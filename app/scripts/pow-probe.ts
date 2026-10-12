/**
 * Which proof-of-work scheme does the board accept?
 *
 * msgboard 0.3.0 replaced the scheme outright. A client that grinds the old one is refused with
 * `powmsg: invalid work`, and so is a new client talking to a node that still runs the old
 * verifier — the error is identical from both sides, so it cannot tell you which end is behind.
 *
 * This posts a tiny payload twice, under two different grinds: once through the fast engine the
 * client picks for itself, once through the pure-JS grind in @msgboard/core, which is the
 * reference implementation of whatever scheme that version ships. If the JS grind is accepted and
 * the engine is not, the engine is behind. If neither is accepted, the node is.
 *
 * Measured 2026-08-21, client 0.3.0: both 943 and 369 accept both grinds. An earlier run that
 * day had 369 refusing, and this script was the source of that claim — read the verdict, not the
 * memory of one, because a node gets upgraded and a rate limit looks like a refusal.
 *
 * Run with `npx tsx scripts/pow-probe.ts`. It writes one message per accepted attempt.
 */
import { board as boardClient } from '@prove.cash/sdk'
import { rpcLabel, rpcUrl, describe } from './rpc.ts'

/**
 * Its own category, not `PROVECASH_CATEGORY`.
 *
 * A probe message is not an intent, so posting it under the app's category makes the watchdog log
 * `messages in our category did not decode` and makes the board show a row nothing can read.
 */
const CATEGORY = 'provecash-powprobe'

const CHAIN = Number(process.env.CHAIN ?? 943)
const RPC = rpcUrl(CHAIN)
/** A distinct payload per attempt. Reusing one gets the second refused as `message exists`,
 *  which the verdict below would read as a scheme mismatch. */
const payload = (label: string): `0x${string}` =>
  `0x${Buffer.from(`pow-probe ${process.pid} ${label}`).toString('hex')}`

console.log('endpoint   ', rpcLabel(CHAIN))
console.log('chain      ', CHAIN)

/**
 * What the board said about one attempt.
 *
 * `refused` and `unknown` are not the same answer, and the difference is the whole probe. Only
 * `refused` means the verifier ran the work and rejected it; `unknown` means the request never
 * reached the verifier at all — a rate limit, a timeout, a dropped socket. A probe that reads a
 * 429 as a scheme mismatch prints "the fast engine is behind" about an engine that was never
 * asked, which is how this script reported 943 broken while it was working.
 */
type Verdict = 'accepted' | 'refused' | 'unknown'

/**
 * Did the verifier answer, or did something stop the request before it got there?
 *
 * Positive evidence only. `powmsg: invalid work` is the verifier speaking. Everything else is
 * assumed to have never arrived, because a wrong `unknown` costs one re-run and a wrong `refused`
 * sends someone to debug a grinder that is fine.
 */
function classify(text: string): Verdict {
  if (/invalid work|proof of work|powmsg/i.test(text)) return 'refused'
  return 'unknown'
}

async function attempt(label: string, stamper: null | undefined): Promise<Verdict> {
  const board = boardClient(RPC, stamper)
  console.log(`\n--- ${label} ---`)
  console.log('client version', (board as unknown as { version: number }).version)
  const started = Date.now()
  try {
    const work = await board.grind(CATEGORY, payload(label))
    console.log('grind      ', Date.now() - started, 'ms,', String(work.stats.iterations), 'iterations')
    const hash = await board.addMessage(work.message)

    /**
     * Read it back. `addMessage` returning a hash is not proof the board kept the message.
     *
     * The reth tree's own probe carries this check for a measured reason: on 2026-08-21 the node
     * counters read `accepted_local=0` against roughly 1,750 `addMessage` calls while every status
     * field said healthy. An accept that nothing can read is the failure this catches, and it is
     * invisible to a probe that stops at the return value.
     */
    const back = await board.getMessage(hash).catch(() => null)
    if (!back) {
      console.log('NOT KEPT   ', hash, '— accepted, then not readable')
      return 'refused'
    }
    console.log('ACCEPTED   ', hash, '· read back')
    return 'accepted'
  } catch (e) {
    const text = describe(e)
    const verdict = classify(text)
    console.log(verdict === 'refused' ? 'REFUSED    ' : 'NO ANSWER  ', text)
    return verdict
  }
}

const engine = await attempt('the engine the client picked', undefined)
const js = await attempt('the pure-JS reference grind', null)

console.log('\nverdict')
if (engine === 'unknown' || js === 'unknown') {
  // Say nothing about the scheme. Neither grind was judged, so there is no evidence either way.
  console.log('  no verdict: the board never judged one of the grinds. Run it again.')
} else if (engine === 'accepted' && js === 'accepted') {
  console.log('  the board accepts this client. Nothing to do.')
} else if (js === 'accepted') {
  console.log('  the fast engine is behind the reference. Fix the engine call.')
} else if (engine === 'refused') {
  console.log('  the node runs a different scheme than this client. The node is behind, or we are.')
} else {
  console.log('  the engine is accepted and the reference is not, which should be impossible.')
}
