import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { apply as installRemote } from '@deepseek-ai/dsh-api-gateway/client'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import { LlmRuntime, LlmAdapter } from '@deepseek-ai/dsh-llm'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { z } from 'zod'
import { ConfigStore } from '../lib/store.js'
import { ContextRecallService } from '../lib/settings.js'
import { remoteInfo } from '../lib/remote.js'

class CatalogAdapter extends LlmAdapter {
  providerInfo(id) { return { id, name: 'Synthetic provider' } }
  async listModels(provider) { return [{ provider, id: 'summary-small', name: 'Synthetic summary model' }] }
  async *stream() { throw new Error('Settings tests must not generate model output') }
}

test('compiled GUI reads and saves through actual rc.5 HTTP Remote transport with credentials and conflicts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'context-recall-remote-'))
  const host = new Context()
  const client = new Context()
  t.after(async () => {
    await client.fiber.dispose()
    await host.fiber.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  new TypertRegistry(host)
  new TypertRegistry(client)
  new HostConnectionService(host, [], {})
  host.provide('remoteAccess', { decide: () => { throw new Error('Owner should bypass access policy') } })
  new TypertGatewayService(host, {})
  const peer = host.connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
  new LlmRuntime(host)
  host.llm.registerAdapter(['synthetic-provider'], new CatalogAdapter())
  const credentials = new Map()
  host.provide('credentials', {
    describe: async ref => ({ configured: credentials.has(ref), writable: true }),
    resolve: async ref => credentials.has(ref) ? { value: credentials.get(ref) } : undefined,
    set: async (ref, value) => { credentials.set(ref, value) },
    unset: async ref => { credentials.delete(ref) },
  })
  const store = new ConfigStore(join(directory, 'settings.json'))
  await store.load()
  new ContextRecallService(host, store)
  host.typert.remotes.register(remoteInfo)
  const requests = []
  const handler = host.connection.createSharedFetchHandler('/api')
  installConnection(client, { interactions: 'none', transport: {
    async fetch(url, init) {
      const request = new Request(new URL(url, 'http://localhost/'), init)
      // Preserve route/envelope evidence without duplicating the secret body.
      requests.push({ path: new URL(request.url).pathname, type: (await request.clone().json()).type })
      return handler.fetch(request, peer)
    },
    openStream() { throw new Error('Configuration uses unary requests') },
  } })
  installRemote(client)
  const definitions = []
  const styles = []
  runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: definition => definitions.push(definition) } },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild: element => styles.push(element) } },
  })
  const dependencies = { react: React, 'react/jsx-runtime': jsxRuntime, 'react-dom': ReactDOM, zod: { z } }
  const plugin = definitions[0].factory(specifier => {
    assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected browser import: ${specifier}`)
    return dependencies[specifier]
  })
  const registrations = []
  client.provide('slots', {
    inject: (_name, callback) => callback(),
    register: (options, component) => { registrations.push({ options, component }); return () => {} },
  })
  client.provide('locale', { register: () => () => {}, bind: () => key => key })
  await client.plugin(plugin)
  const section = registrations.find(entry => entry.options.name === 'settings.section')
  assert.ok(section)
  const face = section.options.inject()
  const signal = new AbortController().signal
  const initial = await face.read(signal)
  assert.deepEqual(initial.models.map(model => [model.provider, model.model]), [['synthetic-provider', 'summary-small']])
  assert.equal(initial.credential.configured, false)
  assert.equal(styles.length, 1)
  assert.equal(registrations.find(entry => entry.options.key === 'recall').options.name, 'tool.call.toolview')

  const config = initial.config
  config.compression = { provider: 'synthetic-provider', model: 'summary-small' }
  const secret = 'synthetic-test-key-do-not-return'
  const saved = await face.save({ config, expectedRevision: initial.revision, apiKey: secret }, signal)
  assert.equal(saved.revision, initial.revision + 1)
  assert.equal(saved.credential.configured, true)
  assert.equal(JSON.stringify(saved).includes(secret), false)
  assert.equal((await readFile(store.path, 'utf8')).includes(secret), false)
  assert.equal(credentials.size, 1)
  assert.ok([...credentials.values()].includes(secret))

  await assert.rejects(face.save({ config, expectedRevision: initial.revision }, signal), /其他窗口修改/)
  assert.equal((await face.read(signal)).revision, saved.revision)
  const invalid = structuredClone(config)
  invalid.compression.model = ''
  await assert.rejects(face.save({ config: invalid, expectedRevision: saved.revision }, signal))
  assert.equal((await face.read(signal)).revision, saved.revision)
  const cleared = await face.save({ config, expectedRevision: saved.revision, clearApiKey: true }, signal)
  assert.equal(cleared.credential.configured, false)
  assert.equal(credentials.size, 0)
  assert.ok(requests.every(request => request.type === 'client-request'))
  assert.ok(requests.some(request => request.path === '/api/contextRecall/get'))
  assert.ok(requests.some(request => request.path === '/api/contextRecall/save'))
})
