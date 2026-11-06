import { type ConfigData } from './config.js';
export declare class ConfigConflict extends Error {
}
export interface ConfigRecord {
    revision: number;
    config: ConfigData;
}
export declare class ConfigStore {
    readonly path: string;
    private record;
    constructor(path: string);
    load(): Promise<void>;
    current(): ConfigData;
    revision(): number;
    save(config: ConfigData, expectedRevision: number): Promise<void>;
}
