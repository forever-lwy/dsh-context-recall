import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import * as Plugin from '../lib/index.js'
import { ContextRecallCompaction } from '../lib/compaction.js'

class TestAdapter extends LlmAdapter {
  providerInfo(provider) { return { id: provider, name: 'Test summary provider' } }
  async listModels(provider) { return [{ provider, id: 'test-summary-model', name: 'Test summary model' }] }
  async *stream() {
    yield { type: 'text-delta', index: 0, text: 'Preserve exact identifiers and continue the pending user request.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('actual Cordis loads recall and replacement compaction as siblings, routes GUI model, and unloads cleanly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-recall-runtime-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const ctx = new Context()
  const fibers = []
  try {
    const descriptors = []
    ctx.provide('typert', {
      lookups: { register: () => () => {} },
      contexts: { registerHost: () => () => {} },
      remotes: { register: info => { descriptors.push(info); return () => {} } },
    })
    ctx.provide('credentials', {
      describe: async () => ({ configured: false, writable: true }),
      resolve: async () => undefined,
    })
    ctx.provide('sessionPersistence', { list: async () => [] })
    ctx.provide('sessionQuery', {
      readSession: async id => { const session = ctx.sessions.get(id); return { session: session.header, events: session.snapshotEvents() } },
    })
    fibers.push(await ctx.plugin(LlmRuntime))
    fibers.push(await ctx.plugin(SessionStore))
    fibers.push(await ctx.plugin(SessionProjectionRegistry))
    fibers.push(await ctx.plugin(AgentRegistry))
    fibers.push(await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false }))
    fibers.push(await ctx.plugin(ToolRuntime))
    fibers.push(await ctx.plugin(NativeToolExecutor))
    ctx.llm.registerAdapter(['test-summary-provider'], new TestAdapter())
    ctx.provide('tokenMeter', {
      measure: session => ({ nodes: session.surface.nodes.map(seq => ({ seq, tokens: 1000, heuristicTokens: 1000 })), totalTokens: session.surface.nodes.length * 1000 }),
      estimateMessage: () => 100,
    })

    // Match bundle loading order: native compaction starts before recall and
    // dynamically acquires the optional global-settings service.
    const compactionFiber = await ctx.plugin(ContextRecallCompaction, { auto: false, maxTokens: 4096 })
    fibers.push(compactionFiber)
    assert.ok(ctx.get('compaction') instanceof ContextRecallCompaction)
    const pluginFiber = await ctx.plugin(Plugin)
    fibers.push(pluginFiber)
    await compactionFiber
    assert.ok(ctx.get('contextRecall'))
    assert.ok(ctx.get('compaction') instanceof ContextRecallCompaction)
    assert.equal(ctx.tools.get('recall').name, 'recall')
    assert.equal(descriptors.length, 1)

    const signal = new AbortController().signal
    const before = await ctx.contextRecall.get({}, signal)
    assert.deepEqual(before.models.map(model => [model.provider, model.model]), [['test-summary-provider', 'test-summary-model']])
    const config = before.config
    config.compression = { provider: 'test-summary-provider', model: 'test-summary-model' }
    const after = await ctx.contextRecall.save({ config, expectedRevision: before.revision }, signal)
    assert.equal(after.revision, before.revision + 1)

    const session = ctx.sessions.create(SessionId('bootstrap-summary-session'))
    session.append('turn/start', { turn: 1 })
    const original = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Exact /work/task.ts details and user instructions. '.repeat(100) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await ctx.compaction.compactRegion(original.seq, original.seq, {
      session, options: { provider: 'unrelated-conversation-provider', model: 'conversation-model' },
    }, signal)
    const summary = session.snapshotEvents().find(event => event.type === 'compaction/summary')
    assert.equal(summary.data.provider, 'test-summary-provider')
    assert.equal(summary.data.model, 'test-summary-model')

    await pluginFiber.dispose()
    assert.equal(ctx.get('contextRecall'), undefined)
    assert.ok(ctx.get('compaction') instanceof ContextRecallCompaction)
    assert.equal(ctx.tools.get('recall'), undefined)
    const fallbackSession = ctx.sessions.create(SessionId('fallback-summary-session'))
    fallbackSession.append('turn/start', { turn: 1 })
    const fallbackOriginal = fallbackSession.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Native fallback retains exact user instructions. '.repeat(100) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await ctx.compaction.compactRegion(fallbackOriginal.seq, fallbackOriginal.seq, {
      session: fallbackSession, options: { provider: 'test-summary-provider', model: 'test-summary-model' },
    }, signal)
    const fallbackSummary = fallbackSession.snapshotEvents().find(event => event.type === 'compaction/summary')
    assert.equal(fallbackSummary.data.provider, 'test-summary-provider')
    assert.equal(fallbackSummary.data.model, 'test-summary-model')
  } finally {
    for (const fiber of fibers.reverse()) await fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
