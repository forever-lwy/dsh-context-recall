import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context, symbols } from '@deepseek-ai/cordis'
import { Loader, Group } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { LlmRuntime, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { createScope } from '@deepseek-ai/dsh-scope'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import * as Plugin from '../lib/index.js'
import { registerCompressionBridge } from '../lib/compaction.js'

class TestAdapter extends LlmAdapter {
  providerInfo(id) { return { id, name: id } }
  async *stream() {
    yield { type: 'text-delta', index: 0, text: 'Exact paths, current user intent, pending work, and the next action.' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function presetFixture(t) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Loader, { baseUrl: new URL('../package.json', import.meta.url).href })
  ctx.loader.builtins.group = Group
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['conversation', 'summary-a', 'summary-b'], new TestAdapter())
  ctx.provide('tokenMeter', {
    measure: session => ({ nodes: session.surface.nodes.map(seq => ({ seq, tokens: 1000, heuristicTokens: 1000 })), totalTokens: session.surface.nodes.length * 1000 }),
    estimateMessage: () => 100,
  })
  await ctx.plugin(AgentPresetRegistry, { default: 'standard' })
  for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
    const path = fileURLToPath(import.meta.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`))
    const declared = loadOverlayPatches('preset compression test', path)[0].insert[0].config
    const compaction = structuredClone(declared.plugins.find(row => row.id === 'compaction'))
    // Mount each shipped isolation realm and its real native backend. Other
    // preset capabilities are unrelated to this focused integration test.
    compaction.config = compaction.config.filter(row => row.name === '@deepseek-ai/dsh-compaction-basic')
    compaction.config[0].config = { ...compaction.config[0].config, auto: false, maxTokens: 4096 }
    await ctx.agentPresets.register({ id, plugins: [compaction] })
  }
  let serial = 0
  const makeAgent = async preset => {
    const scope = createScope(ctx, {})
    await ctx.agentPresets.mount(scope.ctx, preset)
    const session = ctx.sessions.create(SessionId(`preset-test-${++serial}`))
    const agent = { id: session.id, ctx: scope.ctx, session, options: { provider: 'conversation', model: 'chat' }, status: 'idle' }
    await ctx.agents.register(agent)
    return agent
  }
  const compact = async agent => {
    const engine = ctx.agentPresets.serviceFor(agent, 'compaction')
    agent.session.append('turn/start', { turn: agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length + 1 })
    const original = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Important /work/exact.ts details and pending work. '.repeat(100) }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await engine.compactRegion(original.seq, original.seq, agent, new AbortController().signal)
    return agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary').at(-1)
  }
  return { ctx, makeAgent, compact }
}

test('global model reaches actual isolated native engines in all four shipped web preset realms', async t => {
  const { ctx, makeAgent, compact } = await presetFixture(t)
  assert.equal(ctx.get('compaction'), undefined, 'web compaction is intentionally absent at root')
  const existing = await makeAgent('standard')
  const before = ctx.agentPresets.serviceFor(existing, 'compaction')
  assert.ok(before instanceof BasicCompactionEngine)
  assert.equal(Object.hasOwn(before, 'summarize'), false)
  let compression = { provider: 'summary-a', model: 'small-a' }
  const bridge = await ctx.plugin({
    name: 'compression-bridge-test', inject: ['agents', 'agentPresets'],
    apply: child => { registerCompressionBridge(child, () => ({ compression })) },
  })
  const engineConfig = before.config
  assert.equal(Object.hasOwn(before, 'summarize'), true, 'existing agents are bound on activation')
  const implementation = before[symbols.original] ?? before
  const wrapped = Object.getOwnPropertyDescriptor(implementation, 'summarize').value
  for (let index = 0; index < 10; index++) {
    await agentEvents(ctx, existing).waterfall('agent/pre-step', {
      turn: 1, step: index + 1, messages: [], signal: new AbortController().signal,
    }, async () => [])
    assert.equal(Object.getOwnPropertyDescriptor(implementation, 'summarize').value, wrapped,
      'fresh tracing facades must not stack wrappers on the same native instance')
  }
  const agents = [existing]
  for (const preset of ['ptc', 'minimal', 'cordis']) agents.push(await makeAgent(preset))
  for (const agent of agents) {
    const engine = ctx.agentPresets.serviceFor(agent, 'compaction')
    assert.equal(Object.hasOwn(engine, 'summarize'), true, 'awaited agent/created binds before input admission')
    assert.equal(Object.getPrototypeOf(engine).summarize, BasicCompactionEngine.prototype.summarize)
    const summary = await compact(agent)
    assert.equal(summary.data.provider, 'summary-a')
    assert.equal(summary.data.model, 'small-a')
    agent.session.append('turn/end', { turn: 1 })
  }
  assert.equal(before.config, engineConfig, 'native pressure and retention policy remains untouched')
  compression = { provider: 'summary-b', model: 'small-b' }
  const summary = await compact(existing)
  assert.equal(summary.data.provider, 'summary-b')
  assert.equal(summary.data.model, 'small-b')
  existing.session.append('turn/end', { turn: 2 })
  await bridge.dispose()
  for (const agent of agents) assert.equal(Object.hasOwn(ctx.agentPresets.serviceFor(agent, 'compaction'), 'summarize'), false)
  const native = await compact(existing)
  assert.equal(native.data.provider, 'conversation')
  assert.equal(native.data.model, 'chat')
})

test('a native preset engine restart is rebound before a following manual compaction', async t => {
  const { ctx, makeAgent, compact } = await presetFixture(t)
  const agent = await makeAgent('minimal')
  const bridge = await ctx.plugin({
    inject: ['agents', 'agentPresets'],
    apply: child => { registerCompressionBridge(child, () => ({ compression: { provider: 'summary-a', model: 'small-a' } })) },
  })
  const previous = ctx.agentPresets.serviceFor(agent, 'compaction')
  // Read the owned context descriptor: Cordis deliberately rebinds ordinary
  // service.ctx reads to the caller's dependency context.
  await Object.getOwnPropertyDescriptor(previous, 'ctx').value.fiber.restart()
  const current = ctx.agentPresets.serviceFor(agent, 'compaction')
  assert.notEqual(current, previous)
  assert.equal(Object.hasOwn(current, 'summarize'), true)
  const summary = await compact(agent)
  assert.equal(summary.data.provider, 'summary-a')
  await bridge.dispose()
  assert.equal(Object.hasOwn(current, 'summarize'), false)
})

test('empty selection delegates to a prior instance hook and disposal restores its exact descriptor', async t => {
  const { ctx, makeAgent, compact } = await presetFixture(t)
  const agent = await makeAgent('standard')
  const engine = ctx.agentPresets.serviceFor(agent, 'compaction')
  const native = engine.summarize
  let priorCalls = 0
  const prior = function (...args) { priorCalls++; return native.apply(this, args) }
  Object.defineProperty(engine, 'summarize', { configurable: true, enumerable: true, writable: false, value: prior })
  const descriptor = Object.getOwnPropertyDescriptor(engine, 'summarize')
  const bridge = await ctx.plugin({
    inject: ['agents', 'agentPresets'],
    apply: child => { registerCompressionBridge(child, () => ({ compression: { provider: '', model: '' } })) },
  })
  const summary = await compact(agent)
  assert.equal(summary.data.provider, 'conversation')
  assert.equal(priorCalls, 1)
  await bridge.dispose()
  assert.deepEqual(Object.getOwnPropertyDescriptor(engine, 'summarize'), descriptor)
})

test('disposal preserves a later instance hook and deactivates the bridge it retained', async t => {
  const { ctx, makeAgent, compact } = await presetFixture(t)
  const agent = await makeAgent('standard')
  const engine = ctx.agentPresets.serviceFor(agent, 'compaction')
  const bridge = await ctx.plugin({
    inject: ['agents', 'agentPresets'],
    apply: child => { registerCompressionBridge(child, () => ({ compression: { provider: 'summary-a', model: 'small-a' } })) },
  })
  const retained = engine.summarize
  const later = function (...args) { return retained.apply(this, args) }
  Object.defineProperty(engine, 'summarize', { configurable: true, writable: true, value: later })
  await bridge.dispose()
  assert.equal(Object.getOwnPropertyDescriptor(engine, 'summarize').value, later)
  const summary = await compact(agent)
  assert.equal(summary.data.provider, 'conversation')
  assert.equal(summary.data.model, 'chat')
})

test('actual main bundle in its private-query group drives existing and future preset-native engines from saved GUI settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'context-recall-preset-main-'))
  const priorHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const { ctx, makeAgent, compact } = await presetFixture(t)
  t.after(async () => {
    // Dispose before restoring DSH_HOME so asynchronous cleanup stays confined.
    await ctx.fiber.dispose()
    if (priorHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = priorHome
    await rm(directory, { recursive: true, force: true })
  })
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
  await ctx.plugin(ToolRuntime)
  ctx.provide('sessionPersistence', { list: async () => [] })
  ctx.provide('credentials', { describe: async () => ({ configured: false, writable: true }), resolve: async () => undefined })
  await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
  const nativeQuery = ctx.sessionQuery
  const nativeQueryConfig = Object.getOwnPropertyDescriptor(nativeQuery, 'config').value
  const existing = await makeAgent('standard')
  const originalEngine = ctx.agentPresets.serviceFor(existing, 'compaction')
  assert.equal(Object.hasOwn(originalEngine, 'summarize'), false)
  const originalImport = ctx.loader.import.bind(ctx.loader)
  ctx.loader.import = (name, ...args) => name === '@forever-lwy/dsh-context-recall' ? Plugin
    : name === '@deepseek-ai/dsh-session-query-sqlite' ? { default: SessionQuerySqlite }
      : originalImport(name, ...args)
  ctx.provide('dshHomePath', path => join(directory, path))
  const rows = composeEntries([loadOverlayPatches('main-preset-integration', fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)))])
  await ctx.loader.root.update(rows)
  await ctx.loader.await()
  assert.ok(Object.getOwnPropertyDescriptor(ctx.sessionQuery, 'config').value === nativeQueryConfig, 'bundle preserves the root query instance')
  const main = [...ctx.loader.entries()].find(entry => entry.options.name === '@forever-lwy/dsh-context-recall')
  assert.equal(main.fiber.state, 2)
  assert.ok(Object.getOwnPropertyDescriptor(main.fiber.ctx.sessionQuery, 'config').value !== nativeQueryConfig, 'main owns an isolated query service')
  assert.equal(Object.hasOwn(originalEngine, 'summarize'), true, 'main activation reaches the pre-existing preset instance')
  const signal = new AbortController().signal
  const initial = await ctx.contextRecall.get({}, signal)
  const config = initial.config
  config.compression = { provider: 'summary-b', model: 'from-gui' }
  await ctx.contextRecall.save({ config, expectedRevision: initial.revision }, signal)
  const future = await makeAgent('minimal')
  const futureEngine = ctx.agentPresets.serviceFor(future, 'compaction')
  assert.equal(Object.hasOwn(futureEngine, 'summarize'), true)
  for (const agent of [existing, future]) {
    const summary = await compact(agent)
    assert.equal(summary.data.provider, 'summary-b')
    assert.equal(summary.data.model, 'from-gui')
    agent.session.append('turn/end', { turn: 1 })
  }
  await ctx.loader.root.update([])
  await ctx.loader.await()
  assert.ok(Object.getOwnPropertyDescriptor(ctx.sessionQuery, 'config').value === nativeQueryConfig, 'unloading preserves the root query instance')
  assert.equal(ctx.get('contextRecall'), undefined)
  assert.equal(Object.hasOwn(originalEngine, 'summarize'), false)
  assert.equal(Object.hasOwn(futureEngine, 'summarize'), false)
  const fallback = await compact(existing)
  assert.equal(fallback.data.provider, 'conversation')
  assert.equal(fallback.data.model, 'chat')
})
