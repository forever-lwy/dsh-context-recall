import { z } from 'zod';
import { type ConfigData } from './config.js';
export type { ConfigData };
export declare const viewSchema: z.ZodObject<{
    config: z.ZodObject<{
        compression: z.ZodDefault<z.ZodObject<{
            provider: z.ZodDefault<z.ZodString>;
            model: z.ZodDefault<z.ZodString>;
            thresholdRatio: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        }, z.core.$strict>>;
        embedding: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            baseURL: z.ZodDefault<z.ZodString>;
            model: z.ZodDefault<z.ZodString>;
            apiKeyRef: z.ZodDefault<z.ZodString>;
            dimensions: z.ZodDefault<z.ZodNumber>;
            batchSize: z.ZodDefault<z.ZodNumber>;
            maxInputChars: z.ZodDefault<z.ZodNumber>;
            timeoutMs: z.ZodDefault<z.ZodNumber>;
            queryPrefix: z.ZodDefault<z.ZodString>;
            documentPrefix: z.ZodDefault<z.ZodString>;
            background: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
        recall: z.ZodDefault<z.ZodObject<{
            semantic: z.ZodDefault<z.ZodBoolean>;
            warmup: z.ZodDefault<z.ZodEnum<{
                gentle: "gentle";
                fast: "fast";
            }>>;
            coverageThreshold: z.ZodDefault<z.ZodNumber>;
            eventGap: z.ZodDefault<z.ZodNumber>;
            maxEvents: z.ZodDefault<z.ZodNumber>;
            anchor: z.ZodDefault<z.ZodBoolean>;
            anchorRounds: z.ZodDefault<z.ZodNumber>;
            limit: z.ZodDefault<z.ZodNumber>;
            context: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    revision: z.ZodNumber;
    credential: z.ZodObject<{
        configured: z.ZodBoolean;
        writable: z.ZodBoolean;
    }, z.core.$strip>;
    models: z.ZodArray<z.ZodObject<{
        provider: z.ZodString;
        model: z.ZodString;
        name: z.ZodString;
    }, z.core.$strip>>;
    status: z.ZodObject<{
        semanticAvailable: z.ZodBoolean;
        message: z.ZodString;
    }, z.core.$strip>;
}, z.core.$strip>;
export type SettingsView = z.infer<typeof viewSchema>;
export declare const saveSchema: z.ZodObject<{
    config: z.ZodObject<{
        compression: z.ZodDefault<z.ZodObject<{
            provider: z.ZodDefault<z.ZodString>;
            model: z.ZodDefault<z.ZodString>;
            thresholdRatio: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        }, z.core.$strict>>;
        embedding: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            baseURL: z.ZodDefault<z.ZodString>;
            model: z.ZodDefault<z.ZodString>;
            apiKeyRef: z.ZodDefault<z.ZodString>;
            dimensions: z.ZodDefault<z.ZodNumber>;
            batchSize: z.ZodDefault<z.ZodNumber>;
            maxInputChars: z.ZodDefault<z.ZodNumber>;
            timeoutMs: z.ZodDefault<z.ZodNumber>;
            queryPrefix: z.ZodDefault<z.ZodString>;
            documentPrefix: z.ZodDefault<z.ZodString>;
            background: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
        recall: z.ZodDefault<z.ZodObject<{
            semantic: z.ZodDefault<z.ZodBoolean>;
            warmup: z.ZodDefault<z.ZodEnum<{
                gentle: "gentle";
                fast: "fast";
            }>>;
            coverageThreshold: z.ZodDefault<z.ZodNumber>;
            eventGap: z.ZodDefault<z.ZodNumber>;
            maxEvents: z.ZodDefault<z.ZodNumber>;
            anchor: z.ZodDefault<z.ZodBoolean>;
            anchorRounds: z.ZodDefault<z.ZodNumber>;
            limit: z.ZodDefault<z.ZodNumber>;
            context: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    expectedRevision: z.ZodNumber;
    apiKey: z.ZodOptional<z.ZodString>;
    clearApiKey: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strict>;
export type SaveRequest = z.infer<typeof saveSchema>;
export declare const testSchema: z.ZodObject<{
    config: z.ZodObject<{
        compression: z.ZodDefault<z.ZodObject<{
            provider: z.ZodDefault<z.ZodString>;
            model: z.ZodDefault<z.ZodString>;
            thresholdRatio: z.ZodDefault<z.ZodNullable<z.ZodNumber>>;
        }, z.core.$strict>>;
        embedding: z.ZodDefault<z.ZodObject<{
            enabled: z.ZodDefault<z.ZodBoolean>;
            baseURL: z.ZodDefault<z.ZodString>;
            model: z.ZodDefault<z.ZodString>;
            apiKeyRef: z.ZodDefault<z.ZodString>;
            dimensions: z.ZodDefault<z.ZodNumber>;
            batchSize: z.ZodDefault<z.ZodNumber>;
            maxInputChars: z.ZodDefault<z.ZodNumber>;
            timeoutMs: z.ZodDefault<z.ZodNumber>;
            queryPrefix: z.ZodDefault<z.ZodString>;
            documentPrefix: z.ZodDefault<z.ZodString>;
            background: z.ZodDefault<z.ZodBoolean>;
        }, z.core.$strict>>;
        recall: z.ZodDefault<z.ZodObject<{
            semantic: z.ZodDefault<z.ZodBoolean>;
            warmup: z.ZodDefault<z.ZodEnum<{
                gentle: "gentle";
                fast: "fast";
            }>>;
            coverageThreshold: z.ZodDefault<z.ZodNumber>;
            eventGap: z.ZodDefault<z.ZodNumber>;
            maxEvents: z.ZodDefault<z.ZodNumber>;
            anchor: z.ZodDefault<z.ZodBoolean>;
            anchorRounds: z.ZodDefault<z.ZodNumber>;
            limit: z.ZodDefault<z.ZodNumber>;
            context: z.ZodDefault<z.ZodNumber>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    apiKey: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type TestRequest = z.infer<typeof testSchema>;
export declare const remoteInfo: import("@deepseek-ai/dsh-typert-protocol").TypertRemoteInfo<Readonly<Record<string, import("@deepseek-ai/dsh-typert-protocol").TypertRemoteMethod<object, unknown, "unary", never, unknown> | import("@deepseek-ai/dsh-typert-protocol").TypertRemoteMethod<object, unknown, "stream", unknown, unknown>>>>;
export declare const readSettings: (remote: any, signal?: AbortSignal) => Promise<{
    config: {
        compression: {
            provider: string;
            model: string;
            thresholdRatio: number | null;
        };
        embedding: {
            enabled: boolean;
            baseURL: string;
            model: string;
            apiKeyRef: string;
            dimensions: number;
            batchSize: number;
            maxInputChars: number;
            timeoutMs: number;
            queryPrefix: string;
            documentPrefix: string;
            background: boolean;
        };
        recall: {
            semantic: boolean;
            warmup: "gentle" | "fast";
            coverageThreshold: number;
            eventGap: number;
            maxEvents: number;
            anchor: boolean;
            anchorRounds: number;
            limit: number;
            context: number;
        };
    };
    revision: number;
    credential: {
        configured: boolean;
        writable: boolean;
    };
    models: {
        provider: string;
        model: string;
        name: string;
    }[];
    status: {
        semanticAvailable: boolean;
        message: string;
    };
}>;
export declare const saveSettings: (remote: any, request: SaveRequest, signal?: AbortSignal) => Promise<{
    config: {
        compression: {
            provider: string;
            model: string;
            thresholdRatio: number | null;
        };
        embedding: {
            enabled: boolean;
            baseURL: string;
            model: string;
            apiKeyRef: string;
            dimensions: number;
            batchSize: number;
            maxInputChars: number;
            timeoutMs: number;
            queryPrefix: string;
            documentPrefix: string;
            background: boolean;
        };
        recall: {
            semantic: boolean;
            warmup: "gentle" | "fast";
            coverageThreshold: number;
            eventGap: number;
            maxEvents: number;
            anchor: boolean;
            anchorRounds: number;
            limit: number;
            context: number;
        };
    };
    revision: number;
    credential: {
        configured: boolean;
        writable: boolean;
    };
    models: {
        provider: string;
        model: string;
        name: string;
    }[];
    status: {
        semanticAvailable: boolean;
        message: string;
    };
}>;
export declare const testEmbedding: (remote: any, request: TestRequest, signal?: AbortSignal) => Promise<{
    dimensions: number;
    message: string;
}>;
