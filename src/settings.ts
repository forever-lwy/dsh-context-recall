import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ConfigStore, ConfigConflict } from './store.js'
import { OnlineEmbedder } from './embedding.js'
import { remoteInfo, saveSchema, testSchema, searchRequestSchema, readRequestSchema, locateRequestSchema, type LocateRequest, type LocateResult, type SettingsView, type SaveRequest, type TestRequest,
  type SearchRequest, type SearchResult, type ReadRequest, type ReadResult, type StatusResult } from './remote.js'

/** The search page API, attached once the index exists. */
export interface SearchApi {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>
  read(request: ReadRequest): Promise<ReadResult>
  locate(request: LocateRequest): Promise<LocateResult>
  status(): Promise<StatusResult>
}
import type { ConfigData } from './config.js'

declare module '@deepseek-ai/cordis' { interface Context { contextRecall: ContextRecallService } }
export class ContextRecallService extends TypertRemoteService {
  private saves: Promise<unknown> = Promise.resolve()
  private readonly thresholdValidators = new Set<(ratio: number | null) => void>()
  private readonly savedListeners = new Set<() => void>()
  private searchApi: SearchApi | null = null
  /** Attach the search page API; returns the detacher. */
  attachSearch(api: SearchApi): () => void {
    this.searchApi = api
    return () => { if (this.searchApi === api) this.searchApi = null }
  }
  private requireSearch(): SearchApi {
    if (!this.searchApi) throw new RemoteError('gateway/internal', '会话索引尚未就绪，请稍后重试。', {})
    return this.searchApi
  }
  @Remote
  async search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult> {
    const parsed = searchRequestSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '检索参数无效。', {})
    signal.throwIfAborted()
    try { return await this.requireSearch().search(parsed.data, signal) }
    catch (error) {
      if (error instanceof RemoteError || signal.aborted) throw error
      throw new RemoteError('gateway/internal', error instanceof Error ? error.message : '检索失败。', {})
    }
  }
  @Remote
  async read(request: ReadRequest, signal: AbortSignal): Promise<ReadResult> {
    const parsed = readRequestSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '读取参数无效。', {})
    signal.throwIfAborted()
    return this.requireSearch().read(parsed.data)
  }
  @Remote
  async locate(request: LocateRequest, signal: AbortSignal): Promise<LocateResult> {
    const parsed = locateRequestSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '定位参数无效。', {})
    signal.throwIfAborted()
    try { return await this.requireSearch().locate(parsed.data) }
    catch (error) {
      if (error instanceof RemoteError) throw error
      return { ok: false, error: error instanceof Error ? error.message : '定位失败。' }
    }
  }
  @Remote
  async status(request: Record<string, never>, signal: AbortSignal): Promise<StatusResult> {
    signal.throwIfAborted()
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length) {
      throw new RemoteError('gateway/bad-request', '状态读取参数无效。', {})
    }
    return this.requireSearch().status()
  }
  /** Observe successful saves; returns the disposer. */
  onSaved(listener: () => void): () => void {
    this.savedListeners.add(listener)
    return () => { this.savedListeners.delete(listener) }
  }
  constructor(ctx: Context, readonly store: ConfigStore) { super(ctx, 'contextRecall') }
  current(): ConfigData { return this.store.current() }
  addThresholdValidator(validate: (ratio: number | null) => void): () => void {
    this.thresholdValidators.add(validate)
    return () => { this.thresholdValidators.delete(validate) }
  }
  async resolveKey(ref: string): Promise<string | undefined> {
    return (await this.ctx.credentials.resolve(credentialRef(ref)))?.value
  }
  @Remote
  async get(request: Record<string, never>, signal: AbortSignal): Promise<SettingsView> {
    signal.throwIfAborted()
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).length) {
      throw new RemoteError('gateway/bad-request', '配置读取参数无效。', {})
    }
    const config = this.current()
    const info = await this.ctx.credentials.describe(credentialRef(config.embedding.apiKeyRef))
    const models: SettingsView['models'] = []
    const llm = this.ctx.llm
    for (const {id: provider} of llm.listProviders()) {
      try { for (const model of await llm.listModels(provider)) models.push({provider, model: model.id, name: model.name ?? model.id}) }
      catch { /* One unavailable provider must not hide the rest of the GUI. */ }
    }
    signal.throwIfAborted()
    return {config, revision: this.store.revision(), credential: {configured: info.configured, writable: info.writable}, models,
      status: {semanticAvailable: config.embedding.enabled && config.recall.semantic,
        message: config.embedding.enabled ? '在线向量已启用；待索引的对话文本将发送至配置的向量服务。' : '在线向量尚未启用，当前使用本地模糊检索及全文检索。'}}
  }
  @Remote
  async save(request: SaveRequest, signal: AbortSignal): Promise<SettingsView> {
    const parsed = saveSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '配置输入无效，请检查压缩模型、URL 和数值范围。', {})
    const task = this.saves.then(() => this.saveExclusive(parsed.data, signal))
    this.saves = task.catch(() => {})
    return task
  }
  private async saveExclusive(request: SaveRequest, signal: AbortSignal): Promise<SettingsView> {
    signal.throwIfAborted()
    if (request.apiKey && request.clearApiKey) throw new RemoteError('gateway/bad-request', '不能同时清除和填写 API Key。', {})
    await this.store.load()
    if (request.expectedRevision !== this.store.revision()) throw new RemoteError('gateway/bad-request', '配置已在其他窗口修改，请重新加载后保存。', {})
    try {
      for (const validate of this.thresholdValidators) validate(request.config.compression.thresholdRatio)
    } catch (error) {
      throw new RemoteError('gateway/bad-request', error instanceof Error ? error.message : '压缩触发比例与原生保留策略冲突。', {})
    }
    if (request.config.compression.provider) {
      try { await this.ctx.llm.resolveModelInfo(request.config.compression.provider, request.config.compression.model, signal) }
      catch { throw new RemoteError('gateway/bad-request', '压缩模型不可用，请先在 dsh 模型设置中配置该提供方与模型。', {}) }
    }
    const ref = credentialRef(request.config.embedding.apiKeyRef)
    if (request.apiKey !== undefined || request.clearApiKey) {
      if (!(await this.ctx.credentials.describe(ref)).writable) throw new RemoteError('gateway/bad-request', '当前凭据来源不可写，请更换凭据引用。', {})
      if (request.apiKey && /[\r\n\u0000]/.test(request.apiKey)) throw new RemoteError('gateway/bad-request', 'API Key 含无效字符。', {})
    }
    signal.throwIfAborted()
    // Publish config last, so a failed secret write cannot activate a half-saved connection.
    try {
      if (request.apiKey !== undefined) await this.ctx.credentials.set(ref, request.apiKey)
      else if (request.clearApiKey) await this.ctx.credentials.unset(ref)
      await this.store.save(request.config, request.expectedRevision)
    } catch (error) {
      if (error instanceof ConfigConflict) throw new RemoteError('gateway/bad-request', error.message, {})
      throw new RemoteError('gateway/internal', '保存失败，请重新加载核对配置和凭据后重试。', {})
    }
    for (const listener of this.savedListeners) { try { listener() } catch { /* listeners never fail a save */ } }
    return this.get({}, new AbortController().signal)
  }
  @Remote
  async test(request: TestRequest, signal: AbortSignal): Promise<{dimensions: number; message: string}> {
    const parsed = testSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', '向量测试参数无效。', {})
    const embedder = new OnlineEmbedder({...parsed.data.config.embedding, enabled: true},
      async () => parsed.data.apiKey ?? this.resolveKey(parsed.data.config.embedding.apiKeyRef))
    const cancel = () => { void embedder.dispose() }
    signal.addEventListener('abort', cancel, {once: true})
    try {
      signal.throwIfAborted()
      const vector = await embedder.embed('connection test')
      return {dimensions: vector.length, message: `连接成功，向量维度 ${vector.length}。测试未发送会话历史。`}
    } catch (error) {
      throw new RemoteError('gateway/bad-request', error instanceof Error && error.name === 'EmbeddingError' ? error.message : '向量连接测试已取消或失败。', {})
    } finally { signal.removeEventListener('abort', cancel); await embedder.dispose() }
  }
}
export async function registerSettings(ctx: Context): Promise<ContextRecallService> {
  const store = new ConfigStore(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'context-recall-settings.json'))
  await store.load()
  const service = new ContextRecallService(ctx, store)
  ctx.typert.remotes.register(remoteInfo)
  return service
}
