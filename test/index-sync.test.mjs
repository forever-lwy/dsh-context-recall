import test from 'node:test'
import assert from 'node:assert/strict'
import { FuzzyIndex, extractEventText } from '../lib/fuzzy-index.js'
import { IndexSync, EmbedQueue } from '../lib/index-sync.js'

const user = (seq, text, kind = 'user') => ({ seq, type: 'user/message', time: 1000 + seq,
  data: { source: { kind }, content: [{ type: 'text', text }] } })
const reply = (seq, text) => ({ seq, type: 'assistant/message', time: 1000 + seq,
  data: { message: { content: [{ type: 'text', text }, { type: 'tool-call', name: 'bash', arguments: '{"cmd":"ls"}' }] } } })
const title = (seq, text) => ({ seq, type: 'session/title', time: 1000 + seq, data: { title: text, messageSeqs: [], source: { kind: 'fallback' } } })
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

test('only user-authored text and assistant text blocks are indexed', () => {
  assert.equal(extractEventText(user(0, '真实问题')), '真实问题')
  assert.equal(extractEventText(user(1, 'Current runtime context. ...', 'runtime-context')), '')
  assert.equal(extractEventText(user(2, 'Time sampled', 'time-context')), '')
  assert.equal(extractEventText(user(3, '<system-reminder>', 'skill-catalog')), '')
  assert.equal(extractEventText(reply(4, '助手回答')), '助手回答')
  const legacy = { seq: 5, type: 'user/message', data: { content: [{ type: 'text', text: '旧格式消息' }] } }
  assert.equal(extractEventText(legacy), '旧格式消息')
})

test('live events append incrementally after one catch-up read per session', async () => {
  const index = new FuzzyIndex(':memory:').open()
  const header = { id: 's1', cwd: '/w', createdAt: 900 }
  const log = [user(0, '部署脚本放在哪里'), title(1, '部署｜脚本位置')]
  let reads = 0
  let indexed = 0
  const sync = new IndexSync({
    index: () => index, flushDelayMs: 5,
    readSession: async () => { reads += 1; return { session: header, events: [...log] } },
    listSnapshots: async () => [],
    onIndexed: () => { indexed += 1 },
  })
  try {
    sync.observe({ id: 's1', header }, log[1])
    await sync.flush()
    assert.equal(reads, 1)
    assert.equal(index.stats().docs, 1)
    assert.equal(index.searchTitles({ query: '部署脚本' })[0].session_id, 's1')

    // Streaming noise is ignored; real messages append without reading the log.
    sync.observe({ id: 's1', header }, { seq: 2, type: 'assistant/delta', data: {} })
    log.push(reply(3, '脚本在 deploy 目录'), title(4, '运维｜部署脚本'))
    sync.observe({ id: 's1', header }, log[2])
    sync.observe({ id: 's1', header }, log[3])
    await tick(30)
    assert.equal(reads, 1, 'no further log reads for a tracked session')
    assert.equal(index.stats().docs, 2)
    assert.equal(index.sessionsMeta(['s1']).get('s1').title, '运维｜部署脚本')
    assert.equal(index.searchTitles({ query: '运维' })[0].session_id, 's1')
    assert.ok(indexed >= 2)
    assert.equal(index.search({ query: 'bash' }).length, 0, 'tool-call blocks stay out of the index')
  } finally { sync.dispose(); index.close() }
})

test('reconcile reads only changed revisions, removes deleted sessions and keeps live ones', async () => {
  const index = new FuzzyIndex(':memory:').open()
  const logs = {
    a: { session: { id: 'a', createdAt: 1 }, events: [user(0, '甲会话内容')] },
    b: { session: { id: 'b', createdAt: 2 }, events: [user(0, '乙会话内容')] },
  }
  let snaps = [{ header: logs.a.session, revision: 'a1' }, { header: logs.b.session, revision: 'b1' }]
  const reads = []
  const sync = new IndexSync({
    index: () => index,
    readSession: async id => { reads.push(id); return logs[id] },
    listSnapshots: async () => snaps,
    liveIds: () => ['live'],
    readTitles: async ids => new Map(ids.map(id => [id, `标题-${id}`])),
  })
  try {
    await sync.reconcile()
    assert.deepEqual(reads.sort(), ['a', 'b'])
    assert.equal(index.sessionsMeta(['a']).get('a').title, '标题-a', 'host titles backfill untitled sessions')
    reads.length = 0
    await sync.reconcile()
    assert.deepEqual(reads, [], 'unchanged revisions are not read again')

    logs.a.events.push(reply(1, '甲的新回复'))
    index.appendEvents({ id: 'live', createdAt: 3 }, [user(0, '尚未持久化的实时会话')])
    snaps = [{ header: logs.a.session, revision: 'a2' }]
    await sync.reconcile()
    assert.deepEqual(reads, ['a'])
    assert.equal(index.search({ query: '新回复' })[0].session_id, 'a')
    assert.equal(index.sessionState('b'), undefined, 'deleted session removed')
    assert.ok(index.sessionState('live'), 'live unsaved session kept')

    // A log that no longer extends the watermark is rebuilt from scratch.
    logs.a.events = [user(0, '重写后的内容')]
    snaps = [{ header: logs.a.session, revision: 'a3' }]
    await sync.reconcile()
    assert.equal(index.search({ query: '甲的新回复' }).length, 0)
    assert.equal(index.search({ query: '重写后' })[0].session_id, 'a')
  } finally { sync.dispose(); index.close() }
})

test('semantic search filters scope before ranking and streams vectors', () => {
  const index = new FuzzyIndex(':memory:').open()
  try {
    index.appendEvents({ id: 'mine', cwd: '/a' }, [user(0, '我的文档')])
    index.appendEvents({ id: 'other', cwd: '/b' }, [user(0, '别人的文档'), user(1, '别人的另一篇')])
    index.setVectorSpace('space')
    const rows = index.pendingVectors(10)
    index.storeVectors(rows.map(row => ({ rowid: row.rowid, vec: row.text.startsWith('我的') ? new Float32Array([0.8, 0.6]) : new Float32Array([1, 0]) })))
    const q = new Float32Array([1, 0])
    assert.equal(index.semanticSearch(q, 1)[0].session_id, 'other')
    const scoped = index.semanticSearch(q, 1, { cwd: '/a' })
    assert.equal(scoped.length, 1)
    assert.equal(scoped[0].session_id, 'mine')
    index.setArchived(['other'])
    assert.ok(index.semanticSearch(q, 5, { includeArchived: false }).every(hit => hit.session_id === 'mine'))
  } finally { index.close() }
})

test('embed queue drains only after a kick and backs off when the service fails', async () => {
  const index = new FuzzyIndex(':memory:').open()
  index.appendEvents({ id: 's' }, [user(0, '一'), user(1, '二')])
  let calls = 0
  let fail = true
  const embedder = {
    available: true, fingerprint: 'fp', ensureLoaded: async () => {},
    embedBatch: async texts => { calls += 1; if (fail) throw new Error('offline'); return texts.map(() => new Float32Array([1, 0])) },
  }
  const queue = new EmbedQueue({ index: () => index, getEmbedder: () => embedder, getConfig: () => ({ semantic: true, warmup: 'fast' }), kickDelayMs: 1 })
  try {
    await tick(20)
    assert.equal(calls, 0, 'idle queue holds no timer and does nothing')
    queue.kick()
    await tick(30)
    assert.equal(calls, 1)
    assert.equal(queue.failures, 1)
    queue.kick()
    await tick(30)
    assert.equal(calls, 1, 'kicks during backoff do not hammer the service')
    fail = false
    queue.reset()
    await tick(30)
    assert.equal(index.vectorCoverage(), 1)
    assert.equal(queue.failures, 0)
  } finally { await queue.dispose(); index.close() }
})
