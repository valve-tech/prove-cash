# The escrow exit costs three transactions and a wait. Two of them are unnecessary.

**Status: Superseded by `66c43fa`** (2026-08-13, "remove the escrow cooldown, and everything it
needed"). The fix went further than this note asks: `requestUnlock`, `UNLOCK_COOLDOWN` and
`withdrawExpired` are all gone, and `withdraw` returns the money in one call. The note below is
history. It said:

Not implemented. This is a finding with a safety argument, checked against the deployed contract,
and it is the owner's call whether to take it.

## What it costs today

A maker who escrows an intent that never fills pays `deposit`, then `requestUnlock`, then waits
`UNLOCK_COOLDOWN` — fifteen minutes — then pays `withdraw`. Three transactions and a wait, to get
back money that nobody else can spend.

That is the heaviest interaction in the product. Everything else is lighter than people assume:

| what the maker wants | on-chain transactions |
|---|---|
| Swap a token with EIP-3009 | **none, ever** — two signatures, `fillWithAuthorization` does the rest |
| Swap a token with EIP-2612 | none, if the executor bundles `permit` with the fill |
| Swap a plain ERC-20 | one approval, once, then none per swap |
| The "proven" badge | one `deposit` per intent — a paid-for feature, not friction |
| Cancel | one, and see below |

Worth saying plainly because it is a real advantage: CoW still needs an approval to the vault
relayer before a first trade. The EIP-3009 path here needs nothing at all.

## Why the cooldown protects nothing after `endTime`

`UNLOCK_COOLDOWN` does two jobs, and the code separates them:

- **The lower bound** — `block.timestamp < at` — stops a maker watching an executor's fill in the
  mempool and yanking the funds ahead of it.
- **The upper bound** — `block.timestamp >= at + UNLOCK_COOLDOWN` — shuts the window, so a maker
  cannot hold a reservation that is fillable and withdrawable at the same time for ever. The
  comment on `withdraw` calls that a free option and explains why the test lives there.

**Both jobs end at `endTime`.** `_evaluate` line 762 is
`if (block.timestamp >= i.endTime) return (Reason.Expired, 0);` — so past that instant no fill can
happen. There is no mempool fill to front-run, and no option to hold, because the thing the option
would be exercised against is dead.

## The change

```solidity
function withdrawExpired(Intent calldata i) external nonReentrant {
    if (msg.sender != i.maker) revert BadParameter();
    if (block.timestamp < i.endTime) revert StillLocked();
    // ... same payout as `withdraw`, minus the `unlockAt` dance
}
```

Three transactions and fifteen minutes become one transaction and none. There is no race: the
comparison that authorises the withdrawal is the same comparison the fill path already uses to
refuse.

**Two details in the sketch this came from are wrong, and repeating them would not compile.** It
checks `reservations[h].maker == msg.sender`, and it proposes paying out to `r.maker`. `Reservation`
has no `maker` field — F-1 collapsed it to `{uint192 amount; uint64 unlockAt}` and the maker comes
from the calldata preimage, which is safe because the hash commits to it. Use `i.maker` for both.

Edge cases checked, none of them new:

- **An intent whose `endTime` is already past when the deposit lands.** Withdrawable at once, and
  harmless — an executor's fill would have returned `Expired` anyway, so nobody could have relied
  on the reservation.
- **A third party topped the reservation up.** The maker collects their contribution too. That is
  already true of `withdraw`; `deposit` documents that anyone may top up and only the maker may
  take out.

## The companion idea, and the flaw in it

Making `withdraw` callable by anyone once the cooldown matures, with the funds always going to the
maker, would let a keeper sweep expired escrow so makers never touch it. The mechanism works —
again using `i.maker`, not a field that does not exist. But it interacts with the upper bound: a
keeper who sweeps inside the window removes the maker's own chance to re-arm and let the intent
fill after all. Decide what the window means before making anyone able to close it.

## Cancellation

`cancel` and `invalidateBefore` are transactions, and because intents sit on a public board an
executor may already hold a signed copy — so pulling an intent from the board is not a guaranteed
cancel. CoW is in the same position. The product answer is short `endTime` windows: a Dutch auction
that expires in minutes cancels itself, and the on-chain cancel becomes the rare case.

## Why this is worth more than the hooks work

Every hook question in `2026-08-12-hooks-design.md` ends in "do not ship it." This is a change that
removes two transactions and a fifteen-minute wait from a path makers already walk. It needs no
proxy, no account model, no fork, and no new call surface.
