import { z } from 'zod'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'
import { configSchema, type ConfigData } from './config.js'
export type { ConfigData }

export const viewSchema = z.object({
  config: configSchema, revision: z.number().int().nonnegative(),
  credential: z.object({ configured: z.boolean(), writable: z.boolean() }),
  models: z.array(z.object({ provider: z.string(), model: z.string(), name: z.string() })),
  status: z.object({ semanticAvailable: z.boolean(), message: z.string() }),
})
export type SettingsView = z.infer<typeof viewSchema>
export const saveSchema = z.object({config: configSchema, expectedRevision: z.number().int().nonnegative(), apiKey: z.string().trim().min(1).max(16384).optional(), clearApiKey: z.boolean().optional()}).strict()
export type SaveRequest = z.infer<typeof saveSchema>
export const testSchema = z.object({config: configSchema, apiKey: z.string().trim().min(1).max(16384).optional()}).strict()
export type TestRequest = z.infer<typeof testSchema>
const testResultSchema = z.object({ dimensions: z.number().int().positive(), message: z.string() })

const semanticSchema = z.object({ enabled: z.boolean(), ready: z.boolean(), coverage: z.number() })
export const searchRequestSchema = z.object({
  query: z.string().max(2000),
  mode: z.enum(['auto', 'keyword', 'title', 'semantic']).optional(),
  cwd: z.string().max(4096).optional(),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict()
export type SearchRequest = z.infer<typeof searchRequestSchema>
const hitSchema = z.object({ seq: z.number().int(), type: z.string(), time: z.number().optional(), snippet: z.string(), source: z.enum(['keyword', 'semantic']) })
export const searchResultSchema = z.object({
  ok: z.boolean(), query: z.string(), mode: z.string(), semantic: semanticSchema, notice: z.string().optional(),
  groups: z.array(z.object({
    sessionId: z.string(), title: z.string().optional(), cwd: z.string().optional(),
    createdAt: z.number().optional(), updatedAt: z.number().optional(),
    archived: z.boolean(), subagent: z.boolean(), titleMatch: z.boolean(), score: z.number(), hitCount: z.number().int(),
    hits: z.array(hitSchema),
  })),
})
export type SearchResult = z.infer<typeof searchResultSchema>
export const readRequestSchema = z.object({
  sessionId: z.string().min(1).max(512),
  seq: z.number().int().optional(), before: z.number().int().optional(), after: z.number().int().optional(),
  fromSeq: z.number().int().optional(), pageSize: z.number().int().optional(),
}).strict()
export type ReadRequest = z.infer<typeof readRequestSchema>
export const readResultSchema = z.object({
  ok: z.boolean(), error: z.string().optional(), sessionId: z.string().optional(), title: z.string().optional(),
  cwd: z.string().optional(), updatedAt: z.number().optional(),
  items: z.array(z.object({ seq: z.number().int(), type: z.string(), time: z.number().optional(), text: z.string() })).optional(),
  hasBefore: z.boolean().optional(), hasAfter: z.boolean().optional(),
})
export type ReadResult = z.infer<typeof readResultSchema>
export const statusResultSchema = z.object({
  ok: z.boolean(), sessions: z.number().int(), docs: z.number().int(), vectors: z.number().int(),
  semantic: semanticSchema, lastReconcileAt: z.number().optional(),
  workspaces: z.array(z.object({ cwd: z.string(), sessions: z.number().int() })),
})
export type StatusResult = z.infer<typeof statusResultSchema>
export const locateRequestSchema = z.object({ sessionId: z.string().min(1).max(512), seq: z.number().int().nonnegative() }).strict()
export type LocateRequest = z.infer<typeof locateRequestSchema>
export const locateResultSchema = z.object({ ok: z.boolean(), error: z.string().optional(), turn: z.number().int().optional(), text: z.string().optional() })
export type LocateResult = z.infer<typeof locateResultSchema>
const empty = z.object({}).strict()
const codec = (schema: z.ZodType, typeSymbol: string) => ({ mode: 'strict' as const, typeSymbol, create: () => schema })
const method = (input: z.ZodType, output: z.ZodType) => ({
  service: 'contextRecall', invocation: {kind: 'direct' as const},
  parameters: [{name: 'request', source: 'json' as const, codec: codec(input, 'ContextRecallRequest'), strictCodec: codec(input, 'ContextRecallRequest')}],
  result: codec(output, 'ContextRecallResult'), cancellation: {parameter: 'signal' as const},
})
export const remoteInfo = createTypertRemoteInfo({package: '@forever-lwy/dsh-context-recall', methods: {
  'contextRecall/get': method(empty, viewSchema),
  'contextRecall/save': method(saveSchema, viewSchema),
  'contextRecall/test': method(testSchema, testResultSchema),
  'contextRecall/search': method(searchRequestSchema, searchResultSchema),
  'contextRecall/read': method(readRequestSchema, readResultSchema),
  'contextRecall/status': method(empty, statusResultSchema),
  'contextRecall/locate': method(locateRequestSchema, locateResultSchema),
}}, z)
async function invoke<T>(remote: any, key: string, request: unknown, signal?: AbortSignal): Promise<T> {
  const result = await (remoteInfo.methods as any)[key].invoke(remote, {request}, signal)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
export const readSettings = (remote: any, signal?: AbortSignal) => invoke<SettingsView>(remote, 'contextRecall/get', {}, signal)
export const saveSettings = (remote: any, request: SaveRequest, signal?: AbortSignal) => invoke<SettingsView>(remote, 'contextRecall/save', request, signal)
export const testEmbedding = (remote: any, request: TestRequest, signal?: AbortSignal) => invoke<z.infer<typeof testResultSchema>>(remote, 'contextRecall/test', request, signal)
export const searchSessions = (remote: any, request: SearchRequest, signal?: AbortSignal) => invoke<SearchResult>(remote, 'contextRecall/search', request, signal)
export const readSessionText = (remote: any, request: ReadRequest, signal?: AbortSignal) => invoke<ReadResult>(remote, 'contextRecall/read', request, signal)
export const locateMessage = (remote: any, request: LocateRequest, signal?: AbortSignal) => invoke<LocateResult>(remote, 'contextRecall/locate', request, signal)
export const readIndexStatus = (remote: any, signal?: AbortSignal) => invoke<StatusResult>(remote, 'contextRecall/status', {}, signal)
