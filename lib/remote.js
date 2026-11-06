import { z } from 'zod';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { configSchema } from './config.js';
export const viewSchema = z.object({
    config: configSchema, revision: z.number().int().nonnegative(),
    credential: z.object({ configured: z.boolean(), writable: z.boolean() }),
    models: z.array(z.object({ provider: z.string(), model: z.string(), name: z.string() })),
    status: z.object({ semanticAvailable: z.boolean(), message: z.string() }),
});
export const saveSchema = z.object({ config: configSchema, expectedRevision: z.number().int().nonnegative(), apiKey: z.string().trim().min(1).max(16384).optional(), clearApiKey: z.boolean().optional() }).strict();
export const testSchema = z.object({ config: configSchema, apiKey: z.string().trim().min(1).max(16384).optional() }).strict();
const testResultSchema = z.object({ dimensions: z.number().int().positive(), message: z.string() });
const empty = z.object({}).strict();
const codec = (schema, typeSymbol) => ({ mode: 'strict', typeSymbol, create: () => schema });
const method = (input, output) => ({
    service: 'contextRecall', invocation: { kind: 'direct' },
    parameters: [{ name: 'request', source: 'json', codec: codec(input, 'ContextRecallRequest'), strictCodec: codec(input, 'ContextRecallRequest') }],
    result: codec(output, 'ContextRecallResult'), cancellation: { parameter: 'signal' },
});
export const remoteInfo = createTypertRemoteInfo({ package: '@forever-lwy/dsh-context-recall', methods: {
        'contextRecall/get': method(empty, viewSchema),
        'contextRecall/save': method(saveSchema, viewSchema),
        'contextRecall/test': method(testSchema, testResultSchema),
    } }, z);
async function invoke(remote, key, request, signal) {
    const result = await remoteInfo.methods[key].invoke(remote, { request }, signal);
    if (!result.ok)
        throw new Error(result.error.message);
    return result.value;
}
export const readSettings = (remote, signal) => invoke(remote, 'contextRecall/get', {}, signal);
export const saveSettings = (remote, request, signal) => invoke(remote, 'contextRecall/save', request, signal);
export const testEmbedding = (remote, request, signal) => invoke(remote, 'contextRecall/test', request, signal);
