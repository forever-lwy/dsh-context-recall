import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ConfigStore } from './store.js';
import { type LocateRequest, type LocateResult, type SettingsView, type SaveRequest, type TestRequest, type SearchRequest, type SearchResult, type ReadRequest, type ReadResult, type StatusResult } from './remote.js';
/** The search page API, attached once the index exists. */
export interface SearchApi {
    search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>;
    read(request: ReadRequest): Promise<ReadResult>;
    locate(request: LocateRequest): Promise<LocateResult>;
    status(): Promise<StatusResult>;
}
import type { ConfigData } from './config.js';
declare module '@deepseek-ai/cordis' {
    interface Context {
        contextRecall: ContextRecallService;
    }
}
export declare class ContextRecallService extends TypertRemoteService {
    readonly store: ConfigStore;
    private saves;
    private readonly thresholdValidators;
    private readonly savedListeners;
    private searchApi;
    /** Attach the search page API; returns the detacher. */
    attachSearch(api: SearchApi): () => void;
    private requireSearch;
    search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult>;
    read(request: ReadRequest, signal: AbortSignal): Promise<ReadResult>;
    locate(request: LocateRequest, signal: AbortSignal): Promise<LocateResult>;
    status(request: Record<string, never>, signal: AbortSignal): Promise<StatusResult>;
    /** Observe successful saves; returns the disposer. */
    onSaved(listener: () => void): () => void;
    constructor(ctx: Context, store: ConfigStore);
    current(): ConfigData;
    addThresholdValidator(validate: (ratio: number | null) => void): () => void;
    resolveKey(ref: string): Promise<string | undefined>;
    get(request: Record<string, never>, signal: AbortSignal): Promise<SettingsView>;
    save(request: SaveRequest, signal: AbortSignal): Promise<SettingsView>;
    private saveExclusive;
    test(request: TestRequest, signal: AbortSignal): Promise<{
        dimensions: number;
        message: string;
    }>;
}
export declare function registerSettings(ctx: Context): Promise<ContextRecallService>;
