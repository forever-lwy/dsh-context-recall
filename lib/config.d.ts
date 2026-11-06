import { z } from 'zod';
export declare const configSchema: z.ZodObject<{
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
export type ConfigData = z.infer<typeof configSchema>;
export declare const defaultConfig: () => ConfigData;
