import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Context, symbols } from '@deepseek-ai/cordis'
import { Loader, Group } from '@deepseek-ai/cordis-plugin-loader'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { AgentRegistry, agentEvents } from '@deepseek-ai/dsh-agent'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { LlmRuntime, LlmAdapter, createUserMessage, createMessage, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { registerCompressionBridge } from '../lib/compaction.js'

class CapacityAdapter extends LlmAdapter {
  calls = []
  holdNext
  providerInfo(id) { return {id, name: id} }
  async resolveModel(provider, model) {
    if (this.holdNext && provider === 'conversation') {
      const hold = this.holdNext; this.holdNext = undefined
      hold.started()
      await hold.wait
    }
    return {provider, id: model, name: model, context: {contextWindow: 20000}}
  }
  async *stream(options) {
    this.calls.push(options)
    yield {type: 'text-delta', index: 0, text: 'A compact checkpoint retaining exact paths, instructions and pending work.'}
    yield {type: 'finish', reason: {kind: 'stop'}}
  }
}

async function pressureFixture(t, nativeConfig = {}, originalNodeTokens = 1000) {
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Loader, {baseUrl: new URL('../package.json', import.meta.url).href})
  ctx.loader.builtins.group = Group
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(LlmRuntime)
  const adapter = new CapacityAdapter()
  ctx.llm.registerAdapter(['conversation', 'summary'], adapter)
  // Each original message normally prices to 1000 tokens and a checkpoint to
  // 100. This controls exact boundary pressure while native selection,
  // shrinking, transactions and automatic listeners remain real.
  ctx.provide('tokenMeter', {
    measure: session => {
      const events = new Map(session.snapshotEvents().map(event => [event.seq, event]))
      const nodes = session.surface.nodes.map(seq => ({seq, tokens: events.get(seq)?.type === 'compaction/summary' ? 100 : originalNodeTokens, heuristicTokens: originalNodeTokens}))
      return {nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0)}
    },
    estimateMessage: () => 100,
  })
  await ctx.plugin(AgentPresetRegistry, {default: 'standard'})
  for (const id of ['standard', 'ptc', 'minimal', 'cordis']) {
    const path = fileURLToPath(import.meta.resolve(`@deepseek-ai/dsh-web-app/presets/${id}.patch.yml`))
    const declared = loadOverlayPatches('threshold integration', path)[0].insert[0].config
    const group = structuredClone(declared.plugins.find(row => row.id === 'compaction'))
    group.config = group.config.filter(row => row.name === '@deepseek-ai/dsh-compaction-basic')
    group.config[0].config = {auto: true, thresholdRatio: 0.8, headroomTokens: 0, maxTokens: 1024,
      retainRatio: 0.16, compactionRetries: 0, ...nativeConfig}
    await ctx.agentPresets.register({id, plugins: [group]})
  }
  let serial = 0
  const makeAgent = async (preset = 'standard', requestMaxTokens) => {
    const session = ctx.sessions.create(SessionId(`threshold-${++serial}`))
    const agent = {id: session.id, session, options: {provider: 'conversation', model: 'chat'}, status: 'idle'}
    // Agent event carriers key by the Agent identity itself. The real factory
    // creates its scope under that same identity before mounting the preset.
    const scope = createScope(ctx, agent)
    agent.ctx = scope.ctx
    await ctx.agentPresets.mount(scope.ctx, preset)
    for (let turn = 1; turn <= 4; turn++) {
      session.append('turn/start', {turn})
      session.append('user/message', createUserMessage({content: [{type: 'text', text: `User decision ${turn}: preserve /work/exact.ts and continue the requested task. `.repeat(40)}], source: {kind: 'user'}}), {surfaceOp: 'append'})
      session.append('step/start', {turn, step: 1})
      if (turn === 1) session.append('request/header', {header: {config: {provider: 'conversation', model: 'chat', ...(requestMaxTokens === undefined ? {} : {maxTokens: requestMaxTokens})}}, reason: 'initial'})
      session.append('assistant/message', {turn, step: 1, stream: [], message: createMessage({role: 'assistant', content: [{type: 'text', text: `Assistant work ${turn}: exact identifiers and results. `.repeat(40)}], source: {kind: 'model', provider: 'conversation', model: 'chat'}})}, {surfaceOp: 'append'})
      session.append('step/end', {turn, step: 1})
      session.append('turn/end', {turn, reason: {kind: 'completed'}})
    }
    session.append('turn/start', {turn: 5})
    await ctx.agents.register(agent)
    return agent
  }
  const summaries = agent => agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')
  const step = agent => agentEvents(ctx, agent).waterfall('agent/pre-step', {turn: 5, step: 1, messages: [], signal: new AbortController().signal}, async () => [])
  const bridge = async getCompression => ctx.plugin({
    inject: ['agents', 'agentPresets'], apply: child => { registerCompressionBridge(child, () => ({compression: getCompression()})) },
  })
  return {ctx, adapter, makeAgent, summaries, step, bridge}
}

test('native automatic listener stays below the GUI ratio and compacts at the exact boundary', async t => {
  const f = await pressureFixture(t)
  const agent = await f.makeAgent()
  let thresholdRatio = 0.41
  await f.bridge(() => ({provider: 'summary', model: 'small', thresholdRatio}))
  assert.equal(f.ctx.tokenMeter.measure(agent.session).totalTokens, 8000)
  await f.step(agent)
  assert.equal(f.summaries(agent).length, 0, '8000 tokens is below 41% of a 20000-token model')
  thresholdRatio = 0.4
  await f.step(agent)
  assert.equal(f.summaries(agent).length, 1, 'native pressure includes equality at 40%')
  assert.equal(f.summaries(agent)[0].data.provider, 'summary')
  assert.equal(f.summaries(agent)[0].data.model, 'small')
  assert.ok(f.ctx.tokenMeter.measure(agent.session).totalTokens < 8000)
})

test('ratio updates reach existing and future isolated presets and override exact-model thresholds', async t => {
  const f = await pressureFixture(t, {modelPolicies: [{provider: 'conversation', model: 'chat', thresholdRatio: 0.9}]})
  const existing = await f.makeAgent('standard')
  const engine = f.ctx.agentPresets.serviceFor(existing, 'compaction')
  const implementation = engine[symbols.original] ?? engine
  const policyBefore = Object.getOwnPropertyDescriptor(implementation, 'config')
  let thresholdRatio = 0.4
  await f.bridge(() => ({provider: '', model: '', thresholdRatio}))
  const agents = [existing]
  for (const preset of ['ptc', 'minimal', 'cordis']) agents.push(await f.makeAgent(preset))
  for (const agent of agents) {
    await f.step(agent)
    assert.equal(f.summaries(agent).length, 1)
  }
  assert.deepEqual(Object.getOwnPropertyDescriptor(implementation, 'config'), policyBefore, 'the frozen native policy and descriptor must remain untouched')
  const next = await f.makeAgent('minimal')
  thresholdRatio = 0.7
  await f.step(next)
  assert.equal(f.summaries(next).length, 0)
  thresholdRatio = 0.3
  await f.step(next)
  assert.equal(f.summaries(next).length, 1)
})

test('inherit and plugin removal restore native automatic thresholds without replacing services', async t => {
  const f = await pressureFixture(t)
  const existing = await f.makeAgent()
  const implementation = f.ctx.agentPresets.serviceFor(existing, 'compaction')[symbols.original]
  const priorCompact = Object.getOwnPropertyDescriptor(implementation, 'compactIfNeeded')
  let thresholdRatio = null
  const plugin = await f.bridge(() => ({provider: '', model: '', thresholdRatio}))
  await f.step(existing)
  assert.equal(f.summaries(existing).length, 0)
  thresholdRatio = 0.3
  const another = await f.makeAgent('minimal')
  await plugin.dispose()
  assert.deepEqual(Object.getOwnPropertyDescriptor(implementation, 'compactIfNeeded'), priorCompact)
  await f.step(another)
  assert.equal(f.summaries(another).length, 0, 'native 80% is restored after plugin removal')
})

test('configured percentage remains capped by native output reservation and compaction headroom', async t => {
  const f = await pressureFixture(t, {headroomTokens: 12000})
  const agent = await f.makeAgent('standard', 1000)
  await f.bridge(() => ({provider: '', model: '', thresholdRatio: 0.9}))
  await f.step(agent)
  assert.equal(f.summaries(agent).length, 1, 'native remaining-capacity threshold 7000 takes precedence over 90%=18000')
})

test('an automatic check snapshots its ratio before asynchronous capacity lookup', async t => {
  const f = await pressureFixture(t)
  const agent = await f.makeAgent()
  let thresholdRatio = 0.41
  await f.bridge(() => ({provider: '', model: '', thresholdRatio}))
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const wait = new Promise(resolve => { release = resolve })
  f.adapter.holdNext = {started: entered, wait}
  const checking = f.step(agent)
  await started
  thresholdRatio = 0.3
  release()
  await checking
  assert.equal(f.summaries(agent).length, 0, 'in-flight checks retain their earlier 41% threshold')
  await f.step(agent)
  assert.equal(f.summaries(agent).length, 1, 'the next check adopts the saved 30% threshold')
})

test('native absolute-tail conflicts fall back before mutation and still complete one automatic compaction', async t => {
  const f = await pressureFixture(t, {retainTokens: 9000, retainRatio: undefined}, 2500)
  const agent = await f.makeAgent()
  const engine = f.ctx.agentPresets.serviceFor(agent, 'compaction')
  await f.bridge(() => ({provider: 'summary', model: 'small', thresholdRatio: 0.4}))
  assert.equal(f.ctx.tokenMeter.measure(agent.session).totalTokens, 20000)
  await f.step(agent)
  assert.equal(f.summaries(agent).length, 1, 'the incompatible 8000-token override must fall back to the valid native 16000-token threshold')
  assert.equal(f.adapter.calls.length, 1, 'the rejected override must not start a summary transaction')
  assert.equal(f.summaries(agent)[0].data.provider, 'summary')
  assert.equal(f.summaries(agent)[0].data.model, 'small')
  assert.equal(engine.config.retainTokens, 9000)
  assert.equal(engine.config.thresholdRatio, 0.8)
  assert.ok(f.ctx.tokenMeter.measure(agent.session).totalTokens < 16000)
})

test('a high automatic ratio preserves native manual compaction and overflow recovery with the selected summary model', async t => {
  const f = await pressureFixture(t)
  await f.bridge(() => ({provider: 'summary', model: 'small', thresholdRatio: 0.99}))
  const manual = await f.makeAgent('standard')
  await f.step(manual)
  assert.equal(f.summaries(manual).length, 0)
  // The real manual backend executes its maintenance transaction and flush;
  // this idle fixture supplies only the Agent's admission callback.
  manual.session.append('turn/end', {turn: 5, reason: {kind: 'completed'}})
  manual.runMaintenance = callback => callback(new AbortController().signal)
  const manualEngine = f.ctx.agentPresets.serviceFor(manual, 'compaction')
  const result = await manualEngine.compactNow(manual, new AbortController().signal)
  assert.ok(result)
  assert.equal(f.summaries(manual).length, 1)
  assert.equal(f.summaries(manual)[0].data.provider, 'summary')
  assert.equal(f.summaries(manual)[0].data.model, 'small')

  const overflow = await f.makeAgent('minimal')
  await f.step(overflow)
  assert.equal(f.summaries(overflow).length, 0)
  const action = await agentEvents(f.ctx, overflow).waterfall('agent/request-error', {
    turn: 5, step: 1,
    failure: {code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'provider-confirmed context overflow'},
    signal: new AbortController().signal,
  }, async () => ({kind: 'unhandled'}))
  assert.equal(action.kind, 'retry', 'the native overflow listener must compact despite pressure staying below 99%')
  assert.equal(f.summaries(overflow).length, 1)
  assert.equal(f.summaries(overflow)[0].data.provider, 'summary')
  assert.equal(f.summaries(overflow)[0].data.model, 'small')
})
