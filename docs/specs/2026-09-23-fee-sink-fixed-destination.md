# Fee sinks with one fixed destination

> **Superseded by `2026-10-03-fee-config-hash.md` (2026-10-03).** The sink registry, `FeeSink`, `registerFeeSink`, `feeTo` and the owner-gated settlement were all removed on `feat/fee-config-hash`. Kept as history; the body below is unchanged.

**Status: Built in part.** Approved by the owner on 2026-09-23. Supersedes the split design in
`2026-09-23-fee-sink-registry.md`. **Contracts: Built** in `4d48379` (the sink, the registry, the
terms check, the claim, the deploy scripts) and `64224af` (B-2, found while building it), on
`feat/fee-sink-fixed`, not yet on `master`. **SDK and app: in progress** on `sinks-app`.
**Docs:** this pass.

## The rule

A fee sink is one destination, fixed for all time. The settlement is the registry. An intent that
charges a fee names one registered sink. What a maker signs is where the fee goes, for the life of
the intent, and nothing can change it afterwards.

The owner's words, in order:

- "we need one destination, we need 1 sink per intent"
- "the fees can never be updated after the fact without also being checked by the fee sink"
- "as long as that configuration matches or exceeds what is set on the fee sink/what the fee sink
  allows"
- "a fee sink should be linked to a destination for all time. if we want to handle multiple
  destinations then all we have to do is register them with the escrow/orchestrator"

## What this replaces

The owner's branch `feat/fee-sink-registry` (commit `ad661e0`) built two sink contracts:

| contract | destinations | who can change them |
|---|---|---|
| `FeeSink` | 1 to N, with WAD weights | its owner, any time, through `setSplits` |
| `ForwardFeeSink` | exactly 1 | nobody |

`FeeSink`'s owner could redirect a fee after the maker signed. The owner rejected that. The
splitting `FeeSink` is deleted. `ForwardFeeSink` is the right shape, and it becomes `FeeSink`.

The branch's settlement allowlist let the owner switch a sink off. That bricks every signed intent
that names it. Registration becomes permanent.

## Design

### `FeeSink` — an immutable record

```solidity
contract FeeSink {
    address public immutable destination; // never zero
    uint256 public immutable minRate;     // fraction of 1e18; 0 means no floor
    constructor(address destination_, uint256 minRate_);
}
```

- No owner, no setters, no admin.
- `minRate <= 1e18`. The constructor refuses zero `destination` and `minRate > 1e18`.
- It never holds a token. The settlement pays `destination` directly (see Claim).

### Registry — in the settlement, append only

```solidity
struct Sink { address destination; uint256 minRate; }
mapping(address => Sink) public feeSinks;       // sink address → its copied terms
function registerFeeSink(address sink) external onlyOwner;
event FeeSinkRegistered(address indexed sink, address indexed destination, uint256 minRate);
```

- `registerFeeSink` reads `destination()` and `minRate()` from the sink **once**, stores a copy,
  and refuses a sink that is already registered, has no code, or reports a zero destination.
- The copy can never go stale, because the sink's fields are immutable.
- There is **no unregister**. A registered sink stays valid forever.
- The owner's power is one-way: it can add a destination makers may choose. It can never remove
  one, redirect one, or change a rate.

### Terms check — `_termsOk`, with no external call

For an intent with `feeRate > 0`:

1. `feeSinks[feeTo].destination != 0`, else the terms are bad (`Reason.BadTerms_`).
2. `feeRate >= feeSinks[feeTo].minRate`, else the terms are bad.

An intent with `feeRate == 0` charges nothing. Its `feeTo` must be zero or a registered sink whose
floor is 0; any other address is refused (settlement spec FE-8, which supersedes "ignored" here).

This reads storage only. **The settlement still makes no call to `feeTo` inside a fill**, so a
destination can never revert, grief or reenter a fill. That property is kept from master.

`fillability` answers `BadTerms_` for both refusals. The app calls the same view before a maker
signs, so "checked as it is created" is true in practice. The chain enforces it at every fill.

### Booking — unchanged

`_payFee` books the fee to `_pendingFees[feeTo][token]`, keyed by the sink address, as today.

### Claim — pays the destination directly

`claim(sink, token)` transfers the booked amount to `feeSinks[sink].destination`, not to the sink.
No `distribute` step exists, and no token can strand inside a sink contract.

`claim` for an address that is not a registered sink pays that address, as master does today. This
covers fees booked before the upgrade. Decide in implementation whether any such balance can exist
on a fresh deploy; if none can, refuse unregistered addresses and say why in a comment.

**Decided in `4d48379`: refuse.** No such balance can exist. `_termsOk` refuses every charging
intent that names an unregistered address, the registry never removes a row, and the contract is
not upgradeable, so it starts with empty books. `claim` for an unregistered address reverts
`BadParameter`, and the NatSpec on `claim` says why.

### Several destinations

Register several sinks. A maker picks one per intent. One fee is never divided.

### Defaults — approved 2026-09-23, changed 2026-10-01

The owner's words: "each sink should have default values. if an intent uses the zero address, then
the defaults of the default should be used", and "a zero (or any value) on any other param when the
minimum is above produces a revert".

- A sink carries a **default rate** beside its floor, immutable like its destination:
  `FeeSink(destination, minRate, defaultRate)`, with `minRate <= defaultRate <= 1e18`.
- The settlement has **one default sink**, and it is always registered. The constructor sets it.
  The owner changes it with `setDefaultFeeSink(sink)` (decided 2026-09-24). The new sink must be
  registered and not retired. The settlement reads its `defaultRate` and checks
  `minRate <= rate <= 1e18`, as the constructor does. Every refusal is `BadParameter`.
- **The default is a sign-time choice, not a fill-time one** (owner decision, 2026-10-01: "no
  exceptions for the default. they should all be the same. override the intent if you need
  to."). A client that signs "the default" reads `defaultFeeSink()` and writes that sink's address
  and default rate into the intent as `feeTo` and `feeRate`. From then on it is an ordinary named
  sink at a signed rate. No fill reads `defaultFeeSink`, so `setDefaultFeeSink` changes only what
  clients sign next. This replaces the 2026-09-24 rule, under which a zero `feeTo` paid whichever
  default held at fill time (review M-1, 2026-09-30).
- The settlement has **no timelock and no delay**. It names one owner address, and only that address can change the settings. How that address acts, and with what delay, is its own business and not this repository's. The owner's words: "don't handle timelock inside of this contract. it should be enforced by the admin address", and "the only thing we need is the ability to name an address. that address is responsible for implementing time delays. that address would have exclusive access over updating the settings".
- Retiring the default sink is allowed and advisory, as for any sink. Clients stop writing it into
  new intents. Intents already signed against it still fill.
- The fee rules:

| The intent signs | The fill |
|---|---|
| `feeTo = 0`, `feeRate = 0` | no fee: the maker receives the whole gross |
| `feeTo = 0`, `feeRate != 0` | refused (`BadTerms_`): a signed rate must never be silently dropped |
| `feeTo` = a registered sink, `feeRate >= minRate` | pays that sink, at the signed rate |
| `feeTo` = a registered sink, `feeRate < minRate` (zero included) | refused (`BadTerms_`) |
| `feeTo` = any unregistered address | refused (`BadTerms_`) |

- A maker can sign a fee-free intent with `feeTo = 0, feeRate = 0`, or by naming a registered sink
  whose floor is 0, with rate 0.
- **A zero `feeTo` means "no fee" again.** A client that offers "the default" must resolve it
  before signing and show the resolved sink and rate. A client SHOULD re-read `defaultFeeSink()`
  before each signature, or watch `DefaultFeeSinkSet`, so it does not sign a stale default.
- The fee is still taken out of the maker's number, and still booked, then claimed to the
  destination. The terms check still reads storage only and makes no external call.
- The buy-and-burn sink has floor 0 (approved 2026-09-23). Its default rate is **0.5%**
  (`5e15`), decided 2026-09-24. The owner's words: "zero before funds are handed over", then
  "0.5% less" handed to the maker. So nothing is charged before the fill, and the maker receives
  0.5% less. This is the existing single fee on `tokenOut`; no contract change.

## Out of scope

- Splitting one fee across destinations, anywhere.
- An owner-changeable destination, rate or registration. The owner can point the default at
  another registered sink, but no sink's own terms ever change.
- Reading `feeTo` with an external call during a fill.
- `protocolShare`, fee floors in the settlement, gas in a sink.

## What each layer must do

**Contracts.** Replace `FeeSink.sol` with the immutable record. Delete `ForwardFeeSink.sol`.
Replace `allowedFeeSink`/`setFeeSinkAllowed` with `feeSinks`/`registerFeeSink`. Update
`_termsOk`, `fillability` and `claim`. Tests: registration guards, permanence (no path removes a
sink), the floor at exactly `minRate` and one wei below, zero-fee intents unaffected, claim pays
the destination, a hostile destination cannot touch a fill, and invariant coverage of the books.
Gas figures, coverage at 100% branches, Slither triage, ABI export, deploy script.

**SDK and app.** Regenerate ABIs. Registered sinks per chain in `sdk/src/config.ts`, each with its
destination and minimum rate. The sign form offers registered sinks and refuses a rate below the
sink's floor before signing. The console shows one destination, not a split. The admin CLI deploys
a sink and registers it; it has no split or deny commands.

**Docs.** `FEE-MODEL.md`, `AUDIT-SCOPE.md` (the scope gains `FeeSink.sol`; line counts, the tree
pin and test counts move), a reversal note on `2026-08-26-neutral-protocol.md`, a superseded note
on `2026-09-23-fee-sink-registry.md`, and the redeploy runbook: deploy the buy-and-burn sink and
register it at deploy time.
