import { z } from 'zod'

const boundedInt = (min: number, max: number, value: number) => z.number().int().min(min).max(max).default(value)
export const configSchema = z.object({
  compression: z.object({
    provider: z.string().trim().max(512).default(''),
    model: z.string().trim().max(1024).default(''),
    // Native web presets retain 16% of recent context. Preserve that policy
    // rather than implicitly reducing retention for an earlier trigger.
    thresholdRatio: z.number().min(0.17).max(0.99).nullable().default(null),
  }).strict().default({ provider: '', model: '', thresholdRatio: null }).refine(v => !!v.provider === !!v.model, '压缩提供方和模型必须同时填写或同时留空。'),
  embedding: z.object({
    enabled: z.boolean().default(false),
    baseURL: z.string().trim().max(2048).default('https://api.openai.com/v1').refine(value => {
      try { const u = new URL(value); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash } catch { return false }
    }, '向量地址须为不含凭据、查询参数的 HTTP(S) Base URL。'),
    model: z.string().trim().min(1).max(512).default('text-embedding-3-small'),
    apiKeyRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256).default('DSH_RECALL_EMBEDDING_API_KEY'),
    dimensions: boundedInt(0, 65536, 0),
    batchSize: boundedInt(1, 128, 16),
    maxInputChars: boundedInt(128, 100000, 8000),
    timeoutMs: boundedInt(1000, 300000, 30000),
    queryPrefix: z.string().max(1024).default(''),
    documentPrefix: z.string().max(1024).default(''),
    background: z.boolean().default(true),
  }).strict().default({ enabled: false, baseURL: 'https://api.openai.com/v1', model: 'text-embedding-3-small', apiKeyRef: 'DSH_RECALL_EMBEDDING_API_KEY', dimensions: 0, batchSize: 16, maxInputChars: 8000, timeoutMs: 30000, queryPrefix: '', documentPrefix: '', background: true }),
  recall: z.object({
    semantic: z.boolean().default(true), warmup: z.enum(['gentle', 'fast']).default('gentle'),
    coverageThreshold: z.number().min(0).max(1).default(0.9),
    eventGap: boundedInt(0, 100, 5), maxEvents: boundedInt(1, 20, 3),
    anchor: z.boolean().default(true), anchorRounds: boundedInt(1, 20, 3),
    limit: boundedInt(1, 50, 10), context: boundedInt(0, 10, 3),
    // AI access to sessions other than the current one, enforced by the tool:
    // off = never; when-asked = only with the user's own words quoted from a
    // recent message; autonomous/allowed = whenever the model judges it useful.
    crossSession: z.enum(['off', 'when-asked', 'autonomous']).default('when-asked'),
    readOther: z.enum(['off', 'when-asked', 'allowed']).default('when-asked'),
  }).strict().default({ semantic: true, warmup: 'gentle', coverageThreshold: 0.9, eventGap: 5, maxEvents: 3, anchor: true, anchorRounds: 3, limit: 10, context: 3, crossSession: 'when-asked', readOther: 'when-asked' }),
}).strict()
export type ConfigData = z.infer<typeof configSchema>
export const defaultConfig = (): ConfigData => configSchema.parse({})
