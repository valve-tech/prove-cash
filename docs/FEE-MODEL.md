# Who gets what, and what decides it

Rewritten 2026-10-03 for the fee config hash (branch `feat/fee-config-hash`). The sink registry
(`registerFeeSink`, `feeSinks`, `FeeSink`, `feeTo`, `minRate`) is gone. This file says what each
party gets, which inputs decide it, and what bounds it. `contracts/src/ProveSettlement.sol` is
the authority; each formula here names the function that computes it, not a line number, so it
does not rot. Spec: `docs/specs/2026-10-03-fee-config-hash.md` (not in this tree
yet; this file was written from the design as built).

Read this before you write a number on a screen. Three defects on 2026-09-03 came from the same
missing thing — no written answer to "what does this quantity depend on" — and each printed a
figure that was individually correct and wrong beside its neighbour.

---

## Part 1 — The table

| Party | Gets | Computed at | Depends on |
|---|---|---|---|
| **Maker** | `owedToMaker − feeProceeds` (P3 comes out of it) | `TakePoints.price` via `_quote` | the signed curve, the fill time, the signed P3 rate |
| **Fee destinations** | `feeIn` (tokenIn), `feeOut + feeProceeds` (tokenOut), by weight | `claim`, from the book | the signed config and its weights |
| **Filler (solver)** | pays `owedToMaker + feeOut` in tokenOut and `feeIn` in tokenIn | `_quote` | the curve, the fill time, **P1 and P2** |
| **Pool**, **validators** | their own fee, price impact, gas | not on chain | nothing the maker signed |
| **Project** | nothing, no protocol fee | — | — |

The solver's take stays a residual nobody computes on chain: what the sale realised, less what
the settlement made them pay out, less gas.

## Part 2 — Three take points, one config

An intent signs one `feeConfig` (a bytes32) and three rates. A fill reserves up to three fees
under that one key:

| Point | Field | Token | Taken | Borne by |
|---|---|---|---|---|
| **P1 handover** | `feeRateIn` | tokenIn | `floor(take × feeRateIn / WAD)`, as the tokens leave the maker's escrow for the filler; covers the filler's gas | the solver |
| **P2 output** | `feeRate` | tokenOut | `floor(owedToMaker × feeRate / WAD)`, **on top of** `owedToMaker` | the solver |
| **P3 proceeds** | `feeRateProceeds` | tokenOut | `floor(owedToMaker × feeRateProceeds / WAD)`, **out of** `owedToMaker` | the maker |

`owedToMaker = ceilDiv(take × minOutAt(i, ts), amountIn)`, the curve, rounding up. Every fee
rounds down, so the dust stays with whoever bears it. `ProveSettlement.quote(i, take, ts)` returns
all of it in a `TakePoints.Quote` (`owed`, `feeIn`, `feeOut`, `feeProceeds`, `delivered`, and
what each side handles); `ProveReader` and the SDK call this very function.

**The maker's guarantee.** P1 and P2 are charged to the filler, so a maker who signs P2 loses
nothing from it: `delivered = owed − feeProceeds`, and with P3 = 0 that is `owed`. Only P3 reduces
the maker's delivery. A maker who wants a net `N` under P3 signs a gross
`G = ceil(N × WAD / (WAD − r))`; then `G − floor(G × r / WAD) ≥ N`.

**The solver pays for P1 and P2**, so the solver prices them. A fill is profitable when
`proceeds − owed − feeOut − feeIn(in output terms) − gas > 0`. The SDK solver (`legPay`,
`legRate`, `takeFor`, `rationalCeiling`, `edgeOf`) does this; the rates therefore move the time a
decaying offer fills, unlike the old design where the rate came out of the maker's number.

**`maxFeeRate` bounds `feeRateIn + feeRate`** — the two costs the solver bears. It is a
per-call filler choice, not a protocol ceiling. P3 is the maker's own and is not bounded by it.

**Zero config means no fee at all.** `feeConfig = 0` with any non-zero rate is `BadTerms_`: a
signed rate is never silently dropped. Each rate is capped at `WAD` by `_termsOk` (arithmetic, not
policy). Nobody rules on the number below that.

## Part 3 — The config hash, the book, `claim`

`feeConfig = hashStruct(FeeConfig{address[] destinations, uint256[] weights})` in EIP-712 form
(`FeeConfig.hash`). A config is valid when it has 1 to 8 destinations (`MAX_DESTINATIONS`), strictly ascending
by address (so no duplicates), none zero, one weight each, and the weights sum to exactly one `WAD` (`FeeConfig.fault`).
The settlement never looks inside the hash during a fill and **never calls a destination**: it
reserves under `_pendingFees[feeConfig][token]`.

`claim(cfg, token)` is open to anyone. It checks `cfg` against the key, zeroes the cell, pays the
destinations by weight and emits `FeeClaimed`. One destination gets a plain transfer; with several,
each share is a transfer capped at 200,000 gas, and a share that fails is re-booked under that
destination's one-destination config (`FeeConfig.singleHash`) and emitted as `ShareDeferred`, so
no destination blocks the others. `paid + deferred` is the cell, always. `relayer` and the
settlement may not be destinations. `announceFeeConfig(cfg)` logs the preimage for indexers; it
gates nothing, and an unannounced config is just as valid.

`claim` and `announceFeeConfig` live in the linked library `FeeClaimLib` (spec 2.3, option C).
The settlement `DELEGATECALL`s it, so it runs on the settlement's storage. The library has no
owner, no storage, no `SELFDESTRUCT` and no `DELEGATECALL` (`FeeClaim.t.sol` checks the
deployed bytecode); its address is fixed in the settlement's bytecode at link time. This is a
trust surface the old design did not have, and it changes the runtime bytecode that
`contracts/tools/bytecode-pin-*.json` pin (Part 5).

**Stray tokens.** The constructor takes a stray config (immutable `STRAY_CONFIG`): `sweepUnowned`
books unattributed tokens under it, and `claim` pays them out like any other book.
`sweepUnowned` subtracts `totalReserved`, `totalParked` and `totalPendingFees`, so the owner's
sweep cannot reach a booked fee. `contracts/config/fee-configs.json` carries the stray config per chain.

## Part 4 — Defaults, advice and the reader

`FeeDefaults` is **advice only**: the project's suggested config, the suggested rate at each
point, and a warning threshold at each point. The settlement does not read it and does not know
its address. The owner (two-step handover) has one power, `setDefaults(cfg, rates, warn)`, which
appends a history entry carrying the full preimage; nothing is overwritten, `at(0..versions()−1)`
is the audit trail and `DefaultsSet` carries the same. An app signs the defaults' config hash at
the defaults' rates unless the maker overrides; it shows the warning when a rate is above the
warn threshold or the config is not one the defaults name. **Initial defaults: P2 0.5% to a burn
destination, P1 and P3 zero, warn 1% at every point.**
`contracts/config/fee-configs.json` mirrors the history; `FeeConfigsJson.t.sol` recomputes every
hash and `app/scripts/check-fee-configs.ts` (CI) holds the file to the chain's `DefaultsSet` logs.

`FeeConfigView` holds the pure config math and `ProveReader` holds the reads that used to cost
settlement bytecode: `available(Intent)`, `fillability`, `dryRun`, `quote`. **`available` and
`ratesOf` are not on the settlement any more** (766 B and about 189 B). `ProveReader.available` uses
`IntentTerms.ok`, a copy of the settlement's `_termsOk`; a copy cannot be shared without growing
the settlement by 324 B, so `ProveReader.t.sol` pins it to `fillability` by fuzz
(`testFuzz_AvailabilityUsesTheSettlementsTermsRule`). Any change to `_termsOk` must change both.

**The wallet limit.** A wallet cannot sign `feeConfig = 0` as typed data (a struct hash cannot be
zero), so a wallet-signed offer names a config at rate 0. Only a local key, signing a raw digest,
reaches the zero hash. The SDK's `signIntent` says so.

**Wire.** The intent codec is v5: a 32-byte config hash, a `P_FEE_EXT` byte for P1/P3. Old board
posts are unreadable.

**The preimage block.** A board post can carry its config's preimage, so a solver or indexer that
meets an unknown hash can show and claim it without a chain read. It is optional and sits inside
v5, not in a v6: bit 2 of the `P_FEE_EXT` byte (`FEE_EXT_PREIMAGE`) says a block follows the P1/P3
rates. The block is a count byte `n` (1..8), `n` 20-byte destinations, and `n − 1` 8-byte weights;
the last weight is `WAD − sum`. One destination costs 21 bytes, two 49, eight 217, plus the
extension byte when the intent carried no P1/P3 rate. A post without the block is byte-identical to
one encoded before the block existed. The decoder drops the whole post when the block is truncated,
names 0 or more than 8 destinations, has weights that reach `WAD`, is not canonical (sorted,
distinct, no zero address or zero weight), or does not hash to the intent's `feeConfig`. The encoder
refuses the same. Nothing about the block is signed, and nothing needs to be: it is checked
against the signed hash.

The block is for configs a reader cannot already know. The app attaches it only for a config its
build does not ship (`forTheBoard` in `app/src/lib/fee.ts`); a shipped chain default goes without.
The same rule covers an RFQ quote's intent (`MakeQuote`) and the mirror in a signed pair
(`encodeTicket`). A reader learns a preimage through `readIntent`, which keeps it only once the
post's signature verifies (the store's `ingest` does the same after `verifyOnce`), into a bounded
store of its own (`WIRE_CONFIGS`, 1,024 entries, least recently seen out first: a preimage seen
again moves to the back), so evicting an entry costs a signature and not only proof of work. That store is kept apart from `KNOWN_CONFIGS` on purpose:
`KNOWN_CONFIGS` is the sign form's guard, and a stranger's post must not make an unshipped config
look acknowledged. `feeConfigPreimageOf` and `claimFeesFor` read both stores. A reader built
before the block drops the posts that carry it (an unknown extension bit) and reads every other
post as before.

## Part 5 — What bounds each of them, and the bytecode

| Bound | Where | What it stops |
|---|---|---|
| each rate ≤ `WAD` | `_termsOk` | `fee > owed` and the underflow; arithmetic, not policy |
| `feeConfig = 0` ⇒ all rates 0 | `_termsOk` | a signed rate silently dropped |
| `feeRateIn + feeRate ≤ maxFeeRate` | `_evaluate` → `FeeTooHigh_` | a filler engaging with a rate they chose not to; per call |
| `minOutEnd ≤ minOutStart`, both `≤ uint128` | `_termsOk` | a reversed curve; `take × minOutAt` leaving a word |
| `recipient` not this contract or the relayer | `_termsOk` | a delivery nobody can retrieve |
| one custody flag per intent | `_termsOk` | an ambiguous arming path |
| config shape | `FeeConfig.fault`, in `claim`, `announceFeeConfig`, the constructor, `setDefaults` | a book nobody can pay out |
| `claim` of an empty book pays nothing, no event | `FeeClaimLib.pay` | noise |

There is no bound on `curve`, no bound on the window, and no protocol fee.

**EIP-170.** `ProveSettlement` runtime is **23,427 B** against 24,576 B: **1,149 B of margin** (it
was 24,382 B, 194 B, before `available` and `ratesOf` left). `ProveReader` is 21,627 B (2,949 B).
`optimizer_runs` is 200; below that buys under 100 B. Kept on the settlement on purpose:
`FeesTaken` (213 B; indexers and keepers read it), `nonceFloor`, `laneFloor`, `fillability`,
`dryRun`, `park`, `fillBatch` and the `announceFeeConfig` wrapper (about 200 B), all features.

**Bytecode pins.** The old 943 and 369 deployments are ABI-incompatible with this change
(different `Intent` typehash `0xc1e92b74…`, no sink functions, new constructor), so both chains need
a redeploy; nothing is upgraded in place. The library link and the new runtime change every
bytecode pin (`bytecode-pin-943.json`, `verify-bytecode.mjs`) and the unlinked-placeholder
caveat applies: the pin is of the runtime with the library address filled in, so it is regenerated
after the deploy (see the operator redeploy runbook).

## Part 6 — The rule that would have caught all three

Every quantity is either **signed** or **live**, and mixing them is the bug.

- **Signed** — fixed when the maker put their name to it: `amountIn`, the whole curve, the rate,
  the destination, the window, the rung. Also anything derived from them at signing time, such as
  `suggestStart`'s opening price.
- **Live** — true only right now: the pool price, the reserves, the base fee, the proceeds, the
  solver's residual, whether it fills.

Two directions, both wrong:

1. **A live input reaching a signed quantity.** The console passed live gas into `suggestStart`,
   so dragging the base fee moved the maker's curve and shifted the fee-versus-solver split. A
   maker's signed terms cannot respond to what gas does afterwards.
2. **A signed-time rule answering a live question.** The break-even size was computed at the floor
   against a flat market and printed beside a spread bar computed at the current moment against
   the live market, so it read "no size" while the bar showed a healthy margin. Both were correct;
   together they were nonsense.

Three checks before a number ships:

- **Name its context.** Signed or live. If you cannot say which, it is not ready.
- **Check its neighbours.** Two figures side by side must share a context, or say plainly that
  they do not.
- **Use one definition per word.** "The solver's take" was `spread − fee` in one component and
  `spread − fee − gas` in another, on one screen. Pick one, write it here, and make every
  component read it.

---

Written 2026-09-03; rewritten 2026-09-05 (#119) and again 2026-10-03 for the fee config hash, from
`ProveSettlement.sol` as it stands in this commit. If this file and the contract disagree, this
file is wrong and the contract is right.
