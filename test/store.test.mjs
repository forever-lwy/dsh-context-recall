import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigStore, ConfigConflict } from '../lib/store.js'
import { configSchema, defaultConfig } from '../lib/config.js'

test('settings persist atomically with bounded schema, permissions and revision conflict protection', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-recall-config-'))
  try {
    const path = join(dir, 'settings.json'); const store = new ConfigStore(path)
    await store.load(); assert.equal(store.revision(), 0)
    const draft = defaultConfig(); draft.compression = {...draft.compression, provider: 'summary', model: 'compact', thresholdRatio: 0.575}
    await store.save(draft, 0)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    const other = new ConfigStore(path); await other.load(); assert.deepEqual(other.current(), draft)
    const copy = store.current(); copy.compression.model = 'do-not-mutate'
    assert.equal(store.current().compression.model, 'compact')
    await assert.rejects(other.save(defaultConfig(), 0), ConfigConflict)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).revision, 1)
  } finally { await rm(dir, {recursive: true, force: true}) }
})

test('existing settings inherit the native threshold without rewriting model settings or revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-recall-migrate-'))
  try {
    const path = join(dir, 'settings.json')
    const legacy = defaultConfig()
    legacy.compression = {provider: 'existing-provider', model: 'existing-model'}
    const contents = JSON.stringify({revision: 7, config: legacy})
    await writeFile(path, contents)
    const store = new ConfigStore(path)
    await store.load()
    assert.deepEqual(store.current().compression, {...legacy.compression, thresholdRatio: null})
    assert.equal(store.revision(), 7)
    assert.equal(await readFile(path, 'utf8'), contents)
    const next = store.current()
    next.compression.thresholdRatio = 0.575
    await store.save(next, 7)
    const reloaded = new ConfigStore(path)
    await reloaded.load()
    assert.equal(reloaded.current().compression.thresholdRatio, 0.575)
    assert.equal(reloaded.current().compression.model, 'existing-model')
  } finally { await rm(dir, {recursive: true, force: true}) }
})

test('corrupt persisted configuration fails visibly instead of replacing user settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-recall-corrupt-'))
  try {
    const path = join(dir, 'settings.json'); await writeFile(path, '{invalid')
    await assert.rejects(new ConfigStore(path).load(), /无法读取/)
    assert.equal(await readFile(path, 'utf8'), '{invalid')
  } finally { await rm(dir, {recursive: true, force: true}) }
})

test('configuration rejects malformed URLs, partial global routes and invalid resource bounds', () => {
  for (const baseURL of ['file:///tmp/model', 'https://name:password@host/v1', 'https://host/v1?key=secret', 'https://host/v1#fragment']) {
    const draft = defaultConfig(); draft.embedding.baseURL = baseURL
    assert.equal(configSchema.safeParse(draft).success, false)
  }
  const partial = defaultConfig(); partial.compression.provider = 'provider'
  assert.equal(configSchema.safeParse(partial).success, false)
  const bounds = defaultConfig(); bounds.embedding.batchSize = 0
  assert.equal(configSchema.safeParse(bounds).success, false)
  for (const thresholdRatio of [0, 0.16, 0.16999, 1, NaN, Infinity, '0.8']) {
    const draft = defaultConfig(); draft.compression.thresholdRatio = thresholdRatio
    assert.equal(configSchema.safeParse(draft).success, false)
  }
  for (const thresholdRatio of [null, 0.17, 0.575, 0.99]) {
    const draft = defaultConfig(); draft.compression.thresholdRatio = thresholdRatio
    assert.equal(configSchema.safeParse(draft).success, true)
  }
})
