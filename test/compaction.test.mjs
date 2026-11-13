import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ContextRecallCompaction, summarizeWithGlobalModel, COMPACTION_INSTRUCTION } from '../lib/compaction.js'

const textChunks = (text = 'Preserved user goals, exact files and next action.') => [
  { type: 'reasoning-delta', index: 0, text: 'private thought' },
  { type: 'text-delta', index: 1, text },
  { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } },
  { type: 'finish', reason: { kind: 'stop' } },
]
function fixture(chunks = textChunks()) {
  let global = { provider: 'summary-provider', model: 'summary-model' }
  const calls = []
  const ctx = {
    contextRecall: { current: () => ({ compression: global }) },
    llm: { async *stream(options) { calls.push(options); yield* chunks } },
  }
  const history = []
  const agent = {
    options: { provider: 'conversation-provider', model: 'conversation-model' },
    session: {
      id: 'session-a', requestHeader: () => ({ config: agent.options }),
      toolHistory: () => history,
    },
  }
  const input = {
    messages: Object.freeze([Object.freeze({ role: 'user', content: [{ type: 'text', text: 'Remember exact path /work/example.ts' }] })]),
    tools: Object.freeze([{ name: 'read', description: 'Read', parameters: { type: 'object' } }]),
  }
  const receiver = { ctx, readSettings: () => ctx.contextRecall.current(), config: {
    modelPolicies: [], maxTokens: 4096,
    summarizationProvider: '', summarizationModel: '',
  } }
  return { ctx, calls, agent, input, history, receiver,
    update: value => { global = value },
    run: signal => ContextRecallCompaction.prototype.summarize.call(receiver, input, agent, signal),
  }
}

test('replacement inherits native compaction operations and policy schema', () => {
  assert.equal(ContextRecallCompaction.prototype.compactRegion, BasicCompactionEngine.prototype.compactRegion)
  assert.equal(ContextRecallCompaction.prototype.compactNow, BasicCompactionEngine.prototype.compactNow)
  assert.equal(ContextRecallCompaction.prototype.compactIfNeeded, BasicCompactionEngine.prototype.compactIfNeeded)
  assert.equal(ContextRecallCompaction.Config, BasicCompactionEngine.Config)
  assert.ok(!ContextRecallCompaction.inject.includes('contextRecall'))
})

test('global summary route preserves source prefix, tools, cancellation and exact durable call facts', async () => {
  const f = fixture()
  const signal = new AbortController().signal
  const result = await f.run(signal)
  const call = f.calls[0]
  assert.equal(call.provider, 'summary-provider')
  assert.equal(call.model, 'summary-model')
  assert.equal(call.messages[0], f.input.messages[0])
  assert.deepEqual(call.tools, f.input.tools)
  assert.equal(call.toolHistory, f.history)
  assert.equal(call.signal, signal)
  assert.equal(call.purpose, 'compaction')
  assert.equal(call.sessionId, 'session-a')
  assert.equal(call.messages.at(-1).content[0].text, COMPACTION_INSTRUCTION)
  assert.equal(f.input.messages.length, 1)
  assert.equal(f.agent.options.provider, 'conversation-provider')
  assert.equal(result.provider, call.provider)
  assert.equal(result.model, call.model)
  assert.equal(result.maxTokens, call.maxTokens)
  assert.equal(result.llmStreamCall, true)
  assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 })
  assert.equal(result.summary.length, 1)
  assert.equal(result.summary[0].type, 'text')
  assert.equal(result.rawOutput.length, 2)
})

test('GUI route edits apply to subsequent calls; native target-specific cap still applies', async () => {
  const f = fixture()
  f.receiver.config.modelPolicies = [{ provider: 'conversation-provider', model: 'conversation-model', maxTokens: 2048 }]
  await f.run()
  f.update({ provider: 'second-provider', model: 'second-model' })
  await f.run()
  assert.equal(f.calls[0].provider, 'summary-provider')
  assert.equal(f.calls[1].provider, 'second-provider')
  assert.equal(f.calls[1].model, 'second-model')
  assert.equal(f.calls[1].maxTokens, 2048)
})

test('empty global route delegates to native summary routing including its per-model override', async () => {
  const f = fixture()
  f.update({ provider: '', model: '' })
  f.receiver.config.modelPolicies = [{
    provider: 'conversation-provider', model: 'conversation-model',
    summarizationProvider: 'native-provider', summarizationModel: 'native-model', maxTokens: 1024,
  }]
  const result = await f.run()
  assert.equal(f.calls[0].provider, 'native-provider')
  assert.equal(f.calls[0].model, 'native-model')
  assert.equal(result.maxTokens, 1024)
})

test('partial route rejects before provider IO', async () => {
  const f = fixture()
  f.update({ provider: 'provider', model: '' })
  await assert.rejects(f.run(), /configured together/)
  assert.equal(f.calls.length, 0)
})

test('already aborted summary performs no provider IO', async () => {
  const f = fixture()
  const abort = new AbortController()
  const reason = new Error('cancel before summary')
  abort.abort(reason)
  await assert.rejects(f.run(abort.signal), error => error === reason)
  assert.equal(f.calls.length, 0)
})

test('abort during the stream rejects instead of returning a partial checkpoint', async () => {
  const f = fixture()
  const abort = new AbortController()
  const reason = new Error('cancel while generating')
  f.ctx.llm.stream = async function* (options) {
    assert.equal(options.signal, abort.signal)
    yield { type: 'text-delta', index: 0, text: 'partial' }
    abort.abort(reason)
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await assert.rejects(f.run(abort.signal), error => error === reason)
})

test('truncation, provider failures, blank text and image summaries fail closed', async () => {
  const cases = [
    [[{ type: 'text-delta', index: 0, text: 'partial' }, { type: 'finish', reason: { kind: 'max-tokens' } }], /truncated/],
    [[{ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_NOT_FOUND', message: 'Missing model' } } }], /Missing model/],
    [[{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'Provider aborted' } } }], /Provider aborted/],
    [textChunks('  '), /no text/],
    [[{ type: 'block-end', index: 0, block: { type: 'image', attachment: {} } }], /cannot contain image/],
  ]
  for (const [chunks, pattern] of cases) await assert.rejects(fixture(chunks).run(), pattern)
})

test('in-flight call snapshots the configured route before GUI changes', async () => {
  const f = fixture()
  f.ctx.llm.stream = async function* (options) {
    f.update({ provider: 'next-provider', model: 'next-model' })
    assert.equal(options.model, 'summary-model')
    yield* textChunks()
  }
  const result = await f.run()
  assert.equal(result.provider, 'summary-provider')
  assert.equal(result.model, 'summary-model')
})

test('summary failures preserve provider-specific codes and structured facts on rc.3', async () => {
  const failure = { code: 'PROVIDER_CUSTOM_LIMIT', message: 'Custom limit', status: 429, providerRetryAfterMs: 1500 }
  await assert.rejects(fixture([{ type: 'finish', reason: { kind: 'error', failure } }]).run(), error => {
    assert.equal(error.code, failure.code)
    assert.equal(error.failure.status, 429)
    assert.equal(error.failure.providerRetryAfterMs, 1500)
    return true
  })
})

function transactionFixture(chunks) {
  const f = fixture(chunks)
  const session = Session.create(SessionId('real-compaction-session'))
  session.append('turn/start', { turn: 1 })
  const original = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Very long original history with exact identifiers. '.repeat(100) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  f.agent.session = session
  f.ctx.tokenMeter = {
    measure: () => ({ nodes: session.surface.nodes.map(seq => ({ seq, tokens: 1000, heuristicTokens: 1000 })), totalTokens: 1000 }),
    estimateMessage: () => 100,
  }
  f.ctx.waterfall = () => false
  const backend = Object.create(ContextRecallCompaction.prototype)
  Object.defineProperty(backend, 'ctx', { value: f.ctx })
  Object.defineProperty(backend, 'config', { value: f.receiver.config })
  Object.defineProperty(backend, 'readSettings', { value: f.receiver.readSettings })
  return { ...f, session, original, compact: () => backend.compactRegion(original.seq, original.seq, f.agent) }
}

test('native transaction commits global model attribution and retains original raw log', async () => {
  const f = transactionFixture(textChunks())
  const result = await f.compact()
  assert.equal(result.shadowedSeqs[0], f.original.seq)
  assert.equal(f.session.eventAt(f.original.seq).data.content[0].text, f.original.data.content[0].text)
  const summary = f.session.snapshotEvents().find(event => event.type === 'compaction/summary')
  assert.equal(summary.data.provider, 'summary-provider')
  assert.equal(summary.data.model, 'summary-model')
  assert.equal(summary.data.llmStreamCall, true)
  assert.deepEqual(f.session.snapshotEvents().slice(-4).map(event => event.type), [
    'compaction/start', 'compaction/summary', 'user/message', 'compaction/end',
  ])
  assert.ok(!f.session.surface.nodes.includes(f.original.seq))
})

test('provider failure closes native transaction without replacing any original surface', async () => {
  const f = transactionFixture([{ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_NOT_FOUND', message: 'Missing model' } } }])
  const surface = [...f.session.surface.nodes]
  await assert.rejects(f.compact(), /Missing model/)
  assert.deepEqual(f.session.surface.nodes, surface)
  assert.deepEqual(f.session.snapshotEvents().slice(-2).map(event => event.type), ['compaction/start', 'compaction/end'])
  assert.match(f.session.snapshotEvents().at(-1).data.error, /Missing model/)
})
