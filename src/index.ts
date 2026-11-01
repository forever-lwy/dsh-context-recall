import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-tools'
import { registerSettings } from './settings.js'
import { OnlineEmbedder, vectorFingerprint } from './embedding.js'
import { applyRecall } from './recall.js'

export const name = 'dsh-context-recall'
export const inject = ['tools', 'sessions', 'sessionQuery', 'sessionPersistence', 'agents', 'systemPrompt', 'llm', 'credentials', 'typert']

export async function apply(ctx: Context): Promise<void> {
  const settings = await registerSettings(ctx)
  let embedder: OnlineEmbedder | null = null
  let connectionIdentity = ''
  ctx.effect(() => async () => { await embedder?.dispose(); embedder = null })
  const getEmbedder = () => {
    const config = settings.current().embedding
    if (!config.enabled) return null
    const identity = JSON.stringify(config)
    if (connectionIdentity !== identity || embedder?.fingerprint !== vectorFingerprint(config)) {
      void embedder?.dispose()
      embedder = new OnlineEmbedder(config, () => settings.resolveKey(config.apiKeyRef))
      connectionIdentity = identity
    }
    return embedder
  }
  applyRecall(ctx, () => {
    const config = settings.current()
    return {...config.recall, semantic: config.embedding.enabled && config.recall.semantic, background: config.embedding.background}
  }, getEmbedder)
}
