import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context, symbols } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import { SessionStore } from '@deepseek-ai/dsh-session'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { FileUploads } from '@deepseek-ai/dsh-client-file-upload'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as Plugin from '../lib/index.js'

const implementation = service => service?.[symbols.original] ?? service
const patchFile = new URL('../cordis.patch.yml', import.meta.url).pathname

test('bundle owns an isolated search service and leaves all native query/controller rows unchanged', () => {
  const native = [
    { id: 'session-query-sqlite', name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: ':memory:', openAt: 'never' } },
    { id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller' },
    { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', disabled: true },
  ]
  const warnings = []
  const result = composeEntries([[{ insert: native }], loadOverlayPatches('activation-test', patchFile)], message => warnings.push(message))
  assert.deepEqual(warnings, [])
  for (const entry of native) assert.deepEqual(result.find(row => row.id === entry.id), entry)
  const scope = result.find(row => row.id === 'context-recall-scope')
  assert.equal(scope?.name, 'cordis:group')
  assert.equal(scope?.group, true)
  assert.equal(scope?.isolate.sessionQuery, true)
  assert.ok(scope.config.some(row => row.name === '@deepseek-ai/dsh-session-query-sqlite' && row.id !== 'session-query-sqlite'))
  assert.ok(scope.config.some(row => row.name === 'dsh-context-recall'))
})

class CatalogAdapter extends LlmAdapter {
  providerInfo(id) { return { id, name: 'Synthetic activation provider' } }
  async listModels(provider) { return [{ provider, id: 'small', name: 'Synthetic model' }] }
  async *stream() { throw new Error('Activation checks must not generate model output') }
}

function unwrapReply(reply) {
  let value = reply.result ?? reply
  for (let i = 0; i < 3 && value && typeof value === 'object' && 'ok' in value; i++) {
    assert.equal(value.ok, true, JSON.stringify(value.error))
    value = value.value
  }
  return value
}

test('enabling and disabling the real isolated bundle preserves native SessionController and its HTTP model catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'context-recall-activation-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const ctx = new Context()
  try {
    for (const service of [TypertRegistry, SessionStore, AgentRegistry, SessionProjectionRegistry, LlmRuntime]) await ctx.plugin(service)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await ctx.plugin(ToolRuntime)
    ctx.llm.registerAdapter(['synthetic-activation'], new CatalogAdapter())
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'synthetic-activation', model: 'small' }) })
    ctx.provide('attachments', { imageLimits: { maxImageBytes: 1048576 } })
    ctx.provide('fs', {})
    ctx.provide('fileReferences', {})
    ctx.provide('workingDirectory', {})
    ctx.provide('workspaceRegistry', { archivedSessionIds: [], list: () => [] })
    ctx.provide('sessionPersistence', { list: async () => [] })
    ctx.provide('credentials', { describe: async () => ({ configured: false, writable: true }), resolve: async () => undefined })
    ctx.provide('remoteAccess', { decide: () => { throw new Error('Owner must bypass access policy') } })
    // Exercise the exact native resolver ownership without requiring upload storage.
    ctx.provide('fileUploads', { registerAgentResolver(resolve) { return FileUploads.prototype.registerAgentResolver.call(this, resolve) } })
    new HostConnectionService(ctx, [], {})
    new TypertGatewayService(ctx, {})
    const peer = ctx.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
    const handler = ctx.connection.createSharedFetchHandler('/api')
    const readCatalog = async () => {
      const method = 'session/modelCatalog'
      const response = await handler.fetch(new Request(`http://localhost/api/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args: {} } }),
      }), peer)
      assert.equal(response.status, 200)
      return unwrapReply(await response.json())
    }

    const nativeQueryFiber = await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
    const controllerFiber = await ctx.plugin(SessionController, {})
    const nativeQuery = implementation(ctx.sessionQuery)
    const controller = implementation(ctx.sessionController)
    const resourceBefore = ctx.typert.resources.get('session')
    assert.equal((await readCatalog()).groups[0].models[0].id, 'small')

    const loader = new Loader(ctx, { baseUrl: new URL('../package.json', import.meta.url).href })
    loader.builtins.group = Group
    // Loader installs its context-isolation hooks through a child plugin.
    await new Promise(resolve => setImmediate(resolve))
    const originalImport = loader.import.bind(loader)
    // Keep production module identities, replacing only bare module resolution
    // with these already imported, exact rc.5 exports in the isolated test host.
    loader.import = (name, ...args) => name === 'dsh-context-recall' ? Plugin
      : name === '@deepseek-ai/dsh-session-query-sqlite' ? { default: SessionQuerySqlite } : originalImport(name, ...args)
    ctx.provide('dshHomePath', path => join(directory, path))
    const rows = composeEntries([loadOverlayPatches('activation-test', patchFile)])
    await loader.root.update(rows)
    await loader.await()
    const main = [...loader.entries()].find(entry => entry.options.name === 'dsh-context-recall')
    assert.equal(main?.fiber?.state, 2)
    assert.ok(implementation(main.fiber.ctx.sessionQuery) !== nativeQuery, 'recall query must have its own service instance')
    assert.ok(implementation(ctx.sessionQuery) === nativeQuery, 'native query identity must stay unchanged')
    assert.ok(implementation(ctx.sessionController) === controller, 'native controller identity must stay unchanged')
    assert.equal(controllerFiber.state, 2)
    assert.equal(nativeQueryFiber.state, 2)
    assert.ok(ctx.typert.resources.get('session') === resourceBefore, 'native resource registration must stay unchanged')
    assert.equal(ctx.tools.get('recall').name, 'recall')
    assert.equal((await readCatalog()).groups[0].models[0].id, 'small')

    await loader.root.update([])
    await loader.await()
    assert.equal(ctx.get('contextRecall'), undefined)
    assert.equal(ctx.tools.get('recall'), undefined)
    assert.ok(implementation(ctx.sessionQuery) === nativeQuery, 'native query identity must stay unchanged')
    assert.ok(implementation(ctx.sessionController) === controller, 'native controller identity must stay unchanged')
    assert.equal(controllerFiber.state, 2)
    assert.ok(ctx.typert.resources.get('session') === resourceBefore, 'native resource registration must stay unchanged')
    assert.equal((await readCatalog()).groups[0].models[0].id, 'small')
  } finally {
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
})
