// Keeps the session index current without polling session logs.
//
// - Live events: `observe()` is called for every appended session event. It
//   only queues user/assistant messages and title events; a short debounce
//   then appends them to the index. The first time a session is seen in this
//   process its log is read once to catch up on anything missed while the
//   plugin was not running.
// - Reconcile: once shortly after start and then rarely (hourly by default),
//   persisted sessions are listed and only those whose revision changed are
//   read. This also removes deleted sessions.
// - Embeddings: `EmbedQueue` embeds pending documents only after something was
//   indexed, in small batches with pauses, and backs off exponentially when the
//   online service fails. With nothing pending it holds no timer at all.
import { INDEXED_EVENT_TYPES } from './fuzzy-index.js';
const nextTick = () => new Promise(resolve => setImmediate(resolve));
/** Serializes async index work; a failed task never blocks the next one. */
export function createExclusive() {
    let tail = Promise.resolve();
    return task => {
        const run = tail.then(task);
        tail = run.catch(() => { });
        return run;
    };
}
export class IndexSync {
    /**
     * @param {object} options
     * @param {() => import('./fuzzy-index.js').FuzzyIndex | null} options.index
     * @param {(id: string) => Promise<{session?: object, events: object[]}>} options.readSession
     * @param {() => Promise<readonly {header: object, revision: string}[]>} options.listSnapshots
     * @param {() => Iterable<string>} [options.liveIds]
     * @param {(ids: string[]) => Promise<Map<string, string>>} [options.readTitles]
     * @param {() => void} [options.onIndexed]
     * @param {(fn: Function) => Promise<any>} [options.exclusive]
     * @param {(message: string) => void} [options.log]
     * @param {number} [options.flushDelayMs]
     */
    constructor(options) {
        this.options = options;
        this.exclusive = options.exclusive ?? createExclusive();
        this.flushDelayMs = options.flushDelayMs ?? 1500;
        this.queue = new Map(); // sessionId -> { header, events[] }
        this.tracked = new Set(); // sessions caught up in this process
        this.flushTimer = null;
        this.startTimer = null;
        this.intervalTimer = null;
        this.disposed = false;
        this.lastReconcile = null;
    }
    /** Begin the rare reconcile schedule. */
    start({ initialDelayMs = 15_000, intervalMs = 3_600_000 } = {}) {
        if (this.disposed)
            return;
        this.startTimer = setTimeout(() => {
            this.startTimer = null;
            void this.reconcile().catch(error => this.#log(`initial reconcile failed: ${error?.message ?? error}`));
        }, initialDelayMs);
        this.startTimer.unref?.();
        if (intervalMs > 0) {
            this.intervalTimer = setInterval(() => {
                void this.reconcile().catch(error => this.#log(`reconcile failed: ${error?.message ?? error}`));
            }, intervalMs);
            this.intervalTimer.unref?.();
        }
    }
    /** Cheap per-event hook: called for every appended event, streaming included. */
    observe(session, event) {
        if (this.disposed || !event || !INDEXED_EVENT_TYPES.has(event.type))
            return;
        const id = session && typeof session.id === 'string' ? session.id : null;
        if (!id)
            return;
        let entry = this.queue.get(id);
        if (!entry) {
            entry = { header: session.header ?? { id }, events: [] };
            this.queue.set(id, entry);
        }
        entry.events.push(event);
        if (this.flushTimer === null) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                void this.flush().catch(error => this.#log(`flush failed: ${error?.message ?? error}`));
            }, this.flushDelayMs);
            this.flushTimer.unref?.();
        }
    }
    /** Apply every queued live event now (also used before answering a query). */
    flush() {
        if (this.flushTimer !== null) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.queue.size === 0)
            return Promise.resolve(0);
        return this.exclusive(() => this.#flush());
    }
    async #flush() {
        const index = this.options.index();
        if (!index || this.disposed)
            return 0;
        const batch = [...this.queue];
        this.queue.clear();
        let inserted = 0;
        for (const [id, entry] of batch) {
            if (this.disposed)
                break;
            try {
                if (!this.tracked.has(id)) {
                    // First sighting in this process: catch up from the log once, which
                    // already contains the queued events.
                    const log = await this.options.readSession(id);
                    const header = { ...entry.header, ...(log?.session ?? {}), id };
                    const state = index.sessionState(id);
                    const events = Array.isArray(log?.events) ? log.events : [];
                    const last = events.reduce((max, e) => Math.max(max, e?.seq ?? -1), -1);
                    inserted += state && last < state.max_seq
                        ? index.replaceSession(header, events)
                        : index.appendEvents(header, events);
                    this.tracked.add(id);
                }
                else {
                    inserted += index.appendEvents({ ...entry.header, id }, entry.events);
                }
            }
            catch (error) {
                // Retry this session from its log on the next event.
                this.tracked.delete(id);
                this.#log(`index update failed for ${id}: ${error?.message ?? error}`);
            }
        }
        if (inserted > 0)
            this.options.onIndexed?.();
        return inserted;
    }
    /** Read only sessions whose persisted revision changed; drop deleted ones. */
    reconcile() {
        return this.exclusive(async () => {
            const index = this.options.index();
            if (!index || this.disposed)
                return { reindexed: 0, removed: 0 };
            const live = new Set(this.options.liveIds ? this.options.liveIds() : []);
            const result = await index.reconcile({
                snapshots: () => this.options.listSnapshots(),
                inspect: id => this.options.readSession(id),
                keep: id => live.has(id) || this.tracked.has(id) || this.queue.has(id),
                yield: nextTick,
            });
            await this.#backfillTitles(index);
            this.lastReconcile = { at: Date.now(), ...result };
            // Also resumes embedding left pending by an earlier outage or restart.
            this.options.onIndexed?.();
            return result;
        });
    }
    /** Sessions whose logs carry no title event yet get the host-folded title. */
    async #backfillTitles(index) {
        if (!this.options.readTitles)
            return;
        const ids = index.untitledSessions();
        if (ids.length === 0)
            return;
        try {
            const titles = await this.options.readTitles(ids);
            for (const [id, title] of titles)
                if (title)
                    index.setTitle(id, title);
        }
        catch (error) {
            this.#log(`title backfill failed: ${error?.message ?? error}`);
        }
    }
    dispose() {
        this.disposed = true;
        for (const timer of [this.flushTimer, this.startTimer])
            if (timer !== null)
                clearTimeout(timer);
        if (this.intervalTimer !== null)
            clearInterval(this.intervalTimer);
        this.flushTimer = this.startTimer = this.intervalTimer = null;
        this.queue.clear();
    }
    #log(message) {
        try {
            this.options.log?.(message);
        }
        catch { /* logging never breaks indexing */ }
    }
}
/** Pacing per warm-up speed: documents per batch and pause between batches. */
const PACE = {
    gentle: { batch: 16, pauseMs: 10_000 },
    fast: { batch: 64, pauseMs: 1_000 },
};
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
export class EmbedQueue {
    /**
     * @param {object} options
     * @param {() => import('./fuzzy-index.js').FuzzyIndex | null} options.index
     * @param {() => any} options.getEmbedder - current OnlineEmbedder or null
     * @param {() => {semantic?: boolean, background?: boolean, warmup?: string}} options.getConfig
     * @param {(message: string) => void} [options.log]
     * @param {number} [options.kickDelayMs]
     */
    constructor(options) {
        this.options = options;
        this.kickDelayMs = options.kickDelayMs ?? 3_000;
        this.timer = null;
        this.running = null;
        this.failures = 0;
        this.disposed = false;
    }
    /** Something was indexed (or the embedding config changed): embed soon. */
    kick() {
        if (this.disposed || this.failures > 0)
            return;
        this.#schedule(this.kickDelayMs);
    }
    #schedule(delayMs) {
        if (this.disposed || this.timer !== null)
            return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.running = this.#drain().finally(() => { this.running = null; });
        }, delayMs);
        this.timer.unref?.();
    }
    async #drain() {
        if (this.disposed)
            return;
        const config = this.options.getConfig();
        if (!config.semantic || config.background === false)
            return;
        const index = this.options.index();
        const embedder = this.options.getEmbedder();
        if (!index || !embedder || !embedder.available)
            return;
        const pace = PACE[config.warmup] ?? PACE.gentle;
        try {
            await embedder.ensureLoaded();
            if (this.disposed)
                return;
            index.setVectorSpace(embedder.fingerprint);
            const pending = index.pendingVectors(pace.batch);
            if (pending.length === 0) {
                this.failures = 0;
                return;
            }
            const vectors = await embedder.embedBatch(pending.map(p => p.text));
            if (this.disposed)
                return;
            // The vector space may have changed during network IO.
            if (index.vectorSpace === embedder.fingerprint) {
                index.storeVectors(pending.map((p, i) => ({ rowid: p.rowid, vec: vectors[i] })));
            }
            this.failures = 0;
            this.#schedule(pace.pauseMs);
        }
        catch (error) {
            if (this.disposed)
                return;
            this.failures += 1;
            const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1));
            try {
                this.options.log?.(`embedding paused ${Math.round(delay / 1000)}s: ${error?.message ?? error}`);
            }
            catch { /* ignore */ }
            this.#schedule(delay);
        }
    }
    /** Reset backoff after a configuration change and try again soon. */
    reset() {
        this.failures = 0;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        this.kick();
    }
    dispose() {
        this.disposed = true;
        if (this.timer !== null)
            clearTimeout(this.timer);
        this.timer = null;
        return this.running ?? Promise.resolve();
    }
}
