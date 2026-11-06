import type { Context } from '@deepseek-ai/cordis';
export declare const name = "dsh-context-recall-client";
export declare const inject: string[];
export declare function RecallToolView({ block, t }: {
    block?: any;
    t?: (key: string) => string;
}): import("react").JSX.Element;
export declare function apply(ctx: Context): Promise<void>;
export { ContextRecallSettings } from './Settings.js';
