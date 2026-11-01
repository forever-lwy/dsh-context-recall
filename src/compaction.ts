import { symbols, type Context } from '@deepseek-ai/cordis'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { ResolvedConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { BlockAssembler, LlmError, contentHasImage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message, TokenUsage, ToolSchema } from '@deepseek-ai/dsh-llm'
import type {} from './settings.js'
import type { ConfigData } from './config.js'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/**
 * The summary directive and safe stream projection follow dsh-compaction-basic
 * 0.2.1-rc.5 (DeepSeek, MIT). The native backend still owns every selection,
 * tool-pair boundary, transaction, persistence checkpoint and overflow retry.
 */
export const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  '- If the conversation already contains a <compacted-summary> block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.',
].join('\n')

export interface SummaryInput {
  readonly tools?: readonly ToolSchema[]
  readonly messages: readonly Message[]
}

export interface SummaryOutput {
  summary: ContentBlock[]
  rawOutput: ContentBlock[]
  provider: string
  model: string
  maxTokens: number
  llmStreamCall: true
  usage?: TokenUsage
}

export interface SummaryTarget { provider: string; model: string; maxTokens: number }

/** Portable public type for the native protected hook's marked/unmarked result. */
export type NativeSummaryResult = {
  summary: ContentBlock[]
  provider: string
  model: string
  maxTokens?: number
  usage?: TokenUsage
} & ({ rawOutput: ContentBlock[]; llmStreamCall: true } | { rawOutput?: ContentBlock[]; llmStreamCall?: never })

/** A one-shot whose actual route is also recorded in compaction/summary. */
export async function summarizeWithGlobalModel(
  ctx: Context,
  target: SummaryTarget,
  input: SummaryInput,
  agent: Agent,
  signal?: AbortSignal,
): Promise<SummaryOutput> {
  signal?.throwIfAborted()
  const instruction: GenerateOptions['messages'][number] = {
    role: 'user', content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
  }
  Object.freeze(instruction.content[0])
  Object.freeze(instruction.content)
  Object.freeze(instruction)
  const options: GenerateOptions = {
    provider: target.provider,
    model: target.model,
    messages: [...input.messages, instruction],
    toolHistory: agent.session.toolHistory(),
    ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
    maxTokens: target.maxTokens,
    sessionId: agent.session.id,
    purpose: 'compaction',
    ...(signal === undefined ? {} : { signal }),
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    signal?.throwIfAborted()
    assembler.push(chunk)
  }
  signal?.throwIfAborted()
  const finish = assembler.finish
  if (finish.kind === 'error' || finish.kind === 'aborted') {
    throw new LlmError(finish.failure.message, finish.failure.code, finish.failure)
  }
  if (finish.kind === 'max-tokens') {
    throw Object.assign(new Error('summarization truncated at the token cap (incomplete checkpoint)'), { code: 'MAX_TOKENS' })
  }
  const rawOutput = assembler.blocks()
  if (contentHasImage(rawOutput)) {
    throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  }
  const summary = rawOutput.filter(block => block.type === 'text')
  if (!summary.some(block => block.text.trim().length > 0)) {
    throw new Error('summarization produced no text summary content')
  }
  return {
    summary, rawOutput, provider: options.provider, model: options.model,
    maxTokens: options.maxTokens!, llmStreamCall: true,
    ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
  }
}

/** Drop-in replacement for the existing compaction-basic composition row. */
export class ContextRecallCompaction extends BasicCompactionEngine {
  static override inject = [...BasicCompactionEngine.inject]
  static override Config = BasicCompactionEngine.Config
  private readSettings?: () => ConfigData

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx, config)
    // A disabled/unloaded recall entry must leave native compaction working.
    // The optional child also binds service reads to a declared dependency.
    ctx.inject(['contextRecall'], scoped => {
      const read = () => scoped.contextRecall.current()
      this.readSettings = read
      scoped.effect(() => () => {
        // A replacement child may have already published its new reader.
        if (this.readSettings === read) this.readSettings = undefined
      })
    })
  }

  protected override async summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal): Promise<NativeSummaryResult> {
    // Snapshot before awaiting, so a GUI edit affects the next transaction.
    const { provider, model } = this.readSettings?.().compression ?? { provider: '', model: '' }
    if (!provider && !model) return super.summarize(input, agent, signal)
    if (!provider || !model) throw new Error('Compression provider and model must be configured together.')
    const conversation = agent.session.requestHeader()?.config ?? agent.options
    const policy = this.config.modelPolicies.find(item => item.provider === conversation.provider && item.model === conversation.model)
    const maxTokens = policy?.maxTokens ?? this.config.maxTokens
    return summarizeWithGlobalModel(this.ctx, { provider, model, maxTokens }, input, agent, signal)
  }
}

export default ContextRecallCompaction

interface NativeSummaryHook {
  ctx: Context
  config: ResolvedConfig
  summarize(input: SummaryInput, agent: Agent, signal?: AbortSignal): Promise<NativeSummaryResult>
}

/**
 * Extend the native instances selected by web Agent presets. Their isolated
 * compaction services are intentionally invisible as root `ctx.compaction`.
 * Only the documented summarize customization point is decorated; prototypes,
 * service registrations, preset documents and LLM routing are preserved.
 */
export function registerCompressionBridge(ctx: Context, getConfig: () => Pick<ConfigData, 'compression'>): () => void {
  const restorers = new Map<object, () => void>()
  let active = true
  const bind = (value: unknown) => {
    if (!active || !value || typeof value !== 'object') return
    // serviceFor() returns caller-bound Cordis facades whose identity changes
    // on each read. Decorate and deduplicate the one underlying implementation.
    const implementation = Reflect.get(value, symbols.original) ?? value
    if (restorers.has(implementation) || !(implementation instanceof BasicCompactionEngine)) return
    const engine = implementation as unknown as NativeSummaryHook
    const ownerCtx = Object.getOwnPropertyDescriptor(engine, 'ctx')?.value as Context | undefined
    if (!ownerCtx) return
    const own = Object.getOwnPropertyDescriptor(engine, 'summarize')
    if (own && !own.configurable) return
    const original = engine.summarize
    if (typeof original !== 'function') return
    const wrapper: NativeSummaryHook['summarize'] = function (this: NativeSummaryHook, input, agent, signal) {
      const { provider, model } = active ? getConfig().compression : { provider: '', model: '' }
      if (!provider && !model) return original.call(this, input, agent, signal)
      if (!provider || !model) return Promise.reject(new Error('Compression provider and model must be configured together.'))
      const conversation = agent.session.requestHeader()?.config ?? agent.options
      const policy = this.config.modelPolicies.find(item => item.provider === conversation.provider && item.model === conversation.model)
      return summarizeWithGlobalModel(ownerCtx, { provider, model, maxTokens: policy?.maxTokens ?? this.config.maxTokens }, input, agent, signal)
    }
    Object.defineProperty(engine, 'summarize', {
      configurable: true, writable: true, enumerable: own?.enumerable ?? false, value: wrapper,
    })
    restorers.set(engine, () => {
      // A later extension keeps ownership. A retained wrapper delegates to the
      // prior hook after this bridge has been disposed.
      if (Object.getOwnPropertyDescriptor(engine, 'summarize')?.value !== wrapper) return
      if (own) Object.defineProperty(engine, 'summarize', own)
      else delete (engine as Partial<NativeSummaryHook>).summarize
    })
  }
  const bindAgent = (agent: Agent) => bind(ctx.agentPresets.serviceFor(agent, 'compaction'))
  const scan = () => { for (const agent of ctx.agents.list()) bindAgent(agent) }
  const disposers: (() => unknown)[] = [
    // Awaited by AgentRegistry before the first queued input starts.
    ctx.on('agent/created', ({ agent }) => { bindAgent(agent); return undefined }),
    ctx.on('agent-preset/selected', sessionId => { const agent = ctx.agents.get(sessionId); if (agent) bindAgent(agent) }),
    // Rebind a preset engine hot-replaced while its Agent remains alive.
    ctx.on('agent/pre-step', (payload, next) => { bindAgent(payload.agent); return next() }, { prepend: true }),
    ctx.on('agent/request-error', (payload, next) => { bindAgent(payload.agent); return next() }, { prepend: true }),
    // Cordis publishes isolated realms through this lifecycle event too. This
    // covers a hot-reloaded backend followed immediately by manual /compact.
    ctx.on('internal/service', (name, value) => { if (name === 'compaction') bind(value) }, { global: true }),
  ]
  const root = ctx.inject(['compaction'], nativeCtx => { bind(nativeCtx.compaction) })
  scan()
  const dispose = () => {
    if (!active) return
    active = false
    for (const disposeListener of disposers) disposeListener()
    void root.dispose()
    for (const restore of restorers.values()) restore()
    restorers.clear()
  }
  ctx.effect(() => dispose, 'context-recall: native compaction hooks')
  return dispose
}
