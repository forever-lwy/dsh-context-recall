import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Group from '@deepseek-ai/cordis-plugin-group'
import { SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'

const require = createRequire(import.meta.url)
const project = fileURLToPath(new URL('../', import.meta.url))

// These are the actual pinned rc.5 distribution files, not copied composition
// fixtures: a test must see both the web host plane and its isolated presets.
function officialLayers() {
  return ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].flatMap(name => {
    const manifestPath = require.resolve(name + '/package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    assert.equal(manifest.version, '0.2.1-rc.5')
    const patches = manifest.dsh.bundle.patch
    return (Array.isArray(patches) ? patches : [patches]).map(path =>
      loadOverlayPatches('context-recall-test', resolve(dirname(manifestPath), path)))
  })
}

function entriesInGroups(entries) {
  return entries.flatMap(entry => [entry, ...(entry.group && Array.isArray(entry.config) ? entriesInGroups(entry.config) : [])])
}

test('actual bundle composes without warnings and leaves native query/controller lifecycle unchanged', () => {
  const layers = officialLayers()
  const before = composeEntries(layers)
  const warnings = []
  const after = composeEntries([...layers, loadOverlayPatches('context-recall-test', resolve(project, 'cordis.patch.yml'))],
    message => warnings.push(message))
  assert.deepEqual(warnings, [], 'The installed bundle must not contain a no-op name assertion or missing row patch.')
  const originalRows = entriesInGroups(before)
  const resultRows = entriesInGroups(after)
  for (const id of ['session-query-sqlite', 'session-controller', 'compaction-basic']) {
    assert.deepEqual(resultRows.find(row => row.id === id), originalRows.find(row => row.id === id),
      `Installing recall must not restart or replace the native ${id} provider.`)
  }
  const contribution = resultRows.filter(row => row.name === 'dsh-context-recall')
  assert.equal(contribution.length, 1)
  assert.notEqual(contribution[0].disabled, true)
  const boundary = after.find(row => row.id === 'context-recall-scope')
  assert.ok(boundary?.group)
  assert.equal(boundary.isolate?.sessionQuery, true)
  const privateQuery = boundary.config.find(row => row.name === '@deepseek-ai/dsh-session-query-sqlite')
  assert.ok(privateQuery)
  assert.equal(privateQuery.config.openAt, 'first-search')
  assert.ok(boundary.config.some(row => row.name === 'dsh-context-recall'))
})

test('web host compaction is disabled while every shipped preset owns its isolated native engine', () => {
  const layers = officialLayers()
  const before = composeEntries(layers)
  const after = composeEntries([...layers, loadOverlayPatches('context-recall-test', resolve(project, 'cordis.patch.yml'))])
  assert.equal(entriesInGroups(before).find(row => row.id === 'compaction-basic').disabled, true)
  const presets = before.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')
  assert.deepEqual(presets.map(row => row.config.id).sort(), ['cordis', 'minimal', 'ptc', 'standard'])
  for (const preset of presets) {
    const groups = preset.config.plugins.filter(row => row.group && row.isolate?.compaction)
    assert.equal(groups.length, 1, preset.config.id)
    const engine = groups[0].config.find(row => row.id === 'compaction-basic')
    assert.equal(engine.name, '@deepseek-ai/dsh-compaction-basic')
    assert.notEqual(engine.disabled, true)
    assert.deepEqual(after.find(row => row.id === preset.id), preset,
      'The bridge must preserve user-editable preset definitions instead of substituting a root engine.')
  }
})

test('rc.5 name in a non-insert patch asserts identity rather than replacing a module', () => {
  const warnings = []
  const rows = composeEntries([
    [{insert: [{id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true}]}],
    [{id: 'compaction-basic', name: 'dsh-context-recall/compaction'}],
  ], message => warnings.push(message))
  assert.equal(rows[0].name, '@deepseek-ai/dsh-compaction-basic')
  assert.equal(rows[0].disabled, true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /name mismatch/)
})

test('bundle private query remains isolated through actual Loader activation and removal', async () => {
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  let stage = 'loader'
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    stage = 'session store'
    await ctx.plugin(SessionStore)
    stage = 'host query'
    await ctx.plugin(SqliteSessionQueryEngine, {path: ':memory:', openAt: 'never'})
    const hostQuery = ctx.sessionQuery
    // Service reads return caller-bound proxies, so identity is the owning
    // implementation record rather than one contextual facade.
    const hostProvider = () => ctx.reflect.store[ctx.root[Context.isolate].sessionQuery]
    const originalProvider = hostProvider()
    let pluginQuery
    ctx.loader.builtins.queryWitness = {
      inject: ['sessionQuery'],
      apply: child => { pluginQuery = child.sessionQuery },
    }
    const session = ctx.sessions.create(SessionId('private-query-lifecycle'))
    session.append('turn/start', {turn: 1})
    session.append('user/message', createUserMessage({content: [{type: 'text', text: 'isolationmarker preserves exact history'}], source: {kind: 'user'}}), {surfaceOp: 'append'})

    const patches = loadOverlayPatches('context-recall-test', resolve(project, 'cordis.patch.yml'))
    const group = structuredClone(composeEntries([patches]).find(row => row.id === 'context-recall-scope'))
    assert.ok(group, 'The plugin must provide its own isolated full-text query owner.')
    group.config.find(row => row.name === '@deepseek-ai/dsh-session-query-sqlite').config.path = ':memory:'
    // A service witness replaces only the feature entry; the group, isolation
    // declaration and concrete query module come from the shipped bundle.
    group.config.find(row => row.name === 'dsh-context-recall').name = 'cordis:queryWitness'
    for (let cycle = 0; cycle < 2; cycle++) {
      stage = `group update ${cycle}`
      await ctx.loader.root.update([structuredClone(group)])
      stage = 'group ready'
      await ctx.loader.await()
      assert.ok(pluginQuery instanceof SqliteSessionQueryEngine)
      assert.equal(pluginQuery.config.openAt, 'first-search')
      assert.equal(ctx.sessionQuery.config.openAt, 'never')
      assert.ok(hostProvider() === originalProvider, 'The host query provider must retain its identity.')
      stage = `private search ${cycle}`
      const found = await pluginQuery.searchSessions({query: 'isolationmarker'})
      assert.equal(found.items.length, 1)
      await assert.rejects(hostQuery.searchSessions({query: 'isolationmarker'}), error => error.code === 'SESSION_QUERY_SEARCH_DISABLED')
      stage = 'group unload'
      await ctx.loader.root.update([])
      await ctx.loader.await()
      assert.ok(hostProvider() === originalProvider, 'Removing recall must retain the host query provider.')
      assert.equal((await hostQuery.readSession(session.id)).session.id, session.id)
    }
  } catch (error) { throw new Error(`Bundle lifecycle failed during ${stage}: ${String(error)}`, {cause: error}) }
  finally { await ctx.fiber.dispose() }
})

test('actual bundled feature publishes recall and global GUI service from inside the isolated query group', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-recall-bundle-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.group = Group
    new TypertRegistry(ctx)
    ctx.provide('sessionPersistence', {list: async () => []})
    ctx.provide('credentials', {
      describe: async () => ({configured: false, writable: true}),
      resolve: async () => undefined,
    })
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SystemPrompt, {includeHarnessIdentity: false, includeRuntimeContext: false})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SqliteSessionQueryEngine, {path: ':memory:', openAt: 'never'})
    const hostProvider = () => ctx.reflect.store[ctx.root[Context.isolate].sessionQuery]
    const originalProvider = hostProvider()
    const patches = loadOverlayPatches('context-recall-test', resolve(project, 'cordis.patch.yml'))
    const entries = composeEntries([patches])
    entries.find(row => row.id === 'context-recall-scope').config
      .find(row => row.name === '@deepseek-ai/dsh-session-query-sqlite').config.path = ':memory:'
    await ctx.loader.root.update(entries)
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) if (entry.fiber) await entry.fiber.await()
    assert.equal(ctx.tools.get('recall').name, 'recall')
    assert.ok(ctx.contextRecall)
    const state = await ctx.contextRecall.get({}, new AbortController().signal)
    assert.equal(state.config.embedding.enabled, false)
    assert.equal(state.revision, 0)
    assert.ok(hostProvider() === originalProvider)
    assert.deepEqual(ctx.typert.remotes.list().filter(row => row.namespace === 'contextRecall').map(row => row.method).sort(), ['get', 'save', 'test'])
    await ctx.loader.root.update([])
    await ctx.loader.await()
    assert.equal(ctx.get('contextRecall'), undefined)
    assert.equal(ctx.tools.get('recall'), undefined)
    assert.ok(hostProvider() === originalProvider)
    assert.equal(ctx.typert.remotes.list().filter(row => row.namespace === 'contextRecall').length, 0)
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(directory, {recursive: true, force: true})
  }
})
