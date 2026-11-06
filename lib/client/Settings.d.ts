import type { SaveRequest, SettingsView, TestRequest } from '../remote.js';
export interface SettingsFace {
    read: (signal: AbortSignal) => Promise<SettingsView>;
    save: (request: SaveRequest, signal: AbortSignal) => Promise<SettingsView>;
    test: (request: TestRequest, signal: AbortSignal) => Promise<{
        dimensions: number;
        message: string;
    }>;
}
export interface SettingsProps extends SettingsFace {
    t?: (key: string) => string;
}
/** Settings stay local until an explicit save. Read/test/save lifetimes follow the mounted page. */
export declare function ContextRecallSettings(props: SettingsProps): import("react").JSX.Element;
