/**
 * The solver's two opt-in flags, resolved where a test can reach them.
 *
 * Both change what the bot spends money on, both refuse at startup rather than warning, and
 * neither had a test. `solver.ts` says why that matters in its own words: "the lab chain has no
 * board at all, which is how a flag as consequential as `--batch` reached this file with nothing
 * but its own guards tested". A guard nothing attacks is a guard nobody defends, so the guards
 * live here and `flags.test.ts` attacks them.
 *
 * **"Tolerant" means one thing in this repository**: a transaction sent with `skipInvalid` true,
 * which steps over a leg it cannot settle and fills the rest instead of reverting. `--batch`
 * makes a set of independent plans tolerant. `--tolerant` makes a RING tolerant, which needs more
 * than a flag — a cycle minus a leg is not a cycle, so the route has to carry a market that buys
 * what the missing maker was going to supply.
 *
 * Refusing at startup rather than warning, for both. A bot that runs for a week doing none of
 * what its command line asked for is worse than one that will not start.
 */
import type { Address } from 'viem'

/** What the rest of the command line already decided, and what these two flags depend on. */
export type FlagWorld = {
  /** The `ProveBatchExecutor` from `--credit`, or null when the bot settles from its own stock. */
  credit: Address | null
  /** Whether `--amm` is on, so the engine is given a market lookup at all. */
  amm: boolean
}

/**
 * `--batch`: the executor to pack independent plans through, or null to send each on its own.
 *
 * Off by default. What it buys, from the generated rows in `app/src/landing/gas.ts`: a batched
 * leg costs 86,994 gas and the same leg sent alone costs 148,754, so batching saves 60,408 a leg.
 * Eight singles cost 1,190,037 against 695,959 for one batch of the same fills. And a
 * leg a rival took first costs 15,982 inside a tolerant batch while every other leg still fills;
 * sent as a single, that same lost race is a whole reverted transaction that fills nothing.
 *
 * It needs the other two flags, and neither is a detail:
 *
 *   --credit   `settleBatchCall` goes to `ProveBatchExecutor` and there is no inventory-path
 *              version of it. A tolerant batch needs a contract holding the released tokens,
 *              because only code inside the transaction can see which leg was stepped over and
 *              drop the venue call that existed for it.
 *   --amm      every packable plan carries a pool swap by definition — `isIndependent` refuses a
 *              plan without one, since then another leg would have to pay its maker. With pool
 *              legs off there is nothing to pack, so `--batch` alone would pack nothing every
 *              tick and never say why.
 */
export function batchExecutorFlag(argv: readonly string[], world: FlagWorld): Address | null {
  if (!argv.includes('--batch')) return null
  if (!world.credit) {
    throw new Error('--batch settles through ProveBatchExecutor. Pass --credit <address> too.')
  }
  if (!world.amm) {
    throw new Error('--batch packs pool-closed plans, and there are none of those without --amm.')
  }
  return world.credit
}

/**
 * `--tolerant`: carry a market fallback per leg, so a ring that loses one settles anyway.
 *
 * **Off by default, and the default is the point.** A fallback is carried on every ring and paid
 * for on every ring, to save the loss on the few rings that lose a leg. `breakEvenLossRate` in
 * the SDK turns those two costs into the rate above which it pays — about 22% for a three-leg
 * ring, on gas alone. Nobody has measured a live board's rate. Until somebody has, this is a
 * per-operator decision made on a command line, not one that arrives with a deploy.
 *
 * It needs the same two flags as `--batch`, for two different reasons:
 *
 *   --credit   a fallback is a `WHEN_ABSENT` swap inside a `Route`, and only `ProveBatchExecutor`
 *              reads one. There is no inventory-path version.
 *   --amm      a fallback IS a market leg. Without a market lookup the planner has nothing to
 *              size one from, so every leg would be refused on every tick and the flag would do
 *              nothing while appearing to be on.
 *
 * A boolean and not an address: the executor is already named by `--credit`, and asking for it
 * twice is one more place for two answers to disagree.
 */
export function tolerantRingsFlag(argv: readonly string[], world: FlagWorld): boolean {
  if (!argv.includes('--tolerant')) return false
  if (!world.credit) {
    throw new Error('--tolerant carries fallbacks in a route. Pass --credit <address> too.')
  }
  if (!world.amm) {
    throw new Error('--tolerant needs a market per leg to fall back to. Pass --amm too.')
  }
  return true
}
