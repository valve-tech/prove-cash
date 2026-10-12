/**
 * Which of several overlapping passes may still write.
 *
 * The board runs passes that overlap: a poll every 12 s, a store read on every filter change, and
 * a page of the archive. A pass writes when it lands. Two rules decide whether it may:
 *
 * - A newer pass that has already written wins. An older pass that lands after it would put old
 *   data over new.
 * - A reset voids every pass that started before it. Those passes answer a question that nobody
 *   asks any more.
 *
 * Nothing else voids a pass. In particular, a newer pass that only started does not void an older
 * one. On a slow link one poll can take longer than the 12 s interval, and a rule of "the latest
 * start wins" would then discard every poll.
 */
export class Passes {
  private issued = 0
  private written = 0
  private floor = 0

  /** A ticket for a new pass. */
  start(): number {
    return ++this.issued
  }

  /** True when a reset came after this pass started. The pass must read again or stop. */
  voided(ticket: number): boolean {
    return ticket <= this.floor
  }

  /** True when the pass may still write. It may write in several steps. */
  current(ticket: number): boolean {
    return !this.voided(ticket) && ticket >= this.written
  }

  /** Records a write, and returns false when the pass may not write. */
  commit(ticket: number): boolean {
    if (!this.current(ticket)) return false
    this.written = ticket
    return true
  }

  /** Voids every pass started so far. */
  voidAll(): void {
    this.floor = this.issued
  }
}

/**
 * The board's two kinds of pass, and what voids each.
 *
 * They are two counters because they answer two questions. One counter used to serve both. On
 * mount, `refresh` took ticket 1 and the scope effect took ticket 2 in the same commit. The board
 * answered at 1.5 s, the check saw 1 ≠ 2 and threw the answer away, and the header said "checking
 * the board" until the next poll at about 13 s.
 */
export type BoardPasses = {
  /** Reads of the live board. */
  poll: Passes
  /** Reads of the local store through the current scope and token filter. */
  view: Passes
  /** A scope or token change. It voids the store reads, never the board's answer. */
  changeView(): void
  /** A chain or endpoint change. Every pass in flight answers for another book. */
  reset(): void
}

export function boardPasses(): BoardPasses {
  const poll = new Passes()
  const view = new Passes()
  return {
    poll,
    view,
    changeView: () => view.voidAll(),
    reset: () => {
      poll.voidAll()
      view.voidAll()
    },
  }
}

/**
 * Runs `pass` one at a time.
 *
 * A call that arrives while a pass runs does not start a second pass beside it. It asks for one
 * more pass after the current one, and it resolves when that pass is done. So ten calls during one
 * pass cost one more pass, not ten.
 *
 * The board needs this because the endpoint limits each method per second. Two store reads at
 * once send two quote multicalls in the same second, and the second comes back 429.
 *
 * `pass` returns true when it must run again, for example because the view changed under it.
 */
export function serial(pass: () => Promise<boolean>): () => Promise<void> {
  let running: Promise<void> | null = null
  let again = false
  return () => {
    if (running) {
      again = true
      return running
    }
    running = (async () => {
      try {
        do {
          again = false
          if (await pass()) again = true
        } while (again)
      } finally {
        running = null
      }
    })()
    return running
  }
}
