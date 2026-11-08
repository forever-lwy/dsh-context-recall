/** Default index location: <dsh home>/storages/context-recall-index.db */
export function defaultIndexPath(): string;
/** Test hook: CONTEXT_RECALL_INDEX_PATH=:memory: keeps tests off the real index. */
export function recallIndexPath(): string;
/** Keep only letters and numbers (drops whitespace and punctuation). */
export function stripText(text: any): string;
/**
 * Extract searchable conversational text from one event: user-authored
 * messages and assistant text blocks only. Every other event, injected host
 * message and tool block contributes no text.
 */
export function extractEventText(event: any): string;
/** Build search documents for events in ascending seq order. */
export function buildSearchDocs(sessionId: any, events: any): {
    sessionId: any;
    seq: any;
    type: any;
    time: any;
    text: string;
}[];
/** Latest `session/title` event among `events`, or null. */
export function latestTitle(events: any): {
    title: any;
    seq: any;
} | null;
/** Event types that can change what the index holds. */
export const INDEXED_EVENT_TYPES: Set<string>;
/**
 * Self-built index over session titles and conversation text.
 * - `sessions`: one row per session (metadata, title, revision watermark).
 * - `titles`: FTS5 trigram table over normalized titles.
 * - `doc_texts`: original text per indexed event; `docs`: FTS5 trigram table
 *   over the normalized text (same rowid).
 * - `vectors`: float32 embeddings keyed by doc rowid.
 */
export class FuzzyIndex {
    constructor(path?: string);
    path: string;
    db: DatabaseSync | null;
    dim: number;
    vectorSpace: any;
    open(): this;
    close(): void;
    requireDb(): DatabaseSync;
    /** Run `fn` inside one immediate transaction. */
    transaction(fn: any): any;
    /** Model/endpoint/query-prefix changes invalidate only derived vectors. */
    setVectorSpace(fingerprint: any): void;
    /** Watermark rows for every indexed session: { id, revision, max_seq }. */
    sessionStates(): Record<string, import("node:sqlite").SQLOutputValue>[];
    /** One session's watermark row, or undefined. */
    sessionState(id: any): Record<string, import("node:sqlite").SQLOutputValue> | undefined;
    /**
     * Append the events newer than the stored watermark (append-only logs).
     * Creates the session row when missing, folds the latest title and refreshes
     * metadata. Returns the number of new documents.
     */
    appendEvents(header: any, events: any, { revision }?: {}): any;
    /**
     * Drop one session's documents and index its complete log again. Used when a
     * log no longer extends the stored watermark (rewritten or truncated).
     */
    replaceSession(header: any, events: any, { revision }?: {}): any;
    /** Record a persisted revision for an already-current session. */
    setRevision(id: any, revision: any): void;
    /** Remove every row of one session. */
    removeSession(id: any): void;
    /** Flag sessions archived (ids in `archivedIds`) or active (all others). */
    setArchived(archivedIds: any): void;
    /** Set a session title known from outside the event stream (backfill). */
    setTitle(id: any, title: any, seq?: number): void;
    /**
     * Incremental reconcile against the persisted corpus: only sessions whose
     * revision changed are read. services: { snapshots(): Promise<[{header,
     * revision}]>, inspect(id): Promise<{session?, events}>, keep?(id): boolean,
     * yield?(): Promise }. `keep` protects live sessions that are not persisted
     * yet from deletion.
     */
    reconcile(services: any): Promise<{
        reindexed: number;
        removed: number;
    }>;
    /**
     * Fuzzy recall: trigram FTS pass + char-bigram LIKE pass, then a
     * containment rerank. Returns hits sorted by score desc, each with
     * { rowid, session_id, cwd, created_at, seq, type, time, text, score }.
     */
    search({ query, limit, sessionId, cwd, minScore, includeArchived }: {
        query: any;
        limit?: number | undefined;
        sessionId: any;
        cwd: any;
        minScore?: number | undefined;
        includeArchived?: boolean | undefined;
    }): any[];
    /**
     * Title search over session titles. Returns sessions sorted by score with
     * { session_id, title, cwd, created_at, updated_at, archived, score }.
     */
    searchTitles({ query, limit, cwd, includeArchived, minScore }: {
        query: any;
        limit?: number | undefined;
        cwd: any;
        includeArchived?: boolean | undefined;
        minScore?: number | undefined;
    }): {
        score: number;
    }[];
    /** Metadata rows for `ids`: Map(id -> { title, cwd, created_at, updated_at, archived }). */
    sessionsMeta(ids: any): Map<any, any>;
    /** Sessions missing a title (for one-time backfill). */
    untitledSessions(limit?: number): import("node:sqlite").SQLOutputValue[];
    /**
     * Page through one session's indexed text blocks in seq order.
     * Returns { rows: [{seq, type, time, text}], nextFromSeq } — nextFromSeq is
     * the first seq of the following page, or null when the page ended the log.
     */
    browse(sessionId: any, fromSeq?: number, pageSize?: number): {
        rows: Record<string, import("node:sqlite").SQLOutputValue>[];
        nextFromSeq: any;
    };
    /** Documents not yet embedded (semantic warm-up): oldest first. */
    pendingVectors(limit?: number): Record<string, import("node:sqlite").SQLOutputValue>[];
    /** Store embedded vectors (Float32Array each) keyed by doc rowid. */
    storeVectors(rows: any): void;
    /** Fraction of documents with vectors (0..1). */
    vectorCoverage(): number;
    /**
     * Semantic (cosine) search over embedded docs. `qVec` must be normalized.
     * Vectors are streamed from SQLite inside the requested scope and only the
     * best `limit` survive, so memory stays bounded however large the corpus.
     */
    semanticSearch(qVec: any, limit?: number, { sessionId, cwd, minScore, includeArchived }?: {
        minScore?: number | undefined;
        includeArchived?: boolean | undefined;
    }): {
        score: any;
    }[];
    /** Index size (tests / diagnostics). */
    stats(): {
        sessions: import("node:sqlite").SQLOutputValue;
        docs: import("node:sqlite").SQLOutputValue;
        vectors: import("node:sqlite").SQLOutputValue;
    };
    #private;
}
import { DatabaseSync } from 'node:sqlite';
