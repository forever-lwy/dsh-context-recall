import type { ConfigData } from './config.js';
export type EmbeddingConfig = ConfigData['embedding'];
export declare class EmbeddingError extends Error {
    constructor(message: string);
}
export declare function vectorFingerprint(config: EmbeddingConfig): string;
/** Normalize and validate before any vectors can enter the persistent index. */
export declare function normalizeVector(value: unknown, dimension?: number): Float32Array;
/** OpenAI-compatible /embeddings transport; no local model or native runtime. */
export declare class OnlineEmbedder {
    readonly config: EmbeddingConfig;
    private readonly resolveKey;
    private readonly fetcher;
    readonly fingerprint: string;
    readonly available: boolean;
    private readonly lifetime;
    private queue;
    private observedDimension?;
    constructor(config: EmbeddingConfig, resolveKey: () => Promise<string | undefined>, fetcher?: typeof fetch);
    ensureLoaded(): Promise<void>;
    embed(text: string, signal?: AbortSignal): Promise<Float32Array>;
    embedBatch(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
    private run;
    private request;
    dispose(): Promise<void>;
}
