// The single `recall` gateway tool: search and read past sessions.
//
// Progressive disclosure: the resident description only says when to use the
// tool and how access works. Results carry the exact follow-up call, so drill
// down instructions reach the model only when a search actually happened.
//
// Access to other sessions is enforced here, not only described: the user's
// settings choose off / when-asked / autonomous. "when-asked" requires the
// model to quote the user's own request, and the quote must appear in one of
// the user's recent messages in the current session.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { stripText } from './fuzzy-index.js'
import { runRecall, runTitleSearch, schemaValue } from './recall.js'

const RECENT_USER_MESSAGES = 3

const DESCRIPTION = [
  'Search and read the original text of past DSH conversations, including history hidden by context compaction.',
  'Use it whenever earlier details are missing from your context or the user refers to something from before.',
  'action=search finds matches (mode auto = keyword + semantic; title = session titles); action=read opens a session around a seq or page by page.',
  'Default scope is the current session. Other sessions follow the user\'s settings; when a result says the user\'s request is required, pass userRequest with the user\'s exact words from their message, or ask the user.',
  'Each result names the follow-up call to make. Fold recalled facts into your reply naturally without narrating the lookup.',
].join(' ')

const PARAMETERS = {
  action: { type: 'string', enum: ['search', 'read'], description: 'search (default) or read.' },
  query: { type: 'string', description: 'search: words to find (plain words; partial and approximate text works).' },
  mode: { type: 'string', enum: ['auto', 'keyword', 'title', 'semantic'], description: 'search mode; default auto.' },
  scope: { type: 'string', enum: ['session', 'workspace', 'all'], description: 'search scope; default session.' },
  sessionId: { type: 'string', description: 'read: the session to open. search: restrict to one session.' },
  seq: { type: 'integer', description: 'read: open the original text around this seq.' },
  fromSeq: { type: 'integer', description: 'read: page from this seq (default 0).' },
  limit: { type: 'integer', description: 'search: sessions to return; read: page size.' },
  workspace: { type: 'string', description: 'workspace scope: directory to search instead of the current one.' },
  userRequest: { type: 'string', description: 'The user\'s exact words asking to look at other sessions, when required.' },
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    error: { type: 'string' },
    query: { type: 'string' },
    mode: { type: 'string' },
    total: { type: 'integer' },
    next: { type: 'string' },
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sessionId: { type: 'string', required: true },
          title: { type: 'string' },
          cwd: { type: 'string' },
          createdAt: { type: 'integer' },
          updatedAt: { type: 'integer' },
          hitTime: { type: 'integer' },
          snippet: { type: 'string' },
          events: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                startSeq: { type: 'integer', required: true },
                endSeq: { type: 'integer', required: true },
                hitCount: { type: 'integer' },
                snippet: { type: 'string' },
              },
            },
          },
          nextFromSeq: { type: 'integer' },
          context: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                seq: { type: 'integer', required: true },
                type: { type: 'string', required: true },
                time: { type: 'integer' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },
}

/** The user's recent own messages in the current session, newest first. */
function recentUserTexts(index, sessionId, session) {
  const texts = []
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : null
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0 && texts.length < RECENT_USER_MESSAGES; i -= 1) {
        const event = events[i]
        if (event?.type !== 'user/message') continue
        const kind = event.data?.source?.kind
        if (kind !== undefined && kind !== 'user') continue
        const text = (event.data?.content ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
        if (text) texts.push(text)
      }
      if (texts.length > 0) return texts
    }
  } catch { /* fall back to the index */ }
  try {
    for (const row of index.requireDb().prepare(
      "SELECT text FROM doc_texts WHERE session_id = ? AND type = 'user/message' ORDER BY seq DESC LIMIT ?",
    ).all(sessionId, RECENT_USER_MESSAGES)) texts.push(row.text)
  } catch { /* no index: nothing to verify against */ }
  return texts
}

/** Whether `quote` is a real excerpt of one of the user's recent messages. */
export function quotesUser(quote, texts) {
  const needle = stripText(quote).toLowerCase()
  if (Array.from(needle).length < 2) return false
  return texts.some(text => stripText(text).toLowerCase().includes(needle))
}

/**
 * Decide whether this call may touch other sessions. Returns null when
 * allowed, or an error result explaining what the model must do instead.
 */
export function checkAccess({ args, current, config, index, session }) {
  const target = typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : null
  const otherTarget = target !== null && target !== current
  const action = args.action === 'read' ? 'read' : 'search'
  // Title search lists other sessions by nature, whatever scope it names.
  const crossScope = action === 'search' && (args.scope === 'workspace' || args.scope === 'all' || args.mode === 'title')
  let policy = null
  let label = ''
  if (action === 'read' && otherTarget) { policy = config.readOther ?? 'when-asked'; label = 'Reading another session' }
  else if (crossScope || otherTarget) { policy = config.crossSession ?? 'when-asked'; label = 'Searching other sessions' }
  if (policy === null || policy === 'autonomous' || policy === 'allowed') return null
  if (policy === 'off') {
    return { ok: false, error: `${label} is turned off in the user's recall settings. Tell the user if they need it; only they can change it.` }
  }
  if (typeof args.userRequest === 'string' && quotesUser(args.userRequest, recentUserTexts(index, current, session))) return null
  return {
    ok: false,
    error: `${label} needs the user's request. Pass userRequest with the user's exact words from their recent message asking for it; if they did not ask, search the current session instead or ask the user.`,
  }
}

/** Map gateway arguments onto the recall engine's call shape. */
export function toEngineArgs(args, config) {
  const query = typeof args.query === 'string' ? args.query : ''
  if (args.action === 'read') {
    const detail = { sessionId: args.sessionId }
    if (Number.isFinite(args.seq)) {
      detail.seq = args.seq
      detail.before = config.context ?? 3
      detail.after = config.context ?? 3
    } else {
      detail.browse = true
      detail.fromSeq = Number.isFinite(args.fromSeq) ? args.fromSeq : 0
      detail.pageSize = Number.isFinite(args.limit) ? args.limit : 20
    }
    return { query: query || '-', detail }
  }
  const out = { query, scope: args.scope, workspace: args.workspace, limit: args.limit }
  if (typeof args.sessionId === 'string' && args.sessionId) out.detail = { sessionId: args.sessionId }
  return out
}

/** One-line follow-up hint so drill-down usage arrives only with results. */
function nextHint(args, result) {
  if (!result.ok || !result.groups?.length) return undefined
  const first = result.groups[0]
  if (args.action === 'read') {
    if (first.nextFromSeq !== undefined) return `More: {"action":"read","sessionId":"${first.sessionId}","fromSeq":${first.nextFromSeq}}`
    return undefined
  }
  if (result.mode === 'title') return `Open one: {"action":"read","sessionId":"<id>"} or search inside it: {"query":"...","sessionId":"<id>"}`
  const event = first.events?.[0]
  if (first.context?.length) {
    return `Open a hit: {"action":"read","sessionId":"${first.sessionId}","seq":${first.context[0].seq}}`
  }
  if (event) return `Open: {"action":"read","sessionId":"${first.sessionId}","seq":${event.startSeq}}; whole episode: {"action":"read","sessionId":"${first.sessionId}","fromSeq":${event.startSeq}}`
  return `Search inside a session: {"query":"...","sessionId":"${first.sessionId}"}`
}

function render(_args, value) {
  if (!value || value.ok === false) return [{ type: 'text', text: `Recall failed: ${value && value.error ? value.error : 'unknown error'}` }]
  const lines = [`Recall${value.query ? ` "${value.query}"` : ''}: ${value.total} session(s).`]
  for (const g of value.groups || []) {
    const head = `- ${g.title ? `${g.title} ` : ''}(${g.sessionId}${g.cwd ? `, ${g.cwd}` : ''})`
    if (g.context && g.context.length > 0) {
      lines.push(head)
      for (const c of g.context) lines.push(`  [${c.seq} ${c.type}] ${String(c.text || '')}`)
      if (g.nextFromSeq !== undefined) lines.push(`  → next page from seq ${g.nextFromSeq}`)
    } else {
      lines.push(g.snippet ? `${head} — ${g.snippet}` : head)
      if (g.events && g.events.length > 1) {
        lines.push(`  ${g.events.length} episodes: ${g.events.map((e) => `[${e.startSeq}..${e.endSeq}]×${e.hitCount}`).join(', ')}`)
      }
    }
  }
  if (value.next) lines.push(value.next)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Build the tool definition.
 * @param {object} deps
 * @param {any} deps.ctx
 * @param {() => object} deps.getConfig
 * @param {() => object} deps.servicesNow
 * @param {() => boolean} deps.isDisposed
 */
export function defineRecallTool({ ctx, getConfig, servicesNow, isDisposed }) {
  return defineTool({
    name: 'recall',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render },
    async execute(rawArgs, exec) {
      exec?.signal?.throwIfAborted()
      if (isDisposed()) return { ok: false, error: 'Recall plugin disposed' }
      const sessionQuery = ctx.sessionQuery ?? ctx.get?.('sessionQuery')
      if (!sessionQuery) return { ok: false, error: 'sessionQuery service unavailable' }
      const args = { ...rawArgs, action: rawArgs?.action === 'read' ? 'read' : 'search' }
      if (args.action === 'read' && !(typeof args.sessionId === 'string' && args.sessionId)) {
        return { ok: false, error: 'read needs sessionId (from a search result, or the current session).' }
      }
      if (args.action === 'search' && !(typeof args.query === 'string' && args.query.trim())) {
        return { ok: false, error: 'search needs query.' }
      }
      const config = getConfig()
      const services = servicesNow()
      services.signal = exec?.signal
      if (services.sync) { try { await services.sync.flush() } catch { /* search degrades below */ } }
      const agentSession = exec?.agent?.session ?? null
      const denied = services.fuzzy
        ? checkAccess({ args, current: agentSession?.id ?? null, config, index: services.fuzzy, session: agentSession })
        : null
      if (denied) return denied
      const mode = ['keyword', 'title', 'semantic'].includes(args.mode) ? args.mode : 'auto'
      let result
      if (args.action === 'search' && mode === 'title') {
        result = runTitleSearch(services.fuzzy, args, exec, config)
      } else {
        if (mode === 'keyword') services.semanticEnabled = false
        if (mode === 'semantic') services.semanticOnly = true
        result = await runRecall(sessionQuery, toEngineArgs(args, config), exec, services)
      }
      exec?.signal?.throwIfAborted()
      result = { ...result, mode: args.action === 'read' ? undefined : mode }
      result.next = nextHint(args, result)
      return schemaValue(result)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Recall conversation history',
      kind: 'other',
      rawInput: args.query ?? args.sessionId,
    }),
  })
}
