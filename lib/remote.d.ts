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
            crossSession: z.ZodDefault<z.ZodEnum<{
                off: "off";
                "when-asked": "when-asked";
                autonomous: "autonomous";
            }>>;
            readOther: z.ZodDefault<z.ZodEnum<{
                off: "off";
                "when-asked": "when-asked";
                allowed: "allowed";
            }>>;
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
            crossSession: z.ZodDefault<z.ZodEnum<{
                off: "off";
                "when-asked": "when-asked";
                autonomous: "autonomous";
            }>>;
            readOther: z.ZodDefault<z.ZodEnum<{
                off: "off";
                "when-asked": "when-asked";
                allowed: "allowed";
            }>>;
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
            crossSession: z.ZodDefault<z.ZodEnum<{
                off: "off";
                "when-asked": "when-asked";
                autonomous: "autonomous";
            }>>;
            readOther: z.ZodDefault<z.ZodEnum<{
                off: "off";
                "when-asked": "when-asked";
                allowed: "allowed";
            }>>;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    apiKey: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type TestRequest = z.infer<typeof testSchema>;
export declare const searchRequestSchema: z.ZodObject<{
    query: z.ZodString;
    mode: z.ZodOptional<z.ZodEnum<{
        semantic: "semantic";
        auto: "auto";
        keyword: "keyword";
        title: "title";
    }>>;
    cwd: z.ZodOptional<z.ZodString>;
    includeArchived: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type SearchRequest = z.infer<typeof searchRequestSchema>;
export declare const searchResultSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    query: z.ZodString;
    mode: z.ZodString;
    semantic: z.ZodObject<{
        enabled: z.ZodBoolean;
        ready: z.ZodBoolean;
        coverage: z.ZodNumber;
    }, z.core.$strip>;
    notice: z.ZodOptional<z.ZodString>;
    groups: z.ZodArray<z.ZodObject<{
        sessionId: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        cwd: z.ZodOptional<z.ZodString>;
        createdAt: z.ZodOptional<z.ZodNumber>;
        updatedAt: z.ZodOptional<z.ZodNumber>;
        archived: z.ZodBoolean;
        subagent: z.ZodBoolean;
        titleMatch: z.ZodBoolean;
        score: z.ZodNumber;
        hitCount: z.ZodNumber;
        hits: z.ZodArray<z.ZodObject<{
            seq: z.ZodNumber;
            type: z.ZodString;
            time: z.ZodOptional<z.ZodNumber>;
            snippet: z.ZodString;
            source: z.ZodEnum<{
                semantic: "semantic";
                keyword: "keyword";
            }>;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export declare const readRequestSchema: z.ZodObject<{
    sessionId: z.ZodString;
    seq: z.ZodOptional<z.ZodNumber>;
    before: z.ZodOptional<z.ZodNumber>;
    after: z.ZodOptional<z.ZodNumber>;
    fromSeq: z.ZodOptional<z.ZodNumber>;
    pageSize: z.ZodOptional<z.ZodNumber>;
}, z.core.$strict>;
export type ReadRequest = z.infer<typeof readRequestSchema>;
export declare const readResultSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    error: z.ZodOptional<z.ZodString>;
    sessionId: z.ZodOptional<z.ZodString>;
    title: z.ZodOptional<z.ZodString>;
    cwd: z.ZodOptional<z.ZodString>;
    updatedAt: z.ZodOptional<z.ZodNumber>;
    items: z.ZodOptional<z.ZodArray<z.ZodObject<{
        seq: z.ZodNumber;
        type: z.ZodString;
        time: z.ZodOptional<z.ZodNumber>;
        text: z.ZodString;
    }, z.core.$strip>>>;
    hasBefore: z.ZodOptional<z.ZodBoolean>;
    hasAfter: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
export type ReadResult = z.infer<typeof readResultSchema>;
export declare const statusResultSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    sessions: z.ZodNumber;
    docs: z.ZodNumber;
    vectors: z.ZodNumber;
    semantic: z.ZodObject<{
        enabled: z.ZodBoolean;
        ready: z.ZodBoolean;
        coverage: z.ZodNumber;
    }, z.core.$strip>;
    lastReconcileAt: z.ZodOptional<z.ZodNumber>;
    workspaces: z.ZodArray<z.ZodObject<{
        cwd: z.ZodString;
        sessions: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type StatusResult = z.infer<typeof statusResultSchema>;
export declare const locateRequestSchema: z.ZodObject<{
    sessionId: z.ZodString;
    seq: z.ZodNumber;
}, z.core.$strict>;
export type LocateRequest = z.infer<typeof locateRequestSchema>;
export declare const locateResultSchema: z.ZodObject<{
    ok: z.ZodBoolean;
    error: z.ZodOptional<z.ZodString>;
    turn: z.ZodOptional<z.ZodNumber>;
    text: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export type LocateResult = z.infer<typeof locateResultSchema>;
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
            crossSession: "off" | "when-asked" | "autonomous";
            readOther: "off" | "when-asked" | "allowed";
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
            crossSession: "off" | "when-asked" | "autonomous";
            readOther: "off" | "when-asked" | "allowed";
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
export declare const searchSessions: (remote: any, request: SearchRequest, signal?: AbortSignal) => Promise<{
    ok: boolean;
    query: string;
    mode: string;
    semantic: {
        enabled: boolean;
        ready: boolean;
        coverage: number;
    };
    groups: {
        sessionId: string;
        archived: boolean;
        subagent: boolean;
        titleMatch: boolean;
        score: number;
        hitCount: number;
        hits: {
            seq: number;
            type: string;
            snippet: string;
            source: "semantic" | "keyword";
            time?: number | undefined;
        }[];
        title?: string | undefined;
        cwd?: string | undefined;
        createdAt?: number | undefined;
        updatedAt?: number | undefined;
    }[];
    notice?: string | undefined;
}>;
export declare const readSessionText: (remote: any, request: ReadRequest, signal?: AbortSignal) => Promise<{
    ok: boolean;
    error?: string | undefined;
    sessionId?: string | undefined;
    title?: string | undefined;
    cwd?: string | undefined;
    updatedAt?: number | undefined;
    items?: {
        seq: number;
        type: string;
        text: string;
        time?: number | undefined;
    }[] | undefined;
    hasBefore?: boolean | undefined;
    hasAfter?: boolean | undefined;
}>;
export declare const locateMessage: (remote: any, request: LocateRequest, signal?: AbortSignal) => Promise<{
    ok: boolean;
    error?: string | undefined;
    turn?: number | undefined;
    text?: string | undefined;
}>;
export declare const readIndexStatus: (remote: any, signal?: AbortSignal) => Promise<{
    ok: boolean;
    sessions: number;
    docs: number;
    vectors: number;
    semantic: {
        enabled: boolean;
        ready: boolean;
        coverage: number;
    };
    workspaces: {
        cwd: string;
        sessions: number;
    }[];
    lastReconcileAt?: number | undefined;
}>;
