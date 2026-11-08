import type { Context } from '@deepseek-ai/cordis'

interface LayoutFace { selectPanel?(id: string | null): void }
interface WorkspaceFace { openSession?(id: string): void }
interface SessionsFace { open?(id: string): void }
export interface LocateTarget { turn: number; text?: string }

/** Look up an optional client service without failing when it is absent. */
function service<T>(ctx: Context, name: string): T | undefined {
  try { return (ctx as unknown as { get(name: string): unknown }).get(name) as T | undefined } catch { return undefined }
}

const STEP_MS = 120
const OPEN_TIMEOUT_MS = 8_000
const LAND_TIMEOUT_MS = 6_000
const FLASH_CLASS = 'dcr-located'
const MARK_PITCH = 10 // px between turn marks in the host's navigation rail

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until<T>(probe: () => T | null | undefined, timeoutMs: number, signal: { cancelled: boolean }): Promise<T | null> {
  const deadline = Date.now() + timeoutMs
  while (!signal.cancelled && Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await sleep(STEP_MS)
  }
  return null
}

/** The host's turn navigation rail: a nav whose buttons carry data-index. */
function findRail(): HTMLElement | null {
  for (const nav of document.querySelectorAll('nav')) if (nav.querySelector('button[data-index]')) return nav as HTMLElement
  return null
}

/** The turn number a rail mark points at, read from its label ("Jump to turn 3"). */
function markTurn(button: Element): number | null {
  const match = (button.getAttribute('aria-label') || '').match(/(\d+)/)
  return match ? Number(match[1]) : null
}

/** Find the rail mark of `turn`, scrolling the virtualized rail when needed. */
function findMark(rail: HTMLElement, turn: number): HTMLButtonElement | null {
  const marks = [...rail.querySelectorAll<HTMLButtonElement>('button[data-index]')]
  const hit = marks.find(mark => markTurn(mark) === turn)
  if (hit) return hit
  // Marks are laid out by index; turn numbers grow with index, so aim the
  // scroller at the estimated position and let the next probe find it.
  const known = marks.map(mark => ({ index: Number(mark.dataset.index), turn: markTurn(mark) })).filter(m => m.turn !== null)
  const scroller = rail.firstElementChild as HTMLElement | null
  if (known.length && scroller) {
    const ref = known[0]
    const index = ref.index + (turn - (ref.turn as number))
    scroller.scrollTop = Math.max(0, index * MARK_PITCH - scroller.clientHeight / 2)
  }
  return null
}

/** Deepest element inside the conversation whose text contains `text`. */
function findText(text: string): HTMLElement | null {
  const flow = document.querySelector('[data-chat-flow]')
  if (!flow || !text) return null
  const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT)
  const needle = text.replace(/\s+/g, ' ')
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if ((node.textContent || '').replace(/\s+/g, ' ').includes(needle)) return node.parentElement
  }
  // The phrase may span inline elements: fall back to block-level text.
  let best: HTMLElement | null = null
  for (const el of flow.querySelectorAll<HTMLElement>('p, li, div, td, h1, h2, h3, h4, blockquote, pre')) {
    if ((el.textContent || '').replace(/\s+/g, ' ').includes(needle)) best = el
  }
  return best
}

function flash(el: HTMLElement) {
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.add(FLASH_CLASS)
  setTimeout(() => el.classList.remove(FLASH_CLASS), 2_400)
}

let current: { cancelled: boolean } | null = null

/**
 * Bring a message into view in the open conversation: jump with the host's
 * own turn navigation (which pages history in as needed), then highlight the
 * message itself. Best effort; gives up quietly.
 */
export async function locateInConversation(target: LocateTarget, previousFlow: Element | null): Promise<boolean> {
  if (current) current.cancelled = true
  const token = { cancelled: false }
  current = token
  try {
    // Wait for the newly opened conversation (a fresh chat flow) and its rail.
    const rail = await until(() => {
      const flow = document.querySelector('[data-chat-flow]')
      return flow && flow !== previousFlow ? findRail() : null
    }, OPEN_TIMEOUT_MS, token)
      ?? await until(findRail, 1_000, token)
    if (!rail) return false
    const mark = await until(() => findMark(rail, target.turn), OPEN_TIMEOUT_MS, token)
    if (!mark) return false
    mark.click()
    if (!target.text) return true
    const el = await until(() => findText(target.text as string), LAND_TIMEOUT_MS, token)
    if (el && !token.cancelled) flash(el)
    return Boolean(el)
  } finally {
    if (current === token) current = null
  }
}

/**
 * Leave the search page and open `sessionId` in the conversation view; when a
 * message is given, locate it there.
 */
export function openSession(ctx: Context, sessionId: string, locate?: () => Promise<LocateTarget | null>): void {
  const previousFlow = document.querySelector('[data-chat-flow]')
  service<LayoutFace>(ctx, 'layout')?.selectPanel?.(null)
  const workspace = service<WorkspaceFace>(ctx, 'uiWorkspace')
  if (typeof workspace?.openSession === 'function') workspace.openSession(sessionId)
  else service<SessionsFace>(ctx, 'sessions')?.open?.(sessionId)
  if (!locate) return
  void locate().then(target => target ? locateInConversation(target, previousFlow) : false).catch(() => false)
}
