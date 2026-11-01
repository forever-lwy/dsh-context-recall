import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { registerCompressionBridge, thresholdConfigSnapshot, thresholdRetentionProblem } from '../lib/compaction.js'

class TargetPressureConfigError extends Error {
  constructor(message) { super(message); this.targetKey = 'p/m' }
}

test('threshold snapshots override every model threshold while preserving native retention, reserves and limits', async () => {
  const ctx = new Context()
  try {
    const engine = new BasicCompactionEngine(ctx, {
      auto: false, thresholdRatio: 0.8, retainTokens: 1234, headroomTokens: 8192, maxTokens: 4096,
      modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.9, retainRatio: 0.2, headroomTokens: 1024, maxTokens: 512 }],
    })
    const original = engine.config
    const snapshot = thresholdConfigSnapshot(original, 0.4)
    assert.ok(snapshot !== original)
    assert.equal(snapshot.thresholdRatio, 0.4)
    assert.equal(snapshot.modelPolicies[0].thresholdRatio, 0.4)
    assert.equal(snapshot.retainTokens, 1234)
    assert.equal(snapshot.headroomTokens, 8192)
    assert.equal(snapshot.maxTokens, 4096)
    assert.equal(snapshot.modelPolicies[0].retainRatio, 0.2)
    assert.equal(snapshot.modelPolicies[0].headroomTokens, 1024)
    assert.equal(snapshot.modelPolicies[0].maxTokens, 512)
    assert.equal(original.thresholdRatio, 0.8)
    assert.equal(original.modelPolicies[0].thresholdRatio, 0.9)
    assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.modelPolicies) && Object.isFrozen(snapshot.modelPolicies[0]))
  } finally { await ctx.fiber.dispose() }
})

test('retention validation rejects inherited and exact-model conflicts without rewriting either native policy', async () => {
  const ctx = new Context()
  try {
    const engine = new BasicCompactionEngine(ctx, {
      auto: false, thresholdRatio: 0.8, retainRatio: 0.3,
      modelPolicies: [{ provider: 'large', model: 'chat', retainRatio: 0.55 }],
    })
    assert.match(thresholdRetentionProblem(engine.config, 0.3), /30%/)
    assert.match(thresholdRetentionProblem(engine.config, 0.4), /large\/chat.*55%/)
    assert.equal(thresholdRetentionProblem(engine.config, 0.56), undefined)
    assert.equal(engine.config.retainRatio, 0.3)
    assert.equal(engine.config.modelPolicies[0].retainRatio, 0.55)
  } finally { await ctx.fiber.dispose() }
})

test('settings validator follows actual bound engines and unregisters when bridge unloads', async () => {
  const ctx = new Context()
  try {
    ctx.provide('agents', { list: () => [], get: () => undefined })
    ctx.provide('agentPresets', { serviceFor: () => undefined })
    const engine = new BasicCompactionEngine(ctx, {
      auto: false, thresholdRatio: 0.8, retainRatio: 0.16,
      modelPolicies: [{ provider: 'wide', model: 'chat', retainRatio: 0.45 }],
    })
    const validators = new Set()
    const bridge = await ctx.plugin({
      inject: ['agents', 'agentPresets'],
      apply(child) {
        registerCompressionBridge(child, () => ({ compression: { provider: '', model: '', thresholdRatio: null } }), {
          registerThresholdValidator(validate) { validators.add(validate); return () => { validators.delete(validate) } },
        })
      },
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(validators.size, 1)
    const validate = [...validators][0]
    assert.throws(() => validate(0.4), /wide\/chat.*45%/)
    validate(0.5)
    validate(null)
    await bridge.dispose()
    assert.equal(validators.size, 0)
    assert.equal(Object.hasOwn(engine, 'summarize'), false)
    assert.equal(Object.hasOwn(engine, 'compactIfNeeded'), false)
  } finally { await ctx.fiber.dispose() }
})

test('a newly encountered retention conflict keeps native automatic policy instead of shrinking retained history', async () => {
  const ctx = new Context()
  try {
    ctx.provide('agents', { list: () => [], get: () => undefined })
    ctx.provide('agentPresets', { serviceFor: () => undefined })
    const engine = new BasicCompactionEngine(ctx, { auto: false, thresholdRatio: 0.8, retainRatio: 0.5 })
    const nativeConfig = engine.config
    const calls = []
    Object.defineProperty(engine, 'compactIfNeeded', { configurable: true, writable: true,
      value: function () { calls.push(this.config); return Promise.resolve(null) },
    })
    await ctx.plugin({
      inject: ['agents', 'agentPresets'],
      apply(child) { registerCompressionBridge(child, () => ({ compression: { provider: '', model: '', thresholdRatio: 0.4 } })) },
    })
    await new Promise(resolve => setImmediate(resolve))
    const agent = { options: {}, session: { requestHeader: () => undefined } }
    assert.equal(await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal), null)
    assert.equal(calls.length, 1)
    assert.equal(calls[0], nativeConfig, 'fallback calls the prior policy with its original receiver config')
    assert.equal(engine.config, nativeConfig)
    assert.equal(engine.config.thresholdRatio, 0.8)
    assert.equal(engine.config.retainRatio, 0.5)
  } finally { await ctx.fiber.dispose() }
})

async function pressureFailureFixture(pressure) {
  const ctx = new Context()
  ctx.provide('agents', { list: () => [], get: () => undefined })
  ctx.provide('agentPresets', { serviceFor: () => undefined })
  const engine = new BasicCompactionEngine(ctx, { auto: false, thresholdRatio: 0.8, retainRatio: 0.16 })
  Object.defineProperty(engine, 'compactIfNeeded', { configurable: true, writable: true, value: pressure })
  await ctx.plugin({
    inject: ['agents', 'agentPresets'],
    apply(child) { registerCompressionBridge(child, () => ({ compression: { provider: '', model: '', thresholdRatio: 0.4 } })) },
  })
  await new Promise(resolve => setImmediate(resolve))
  return { ctx, engine, agent: { options: {}, session: { requestHeader: () => undefined } } }
}

test('absolute retention fallback recognizes only the native pre-transaction policy guard', async () => {
  const calls = []
  const guard = new TargetPressureConfigError('BasicCompactionConfig: p/m retainTokens (9000) must be less than threshold tokens 8000')
  const { ctx, engine, agent } = await pressureFailureFixture(function () {
    calls.push(this.config.thresholdRatio)
    return this.config.thresholdRatio === 0.4 ? Promise.reject(guard) : Promise.resolve(null)
  })
  try {
    assert.equal(await engine.compactIfNeeded(agent, 'pressure', new AbortController().signal), null)
    assert.deepEqual(calls, [0.4, 0.8])
  } finally { await ctx.fiber.dispose() }
})

test('summary and commit failures propagate once instead of retrying after possible native progress', async () => {
  for (const error of [
    Object.assign(new Error('summary is not smaller than the shadowed content'), { targetKey: 'p/m' }),
    Object.assign(new Error('BasicCompactionConfig: p/m retainTokens (9000) must be less than threshold tokens 8000'), { targetKey: 'p/m' }),
    Object.assign(new Error('compaction did not commit cleanly'), { targetKey: 'p/m' }),
  ]) {
    let calls = 0
    const { ctx, engine, agent } = await pressureFailureFixture(function () { calls++; return Promise.reject(error) })
    try {
      await assert.rejects(engine.compactIfNeeded(agent, 'pressure', new AbortController().signal), value => value === error)
      assert.equal(calls, 1)
    } finally { await ctx.fiber.dispose() }
  }
})

test('cancellation preserves the native error and never retries a retention guard', async () => {
  const abort = new AbortController()
  const reason = new Error('cancelled by caller')
  const guard = new TargetPressureConfigError('BasicCompactionConfig: p/m retainTokens (9000) must be less than threshold tokens 8000')
  let calls = 0
  const { ctx, engine, agent } = await pressureFailureFixture(function (_agent, _trigger, signal) {
    calls++
    assert.equal(signal, abort.signal)
    abort.abort(reason)
    return Promise.reject(guard)
  })
  try {
    await assert.rejects(engine.compactIfNeeded(agent, 'pressure', abort.signal), value => value === guard)
    assert.equal(abort.signal.reason, reason)
    assert.equal(calls, 1)
  } finally { await ctx.fiber.dispose() }
})
