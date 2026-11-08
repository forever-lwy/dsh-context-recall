import test from 'node:test'
import assert from 'node:assert/strict'
import { applyRecall } from '../lib/recall.js'
import { quotesUser } from '../lib/recall-tool.js'

const text = (seq, value, type = 'user/message') => ({ seq, type, time: 1000 + seq,
  data: type === 'assistant/message' ? { message: { content: [{ type: 'text', text: value }] } } : { source: { kind: 'user' }, content: [{ type: 'text', text: value }] } })
const logs = {
  one: { session: { id: 'one', cwd: '/work/a', createdAt: 1 }, events: [text(0, '帮我看看另一个窗口里部署脚本的结论'), text(1, '当前会话里的数据库讨论', 'assistant/message')] },
  two: { session: { id: 'two', cwd: '/work/a', createdAt: 2 }, events: [text(0, '部署脚本放在 deploy 目录'), { seq: 1, type: 'session/title', time: 1001, data: { title: '运维｜部署脚本' } }] },
  three: { session: { id: 'three', cwd: '/work/b', createdAt: 3 }, events: [text(0, '另一个工作区的部署脚本')] },
}
const query = {
  readTitle: async () => undefined,
  searchSessions: async () => ({ items: [] }),
  searchEvents: async () => ({ items: [] }),
  readSession: async id => logs[id],
  readEvent: async ({ sessionId, seq, before, after }) => ({ session: logs[sessionId].session,
    events: logs[sessionId].events.filter(e => e.seq >= seq - before && e.seq <= seq + after) }),
  filterEvents: async () => [],
}

async function setup(access = {}, { embedder = null } = {}) {
  const previous = process.env.CONTEXT_RECALL_INDEX_PATH
  process.env.CONTEXT_RECALL_INDEX_PATH = ':memory:'
  const cleanup = []
  let definition
  const config = { semantic: Boolean(embedder), anchor: false, limit: 10, context: 1, crossSession: 'when-asked', readOther: 'when-asked', ...access }
  const ctx = { sessionQuery: query, sessions: { list: () => [] }, effect: f => cleanup.push(f()),
    tools: { register: tool => { definition = tool } }, systemPrompt: { context: () => {} }, on: () => {} }
  const handles = applyRecall(ctx, () => config, () => embedder, { autoStart: false })
  for (const log of Object.values(logs)) handles.index().appendEvents(log.session, log.events)
  const exec = { agent: { session: { id: 'one', header: logs.one.session, snapshotEvents: () => logs.one.events } } }
  return {
    definition, config,
    call: args => definition.execute(args, exec),
    async close() {
      await Promise.all(cleanup.map(fn => fn()))
      if (previous === undefined) delete process.env.CONTEXT_RECALL_INDEX_PATH
      else process.env.CONTEXT_RECALL_INDEX_PATH = previous
    },
  }
}

test('resident tool definition stays small', async () => {
  const t = await setup()
  try {
    const size = JSON.stringify({ name: t.definition.name, description: t.definition.description, parameters: t.definition.parameters }).length
    assert.ok(size < 2200, `recall definition grew to ${size} chars`)
  } finally { await t.close() }
})

test('current-session search works without any permission and returns a follow-up hint', async () => {
  const t = await setup({ crossSession: 'off', readOther: 'off' })
  try {
    const result = await t.call({ query: '数据库' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.groups.map(g => g.sessionId), ['one'])
    assert.match(result.next, /"action":"read","sessionId":"one","seq":1/)
    const page = await t.call({ action: 'read', sessionId: 'one', limit: 1 })
    assert.equal(page.groups[0].context.length, 1)
    assert.match(page.next, /"fromSeq":1/)
  } finally { await t.close() }
})

test('cross-session search honors off / when-asked (verified quote) / autonomous', async () => {
  const off = await setup({ crossSession: 'off' })
  try {
    const denied = await off.call({ query: '部署脚本', scope: 'workspace', userRequest: '帮我看看另一个窗口' })
    assert.equal(denied.ok, false)
    assert.match(denied.error, /turned off/)
  } finally { await off.close() }

  const asked = await setup()
  try {
    assert.match((await asked.call({ query: '部署脚本', scope: 'workspace' })).error, /needs the user's request/)
    assert.equal((await asked.call({ query: '部署脚本', scope: 'workspace', userRequest: '请搜索全部历史' })).ok, false, 'invented quote rejected')
    const allowed = await asked.call({ query: '部署脚本', scope: 'workspace', userRequest: '看看另一个窗口里部署脚本' })
    assert.equal(allowed.ok, true)
    assert.ok(allowed.groups.some(g => g.sessionId === 'two'))
    assert.ok(!allowed.groups.some(g => g.sessionId === 'three'), 'workspace scope stays in the current directory')
  } finally { await asked.close() }

  const free = await setup({ crossSession: 'autonomous' })
  try {
    const all = await free.call({ query: '部署脚本', scope: 'all' })
    assert.equal(all.ok, true)
    assert.ok(all.groups.some(g => g.sessionId === 'three'))
  } finally { await free.close() }
})

test('reading another session follows its own policy; title search counts as cross-session', async () => {
  const t = await setup({ crossSession: 'autonomous', readOther: 'when-asked' })
  try {
    const titles = await t.call({ query: '部署', mode: 'title' })
    assert.equal(titles.ok, true)
    assert.equal(titles.groups[0].sessionId, 'two')
    assert.equal(titles.groups[0].title, '运维｜部署脚本')
    assert.match(titles.next, /"action":"read"/)
    assert.equal((await t.call({ action: 'read', sessionId: 'two' })).ok, false)
    const read = await t.call({ action: 'read', sessionId: 'two', seq: 0, userRequest: '另一个窗口里部署脚本的结论' })
    assert.equal(read.ok, true)
    assert.match(read.groups[0].context[0].text, /deploy 目录/)
  } finally { await t.close() }

  const blocked = await setup({ crossSession: 'off', readOther: 'allowed' })
  try {
    assert.equal((await blocked.call({ query: '部署', mode: 'title' })).ok, false)
    assert.equal((await blocked.call({ action: 'read', sessionId: 'two' })).ok, true)
  } finally { await blocked.close() }
})

test('keyword mode never embeds; semantic mode reports when vectors are unavailable', async () => {
  let embedded = 0
  const embedder = { available: true, fingerprint: 'fp', ensureLoaded: async () => {},
    embed: async () => { embedded += 1; return new Float32Array([1, 0]) }, embedBatch: async texts => texts.map(() => new Float32Array([1, 0])) }
  const t = await setup({}, { embedder })
  try {
    await t.call({ query: '数据库', mode: 'keyword' })
    assert.equal(embedded, 0)
    t.config.coverageThreshold = 2 // never ready
    const semantic = await t.call({ query: '数据库', mode: 'semantic' })
    assert.equal(semantic.ok, false)
    assert.match(semantic.error, /Semantic search is unavailable/)
  } finally { await t.close() }
})

test('quote check normalizes punctuation and rejects trivial quotes', () => {
  assert.equal(quotesUser('看看 另一个窗口！', ['帮我看看另一个窗口里的内容']), true)
  assert.equal(quotesUser('看', ['看看']), false)
  assert.equal(quotesUser('别的话', ['帮我看看']), false)
})
