import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { FuzzyIndex } from '../lib/fuzzy-index.js'
import { createSearchApi, snippetAround } from '../lib/search-service.js'
import { remoteInfo } from '../lib/remote.js'
import { ContextRecallService } from '../lib/settings.js'

const user = (seq, text) => ({ seq, type: 'user/message', time: 1000 + seq, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const reply = (seq, text) => ({ seq, type: 'assistant/message', time: 1000 + seq, data: { message: { content: [{ type: 'text', text }] } } })
const title = (seq, text) => ({ seq, type: 'session/title', time: 1000 + seq, data: { title: text } })

function fixture() {
  const index = new FuzzyIndex(':memory:').open()
  index.appendEvents({ id: 'a', cwd: '/work/a', createdAt: 1 }, [title(0, '部署脚本整理'), user(1, '怎么写 nginx 配置'), reply(2, '先备份再修改 nginx')])
  index.appendEvents({ id: 'b', cwd: '/work/b', createdAt: 2 }, [user(0, '数据库备份策略'), reply(1, '每天全量，每小时增量备份')])
  index.appendEvents({ id: 'c', cwd: '/work/a', createdAt: 3, origin: 'subagent' }, [user(0, '子代理检查部署脚本')])
  return index
}

test('search API merges title and full-text matches, filters scope and archive', async () => {
  const index = fixture()
  let flushed = 0
  const api = createSearchApi({ index: () => index, getEmbedder: () => null, getConfig: () => ({ semantic: false }),
    sync: { flush: async () => { flushed += 1 } }, archivedIds: () => ['b'] })
  try {
    const both = await api.search({ query: '部署脚本' })
    assert.equal(flushed, 1)
    assert.deepEqual(both.groups.map(g => g.sessionId).sort(), ['a', 'c'])
    const a = both.groups.find(g => g.sessionId === 'a')
    assert.equal(a.titleMatch, true)
    assert.equal(a.title, '部署脚本整理')
    assert.equal(both.groups.find(g => g.sessionId === 'c').subagent, true)

    const text = await api.search({ query: 'nginx', mode: 'keyword' })
    assert.deepEqual(text.groups.map(g => g.sessionId), ['a'])
    assert.deepEqual(text.groups[0].hits.map(h => h.seq), [1, 2])

    assert.deepEqual((await api.search({ query: '部署', mode: 'title' })).groups.map(g => g.sessionId), ['a'])
    assert.deepEqual((await api.search({ query: '部署脚本', cwd: '/work/b' })).groups, [])
    const archived = await api.search({ query: '备份' })
    assert.equal(archived.groups.find(g => g.sessionId === 'b').archived, true)
    assert.ok(!(await api.search({ query: '备份', includeArchived: false })).groups.some(g => g.sessionId === 'b'))

    const semantic = await api.search({ query: '备份', mode: 'semantic' })
    assert.equal(semantic.groups.length, 0)
    assert.match(semantic.notice, /未启用在线向量/)
  } finally { index.close() }
})

test('search API reads windows and pages, and reports status', async () => {
  const index = fixture()
  const api = createSearchApi({ index: () => index, getEmbedder: () => null, getConfig: () => ({ semantic: false }) })
  try {
    const win = await api.read({ sessionId: 'a', seq: 2, before: 1, after: 0 })
    assert.deepEqual(win.items.map(i => i.seq), [1, 2])
    assert.equal(win.title, '部署脚本整理')
    assert.equal(win.hasBefore, false)
    const page = await api.read({ sessionId: 'a', fromSeq: 0, pageSize: 1 })
    assert.equal(page.items.length, 1)
    assert.equal(page.hasAfter, true)
    assert.equal((await api.read({ sessionId: 'missing' })).ok, false)
    const status = await api.status()
    assert.equal(status.sessions, 3)
    assert.deepEqual(status.workspaces.map(w => w.cwd), ['/work/a', '/work/b'])
  } finally { index.close() }
  assert.equal(snippetAround('前'.repeat(300) + '目标词' + '后'.repeat(300), '目标词').includes('目标词'), true)
})

test('remote schema exposes the search methods and the service delegates to the attached API', async () => {
  for (const key of ['contextRecall/search', 'contextRecall/read', 'contextRecall/status', 'contextRecall/locate']) assert.ok(remoteInfo.methods[key], key)
  const calls = []
  const fake = { search: async r => { calls.push(['search', r]); return { ok: true, query: r.query, mode: 'auto', semantic: { enabled: false, ready: false, coverage: 1 }, groups: [] } },
    read: async r => { calls.push(['read', r]); return { ok: true, items: [] } }, status: async () => ({ ok: true }) }
  const service = Object.create(ContextRecallService.prototype)
  service.searchApi = null
  const signal = new AbortController().signal
  await assert.rejects(service.search({ query: 'x' }, signal), /尚未就绪/)
  const detach = service.attachSearch(fake)
  await service.search({ query: 'x', mode: 'title' }, signal)
  await service.read({ sessionId: 'a', seq: 1 }, signal)
  await assert.rejects(service.search({ query: 'x', bogus: 1 }, signal), /参数无效/)
  detach()
  assert.deepEqual(calls.map(c => c[0]), ['search', 'read'])
})

// ── page interaction (jsdom) ─────────────────────────────────────────────
let dom, React, createRoot, Simulate, SearchPage, highlightTerms
const originals = new Map()
before(async () => {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://dsh.test/' })
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  }
  React = await import('react'); ({ createRoot } = await import('react-dom/client'))
  ;({ Simulate } = await import('react-dom/test-utils'))
  ;({ SearchPage, highlightTerms } = await import('../lib/client/SearchPage.js'))
})
after(() => {
  dom.window.close()
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else delete globalThis[key]
  }
})

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('search page debounces one request per input, previews hits and opens sessions', async t => {
  const index = fixture()
  const api = createSearchApi({ index: () => index, getEmbedder: () => null, getConfig: () => ({ semantic: false }) })
  const searches = [], reads = [], opened = []
  const props = {
    search: (request, signal) => { searches.push(request); return api.search(request, signal) },
    read: (request) => { reads.push(request); return api.read(request) },
    status: () => api.status(),
    open: (sessionId, seq) => opened.push([sessionId, seq]),
    t: (key, params) => params ? `${key}:${JSON.stringify(params)}` : key,
  }
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  const act = fn => React.act(async () => { await fn?.() })
  t.after(async () => { await act(() => root.unmount()); container.remove(); index.close() })
  await act(() => root.render(React.createElement(SearchPage, props)))
  const input = container.querySelector('[data-search="query"]')
  await act(() => Simulate.change(input, { target: { value: 'nginx' } }))
  await act(() => wait(400))
  await act(() => wait(50))
  assert.equal(searches.length, 1, 'exactly one debounced request; re-renders do not repeat it')
  assert.equal(searches[0].query, 'nginx')
  assert.ok(container.querySelector('[data-session="a"]'))
  assert.ok(container.querySelector('mark'), 'query terms are highlighted')

  await act(() => container.querySelector('[data-mode="keyword"]').click())
  await act(() => wait(400))
  assert.equal(searches.at(-1).mode, 'keyword')
  const count = searches.length
  await act(() => wait(400))
  assert.equal(searches.length, count, 'idle page sends nothing more')

  await act(() => container.querySelector('[data-hit="a:2"]').click())
  await act(() => wait(20))
  assert.deepEqual(reads.at(-1), { sessionId: 'a', seq: 2, before: 6, after: 6 })
  assert.ok(container.querySelector('[data-seq="2"].target'))
  await act(() => container.querySelector('[data-action="open-session"]').click())
  assert.deepEqual(opened, [['a', 2]])
  await act(() => container.querySelector('[data-action="close-preview"]').click())
  assert.equal(container.querySelector('.dcr-preview'), null)
  assert.deepEqual(highlightTerms('部署 脚本 a'), ['部署 脚本 a', '部署', '脚本'])
})

test('locate maps a seq to its host turn and a plain-text phrase', async () => {
  const { locateSnippet } = await import('../lib/search-service.js')
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } }, user(1, '第一问'), reply(2, '第一答'),
    { seq: 3, type: 'turn/start', data: { turn: 2 } }, user(4, '第二问：环境信息'),
    { seq: 5, type: 'assistant/message', time: 1, data: { turn: 2, message: { content: [{ type: 'text', text: '## 1. **系统**与容器\n- 内核' }] } } },
  ]
  const api = createSearchApi({ index: () => null, getEmbedder: () => null, getConfig: () => ({}), readSession: async () => ({ events }) })
  assert.deepEqual(await api.locate({ sessionId: 's', seq: 4 }), { ok: true, turn: 2, text: '第二问：环境信息' })
  assert.deepEqual(await api.locate({ sessionId: 's', seq: 5 }), { ok: true, turn: 2, text: '1. 系统 与容器' })
  assert.equal((await api.locate({ sessionId: 's', seq: 2 })).turn, 1)
  assert.equal(locateSnippet('`code` only\nplain words here'), 'code only')
})

test('conversation locator clicks the host turn mark and highlights the message', async () => {
  const { locateInConversation } = await import('../lib/client/navigate.js')
  globalThis.NodeFilter = dom.window.NodeFilter
  const old = document.createElement('div'); old.setAttribute('data-chat-flow', ''); document.body.appendChild(old)
  const previous = old
  setTimeout(() => {
    old.remove()
    const flow = document.createElement('div'); flow.setAttribute('data-chat-flow', '')
    const nav = document.createElement('nav')
    const scroller = document.createElement('div'); nav.appendChild(scroller)
    for (let i = 0; i < 3; i++) {
      const mark = document.createElement('button'); mark.dataset.index = String(i); mark.setAttribute('aria-label', `Jump to turn ${i + 1}`)
      mark.addEventListener('click', () => { const p = document.createElement('p'); p.textContent = `turn ${i + 1}: 第二问：环境信息`; flow.appendChild(p) })
      scroller.appendChild(mark)
    }
    document.body.append(nav, flow)
  }, 50)
  dom.window.HTMLElement.prototype.scrollIntoView = function () { this.dataset.scrolled = '1' }
  const ok = await locateInConversation({ turn: 2, text: '第二问：环境信息' }, previous)
  assert.equal(ok, true)
  const hit = document.querySelector('.dcr-located')
  assert.ok(hit)
  assert.match(hit.textContent, /^turn 2/)
  assert.equal(hit.dataset.scrolled, '1')
  document.body.innerHTML = ''
})
