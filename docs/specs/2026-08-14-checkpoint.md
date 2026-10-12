# Checkpoint, 2026-08-14
**Status: Superseded by `docs/ROADMAP.md`** (set 2026-09-23). A snapshot of 2026-08-14, kept as history. `docs/ROADMAP.md` is the checkpoint now.
Written to survive a context reset. Where the code is, what is decided, what is not, and what
the next pieces would cost.

---

## Where it stands

**Deployed and live on chain 943.** prove.cash serves a build that points at it, and the live
bundle is byte-identical to the local one.

| contract | address |
|---|---|
| `ProveSettlement` | `0x874D57631986babdAFaB1A28a98dD70723c655cc` |
| `ProveRelayer` | `0x6B5eE12EE2B22D4e475403EA016b2611068Bf257` |
| `ProveExecutor` | `0x1E137bfC205D2A3EDa49b67B50194555812Ff512` |
| `ProveCallSink` | `0x6F918F3D22F3f98a6d8315659E2C364f55e0C85D` |
| `FeeSink` | `0xf45228dAb4387713D3F8c8873dF1bF805192F55C` |

Every link verified in both directions on chain. All six e2e paths green against this
deployment: gasless, partial, escrow, batch, callback, ring.

261 contract tests, 106 SDK tests, 22 app tests. **100% line, statement, branch and function
coverage on all five contracts**, without `--ir-minimum`.

### The five contracts

| contract | what it is |
|---|---|
| `ProveSettlement` | the intents, the fills, the escrow ledger |
| `ProveRelayer` | holds every allowance, maker and executor alike. One function, one caller |
| `ProveExecutor` | public periphery: fill with no inventory, from any venue |
| `ProveCallSink` | makes the caller's arbitrary call, so `ProveExecutor` never does |
| `FeeSink` | fee collection, x402 unwrap, PLSX buyback |

---

## The rule that governs an intent's lifetime

**An intent's allowed lifetime matches the strength of its off switch.**

- **Escrow** — armed by a deposit. `withdraw` undoes it, ends the offer for good, and returns the
  money in one transaction. A maker does that for their own reasons, so being safe is free. May
  rest indefinitely.
- **Wallet** — armed by an ERC-20 approval that lives on the token, where the settlement cannot
  see it granted or revoked. Revoking never cancels, so re-approving revives every signature the
  maker ever wrote against that token. Capped at `MAX_WALLET_WINDOW`.
- **Authorization** — needs no cap. The EIP-3009 signature carries its own `validBefore` and the
  token enforces it.

`test_RevokingAnAllowanceIsNotCancellingAndReApprovingRevivesEveryOldIntent` is the hole this
closes. It is not fixable in the contract, because the arming action is on the token.

### The cap is two bounds, not one

`_termsOk` checks the window's **width** and the **distance to its start**, and needs both:

- Width alone lets a maker sign a legal-looking hour that opens in ten years. The signature then
  waits a decade for an allowance the maker has long forgotten.
- Distance alone — reading `endTime` against `block.timestamp` — means a client whose clock runs
  two minutes fast cannot sign anything the contract accepts. Chain time tracks wall clock within
  about ten seconds (measured, below), so the margin would be far too thin.

Worst case is two windows: one waiting to open, one open. `_termsOk` is shared by `_evaluate` and
`available`, so a view can never call an intent live that a fill would refuse.

---

## Open, not built

### Board retention policy — the owner's direction, 2026-08-14

Not started. This is **off-chain board policy**, not contract work, and that is the point: the
chain already refuses anything dangerous, so the board is free to make cheap decisions about what
it bothers to keep.

The shape the owner described:

- Cancellation of a signature-only intent is an on-chain act, and stays that way.
- A solver or the board may **drop** a signature for any reason at all — insufficient allowance,
  a signature that does not verify, a price nobody will touch, outside its window. Dropping is not
  cancelling and carries no promise.
- Keep an address's signatures even when it has posted several. Do not evict on count alone.
- **Tiering.** Trading in PLSX or PLS earns longer retention, or a wider price band — 10x outside
  the current book instead of 3x. Membership buys shelf space, not validity.

The separation to preserve: **the board decides what it carries; the chain decides what can
settle.** A dropped intent is still fillable by anyone holding a copy, which is why the on-chain
cap is the real bound and board policy is only about cost.

### Findings still unactioned

- **E-5, the fee is voluntary for anyone who can coordinate.** A maker and executor who settle the
  real consideration elsewhere pay 1 wei on any size. Inherent to intent trading; makes the fee
  regressive.
- **`plsxSink` immutable versus timelocked.** Recommendation stands: make the burn destination
  immutable and timelock only what must stay adjustable (router, slippage, min price).
- **Escrow vault.** Escrowed balances are owned by the settlement, so the relayer does not cover
  them and rule 1 is all that guards them. Never costed.
- **Mainnet 369** has nothing deployed and `config/369.json` is empty.
- **External audit** before real money.
- **`invalidateBefore` in the cleanup view.** A maker who raised their nonce floor killed their
  intents too, and the cleanup view still offers a cancel that would revert. One more multicall
  entry.
- **`cancel` and `cancelledAt` are not in the SDK.** The app calls them directly through the
  generated ABI, which is correct but inconsistent with every other settlement write.

### Closed since the last checkpoint

- **E-3, the ring break — mitigated, not closed.** No on-chain fix exists and none was invented.
  What changed is where the exposure lives.

  The independent-batch half was never exposed: `fillBatch` outside a ring already defaults
  `skipInvalid` to true, so one invalidated intent costs the griefer 13k and the executor
  nothing. Only rings must stay atomic, and rings are capped at three legs — the cap is in the
  type, `maxLegs?: 2 | 3`, so no caller can widen it. That takes the measured ratio from 27:1 at
  eight legs to roughly 11:1 at three.

  `executeRing` now simulates at the moment of sending. It had promised this in its comment and
  not done it, so every caller was checking earlier in its own pipeline and leaving a window.
  This does not close the window — a maker watching the mempool can still get a cancel in front —
  but it removes the seconds between planning and broadcast, which is where the cheap breaks are.
  A break throws `RingBrokenError` carrying the revert reason, so discovering it costs no gas.

  `brokenLegs` names which maker broke it, by simulating each leg alone after the fact. An empty
  answer means the legs are individually fine and the ring failed on something only the batch
  sees — a moved pool, or the fee — which is a re-plan rather than a maker to avoid.

  **Still open:** the mempool race itself, and any use of the answer `brokenLegs` gives. Nothing
  yet stops planning around a maker who has broken rings before.

- **E-6** — `Filled` is not a volume oracle. Now said so, on the event.
- **E-8** — buyback sandwich. `setRoute` refuses a token with no owner floor, `setMinPrice(t, 0)`
  refuses while a route exists, and the `EconAudit` fixture moved from 1% of the pool to 0.25%,
  below the ~0.3% break-even.
- **E-9** — **refuted.** `saleGapBlocks` is live configuration. The window binds only an *observed*
  route, and the two knobs have different units. `test_TheSaleGapHoldsBetweenSales` was already
  the counter-example.
- **E-10** — a quiet pair bricked the buyback. `observe` now calls `sync()` on every hop first.
- **E-11** — naming `ProveExecutor` as exclusive executor restricts nothing. The app has no
  exclusive-executor field, so there is nothing to guard. If one is ever added, note that the
  executor address is not discoverable on chain — the settlement holds no pointer back — so it
  needs a registry entry.
- **E-12** — proposer timestamp drift, now measured rather than guessed. See below.
- **F-2** — the solver SDK approved the settlement, not the relayer. Every `fillBatch` a solver
  sent following the SDK would have reverted on allowance.
- **F-3 through F-7** — all fixed, each with a test.
- **Cleanup links** — built. `/app/cleanup/<chainId>/<address>`.

---

## Measured, 2026-08-14

**Block timestamps, chains 943 and 369.** 120 consecutive blocks on each: 10-second slots, p50 10s,
max 20s, strictly increasing, zero non-increasing gaps. Head lags wall clock by 1–4s on 943 and
9–10s on 369.

So a proposer's control over `block.timestamp` is one slot, bought by skipping their turn and
forfeiting the block reward. On a Dutch curve that is 10 seconds of decay: 0.3% of an hour-long
range, about 1% of the app's shortest 15-minute option, a sixth of a one-minute curve. **E-12 is
not exposed at any window the app offers.** The number is recorded on `minOutAt` in the SDK.

---

## Traps this codebase has bitten me with, repeatedly

Worth reading before touching anything.

1. **`vm.prank` is single-shot, and so is `vm.expectRevert`.** `settlement.relayer()`, `makeAddr`,
   `_sign` and `new` are all calls, and any of them on the pranked line eats the prank. Hit six
   times now. Hoist the value into a local first.

   **The argument position is the one that catches you out.** An argument is evaluated *after* the
   cheatcode, so a helper called inline makes its own call the "next call":

   ```solidity
   vm.prank(executor);
   vm.expectRevert(BadParameter.selector);
   settlement.fillWithPermit(i, sig, take, _permit(...), ANY_FEE);  // _permit reads the token
   ```

   `_permit` reads the token's domain and nonce, so that staticcall eats the prank *and* satisfies
   the expectation, and the real call then runs unpranked and unwatched. Five tests in
   `Permit.t.sol` failed this way at once, with two different symptoms — three "did not revert as
   expected", and two `ERC20InsufficientAllowance` because the fill ran as the test contract
   rather than as the executor. Two symptoms, one cause. Hoist every helper that touches a
   contract into a local above the cheatcodes.
2. **`git commit` with a pathspec stages tracked changes only.** New files need an explicit
   `git add`. Three files in one session were described in a commit message and not contained in
   it, including `ProveCallSink.sol`, which was the entire answer to a HIGH security finding.
3. **`grep -E "error TS"` fails on tsc output** — ANSI colour codes sit between the two words.
   Grep for `TS[0-9]+`.
4. **A shell does not carry `cd` where you think it does.** Use absolute paths.
5. **Gas assertions do not survive `forge coverage`.** Instrumentation moves every absolute
   figure. `Gas.t.sol` asserts nothing at all for this reason; assert ordering, never magnitude.
6. **A state override installs runtime code and never runs a constructor,** so an `immutable` reads
   as zero in a dry run. `InventoryExecutor` uses constants for this reason. Those constants are
   now patched from the registry at compile time, because hand-editing them meant every redeploy
   left them naming the deployment before it.
7. **`forge fmt` under the Foundry nightly disagrees with the committed style** and reformats
   hunks across the repo. HEAD is not fmt-clean and CI has no fmt gate. Do not run it across
   files you did not otherwise change.
8. **A second copy of anything drifts.** `contracts/abi/*.json` is the second copy of every ABI,
   nothing in the repo reads it, and it drifted by four deleted functions and three missing ones
   before anybody noticed. CI now runs `abi/export.sh --check`.
