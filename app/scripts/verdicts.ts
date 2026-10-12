import type { Hex } from 'viem'

/**
 * What the solver learned about each board message, kept only when it is sure.
 *
 * A check answers with a verdict, with null for "not an intent we can use", or with 'unknown'
 * when a read failed. Only the first two are facts. The solver reads the board as a delta, so a
 * message is offered once: a failed read cached as null lost a good intent for the life of the
 * process. An unknown is kept aside and asked again on later passes, up to `maxTries` times.
 */
export class VerdictCache<T> {
  private done = new Map<string, T | null>()
  private retry = new Map<string, { data: Hex; tries: number }>()
  private readonly max: number
  private readonly maxTries: number

  /**
   * @param max the most verdicts kept. Eviction is oldest first; evicting a live one costs one
   *   more check and nothing else.
   * @param maxTries how many times a failing read is asked before it counts as a refusal.
   */
  constructor(max: number, maxTries = 5) {
    this.max = max
    this.maxTries = maxTries
  }

  get size(): number {
    return this.done.size
  }

  private remember(hash: string, verdict: T | null): void {
    if (this.done.size >= this.max) {
      const oldest = this.done.keys().next()
      if (!oldest.done) this.done.delete(oldest.value)
    }
    this.done.set(hash, verdict)
  }

  /**
   * The usable verdicts for these messages and for any earlier ones still waiting on a retry.
   */
  async resolve(
    messages: readonly { hash: string; data: Hex }[],
    check: (data: Hex) => Promise<T | null | 'unknown'>,
  ): Promise<{ hash: string; data: Hex; verdict: T }[]> {
    const todo = new Map<string, Hex>()
    for (const [hash, r] of this.retry) todo.set(hash, r.data)
    for (const msg of messages) todo.set(msg.hash, msg.data)

    const out: { hash: string; data: Hex; verdict: T }[] = []
    for (const [hash, data] of todo) {
      let verdict = this.done.get(hash)
      if (verdict === undefined) {
        const answer = await check(data)
        if (answer === 'unknown') {
          const tries = (this.retry.get(hash)?.tries ?? 0) + 1
          if (tries < this.maxTries) {
            this.retry.set(hash, { data, tries })
            continue
          }
          verdict = null
        } else {
          verdict = answer
        }
        this.retry.delete(hash)
        this.remember(hash, verdict)
      }
      if (verdict !== null) out.push({ hash, data, verdict })
    }
    return out
  }
}
