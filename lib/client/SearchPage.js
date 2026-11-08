import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
const MODES = ['auto', 'keyword', 'title', 'semantic'];
const DEBOUNCE_MS = 300;
const PREVIEW_STEP = 6;
/** Terms to highlight: the whole query plus its whitespace-separated words. */
export function highlightTerms(query) {
    const whole = query.trim();
    if (!whole)
        return [];
    const words = whole.split(/\s+/).filter(word => Array.from(word).length >= 2);
    return [...new Set([whole, ...words])].sort((a, b) => b.length - a.length);
}
/** Wrap occurrences of `terms` (case-insensitive) in <mark>. */
export function highlight(text, terms) {
    if (terms.length === 0 || !text)
        return [text];
    const escaped = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
    return text.split(pattern).map((part, i) => i % 2 === 1 ? _jsx("mark", { children: part }, i) : part);
}
function when(time, t) {
    if (!time)
        return '';
    const date = new Date(time);
    const now = new Date();
    const sameDay = date.toDateString() === now.toDateString();
    return sameDay ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleDateString(undefined, { year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' })
            || t('unknownTime');
}
function shortPath(cwd) {
    if (!cwd)
        return '';
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join('/')}`;
}
/** Translate and interpolate {name} placeholders, whether or not the host does. */
function translator(t) {
    return (key, params) => String(t(key, params)).replace(/\{(\w+)\}/g, (match, name) => params && name in params ? String(params[name]) : match);
}
export function SearchPage(props) {
    const tr = translator(props.t);
    const t = tr;
    const tRef = useRef(tr);
    tRef.current = tr;
    const face = useRef(props);
    face.current = props;
    const [query, setQuery] = useState('');
    const [mode, setMode] = useState('auto');
    const [cwd, setCwd] = useState('');
    const [includeArchived, setIncludeArchived] = useState(true);
    const [result, setResult] = useState(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState(null);
    const [selection, setSelection] = useState(null);
    const [preview, setPreview] = useState(null);
    const [previewError, setPreviewError] = useState('');
    const [range, setRange] = useState({ before: PREVIEW_STEP, after: PREVIEW_STEP });
    const input = useRef(null);
    const terms = useMemo(() => highlightTerms(result?.query ?? ''), [result?.query]);
    useEffect(() => { input.current?.focus(); }, []);
    useEffect(() => {
        const controller = new AbortController();
        face.current.status(controller.signal).then(value => { if (!controller.signal.aborted)
            setStatus(value); }).catch(() => { });
        return () => controller.abort();
    }, []);
    useEffect(() => {
        const text = query.trim();
        if (!text) {
            setResult(null);
            setError('');
            setBusy(false);
            return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => {
            setBusy(true);
            setError('');
            face.current.search({ query: text, mode, includeArchived, ...(cwd ? { cwd } : {}) }, controller.signal)
                .then(value => { if (!controller.signal.aborted) {
                setResult(value);
                setBusy(false);
            } })
                .catch(reason => {
                if (controller.signal.aborted)
                    return;
                setBusy(false);
                setError(reason instanceof Error ? reason.message : tRef.current('failed'));
            });
        }, DEBOUNCE_MS);
        return () => { clearTimeout(timer); controller.abort(); };
    }, [query, mode, cwd, includeArchived]);
    useEffect(() => {
        if (!selection) {
            setPreview(null);
            return;
        }
        const controller = new AbortController();
        setPreviewError('');
        const request = selection.seq === undefined
            ? { sessionId: selection.sessionId, fromSeq: 0, pageSize: 30 }
            : { sessionId: selection.sessionId, seq: selection.seq, before: range.before, after: range.after };
        face.current.read(request, controller.signal)
            .then(value => {
            if (controller.signal.aborted)
                return;
            if (!value.ok) {
                setPreviewError(value.error ?? tRef.current('failed'));
                setPreview(null);
            }
            else
                setPreview(value);
        })
            .catch(reason => { if (!controller.signal.aborted)
            setPreviewError(reason instanceof Error ? reason.message : tRef.current('failed')); });
        return () => controller.abort();
    }, [selection, range]);
    const previewList = useRef(null);
    useEffect(() => {
        const el = previewList.current?.querySelector('li.target');
        el?.scrollIntoView?.({ block: 'center' });
    }, [preview]);
    const choose = (next) => { setRange({ before: PREVIEW_STEP, after: PREVIEW_STEP }); setSelection(next); };
    const semantic = result?.semantic ?? status?.semantic;
    const coverage = semantic ? Math.round(semantic.coverage * 100) : 0;
    return _jsxs("section", { className: "dcr-search", "aria-label": t('searchTitle'), children: [_jsxs("header", { className: "dcr-search-head", children: [_jsx("h2", { children: t('searchTitle') }), status && _jsxs("span", { className: "dcr-hint", "data-role": "status", children: [t('indexStatus', { sessions: status.sessions, docs: status.docs }), status.semantic.enabled ? ` · ${t('vectorCoverage', { coverage })}` : ` · ${t('vectorOff')}`] })] }), _jsxs("div", { className: "dcr-search-bar", children: [_jsx("input", { ref: input, type: "search", "data-search": "query", value: query, placeholder: t('searchPlaceholder'), "aria-label": t('searchPlaceholder'), onChange: event => setQuery(event.target.value), onKeyDown: event => { if (event.key === 'Escape')
                            setQuery(''); } }), _jsx("div", { className: "dcr-search-modes", role: "tablist", "aria-label": t('modeLabel'), children: MODES.map(value => _jsx("button", { type: "button", role: "tab", "aria-selected": mode === value, "data-mode": value, className: mode === value ? 'active' : '', onClick: () => setMode(value), children: tr(`mode${value[0].toUpperCase()}${value.slice(1)}`) }, value)) }), _jsxs("div", { className: "dcr-search-filters", children: [_jsxs("select", { "data-search": "cwd", value: cwd, "aria-label": t('workspaceLabel'), onChange: event => setCwd(event.target.value), children: [_jsx("option", { value: "", children: t('allWorkspaces') }), (status?.workspaces ?? []).map(w => _jsxs("option", { value: w.cwd, title: w.cwd, children: [shortPath(w.cwd), " (", w.sessions, ")"] }, w.cwd))] }), _jsxs("label", { className: "dcr-toggle", children: [_jsx("input", { type: "checkbox", "data-search": "archived", checked: includeArchived, onChange: event => setIncludeArchived(event.target.checked) }), _jsx("span", { children: t('includeArchived') })] })] })] }), mode === 'semantic' && semantic && !semantic.ready && _jsx("p", { className: "dcr-hint", children: semantic.enabled ? t('semanticNotReady', { coverage }) : t('semanticOff') }), result?.notice && _jsx("p", { className: "dcr-hint", role: "status", children: result.notice }), error && _jsx("p", { className: "dcr-error", role: "alert", children: error }), _jsxs("div", { className: `dcr-search-body${selection ? ' with-preview' : ''}`, children: [_jsxs("ol", { className: "dcr-search-results", "aria-busy": busy, children: [busy && !result && _jsx("li", { className: "dcr-hint", children: t('searching') }), result && result.groups.length === 0 && !busy && _jsx("li", { className: "dcr-hint", "data-role": "empty", children: t('noResults') }), result?.groups.map(group => _jsxs("li", { className: `dcr-result${selection?.sessionId === group.sessionId ? ' selected' : ''}`, children: [_jsxs("button", { type: "button", className: "dcr-result-head", "data-session": group.sessionId, onClick: () => choose({ sessionId: group.sessionId, seq: group.hits[0]?.seq }), children: [_jsx("span", { className: "dcr-result-title", children: highlight(group.title || t('untitled'), terms) }), _jsxs("span", { className: "dcr-result-meta", children: [group.archived && _jsx("span", { className: "dcr-badge", children: t('archived') }), group.subagent && _jsx("span", { className: "dcr-badge", children: t('subagent') }), group.cwd && _jsx("span", { title: group.cwd, children: shortPath(group.cwd) }), _jsx("span", { children: when(group.updatedAt, t) }), group.hitCount > group.hits.length && _jsx("span", { children: t('moreHits', { count: group.hitCount }) })] })] }), group.hits.length > 0 && _jsx("ul", { className: "dcr-hits", children: group.hits.map(hit => _jsx("li", { children: _jsxs("button", { type: "button", "data-hit": `${group.sessionId}:${hit.seq}`, className: selection?.sessionId === group.sessionId && selection.seq === hit.seq ? 'selected' : '', onClick: () => choose({ sessionId: group.sessionId, seq: hit.seq }), children: [_jsx("span", { className: "dcr-who", children: t(hit.type === 'assistant/message' ? 'assistant' : 'you') }), hit.source === 'semantic' && _jsx("span", { className: "dcr-badge", children: t('semanticHit') }), _jsx("span", { className: "dcr-snippet", children: highlight(hit.snippet, terms) })] }) }, hit.seq)) })] }, group.sessionId))] }), selection && _jsxs("aside", { className: "dcr-preview", "aria-label": t('preview'), children: [_jsxs("div", { className: "dcr-preview-head", children: [_jsx("strong", { children: preview?.title || t('untitled') }), _jsxs("span", { className: "dcr-preview-actions", children: [_jsx("button", { type: "button", "data-action": "open-session", onClick: () => face.current.open(selection.sessionId, selection.seq), children: t('openSession') }), _jsx("button", { type: "button", "data-action": "close-preview", "aria-label": t('closePreview'), onClick: () => setSelection(null), children: "\u00D7" })] })] }), previewError && _jsx("p", { className: "dcr-error", role: "alert", children: previewError }), preview?.hasBefore && selection.seq !== undefined && _jsx("button", { type: "button", className: "dcr-more", "data-action": "earlier", onClick: () => setRange(w => ({ ...w, before: w.before + PREVIEW_STEP * 2 })), children: t('earlier') }), _jsx("ol", { className: "dcr-preview-items", ref: previewList, children: preview?.items?.map(item => _jsxs("li", { "data-seq": item.seq, className: `${item.type === 'assistant/message' ? 'assistant' : 'user'}${item.seq === selection.seq ? ' target' : ''}`, children: [_jsxs("span", { className: "dcr-who", children: [t(item.type === 'assistant/message' ? 'assistant' : 'you'), item.time ? ` · ${when(item.time, t)}` : ''] }), _jsx("div", { className: "dcr-preview-text", children: highlight(item.text, terms) })] }, item.seq)) }), preview?.hasAfter && _jsx("button", { type: "button", className: "dcr-more", "data-action": "later", onClick: () => selection.seq === undefined
                                    ? setSelection({ sessionId: selection.sessionId, seq: preview.items?.at(-1)?.seq })
                                    : setRange(w => ({ ...w, after: w.after + PREVIEW_STEP * 2 })), children: t('later') })] })] })] });
}
/** Sidebar row icon: magnifier over a clock hand. */
export function SearchIcon({ size }) {
    const edge = size ?? 16;
    return _jsxs("svg", { width: edge, height: edge, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true", children: [_jsx("circle", { cx: "7", cy: "7", r: "4.6", stroke: "currentColor", strokeWidth: "1.6" }), _jsx("path", { d: "M7 4.8V7l1.5 1", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }), _jsx("path", { d: "M10.6 10.6 14 14", stroke: "currentColor", strokeWidth: "1.7", strokeLinecap: "round" })] });
}
