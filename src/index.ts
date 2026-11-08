import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-tools'
import { registerSettings, type SearchApi } from './settings.js'
import { OnlineEmbedder, vectorFingerprint } from './embedding.js'
import { applyRecall } from './recall.js'
import { registerCompressionBridge } from './compaction.js'
import { createSearchApi } from './search-service.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-context-recall'
export const inject = ['tools', 'sessions', 'sessionQuery', 'sessionPersistence', 'agents', 'systemPrompt', 'llm', 'credentials', 'typert']

export async function apply(ctx: Context): Promise<void> {
  const settings = await registerSettings(ctx)
  // Web's real backends belong to isolated preset scopes. Bind each native
  // instance through the registry; leave their declarations and policies intact.
  ctx.inject(['agentPresets'], scoped => {
    registerCompressionBridge(scoped, () => settings.current(), {
      registerThresholdValidator: validate => settings.addThresholdValidator(validate),
    })
  })
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
  const recall = applyRecall(ctx, () => {
    const config = settings.current()
    return {...config.recall, semantic: config.embedding.enabled && config.recall.semantic, background: config.embedding.background}
  }, getEmbedder)
  // A saved embedding configuration may enable vectors or change their space.
  ctx.effect(() => settings.onSaved(() => recall.embedQueue.reset()), 'context-recall: embedding config watcher')
  const api = createSearchApi({
    index: recall.index,
    getEmbedder: () => getEmbedder(),
    getConfig: () => {
      const config = settings.current()
      return {semantic: config.embedding.enabled && config.recall.semantic, coverageThreshold: config.recall.coverageThreshold}
    },
    sync: recall.sync,
    archivedIds: () => readArchivedIds(ctx),
    readSession: (id: string) => (ctx as any).sessionQuery.readSession(id),
  })
  ctx.effect(() => settings.attachSearch(api as unknown as SearchApi), 'context-recall: search page api')
}

/** Official archive set: the workspace registry, else its persisted storage file. */
function readArchivedIds(ctx: Context): readonly string[] | undefined {
  try {
    const registry = (ctx as any).get?.('workspaceRegistry') as { archivedSessionIds?: unknown } | undefined
    const ids = registry?.archivedSessionIds
    if (Array.isArray(ids)) return ids.filter((id): id is string => typeof id === 'string')
  } catch { /* registry not started yet */ }
  try {
    const file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'storages', 'workspace.json')
    const ids = JSON.parse(readFileSync(file, 'utf8'))?.global?.archivedSessionIds
    if (Array.isArray(ids)) return ids.filter((id: unknown): id is string => typeof id === 'string')
  } catch { /* no archive information */ }
  return undefined
}
