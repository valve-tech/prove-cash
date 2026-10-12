# Gas-cover fee-split

**Status: proposed.** Nothing here is built. The fee split (#119) and fee booking (#122) already
shipped; this note is the product that sits on top of them.

**Companion reading.** `docs/FEE-MODEL.md` is the arithmetic authority. The landing console
("split") already teaches the three-way surplus split. This document decides what the **app**
does with the interface-fee leg — today that leg defaults to PulseX's buy-and-burn and prove.cash
keeps none of it.

## One sentence

Offer makers an optional fee destination that **covers the gas they still pay** (and the gas a
fee claim still costs), funded by carving that cost out of the same interface fee they already
sign — and send whatever is left where they meant it to go.

## Why this exists

Three facts, already true on chain:

1. **Posting is free. Settling is not free for everyone.** Signing and board posting cost no
   transaction. Escrow deposit, cancel, park, withdraw, and `claim` still cost gas in PLS. The
   measured claim that empties a destination's book is **51,877 gas**
   (`app/src/landing/gas.ts`, row `claim, a destination empties its book`). A first-touch
   deposit is **124,790 gas**.
2. **The fee is an interface fee, not a protocol fee.** The maker signs `feeRate` and `feeTo`.
   The settlement takes no share and has no destination of its own
   (`contracts/test/ProveSettlement.t.sol` "Where the fee goes"; `docs/FEE-MODEL.md` Part 2).
   Whoever builds the intent directs the whole charge. Today this app's default is PulseX's
   buy-and-burn (`sdk/src/config.ts` `feeTo`).
3. **The fee is booked, not transferred.** `#122` pulls the fee to the settlement and credits
   `_pendingFees[feeTo][token]`. Somebody — the destination, or a stranger willing to spend the
   gas — later calls `claim`. Small accruals sit below the cost of claiming them.

The landing page already tells the maker that the surplus "splits three ways and no further":
fee, gas, solver residual. **Gas cover is not a fourth way.** It spends the fee leg on the gas
leg for the people the residual never reaches — makers and fee claimants — without touching the
solver's residual or the maker's signed delivery.

## Who it is for

| Actor | What they want | What this gives them |
|---|---|---|
| **Maker using prove.cash** | Post and manage offers without stocking PLS for every deposit, cancel, or withdraw | A signed fee that buys those transactions later, disclosed before they sign |
| **Maker on EIP-3009 / Permit2** | Stay on the zero-tx path as long as possible | Cover only when they leave that path (escrow arm, bulk retire, park withdraw) — not when they never need it |
| **Fee destination (burn, partner, self)** | Receive value without paying claim gas out of pocket | A claimer that pays gas and is repaid from the fee book, in the open |
| **prove.cash as an interface** | A business model that does not reintroduce a protocol fee | Keep earning zero as protocol; optionally operate the cover float as the named `feeTo`, with a published split |

Not for: solvers. Fill gas is already their cost and their residual. Covering solver gas from the
fee would move the rate back onto the fill clock — the exact defect the fee split
removed (`docs/FEE-MODEL.md` Part 3).

## The product shape

### What the maker sees

On the sign form, next to the existing destination chips (buy-and-burn / custom), a third chip:

**Gas cover**

Selecting it:

1. Sets `feeTo` to the cover contract (or the cover's claim-router address) for this chain.
2. Keeps the maker typing a **net** they will receive; the form still derives the gross
   (`grossForNet` / `docs/FEE-MODEL.md` Part 3).
3. Shows a new line under the split readout:

   > of the fee, about **X** goes to cover gas · **Y** goes to {remainder destination}

4. Names the remainder destination in words (default: the same PulseX buy-and-burn the app
   already offers). The maker can change the remainder; they cannot hide that a split exists.

The chip is off by default on day one. Defaulting it on is a later decision and needs its own
measurement (see Open questions).

### What the cover does with a fee

On each fill that names the cover as `feeTo`, the settlement books the whole fee to the cover's
address — same as any other destination. No settlement change.

Off chain / in the cover contract, the accrued balance is accounted in two buckets:

| Bucket | Purpose | Bound |
|---|---|---|
| **Cover float** | Pay gas (in PLS) for allowlisted maker-side and claim transactions | Sized so a quiet week of claims and arms still clears; never spends the remainder bucket |
| **Remainder** | Forwarded to the destination the maker (or the app default) named — burn, partner, or EOA | Never used to buy gas |

**The split rate is not a signed intent field.** It is a property of the cover destination the
maker chose. Changing the cover's split does not rewrite resting offers; it only changes how
future claims against that destination are divided. That is the same trust model as naming any
other contract as `feeTo` today.

Publish the live split on the sign form and on a public status page. A maker who disagrees names
a different `feeTo`.

### Which gas it covers

In scope for v1:

| Action | Who initiates | Why it is coverable |
|---|---|---|
| `claim(feeTo, token)` for balances owed to the cover or to allowlisted partners | Cover keeper, or permissionless with a tip | Directly pays for the booking model #122 introduced |
| Escrow `deposit` / arm for a maker who opted in | Cover relayer, maker-authenticated | The main PLS tax on makers who leave the gasless rungs |
| `park` + withdraw / `invalidateBefore` bulk retire for an opted-in maker | Cover relayer, maker-authenticated | Exit and reprice paths that today strand makers who hold no PLS |

Out of scope for v1:

- Solver fill gas, failed-leg griefing, or any payment that would change `proceeds − gross − gas`
- Board proof-of-work (already free)
- Tokens the cover cannot price into PLS without a vetted route (same discipline as the retired
  FeeSink: no unarmed route, no silent strand)

### Opt-in and authentication

A maker is not covered merely because an offer named the cover as `feeTo`. Covering a
deposit or cancel moves the maker's tokens or ends their offer, so the relayer needs a second
signal that is not the trading signature:

- **v1:** EIP-712 "cover request" per action (or a short-lived session approval), bound to the
  maker, the action, a gas ceiling, and an expiry. The trading intent's `feeTo` alone is not
  enough.
- **Not v1:** unrestricted account abstraction / 4337 paymasters. The cover is an allowlisted
  relayer with a published policy, not a general gas tank.

Claiming fees owed to the cover itself needs no maker signature — anyone may call `claim` today.

## Economics (order-of-magnitude)

Use live gas rows, not guesses:

- Claim: **~52k gas**. At 710k gwei and ~$0.000014/PLS (illustrative — print live figures in the
  UI), one claim is cheap in USD on PulseChain and still real in PLS.
- First-touch deposit: **~125k gas**.
- Warm fill that books a fee: the booking premium is ~10% steady-state on the fee path
  (`2026-09-03-the-signed-intent-before-mainnet.md`, #122 table) — already paid by the solver,
  not by this product.

**Break-even for the float:** fee accrual credited to the cover, denominated in `tokenOut`, must
convert to enough PLS to pay the sponsored gas plus the remainder obligation. The cover refuses
a sponsorship when the float is below the gas ceiling for that action. It does not borrow from
the remainder bucket. It does not skim the maker's delivery.

**Dust:** six-decimal outs can book a fee of zero below 1,000 units (`FEE-MODEL.md`). Cover does
not invent a minimum fee; a fill that books nothing adds nothing to the float. Sponsorship of
that maker's next deposit still requires float from other fills or an external top-up.

## What does not change on chain

- No `feeSink`, `protocolShare`, or owner fee dial returns. Neutral protocol stands
  (`2026-08-26-neutral-protocol.md`).
- No change to `_quote`, `_payFee`, or `claim` for v1. The cover is a `feeTo` like any other.
- No change to solver residual accounting. Gas cover never appears in `proceeds − gross − gas`.
- Makers who name `feeTo = 0` still pay nothing and receive no cover.

If v2 needs an on-chain split (e.g. remainder enforced in the same claim tx), that is a separate
contract change and a separate review. Do not sneak it into v1.

## User flows

### A. Maker opts into gas cover on a new offer

1. Sign form → destination chip **Gas cover**.
2. Form shows net, derived gross, fee, cover share, remainder share, remainder name.
3. Maker signs. Intent `feeTo` is the cover address; `feeRate` is the rate they chose.
4. Offer posts to the board as today.

### B. Maker deposits into escrow without holding PLS

1. Maker is opted in and has floating credit (prior fees, or a policy that allows a first arm
   against expected fee — see Open questions).
2. Maker signs a cover request for `deposit` with a gas ceiling.
3. Relayer submits the deposit; float pays PLS gas; maker's tokens move as today.
4. If the float cannot cover the ceiling, the UI says so before the request is offered — never
   after a failed submission the maker did not send.

### C. Cover claims and forwards

1. Keeper (or anyone) calls `claim(cover, token)`.
2. Cover accounts the receipt into float vs remainder per the published split.
3. Remainder is forwarded on a schedule (per claim, daily, or above a threshold).
4. Float is spent only on allowlisted sponsorships.

### D. Maker declines

Custom `feeTo`, buy-and-burn chip, or no fee. No cover request UI. Identical to today.

## Acceptance criteria

### Product / UX

- [ ] Sign form can select Gas cover as `feeTo` on both supported chains, with the remainder
      destination named in words (not only an address).
- [ ] Split readout shows cover share and remainder share before signature, using the same
      net→gross derivation as the existing fee line.
- [ ] Copy never says "free gas" or "we pay your gas always". It says which actions are covered,
      that cover depends on float, and that the solver still pays fill gas.
- [ ] Landing "split" console gains one sentence pointing at this option without inventing a
      fourth surplus party.
- [ ] 35 locales get keys; English ships first, others in the same PR or a follow-up tagged on
      the issue — not a silent English-only chip.

### Policy / safety

- [ ] Published allowlist of sponsorable actions and per-action gas ceilings.
- [ ] Cover request signatures bind maker, action, ceiling, expiry; replaying a request cannot
      move funds twice.
- [ ] Float and remainder are separately accounted; an empty float refuses sponsorship without
      touching remainder.
- [ ] No path for cover to change `feeRate`/`feeTo` on a resting offer.

### Measurement

- [ ] Dashboard: fee booked to cover, PLS spent on sponsorships, remainder forwarded, refused
      sponsorships by reason (empty float / action not allowlisted / bad request).
- [ ] Cycle report (`app/scripts/cycle-report.ts`) gains a line for cover `feeTo` balances so a
      green bot log cannot hide a stranded fee book.

## Non-goals

- Reintroducing a protocol fee or owner-set floor.
- Paying solvers, market makers, or heartbeat bots from the fee.
- A general-purpose PulseChain paymaster for arbitrary calldata.
- Guaranteeing cover for makers who never generate fee accrual and never fund the float.
- Changing the settlement to transfer fees during fill again.

## Rollout

1. **Spec + issue** (this document).
2. **Cover contract + keeper** on 943 only; remainder = burn; split published; no production
   makers pointed at it by default.
3. **Sign-form chip behind a flag** on 943; dogfood with internal makers.
4. **Measure** two weeks: float solvency, refused sponsorship rate, claim cadence vs gas price.
5. **Mainnet** only after #35 redeploy posture is understood — the cover address is a `feeTo`
   like any other and does not itself require a settlement redeploy, but the app registry and
   default chips do.

## Open questions

1. **Default on or off?** Off until float solvency is boring. On would subsidise onboarding and
   hide PLS poverty; it also spends float on makers who never meant to pay a fee.
2. **First deposit before any fee accrues?** Allow a capped bootstrap (treasury-funded) or
   require a prior fee-paying fill. Bootstrap is product-useful and economically a grant; say so.
3. **Remainder destination fixed per cover deployment, or per maker?** Per maker needs either
   multiple cover clones or an on-chain remainder registry. v1 can fix remainder to burn and
   defer per-maker remainder.
4. **Who may call sponsor?** Single keeper key, or permissionless with a tip paid from float?
   Permissionless is closer to `claim` and harder to grief; start with a keeper.
5. **Do we ever take an interface cut above cover?** Neutral protocol says the settlement will
   not. An interface cut would be a second remainder destination named prove.cash. Decide
   explicitly; do not let "ops costs" become an undeclared third bucket.

## Decision log

| Date | Decision |
|---|---|
| 2026-09-20 | Draft opened. Product sits on #119/#122; no settlement change for v1. |
| — | Default chip state, bootstrap grant, and whether prove.cash takes a remainder cut: unresolved. |

