import { type Context } from '@deepseek-ai/cordis';
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm';
import type { ConfigData } from './config.js';
/**
 * The summary directive and safe stream projection follow dsh-compaction-basic
 * 0.2.1-rc.5 (DeepSeek, MIT). The native backend still owns every selection,
 * tool-pair boundary, transaction, persistence checkpoint and overflow retry.
 */
export declare const COMPACTION_INSTRUCTION: string;
export interface SummaryInput {
    readonly tools?: readonly ToolSchema[];
    readonly messages: readonly Message[];
}
export interface SummaryOutput {
    summary: ContentBlock[];
    rawOutput: ContentBlock[];
    provider: string;
    model: string;
    maxTokens: number;
    llmStreamCall: true;
    usage?: TokenUsage;
}
export interface SummaryTarget {
    provider: string;
    model: string;
    maxTokens: number;
}
/** Portable public type for the native protected hook's marked/unmarked result. */
export type NativeSummaryResult = {
    summary: ContentBlock[];
    provider: string;
    model: string;
    maxTokens?: number;
    usage?: TokenUsage;
} & ({
    rawOutput: ContentBlock[];
    llmStreamCall: true;
} | {
    rawOutput?: ContentBlock[];
    llmStreamCall?: never;
});
/** A one-shot whose actual route is also recorded in compaction/summary. */
export declare function summarizeWithGlobalModel(ctx: Context, target: SummaryTarget, input: SummaryInput, agent: Agent, signal?: AbortSignal): Promise<SummaryOutput>;
/** Drop-in replacement for the existing compaction-basic composition row. */
export declare class ContextRecallCompaction extends BasicCompactionEngine {
    static inject: string[];
    static Config: import("@deepseek-ai/schemastery").default<BasicCompactionConfig>;
    private readSettings?;
    constructor(ctx: Context, config?: BasicCompactionConfig);
    protected summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal): Promise<NativeSummaryResult>;
}
export default ContextRecallCompaction;
export interface CompressionBridgeOptions {
    registerThresholdValidator?: (validate: (ratio: number | null) => void) => () => void;
}
/** Retention is native policy; a threshold override never shrinks its tail. */
export declare function thresholdRetentionProblem(config: ResolvedConfig, ratio: number): string | undefined;
/** The native resolver retains output reservations, headroom and all tail rules. */
export declare function thresholdConfigSnapshot(config: ResolvedConfig, ratio: number): ResolvedConfig;
/**
 * Extend the native instances selected by web Agent presets. Their isolated
 * compaction services are intentionally invisible as root `ctx.compaction`.
 * Decorate the summary hook and automatic policy entry point; prototypes,
 * native configuration, registrations and LLM routing are preserved.
 */
export declare function registerCompressionBridge(ctx: Context, getConfig: () => Pick<ConfigData, 'compression'>, options?: CompressionBridgeOptions): () => void;
