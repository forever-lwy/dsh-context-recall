import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { SearchRequest, SearchResult, ReadRequest, ReadResult, StatusResult } from '../remote.js'

export type SearchMode = 'auto' | 'keyword' | 'title' | 'semantic'
export interface SearchFace {
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult>
  read(request: ReadRequest, signal: AbortSignal): Promise<ReadResult>
  status(signal: AbortSignal): Promise<StatusResult>
  /** Open a session in the conversation view (optionally aiming at a seq). */
  open(sessionId: string, seq?: number): void
  t: (key: string, params?: Record<string, unknown>) => string
}

const MODES: SearchMode[] = ['auto', 'keyword', 'title', 'semantic']
const DEBOUNCE_MS = 300
const PREVIEW_STEP = 6

/** Terms to highlight: the whole query plus its whitespace-separated words. */
export function highlightTerms(query: string): string[] {
  const whole = query.trim()
  if (!whole) return []
  const words = whole.split(/\s+/).filter(word => Array.from(word).length >= 2)
  return [...new Set([whole, ...words])].sort((a, b) => b.length - a.length)
}

/** Wrap occurrences of `terms` (case-insensitive) in <mark>. */
export function highlight(text: string, terms: string[]): ReactNode[] {
  if (terms.length === 0 || !text) return [text]
  const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  return text.split(pattern).map((part, i) => i % 2 === 1 ? <mark key={i}>{part}</mark> : part)
}

function when(time: number | undefined, t: SearchFace['t']): string {
  if (!time) return ''
  const date = new Date(time)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' })
    || t('unknownTime')
}

function shortPath(cwd: string | undefined): string {
  if (!cwd) return ''
  const parts = cwd.split(/[\\/]/).filter(Boolean)
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join('/')}`
}

interface Selection { sessionId: string; seq?: number }

/** Translate and interpolate {name} placeholders, whether or not the host does. */
function translator(t: SearchFace['t']) {
  return (key: string, params?: Record<string, unknown>) =>
    String(t(key, params)).replace(/\{(\w+)\}/g, (match, name) => params && name in params ? String(params[name]) : match)
}

export function SearchPage(props: SearchFace) {
  const tr = translator(props.t)
  const t = tr
  const tRef = useRef(tr)
  tRef.current = tr
  const face = useRef(props)
  face.current = props
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('auto')
  const [cwd, setCwd] = useState('')
  const [includeArchived, setIncludeArchived] = useState(true)
  const [result, setResult] = useState<SearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<StatusResult | null>(null)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [preview, setPreview] = useState<ReadResult | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [range, setRange] = useState({ before: PREVIEW_STEP, after: PREVIEW_STEP })
  const input = useRef<HTMLInputElement>(null)
  const terms = useMemo(() => highlightTerms(result?.query ?? ''), [result?.query])

  useEffect(() => { input.current?.focus() }, [])

  useEffect(() => {
    const controller = new AbortController()
    face.current.status(controller.signal).then(value => { if (!controller.signal.aborted) setStatus(value) }).catch(() => {})
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const text = query.trim()
    if (!text) { setResult(null); setError(''); setBusy(false); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setBusy(true); setError('')
      face.current.search({ query: text, mode, includeArchived, ...(cwd ? { cwd } : {}) }, controller.signal)
        .then(value => { if (!controller.signal.aborted) { setResult(value); setBusy(false) } })
        .catch(reason => {
          if (controller.signal.aborted) return
          setBusy(false); setError(reason instanceof Error ? reason.message : tRef.current('failed'))
        })
    }, DEBOUNCE_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, mode, cwd, includeArchived])

  useEffect(() => {
    if (!selection) { setPreview(null); return }
    const controller = new AbortController()
    setPreviewError('')
    const request: ReadRequest = selection.seq === undefined
      ? { sessionId: selection.sessionId, fromSeq: 0, pageSize: 30 }
      : { sessionId: selection.sessionId, seq: selection.seq, before: range.before, after: range.after }
    face.current.read(request, controller.signal)
      .then(value => {
        if (controller.signal.aborted) return
        if (!value.ok) { setPreviewError(value.error ?? tRef.current('failed')); setPreview(null) } else setPreview(value)
      })
      .catch(reason => { if (!controller.signal.aborted) setPreviewError(reason instanceof Error ? reason.message : tRef.current('failed')) })
    return () => controller.abort()
  }, [selection, range])

  const previewList = useRef<HTMLOListElement>(null)
  useEffect(() => {
    const el = previewList.current?.querySelector('li.target') as HTMLElement | null
    el?.scrollIntoView?.({ block: 'center' })
  }, [preview])
  const choose = (next: Selection) => { setRange({ before: PREVIEW_STEP, after: PREVIEW_STEP }); setSelection(next) }
  const semantic = result?.semantic ?? status?.semantic
  const coverage = semantic ? Math.round(semantic.coverage * 100) : 0

  return <section className="dcr-search" aria-label={t('searchTitle')}>
    <header className="dcr-search-head">
      <h2>{t('searchTitle')}</h2>
      {status && <span className="dcr-hint" data-role="status">{t('indexStatus', { sessions: status.sessions, docs: status.docs })}
        {status.semantic.enabled ? ` · ${t('vectorCoverage', { coverage })}` : ` · ${t('vectorOff')}`}</span>}
    </header>
    <div className="dcr-search-bar">
      <input ref={input} type="search" data-search="query" value={query} placeholder={t('searchPlaceholder')} aria-label={t('searchPlaceholder')}
        onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery('') }} />
      <div className="dcr-search-modes" role="tablist" aria-label={t('modeLabel')}>
        {MODES.map(value => <button key={value} type="button" role="tab" aria-selected={mode === value} data-mode={value}
          className={mode === value ? 'active' : ''} onClick={() => setMode(value)}>{tr(`mode${value[0].toUpperCase()}${value.slice(1)}`)}</button>)}
      </div>
      <div className="dcr-search-filters">
        <select data-search="cwd" value={cwd} aria-label={t('workspaceLabel')} onChange={event => setCwd(event.target.value)}>
          <option value="">{t('allWorkspaces')}</option>
          {(status?.workspaces ?? []).map(w => <option key={w.cwd} value={w.cwd} title={w.cwd}>{shortPath(w.cwd)} ({w.sessions})</option>)}
        </select>
        <label className="dcr-toggle"><input type="checkbox" data-search="archived" checked={includeArchived}
          onChange={event => setIncludeArchived(event.target.checked)} /><span>{t('includeArchived')}</span></label>
      </div>
    </div>
    {mode === 'semantic' && semantic && !semantic.ready && <p className="dcr-hint">{semantic.enabled ? t('semanticNotReady', { coverage }) : t('semanticOff')}</p>}
    {result?.notice && <p className="dcr-hint" role="status">{result.notice}</p>}
    {error && <p className="dcr-error" role="alert">{error}</p>}
    <div className={`dcr-search-body${selection ? ' with-preview' : ''}`}>
      <ol className="dcr-search-results" aria-busy={busy}>
        {busy && !result && <li className="dcr-hint">{t('searching')}</li>}
        {result && result.groups.length === 0 && !busy && <li className="dcr-hint" data-role="empty">{t('noResults')}</li>}
        {result?.groups.map(group => <li key={group.sessionId} className={`dcr-result${selection?.sessionId === group.sessionId ? ' selected' : ''}`}>
          <button type="button" className="dcr-result-head" data-session={group.sessionId}
            onClick={() => choose({ sessionId: group.sessionId, seq: group.hits[0]?.seq })}>
            <span className="dcr-result-title">{highlight(group.title || t('untitled'), terms)}</span>
            <span className="dcr-result-meta">
              {group.archived && <span className="dcr-badge">{t('archived')}</span>}
              {group.subagent && <span className="dcr-badge">{t('subagent')}</span>}
              {group.cwd && <span title={group.cwd}>{shortPath(group.cwd)}</span>}
              <span>{when(group.updatedAt, t)}</span>
              {group.hitCount > group.hits.length && <span>{t('moreHits', { count: group.hitCount })}</span>}
            </span>
          </button>
          {group.hits.length > 0 && <ul className="dcr-hits">
            {group.hits.map(hit => <li key={hit.seq}>
              <button type="button" data-hit={`${group.sessionId}:${hit.seq}`}
                className={selection?.sessionId === group.sessionId && selection.seq === hit.seq ? 'selected' : ''}
                onClick={() => choose({ sessionId: group.sessionId, seq: hit.seq })}>
                <span className="dcr-who">{t(hit.type === 'assistant/message' ? 'assistant' : 'you')}</span>
                {hit.source === 'semantic' && <span className="dcr-badge">{t('semanticHit')}</span>}
                <span className="dcr-snippet">{highlight(hit.snippet, terms)}</span>
              </button>
            </li>)}
          </ul>}
        </li>)}
      </ol>
      {selection && <aside className="dcr-preview" aria-label={t('preview')}>
        <div className="dcr-preview-head">
          <strong>{preview?.title || t('untitled')}</strong>
          <span className="dcr-preview-actions">
            <button type="button" data-action="open-session" onClick={() => face.current.open(selection.sessionId, selection.seq)}>{t('openSession')}</button>
            <button type="button" data-action="close-preview" aria-label={t('closePreview')} onClick={() => setSelection(null)}>×</button>
          </span>
        </div>
        {previewError && <p className="dcr-error" role="alert">{previewError}</p>}
        {preview?.hasBefore && selection.seq !== undefined && <button type="button" className="dcr-more" data-action="earlier"
          onClick={() => setRange(w => ({ ...w, before: w.before + PREVIEW_STEP * 2 }))}>{t('earlier')}</button>}
        <ol className="dcr-preview-items" ref={previewList}>
          {preview?.items?.map(item => <li key={item.seq} data-seq={item.seq} className={`${item.type === 'assistant/message' ? 'assistant' : 'user'}${item.seq === selection.seq ? ' target' : ''}`}>
            <span className="dcr-who">{t(item.type === 'assistant/message' ? 'assistant' : 'you')}{item.time ? ` · ${when(item.time, t)}` : ''}</span>
            <div className="dcr-preview-text">{highlight(item.text, terms)}</div>
          </li>)}
        </ol>
        {preview?.hasAfter && <button type="button" className="dcr-more" data-action="later"
          onClick={() => selection.seq === undefined
            ? setSelection({ sessionId: selection.sessionId, seq: preview.items?.at(-1)?.seq })
            : setRange(w => ({ ...w, after: w.after + PREVIEW_STEP * 2 }))}>{t('later')}</button>}
      </aside>}
    </div>
  </section>
}

/** Sidebar row icon: magnifier over a clock hand. */
export function SearchIcon({ size }: { size?: number }) {
  const edge = size ?? 16
  return <svg width={edge} height={edge} viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="7" cy="7" r="4.6" stroke="currentColor" strokeWidth="1.6" />
    <path d="M7 4.8V7l1.5 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
  </svg>
}
