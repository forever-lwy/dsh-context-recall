/** Serializes async index work; a failed task never blocks the next one. */
export function createExclusive(): (task: any) => Promise<void>;
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
    constructor(options: {
        index: () => import("./fuzzy-index.js").FuzzyIndex | null;
        readSession: (id: string) => Promise<{
            session?: object;
            events: object[];
        }>;
        listSnapshots: () => Promise<readonly {
            header: object;
            revision: string;
        }[]>;
        liveIds?: (() => Iterable<string>) | undefined;
        readTitles?: ((ids: string[]) => Promise<Map<string, string>>) | undefined;
        onIndexed?: (() => void) | undefined;
        exclusive?: ((fn: Function) => Promise<any>) | undefined;
        log?: ((message: string) => void) | undefined;
        flushDelayMs?: number | undefined;
    });
    options: {
        index: () => import("./fuzzy-index.js").FuzzyIndex | null;
        readSession: (id: string) => Promise<{
            session?: object;
            events: object[];
        }>;
        listSnapshots: () => Promise<readonly {
            header: object;
            revision: string;
        }[]>;
        liveIds?: (() => Iterable<string>) | undefined;
        readTitles?: ((ids: string[]) => Promise<Map<string, string>>) | undefined;
        onIndexed?: (() => void) | undefined;
        exclusive?: ((fn: Function) => Promise<any>) | undefined;
        log?: ((message: string) => void) | undefined;
        flushDelayMs?: number | undefined;
    };
    exclusive: (fn: Function) => Promise<any>;
    flushDelayMs: number;
    queue: Map<any, any>;
    tracked: Set<any>;
    flushTimer: any;
    startTimer: any;
    intervalTimer: NodeJS.Timeout | null;
    disposed: boolean;
    lastReconcile: {
        reindexed: number;
        removed: number;
        at: number;
    } | null;
    /** Begin the rare reconcile schedule. */
    start({ initialDelayMs, intervalMs }?: {
        initialDelayMs?: number | undefined;
        intervalMs?: number | undefined;
    }): void;
    /** Cheap per-event hook: called for every appended event, streaming included. */
    observe(session: any, event: any): void;
    /** Apply every queued live event now (also used before answering a query). */
    flush(): Promise<any>;
    /** Read only sessions whose persisted revision changed; drop deleted ones. */
    reconcile(): Promise<any>;
    dispose(): void;
    #private;
}
export class EmbedQueue {
    /**
     * @param {object} options
     * @param {() => import('./fuzzy-index.js').FuzzyIndex | null} options.index
     * @param {() => any} options.getEmbedder - current OnlineEmbedder or null
     * @param {() => {semantic?: boolean, background?: boolean, warmup?: string}} options.getConfig
     * @param {(message: string) => void} [options.log]
     * @param {number} [options.kickDelayMs]
     */
    constructor(options: {
        index: () => import("./fuzzy-index.js").FuzzyIndex | null;
        getEmbedder: () => any;
        getConfig: () => {
            semantic?: boolean;
            background?: boolean;
            warmup?: string;
        };
        log?: ((message: string) => void) | undefined;
        kickDelayMs?: number | undefined;
    });
    options: {
        index: () => import("./fuzzy-index.js").FuzzyIndex | null;
        getEmbedder: () => any;
        getConfig: () => {
            semantic?: boolean;
            background?: boolean;
            warmup?: string;
        };
        log?: ((message: string) => void) | undefined;
        kickDelayMs?: number | undefined;
    };
    kickDelayMs: number;
    timer: any;
    running: any;
    failures: number;
    disposed: boolean;
    /** Something was indexed (or the embedding config changed): embed soon. */
    kick(): void;
    /** Reset backoff after a configuration change and try again soon. */
    reset(): void;
    dispose(): any;
    #private;
}
