/** Snippet windowed around the first query fragment that occurs in `text`. */
export function snippetAround(text: any, query: any, maxChars?: number): string;
/**
 * @param {object} deps
 * @param {() => import('./fuzzy-index.js').FuzzyIndex | null} deps.index
 * @param {() => any} deps.getEmbedder - OnlineEmbedder or null
 * @param {() => {semantic?: boolean, coverageThreshold?: number}} deps.getConfig
 * @param {{flush(): Promise<any>, lastReconcile?: object|null}} [deps.sync]
 * @param {() => readonly string[] | undefined} [deps.archivedIds]
 * @param {(id: string) => Promise<{events: object[]}>} [deps.readSession]
 */
export function createSearchApi(deps: {
    index: () => import("./fuzzy-index.js").FuzzyIndex | null;
    getEmbedder: () => any;
    getConfig: () => {
        semantic?: boolean;
        coverageThreshold?: number;
    };
    sync?: {
        flush(): Promise<any>;
        lastReconcile?: object | null;
    } | undefined;
    archivedIds?: (() => readonly string[] | undefined) | undefined;
    readSession?: ((id: string) => Promise<{
        events: object[];
    }>) | undefined;
}): {
    search: (request: any, signal: any) => Promise<{
        notice?: string | undefined;
        groups: {
            sessionId: any;
            title: any;
            cwd: any;
            createdAt: any;
            updatedAt: any;
            archived: boolean;
            subagent: boolean;
            titleMatch: any;
            score: number;
            hitCount: any;
            hits: any[];
        }[];
        ok: boolean;
        query: string;
        mode: any;
        semantic: {
            enabled: boolean;
            ready: boolean;
            coverage: any;
        };
    }>;
    read: (request: any) => Promise<{
        ok: boolean;
        error: string;
        sessionId?: undefined;
        title?: undefined;
        cwd?: undefined;
        updatedAt?: undefined;
        items?: undefined;
        hasBefore?: undefined;
        hasAfter?: undefined;
    } | {
        ok: boolean;
        sessionId: any;
        title: any;
        cwd: any;
        updatedAt: any;
        items: {
            seq: import("node:sqlite").SQLOutputValue;
            type: import("node:sqlite").SQLOutputValue;
            time: string | number | bigint | NodeJS.NonSharedUint8Array | undefined;
            text: import("node:sqlite").SQLOutputValue;
        }[];
        hasBefore: boolean;
        hasAfter: boolean;
        error?: undefined;
    }>;
    locate: (request: any) => Promise<{
        ok: boolean;
        error: string;
    } | {
        text?: string | undefined;
        ok: boolean;
        turn: any;
        error?: undefined;
    }>;
    status: () => Promise<{
        ok: boolean;
        sessions: import("node:sqlite").SQLOutputValue;
        docs: import("node:sqlite").SQLOutputValue;
        vectors: import("node:sqlite").SQLOutputValue;
        semantic: {
            enabled: boolean;
            ready: boolean;
            coverage: any;
        };
        lastReconcileAt: any;
        workspaces: {
            cwd: import("node:sqlite").SQLOutputValue;
            sessions: import("node:sqlite").SQLOutputValue;
        }[];
    }>;
};
/**
 * A short, markdown-free phrase from the start of a message that will appear
 * verbatim in the rendered conversation (first line with plain characters).
 */
export function locateSnippet(text: any): string;
