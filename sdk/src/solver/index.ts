/**
 * @prove.cash/sdk/solver — ring matching over signed intents.
 *
 * A solver reads the order book, finds sets of intents that pay for each other, and settles them
 * in one transaction. Two makers going opposite ways on the same pair need not agree on a price;
 * they only need to concede, between them, more than the protocol charges. That is the whole
 * business, and this package is the machine that looks for it.
 *
 * The layers, bottom up:
 *
 *   abi      every call shape the solver puts on the wire, isolated in one file
 *   arming   which legs the solver can reach, and the signature bytes that reach them
 *   book     live intents, indexed by pair, with the chain's own verdict on each
 *   confid.  how certain each leg of an atomic batch is, and the order that makes a break cheap
 *   depth    how many entries each direction keeps, per token, so a hub indexes deeper
 *   price    pool snapshots, the AMM curve in exact integers, and WPLS valuation
 *   graph    a bounded pool graph on chain reserves, and routes of up to three hops over it
 *   subgraph which pairs exist, from PulseX's subgraphs: discovery only, never a price
 *   graphsync  how the graph stays true: a first chain read per pair, then `Sync` logs per tick
 *   rings    2- and 3-cycles, and the condition `Π r_k · (1 + φ)^n ≤ 1`
 *   size     the integer sizing that decides what a cycle is actually worth
 *   tolerant a market fallback per leg, so a ring that loses one settles instead of reverting
 *   mempool  which legs a rival's pending transaction already names, before this solver sends
 *   plan     the engine: a pure function from a book and a timestamp to ranked plans
 *   groups   which plans can settle together, once a maker's balance and permit nonces are
 *            counted as the shared things they are
 *   dryrun   the chain's own answer on a chosen set, and the bisection that follows a no
 *   trust    which makers this solver will risk its own gas on, and what a failure buys back
 *   execute  simulate, then send
 *
 * The engine is pure on purpose. A ring that only closes after ten minutes of Dutch decay, a
 * ring that integer rounding kills, a ring with one all-or-nothing leg — all of them are unit
 * tests, not chain tests, because `solve` takes its world as an argument. `dryrun` keeps the one
 * question only a chain can answer behind a one-function boundary, for the same reason.
 *
 *   import { loadBookFromStore, loadPools, loadPrices, solve, selectFeasible } from '@prove.cash/sdk/solver'
 */

export * from './abi.js'
export * from './arming.js'
export * from './book.js'
export * from './confidence.js'
export * from './depth.js'
export * from './dryrun.js'
export * from './execute.js'
export * from './graph.js'
export * from './graphsync.js'
export * from './groups.js'
export * from './market.js'
export * from './mempool.js'
export * from './pack.js'
export * from './plan.js'
export * from './price.js'
export * from './rings.js'
export * from './size.js'
export * from './subgraph.js'
export * from './tolerant.js'
export * from './trust.js'
