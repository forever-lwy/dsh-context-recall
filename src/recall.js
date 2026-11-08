// Derived from dsh-recall, Copyright (c) 2026 dsh-extension-hub contributors.
// MIT licensed; see THIRD_PARTY.md and LICENSE.
// dsh-recall host entry: registers the `recall` tool on ctx.tools.
//
// The tool searches the ORIGINAL text of every DSH session through the
// official `ctx.sessionQuery` service (FTS5, auto-indexed from the persisted
// JSONL logs — including history shadowed by compaction). Results are grouped
// per session with the surrounding context window, like searching chat
// records and opening the relevant messages.
//
// Registered per Cordis plugin convention: named exports { name, inject,
// apply } — the loader mounts this package through a patch row
// `- id: recall / name: dsh-recall`.
import { FuzzyIndex, recallIndexPath, stripText } from './fuzzy-index.js'
import { IndexSync, EmbedQueue, createExclusive } from './index-sync.js'
import { defineRecallTool } from './recall-tool.js'

/** Semantic index is used only once at least this fraction of docs are embedded. */
const SEMANTIC_READY_COVERAGE = 0.9

/** Same-topic event merge: adjacent hits whose TEXT-BLOCK distance (doc_texts
 *  rowid gap — NOT seq, which spans tool calls/reasoning/chunks) is ≤ this
 *  value merge into one event. Measured on real data: p50 gap = 3, 61% of
 *  consecutive same-topic mentions are ≤ 5 text blocks apart (one question →
 *  answer → follow-up chain). */
const EVENT_GAP = 5

/** Coarse recall shows at most this many events per session (token budget:
 *  3 event snippets keep the coarse call ~600–800 tokens, far below the old
 *  full-context windows). */
const MAX_EVENTS_PER_SESSION = 3

// Extract human-readable text from one session event for context windows.
export function eventText(event) {
  if (!event || !event.data) return ''
  const d = event.data
  if (event.type === 'user/message') {
    const c = d.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .filter(Boolean)
        .join('\n')
    }
    return ''
  }
  if (event.type === 'assistant/message') {
    const m = d.message
    const c = m && m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .filter(Boolean)
        .join('\n')
    }
    return ''
  }
  if (event.type === 'tool/call') {
    return `[tool:${d.name}] ${typeof d.arguments === 'string' ? d.arguments : ''}`
  }
  return `[${event.type}]`
}

function normText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/**
 * Run one recall search: normalize the query, call searchSessions with
 * optional workspace filtering, then enrich each hit with the session title
 * and a bounded context window around its strongest match.
 */
export async function runRecall(sessionQuery, args, exec, services = {}) {
  const query = normText(args.query)
  if (query === '') return { ok: false, error: 'query is required' }
  const limit = Math.floor(Math.min(Math.max(Number.isFinite(args.limit) ? args.limit : (services.config?.limit ?? 10), 1), 50))
  const contextN = Math.floor(Math.min(Math.max(Number.isFinite(args.context) ? args.context : (services.config?.context ?? 3), 0), 10))

  // Second stage (progressive disclosure): drill into one session's original
  // text. When present, everything else (scope filters) is bypassed — the
  // target session is explicitly user-provided.
  const detail = args.detail && typeof args.detail === 'object' ? args.detail : null
  if (detail) return runDetail(sessionQuery, query, limit, contextN, detail, services)

  // Scope resolution. The DEFAULT is the current session only — an agent must
  // never broaden the search on its own; cross-session/cross-project recall
  // happens only when the user explicitly asks (scope=workspace | all).
  const scopeArg = typeof args.scope === 'string' ? args.scope : ''
  const scope = scopeArg === 'session' || scopeArg === 'workspace' || scopeArg === 'all' ? scopeArg : null
  const agentSession = exec && exec.agent && exec.agent.session ? exec.agent.session : null
  const sessionId = agentSession ? agentSession.id : null
  const agentCwd = agentSession && agentSession.header ? agentSession.header.cwd : null
  const explicitCwd = typeof args.workspace === 'string' && args.workspace.trim() !== '' ? args.workspace.trim() : null
  if (scope !== 'all' && !(scope !== 'workspace' && sessionId) && !(explicitCwd || agentCwd)) {
    return { ok: false, error: 'Current session or workspace is required; choose an explicit scope instead of broadening the search automatically.' }
  }

  // The same scope expressed twice: id/cwd filters for the fuzzy index and
  // sessionFilters for the official literal search.
  let fuzzySessionId = null
  let fuzzyCwd = null
  const sessionFilters = []
  if (scope === 'all') {
    // no session filters — every session is searched
  } else if (scope === 'workspace') {
    const cwd = explicitCwd || agentCwd
    if (cwd) {
      sessionFilters.push({ kind: 'cwd', values: [cwd] })
      fuzzyCwd = cwd
    }
  } else if (scope === 'session') {
    if (sessionId) {
      sessionFilters.push({ kind: 'id', values: [sessionId] })
      fuzzySessionId = sessionId
    } else {
      const cwd = explicitCwd || agentCwd
      if (cwd) {
        sessionFilters.push({ kind: 'cwd', values: [cwd] })
        fuzzyCwd = cwd
      }
    }
  } else {
    // default: current session, falling back to the current workspace
    if (sessionId) {
      sessionFilters.push({ kind: 'id', values: [sessionId] })
      fuzzySessionId = sessionId
    } else {
      const cwd = explicitCwd || agentCwd
      if (cwd) {
        sessionFilters.push({ kind: 'cwd', values: [cwd] })
        fuzzyCwd = cwd
      }
    }
  }

  // ── fuzzy index path (primary; degrades to the official literal search) ──
  await prepareIndex(services)
  if (services.fuzzy) {
    try {
      // Semantic layer: incremental asynchronous online warm-up, then — once
      // coverage is complete — semantic hits merged
      // with the fuzzy hits. Any semantic failure silently degrades to
      // fuzzy-only.
      let semHits = []
      if (services.embedder && services.embedder.available && services.semanticEnabled !== false) {
        try {
          await services.embedder.ensureLoaded()
          services.fuzzy.setVectorSpace(services.embedder.fingerprint)
          const pending = services.fuzzy.pendingVectors(services.semanticBudget ?? 48)
          if (pending.length > 0) {
            const vecs = await services.embedder.embedBatch(pending.map((p) => p.text), services.signal)
            services.fuzzy.storeVectors(pending.map((p, i) => ({ rowid: p.rowid, vec: vecs[i] })))
          }
          if (services.fuzzy.vectorCoverage() >= (services.config?.coverageThreshold ?? SEMANTIC_READY_COVERAGE)) {
            const qVec = await services.embedder.embed(query, services.signal)
            semHits = services.fuzzy.semanticSearch(qVec, limit * 3, { sessionId: fuzzySessionId, cwd: fuzzyCwd })
            services.semanticReady = true
          }
        } catch {
          // semantic unavailable: fuzzy-only below
        }
      }
      if (services.semanticOnly && semHits.length === 0 && !services.semanticReady) {
        return { ok: false, error: 'Semantic search is unavailable (online embeddings off, failing, or index coverage below the configured threshold). Use mode auto or keyword.' }
      }
      const fuzzyHits = services.semanticOnly ? [] : services.fuzzy.search({ query, limit: limit * 3, sessionId: fuzzySessionId, cwd: fuzzyCwd })
      const hits = mergeHits(semHits, fuzzyHits, limit)
      if (hits.length > 0) {
        const groups = await buildGroups(sessionQuery, hits, { limit, contextN, query, config: services.config, index: services.fuzzy })
        return { ok: true, query, total: groups.length, groups }
      }
    } catch {
      // fuzzy search failed: degrade to the official literal search below
    }
  }

  // ── official literal search (phase-1 path, also the degradation target) ──
  let page
  try {
    page = await sessionQuery.searchSessions({ query, sessionFilters: sessionFilters.length ? sessionFilters : undefined, limit })
  } catch (error) {
    return { ok: false, error: `search failed: ${error && error.message ? error.message : String(error)}` }
  }

  const hits = (page && Array.isArray(page.items) ? page.items : []).filter((h) => h && h.header && h.bestMatch)
  const groups = []
  for (const hit of hits) {
    const sessionId = hit.header.id
    const group = {
      sessionId,
      cwd: hit.header.cwd || null,
      createdAt: hit.header.createdAt || null,
      hitTime: hit.bestMatch.time || null,
      snippet: normText(hit.bestMatch.snippet),
      context: [],
    }
    try {
      const title = await sessionQuery.readTitle(sessionId)
      if (title && typeof title.title === 'string') group.title = title.title
    } catch {
      // title unavailable; keep the group without one
    }
    groups.push(group)
  }
  return { ok: true, query, total: groups.length, groups }
}

/**
 * Second stage (progressive disclosure): drill into one session's ORIGINAL
 * text. Three shapes:
 *   detail:{sessionId}                  — all hits inside that session (light)
 *   detail:{sessionId, seq, before, after} — exact original window around one seq
 *   detail:{sessionId, browse, fromSeq, pageSize} — page through the session
 * The target session is explicit user-provided, so no scope filter applies.
 */
async function runDetail(sessionQuery, query, limit, contextN, detail, services) {
  const sessionId = typeof detail.sessionId === 'string' && detail.sessionId !== '' ? detail.sessionId : null
  if (!sessionId) return { ok: false, error: 'detail.sessionId is required' }
  let title = null
  try {
    const t = await sessionQuery.readTitle(sessionId)
    if (t && typeof t.title === 'string' && t.title) title = t.title
  } catch {
    // title unavailable
  }

  // ── browse: page through the session's text blocks ──────────────────────
  if (detail.browse === true) {
    const fromSeq = Number.isFinite(detail.fromSeq) ? Math.max(0, Math.floor(detail.fromSeq)) : 0
    const pageSize = Math.min(Math.max(Number.isFinite(detail.pageSize) ? detail.pageSize : 20, 1), 50)
    await prepareIndex(services)
    if (services.fuzzy) {
      try {
        const { rows, nextFromSeq } = services.fuzzy.browse(sessionId, fromSeq, pageSize)
        const group = {
          sessionId,
          title,
          context: rows.map((r) => ({ seq: r.seq, type: r.type, time: r.time ?? null, text: r.text })),
        }
        if (nextFromSeq !== null) group.nextFromSeq = nextFromSeq
        return { ok: true, query, total: 1, groups: [group] }
      } catch {
        // fall through to the official read
      }
    }
    try {
      const docs = await sessionQuery.filterEvents(sessionId, [{ kind: 'seq', range: { gte: fromSeq, lte: fromSeq + pageSize - 1 } }])
      const events = Array.isArray(docs) ? docs : []
      const group = {
        sessionId,
        title,
        context: events.map((d) => ({ seq: d.seq, type: d.type, time: d.time ?? null, text: d.text })),
      }
      if (events.length === pageSize) group.nextFromSeq = fromSeq + pageSize
      return { ok: true, query, total: 1, groups: [group] }
    } catch (error) {
      return { ok: false, error: `browse failed: ${error && error.message ? error.message : String(error)}` }
    }
  }

  // ── exact original-text window around one seq ───────────────────────────
  if (Number.isFinite(detail.seq)) {
    const seq = Math.floor(detail.seq)
    const before = Math.min(Math.max(Number.isFinite(detail.before) ? detail.before : contextN, 0), 10)
    const after = Math.min(Math.max(Number.isFinite(detail.after) ? detail.after : contextN, 0), 10)
    try {
      const window = await sessionQuery.readEvent({ sessionId, seq, before, after })
      const group = { sessionId, title }
      const header = window?.session ?? null
      if (header) {
        group.cwd = header.cwd || null
        group.createdAt = header.createdAt || null
      }
      group.context = (window && Array.isArray(window.events) ? window.events : []).map((e) => ({
        seq: e.seq,
        type: e.type,
        time: e.time || null,
        text: eventText(e),
      }))
      return { ok: true, query, total: 1, groups: [group] }
    } catch (error) {
      return { ok: false, error: `detail failed: ${error && error.message ? error.message : String(error)}` }
    }
  }

  // ── all hits inside one session (light list) ────────────────────────────
  try {
    const hits = await detailSessionHits(sessionQuery, query, limit, sessionId, services)
    const group = {
      sessionId,
      title,
      context: hits.map((h) => ({ seq: h.seq, type: h.type || 'text', time: h.time || null, text: makeFuzzySnippet(h.text, query) })),
    }
    if (hits.length > 0) {
      group.cwd = hits[0].cwd || null
      group.createdAt = hits[0].created_at || null
    }
    return { ok: true, query, total: 1, groups: [group] }
  } catch (error) {
    return { ok: false, error: `detail failed: ${error && error.message ? error.message : String(error)}` }
  }
}

/** All hits inside one explicit session (semantic ∪ fuzzy, official fallback). */
async function detailSessionHits(sessionQuery, query, limit, sessionId, services) {
  await prepareIndex(services)
  if (services.fuzzy) {
    try {
      let semHits = []
      if (services.embedder && services.embedder.available && services.semanticEnabled !== false) {
        try {
          await services.embedder.ensureLoaded()
          services.fuzzy.setVectorSpace(services.embedder.fingerprint)
          const pending = services.fuzzy.pendingVectors(services.semanticBudget ?? 48)
          if (pending.length > 0) {
            const vecs = await services.embedder.embedBatch(pending.map((p) => p.text), services.signal)
            services.fuzzy.storeVectors(pending.map((p, i) => ({ rowid: p.rowid, vec: vecs[i] })))
          }
          if (services.fuzzy.vectorCoverage() >= (services.config?.coverageThreshold ?? SEMANTIC_READY_COVERAGE)) {
            const qVec = await services.embedder.embed(query, services.signal)
            semHits = services.fuzzy.semanticSearch(qVec, limit * 3, { sessionId })
          }
        } catch {
          // semantic unavailable: fuzzy-only
        }
      }
      const fuzzyHits = services.fuzzy.search({ query, limit: limit * 3, sessionId })
      return mergeHits(semHits, fuzzyHits, limit)
    } catch {
      // fall through to the official search
    }
  }
  const page = await sessionQuery.searchEvents({ sessionId, query, limit })
  const items = (page && Array.isArray(page.items) ? page.items : []).filter((h) => h && Number.isFinite(h.seq))
  return items.map((h) => ({
    session_id: sessionId,
    seq: h.seq,
    type: h.type,
    time: h.time,
    text: typeof h.snippet === 'string' ? h.snippet : '',
    cwd: null,
    created_at: null,
    score: 1,
  }))
}

/**
 * Title search across sessions (scope workspace by default, or all).
 * Returns the same group shape as a coarse recall, without episodes.
 */
export function runTitleSearch(index, args, exec, config = {}) {
  if (!index) return { ok: false, error: 'Title search needs the session index, which is unavailable.' }
  const query = normText(args.query)
  const limit = Math.floor(Math.min(Math.max(Number.isFinite(args.limit) ? args.limit : (config.limit ?? 10), 1), 50))
  const agentCwd = exec?.agent?.session?.header?.cwd ?? null
  const explicitCwd = typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : null
  const cwd = args.scope === 'all' ? null : (explicitCwd || agentCwd)
  if (args.scope !== 'all' && !cwd) return { ok: false, error: 'No current workspace; pass scope "all" or a workspace.' }
  const rows = index.searchTitles({ query, limit, cwd: cwd ?? undefined })
  const groups = rows.map(row => ({
    sessionId: row.session_id,
    title: row.title || undefined,
    cwd: row.cwd || undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  }))
  return { ok: true, query, total: groups.length, groups }
}

/**
 * Bring the index up to date before reading it: apply queued live events.
 * A broken index degrades the call to the official literal search.
 */
async function prepareIndex(services) {
  if (!services.fuzzy) return
  try {
    if (services.sync) await services.sync.flush()
  } catch {
    services.fuzzy = null
  }
}

/**
 * Bounded snippet windowed around the first query fragment occurrence.
 */
function makeFuzzySnippet(text, query) {
  const maxChars = 240
  const clean = normText(text)
  const chars = Array.from(clean)
  if (chars.length <= maxChars) return clean
  const q = stripText(query)
  let at = -1
  if (q) {
    for (let len = Math.min(q.length, 24); len >= 2 && at < 0; len -= 1) {
      at = clean.indexOf(q.slice(0, len))
      if (at < 0) at = clean.indexOf(q.slice(q.length - len))
    }
  }
  const matchAt = at >= 0 ? at : 0
  const start = Math.max(0, matchAt - Math.floor(maxChars / 3))
  const prefix = start > 0 ? '…' : ''
  const end = Math.min(chars.length, start + maxChars - prefix.length - 1)
  const suffix = end < chars.length ? '…' : ''
  return `${prefix}${chars.slice(start, end).join('')}${suffix}`
}

/**
 * Merge semantic and fuzzy hits (both score-sorted 0..1) by doc rowid,
 * keeping the best score per doc. Returns up to limit*2 candidates.
 */
export function mergeHits(semHits, fuzzyHits, limit) {
  const byRowid = new Map()
  for (const h of fuzzyHits) byRowid.set(h.rowid, h)
  for (const h of semHits) {
    const existing = byRowid.get(h.rowid)
    if (!existing) byRowid.set(h.rowid, h)
    else if (h.score > existing.score) existing.score = h.score
  }
  return [...byRowid.values()].sort((a, b) => b.score - a.score).slice(0, limit * 2)
}

/**
 * Merge one session's hits into "events" — same-topic episodes. Consecutive
 * hits whose text-block distance (doc_texts rowid gap) is ≤ EVENT_GAP belong
 * to the same discussion and merge into one event; farther apart they start a
 * new event. Pure local heuristic — no LLM, no topic naming. Events are
 * sorted by their best hit's score, capped at MAX_EVENTS_PER_SESSION.
 * Returns [{ startSeq, endSeq, hitCount, snippet }] — the full event text is
 * one detail browse away (from startSeq until endSeq).
 */
export function buildEvents(hits, query, config = {}) {
  const sorted = [...hits].sort((a, b) => a.rowid - b.rowid)
  const events = []
  let cur = null
  for (const h of sorted) {
    if (!cur || h.rowid - cur.last.rowid > (config.eventGap ?? EVENT_GAP)) {
      cur = { hits: [h], last: h, best: h }
      events.push(cur)
    } else {
      cur.hits.push(h)
      cur.last = h
      if (h.score > cur.best.score) cur.best = h
    }
  }
  const out = events
    .map((e) => ({
      startSeq: e.hits[0].seq,
      endSeq: e.hits[e.hits.length - 1].seq,
      hitCount: e.hits.length,
      snippet: makeFuzzySnippet(e.best.text, query),
      _score: e.best.score,
    }))
    .sort((a, b) => b._score - a._score)
    .slice(0, config.maxEvents ?? MAX_EVENTS_PER_SESSION)
  for (const e of out) delete e._score
  return out
}

/**
 * Build coarse-recall output groups from score-sorted hits: best hit per
 * session, enriched with the session title and a short snippet — NO context
 * window (progressive disclosure: the second stage via detail drills into
 * the original text when needed). Hits of one session are additionally
 * aggregated into same-topic events (see buildEvents).
 */
async function buildGroups(sessionQuery, hits, { limit, query, config, index }) {
  const bySession = new Map()
  for (const hit of hits) {
    if (!bySession.has(hit.session_id)) bySession.set(hit.session_id, [])
    bySession.get(hit.session_id).push(hit)
  }
  let meta = new Map()
  try { if (index) meta = index.sessionsMeta([...bySession.keys()]) } catch { /* titles fall back to the host */ }
  const groups = []
  for (const [hitSessionId, sessionHits] of bySession) {
    if (groups.length >= limit) break
    const events = buildEvents(sessionHits, query, config)
    const best = events[0] || null
    const group = {
      sessionId: hitSessionId,
      cwd: sessionHits[0].cwd || null,
      createdAt: sessionHits[0].created_at || null,
      hitTime: sessionHits[0].time || null,
      snippet: best ? best.snippet : makeFuzzySnippet(sessionHits[0].text, query),
      context: [],
    }
    if (events.length > 0) group.events = events
    const indexedTitle = meta.get(hitSessionId)?.title
    if (indexedTitle) group.title = indexedTitle
    else {
      try {
        const title = await sessionQuery.readTitle(hitSessionId)
        if (title && typeof title.title === 'string') group.title = title.title
      } catch {
        // title unavailable; keep the group without one
      }
    }
    groups.push(group)
  }
  return groups
}

/**
 * Build the compaction anchor text for one compaction/summary event: the
 * LLM-written summary plus up to three key original fragments picked from
 * the shadowed seq range (pure-local heuristics — user messages first, then
 * the longest texts; no external LLM).
 */
export async function buildAnchorText(sessionQuery, sessionId, summaryEvent) {
  const data = summaryEvent && summaryEvent.data ? summaryEvent.data : {}
  const lines = []
  const summary = typeof data.summary === 'string' ? data.summary.trim()
    : Array.isArray(data.summary) ? data.summary.filter(block => block?.type === 'text').map(block => block.text ?? '').join('\n').trim() : ''
  if (summary) lines.push(`摘要:${summary.slice(0, 400)}`)
  const range = data.shadowedRange
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end)) {
    try {
      const docs = await sessionQuery.filterEvents(sessionId, [{ kind: 'seq', range: { gte: range.start, lte: range.end } }])
      const candidates = (Array.isArray(docs) ? docs : [])
        .filter(
          (d) =>
            d &&
            (d.type === 'user/message' || d.type === 'assistant/message') &&
            typeof d.text === 'string' &&
            d.text.trim().length > 0,
        )
        .map((d) => ({ seq: d.seq, type: d.type, text: normText(d.text) }))
      candidates.sort((a, b) =>
        a.type === b.type ? b.text.length - a.text.length : a.type === 'user/message' ? -1 : 1,
      )
      for (const p of candidates.slice(0, 3)) {
        const who = p.type === 'user/message' ? '你' : '助手'
        lines.push(`[${who}#${p.seq}] ${p.text.slice(0, 160)}`)
      }
    } catch {
      // fragments unavailable; the summary alone still anchors the range
    }
  }
  lines.push(`以上为本会话被压缩区间的摘要与关键原文片段。需要精确原文时用 recall 工具读取:{"action":"read","sessionId":"${sessionId}","seq":<seq>}，或从某处翻页:{"action":"read","sessionId":"${sessionId}","fromSeq":<seq>}。`)
  return lines.join('\n')
}

/** Remove absent optional fields so runtime output matches its declared schema. */
export function schemaValue(value) {
  if (Array.isArray(value)) return value.map(schemaValue)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null && v !== undefined).map(([k, v]) => [k, schemaValue(v)]))
  return value
}

/**
 * Public corpus APIs used by the index: persisted snapshots (cheap header +
 * revision listing), live-preferred full reads, live ids and host titles.
 * Failed listings must not erase a valid index.
 */
export function corpusServices(ctx) {
  const query = () => ctx.sessionQuery ?? ctx.get?.('sessionQuery')
  const persistence = () => ctx.sessionPersistence ?? ctx.get?.('sessionPersistence')
  return {
    listSnapshots: async () => {
      const service = persistence()
      return service ? service.list() : []
    },
    readSession: id => query().readSession(id),
    liveIds: () => (ctx.sessions?.list?.() ?? []).map(session => session.id),
    readTitles: async ids => {
      const titles = new Map()
      const service = query()
      if (!service?.readTitleSnapshots) return titles
      const results = await service.readTitleSnapshots(ids)
      for (const result of results) {
        const title = result?.status === 'fulfilled' ? result.value?.title?.title : undefined
        if (typeof title === 'string' && title.trim()) titles.set(result.sessionId, title.trim())
      }
      return titles
    },
  }
}

/** Installs recall behavior with live GUI configuration and a remote embedder. */
export function applyRecall(ctx, getConfig, getEmbedder, options = {}) {
  let fuzzy = null
  let lastEmbedder = null
  let disposed = false
  const anchors = new Map()
  const exclusive = createExclusive()
  const getFuzzy = () => {
    if (disposed) return null
    if (fuzzy) return fuzzy
    const candidate = new FuzzyIndex(recallIndexPath())
    try { candidate.open(); fuzzy = candidate; return fuzzy }
    catch { candidate.close(); return null }
  }
  const log = message => { try { ctx.logger?.('context-recall')?.debug?.(message) } catch { /* never break recall */ } }
  const corpus = corpusServices(ctx)
  const embedQueue = new EmbedQueue({
    index: getFuzzy,
    getEmbedder: () => {
      const embedder = getConfig().semantic ? getEmbedder() : null
      if (embedder) lastEmbedder = embedder
      return embedder
    },
    getConfig,
    log,
  })
  const sync = new IndexSync({
    index: getFuzzy, ...corpus, exclusive, log,
    onIndexed: () => embedQueue.kick(),
  })
  ctx.on('session/event', (session, event) => sync.observe(session, event))
  if (options.autoStart !== false) sync.start(options.schedule)
  const servicesNow = () => {
    const config = getConfig()
    const embedder = config.semantic ? getEmbedder() : null
    if (embedder) lastEmbedder = embedder
    const index = getFuzzy()
    if (index && embedder?.fingerprint) index.setVectorSpace(embedder.fingerprint)
    return {
      fuzzy: index, sync, embedder, config,
      semanticEnabled: config.semantic,
      semanticBudget: config.warmup === 'gentle' ? 16 : 48,
    }
  }
  ctx.effect(() => () => {
    disposed = true
    sync.dispose()
    anchors.clear()
    // Abort online IO before waiting for our queues. Cordis runs root cleanup
    // effects in reverse order, so the embedding owner's disposer may run later.
    const stopped = lastEmbedder?.dispose?.()
    // No sqlite handle is closed while an active network/index operation owns it.
    return Promise.allSettled([exclusive(() => {}), embedQueue.dispose(), stopped]).finally(() => { fuzzy?.close(); fuzzy = null })
  })
  const handles = { sync, embedQueue, index: getFuzzy }

  // One global provider selects its anchor by the assembly's current agent.
  // Registration belongs to this plugin fiber, so hot reload removes it cleanly.
  ctx.systemPrompt.context({
    name: 'context-recall-anchor', order: 500, interpolate: false,
    text: context => {
      if (!getConfig().anchor) return ''
      const sessionId = context?.agent?.session?.id
      const entry = sessionId ? anchors.get(sessionId) : null
      if (!entry || entry.rounds <= 0) return ''
      entry.rounds -= 1
      return entry.text
    },
  })
  ctx.on('session/disposed', session => { if (session) anchors.delete(session.id) })
  ctx.on('session/event', (session, event) => {
    if (disposed || !getConfig().anchor || event?.type !== 'compaction/summary' || !session?.id) return
    const sessionId = session.id
    const entry = { text: '', rounds: 0 }
    anchors.set(sessionId, entry)
    buildAnchorText(ctx.sessionQuery, sessionId, event).then(text => {
      if (!disposed && anchors.get(sessionId) === entry) {
        entry.text = text
        entry.rounds = getConfig().anchorRounds ?? 3
      }
    }).catch(() => {})
  })

  ctx.tools.register(defineRecallTool({ ctx, getConfig, servicesNow, isDisposed: () => disposed }))
  return handles
}
