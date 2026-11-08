import { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { ConfigStore } from './store.js';
import { type SettingsView, type SaveRequest, type TestRequest } from './remote.js';
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
