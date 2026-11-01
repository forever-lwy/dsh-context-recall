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
const empty = z.object({}).strict()
const codec = (schema: z.ZodType, typeSymbol: string) => ({ mode: 'strict' as const, typeSymbol, create: () => schema })
const method = (input: z.ZodType, output: z.ZodType) => ({
  service: 'contextRecall', invocation: {kind: 'direct' as const},
  parameters: [{name: 'request', source: 'json' as const, codec: codec(input, 'ContextRecallRequest'), strictCodec: codec(input, 'ContextRecallRequest')}],
  result: codec(output, 'ContextRecallResult'), cancellation: {parameter: 'signal' as const},
})
export const remoteInfo = createTypertRemoteInfo({package: 'dsh-context-recall', methods: {
  'contextRecall/get': method(empty, viewSchema),
  'contextRecall/save': method(saveSchema, viewSchema),
  'contextRecall/test': method(testSchema, testResultSchema),
}}, z)
async function invoke<T>(remote: any, key: string, request: unknown, signal?: AbortSignal): Promise<T> {
  const result = await (remoteInfo.methods as any)[key].invoke(remote, {request}, signal)
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}
export const readSettings = (remote: any, signal?: AbortSignal) => invoke<SettingsView>(remote, 'contextRecall/get', {}, signal)
export const saveSettings = (remote: any, request: SaveRequest, signal?: AbortSignal) => invoke<SettingsView>(remote, 'contextRecall/save', request, signal)
export const testEmbedding = (remote: any, request: TestRequest, signal?: AbortSignal) => invoke<z.infer<typeof testResultSchema>>(remote, 'contextRecall/test', request, signal)
