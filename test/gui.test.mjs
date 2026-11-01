import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import { defaultConfig } from '../lib/config.js'

let dom, React, createRoot, Simulate, Settings
const originals = new Map()
const snapshot = () => ({ config: defaultConfig(), revision: 3, credential: { configured: true, writable: true },
  models: [{provider: 'deepseek', model: 'deepseek-chat', name: 'DeepSeek Chat'}],
  status: { semanticAvailable: false, message: 'Embedding not enabled' } })
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b }); return {promise, resolve, reject} }

before(async () => {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {url: 'https://dsh.test/'})
  for (const [key,value] of Object.entries({window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true})) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis,key))
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value})
  }
  React = await import('react'); ({createRoot} = await import('react-dom/client'))
  ;({Simulate} = await import('react-dom/test-utils'))
  ;({ContextRecallSettings: Settings} = await import('../lib/client/Settings.js'))
})
after(() => {
  dom.window.close()
  for (const [key,descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis,key,descriptor)
    else delete globalThis[key]
  }
})
async function mount(t, options = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container), reads = [], saves = [], tests = []
  const props = {
    read: signal => { reads.push(signal); return options.read?.(signal) ?? Promise.resolve(snapshot()) },
    save: (request,signal) => { saves.push({request,signal}); return options.save?.(request,signal) ?? Promise.resolve({...snapshot(), config: request.config, revision: 4}) },
    test: (request,signal) => { tests.push({request,signal}); return options.test?.(request,signal) ?? Promise.resolve({dimensions: 1536,message:'Connected'}) },
  }
  const flush = action => React.act(async () => { action?.() })
  await flush(() => root.render(React.createElement(Settings, props)))
  let unmounted = false
  const unmount = async () => { if (!unmounted) { unmounted = true; await flush(() => root.unmount()); container.remove() } }
  t.after(unmount)
  return {container, props, root, saves, reads, tests, flush, unmount,
    field: key => container.querySelector(`[data-setting="${key}"]`),
    async change(key,value) { const field = container.querySelector(`[data-setting="${key}"]`); assert.ok(field, key); await flush(() => Simulate.change(field,{target:{value,checked:value}})) },
    async click(action) { const button = container.querySelector(`[data-action="${action}"]`); assert.ok(button); await flush(() => button.click()) },
    async submit() { await flush(() => Simulate.submit(container.querySelector('form'))) },
  }
}

test('every configuration field has a GUI control and configured model selection updates both routing fields', async t => {
  const ui = await mount(t)
  for (const [section,fields] of Object.entries(defaultConfig())) for (const key of Object.keys(fields)) assert.ok(ui.field(`${section}.${key}`),`${section}.${key}`)
  assert.match(ui.container.textContent,/压缩前原文/)
  assert.equal(ui.field('apiKey').type,'password')
  await ui.change('compression.catalog',JSON.stringify(['deepseek','deepseek-chat']))
  assert.equal(ui.field('compression.provider').value,'deepseek')
  assert.equal(ui.field('compression.model').value,'deepseek-chat')
  await ui.submit()
  assert.equal(ui.saves[0].request.expectedRevision,3)
  assert.deepEqual(ui.saves[0].request.config.compression,{provider:'deepseek',model:'deepseek-chat',thresholdRatio:null})
})

test('automatic compaction threshold uses a precise percentage and survives model selection', async t => {
  const ui = await mount(t)
  assert.equal(ui.field('compression.thresholdMode').value,'inherit')
  assert.equal(ui.field('compression.thresholdRatio').disabled,true)
  assert.equal(ui.field('compression.thresholdRatio').value,'')
  await ui.change('compression.thresholdMode','custom')
  assert.equal(ui.field('compression.thresholdRatio').disabled,false)
  await ui.change('compression.thresholdRatio','57.5')
  await ui.change('compression.catalog',JSON.stringify(['deepseek','deepseek-chat']))
  assert.equal(ui.field('compression.thresholdRatio').value,'57.5')
  await ui.submit()
  assert.equal(ui.saves[0].request.config.compression.thresholdRatio,0.575)
  assert.equal(ui.field('compression.thresholdRatio').value,'57.5')
  assert.match(ui.container.textContent,/下一次自动检查/)
  assert.match(ui.container.textContent,/不会立即压缩/)
})

test('saved decimal threshold is not rounded and native inheritance sends an explicit null', async t => {
  const saved = snapshot(); saved.config.compression.thresholdRatio=0.333
  const ui = await mount(t,{read:async()=>saved})
  assert.equal(ui.field('compression.thresholdRatio').value,'33.3')
  await ui.change('compression.thresholdMode','inherit')
  assert.equal(ui.field('compression.thresholdRatio').disabled,true)
  await ui.change('compression.catalog',JSON.stringify(['deepseek','deepseek-chat']))
  await ui.submit()
  assert.equal(ui.saves[0].request.config.compression.thresholdRatio,null)
  await ui.change('compression.thresholdMode','custom')
  await ui.change('compression.thresholdRatio','99')
  await ui.submit()
  assert.equal(ui.saves[1].request.config.compression.thresholdRatio,0.99)
  await ui.change('compression.thresholdRatio','17')
  await ui.submit()
  assert.equal(ui.saves[2].request.config.compression.thresholdRatio,0.17)
})

test('invalid percentages never reach save and switching to native policy clears the invalid override', async t => {
  const ui = await mount(t)
  await ui.change('compression.thresholdMode','custom')
  for (const invalid of ['','0','1','16','16.999','100','NaN','Infinity','-1','1e2','98.9999999999999999']) {
    await ui.change('compression.thresholdRatio',invalid)
    await ui.submit()
    assert.equal(ui.saves.length,0,invalid)
    assert.match(ui.container.querySelector('[role=alert]').textContent,/17–99/)
  }
  await ui.change('compression.thresholdMode','inherit')
  await ui.submit()
  assert.equal(ui.saves[0].request.config.compression.thresholdRatio,null)
})

test('no autosave, drafts survive unrelated rerender, explicit save carries new key then clears password', async t => {
  const ui = await mount(t)
  await ui.change('embedding.model','custom-embedding')
  await ui.change('apiKey','private-test-value')
  assert.equal(ui.saves.length,0)
  await ui.flush(() => ui.root.render(React.createElement(Settings,{...ui.props,t:key=>key})))
  assert.equal(ui.reads.length,1)
  assert.equal(ui.field('embedding.model').value,'custom-embedding')
  await ui.submit()
  assert.equal(ui.saves[0].request.apiKey,'private-test-value')
  assert.equal(ui.field('apiKey').value,'')
  assert.equal(window.localStorage.length,0)
  assert.ok(!ui.container.textContent.includes('private-test-value'))
})

test('tests use unsaved connection and secret, do not persist settings or discard draft', async t => {
  const ui = await mount(t)
  await ui.change('embedding.baseURL','https://vectors.test/v1')
  await ui.change('apiKey','test-only-value')
  await ui.click('test')
  assert.equal(ui.tests[0].request.config.embedding.baseURL,'https://vectors.test/v1')
  assert.equal(ui.tests[0].request.apiKey,'test-only-value')
  assert.equal(ui.saves.length,0)
  assert.equal(ui.field('apiKey').value,'test-only-value')
  assert.match(ui.container.textContent,/Connected \(1536\)/)
})

test('revision conflict keeps all edits and secret for retry; clearing is explicit', async t => {
  const ui = await mount(t,{save:async () => {throw new Error('配置已在其他窗口变化，请重新读取。')}})
  await ui.change('embedding.model','my-new-model')
  await ui.change('apiKey','not-lost-on-conflict')
  await ui.submit()
  assert.match(ui.container.querySelector('[role=alert]').textContent,/其他窗口/)
  assert.equal(ui.field('embedding.model').value,'my-new-model')
  assert.equal(ui.field('apiKey').value,'not-lost-on-conflict')
  await ui.change('clearApiKey',true)
  assert.equal(ui.field('apiKey').value,'')
  await ui.submit()
  assert.equal(ui.saves[1].request.clearApiKey,true)
  assert.equal(ui.saves[1].request.apiKey,undefined)
})

test('double submit is blocked while save is in flight and unmount aborts the request', async t => {
  const pending = deferred()
  const ui = await mount(t,{save:() => pending.promise})
  await ui.change('recall.anchorRounds',4)
  await ui.submit(); await ui.submit()
  assert.equal(ui.saves.length,1)
  assert.equal(ui.saves[0].signal.aborted,false)
  await ui.unmount()
  assert.equal(ui.saves[0].signal.aborted,true)
  await ui.flush(() => pending.resolve({...snapshot(),revision:4}))
})

test('invalid routing pair and numeric values are rejected before remote save', async t => {
  const ui = await mount(t)
  await ui.change('compression.provider','deepseek')
  await ui.submit()
  assert.equal(ui.saves.length,0)
  assert.match(ui.container.querySelector('[role=alert]').textContent,/同时/)
  await ui.change('compression.provider','')
  await ui.change('recall.coverageThreshold',1.5)
  await ui.submit()
  assert.equal(ui.saves.length,0)
  assert.match(ui.container.querySelector('[role=alert]').textContent,/coverageThreshold/)
})

test('built browser artifact registers a complete settings page and minimal localized recall tool view', async t => {
  const source = await readFile(new URL('../lib/client.js',import.meta.url),'utf8')
  assert.ok(!source.includes('node:sqlite'))
  assert.ok(!source.includes('node:fs'))
  let artifact
  window.__ModuleLoader__ = {load:value => {artifact=value}}
  runInThisContext(source)
  assert.equal(artifact.id,'dsh-context-recall')
  const plugin = artifact.factory(createRequire(import.meta.url))
  assert.deepEqual(plugin.inject,['slots','locale','remote'])
  const entries=[], dictionaries=[], cleanups=[]
  let schemaMounted=false
  const ctx={
    remote:{$mount:async () => {schemaMounted=true; return () => {schemaMounted=false}}},
    effect:body=>{const cleanup=body(); if (typeof cleanup==='function') cleanups.push(cleanup)},
    locale:{register:(...args)=>{dictionaries.push(args);return ()=>{}},bind:()=>key=>({nav:'上下文压缩与回忆',done:'回忆完成',recalling:'回忆中…',recallFailed:'回忆失败'}[key]??key)},
    slots:{inject:(_name,body)=>body(),register:(options,Component)=>{entries.push({options,Component});return ()=>{}}},
    inject:(names,body)=>{assert.deepEqual(names,['remote.contextRecall']);assert.equal(schemaMounted,true);body(ctx)},
  }
  await plugin.apply(ctx)
  const page=entries.find(entry=>entry.options.name==='settings.section')
  assert.equal(page.options.id,'context-recall')
  assert.equal(page.options.label(),'上下文压缩与回忆')
  assert.equal(typeof page.options.inject().save,'function')
  assert.equal(dictionaries.length,2)
  const tool=entries.find(entry=>entry.options.name==='tool.call.toolview')
  assert.equal(tool.options.key,'recall')
  const container=document.createElement('div');document.body.appendChild(container)
  const root=createRoot(container)
  await React.act(async()=>root.render(React.createElement(tool.Component,{...tool.options.inject(),block:{kind:'tool-result',result:{groups:[{text:'hidden original text'}]}}})))
  assert.equal(container.textContent,'回忆完成')
  assert.ok(!container.textContent.includes('hidden original text'))
  await React.act(async()=>root.unmount());container.remove()
  for(const cleanup of cleanups.reverse()) await cleanup()
  assert.equal(schemaMounted,false)
  assert.equal(document.querySelector('style[data-plugin="dsh-context-recall"]'),null)
  delete window.__ModuleLoader__
})
