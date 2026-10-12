import { describe, expect, test } from 'vitest'
import { boardPasses, Passes, serial } from './passes'

describe('which overlapping pass may write', () => {
  test('the board answer that lands during mount is kept', () => {
    // The defect. On mount `refresh` starts a poll and the scope effect changes the view in the
    // same commit. One shared counter made the poll stale, and its answer at 1.5 s was discarded.
    const p = boardPasses()
    const poll = p.poll.start()
    p.changeView()
    const view = p.view.start()
    expect(p.poll.commit(poll)).toBe(true)
    expect(p.view.commit(view)).toBe(true)
  })

  test('a filter change during a poll does not discard the poll', () => {
    const p = boardPasses()
    const poll = p.poll.start()
    expect(p.poll.commit(poll)).toBe(true) // status
    p.changeView()
    expect(p.poll.commit(poll)).toBe(true) // live keys, after the ingest
    expect(p.poll.current(poll)).toBe(true) // answered
  })

  test('a filter change voids a store read for the old view', () => {
    const p = boardPasses()
    const view = p.view.start()
    p.changeView()
    expect(p.view.voided(view)).toBe(true)
    expect(p.view.commit(view)).toBe(false)
    // The read for the new view writes.
    expect(p.view.commit(p.view.start())).toBe(true)
  })

  test('a slow poll is kept when the next poll starts before it lands', () => {
    const polls = new Passes()
    const slow = polls.start()
    const next = polls.start() // 12 s later, while `slow` is still in flight
    expect(polls.commit(slow)).toBe(true)
    expect(polls.commit(next)).toBe(true)
  })

  test('an older pass cannot write over a newer one that has written', () => {
    const polls = new Passes()
    const old = polls.start()
    const fresh = polls.start()
    expect(polls.commit(fresh)).toBe(true)
    expect(polls.commit(old)).toBe(false)
    // Superseded, not voided: a newer answer exists, so the old pass does not read again.
    expect(polls.voided(old)).toBe(false)
  })

  test('a pass may write in several steps', () => {
    const polls = new Passes()
    const t = polls.start()
    expect(polls.commit(t)).toBe(true)
    expect(polls.commit(t)).toBe(true)
  })

  test('a newer pass that failed does not block an older one', () => {
    // A failure writes its error without a commit, so an older answer can still land.
    const polls = new Passes()
    const old = polls.start()
    const failed = polls.start()
    expect(polls.current(failed)).toBe(true)
    expect(polls.commit(old)).toBe(true)
  })

  test('a chain reset voids every pass in flight, on the board and in the view', () => {
    const p = boardPasses()
    const poll = p.poll.start()
    const view = p.view.start()
    p.reset()
    expect(p.poll.commit(poll)).toBe(false)
    expect(p.view.commit(view)).toBe(false)
    expect(p.poll.commit(p.poll.start())).toBe(true)
    expect(p.view.commit(p.view.start())).toBe(true)
  })
})

describe('store reads run one at a time', () => {
  /** A pass that waits until the test lets it finish. */
  function gated() {
    let runs = 0
    let release: () => void = () => {}
    const pass = async () => {
      runs++
      await new Promise<void>((r) => (release = r))
      return false
    }
    return { pass, runs: () => runs, release: () => release() }
  }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  test('calls during a pass cost one more pass, not one each', async () => {
    const g = gated()
    const run = serial(g.pass)
    const first = run()
    const second = run()
    const third = run()
    expect(g.runs()).toBe(1)
    g.release()
    await tick()
    // One more pass for the two calls that arrived during the first.
    expect(g.runs()).toBe(2)
    g.release()
    await Promise.all([first, second, third])
    expect(g.runs()).toBe(2)
  })

  test('a caller resolves only after the pass it asked for', async () => {
    const g = gated()
    const run = serial(g.pass)
    void run()
    let done = false
    void run().then(() => (done = true))
    g.release()
    await tick()
    // The first pass is over, but the second caller's pass is still running.
    expect(done).toBe(false)
    g.release()
    await tick()
    expect(done).toBe(true)
  })

  test('a pass that asks to run again runs again', async () => {
    let runs = 0
    const run = serial(async () => ++runs < 3)
    await run()
    expect(runs).toBe(3)
  })

  test('a failed pass rejects its callers, and the next call starts afresh', async () => {
    let fail = true
    let runs = 0
    const run = serial(async () => {
      runs++
      if (fail) throw new Error('read failed')
      return false
    })
    await expect(run()).rejects.toThrow('read failed')
    fail = false
    await run()
    expect(runs).toBe(2)
  })
})
