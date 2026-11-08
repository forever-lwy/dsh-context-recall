// Search API behind the session search page. It reads the same index as the
// `recall` tool but returns a shape made for people: sessions ranked by their
// best match, each with a few highlighted hits that the preview can open.
//
// The page belongs to the user, so it is not bound by the AI access settings.
import { stripText, extractEventText } from './fuzzy-index.js'

const MAX_HITS_PER_SESSION = 5
const SNIPPET_CHARS = 180

function clamp(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), min), max) : fallback
}

/** Snippet windowed around the first query fragment that occurs in `text`. */
export function snippetAround(text, query, maxChars = SNIPPET_CHARS) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  const chars = Array.from(clean)
  if (chars.length <= maxChars) return clean
  const q = stripText(query)
  let at = -1
  for (let len = Math.min(q.length, 24); len >= 2 && at < 0; len -= 1) {
    at = clean.indexOf(q.slice(0, len))
    if (at < 0) at = clean.indexOf(q.slice(q.length - len))
  }
  const start = Math.max(0, (at >= 0 ? Array.from(clean.slice(0, at)).length : 0) - Math.floor(maxChars / 3))
  const end = Math.min(chars.length, start + maxChars)
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`
}

/**
 * @param {object} deps
 * @param {() => import('./fuzzy-index.js').FuzzyIndex | null} deps.index
 * @param {() => any} deps.getEmbedder - OnlineEmbedder or null
 * @param {() => {semantic?: boolean, coverageThreshold?: number}} deps.getConfig
 * @param {{flush(): Promise<any>, lastReconcile?: object|null}} [deps.sync]
 * @param {() => readonly string[] | undefined} [deps.archivedIds]
 * @param {(id: string) => Promise<{events: object[]}>} [deps.readSession]
 */
export function createSearchApi(deps) {
  const requireIndex = () => {
    const index = deps.index()
    if (!index) throw new Error('会话索引不可用。')
    return index
  }
  const refresh = async index => {
    try { await deps.sync?.flush() } catch { /* search the index as it is */ }
    try {
      const ids = deps.archivedIds?.()
      if (Array.isArray(ids)) index.setArchived(ids)
    } catch { /* archive flags stay as last known */ }
  }
  const semanticState = index => {
    const config = deps.getConfig()
    const embedder = config.semantic ? deps.getEmbedder() : null
    const coverage = index.vectorCoverage()
    const ready = Boolean(embedder && embedder.available && coverage >= (config.coverageThreshold ?? 0.9))
    return { embedder, coverage, ready, enabled: Boolean(config.semantic && embedder) }
  }

  async function search(request, signal) {
    const index = requireIndex()
    await refresh(index)
    const query = String(request.query || '').trim()
    const mode = ['keyword', 'title', 'semantic'].includes(request.mode) ? request.mode : 'auto'
    const limit = clamp(request.limit, 1, 100, 30)
    const scope = { cwd: request.cwd || undefined, includeArchived: request.includeArchived !== false }
    const semantic = semanticState(index)
    const base = { ok: true, query, mode, semantic: { enabled: semantic.enabled, ready: semantic.ready, coverage: semantic.coverage } }
    if (!query) return { ...base, groups: [] }

    const sessions = new Map() // sessionId -> { score, titleMatch, hits: Map(seq -> hit) }
    const touch = id => {
      let entry = sessions.get(id)
      if (!entry) { entry = { score: 0, titleMatch: false, hits: new Map() }; sessions.set(id, entry) }
      return entry
    }
    const addHit = (hit, source) => {
      const entry = touch(hit.session_id)
      entry.score = Math.max(entry.score, hit.score)
      const existing = entry.hits.get(hit.seq)
      if (!existing || hit.score > existing.score) {
        entry.hits.set(hit.seq, { seq: hit.seq, type: hit.type, time: hit.time ?? undefined, score: hit.score, source,
          snippet: snippetAround(hit.text, query) })
      }
    }

    if (mode === 'title' || mode === 'auto' || mode === 'keyword') {
      for (const row of index.searchTitles({ query, limit: limit * 2, ...scope })) {
        const entry = touch(row.session_id)
        entry.titleMatch = true
        // A title match ranks a session like a strong content match.
        entry.score = Math.max(entry.score, mode === 'title' ? row.score : row.score * 0.95)
      }
    }
    if (mode === 'auto' || mode === 'keyword') {
      for (const hit of index.search({ query, limit: Math.min(limit * 4, 100), ...scope })) addHit(hit, 'keyword')
    }
    let semanticError
    if (mode === 'semantic' || (mode === 'auto' && semantic.ready)) {
      if (!semantic.ready) {
        semanticError = semantic.enabled ? '语义索引尚未就绪（向量覆盖率不足或服务不可用）。' : '未启用在线向量，无法进行语义检索。'
      } else {
        try {
          await semantic.embedder.ensureLoaded()
          signal?.throwIfAborted?.()
          index.setVectorSpace(semantic.embedder.fingerprint)
          const qVec = await semantic.embedder.embed(query, signal)
          for (const hit of index.semanticSearch(qVec, Math.min(limit * 4, 200), scope)) addHit(hit, 'semantic')
        } catch (error) {
          if (signal?.aborted) throw error
          semanticError = '语义检索暂时失败，已显示关键词结果。'
        }
      }
    }

    const meta = index.sessionsMeta([...sessions.keys()])
    const groups = [...sessions]
      .filter(([id]) => meta.has(id))
      .map(([id, entry]) => {
        const row = meta.get(id)
        const hits = [...entry.hits.values()].sort((a, b) => b.score - a.score).slice(0, MAX_HITS_PER_SESSION)
          .sort((a, b) => a.seq - b.seq)
        return {
          sessionId: id,
          title: row.title || undefined,
          cwd: row.cwd || undefined,
          createdAt: row.created_at ?? undefined,
          updatedAt: row.updated_at ?? undefined,
          archived: row.archived === 1,
          subagent: row.origin === 'subagent',
          titleMatch: entry.titleMatch,
          score: Number(entry.score.toFixed(4)),
          hitCount: entry.hits.size,
          hits: hits.map(({ score: _score, ...hit }) => hit),
        }
      })
      .sort((a, b) => b.score - a.score || (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, limit)
    return { ...base, groups, ...(semanticError ? { notice: semanticError } : {}) }
  }

  async function read(request) {
    const index = requireIndex()
    await refresh(index)
    const meta = index.sessionsMeta([request.sessionId]).get(request.sessionId)
    if (!meta) return { ok: false, error: '该会话不在索引中（可能已删除）。' }
    let rows, hasBefore, hasAfter
    if (Number.isFinite(request.seq)) {
      ;({ rows, hasBefore, hasAfter } = index.window(request.sessionId, request.seq, clamp(request.before, 0, 50, 4), clamp(request.after, 0, 50, 4)))
    } else {
      const page = index.browse(request.sessionId, clamp(request.fromSeq, 0, Number.MAX_SAFE_INTEGER, 0), clamp(request.pageSize, 1, 100, 30))
      rows = page.rows
      hasBefore = false
      hasAfter = page.nextFromSeq !== null
    }
    return {
      ok: true,
      sessionId: request.sessionId,
      title: meta.title || undefined,
      cwd: meta.cwd || undefined,
      updatedAt: meta.updated_at ?? undefined,
      items: rows.map(row => ({ seq: row.seq, type: row.type, time: row.time ?? undefined, text: row.text })),
      hasBefore,
      hasAfter,
    }
  }

  /**
   * Where a message sits in the conversation view: its turn number (the host's
   * turn navigation unit) and the start of its text for in-turn highlighting.
   * Reads the session log once.
   */
  async function locate(request) {
    if (!deps.readSession) return { ok: false, error: '无法读取会话日志。' }
    const log = await deps.readSession(request.sessionId)
    const events = Array.isArray(log?.events) ? log.events : []
    let turn = null
    let text = ''
    for (const event of events) {
      if (!event || event.seq > request.seq) break
      if (event.type === 'turn/start' && Number.isFinite(event.data?.turn)) turn = event.data.turn
      if (event.seq === request.seq) {
        if (event.type === 'assistant/message' && Number.isFinite(event.data?.turn)) turn = event.data.turn
        text = extractEventText(event)
      }
    }
    if (turn === null) return { ok: false, error: '找不到该消息所在的回合。' }
    return { ok: true, turn, ...(text ? { text: locateSnippet(text) } : {}) }
  }

  async function status() {
    const index = requireIndex()
    const stats = index.stats()
    const semantic = semanticState(index)
    const last = deps.sync?.lastReconcile ?? null
    return {
      ok: true,
      sessions: stats.sessions,
      docs: stats.docs,
      vectors: stats.vectors,
      semantic: { enabled: semantic.enabled, ready: semantic.ready, coverage: semantic.coverage },
      lastReconcileAt: last?.at ?? undefined,
      workspaces: index.workspaces().map(row => ({ cwd: row.cwd, sessions: row.sessions })),
    }
  }

  return { search, read, locate, status }
}

/**
 * A short, markdown-free phrase from the start of a message that will appear
 * verbatim in the rendered conversation (first line with plain characters).
 */
export function locateSnippet(text) {
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/[`*_#>|[\]()~-]+/g, ' ').replace(/\s+/g, ' ').trim()
    if (Array.from(line).length >= 4) return Array.from(line).slice(0, 24).join('').trim()
  }
  return Array.from(String(text).replace(/\s+/g, ' ').trim()).slice(0, 24).join('')
}
