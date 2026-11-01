import { createHash } from 'node:crypto'
import type { ConfigData } from './config.js'

export type EmbeddingConfig = ConfigData['embedding']
export class EmbeddingError extends Error {
  constructor(message: string) { super(message); this.name = 'EmbeddingError' }
}
export function vectorFingerprint(config: EmbeddingConfig): string {
  return createHash('sha256').update(JSON.stringify({baseURL: config.baseURL.replace(/\/+$/, ''), model: config.model,
    dimensions: config.dimensions, queryPrefix: config.queryPrefix, documentPrefix: config.documentPrefix,
    maxInputChars: config.maxInputChars})).digest('hex')
}
/** Normalize and validate before any vectors can enter the persistent index. */
export function normalizeVector(value: unknown, dimension?: number): Float32Array {
  if (!Array.isArray(value) || value.length < 1 || value.length > 65536 || (dimension && value.length !== dimension)
    || value.some(v => typeof v !== 'number' || !Number.isFinite(v))) throw new EmbeddingError('向量服务返回的维度或数值无效。')
  const norm = Math.hypot(...value)
  if (!Number.isFinite(norm) || norm === 0) throw new EmbeddingError('向量服务返回了零向量或无效向量。')
  return Float32Array.from(value, v => v / norm)
}

/** OpenAI-compatible /embeddings transport; no local model or native runtime. */
export class OnlineEmbedder {
  readonly fingerprint: string
  readonly available: boolean
  private readonly lifetime = new AbortController()
  private queue: Promise<unknown> = Promise.resolve()
  private observedDimension?: number
  constructor(readonly config: EmbeddingConfig, private readonly resolveKey: () => Promise<string | undefined>,
    private readonly fetcher: typeof fetch = fetch) {
    this.config = structuredClone(config)
    this.fingerprint = vectorFingerprint(config)
    this.available = config.enabled
  }
  async ensureLoaded() { if (!this.available) throw new EmbeddingError('在线向量检索尚未启用。'); this.lifetime.signal.throwIfAborted() }
  async embed(text: string, signal?: AbortSignal): Promise<Float32Array> { return (await this.run([this.config.queryPrefix + text], signal))[0] }
  async embedBatch(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const result: Float32Array[] = []
    for (let start = 0; start < texts.length; start += this.config.batchSize) {
      result.push(...await this.run(texts.slice(start, start + this.config.batchSize).map(v => this.config.documentPrefix + v), signal))
    }
    return result
  }
  private run(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const task = this.queue.then(() => this.request(texts, signal))
    this.queue = task.catch(() => undefined)
    return task
  }
  private async request(texts: string[], callerSignal?: AbortSignal): Promise<Float32Array[]> {
    callerSignal?.throwIfAborted()
    await this.ensureLoaded()
    if (!texts.length) return []
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs), ...(callerSignal ? [callerSignal] : [])])
    const key = await this.resolveKey()
    signal.throwIfAborted()
    const body: Record<string, unknown> = {model: this.config.model, input: texts.map(v => v.slice(0, this.config.maxInputChars)), encoding_format: 'float'}
    if (this.config.dimensions) body.dimensions = this.config.dimensions
    let response: Response
    try {
      response = await this.fetcher(this.config.baseURL.replace(/\/+$/, '') + '/embeddings', {
        method: 'POST', headers: {'Content-Type': 'application/json', ...(key ? {Authorization: `Bearer ${key}`} : {})},
        body: JSON.stringify(body), signal, redirect: 'error',
      })
    } catch { throw new EmbeddingError('向量请求失败或超时，请检查地址、网络和超时设置。') }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new EmbeddingError(`向量服务返回 HTTP ${response.status}，请检查模型、配额与凭据。`)
    }
    // Bound response allocation even if a faulty endpoint omits Content-Length.
    const reader = response.body?.getReader()
    if (!reader) throw new EmbeddingError('向量服务未返回数据。')
    const pieces: Uint8Array[] = []; let length = 0
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break
        length += part.value.byteLength
        if (length > 32 * 1024 * 1024) { await reader.cancel(); throw new EmbeddingError('向量响应过大。') }
        pieces.push(part.value)
      }
      const bytes = Buffer.concat(pieces)
      const value = JSON.parse(bytes.toString('utf8'))
      if (!Array.isArray(value.data) || value.data.length !== texts.length) throw new Error('shape')
      const rows = [...value.data].sort((a: any, b: any) => a.index - b.index)
      if (rows.some((v: any, i: number) => v.index !== i)) throw new Error('indices')
      const dimension = this.config.dimensions || this.observedDimension || rows[0]?.embedding?.length
      const vectors = rows.map((row: any) => normalizeVector(row.embedding, dimension))
      this.observedDimension = vectors[0].length
      return vectors
    } catch (error) {
      if (error instanceof EmbeddingError) throw error
      throw new EmbeddingError('向量响应格式无效或传输中断。')
    } finally { reader.releaseLock() }
  }
  async dispose() { this.lifetime.abort(); await this.queue.catch(() => {}) }
}
