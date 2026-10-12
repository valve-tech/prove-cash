# Fee disposal: should FeeSink swap, or forward?

**Status: Superseded by [`2026-08-26-neutral-protocol.md`](./2026-08-26-neutral-protocol.md)**
(#117). `cf61733` deleted `FeeSink` on 2026-09-03, and `defaultProceeds` names the buy-and-burn
directly. The measurements below still hold. The note is history, and it said: "proposed.
Nothing here is built. `FeeSink` still swaps."

`FeeSink` collects protocol fees in whatever token a fill charged them in, sells them for PLSX,
and burns the PLSX. Almost all of its 744 lines are swap defence: a time-weighted floor, an owner
floor per token, a slippage cap, a size bound, a block gap, and a keeper tip.

PulseX runs its own buy-and-burn. So we could send it the raw fee tokens and delete the swap.
This document records what that contract actually does, measured rather than assumed, and what
the trade costs.

Every number below comes from mainnet chain 369, read on 2026-08-24 around block 27,372,750.
`contracts/test/ForkBuyAndBurn.t.sol` pins the behaviour against a fork.

## What the PulseX buy-and-burn is

`factory.feeTo()` is `0xd6cA7ee047a6F45d20d2962E4394E070cF27724F`. It is a UUPS proxy. The
implementation is `0x5f02fbb0f8d924e9b67c7daae523ff51175699f9`, verified as
`PLSXBuyAndBurnUpgradeable`. It has burned 1.79 trillion PLSX, so it works and it works at scale.

The entry point is `convertLps(address[] tokens0, address[] tokens1)`.

**It does convert donated tokens.** For each named pair it burns any LP it holds, and the LP step
is skipped when that balance is zero. It then calls `_convertStep(token, balanceOf(address(this)))`
— the contract's whole balance of the named token. So a plain ERC-20 sent to it as a gift is swept
up, bridged toward WPLS, swapped to PLSX, and burned. You do not need to hold LP.

## What it costs

| Control | Live value | What it means for us |
|---|---|---|
| `devCut` | **1429 bps** | 14.29% of every conversion goes to `devAddr` before the burn |
| `BOUNTY_FEE` | 10 bps | 0.1% to whoever calls |
| `devAddr` | `0x3239713576e11082CF9B9cDA9b77468Ea644c682` | not us |
| `anyAuth` | `true` | anybody may call, so we do not need permission |
| `onlyEOA` | `msg.sender == tx.origin` | `FeeSink` can never call it; a bot must |
| `slippage` | 9 | a donation above about a ninth of the pair reserve reverts |
| owner | `0x1AAc90D3409609Dd61aB62ad72372bA9c4d24a40` | UUPS, and `setDevCut` caps at 5000 bps |

The fork test measures it rather than trusting the dial. 100,000 HEX donated at block 27,260,000
produced 34,463,688.58 PLSX. `devAddr` took 4,924,861.10 of that — 14.29% to the wei. The burn was
85.62% of the total.

So forwarding costs about **14.4% of the fee stream**. Our own route costs the AMM fee for each
hop plus up to 2% of keeper tip, so call it 2–3%. The gap is about eleven points.

The gap is not fixed. The owner can raise `devCut` to 50% with one call, and can upgrade the
implementation. We would get no notice and have no recourse.

## Never forward a wrapper

An x402 wrapper is a 1:1 claim on an underlying token. `FeeSink` already redeems one at par
instead of selling it, because selling a par claim on an AMM pays slippage for nothing.

Sending a wrapper to the buy-and-burn strands it **permanently**. `convertLps` calls
`_getValidPair` and rejects the batch with `PLSXBuyAndBurn: Invalid pair` before it converts
anything. The x402 wrapper for PLSX has no pair against WPLS or PLSX, so nobody can name it in a
batch. `_convertStep` only ever runs on named tokens, so the balance is unreachable rather than
merely unconverted.

There is no way in by another route either. `bridgeFor` returns WPLS for anything with no bridge
set, so even a wrapper that somehow had a pool against an unrelated token would send `_swap` to a
missing x402/WPLS pair and revert with `PLSXBuyAndBurn: Cannot convert`.

An earlier draft of this note claimed a donated wrapper would revert other people's batches. That
is wrong. The pair check refuses the batch before the swap, so the wrapper harms only us.

## We cannot sell a taxed token. PulseX can.

`buyback` calls `swapExactTokensForTokens`, the router's plain variant. A real UniswapV2 pair
checks k after the transfer, so a swap whose input arrives short of `amountIn` reverts with
`UniswapV2: K`. A fee-on-transfer token always arrives short. So the sink can never sell one, and
a taxed fee accumulates in it for good.

PulseX's buy-and-burn does not have this problem. `_swap` transfers to the pair, then reads
`balanceOf(pair) - reserveInput` to learn what actually arrived, and its own comment says this
accounts for transfer taxes. It then calls `pair.swap` directly rather than going through a
router.

`contracts/test/FeeSinkMatrix.t.sol` pins our side of this. The local mock pair has no k check, so
the sale completes there; the test measures the reserve product falling, which is the number a
real pair reads before it refuses.

This changes the case for forwarding. For a fee-on-transfer token, forwarding is not the cheaper
route — it is the **only** route. 14.29% of something beats all of nothing.

There is a second answer, and it may be the better one: switch `buyback` to
`swapExactTokensForTokensSupportingFeeOnTransferTokens` and measure the PLSX delta against
`minPlsxOut` ourselves. The supporting variant returns no amounts, so the bound has to move from
the router's answer to our own measurement. `FeeSink` already measures deltas in `_unwrap`, `buyback` and `_burn` and in
`_burnOrSend`, so the pattern is in the file. That keeps taxed tokens on the 2–3% route instead of
the 14.4% one.

## Which tokens carry which gasless rung

Relevant because the wrapper exists to add EIP-3009, not to add permit.

| Token | permit (2612) | 3009 |
|---|---|---|
| PLSX | yes | no |
| x402-PLSX | yes | yes, including the ERC-7598 `bytes` variant |
| WPLS | no | no |
| HEX | no | no |

PLSX already carries permit, so a wrapper was never needed to make PLSX gasless. The wrapper adds
3009, which the x402 payment protocol requires. It also carries `wrapWithPermit`, so a holder can
enter the wrapper from a signature and spend no gas of their own.

The wrapper implementation at `0x78016463124783829764aa74cb98549ecbdb7bcf` is **not verified** on
the explorer. Each wrapper is a minimal proxy, so an instance cannot be upgraded, but nobody can
read what the instances run. Treat that as a gate in front of any plan that routes user money
through one.

The two largest tokens after PLSX carry neither rung. So the standing approval to `ProveRelayer`
covers what the gasless rungs cannot, and it covers every token. Both gasless rungs are minority
paths on this chain.

## Recommendation

Keep our own swap for the tokens that carry the volume. 14.29% is too much to give away on the
main flow, and the machinery already handles those tokens.

Use the forward as the **fallback for unarmed tokens**. An empty route means disarmed today, so
anything the owner has not vetted simply accumulates. Forwarding the tail costs 14.4% of a small
number and removes the standing burden of arming every new token with `setMinPrice` and
`setRoute`. That bounds the tax to the tail and keeps the owner's lever.

Always unwrap before forwarding. Never send a wrapper.

## What this does not block

`ProveSettlement.feeSink` is a storage variable with a setter, not an immutable. So we can deploy
with the current `FeeSink` and point the settlement at a new one later. **This decision does not
block the mainnet deploy.**

## Two operational hazards the matrix found

Neither is a defect. Both bound which tokens the owner can safely arm.

**A coarse-decimal token needs a floor scaled to its own unit.** `minPlsxPerUnit` is PLSX wei per
*smallest unit*, times `PRICE_SCALE`. A floor copied from an 18-decimal token rounds to zero
against a 2-decimal slice, and the sale then refuses with `NoPriceFloor`. The contract fails safe.
The hazard is that somebody copies a floor and the token silently never sells.

**A token that blocks the sink strands its fee for good.** There is no rescue path, deliberately.

## Decided, 2026-08-31

Both of the first two are settled, and they turned out to be one question.

**An unarmed token is held. Nothing forwards it.** Refusing was never available — an ERC-20
transfer asks nobody's permission — so the choice was forward or hold, and forwarding loses on
three counts. The 14.29% is not fixed: `devCut` is one owner call away from 50% behind a UUPS
proxy under a key we do not hold, with no notice and no recourse. A wrapper sent there is
stranded permanently rather than merely unconverted, so the fallback carries a trap that must
never fire. And holding costs nothing: `setMinPrice` then `setRoute` releases the token to
anybody who wants to sell it, which is the vetting the two-call arming exists for.

`FeeSink.saleable(token)` reports which state a token is in, so an operator can read the parked
set instead of discovering it one reverted simulation at a time.

**`buyback` uses the supporting swap variant.** This is what makes holding the right answer
rather than a way of losing tokens quietly. It was a one-line change, because nothing downstream
ever read the router's return value — `bought` is the sink's own PLSX delta and both bounds are
checked against it.

One bound remains, and it is worth stating rather than hiding: the keeper's `minPlsxOut` must
clear `getAmountsOut(whole slice) * (1 - maxSlippageBps)`, and that quote assumes the whole slice
arrives. A tax wider than `maxSlippageBps` — capped at 10% — cannot produce a bound both checks
accept. Such a token is unsellable here, and the answer to that is the one above: the owner does
not arm it.

`test/FeeSinkMatrix.t.sol` Row 4 measures both halves now. `MockV2Pair` checks k, so the row
proves the pair's own rule instead of describing it in prose.

## Open

- `protocolShareBps` is still provisional at 5000. See `contracts/config/369.json`.
- If fees ever accrue as internal balances instead of transfers, `FeeSink` stops working. It
  expects to receive real tokens it can sell.
