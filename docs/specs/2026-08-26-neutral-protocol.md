> **Reversal / evolution (2026-09-23).** Settlement fee math stays neutral: one pull, book to
> `feeTo`, no `protocolShare`. What returns is **external** FeeSink infrastructure plus a
> settlement-owned allowlist so charging intents cannot name raw EOAs. See
> [`2026-09-23-fee-sink-registry.md`](./2026-09-23-fee-sink-registry.md).
>
> **Later the same day (2026-09-23):** the owner rejected that split, owner-changeable sink.
> [`2026-09-23-fee-sink-fixed-destination.md`](./2026-09-23-fee-sink-fixed-destination.md)
> supersedes it. It is built in `4d48379`: a charging intent must name a registered sink, and
> the owner's one fee power is `registerFeeSink`, which adds a sink and can never remove one.

# prove.cash is neutral, so the settlement has no owner

> **Correction, 2026-09-23. The title is wrong: the settlement has an owner.** The title stays
> because it is the name this decision has carried since 2026-08-26. What the title means is
> that the owner has no power over a fee or over a maker's money.
>
> The owner's whole power set in `contracts/src/ProveSettlement.sol`, all behind `onlyOwner`:
>
> | function | what it does | where |
> |---|---|---|
> | `transferOwnership` | names the next owner (never zero) | built |
> | `setDefaultProceeds` | repoints where `sweepUnowned` sends tokens that no intent, deposit, parked balance or booked fee claims | built |
> | `registerFeeSink` | adds a sink that makers may name, one way and permanent | built in `4d48379`, from `2026-09-23-fee-sink-fixed-destination.md` |
> | `setFeeSinkAllowed` | switched a fee sink on or off | only on `feat/fee-sink-registry` (`ad661e0`). `4d48379` replaced it, so it exists in no built settlement |
>
> What the owner can never do: pause, upgrade, or change the code; set, raise or redirect a fee a
> maker signed; move a reserved deposit, parked capital or a booked fee; cancel an intent for a
> maker; or remove a registered sink or change its destination or floor. No function writes a
> sink's row twice (`test_NoFunctionCanRemoveOrChangeARegistration`). `sweepUnowned` is permissionless, and it moves only the balance that no book
> claims.

**Status: Built** in `84e8895` (2026-08-26). This note records the decision and what it deleted.

## The decision

prove.cash takes no fee. It is a protocol for attributing tokens, and it sends proceeds to other
people's buy-and-burns. It does not hold them, dispose of them, or burn them, and it earns
nothing from a fill.

That is one sentence and it removes most of the fee system.

## What was there

A fee split two ways. The intent named `feeTo` and a rate; the settlement carried a `feeSink` in
storage, a `feeFloorRate` under the maker's rate, and a `protocolShare` deciding how the two
destinations divided what was collected. An owner set all three, and a `feePolicy` seam let a
replaceable contract do the dividing.

The argument for the sink being configuration rather than a signed field was that a fee whose
destination the signer picks is not a protocol fee — name yourself and the protocol earns
nothing.

**That argument is correct and it does not matter, because there is no protocol fee.** A maker
who names themselves has written a worse price in a more complicated way: `feeRate` with
`feeTo = self` is exactly `minOut` raised. There is nothing to defend.

## What is left

```
Intent.feeRate    what this offer charges, signed
Intent.feeTo      where it goes, signed
```

That is all of it. There is no ceiling either — see below.

The registry supplies the default destination — `feeTo` on chain 369 is PulseX's own
buy-and-burn, read off `factory.feeTo()` — and the sign form already offers it as the default
chip. So the burn already reached the maker as a default value in a signed field. The
configuration was describing something the intent had always expressed.

## What this deletes

| | why it goes |
|---|---|
| `feeSink` storage | the intent names the destination |
| `setFeeSink` | **renamed, not deleted** — see below |
| `protocolShare` and its ceiling | one fee, one destination, nothing to divide |
| `feeFloorRate` and its ceiling | a minimum charged to the filler and paid to a destination the maker chose is a forced donation, not revenue. A neutral protocol does not compel one |
| `setFees` | nothing left to set |
| `IFeePolicy` and `setFeePolicy` | the policy existed to divide a fee between two destinations |
| `setFees`, `setFeePolicy` | nothing left to set or to divide |
| `MAX_FEE_RATE` | see below |
| `_rateOf` | it returned the higher of the maker's rate and the floor. With no floor, the rate is the maker's rate |
| `_clampFee` | it bounded a policy's output against the signed rate. With no policy there is nothing to bound, and the caller's own `maxFeeRate` is already checked in `_evaluate`, where a batch can still step over the leg |

**One owner-gated function survives, and it touches no fee and no maker's money.**
`setFeeSink` is a misnomer under this design — the intent always names the destination, and a
test must pin that — so it becomes `setDefaultProceeds`: the address any token that reaches this
contract *unattributed* is sent to.

Immutable would be the stronger claim, and it is the wrong one. If the default destination is a
buy-and-burn EOA and that key rotates or is lost, an immutable address strands every future
sweep for good. A setter can repoint it, and what it can repoint is only value that already
belongs to nobody.

So the sentence on the landing page becomes: the owner can say where lost tokens go, and nothing
else. No pause, no upgrade, no fee, no reach into escrow.

`FeeSink` stops being infrastructure. It becomes one address an intent may name, alongside
PulseX's buy-and-burn and a plain EOA — a prove.cash buy-and-burn is an EOA today and works
unchanged, because `_payFee` transfers to `feeTo` with no code check. Whoever deploys a `FeeSink`
owns it; the settlement does not know it exists.

Three open items dissolve rather than get answered: whether `FeeSink` forwards unarmed tokens,
arming it per token, and choosing `protocolShare`. All three only exist if fees route through a
contract we run.

## The one thing that needs a destination

Tokens reach the settlement that belong to no intent: a plain transfer instead of `deposit`, an
airdrop, a token that rebases up. `_reserved` is keyed by intent hash and there is no per-token
total, so the contract cannot work out which part of its own balance is unclaimed, and nothing
can retrieve it.

The fix is a per-token total and a permissionless sweep. Its destination cannot be `feeSink`
any more, and it must not be a burn — burning would be the settlement deciding what happens to
value rather than saying who it belongs to, which is the one thing this contract does not do.

**`defaultProceeds`, the one address the owner may set.** It is still attribution: anything
unattributed goes here. It is not a reach into anyone's money, because by construction the only
balance it can move is the part no intent has a claim on.

## The ceiling goes too

`MAX_FEE_RATE` capped what a maker could sign. Ask who it protected.

Not the maker — they chose it, and it costs them nothing directly, because the filler pays it.
Not the filler — they pass their own `maxFeeRate` at fill time, and `maxFeeRateFor` computes it
from the legs they are filling. Not the protocol — it earns nothing.

Its stated reason was that an executor could know the worst an intent might ask before reading
the intent. They read the intent anyway, and they set their own bound. A maker who signs a rate
nobody will pay has signed an offer nobody fills, which is their signature to waste.

**What is left as a ceiling is the type.** `feeRate` is a `uint64` against a denominator of
`1e18`, so the largest expressible rate is about 1,844%. That is a consequence of the field's
width and not a decision anybody made about economics, which is the right kind of limit for a
protocol that takes no position.

The arithmetic is safe without it: `delivered` is capped at `uint128` by `_termsOk`, so
`delivered * rate` is bounded by `3.4e38 * 1.8e19 = 6.2e57`, against a `uint256`'s `1.16e77`.

## What does not change

The Dutch decay, the four custody rungs, escrow, the batch
and callback paths, the executors and the venue are all untouched — none of them ever read a fee
dial.
