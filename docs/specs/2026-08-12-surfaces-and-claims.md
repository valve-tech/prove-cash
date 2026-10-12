# Two surfaces, and the claims each one is allowed to make

**Status: Built** (checked 2026-09-23). `/` is the landing page (`app/src/landing/`) and `/app` is
the dapp (`app/src/routes.ts`). The claim list is a standing rule for user-facing copy.

The app has been one surface since it was written: a trading client at `/`. That serves the
executor who already knows what this is and fails the maker who does not. This note splits the two
and fixes the claim list, because the temptation on a landing page is to say the thing that is
almost true.

## The split

`/` is the landing page. `/app` is the dapp. One bundle, one Cloudflare Worker, no router library
— `app/src/routes.ts` is the whole mechanism, and `app/src/main.tsx` is the whole route table.

The split is not cosmetic. The landing page imports nothing from `viem`, the board client or the
proof-of-work worker, so a first-time visitor downloads a page rather than a trading client. The
dapp arrives through `React.lazy` the moment the path asks for it. **Anything added to the landing
page that pulls in the SDK undoes the only reason the split exists.**

Wrangler already serves deep links correctly: `not_found_handling` is
`single-page-application`, so `/app` returns `index.html` and the router takes it from there.

## The claim list

Each claim below is either checkable or marked. Nothing else goes on the landing page.

### True, and worth leading with

**Signing an offer costs no gas and no transaction.** Posting is proof of work in the browser.
Verifiable: `app/src/lib/pow.worker.ts`, and the board carries the intent, not the chain.

**On an EIP-3009 token, a maker can trade having never sent a transaction — not one, ever.**
Two signatures, and `fillWithAuthorization` does the rest. This is the strongest thing we have and
it is genuinely unusual: CoW still requires an approval to its vault relayer before a first trade.
Verifiable: `ProveSettlement.fillWithAuthorization`, and CoW's own docs on the vault relayer.

The honest framing, which is stronger than "we're gasless": **ours is a protocol guarantee and the
comparable path elsewhere is a solver convention.** The EIP-3009 authorization is pinned to one
intent by `auth.nonce == intentHash`, so a signature arms exactly one trade and cancelling the
intent revokes it. CoW reaches zero-transaction onboarding only through its hooks layer, which
their documentation says is "not enforced by the CoW Protocol smart contracts."

**The maker receives exactly the rate they signed.** The fee is charged on top, to the executor,
and rounding always favours the maker. Verifiable: `_quote`, and `_ceilDiv`.

**Anyone can execute.** No allowlist, no bond, no registration.

### True, and must be said even though it is not flattering

**Cancelling costs a transaction, and for a funded escrow offer it takes effect fifteen minutes
later.** Two separate facts, and earlier drafts of this list carried only the first. Both must be
said.

The transaction: `cancel` and `invalidateBefore` are on-chain calls. Because intents sit on a
public board, an executor may already hold a signed copy — so pulling an intent from the board is
*not* a cancel. CoW is in the same position.

The delay, which is the one nobody expects. `cancel` sets `cancelledAt[h]` to now, **plus
`UNLOCK_COOLDOWN` when the intent carries `FLAG_ESCROW` and its reservation is non-empty**.
`invalidateBefore` stores the same deferred instant, and `_evaluate` applies it only to escrow
intents — for an approval-mode intent the nonce floor bites at once. So:

| Custody | When a cancel takes effect |
|---|---|
| approval (unproven) | immediately |
| escrow with nothing deposited | immediately |
| **escrow, funded** | **fifteen minutes later** |
| authorization, before it fills | immediately |
| authorization, after a part fill left a remainder in escrow | fifteen minutes later |

Verifiable: `ProveSettlement.cancel`, `invalidateBefore`, and the two reads in `_evaluate` and
`available`.

This is not a defect and the UI should not apologise for it. It is the same promise the cooldown
makes everywhere else: once funds stand behind an offer, an executor gets a known window in which
they cannot be pulled away mid-fill. Say what it is and why. **The maker it lands on is the maker
with money committed — the one most likely to want out — so burying it is the worst option.**

The product answer remains short `endTime` windows: a Dutch auction that expires in minutes
cancels itself, and the on-chain cancel becomes the rare case.

**Getting out of escrow costs three transactions and a fifteen-minute wait.** `deposit`, then
`requestUnlock`, then the cooldown, then `withdraw`. This is the heaviest path in the product.
`2026-08-12-escrow-exit.md` proposes reducing it to one transaction and no wait for expired
intents; until that ships, the UI states the real cost.

**Unproven means the tokens can vanish.** They sit in the maker's wallet under an allowance. The
badge is doing real work and should not be softened.

### Not true, and currently claimed anyway

**The Tour's "Fill without inventory" step is wrong on two counts** as of `ddab838`. It says an
executor "can name a callback contract" — the contract now calls `msg.sender`, and there is no
target parameter. It says the settlement "checks by balance that the recipient and the fee sink
were paid" — the contract now pulls the payment afterwards and does not watch balances.
Verifiable: `_settleViaCallback`, and `IProveCallback`'s doc comment.

### Not true, and must never be claimed

- **Any smart-account or account-abstraction feature.** PulseChain is on Shanghai. Measured
  2026-08-12 on both 369 and 943: no `blobGasUsed`, no `parentBeaconBlockRoot`, no `requestsHash`.
  Cancun is not active, so Prague is not, so EIP-7702 does not exist here yet.
- **Maker hooks, pre-hooks, post-hooks, or "swap and deposit in one action."** None of it ships.
  See `2026-08-12-hooks-design.md`.
- **Atomic unstake-and-swap.** For a position an EOA already holds directly, no proxy can do it
  and 7702 does not exist here. Two transactions, and say so if asked.
- **MEV protection by uniform clearing price.** We give each maker a signed floor, which is a
  different and weaker promise than CoW's batch-uniform price. Do not borrow their language.

## What the landing page is for

One job: a maker who has never heard of this understands, in one screen, that they can sign an
offer instead of sending a transaction, and that the rate they sign is the rate they get. The
custody ladder is the second screen, because it is the thing that makes the promise credible and
the thing nobody else does.

The executor is not the landing page's audience. They arrive at `/app` from a link.
