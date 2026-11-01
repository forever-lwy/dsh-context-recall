import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultConfig } from '../lib/config.js'
import { OnlineEmbedder, normalizeVector, vectorFingerprint } from '../lib/embedding.js'

const config = changes => ({...defaultConfig().embedding, enabled: true, ...changes})
const payload = vectors => new Response(JSON.stringify({data: vectors.map((embedding, index) => ({embedding, index})).reverse()}), {headers: {'Content-Type': 'application/json'}})

test('online adapter sends exact endpoint, auth, prefixes and dimensional request; orders and normalizes responses', async () => {
  const calls = []
  const embedder = new OnlineEmbedder(config({baseURL: 'https://vectors.example/v1/', model: 'remote', dimensions: 2, queryPrefix: 'query:', documentPrefix: 'doc:', batchSize: 2}),
    async () => 'test-secret', async (url, options) => {
      calls.push({url, ...options, body: JSON.parse(options.body)})
      return payload(JSON.parse(options.body).input.map((_, i) => i ? [0, 3] : [4, 0]))
    })
  const vectors = await embedder.embedBatch(['first', 'second', 'third'])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://vectors.example/v1/embeddings')
  assert.equal(calls[0].headers.Authorization, 'Bearer test-secret')
  assert.equal(calls[0].redirect, 'error')
  assert.deepEqual(calls[0].body, {model: 'remote', input: ['doc:first', 'doc:second'], dimensions: 2, encoding_format: 'float'})
  assert.deepEqual(vectors.map(v => Array.from(v)), [[1, 0], [0, 1], [1, 0]])
  await embedder.embed('lookup')
  assert.deepEqual(calls[2].body.input, ['query:lookup'])
  await embedder.dispose()
})

test('default dimension is inferred once; requests are serialized and re-resolve rotated credentials', async () => {
  let key = 'first'; const seen = []; let running = 0; let max = 0
  const embedder = new OnlineEmbedder(config(), async () => key, async (_url, options) => {
    running++; max = Math.max(max, running); seen.push(options.headers.Authorization)
    await new Promise(resolve => setTimeout(resolve, 5)); running--
    assert.equal(JSON.parse(options.body).dimensions, undefined)
    return payload([[1, 1, 1]])
  })
  await embedder.embed('one'); key = 'second'
  await Promise.all([embedder.embed('two'), embedder.embed('three')])
  assert.equal(max, 1)
  assert.deepEqual(seen, ['Bearer first', 'Bearer second', 'Bearer second'])
  await embedder.dispose()
})

test('space fingerprint tracks model, endpoint, dimensions and both text transforms', () => {
  const original = config()
  for (const patch of [{model: 'other'}, {baseURL: 'https://another/v1'}, {dimensions: 3}, {queryPrefix: 'q'}, {documentPrefix: 'd'}, {maxInputChars: 1000}]) {
    assert.notEqual(vectorFingerprint({...original, ...patch}), vectorFingerprint(original))
  }
  assert.equal(vectorFingerprint({...original, timeoutMs: 1000}), vectorFingerprint(original))
})

test('invalid response arrays and dimensions never enter persistent vectors', async () => {
  for (const invalid of [[], [0, 0], [NaN, 1], [Infinity, 1], ['1', 2]]) assert.throws(() => normalizeVector(invalid))
  assert.throws(() => normalizeVector([1, 2], 3))
  for (const value of [{data: []}, {data: [{index: 1, embedding: [1]}]}, {data: [{index: 0, embedding: [0]}]}]) {
    const embedder = new OnlineEmbedder(config(), async () => undefined, async () => new Response(JSON.stringify(value)))
    await assert.rejects(embedder.embed('x'), /响应|向量/)
    await embedder.dispose()
  }
})

test('provider body, URL and credentials are absent from errors', async () => {
  const secret = 'test-do-not-disclose'
  const embedder = new OnlineEmbedder(config(), async () => secret,
    async () => new Response(`provider echoed ${secret}`, {status: 401}))
  await assert.rejects(embedder.embed('x'), error => error.message.includes('401') && !error.message.includes(secret))
  await embedder.dispose()
  const network = new OnlineEmbedder(config(), async () => secret, async () => { throw new Error(secret) })
  await assert.rejects(network.embed('x'), error => !error.message.includes(secret))
  await network.dispose()
})

test('disposal aborts active request and prevents queued network calls', async () => {
  let start; const started = new Promise(resolve => {start = resolve}); let calls = 0
  const embedder = new OnlineEmbedder(config(), async () => undefined, async (_url, options) => {
    calls++; start()
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}))
  })
  const one = embedder.embed('x').catch(error => error)
  await started
  const two = embedder.embed('y').catch(error => error)
  await embedder.dispose()
  assert.ok(await one instanceof Error); assert.ok(await two instanceof Error); assert.equal(calls, 1)
})

test('input length limit bounds uploads but does not alter retained source documents', async () => {
  const text = '汉'.repeat(500); let inputs
  const embedder = new OnlineEmbedder(config({maxInputChars: 128}), async () => undefined, async (_url, options) => {
    inputs = JSON.parse(options.body).input; return payload([[1]])
  })
  await embedder.embedBatch([text])
  assert.equal(inputs[0].length, 128); assert.equal(text.length, 500)
  await embedder.dispose()
})

test('per-call cancellation aborts online requests without disabling later recall', async () => {
  let start; const started = new Promise(resolve => { start = resolve }); let calls = 0
  const embedder = new OnlineEmbedder(config(), async () => undefined, async (_url, options) => {
    calls++
    if (calls > 1) return payload([[1, 0]])
    start()
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), {once: true}))
  })
  const controller = new AbortController()
  const cancelled = embedder.embed('cancel', controller.signal).catch(error => error)
  await started; controller.abort()
  assert.ok(await cancelled instanceof Error)
  assert.deepEqual(Array.from(await embedder.embed('next')), [1, 0])
  await embedder.dispose()
})
