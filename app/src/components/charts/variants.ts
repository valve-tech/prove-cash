import type { Key } from '../../i18n/en.ts'

/**
 * Which market picture the reader is looking at, and which one they get first.
 *
 * Six drawings of the same two facts — the pool's curve and the board's resting offers — each
 * answering a different question. None of them wins outright, so the reader picks. What the app
 * owes them is a sensible first choice per screen, and a way to change it that survives a reload.
 *
 * A variant appears in this registry only once it is built. A menu that lists a drawing the app
 * cannot draw is worse than a shorter menu.
 */

/** Where the picture is being shown. The two screens ask different questions of the same data. */
export type ChartContext = 'sign' | 'board'

export type VariantId = 'curve' | 'ladder' | 'capacity' | 'impact' | 'tape' | 'reserves'

export type Variant = {
  id: VariantId
  /** The menu label. Translated, so it is a key rather than a word. */
  label: Key
  /** Screens this drawing makes sense on. */
  contexts: readonly ChartContext[]
}

export const VARIANTS: readonly Variant[] = [
  // Sign only: the curve places the offer you are typing onto the pool, and the board has no
  // draft to place. Offering it there would be a menu entry that draws the same picture as the
  // depth chart with a worse name.
  { id: 'curve', label: 'chart.v.curve', contexts: ['sign'] },
  { id: 'ladder', label: 'chart.v.ladder', contexts: ['sign', 'board'] },
  { id: 'capacity', label: 'chart.v.capacity', contexts: ['sign', 'board'] },
  { id: 'impact', label: 'chart.v.impact', contexts: ['sign', 'board'] },
  { id: 'tape', label: 'chart.v.tape', contexts: ['sign', 'board'] },
  { id: 'reserves', label: 'chart.v.reserves', contexts: ['sign', 'board'] },
]

/**
 * The first drawing each screen shows.
 *
 * Signing is a question about one offer you are still typing — what does my size do to the rate,
 * and does this floor fill? — so the curve with the draft placed on it answers it directly. The
 * board is a question about everyone else's resting offers, which is what a ladder is for.
 */
export const DEFAULT_VARIANT: Record<ChartContext, VariantId> = {
  sign: 'curve',
  board: 'ladder',
}

export const variantsFor = (ctx: ChartContext): readonly Variant[] =>
  VARIANTS.filter((v) => v.contexts.includes(ctx))

const KEY = (ctx: ChartContext) => `prove.chart.${ctx}`

/** The reader's last choice for this screen, or the default when there is not a usable one. */
export function readVariant(ctx: ChartContext): VariantId {
  try {
    const saved = localStorage.getItem(KEY(ctx))
    // A saved id can outlive the variant it names — a rename, or a drawing we withdrew. Fall
    // back rather than render nothing.
    if (saved && variantsFor(ctx).some((v) => v.id === saved)) return saved as VariantId
  } catch {
    // Private mode and blocked storage both throw on read. The default is a fine answer.
  }
  return DEFAULT_VARIANT[ctx]
}

export function writeVariant(ctx: ChartContext, id: VariantId): void {
  try {
    localStorage.setItem(KEY(ctx), id)
  } catch {
    // Not being able to remember the choice is not a reason to refuse to make it.
  }
}
