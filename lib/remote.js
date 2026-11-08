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
const semanticSchema = z.object({ enabled: z.boolean(), ready: z.boolean(), coverage: z.number() });
export const searchRequestSchema = z.object({
    query: z.string().max(2000),
    mode: z.enum(['auto', 'keyword', 'title', 'semantic']).optional(),
    cwd: z.string().max(4096).optional(),
    includeArchived: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
}).strict();
const hitSchema = z.object({ seq: z.number().int(), type: z.string(), time: z.number().optional(), snippet: z.string(), source: z.enum(['keyword', 'semantic']) });
export const searchResultSchema = z.object({
    ok: z.boolean(), query: z.string(), mode: z.string(), semantic: semanticSchema, notice: z.string().optional(),
    groups: z.array(z.object({
        sessionId: z.string(), title: z.string().optional(), cwd: z.string().optional(),
        createdAt: z.number().optional(), updatedAt: z.number().optional(),
        archived: z.boolean(), subagent: z.boolean(), titleMatch: z.boolean(), score: z.number(), hitCount: z.number().int(),
        hits: z.array(hitSchema),
    })),
});
export const readRequestSchema = z.object({
    sessionId: z.string().min(1).max(512),
    seq: z.number().int().optional(), before: z.number().int().optional(), after: z.number().int().optional(),
    fromSeq: z.number().int().optional(), pageSize: z.number().int().optional(),
}).strict();
export const readResultSchema = z.object({
    ok: z.boolean(), error: z.string().optional(), sessionId: z.string().optional(), title: z.string().optional(),
    cwd: z.string().optional(), updatedAt: z.number().optional(),
    items: z.array(z.object({ seq: z.number().int(), type: z.string(), time: z.number().optional(), text: z.string() })).optional(),
    hasBefore: z.boolean().optional(), hasAfter: z.boolean().optional(),
});
export const statusResultSchema = z.object({
    ok: z.boolean(), sessions: z.number().int(), docs: z.number().int(), vectors: z.number().int(),
    semantic: semanticSchema, lastReconcileAt: z.number().optional(),
    workspaces: z.array(z.object({ cwd: z.string(), sessions: z.number().int() })),
});
export const locateRequestSchema = z.object({ sessionId: z.string().min(1).max(512), seq: z.number().int().nonnegative() }).strict();
export const locateResultSchema = z.object({ ok: z.boolean(), error: z.string().optional(), turn: z.number().int().optional(), text: z.string().optional() });
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
        'contextRecall/search': method(searchRequestSchema, searchResultSchema),
        'contextRecall/read': method(readRequestSchema, readResultSchema),
        'contextRecall/status': method(empty, statusResultSchema),
        'contextRecall/locate': method(locateRequestSchema, locateResultSchema),
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
export const searchSessions = (remote, request, signal) => invoke(remote, 'contextRecall/search', request, signal);
export const readSessionText = (remote, request, signal) => invoke(remote, 'contextRecall/read', request, signal);
export const locateMessage = (remote, request, signal) => invoke(remote, 'contextRecall/locate', request, signal);
export const readIndexStatus = (remote, signal) => invoke(remote, 'contextRecall/status', {}, signal);
