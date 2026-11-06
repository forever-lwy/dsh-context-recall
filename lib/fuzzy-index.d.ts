/** Default index location: <dsh home>/storages/context-recall-index.db */
export function defaultIndexPath(): string;
/** Test hook: CONTEXT_RECALL_INDEX_PATH=:memory: keeps tests off the real index. */
export function recallIndexPath(): string;
/** Keep only letters and numbers (drops whitespace and punctuation). */
export function stripText(text: any): string;
/**
 * Extract searchable conversational text from one event.
 * Mirrors the official extractSessionEventText surface for user/assistant
 * messages — except tool-call/tool-result blocks are excluded (operational
 * noise; see blockText). Every other event type contributes no text.
 */
export function extractEventText(event: any): string;
/**
 * Build search documents for one complete event log (ascending seq order).
 * The full append-only log is indexed (including shadowed/compacted history);
 * surface classification is intentionally omitted — for recall, all history
 * must stay searchable, and foldSurface lives in the official dsh-session
 * package we choose not to depend on.
 */
export function buildSearchDocs(sessionId: any, events: any): {
    sessionId: any;
    seq: any;
    type: any;
    time: any;
    text: string;
}[];
/**
 * Self-built fuzzy index over session conversation text.
 * - `docs` FTS5 virtual table (trigram tokenizer) over whitespace/punctuation
 *   stripped text: arbitrary-position substring recall for >= 3 chars.
 * - `doc_texts` plain table holding original text: used for the char-bigram
 *   LIKE recall pass (covers 1-2 char queries and paraphrase overlap) and for
 *   snippets.
 * - `sessions` table tracks per-session state (fingerprint/revision/max_seq)
 *   for incremental reconciliation.
 */
export class FuzzyIndex {
    constructor(path?: string);
    path: string;
    db: DatabaseSync | null;
    dim: number;
    vectorSpace: any;
    open(): this;
    _vecCache: any;
    close(): void;
    requireDb(): DatabaseSync;
    /** Model/endpoint/query-prefix changes invalidate only derived vectors. */
    setVectorSpace(fingerprint: any): void;
    /**
     * Incremental reconcile against the live + persisted corpus.
     * services: { live(): [{header, events}], snapshots(): Promise<[{header,
     * revision}]>, inspect(id): Promise<{meta, events}> }
     */
    reconcile(services: any): Promise<{
        reindexed: number;
    }>;
    /**
     * Fuzzy recall: trigram FTS pass + char-bigram LIKE pass, then a
     * containment rerank. Returns hits sorted by score desc, each with
     * { rowid, session_id, cwd, created_at, seq, type, time, text, score }.
     */
    search({ query, limit, sessionId, cwd, minScore }: {
        query: any;
        limit?: number | undefined;
        sessionId: any;
        cwd: any;
        minScore?: number | undefined;
    }): any[];
    /**
     * Documents not yet embedded (semantic warm-up): oldest first.
     */
    /**
     * Page through one session's indexed text blocks in seq order.
     * Returns { rows: [{seq, type, time, text}], nextFromSeq } — nextFromSeq is
     * the first seq of the following page, or null when the page ended the log.
     */
    browse(sessionId: any, fromSeq?: number, pageSize?: number): {
        rows: Record<string, import("node:sqlite").SQLOutputValue>[];
        nextFromSeq: any;
    };
    pendingVectors(limit?: number): Record<string, import("node:sqlite").SQLOutputValue>[];
    /** Store embedded vectors (Float32Array each) keyed by doc rowid. */
    storeVectors(rows: any): void;
    /** Fraction of documents with vectors (0..1). */
    vectorCoverage(): number;
    /** Load all vectors into a cached {rowids, data} flat Float32Array. */
    syncVectorCache(): void;
    /**
     * Semantic (cosine) search over embedded docs. `qVec` must be normalized.
     * Returns hits sorted by score desc with doc metadata, scoped by
     * sessionId/cwd. Requires full index coverage for meaningful results —
     * callers gate on vectorCoverage().
     */
    semanticSearch(qVec: any, limit?: number, { sessionId, cwd, minScore }?: {
        minScore?: number | undefined;
    }): {
        score: any;
    }[];
    /** Total indexed documents (tests / diagnostics). */
    stats(): {
        sessions: import("node:sqlite").SQLOutputValue;
        docs: import("node:sqlite").SQLOutputValue;
    };
}
import { DatabaseSync } from 'node:sqlite';
