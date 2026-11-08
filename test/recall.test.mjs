import test from 'node:test'
import assert from 'node:assert/strict'
import { FuzzyIndex } from '../lib/fuzzy-index.js'
import { applyRecall, runRecall, buildEvents, buildAnchorText, corpusServices, schemaValue } from '../lib/recall.js'
import { IndexSync } from '../lib/index-sync.js'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionStore, SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const message = (seq, text, type = 'user/message') => ({ seq, type, time: 1000 + seq,
  data: type === 'assistant/message' ? { message: { content: [{ type: 'text', text }] } } : { content: [{ type: 'text', text }] } })
const sessions = [
  { header: { id: 'one', cwd: '/work/a', createdAt: 100 }, events: [message(0, '数据库压缩模型使用远程推理服务'), message(1, '保留 PostgreSQL，使用在线向量模型', 'assistant/message'), message(2, '保留原始日志，压缩后仍然能回忆')] },
  { header: { id: 'two', cwd: '/work/a', createdAt: 200 }, events: [message(0, '另一个窗口讨论数据库备份')] },
  { header: { id: 'three', cwd: '/work/b', createdAt: 300 }, events: [message(0, '另一个工作区讨论数据库备份')] },
]
const liveServices = {}
const openIndexed = (list = sessions) => {
  const fuzzy = new FuzzyIndex(':memory:').open()
  for (const s of list) fuzzy.appendEvents(s.header, s.events)
  return fuzzy
}
const exec = { agent: { session: { id: 'one', header: sessions[0].header } } }
const query = {
  readTitle: async id => ({ title: `title:${id}` }),
  searchSessions: async () => ({ items: [] }),
  searchEvents: async () => ({ items: [] }),
  filterEvents: async (id, filters) => sessions.find(s => s.header.id === id).events
    .filter(e => e.seq >= filters[0].range.gte && e.seq <= filters[0].range.lte)
    .map(e => ({ ...e, text: e.type === 'assistant/message' ? e.data.message.content[0].text : e.data.content[0].text })),
  readEvent: async ({ sessionId, seq, before, after }) => ({ session: sessions.find(s => s.header.id === sessionId).header,
    events: sessions.find(s => s.header.id === sessionId).events.filter(e => e.seq >= seq - before && e.seq <= seq + after) }),
}

test('current-session default, workspace and explicit all scopes; no accidental broadening', async () => {
  const fuzzy = openIndexed()
  try {
    const services = { ...liveServices, fuzzy }
    const current = await runRecall(query, { query: '数据库' }, exec, services)
    assert.deepEqual(current.groups.map(g => g.sessionId), ['one'])
    assert.equal(current.groups[0].context.length, 0)
    assert.ok(current.groups[0].events.length)
    const workspace = await runRecall(query, { query: '数据库', scope: 'workspace' }, exec, { ...liveServices, fuzzy })
    assert.deepEqual(new Set(workspace.groups.map(g => g.sessionId)), new Set(['one', 'two']))
    const all = await runRecall(query, { query: '数据库', scope: 'all' }, exec, { ...liveServices, fuzzy })
    assert.equal(all.groups.length, 3)
    const unavailable = await runRecall(query, { query: '数据库' }, {}, { ...liveServices, fuzzy })
    assert.equal(unavailable.ok, false)
    const missingCwd = await runRecall(query, { query: '数据库', scope: 'workspace' }, { agent: { session: { id: 'one', header: {} } } }, { ...liveServices, fuzzy })
    assert.equal(missingCwd.ok, false)
  } finally { fuzzy.close() }
})

test('detail hit list, full original assistant text and paged browsing are preserved', async () => {
  const fuzzy = openIndexed()
  try {
    const services = { ...liveServices, fuzzy }
    const hitList = await runRecall(query, { query: '在线向量', detail: { sessionId: 'one' } }, exec, services)
    assert.match(hitList.groups[0].context[0].text, /在线向量/)
    const exact = await runRecall(query, { query: '数据库', detail: { sessionId: 'one', seq: 1, before: 0, after: 0 } }, exec, services)
    assert.equal(exact.groups[0].cwd, '/work/a')
    assert.equal(exact.groups[0].context[0].text, '保留 PostgreSQL，使用在线向量模型')
    const first = await runRecall(query, { query: '数据库', detail: { sessionId: 'one', browse: true, pageSize: 2 } }, exec, services)
    assert.equal(first.groups[0].nextFromSeq, 2)
    const last = await runRecall(query, { query: '数据库', detail: { sessionId: 'one', browse: true, fromSeq: 2, pageSize: 2 } }, exec, services)
    assert.equal(last.groups[0].context.length, 1)
    assert.equal(last.groups[0].nextFromSeq, undefined)
  } finally { fuzzy.close() }
})

test('fuzzy typo tolerance and literal fallback survive semantic outage', async () => {
  const fuzzy = openIndexed()
  try {
    const result = await runRecall(query, { query: '数据库压缩模形' }, exec, { ...liveServices, fuzzy,
      semanticEnabled: true, embedder: { available: true, ensureLoaded: async () => { throw new Error('offline') } } })
    assert.equal(result.groups[0].sessionId, 'one')
    let request
    const fallback = await runRecall({ ...query, searchSessions: async r => { request = r; return { items: [{ header: sessions[0].header, bestMatch: { snippet: '原文' } }] } } },
      { query: '原文' }, exec, { fuzzy: { search: () => { throw new Error('index unavailable') } } })
    assert.equal(fallback.ok, true)
    assert.deepEqual(request.sessionFilters, [{ kind: 'id', values: ['one'] }])
  } finally { fuzzy.close() }
})

test('remote semantic retrieval uses dynamic dimensions and gated coverage', async () => {
  const fuzzy = openIndexed()
  try {
    fuzzy.setVectorSpace('model-one')
    const pending = fuzzy.pendingVectors(100)
    fuzzy.storeVectors(pending.map(p => ({ rowid: p.rowid, vec: new Float32Array([1, 0, 0]) })))
    assert.equal(fuzzy.dim, 3)
    assert.equal(fuzzy.vectorCoverage(), 1)
    let embeddedQuery
    const result = await runRecall(query, { query: '无字面重叠的改述' }, exec, { ...liveServices, fuzzy, semanticEnabled: true,
      embedder: { available: true, fingerprint: 'model-one', ensureLoaded: async () => {}, embed: async value => { embeddedQuery = value; return new Float32Array([1, 0, 0]) } } })
    assert.equal(result.groups[0].sessionId, 'one')
    assert.equal(embeddedQuery, '无字面重叠的改述')
    fuzzy.requireDb().prepare('DELETE FROM vectors WHERE doc_rowid = ?').run(pending[0].rowid)
    embeddedQuery = undefined
    const gated = await runRecall(query, { query: '数据库' }, exec, { ...liveServices, fuzzy, semanticEnabled: true, semanticBudget: 0,
      config: { coverageThreshold: 0.9 },
      embedder: { available: true, fingerprint: 'model-one', ensureLoaded: async () => {}, embed: async () => { embeddedQuery = 'unexpected'; return new Float32Array([1, 0, 0]) } } })
    assert.equal(gated.ok, true)
    assert.equal(embeddedQuery, undefined, 'semantic query must stay gated below configured coverage')
    fuzzy.setVectorSpace('different-provider-same-dim')
    assert.equal(fuzzy.vectorCoverage(), 0)
    assert.equal(fuzzy.dim, 0)
    assert.throws(() => fuzzy.storeVectors([{ rowid: pending[0].rowid, vec: new Float32Array([NaN]) }]), /Invalid/)
  } finally { fuzzy.close() }
})

test('deleted/replaced sessions clear orphan vectors and keep exact coverage', async () => {
  const fuzzy = openIndexed()
  try {
    fuzzy.setVectorSpace('test')
    fuzzy.storeVectors(fuzzy.pendingVectors(100).map(p => ({ rowid: p.rowid, vec: new Float32Array([1, 0]) })))
    const snap = s => ({ header: s.header, revision: `r:${s.header.id}` })
    await fuzzy.reconcile({ snapshots: async () => [snap(sessions[0])], inspect: async id => sessions.find(s => s.header.id === id) })
    assert.equal(fuzzy.requireDb().prepare('SELECT COUNT(*) AS n FROM vectors').get().n, 3)
    assert.equal(fuzzy.vectorCoverage(), 1)
    fuzzy.appendEvents(sessions[0].header, [...sessions[0].events, message(3, '新的尚未嵌入文本')])
    assert.equal(fuzzy.vectorCoverage(), 0.75)
  } finally { fuzzy.close() }
})

test('event aggregation honors GUI gap/count and bounded snippets', () => {
  const hits = [1, 3, 20, 40].map((rowid, i) => ({ rowid, seq: i * 10, score: 1 - i / 10, text: '数据库'.repeat(300) }))
  const events = buildEvents(hits, '数据库')
  assert.equal(events[0].hitCount, 2)
  assert.equal(events[0].startSeq, 0)
  assert.equal(events[0].endSeq, 10)
  assert.ok(events[0].snippet.length <= 241)
  assert.equal(buildEvents(hits, '数据库', { eventGap: 1, maxEvents: 1 }).length, 1)
  assert.equal(buildEvents(hits, '数据库', { eventGap: 1, maxEvents: 1 })[0].hitCount, 1)
})

test('rc.5 block-array summaries and original user fragments build anchors', async () => {
  const text = await buildAnchorText(query, 'one', { data: { summary: [{ type: 'text', text: '使用专用压缩模型' }], shadowedRange: { start: 0, end: 2 } } })
  assert.match(text, /摘要:使用专用压缩模型/)
  assert.match(text, /保留原始日志/)
  assert.match(text, /detail/)
})

test('public corpus adapter lists snapshots, reads logs and folds host titles', async () => {
  let listCount = 0
  const svc = corpusServices({ sessions: { list: () => [{ id: 'one', header: sessions[0].header }] },
    sessionQuery: { readSession: async () => ({ session: sessions[0].header, events: sessions[0].events }),
      readTitleSnapshots: async ids => ids.map(id => id === 'one'
        ? { sessionId: id, status: 'fulfilled', value: { header: sessions[0].header, title: { title: ' 标题一 ' } } }
        : { sessionId: id, status: 'rejected', reason: new Error('missing') }) },
    sessionPersistence: { list: async () => { listCount++; return [] } } })
  assert.equal((await svc.readSession('one')).events.length, 3)
  assert.deepEqual(svc.liveIds(), ['one'])
  await svc.listSnapshots()
  assert.equal(listCount, 1)
  assert.deepEqual([...await svc.readTitles(['one', 'two'])], [['one', '标题一']])
  assert.deepEqual(schemaValue({ a: null, b: { c: undefined, d: 'kept' }, e: 0 }), { b: { d: 'kept' }, e: 0 })
})

test('anchor lifetime, live GUI toggle and full detail rendering', async () => {
  const listeners = new Map(), cleanup = []
  let definition, provider
  const config = { semantic: false, anchor: true, anchorRounds: 3 }
  const ctx = { sessionQuery: query, sessions: { list: () => [] }, effect: f => cleanup.push(f()),
    tools: { register: tool => { definition = tool } }, systemPrompt: { context: p => { provider = p } },
    on: (name, fn) => listeners.set(name, fn) }
  applyRecall(ctx, () => config, () => null, { autoStart: false })
  try {
    listeners.get('session/event')({ id: 'one' }, { type: 'compaction/summary', data: { summary: [{ type: 'text', text: '压缩摘要' }] } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(provider.text({ agent: { session: { id: 'two' } } }), '')
    for (let i = 0; i < 3; i++) assert.match(provider.text({ agent: { session: { id: 'one' } } }), /压缩摘要/)
    assert.equal(provider.text({ agent: { session: { id: 'one' } } }), '')
    const long = '完整原文'.repeat(200)
    const rendered = definition.output.render({}, { ok: true, query: 'test', total: 1, groups: [{ sessionId: 'one', context: [{ seq: 1, type: 'assistant/message', text: long }] }] })
    assert.ok(rendered[0].text.includes(long))
  } finally { await Promise.all(cleanup.map(fn => fn())) }
})

test('real rc.5 query/persistence reads and system prompt assembly honor ported interfaces', async () => {
  const ctx = new Context()
  const cold = Session.create(SessionId('persisted-recall'), [], {
    version: 4, id: SessionId('persisted-recall'), createdAt: 1000, cwd: '/work/cold', isSeeded: false,
  })
  const coldMessage = cold.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '持久会话中的数据库原始内容\n完整换行' }] }), { surfaceOp: 'append' })
  let handlesClosed = 0
  class ReadOnlyPersistence extends SessionPersistence {
    async list() { return [{ header: cold.header, revision: 'persisted:1' }] }
    async open(id, access) {
      assert.equal(id, cold.id)
      assert.equal(access, 'read')
      return { header: cold.header, inheritedEventCount: 0,
        read: async () => ({ events: [...cold.snapshotEvents()], eventState: 'shared-frozen' }),
        close: async () => { handlesClosed++ } }
    }
  }
  const fuzzy = new FuzzyIndex(':memory:').open()
  try {
    const fibers = [ctx.plugin(SessionStore), ctx.plugin(ReadOnlyPersistence), ctx.plugin(SessionQueryEngine), ctx.plugin(SystemPrompt), ctx.plugin(ToolRuntime), ctx.plugin(NativeToolExecutor)]
    await Promise.all(fibers.map(fiber => fiber.await()))
    const live = ctx.sessions.create(SessionId('live-recall'), { meta: { cwd: '/work/live' } })
    const liveEvent = live.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '实时会话数据库内容' }] }), { surfaceOp: 'append' })
    const sync = new IndexSync({ index: () => fuzzy, ...corpusServices(ctx) })
    sync.observe(live, liveEvent)
    await sync.flush()
    await sync.reconcile()
    sync.dispose()
    const services = { fuzzy }
    const result = await runRecall(ctx.sessionQuery, { query: '数据库', scope: 'all' }, {}, services)
    assert.equal(result.ok, true)
    assert.deepEqual(new Set(result.groups.map(group => group.sessionId)), new Set([live.id, cold.id]))
    const detail = await runRecall(ctx.sessionQuery, { query: '数据库', detail: { sessionId: cold.id, seq: coldMessage.seq, before: 0, after: 0 } }, {}, services)
    assert.equal(detail.groups[0].cwd, '/work/cold')
    assert.equal(detail.groups[0].context[0].text, '持久会话中的数据库原始内容\n完整换行')
    assert.ok(handlesClosed > 0, 'public query must close read-only cold-session handles')

    const recallFiber = ctx.plugin({ name: 'recall-integration-fixture', inject: ['tools', 'sessions', 'sessionQuery', 'sessionPersistence', 'systemPrompt'],
      apply: child => { applyRecall(child, () => ({ semantic: false, anchor: true, anchorRounds: 3 }), () => null, { autoStart: false }) } })
    await recallFiber.await()
    ctx.emit('session/event', live, { type: 'compaction/summary', data: { summary: [{ type: 'text', text: '来自真实提示组装的压缩锚点' }] } })
    await new Promise(resolve => setImmediate(resolve))
    const assembly = await ctx.systemPrompt.assemble({ agent: { session: live } })
    assert.match(assembly.contexts.find(context => context.name === 'context-recall-anchor').text, /真实提示组装/)
    const unrelated = await ctx.systemPrompt.assemble({ agent: { session: cold } })
    assert.equal(unrelated.contexts.find(context => context.name === 'context-recall-anchor').text, '')
    await recallFiber.dispose()
    const removed = await ctx.systemPrompt.assemble({ agent: { session: live } })
    assert.ok(!removed.contexts.some(context => context.name === 'context-recall-anchor'), 'plugin unload removes the global anchor provider')
  } finally { fuzzy.close(); await ctx.fiber.dispose() }
})

test('unload aborts in-flight online warm-up before waiting for its queue', async () => {
  const previousPath = process.env.CONTEXT_RECALL_INDEX_PATH
  process.env.CONTEXT_RECALL_INDEX_PATH = ':memory:'
  const cleanup = []
  let definition, rejectNetwork, enteredBatch, disposals = 0
  const entered = new Promise(resolve => { enteredBatch = resolve })
  const embedder = {
    available: true, fingerprint: 'abortable-online-model', ensureLoaded: async () => {},
    embedBatch: () => { enteredBatch(); return new Promise((_, reject) => { rejectNetwork = reject }) },
    dispose: async () => { disposals++; rejectNetwork?.(new Error('disposed online IO')) },
  }
  const ctx = { sessionQuery: { ...query, readSession: async () => ({ session: sessions[0].header, events: sessions[0].events }) },
    sessions: { list: () => [{ id: 'one', header: sessions[0].header }] }, effect: f => cleanup.push(f()),
    tools: { register: tool => { definition = tool } }, systemPrompt: { context: () => {} }, on: (name, fn) => { if (name === 'session/event') observers.push(fn) } }
  const observers = []
  const observe = (...args) => observers.forEach(fn => fn(...args))
  try {
    const handles = applyRecall(ctx, () => ({ semantic: true, anchor: true, warmup: 'gentle' }), () => embedder, { autoStart: false })
    observe({ id: 'one', header: sessions[0].header }, sessions[0].events[0])
    await handles.sync.flush()
    const running = definition.execute({ query: '数据库' }, exec)
    await entered
    await Promise.all(cleanup.map(fn => fn()))
    assert.equal(disposals, 1)
    assert.equal((await running).ok, true, 'semantic abort must retain fuzzy retrieval fallback')
  } finally {
    if (previousPath === undefined) delete process.env.CONTEXT_RECALL_INDEX_PATH
    else process.env.CONTEXT_RECALL_INDEX_PATH = previousPath
  }
})
