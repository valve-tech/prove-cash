# The solver: ring matching over signed intents

**Status: Built, and this note covers only its core** (checked 2026-09-23). The five files in
"Shape of the implementation" exist. `sdk/src/solver/` now has 21 modules that are not tests,
and this note names five of them. `_deliverOnly`, which the next section names, no longer exists
in `ProveSettlement`. The ring algebra here still holds; read the code for everything else.

A solver reads the order book, finds sets of intents that pay for each other, and settles them
in one transaction. This document fixes the algebra, so the implementation and the tests can
disagree with each other loudly instead of quietly.

## What the contract gives the solver

For intent `i` filled for `take` at time `t`, `ProveSettlement` does two things:

- `_release` sends `take` of `tokenIn` to the executor.
- `_deliverOnly` pulls `delivered` of `tokenOut` from the executor to the recipient, and
  `_deliver` pulls `fee` more to the sink.

So the executor **receives** `take` of token A and **pays** `delivered + fee` of token B. Nothing
nets automatically. A ring is profitable only when the amounts the executor receives cover the
amounts it pays, token by token.

Write the marginal rate of intent `i` at time `t` as

```
r_i(t) = minOutAt(i, t) / amountIn_i        # tokenOut per tokenIn
```

`minOutAt` decays from `minOutStart` to `minOutEnd` between `startTime` and `endTime`, so **an
intent gets cheaper for the executor as it ages**. A ring that is unprofitable now may become
profitable later, and the solver must be able to say when.

The exact integer forms, which the solver must reproduce bit for bit:

```
delivered = ceilDiv(take * minOutAt(i, t), amountIn_i)
gross     = ceilDiv(delivered * feeBps, 10_000)
fee       = gross - (gross * executorRebateBps) / 10_000
```

With the deployed settings — `feeBps = 10`, `executorRebateBps = 2000` — the executor pays about
8 basis points on top of every delivery. Call that `φ = 8e-4`. Read both values from the chain;
the owner can change them.

## When a ring closes

Take a cycle of tokens `T₁ → T₂ → … → T_n → T₁`, where intent `k` sells `T_k` for `T_{k+1}`.
Let `a_k` be the amount taken from intent `k` and `p_k = delivered_k + fee_k` the amount paid.

The executor's balance in `T_k` changes by `+a_k` (from intent `k`) and `−p_{k−1}` (paying for
intent `k−1`). It must not end negative:

```
a_k ≥ p_{k−1}    for every k
```

Since `p_k ≈ a_k · r_k · (1 + φ)`, chaining the inequalities around the cycle gives

```
a₁ ≥ a₁ · Π r_k · (1 + φ)^n
```

which holds only if

```
Π_k r_k · (1 + φ)^n ≤ 1          ← the ring condition
```

**For a two-leg ring at today's fee, the two makers together must concede at least 16 bps.**
The product of their two minimum rates has to be at most `1 / 1.0016 ≈ 0.998402`. That number is
the whole business: it is the spread the protocol needs to exist.

Equivalently, take `−log r_k` as an edge weight and a profitable ring is a negative cycle. With a
length cap of three, do not run Bellman-Ford — enumerate.

## Sizing a ring

Set every leg to the tightest amount that still closes:

```
a₁  = the free variable
a_{k+1} = p_k = delivered_k + fee_k          for k = 1 … n−1
profit  = a₁ − p_n                           denominated in T₁
```

Pick the largest `a₁` that keeps every leg inside what is left of its intent:

```
a₁ ≤ remaining₁,   a₂ ≤ remaining₂,   …,   a_n ≤ remaining_n
```

Compute this with bigints and the exact `ceilDiv` above — never floating point. The rounding is
against the executor at every step, so a ring that clears by one wei in rational arithmetic can
fail in integer arithmetic. Estimate `a₁` with rationals, run the exact integer chain, and shrink
if a leg overflows its remaining. Then simulate the real call; the simulation is the ground truth,
not the arithmetic.

**Intents without `FLAG_PARTIAL` pin their leg**: `a_k` must equal exactly the remaining amount.
One pinned leg determines the whole ring. Two pinned legs almost never agree, so check and drop.

## Working capital

`fillBatch` settles legs in order, and each leg pays before the next leg's receipt arrives. Going
round a cycle, the executor must therefore front every payment but one.

**This section said `capital = Σ p_k − max_k p_k`. That was wrong twice, and running it found
both.**

Wrong first because the payments are in different tokens, so the expression sums quantities that
do not add. Capital is a **list, one entry per token paid before the last leg**, and the list
depends on which rotation the operator picks. Report the list.

Wrong again because of *which* payment the first receipt covers. It is always the last one in the
rotation — and that is the **smallest** of them, because the value sheds a maker's concession at
every step around the ring. No rotation skips the largest payment, so subtracting `max p_k`
understates what the solver has to hold. Measured on a three-leg ring of real pools: the true
requirement was 2,002,207 WPLS-equivalent where the formula claimed 1,997,375, short by 0.24%.
A solver sized by the formula would be short every time, by a little.

The report errs the other way, and deliberately. It asks for `delivered + fee` per leg, while a
leg's true peak need is `delivered`: `fillBatch` accumulates the protocol fees and flushes them at
a token boundary rather than per intent. Being asked to hold slightly too much is the right
failure direction.

For a two-leg ring the capital is a single payment, and it comes straight back in the same
transaction.
This is a real constraint on who can solve, and it is the reason a `fillBatchWithCallback` — one
release pass, one callback, one verification pass — is worth adding. Until it exists, a solver
holds inventory.

**Set `skipInvalid = false` for a ring.** Skipping a leg would settle the others and leave the
solver holding an unhedged position. A ring is atomic or it is nothing.

## Closing through an AMM

A ring does not have to close through intents alone. The last leg may be a PulseX swap, which
turns a thin book into a usable one:

- **One intent plus the AMM** — fill, then sell the token received. This is plain arbitrage and
  the existing executor bot already does it.
- **Two intents plus the AMM** — the pair nets most of the way and the pool covers the remainder.

An AMM leg brings slippage and a swap fee, so price it with `getAmountsOut` rather than a spot
ratio, and treat the router quote as a bound that can move before inclusion.

## Which intents are eligible

Before any of the above, an intent has to be fillable. `fillability(intent, signature, take,
executor)` returns a single reason code covering expiry, cancellation, the nonce floor, the
executor restriction, the amount already filled, partial-fill permission, escrow funding, and —
in its deep mode — the maker's live allowance and balance. Batch those calls through multicall
and let the chain answer. Do not re-derive the rules off-chain; that is how a solver and a
settlement contract drift apart.

## Whether it is worth doing

```
profit_in_T₁ − gasUsed · gasPrice · price(PLS → T₁) > 0
```

Estimate `gasUsed` from a simulation, not from a constant. Convert with the same router quote the
solver already fetched. A ring that clears by less than its own gas is not a match.

## Shape of the implementation

```
sdk/src/solver/
  book.ts     order book: live intents indexed by (tokenIn, tokenOut)
  rings.ts    enumerate 2- and 3-cycles, apply the ring condition
  size.ts     exact integer sizing against remaining amounts
  price.ts    AMM reference prices and the gas conversion
  plan.ts     a ranked, simulated, executable plan
```

The engine is a pure function from a book and a timestamp to a list of plans. Keep it that way:
it makes the interesting cases — a ring that only closes after ten minutes of decay, a ring that
integer rounding kills — testable without a chain.
