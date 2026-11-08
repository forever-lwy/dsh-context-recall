// Derived from dsh-recall, Copyright (c) 2026 dsh-extension-hub contributors.
// MIT licensed; see THIRD_PARTY.md and LICENSE.
// Session index: one self-built SQLite database (node:sqlite, zero npm
// dependencies) that serves title search, fuzzy full-text search and semantic
// recall over every DSH session.
//
// Why not the official @deepseek-ai/dsh-session-query-sqlite index: it uses the
// unicode61 tokenizer and matches the whole query as one quoted phrase, so it
// only finds exact literal strings (2-char Chinese phrases fail outright and
// "remembered roughly" queries miss). This index keeps a trigram FTS table plus
// a char-bigram containment rerank to cover partial and paraphrased recall.
//
// Text extraction indexes what people actually said: user messages whose
// source is the user (or that predate message sources) and assistant text
// blocks. Host-injected user messages (runtime context, time context, skill
// catalogs, memory snapshots) and tool-call blocks are noise for recall; they
// used to dominate both the fuzzy corpus and the embedded vectors.
//
// The index is fed incrementally (see index-sync.js): live events append
// documents directly, and a rare reconcile reads only sessions whose persisted
// revision changed. Nothing here reads log files or decodes zstd itself.
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** Application id protecting unrelated databases from accidental resets. */
const APPLICATION_ID = 0x4352434c // 'CRCL' — independent of upstream recall.
// v2: titles, session metadata, user-authored text only (injected host
// messages dropped). The text set changed, so v1 documents and vectors are
// rebuilt from the session logs on the first reconcile.
const SCHEMA_VERSION = 2

/** Default index location: <dsh home>/storages/context-recall-index.db */
export function defaultIndexPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'context-recall-index.db')
}

/** Test hook: CONTEXT_RECALL_INDEX_PATH=:memory: keeps tests off the real index. */
export function recallIndexPath() {
  return process.env.CONTEXT_RECALL_INDEX_PATH || defaultIndexPath()
}

/** Keep only letters and numbers (drops whitespace and punctuation). */
export function stripText(text) {
  return String(text || '').replace(/[^\p{L}\p{N}]/gu, '')
}

function codePoints(text) {
  return Array.from(text)
}

function ngrams(chars, n) {
  const out = []
  for (let i = 0; i + n <= chars.length; i += 1) out.push(chars.slice(i, i + n).join(''))
  return out
}

/** Event types that can change what the index holds. */
export const INDEXED_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'session/title'])

/**
 * Whether a user/message was written by the person. Messages without a source
 * predate message sources and are treated as user-authored.
 */
function isUserAuthored(data) {
  const kind = data && data.source && typeof data.source === 'object' ? data.source.kind : undefined
  return kind === undefined || kind === 'user'
}

/**
 * Extract searchable conversational text from one event: user-authored
 * messages and assistant text blocks only. Every other event, injected host
 * message and tool block contributes no text.
 */
export function extractEventText(event) {
  if (!event || typeof event !== 'object') return ''
  switch (event.type) {
    case 'user/message':
      return isUserAuthored(event.data) ? contentText(event.data && event.data.content) : ''
    case 'assistant/message':
      return event.data && event.data.message ? contentText(event.data.message.content) : ''
    default:
      return ''
  }
}

function contentText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content.map(blockText).filter(Boolean).join('\n')
}

function blockText(block) {
  if (!block || typeof block !== 'object') return ''
  // Tool-call / tool-result blocks are operational noise (JSON arguments).
  return block.type === 'text' && typeof block.text === 'string' ? block.text.trim() : ''
}

/** Build search documents for events in ascending seq order. */
export function buildSearchDocs(sessionId, events) {
  const docs = []
  for (const event of events || []) {
    const text = extractEventText(event)
    if (!text) continue
    docs.push({ sessionId, seq: event.seq, type: event.type, time: event.time ?? null, text })
  }
  return docs
}

/** Latest `session/title` event among `events`, or null. */
export function latestTitle(events) {
  let found = null
  for (const event of events || []) {
    if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      if (!found || event.seq > found.seq) found = { title: event.data.title.trim(), seq: event.seq }
    }
  }
  return found
}

function lastSeq(events) {
  let max = -1
  for (const event of events || []) if (Number.isFinite(event?.seq) && event.seq > max) max = event.seq
  return max
}

function lastTime(events) {
  let max = null
  for (const event of events || []) if (Number.isFinite(event?.time) && (max === null || event.time > max)) max = event.time
  return max
}

/** Decode a stored float32 BLOB, copying only when SQLite returned an unaligned view. */
function decodeVector(bytes, dim) {
  if (bytes.byteOffset % 4 === 0) return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
  const copy = Uint8Array.from(bytes)
  const vector = new Float32Array(copy.buffer)
  if (vector.length !== dim) throw new Error('Stored vector dimension mismatch')
  return vector
}

/** Character-ngram containment score of `text` against a prepared query. */
function containmentScore(text, prepared) {
  const { q, chars, qBigrams, qTrigrams } = prepared
  const normChars = codePoints(stripText(text).slice(0, 1000))
  if (!qBigrams) return normChars.join('').includes(chars[0]) ? 0.8 : 0
  const dBigrams = new Set(ngrams(normChars, 2))
  let hit = 0
  for (const b of qBigrams) if (dBigrams.has(b)) hit += 1
  let tri = 0
  if (qTrigrams) {
    const dTrigrams = new Set(ngrams(normChars, 3))
    for (const t of qTrigrams) if (dTrigrams.has(t)) tri += 1
    tri /= qTrigrams.size
  }
  let score = 0.7 * (hit / qBigrams.size) + 0.3 * tri
  if (normChars.join('').includes(q)) score = Math.max(score, 0.9)
  return score
}

function prepareQuery(query) {
  const q = stripText(String(query || '').trim())
  const chars = codePoints(q)
  return {
    q, chars,
    qBigrams: chars.length >= 2 ? new Set(ngrams(chars, 2)) : null,
    qTrigrams: chars.length >= 3 ? new Set(ngrams(chars, 3)) : null,
  }
}

/**
 * Self-built index over session titles and conversation text.
 * - `sessions`: one row per session (metadata, title, revision watermark).
 * - `titles`: FTS5 trigram table over normalized titles.
 * - `doc_texts`: original text per indexed event; `docs`: FTS5 trigram table
 *   over the normalized text (same rowid).
 * - `vectors`: float32 embeddings keyed by doc rowid.
 */
export class FuzzyIndex {
  constructor(path = recallIndexPath()) {
    this.path = path === ':memory:' ? ':memory:' : resolve(path)
    this.db = null
    this.dim = 0
    this.vectorSpace = null
  }

  open() {
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true })
    const db = new DatabaseSync(this.path)
    const { application_id: appId } = db.prepare('PRAGMA application_id').get()
    if (appId !== 0 && appId !== APPLICATION_ID) {
      db.close()
      throw new Error(`recall index at "${this.path}" belongs to another application`)
    }
    const { user_version: version } = db.prepare('PRAGMA user_version').get()
    if (version !== SCHEMA_VERSION) {
      for (const table of ['sessions', 'titles', 'doc_texts', 'docs', 'vectors', 'vector_meta']) db.exec(`DROP TABLE IF EXISTS ${table}`)
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    }
    if (this.path !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA busy_timeout = 5000')
    }
    db.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        cwd        TEXT,
        created_at INTEGER,
        updated_at INTEGER,
        title      TEXT,
        title_seq  INTEGER NOT NULL DEFAULT -1,
        parent     TEXT,
        origin     TEXT,
        archived   INTEGER NOT NULL DEFAULT 0,
        revision   TEXT,
        max_seq    INTEGER NOT NULL DEFAULT -1
      ) STRICT
    `)
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS titles USING fts5(
        norm,
        session_id UNINDEXED,
        tokenize = 'trigram'
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS doc_texts (
        rowid      INTEGER PRIMARY KEY,
        session_id TEXT NOT NULL,
        seq        INTEGER NOT NULL,
        type       TEXT NOT NULL,
        time       INTEGER,
        text       TEXT NOT NULL
      ) STRICT
    `)
    db.exec('CREATE INDEX IF NOT EXISTS doc_texts_session ON doc_texts(session_id, seq)')
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
        norm,
        session_id UNINDEXED,
        seq UNINDEXED,
        type UNINDEXED,
        time UNINDEXED,
        tokenize = 'trigram'
      )
    `)
    db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        doc_rowid INTEGER PRIMARY KEY,
        vec       BLOB NOT NULL
      ) STRICT
    `)
    db.exec('CREATE TABLE IF NOT EXISTS vector_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
    this.db = db
    this.vectorSpace = db.prepare("SELECT value FROM vector_meta WHERE key = 'space'").get()?.value ?? null
    this.dim = Number(db.prepare("SELECT value FROM vector_meta WHERE key = 'dim'").get()?.value ?? 0)
    return this
  }

  close() {
    if (this.db) {
      try {
        this.db.close()
      } catch {
        // already closed
      }
      this.db = null
    }
  }

  requireDb() {
    if (!this.db) throw new Error('recall index is not open')
    return this.db
  }

  /** Run `fn` inside one immediate transaction. */
  transaction(fn) {
    const db = this.requireDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // no transaction to roll back
      }
      throw error
    }
  }

  /** Model/endpoint/query-prefix changes invalidate only derived vectors. */
  setVectorSpace(fingerprint) {
    if (typeof fingerprint !== 'string' || !fingerprint) throw new Error('Embedding vector space is required')
    if (this.vectorSpace === fingerprint) return
    this.transaction(db => {
      db.exec('DELETE FROM vectors')
      db.exec('DELETE FROM vector_meta')
      db.prepare('INSERT INTO vector_meta (key, value) VALUES (?, ?)').run('space', fingerprint)
    })
    this.vectorSpace = fingerprint
    this.dim = 0
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** Watermark rows for every indexed session: { id, revision, max_seq }. */
  sessionStates() {
    return this.requireDb().prepare('SELECT id, revision, max_seq FROM sessions').all()
  }

  /** One session's watermark row, or undefined. */
  sessionState(id) {
    return this.requireDb().prepare('SELECT id, revision, max_seq, title_seq FROM sessions WHERE id = ?').get(id)
  }

  /**
   * Append the events newer than the stored watermark (append-only logs).
   * Creates the session row when missing, folds the latest title and refreshes
   * metadata. Returns the number of new documents.
   */
  appendEvents(header, events, { revision } = {}) {
    if (!header || typeof header.id !== 'string') throw new Error('session header is required')
    return this.transaction(db => this.#append(db, header, events, revision))
  }

  /**
   * Drop one session's documents and index its complete log again. Used when a
   * log no longer extends the stored watermark (rewritten or truncated).
   */
  replaceSession(header, events, { revision } = {}) {
    if (!header || typeof header.id !== 'string') throw new Error('session header is required')
    return this.transaction(db => {
      this.#deleteSession(db, header.id)
      return this.#append(db, header, events, revision)
    })
  }

  /** Record a persisted revision for an already-current session. */
  setRevision(id, revision) {
    this.requireDb().prepare('UPDATE sessions SET revision = ? WHERE id = ?').run(revision ?? null, id)
  }

  /** Remove every row of one session. */
  removeSession(id) {
    this.transaction(db => this.#deleteSession(db, id))
  }

  /** Flag sessions archived (ids in `archivedIds`) or active (all others). */
  setArchived(archivedIds) {
    const ids = new Set(archivedIds)
    this.transaction(db => {
      const update = db.prepare('UPDATE sessions SET archived = ? WHERE id = ?')
      for (const row of db.prepare('SELECT id, archived FROM sessions').all()) {
        const flag = ids.has(row.id) ? 1 : 0
        if (row.archived !== flag) update.run(flag, row.id)
      }
    })
  }

  #append(db, header, events, revision) {
    const id = header.id
    const row = db.prepare('SELECT max_seq, title_seq, created_at, updated_at FROM sessions WHERE id = ?').get(id)
    const fromSeq = row ? row.max_seq : -1
    const insertData = db.prepare('INSERT INTO doc_texts (session_id, seq, type, time, text) VALUES (?, ?, ?, ?, ?)')
    const insertDoc = db.prepare('INSERT INTO docs (rowid, norm, session_id, seq, type, time) VALUES (?, ?, ?, ?, ?, ?)')
    let inserted = 0
    for (const d of buildSearchDocs(id, events)) {
      if (d.seq <= fromSeq) continue
      const norm = stripText(d.text)
      if (!norm) continue
      const info = insertData.run(d.sessionId, d.seq, d.type, d.time, d.text)
      insertDoc.run(info.lastInsertRowid, norm, d.sessionId, d.seq, d.type, d.time)
      inserted += 1
    }
    const maxSeq = Math.max(fromSeq, lastSeq(events))
    const updatedAt = Math.max(row?.updated_at ?? 0, lastTime(events) ?? 0, header.createdAt ?? 0) || null
    db.prepare(`
      INSERT INTO sessions (id, cwd, created_at, updated_at, parent, origin, revision, max_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        cwd = COALESCE(excluded.cwd, sessions.cwd),
        created_at = COALESCE(excluded.created_at, sessions.created_at),
        updated_at = excluded.updated_at,
        parent = COALESCE(excluded.parent, sessions.parent),
        origin = COALESCE(excluded.origin, sessions.origin),
        revision = CASE WHEN ? THEN excluded.revision ELSE sessions.revision END,
        max_seq = excluded.max_seq
    `).run(id, header.cwd ?? null, header.createdAt ?? null, updatedAt, header.parentSession ?? null,
      header.origin ?? null, revision ?? null, maxSeq, revision === undefined ? 0 : 1)
    const title = latestTitle(events)
    if (title && title.seq > (row ? row.title_seq : -1)) this.#writeTitle(db, id, title.title, title.seq)
    return inserted
  }

  /** Set a session title known from outside the event stream (backfill). */
  setTitle(id, title, seq = -1) {
    this.transaction(db => {
      const row = db.prepare('SELECT title_seq FROM sessions WHERE id = ?').get(id)
      if (!row || (seq >= 0 && seq <= row.title_seq)) return
      this.#writeTitle(db, id, String(title || '').trim(), seq)
    })
  }

  #writeTitle(db, id, title, seq) {
    db.prepare('UPDATE sessions SET title = ?, title_seq = ? WHERE id = ?').run(title || null, seq, id)
    db.prepare('DELETE FROM titles WHERE session_id = ?').run(id)
    const norm = stripText(title)
    if (norm) db.prepare('INSERT INTO titles (norm, session_id) VALUES (?, ?)').run(norm, id)
  }

  #deleteSession(db, id) {
    db.prepare('DELETE FROM vectors WHERE doc_rowid IN (SELECT rowid FROM doc_texts WHERE session_id = ?)').run(id)
    db.prepare('DELETE FROM docs WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM doc_texts WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM titles WHERE session_id = ?').run(id)
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  /**
   * Incremental reconcile against the persisted corpus: only sessions whose
   * revision changed are read. services: { snapshots(): Promise<[{header,
   * revision}]>, inspect(id): Promise<{session?, events}>, keep?(id): boolean,
   * yield?(): Promise }. `keep` protects live sessions that are not persisted
   * yet from deletion.
   */
  async reconcile(services) {
    this.requireDb()
    const snaps = (await (services.snapshots ? services.snapshots() : [])) || []
    const rows = new Map(this.sessionStates().map(row => [row.id, row]))
    const seen = new Set()
    let reindexed = 0
    for (const snap of snaps) {
      const id = snap?.header?.id
      if (typeof id !== 'string') continue
      seen.add(id)
      const row = rows.get(id)
      if (row && row.revision !== null && row.revision === snap.revision) continue
      const log = await services.inspect(id)
      const events = log && Array.isArray(log.events) ? log.events : []
      const header = { ...snap.header, ...(log && log.session ? log.session : {}) }
      if (row && lastSeq(events) < row.max_seq) this.replaceSession(header, events, { revision: snap.revision })
      else this.appendEvents(header, events, { revision: snap.revision })
      reindexed += 1
      if (services.yield) await services.yield()
    }
    let removed = 0
    for (const id of rows.keys()) {
      if (seen.has(id) || (services.keep && services.keep(id))) continue
      this.removeSession(id)
      removed += 1
    }
    return { reindexed, removed }
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * Fuzzy recall: trigram FTS pass + char-bigram LIKE pass, then a
   * containment rerank. Returns hits sorted by score desc, each with
   * { rowid, session_id, cwd, created_at, seq, type, time, text, score }.
   */
  search({ query, limit = 20, sessionId, cwd, minScore = 0.15, includeArchived = true }) {
    const db = this.requireDb()
    const prepared = prepareQuery(query)
    const { chars } = prepared
    if (chars.length === 0) return []
    const cap = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 100)
    const scope = scopeSql({ sessionId, cwd, includeArchived })

    const candidates = new Map() // rowid -> hit (first occurrence wins)
    const add = (row) => {
      if (!candidates.has(row.rowid)) candidates.set(row.rowid, row)
    }
    const select = 'SELECT t.rowid AS rowid, t.session_id, t.seq, t.type, t.time, t.text, s.cwd AS cwd, s.created_at AS created_at'

    if (chars.length >= 3) {
      const expr = [...new Set(ngrams(chars, 3))].map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ')
      for (const row of db.prepare(`
        ${select}
        FROM docs JOIN doc_texts t ON t.rowid = docs.rowid
        JOIN sessions s ON s.id = t.session_id
        WHERE docs MATCH ?${scope.sql} LIMIT 800
      `).all(expr, ...scope.params)) add(row)
    }

    if (chars.length >= 2) {
      const bigrams = [...prepared.qBigrams]
      const likes = bigrams.map(() => 't.text LIKE ?').join(' OR ')
      const hitsSql = bigrams.map(() => '(CASE WHEN t.text LIKE ? THEN 1 ELSE 0 END)').join(' + ')
      const patterns = bigrams.map((b) => `%${b}%`)
      for (const row of db.prepare(`
        ${select}, (${hitsSql}) AS like_hits
        FROM doc_texts t JOIN sessions s ON s.id = t.session_id
        WHERE (${likes})${scope.sql}
        ORDER BY like_hits DESC, t.rowid ASC
        LIMIT 1500
      `).all(...patterns, ...patterns, ...scope.params)) add(row)
    } else {
      for (const row of db.prepare(`
        ${select}
        FROM doc_texts t JOIN sessions s ON s.id = t.session_id
        WHERE t.text LIKE ?${scope.sql} LIMIT 1500
      `).all(`%${chars[0]}%`, ...scope.params)) add(row)
    }

    const results = []
    for (const c of candidates.values()) {
      const score = containmentScore(c.text, prepared)
      if (score >= minScore) results.push({ ...c, score, like_hits: undefined })
    }
    results.sort((a, b) => b.score - a.score)
    return results.slice(0, cap).map(({ like_hits: _ignored, ...hit }) => hit)
  }

  /**
   * Title search over session titles. Returns sessions sorted by score with
   * { session_id, title, cwd, created_at, updated_at, archived, score }.
   */
  searchTitles({ query, limit = 20, cwd, includeArchived = true, minScore = 0.3 }) {
    const db = this.requireDb()
    const prepared = prepareQuery(query)
    const { chars } = prepared
    if (chars.length === 0) return []
    const cap = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 200)
    const scope = scopeSql({ cwd, includeArchived })
    const select = 'SELECT s.id AS session_id, s.title, s.cwd, s.created_at, s.updated_at, s.archived'
    const rows = chars.length >= 3
      ? db.prepare(`
          ${select} FROM titles JOIN sessions s ON s.id = titles.session_id
          WHERE titles MATCH ?${scope.sql} LIMIT 500
        `).all([...new Set(ngrams(chars, 3))].map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR '), ...scope.params)
      : db.prepare(`
          ${select} FROM sessions s WHERE s.title LIKE ?${scope.sql} LIMIT 500
        `).all(`%${chars.join('')}%`, ...scope.params)
    const results = []
    for (const row of rows) {
      const score = containmentScore(row.title || '', prepared)
      if (score >= minScore) results.push({ ...row, score })
    }
    results.sort((a, b) => b.score - a.score || (b.updated_at ?? 0) - (a.updated_at ?? 0))
    return results.slice(0, cap)
  }

  /** Metadata rows for `ids`: Map(id -> { title, cwd, created_at, updated_at, archived }). */
  sessionsMeta(ids) {
    const db = this.requireDb()
    const stmt = db.prepare('SELECT id, title, cwd, created_at, updated_at, archived, origin FROM sessions WHERE id = ?')
    const out = new Map()
    for (const id of new Set(ids)) {
      const row = stmt.get(id)
      if (row) out.set(id, row)
    }
    return out
  }

  /** Sessions missing a title (for one-time backfill). */
  untitledSessions(limit = 500) {
    return this.requireDb().prepare('SELECT id FROM sessions WHERE title IS NULL LIMIT ?').all(limit).map(row => row.id)
  }

  /**
   * Page through one session's indexed text blocks in seq order.
   * Returns { rows: [{seq, type, time, text}], nextFromSeq } — nextFromSeq is
   * the first seq of the following page, or null when the page ended the log.
   */
  browse(sessionId, fromSeq = 0, pageSize = 20) {
    const db = this.requireDb()
    const start = Math.max(0, Number.isFinite(fromSeq) ? Math.floor(fromSeq) : 0)
    const size = Math.min(Math.max(Number.isFinite(pageSize) ? pageSize : 20, 1), 100)
    const rows = db
      .prepare('SELECT seq, type, time, text FROM doc_texts WHERE session_id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?')
      .all(sessionId, start, size)
    const nextFromSeq = rows.length === size ? rows[rows.length - 1].seq + 1 : null
    return { rows, nextFromSeq }
  }

  /** Documents not yet embedded (semantic warm-up): oldest first. */
  pendingVectors(limit = 50) {
    return this.requireDb().prepare(`
      SELECT d.rowid AS rowid, d.text AS text
      FROM doc_texts d
      WHERE NOT EXISTS (SELECT 1 FROM vectors v WHERE v.doc_rowid = d.rowid)
      ORDER BY d.rowid ASC
      LIMIT ?
    `).all(limit)
  }

  /** Store embedded vectors (Float32Array each) keyed by doc rowid. */
  storeVectors(rows) {
    if (!rows || rows.length === 0) return
    const dim = this.dim || rows[0]?.vec?.length
    if (!Number.isSafeInteger(dim) || dim < 1 || dim > 65536) throw new Error('Invalid embedding dimensions')
    for (const { rowid, vec } of rows) {
      if (!Number.isSafeInteger(rowid) || !(vec instanceof Float32Array) || vec.length !== dim
          || !vec.every(Number.isFinite)) throw new Error('Invalid embedding vector')
    }
    this.transaction(db => {
      const exists = db.prepare('SELECT 1 FROM doc_texts WHERE rowid = ?')
      const insert = db.prepare('INSERT OR REPLACE INTO vectors (doc_rowid, vec) VALUES (?, ?)')
      for (const { rowid, vec } of rows) {
        // A corpus refresh may have removed a pending document during network IO.
        if (!exists.get(rowid)) continue
        insert.run(rowid, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength))
      }
      db.prepare('INSERT OR REPLACE INTO vector_meta (key, value) VALUES (?, ?)').run('dim', String(dim))
    })
    this.dim = dim
  }

  /** Fraction of documents with vectors (0..1). */
  vectorCoverage() {
    const db = this.requireDb()
    const docs = db.prepare('SELECT COUNT(*) AS n FROM doc_texts').get().n
    if (docs === 0) return 1
    const vecs = db.prepare('SELECT COUNT(*) AS n FROM vectors v JOIN doc_texts d ON d.rowid = v.doc_rowid').get().n
    return Math.min(1, vecs / docs)
  }

  /**
   * Semantic (cosine) search over embedded docs. `qVec` must be normalized.
   * Vectors are streamed from SQLite inside the requested scope and only the
   * best `limit` survive, so memory stays bounded however large the corpus.
   */
  semanticSearch(qVec, limit = 20, { sessionId, cwd, minScore = 0.5, includeArchived = true } = {}) {
    if (!qVec || qVec.length !== this.dim) return []
    const db = this.requireDb()
    const cap = Math.min(Math.max(Number.isFinite(limit) ? limit : 20, 1), 300)
    const scope = scopeSql({ sessionId, cwd, includeArchived })
    const top = [] // ascending by score; top[0] is the weakest kept hit
    const dim = this.dim
    for (const row of db.prepare(`
      SELECT v.doc_rowid AS rowid, v.vec AS vec
      FROM vectors v JOIN doc_texts t ON t.rowid = v.doc_rowid
      JOIN sessions s ON s.id = t.session_id
      WHERE 1 = 1${scope.sql}
    `).iterate(...scope.params)) {
      const vec = decodeVector(row.vec, dim)
      if (vec.length !== dim) continue
      let s = 0
      for (let d = 0; d < dim; d += 1) s += vec[d] * qVec[d]
      if (s < minScore || (top.length >= cap && s <= top[0][1])) continue
      let at = top.findIndex(([, score]) => score > s)
      if (at < 0) at = top.length
      top.splice(at, 0, [row.rowid, s])
      if (top.length > cap) top.shift()
    }
    const lookup = db.prepare(`
      SELECT t.rowid AS rowid, t.session_id, t.seq, t.type, t.time, t.text, s.cwd AS cwd, s.created_at AS created_at
      FROM doc_texts t JOIN sessions s ON s.id = t.session_id WHERE t.rowid = ?
    `)
    const hits = []
    for (let i = top.length - 1; i >= 0; i -= 1) {
      const row = lookup.get(top[i][0])
      if (row) hits.push({ ...row, score: top[i][1] })
    }
    return hits
  }

  /** Index size (tests / diagnostics). */
  stats() {
    const db = this.requireDb()
    return {
      sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,
      docs: db.prepare('SELECT COUNT(*) AS n FROM doc_texts').get().n,
      vectors: db.prepare('SELECT COUNT(*) AS n FROM vectors').get().n,
    }
  }
}

/** SQL fragment restricting `s` (sessions) to a scope; appended after WHERE. */
function scopeSql({ sessionId, cwd, includeArchived = true }) {
  let sql = ''
  const params = []
  if (sessionId) {
    sql += ' AND s.id = ?'
    params.push(sessionId)
  } else if (cwd) {
    sql += ' AND s.cwd = ?'
    params.push(cwd)
  }
  if (!includeArchived) sql += ' AND s.archived = 0'
  return { sql, params }
}
