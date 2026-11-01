import { useEffect, useId, useRef, useState } from 'react'
import { configSchema } from '../config.js'
import type { ConfigData, SaveRequest, SettingsView, TestRequest } from '../remote.js'
import { zh } from './locales.js'

export interface SettingsFace {
  read: (signal: AbortSignal) => Promise<SettingsView>
  save: (request: SaveRequest, signal: AbortSignal) => Promise<SettingsView>
  test: (request: TestRequest, signal: AbortSignal) => Promise<{ dimensions: number; message: string }>
}
export interface SettingsProps extends SettingsFace { t?: (key: string) => string }

/** Move the decimal point as text so 0.575 displays as 57.5, without multiplying floats. */
function thresholdPercent(ratio: number | null): string {
  if (ratio === null) return '80'
  const decimal = (String(ratio).split('.')[1] ?? '').padEnd(2, '0')
  return `${Number(decimal.slice(0, 2))}${decimal.length > 2 ? `.${decimal.slice(2)}` : ''}`
}

function thresholdRatio(percent: string): number {
  if (!/^\d+(?:\.\d+)?$/.test(percent) || Number(percent) < 17 || Number(percent) > 99) return NaN
  const [whole, fraction = ''] = percent.split('.')
  const digits = whole.padStart(3, '0')
  const ratio = Number(`${digits.slice(0, -2)}.${digits.slice(-2)}${fraction}`)
  const trimmedFraction = fraction.replace(/0+$/, '')
  const canonical = `${whole.replace(/^0+(?=\d)/, '')}${trimmedFraction ? `.${trimmedFraction}` : ''}`
  // Reject precision loss instead of silently changing the percentage during a save.
  return thresholdPercent(ratio) === canonical ? ratio : NaN
}

/** Settings stay local until an explicit save. Read/test/save lifetimes follow the mounted page. */
export function ContextRecallSettings(props: SettingsProps) {
  const t = props.t ?? ((key: string) => zh[key] ?? key)
  const operations = useRef(props)
  operations.current = props
  const [view, setView] = useState<SettingsView | null>(null)
  const [draft, setDraft] = useState<ConfigData | null>(null)
  const [thresholdInput, setThresholdInput] = useState('80')
  const [apiKey, setApiKey] = useState('')
  const [clearApiKey, setClearApiKey] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState<'read' | 'save' | 'test' | null>('read')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [loadEpoch, setLoadEpoch] = useState(0)
  const active = useRef<AbortController | null>(null)
  const inFlight = useRef(false)
  const mounted = useRef(false)
  const prefix = useId()

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    active.current = controller
    inFlight.current = true
    setBusy('read'); setError(''); setMessage('')
    void operations.current.read(controller.signal).then(snapshot => {
      if (controller.signal.aborted) return
      setView(snapshot); setDraft(structuredClone(snapshot.config)); setDirty(false)
      setThresholdInput(thresholdPercent(snapshot.config.compression.thresholdRatio))
      setApiKey(''); setClearApiKey(false)
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : t('failed'))
    }).finally(() => {
      if (!controller.signal.aborted) { inFlight.current = false; setBusy(null) }
    })
    return () => { mounted.current = false; controller.abort(); active.current?.abort(); inFlight.current = false }
  }, [loadEpoch])

  const update = <Section extends keyof ConfigData>(section: Section, key: keyof ConfigData[Section], value: unknown) => {
    setDraft(previous => previous ? { ...previous, [section]: { ...previous[section], [key]: value } } : previous)
    setDirty(true); setMessage(''); setError('')
  }
  const changedSecret = (value: string) => { setApiKey(value); setClearApiKey(false); setDirty(true); setMessage(''); setError('') }
  const parseDraft = (): ConfigData | null => {
    if (draft?.compression.thresholdRatio !== null && !Number.isFinite(thresholdRatio(thresholdInput))) {
      setError(t('thresholdInvalid'))
      return null
    }
    const parsed = configSchema.safeParse(draft)
    if (!parsed.success) {
      setError(t('invalid') + parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '))
      return null
    }
    return parsed.data
  }
  const perform = async (kind: 'save' | 'test') => {
    if (inFlight.current || !view) return
    const config = parseDraft()
    if (!config) return
    const controller = new AbortController()
    active.current = controller; inFlight.current = true
    setBusy(kind); setError(''); setMessage('')
    try {
      if (kind === 'save') {
        const snapshot = await operations.current.save({ config, expectedRevision: view.revision,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(clearApiKey ? { clearApiKey: true } : {}) }, controller.signal)
        if (controller.signal.aborted || !mounted.current) return
        setView(snapshot); setDraft(structuredClone(snapshot.config)); setDirty(false)
        setThresholdInput(thresholdPercent(snapshot.config.compression.thresholdRatio))
        setApiKey(''); setClearApiKey(false); setMessage(t('saved'))
      } else {
        const result = await operations.current.test({ config, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }, controller.signal)
        if (controller.signal.aborted || !mounted.current) return
        setMessage(`${result.message} (${result.dimensions})`)
      }
    } catch (reason) {
      if (!controller.signal.aborted && mounted.current) setError(reason instanceof Error ? reason.message : t('failed'))
    } finally {
      if (!controller.signal.aborted && mounted.current) { inFlight.current = false; setBusy(null) }
    }
  }
  const field = (section: keyof ConfigData, key: string, label: string, options: { min?: number; max?: number; step?: number; type?: string; hint?: string } = {}) => {
    const value = (draft![section] as any)[key]
    const numeric = typeof value === 'number'
    const id = `${prefix}-${section}-${key}`
    return <label className="dcr-field" htmlFor={id} key={key}>
      <span>{t(label)}</span>
      <input id={id} data-setting={`${section}.${key}`} type={options.type ?? (numeric ? 'number' : 'text')}
        value={Number.isNaN(value) ? '' : value} min={options.min} max={options.max} step={options.step ?? (numeric ? 1 : undefined)}
        autoComplete="off" spellCheck={false}
        onChange={event => update(section, key as never, numeric ? (event.target.value === '' ? NaN : Number(event.target.value)) : event.target.value)} />
      {options.hint && <small>{options.hint}</small>}
    </label>
  }
  const toggle = (section: keyof ConfigData, key: string, label: string) => <label className="dcr-toggle" key={key}>
    <input data-setting={`${section}.${key}`} type="checkbox" checked={(draft![section] as any)[key]}
      onChange={event => update(section, key as never, event.target.checked)} />
    <span>{t(label)}</span>
  </label>

  return <section className="dcr-settings" aria-label={t('nav')}>
    <h2>{t('nav')}</h2><p>{t('intro')}</p>
    {busy === 'read' && <p role="status">{t('loading')}</p>}
    {error && <p className="dcr-error" role="alert">{error}</p>}
    {message && <p role="status" className="dcr-success">{message}</p>}
    {!draft || !view ? <button type="button" disabled={busy !== null} onClick={() => setLoadEpoch(value => value + 1)}>{t('retry')}</button> :
      <form onSubmit={event => { event.preventDefault(); void perform('save') }}>
        <fieldset disabled={busy !== null}>
          <legend>{t('compression')}</legend><p>{t('compressionHelp')}</p>
          <label className="dcr-field"><span>{t('catalog')}</span>
            <select data-setting="compression.catalog" value={draft.compression.provider === '' && draft.compression.model === '' ? '' :
              view.models.some(model => model.provider === draft.compression.provider && model.model === draft.compression.model)
                ? JSON.stringify([draft.compression.provider, draft.compression.model]) : 'custom'}
              onChange={event => {
                if (event.target.value === 'custom') return
                const [provider, model] = event.target.value ? JSON.parse(event.target.value) : ['', '']
                setDraft(previous => previous ? { ...previous, compression: { ...previous.compression, provider, model } } : previous)
                setDirty(true); setMessage(''); setError('')
              }}>
              <option value="">{t('inherit')}</option><option value="custom">{t('custom')}</option>
              {view.models.map(model => <option key={JSON.stringify([model.provider, model.model])} value={JSON.stringify([model.provider, model.model])}>{model.name} · {model.provider}/{model.model}</option>)}
            </select>
          </label>
          <div className="dcr-grid">{field('compression', 'provider', 'provider')}{field('compression', 'model', 'compressionModel')}</div>
          <div className="dcr-grid">
            <label className="dcr-field"><span>{t('thresholdMode')}</span>
              <select data-setting="compression.thresholdMode" value={draft.compression.thresholdRatio === null ? 'inherit' : 'custom'}
                onChange={event => update('compression', 'thresholdRatio', event.target.value === 'inherit' ? null : thresholdRatio(thresholdInput))}>
                <option value="inherit">{t('thresholdInherit')}</option><option value="custom">{t('thresholdCustom')}</option>
              </select>
            </label>
            <label className="dcr-field" htmlFor={`${prefix}-compression-thresholdRatio`}><span>{t('thresholdRatio')}</span>
              <input id={`${prefix}-compression-thresholdRatio`} data-setting="compression.thresholdRatio" type="number" min="17" max="99" step="any"
                disabled={draft.compression.thresholdRatio === null} value={draft.compression.thresholdRatio === null ? '' : thresholdInput}
                onChange={event => { setThresholdInput(event.target.value); update('compression', 'thresholdRatio', thresholdRatio(event.target.value)) }} />
            </label>
          </div>
          <p className="dcr-hint">{t('thresholdHelp')}</p>
        </fieldset>
        <fieldset disabled={busy !== null}>
          <legend>{t('embedding')}</legend><p className="dcr-disclosure">{t('disclosure')}</p>
          {toggle('embedding', 'enabled', 'enabled')}
          <div className="dcr-grid">{field('embedding', 'baseURL', 'baseURL', {type: 'url'})}{field('embedding', 'model', 'embeddingModel')}
            {field('embedding', 'apiKeyRef', 'apiKeyRef')}
            <label className="dcr-field"><span>{t('apiKey')}</span><input type="password" autoComplete="new-password" data-setting="apiKey" value={apiKey}
              disabled={!view.credential.writable} onChange={event => changedSecret(event.target.value)} />
              <small>{t(view.credential.configured ? 'keyConfigured' : 'keyMissing')}{!view.credential.writable ? ` · ${t('keyReadOnly')}` : ''}</small>
            </label>
          </div>
          <label className="dcr-toggle"><input data-setting="clearApiKey" type="checkbox" checked={clearApiKey} disabled={!view.credential.writable}
            onChange={event => { setClearApiKey(event.target.checked); setApiKey(''); setDirty(true); setMessage(''); setError('') }} /><span>{t('clearApiKey')}</span></label>
          <div className="dcr-grid">
            {field('embedding', 'dimensions', 'dimensions', {min: 0, max: 65536})}
            {field('embedding', 'batchSize', 'batchSize', {min: 1, max: 128})}
            {field('embedding', 'maxInputChars', 'maxInputChars', {min: 128, max: 100000})}
            {field('embedding', 'timeoutMs', 'timeoutMs', {min: 1000, max: 300000})}
            {field('embedding', 'queryPrefix', 'queryPrefix')}{field('embedding', 'documentPrefix', 'documentPrefix')}
          </div>
          {toggle('embedding', 'background', 'background')}
          <button type="button" data-action="test" onClick={() => void perform('test')}>{busy === 'test' ? t('testing') : t('test')}</button>
          <small className="dcr-hint">{t('testHelp')}</small>
        </fieldset>
        <fieldset disabled={busy !== null}>
          <legend>{t('recall')}</legend>{toggle('recall', 'semantic', 'semantic')}
          <div className="dcr-grid">
            <label className="dcr-field"><span>{t('warmup')}</span><select data-setting="recall.warmup" value={draft.recall.warmup}
              onChange={event => update('recall', 'warmup', event.target.value)}><option value="gentle">{t('gentle')}</option><option value="fast">{t('fast')}</option></select></label>
            {field('recall', 'coverageThreshold', 'coverageThreshold', {min: 0, max: 1, step: 0.01})}
            {field('recall', 'eventGap', 'eventGap', {min: 0, max: 100})}{field('recall', 'maxEvents', 'maxEvents', {min: 1, max: 20})}
            {field('recall', 'limit', 'limit', {min: 1, max: 50})}{field('recall', 'context', 'context', {min: 0, max: 10})}
          </div>
          {toggle('recall', 'anchor', 'anchor')}{field('recall', 'anchorRounds', 'anchorRounds', {min: 1, max: 20})}
        </fieldset>
        <p className="dcr-hint" role="status">{view.status.message}</p>
        <div className="dcr-actions"><button type="submit" data-action="save" disabled={busy !== null || !dirty}>{busy === 'save' ? t('saving') : t('save')}</button>
          <button type="button" data-action="reload" disabled={busy !== null} onClick={() => setLoadEpoch(value => value + 1)}>{t(dirty ? 'discard' : 'retry')}</button>
          {dirty && <span>{t('dirty')}</span>}</div>
      </form>}
  </section>
}
