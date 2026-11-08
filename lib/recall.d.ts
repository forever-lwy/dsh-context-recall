export function eventText(event: any): string;
/**
 * Run one recall search: normalize the query, call searchSessions with
 * optional workspace filtering, then enrich each hit with the session title
 * and a bounded context window around its strongest match.
 */
export function runRecall(sessionQuery: any, args: any, exec: any, services?: {}): Promise<{
    ok: boolean;
    query: any;
    total: number;
    groups: {
        sessionId: any;
        title: any;
    }[];
    error?: undefined;
} | {
    ok: boolean;
    error: string;
    query?: undefined;
    total?: undefined;
    groups?: undefined;
} | {
    ok: boolean;
    query: string;
    total: number;
    groups: {
        sessionId: any;
        cwd: any;
        createdAt: any;
        hitTime: any;
        snippet: string;
        context: never[];
    }[];
    error?: undefined;
}>;
/**
 * Title search across sessions (scope workspace by default, or all).
 * Returns the same group shape as a coarse recall, without episodes.
 */
export function runTitleSearch(index: any, args: any, exec: any, config?: {}): {
    ok: boolean;
    error: string;
    query?: undefined;
    total?: undefined;
    groups?: undefined;
} | {
    ok: boolean;
    query: string;
    total: any;
    groups: any;
    error?: undefined;
};
/**
 * Merge semantic and fuzzy hits (both score-sorted 0..1) by doc rowid,
 * keeping the best score per doc. Returns up to limit*2 candidates.
 */
export function mergeHits(semHits: any, fuzzyHits: any, limit: any): any[];
/**
 * Merge one session's hits into "events" — same-topic episodes. Consecutive
 * hits whose text-block distance (doc_texts rowid gap) is ≤ EVENT_GAP belong
 * to the same discussion and merge into one event; farther apart they start a
 * new event. Pure local heuristic — no LLM, no topic naming. Events are
 * sorted by their best hit's score, capped at MAX_EVENTS_PER_SESSION.
 * Returns [{ startSeq, endSeq, hitCount, snippet }] — the full event text is
 * one detail browse away (from startSeq until endSeq).
 */
export function buildEvents(hits: any, query: any, config?: {}): {
    startSeq: any;
    endSeq: any;
    hitCount: number;
    snippet: string;
    _score: any;
}[];
/**
 * Build the compaction anchor text for one compaction/summary event: the
 * LLM-written summary plus up to three key original fragments picked from
 * the shadowed seq range (pure-local heuristics — user messages first, then
 * the longest texts; no external LLM).
 */
export function buildAnchorText(sessionQuery: any, sessionId: any, summaryEvent: any): Promise<string>;
/** Remove absent optional fields so runtime output matches its declared schema. */
export function schemaValue(value: any): any;
/**
 * Public corpus APIs used by the index: persisted snapshots (cheap header +
 * revision listing), live-preferred full reads, live ids and host titles.
 * Failed listings must not erase a valid index.
 */
export function corpusServices(ctx: any): {
    listSnapshots: () => Promise<any>;
    readSession: (id: any) => any;
    liveIds: () => any;
    readTitles: (ids: any) => Promise<Map<any, any>>;
};
/** Installs recall behavior with live GUI configuration and a remote embedder. */
export function applyRecall(ctx: any, getConfig: any, getEmbedder: any, options?: {}): {
    sync: IndexSync;
    embedQueue: EmbedQueue;
    index: () => any;
};
import { IndexSync } from './index-sync.js';
import { EmbedQueue } from './index-sync.js';
