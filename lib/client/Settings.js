import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useId, useRef, useState } from 'react';
import { configSchema } from '../config.js';
import { zh } from './locales.js';
/** Move the decimal point as text so 0.575 displays as 57.5, without multiplying floats. */
function thresholdPercent(ratio) {
    if (ratio === null)
        return '80';
    const decimal = (String(ratio).split('.')[1] ?? '').padEnd(2, '0');
    return `${Number(decimal.slice(0, 2))}${decimal.length > 2 ? `.${decimal.slice(2)}` : ''}`;
}
function thresholdRatio(percent) {
    if (!/^\d+(?:\.\d+)?$/.test(percent) || Number(percent) < 17 || Number(percent) > 99)
        return NaN;
    const [whole, fraction = ''] = percent.split('.');
    const digits = whole.padStart(3, '0');
    const ratio = Number(`${digits.slice(0, -2)}.${digits.slice(-2)}${fraction}`);
    const trimmedFraction = fraction.replace(/0+$/, '');
    const canonical = `${whole.replace(/^0+(?=\d)/, '')}${trimmedFraction ? `.${trimmedFraction}` : ''}`;
    // Reject precision loss instead of silently changing the percentage during a save.
    return thresholdPercent(ratio) === canonical ? ratio : NaN;
}
/** Settings stay local until an explicit save. Read/test/save lifetimes follow the mounted page. */
export function ContextRecallSettings(props) {
    const t = props.t ?? ((key) => zh[key] ?? key);
    const operations = useRef(props);
    operations.current = props;
    const [view, setView] = useState(null);
    const [draft, setDraft] = useState(null);
    const [thresholdInput, setThresholdInput] = useState('80');
    const [apiKey, setApiKey] = useState('');
    const [clearApiKey, setClearApiKey] = useState(false);
    const [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState('read');
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [loadEpoch, setLoadEpoch] = useState(0);
    const active = useRef(null);
    const inFlight = useRef(false);
    const mounted = useRef(false);
    const prefix = useId();
    useEffect(() => {
        mounted.current = true;
        const controller = new AbortController();
        active.current = controller;
        inFlight.current = true;
        setBusy('read');
        setError('');
        setMessage('');
        void operations.current.read(controller.signal).then(snapshot => {
            if (controller.signal.aborted)
                return;
            setView(snapshot);
            setDraft(structuredClone(snapshot.config));
            setDirty(false);
            setThresholdInput(thresholdPercent(snapshot.config.compression.thresholdRatio));
            setApiKey('');
            setClearApiKey(false);
        }).catch(reason => {
            if (!controller.signal.aborted)
                setError(reason instanceof Error ? reason.message : t('failed'));
        }).finally(() => {
            if (!controller.signal.aborted) {
                inFlight.current = false;
                setBusy(null);
            }
        });
        return () => { mounted.current = false; controller.abort(); active.current?.abort(); inFlight.current = false; };
    }, [loadEpoch]);
    const update = (section, key, value) => {
        setDraft(previous => previous ? { ...previous, [section]: { ...previous[section], [key]: value } } : previous);
        setDirty(true);
        setMessage('');
        setError('');
    };
    const changedSecret = (value) => { setApiKey(value); setClearApiKey(false); setDirty(true); setMessage(''); setError(''); };
    const parseDraft = () => {
        if (draft?.compression.thresholdRatio !== null && !Number.isFinite(thresholdRatio(thresholdInput))) {
            setError(t('thresholdInvalid'));
            return null;
        }
        const parsed = configSchema.safeParse(draft);
        if (!parsed.success) {
            setError(t('invalid') + parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
            return null;
        }
        return parsed.data;
    };
    const perform = async (kind) => {
        if (inFlight.current || !view)
            return;
        const config = parseDraft();
        if (!config)
            return;
        const controller = new AbortController();
        active.current = controller;
        inFlight.current = true;
        setBusy(kind);
        setError('');
        setMessage('');
        try {
            if (kind === 'save') {
                const snapshot = await operations.current.save({ config, expectedRevision: view.revision,
                    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearApiKey ? { clearApiKey: true } : {}) }, controller.signal);
                if (controller.signal.aborted || !mounted.current)
                    return;
                setView(snapshot);
                setDraft(structuredClone(snapshot.config));
                setDirty(false);
                setThresholdInput(thresholdPercent(snapshot.config.compression.thresholdRatio));
                setApiKey('');
                setClearApiKey(false);
                setMessage(t('saved'));
            }
            else {
                const result = await operations.current.test({ config, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }, controller.signal);
                if (controller.signal.aborted || !mounted.current)
                    return;
                setMessage(`${result.message} (${result.dimensions})`);
            }
        }
        catch (reason) {
            if (!controller.signal.aborted && mounted.current)
                setError(reason instanceof Error ? reason.message : t('failed'));
        }
        finally {
            if (!controller.signal.aborted && mounted.current) {
                inFlight.current = false;
                setBusy(null);
            }
        }
    };
    const field = (section, key, label, options = {}) => {
        const value = draft[section][key];
        const numeric = typeof value === 'number';
        const id = `${prefix}-${section}-${key}`;
        return _jsxs("label", { className: "dcr-field", htmlFor: id, children: [_jsx("span", { children: t(label) }), _jsx("input", { id: id, "data-setting": `${section}.${key}`, type: options.type ?? (numeric ? 'number' : 'text'), value: Number.isNaN(value) ? '' : value, min: options.min, max: options.max, step: options.step ?? (numeric ? 1 : undefined), autoComplete: "off", spellCheck: false, onChange: event => update(section, key, numeric ? (event.target.value === '' ? NaN : Number(event.target.value)) : event.target.value) }), options.hint && _jsx("small", { children: options.hint })] }, key);
    };
    const toggle = (section, key, label) => _jsxs("label", { className: "dcr-toggle", children: [_jsx("input", { "data-setting": `${section}.${key}`, type: "checkbox", checked: draft[section][key], onChange: event => update(section, key, event.target.checked) }), _jsx("span", { children: t(label) })] }, key);
    return _jsxs("section", { className: "dcr-settings", "aria-label": t('nav'), children: [_jsx("h2", { children: t('nav') }), _jsx("p", { children: t('intro') }), busy === 'read' && _jsx("p", { role: "status", children: t('loading') }), error && _jsx("p", { className: "dcr-error", role: "alert", children: error }), message && _jsx("p", { role: "status", className: "dcr-success", children: message }), !draft || !view ? _jsx("button", { type: "button", disabled: busy !== null, onClick: () => setLoadEpoch(value => value + 1), children: t('retry') }) :
                _jsxs("form", { onSubmit: event => { event.preventDefault(); void perform('save'); }, children: [_jsxs("fieldset", { disabled: busy !== null, children: [_jsx("legend", { children: t('compression') }), _jsx("p", { children: t('compressionHelp') }), _jsxs("label", { className: "dcr-field", children: [_jsx("span", { children: t('catalog') }), _jsxs("select", { "data-setting": "compression.catalog", value: draft.compression.provider === '' && draft.compression.model === '' ? '' :
                                                view.models.some(model => model.provider === draft.compression.provider && model.model === draft.compression.model)
                                                    ? JSON.stringify([draft.compression.provider, draft.compression.model]) : 'custom', onChange: event => {
                                                if (event.target.value === 'custom')
                                                    return;
                                                const [provider, model] = event.target.value ? JSON.parse(event.target.value) : ['', ''];
                                                setDraft(previous => previous ? { ...previous, compression: { ...previous.compression, provider, model } } : previous);
                                                setDirty(true);
                                                setMessage('');
                                                setError('');
                                            }, children: [_jsx("option", { value: "", children: t('inherit') }), _jsx("option", { value: "custom", children: t('custom') }), view.models.map(model => _jsxs("option", { value: JSON.stringify([model.provider, model.model]), children: [model.name, " \u00B7 ", model.provider, "/", model.model] }, JSON.stringify([model.provider, model.model])))] })] }), _jsxs("div", { className: "dcr-grid", children: [field('compression', 'provider', 'provider'), field('compression', 'model', 'compressionModel')] }), _jsxs("div", { className: "dcr-grid", children: [_jsxs("label", { className: "dcr-field", children: [_jsx("span", { children: t('thresholdMode') }), _jsxs("select", { "data-setting": "compression.thresholdMode", value: draft.compression.thresholdRatio === null ? 'inherit' : 'custom', onChange: event => update('compression', 'thresholdRatio', event.target.value === 'inherit' ? null : thresholdRatio(thresholdInput)), children: [_jsx("option", { value: "inherit", children: t('thresholdInherit') }), _jsx("option", { value: "custom", children: t('thresholdCustom') })] })] }), _jsxs("label", { className: "dcr-field", htmlFor: `${prefix}-compression-thresholdRatio`, children: [_jsx("span", { children: t('thresholdRatio') }), _jsx("input", { id: `${prefix}-compression-thresholdRatio`, "data-setting": "compression.thresholdRatio", type: "number", min: "17", max: "99", step: "any", disabled: draft.compression.thresholdRatio === null, value: draft.compression.thresholdRatio === null ? '' : thresholdInput, onChange: event => { setThresholdInput(event.target.value); update('compression', 'thresholdRatio', thresholdRatio(event.target.value)); } })] })] }), _jsx("p", { className: "dcr-hint", children: t('thresholdHelp') })] }), _jsxs("fieldset", { disabled: busy !== null, children: [_jsx("legend", { children: t('embedding') }), _jsx("p", { className: "dcr-disclosure", children: t('disclosure') }), toggle('embedding', 'enabled', 'enabled'), _jsxs("div", { className: "dcr-grid", children: [field('embedding', 'baseURL', 'baseURL', { type: 'url' }), field('embedding', 'model', 'embeddingModel'), field('embedding', 'apiKeyRef', 'apiKeyRef'), _jsxs("label", { className: "dcr-field", children: [_jsx("span", { children: t('apiKey') }), _jsx("input", { type: "password", autoComplete: "new-password", "data-setting": "apiKey", value: apiKey, disabled: !view.credential.writable, onChange: event => changedSecret(event.target.value) }), _jsxs("small", { children: [t(view.credential.configured ? 'keyConfigured' : 'keyMissing'), !view.credential.writable ? ` · ${t('keyReadOnly')}` : ''] })] })] }), _jsxs("label", { className: "dcr-toggle", children: [_jsx("input", { "data-setting": "clearApiKey", type: "checkbox", checked: clearApiKey, disabled: !view.credential.writable, onChange: event => { setClearApiKey(event.target.checked); setApiKey(''); setDirty(true); setMessage(''); setError(''); } }), _jsx("span", { children: t('clearApiKey') })] }), _jsxs("div", { className: "dcr-grid", children: [field('embedding', 'dimensions', 'dimensions', { min: 0, max: 65536 }), field('embedding', 'batchSize', 'batchSize', { min: 1, max: 128 }), field('embedding', 'maxInputChars', 'maxInputChars', { min: 128, max: 100000 }), field('embedding', 'timeoutMs', 'timeoutMs', { min: 1000, max: 300000 }), field('embedding', 'queryPrefix', 'queryPrefix'), field('embedding', 'documentPrefix', 'documentPrefix')] }), toggle('embedding', 'background', 'background'), _jsx("button", { type: "button", "data-action": "test", onClick: () => void perform('test'), children: busy === 'test' ? t('testing') : t('test') }), _jsx("small", { className: "dcr-hint", children: t('testHelp') })] }), _jsxs("fieldset", { disabled: busy !== null, children: [_jsx("legend", { children: t('recall') }), toggle('recall', 'semantic', 'semantic'), _jsxs("div", { className: "dcr-grid", children: [_jsxs("label", { className: "dcr-field", children: [_jsx("span", { children: t('warmup') }), _jsxs("select", { "data-setting": "recall.warmup", value: draft.recall.warmup, onChange: event => update('recall', 'warmup', event.target.value), children: [_jsx("option", { value: "gentle", children: t('gentle') }), _jsx("option", { value: "fast", children: t('fast') })] })] }), field('recall', 'coverageThreshold', 'coverageThreshold', { min: 0, max: 1, step: 0.01 }), field('recall', 'eventGap', 'eventGap', { min: 0, max: 100 }), field('recall', 'maxEvents', 'maxEvents', { min: 1, max: 20 }), field('recall', 'limit', 'limit', { min: 1, max: 50 }), field('recall', 'context', 'context', { min: 0, max: 10 })] }), toggle('recall', 'anchor', 'anchor'), field('recall', 'anchorRounds', 'anchorRounds', { min: 1, max: 20 })] }), _jsxs("fieldset", { disabled: busy !== null, children: [_jsx("legend", { children: t('access') }), _jsx("p", { className: "dcr-hint", children: t('accessHelp') }), _jsxs("div", { className: "dcr-grid", children: [_jsxs("label", { className: "dcr-field", children: [_jsx("span", { children: t('crossSession') }), _jsxs("select", { "data-setting": "recall.crossSession", value: draft.recall.crossSession, onChange: event => update('recall', 'crossSession', event.target.value), children: [_jsx("option", { value: "off", children: t('accessOff') }), _jsx("option", { value: "when-asked", children: t('accessWhenAsked') }), _jsx("option", { value: "autonomous", children: t('accessAutonomous') })] })] }), _jsxs("label", { className: "dcr-field", children: [_jsx("span", { children: t('readOther') }), _jsxs("select", { "data-setting": "recall.readOther", value: draft.recall.readOther, onChange: event => update('recall', 'readOther', event.target.value), children: [_jsx("option", { value: "off", children: t('accessOff') }), _jsx("option", { value: "when-asked", children: t('accessWhenAsked') }), _jsx("option", { value: "allowed", children: t('accessAllowed') })] })] })] })] }), _jsx("p", { className: "dcr-hint", role: "status", children: view.status.message }), _jsxs("div", { className: "dcr-actions", children: [_jsx("button", { type: "submit", "data-action": "save", disabled: busy !== null || !dirty, children: busy === 'save' ? t('saving') : t('save') }), _jsx("button", { type: "button", "data-action": "reload", disabled: busy !== null, onClick: () => setLoadEpoch(value => value + 1), children: t(dirty ? 'discard' : 'retry') }), dirty && _jsx("span", { children: t('dirty') })] })] })] });
}
