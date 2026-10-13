// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, MockERC20, MockPermit2, MockWrapper} from "./Mocks.sol";
import {FaucetToken} from "./tokens/FaucetToken.sol";
import {WeirdToken} from "./tokens/WeirdToken.sol";
import {RebasingToken} from "./tokens/RebasingToken.sol";
import {
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION
} from "./Fees.sol";

/**
 * @notice Every token behaviour against every custody rung, in one table. This is the
 *         specification of which tokens prove.cash supports.
 *
 * A reader asking "can we take a fee-on-transfer token on a gasless intent?" reads the row and
 * stops. Each cell names its outcome before it runs: either the fill settles and all four parties
 * — maker, executor, sink, feeTo — are exact to the wei, or it is refused with one named error.
 * No cell accepts both.
 *
 * **The table.** `x2` and `/2` are rebases applied after the funding and before the fill.
 *
 * ```
 *  token behaviour        approval      escrow            permit        authorization  permit2
 *  ---------------------  ------------  ----------------  ------------  -------------  ------------
 *  standard, 18 decimals  settles       settles           settles       settles        settles
 *  standard, 8 decimals   settles       settles           settles       settles        settles
 *  standard, 6 decimals   settles       settles           settles       settles        settles
 *  fee on transfer, 10%   settles (a)   EscrowShort (b)   settles (a)   EscrowShort    EscrowShort
 *  no return data         settles       settles           settles       settles        settles
 *  blocked executor       Blocked       Blocked           Blocked       Blocked        Blocked
 *  rebase up, x2          settles       settles (c)       settles       n/a, no 3009   settles
 *  rebase down, /2        InsufBalance  InsufBalance (d)  EscrowShort   n/a, no 3009   InsufBalance
 *  par wrapper            settles       settles           n/a, no 2612  n/a, no 3009   settles
 * ```
 *
 * `Blocked` is the token's own error, `InsufBalance` is `ERC20InsufficientBalance`, and
 * `EscrowShort` is the settlement's. `SafeERC20` bubbles a token's revert data, so the error a
 * cell asserts is the one the token raised.
 *
 * **Three decimal widths, because a fee divides differently at each.** Eighteen is what every
 * mock here used to assume. Six is what the bridged stablecoins on chain 369 carry. Eight is HEX,
 * which is the widest-held token on that chain and a width nothing else in this repository
 * exercises. The amounts below divide exactly at all three, so a settled cell says the plumbing
 * carries the width rather than that the arithmetic happened to round well. Where the width does
 * bite is the fee floor: `fee` rounds down, so a gross under 1,000 units books nothing at any
 * width, and that floor is worth a thousandth of a cent in HEX and a tenth of a cent in USDC.
 * `test/Fork369RealTokens.t.sol` measures it against the tokens themselves.
 *
 * **The mocks.** `FaucetToken` carries the three standard rows, `WeirdToken` the three misbehaving
 * ones, `RebasingToken` the two elastic ones and `MockWrapper` the last. `WeirdToken` signs
 * nothing, so the permit and authorization columns of its rows run on `SigningWeirdToken` at the
 * foot of this file — the same three switches on a token that signs. The permit2 column needs no
 * such thing and runs on the shipped mock, because that rung asks the asset for no signature at
 * all. An `n/a` cell is one the token cannot physically take, and it says which signature is
 * missing.
 *
 * **(a) A taxing `tokenIn` shorts the executor, and never the maker.** The maker parts with
 * exactly the `take` they signed for; the tax is burned out of that, and the executor receives
 * 900 of the 1,000 the maker paid. `_deliverTo` brackets the delivery leg with a balance read and
 * `_release` has no such guard, so the shortfall lands on the one party that chose to be here.
 * A taxing `tokenOut` is refused instead, with `Underpaid` —
 * `test_ATaxingTokenInShortsTheExecutorAndATaxingTokenOutIsRefused` holds both halves.
 *
 * **(b) A taxed deposit under-funds the intent; it never over-credits it.** This note covers the
 * three custodied columns — escrow, authorization and permit2 — and all three answer
 * `EscrowShort`. `deposit` credits the balance that arrived, so 1,000 asked for reserves 900, and
 * a fill for the whole `amountIn` is refused. The table runs the same three cells again asking
 * only for the 900 the funding delivered, and all three settle. `balanceOf(settlement)` equals
 * the sum of the reservations throughout, which is the property that matters. An authorization
 * and a Permit2 signature are the sharper case: both move the whole `amountIn` at fill time, so a
 * taxing token can never fill such an intent at its full size — only at what the tax leaves.
 *
 * **What a refusal leaves behind differs, and permit2 leaves the least.** The escrow cell fails
 * with 900 already sitting here, because the deposit was its own transaction. The authorization
 * and permit2 cells draw inside the fill's frame, so the refusal unwinds the draw: the maker
 * keeps their tokens and the single-use nonce is unspent. `Arming.t.sol` holds the Permit2 half
 * of that as `test_ABadPermit2SignatureLeavesNothingBehind`.
 *
 * **(c) A rebase up strands the gain.** The escrow pays out the number it booked, so the extra
 * 1,000 the index created stays in the contract, reserved to nobody, and no `withdraw` reaches
 * it. Nothing is lost and nothing is stealable — it is dust that grows.
 *
 * **(d) A rebase down makes the contract insolvent against its own book, and that is real.**
 * `reserved` still says 1,000 while the contract holds 500. A fill for 1,000 reverts inside the
 * token; a fill for 500 succeeds, empties the balance, and leaves the book claiming 500 that is
 * not there. Whoever moves first is paid in full and whoever is slower gets nothing. The
 * settlement cannot see it and cannot fix it — the reservation is a number, not a share — so the
 * answer is an allowlist off chain: never escrow an asset whose balance can fall.
 *
 * **Who names the refusal when the maker's balance shrinks.** The rebase-down row is refused on
 * four rungs and three of them say `InsufBalance`, which is the token's own complaint. The permit
 * rung says `EscrowShort` instead: arming re-evaluates the leg deeply, and that pass reads the
 * maker's halved balance before any token is asked to move anything. Permit2 does not join it,
 * and the reason is worth writing down. `_evaluate` answers "is this maker funded?" from the
 * reservation alone for every custodied rung, so it never probes a permit2 maker's wallet — the
 * first thing to notice the missing money is the token, one hop later, inside the pull.
 *
 * **permit2 is the only gasless rung the last three rows can take at all.** A par wrapper signs
 * no EIP-2612 and no EIP-3009, and a rebasing token signs no EIP-3009, so those four cells are
 * `n/a` on the older gasless columns. All three rows run on permit2, because the maker signs for
 * Permit2 and the asset is never consulted. Two of them settle; the third is refused by the
 * token's own shrinking balance, which is a verdict rather than a missing signature. That is the
 * widest-reach claim the rung makes, and the table measures it rather than asserting it.
 *
 * **What is not crossed here.** The behaviour rides on `tokenIn`, because custody is custody of
 * `tokenIn`. The delivery leg is `tokenOut`'s and it is guarded differently, so it gets its own
 * test rather than a second axis.
 */
contract TokenMatrixTest is Test {
    // ── The axes ─────────────────────────────────────────────────────────────

    /// @dev How the token behaves. One row of the table each.
    enum Kind {
        Standard,
        FeeOnTransfer,
        Silent,
        BlockedExecutor,
        RebaseUp,
        RebaseDown,
        ParWrapper
    }

    /// @dev The five ways an intent is backed. `ProveSettlement`'s header names them.
    enum Rung {
        Approval,
        Escrow,
        Permit,
        Authorization,
        Permit2
    }

    enum Verdict {
        Settles,
        Refuses,
        NotApplicable
    }

    /**
     * @dev One cell. Adding a row is one line of `_cells`.
     *
     * @param fullTake asks for the whole `amountIn`. False asks for what the funding actually
     *        delivered, which is the same number for every token that does not tax.
     * @param err the selector the refusal must carry, matched with `expectPartialRevert`. A
     *        selector rather than the whole payload, because the arguments belong to the fixture:
     *        a blocked address and an insufficient balance both name numbers this table is not
     *        about, and pinning them would test the mock rather than the settlement.
     */
    struct Cell {
        string name;
        Kind kind;
        Rung rung;
        uint8 dec;
        bool fullTake;
        Verdict verdict;
        bytes4 err;
    }

    /// @dev Balances before the fill, so every assertion is a delta the fill caused.
    struct Snap {
        uint256 makerIn;
        uint256 execIn;
        uint256 makerOut;
        uint256 execOut;
        uint256 sinkOut;
        uint256 feeToOut;
        /// @dev The destination's row in the settlement's fee book. A fee is booked rather than
        ///      transferred, so this is the number a fill moves and `feeToOut` is the one it
        ///      must leave alone.
        uint256 feeToBook;
    }

    /// @dev What the fill must move, computed here rather than read back from the contract.
    struct Expect {
        uint256 makerPaid;
        uint256 execGot;
        /// @dev The curve's number, and the executor's whole outlay. It splits into the two
        ///      below and their sum is always exactly this.
        uint256 gross;
        uint256 delivered;
        uint256 fee;
    }

    // ── Fixture ──────────────────────────────────────────────────────────────

    ProveSettlement settlement;
    /// @dev Read once. `vm.prank` is single-shot and `settlement.relayer()` is a call.
    address relayer;
    /// @dev The one address a permit2 maker ever approves. It backs the fifth column.
    MockPermit2 permit2;

    address owner = address(0xB0B);
    address sink = address(0x5152);
    address executor = address(0xE0E);
    address feeTo = address(0xFEE0);
    address maker;
    uint256 makerKey;

    /// @dev The two tokens of the cell being run. State, not arguments: the runner is already at
    ///      the stack depth `forge coverage` adds its counters to.
    address tIn;
    address tOut;

    /// @dev This cell's Permit2 signature, if the cell is on that rung. State for the reason
    ///      `tIn` and `tOut` are state: `_execute` is already as deep as `forge coverage` can
    ///      take it, and a sixth struct in that frame is one too many.
    ProveSettlement.Permit2Transfer p2Arm;

    /// @dev One per cell, so two cells never share an intent hash.
    uint256 caseNonce;

    /// @dev The rebasing token's index scale and the taxing token's cut, both in basis
    ///      points. These are the tokens' own arithmetic and did not move when the fee's unit
    ///      did — see FEE_WAD below for the one that did.
    uint256 constant BPS = 10_000;

    /// @dev One, in the unit a fee rate is counted in.
    uint256 constant FEE_WAD = 1e18;
    /// @dev Ten basis points, signed into every intent the matrix builds. The intent's own, and
    ///      there is no other source for one.
    uint64 constant FEE_RATE = 0.001e18;
    /// @dev Ten per cent. Every amount below divides by it exactly, so no assertion here is
    ///      about rounding.
    uint16 constant TAX_BPS = 1_000;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        // A working Permit2, not the codeless placeholder. The other four rungs never call it,
        // so the fifth one costs them nothing. `MockPermit2` lists the five things it copies
        // faithfully, and every one of them decides a cell below.
        permit2 = new MockPermit2();
        settlement = newSettlement(address(permit2));
        relayer = settlement.relayer();
        vm.warp(1_700_000_000);
    }

    // ── The matrix ───────────────────────────────────────────────────────────

    // The table's own shorthand, so a row reads as a row. These were locals in `_cells()` and
    // belong to the contract now because forty-three tests share them. The four selectors are
    // `immutable` rather than `constant`: a `.selector` is not a compile-time constant here.
    Kind constant std = Kind.Standard;
    Kind constant fee = Kind.FeeOnTransfer;
    Kind constant mute = Kind.Silent;
    Kind constant ban = Kind.BlockedExecutor;
    Kind constant up = Kind.RebaseUp;
    Kind constant down = Kind.RebaseDown;
    Kind constant wrap = Kind.ParWrapper;
    Rung constant appr = Rung.Approval;
    Rung constant esc = Rung.Escrow;
    Rung constant perm = Rung.Permit;
    Rung constant auth = Rung.Authorization;
    Rung constant p2 = Rung.Permit2;
    Verdict constant ok = Verdict.Settles;
    Verdict constant no = Verdict.Refuses;
    Verdict constant na = Verdict.NotApplicable;
    bytes4 immutable short_ = ProveSettlement.EscrowShort.selector;
    bytes4 immutable blocked = WeirdToken.Blocked.selector;
    bytes4 immutable poor = IERC20Errors.ERC20InsufficientBalance.selector;

    /**
     * @dev The permit rung under a shrinking balance is refused by our own probe.
     *
     * Arming re-evaluates the leg deeply, and that pass reads the maker's halved balance before
     * any token is asked to move anything. So the refusal is `EscrowShort` — the maker cannot pay
     * — rather than the token's own complaint one hop later. Same outcome, named by us instead of
     * by the asset.
     *
     * The permit2 rung does not share it, and the header says why: a custodied rung is judged on
     * its reservation, so no probe ever reads that maker's wallet.
     */
    bytes4 immutable cannotPay = ProveSettlement.EscrowShort.selector;

    /**
     * @dev The table, one test per row.
     *
     * It used to be a single `test_TheMatrix` walking a `Cell[]`, and the first failing cell
     * stopped the loop — so one broken row hid the forty-two behind it and the report said
     * "1 failed" either way. Forty-three named tests say which rows hold and which do not, in one
     * run, which is the whole reason for having a matrix rather than a list.
     *
     * The short aliases below are what let a row read as a row. Each test is one line, and the
     * rows stay in the order the header table prints them.
     */
    function test_18dpApproval() public {
        _run(Cell("18dp / approval", std, appr, 18, true, ok, 0));
    }

    function test_18dpEscrow() public {
        _run(Cell("18dp / escrow", std, esc, 18, true, ok, 0));
    }

    function test_18dpPermit() public {
        _run(Cell("18dp / permit", std, perm, 18, true, ok, 0));
    }

    function test_18dpAuth() public {
        _run(Cell("18dp / auth", std, auth, 18, true, ok, 0));
    }

    function test_18dpPermit2() public {
        _run(Cell("18dp / permit2", std, p2, 18, true, ok, 0));
    }

    /// @dev Eight decimals is HEX, the widest-held token on 369 and a width no other fixture in
    ///      this repository carries. `test/Fork369RealTokens.t.sol` runs the same five claims
    ///      against the token itself, where the decimals are the chain's rather than a mock's.
    function test_8dpApproval() public {
        _run(Cell("8dp / approval", std, appr, 8, true, ok, 0));
    }

    function test_8dpEscrow() public {
        _run(Cell("8dp / escrow", std, esc, 8, true, ok, 0));
    }

    function test_8dpPermit() public {
        _run(Cell("8dp / permit", std, perm, 8, true, ok, 0));
    }

    function test_8dpAuth() public {
        _run(Cell("8dp / auth", std, auth, 8, true, ok, 0));
    }

    function test_8dpPermit2() public {
        _run(Cell("8dp / permit2", std, p2, 8, true, ok, 0));
    }

    function test_6dpApproval() public {
        _run(Cell("6dp / approval", std, appr, 6, true, ok, 0));
    }

    function test_6dpEscrow() public {
        _run(Cell("6dp / escrow", std, esc, 6, true, ok, 0));
    }

    function test_6dpPermit() public {
        _run(Cell("6dp / permit", std, perm, 6, true, ok, 0));
    }

    function test_6dpAuth() public {
        _run(Cell("6dp / auth", std, auth, 6, true, ok, 0));
    }

    function test_6dpPermit2() public {
        _run(Cell("6dp / permit2", std, p2, 6, true, ok, 0));
    }

    function test_TaxApproval() public {
        _run(Cell("tax / approval", fee, appr, 18, true, ok, 0));
    }

    function test_TaxEscrowWhole() public {
        _run(Cell("tax / escrow, whole", fee, esc, 18, true, no, short_));
    }

    function test_TaxEscrowFunded() public {
        _run(Cell("tax / escrow, funded", fee, esc, 18, false, ok, 0));
    }

    function test_TaxPermit() public {
        _run(Cell("tax / permit", fee, perm, 18, true, ok, 0));
    }

    function test_TaxAuthWhole() public {
        _run(Cell("tax / auth, whole", fee, auth, 18, true, no, short_));
    }

    function test_TaxAuthFunded() public {
        _run(Cell("tax / auth, funded", fee, auth, 18, false, ok, 0));
    }

    /// @dev Like the authorization column and not like the permit one. `_pullPermit2` draws the
    ///      whole `amountIn`, the tax eats a tenth on the way in, and the deep re-evaluation
    ///      refuses a fill the 900 that arrived cannot cover.
    function test_TaxPermit2Whole() public {
        _run(Cell("tax / permit2, whole", fee, p2, 18, true, no, short_));
    }

    /// @dev The same draw, asked only for what it delivers. The maker still parts with 1,000 and
    ///      the executor receives 810, because the tax is charged again on the way out.
    function test_TaxPermit2Funded() public {
        _run(Cell("tax / permit2, funded", fee, p2, 18, false, ok, 0));
    }

    function test_SilentApproval() public {
        _run(Cell("silent / approval", mute, appr, 18, true, ok, 0));
    }

    function test_SilentEscrow() public {
        _run(Cell("silent / escrow", mute, esc, 18, true, ok, 0));
    }

    function test_SilentPermit() public {
        _run(Cell("silent / permit", mute, perm, 18, true, ok, 0));
    }

    function test_SilentAuth() public {
        _run(Cell("silent / auth", mute, auth, 18, true, ok, 0));
    }

    /**
     * @dev It settles, and it did not at first. `MockPermit2` pulled with a plain
     *      `IERC20.transferFrom`, so this cell moved the money and then reverted on an empty
     *      return buffer with the transfer already done. The real Permit2 sends it through
     *      solmate's `safeTransferFrom`, which accepts silence — so the mock was refusing a fill
     *      the deployed contract performs, on USDT's exact shape. The mock now matches.
     */
    function test_SilentPermit2() public {
        _run(Cell("silent / permit2", mute, p2, 18, true, ok, 0));
    }

    function test_BlockedApproval() public {
        _run(Cell("blocked / approval", ban, appr, 18, true, no, blocked));
    }

    function test_BlockedEscrow() public {
        _run(Cell("blocked / escrow", ban, esc, 18, true, no, blocked));
    }

    function test_BlockedPermit() public {
        _run(Cell("blocked / permit", ban, perm, 18, true, no, blocked));
    }

    function test_BlockedAuth() public {
        _run(Cell("blocked / auth", ban, auth, 18, true, no, blocked));
    }

    function test_BlockedPermit2() public {
        _run(Cell("blocked / permit2", ban, p2, 18, true, no, blocked));
    }

    function test_RebaseUpApproval() public {
        _run(Cell("rebase up / approval", up, appr, 18, true, ok, 0));
    }

    function test_RebaseUpEscrow() public {
        _run(Cell("rebase up / escrow", up, esc, 18, true, ok, 0));
    }

    function test_RebaseUpPermit() public {
        _run(Cell("rebase up / permit", up, perm, 18, true, ok, 0));
    }

    function test_RebaseUpAuthNoEIP3009() public {
        _run(Cell("rebase up / auth, no EIP-3009", up, auth, 18, true, na, 0));
    }

    /// @dev A cell the authorization column cannot run at all. The permit2 maker's signature is
    ///      Permit2's, not the token's, so an elastic token needs no EIP-3009 to reach this rung.
    function test_RebaseUpPermit2() public {
        _run(Cell("rebase up / permit2", up, p2, 18, true, ok, 0));
    }

    function test_RebaseDownApproval() public {
        _run(Cell("rebase down / approval", down, appr, 18, true, no, poor));
    }

    function test_RebaseDownEscrow() public {
        _run(Cell("rebase down / escrow", down, esc, 18, true, no, poor));
    }

    function test_RebaseDownPermit() public {
        _run(Cell("rebase down / permit", down, perm, 18, true, no, cannotPay));
    }

    function test_RebaseDownAuthNoEIP3009() public {
        _run(Cell("rebase down / auth, no EIP-3009", down, auth, 18, true, na, 0));
    }

    /// @dev The token's error, not ours, and that is the divergence from the permit column.
    ///      `_evaluate` reads the reservation for a custodied rung and never probes the maker's
    ///      wallet, so nothing on our side sees the halved balance before Permit2 asks for it.
    function test_RebaseDownPermit2() public {
        _run(Cell("rebase down / permit2", down, p2, 18, true, no, poor));
    }

    function test_WrapperApproval() public {
        _run(Cell("wrapper / approval", wrap, appr, 18, true, ok, 0));
    }

    function test_WrapperEscrow() public {
        _run(Cell("wrapper / escrow", wrap, esc, 18, true, ok, 0));
    }

    function test_WrapperPermitNoEIP2612() public {
        _run(Cell("wrapper / permit, no EIP-2612", wrap, perm, 18, true, na, 0));
    }

    function test_WrapperAuthNoEIP3009() public {
        _run(Cell("wrapper / auth, no EIP-3009", wrap, auth, 18, true, na, 0));
    }

    /// @dev The row's only gasless cell that settles. A par wrapper signs neither EIP-2612 nor
    ///      EIP-3009, and permit2 asks it for neither.
    function test_WrapperPermit2() public {
        _run(Cell("wrapper / permit2", wrap, p2, 18, true, ok, 0));
    }

    /**
     * @dev One cell, end to end.
     *
     * Everything that calls a token happens before `vm.expectRevert`. A permit digest reads the
     * token's domain and nonce, and an expectation set first would be satisfied by that read
     * rather than by the fill.
     */
    function _run(Cell memory c) private {
        if (c.verdict == Verdict.NotApplicable) {
            emit log_named_string("cell not applicable", c.name);
            return;
        }

        _deploy(c);
        ProveSettlement.Intent memory i = _intent(c);
        bytes32 h = settlement.hashIntent(i);
        bytes memory sig = _sign(i);
        uint256 take = _fund(c, i, h);

        ProveSettlement.Permit memory p;
        ProveSettlement.Authorization memory a;
        if (c.rung == Rung.Permit) p = _permit(c, block.timestamp + 1 days);
        if (c.rung == Rung.Authorization) a = _auth(c, h);
        if (c.rung == Rung.Permit2) _sign2(c, h, block.timestamp + 1 days);

        Snap memory s0 = _snap();

        if (c.verdict == Verdict.Refuses) vm.expectPartialRevert(c.err);
        _execute(c, i, sig, take, p, a);

        if (c.verdict == Verdict.Settles) _assertSettled(c, take, h, s0);
    }

    function _execute(
        Cell memory c,
        ProveSettlement.Intent memory i,
        bytes memory sig,
        uint256 take,
        ProveSettlement.Permit memory p,
        ProveSettlement.Authorization memory a
    ) private {
        if (c.rung == Rung.Permit2) {
            vm.prank(executor);
            settlement.fillWithPermit2(i, sig, take, p2Arm, ANY_FEE);
        } else if (c.rung == Rung.Permit) {
            vm.prank(executor);
            settlement.fillWithPermit(i, sig, take, p, ANY_FEE);
        } else if (c.rung == Rung.Authorization) {
            vm.prank(executor);
            settlement.fillWithAuthorization(i, sig, take, a, ANY_FEE);
        } else {
            vm.prank(executor);
            settlement.fill(i, sig, take, ANY_FEE);
        }
    }

    // ── What a settled cell must be worth ────────────────────────────────────

    function _assertSettled(Cell memory c, uint256 take, bytes32 h, Snap memory s0) private view {
        Expect memory e = _expect(c, take);

        assertEq(IERC20(tIn).balanceOf(maker), s0.makerIn - e.makerPaid, _msg(c, "maker paid in"));
        assertEq(IERC20(tIn).balanceOf(executor), s0.execIn + e.execGot, _msg(c, "executor got in"));
        assertEq(
            IERC20(tOut).balanceOf(maker), s0.makerOut + e.delivered, _msg(c, "maker paid out")
        );
        // The gross, whatever the rate is. The split moved the fee inside the maker's number, so
        // this figure did not move when the maker's did.
        assertEq(
            IERC20(tOut).balanceOf(executor), s0.execOut - e.gross, _msg(c, "executor paid out")
        );
        // The fee is booked to the destination, not transferred to it, so the row moves and the
        // balance does not. Every cell of the matrix asserts both halves.
        assertEq(
            settlement.pendingFees(feeCfg(feeTo), tOut),
            s0.feeToBook + e.fee,
            _msg(c, "feeTo's book")
        );
        assertEq(IERC20(tOut).balanceOf(feeTo), s0.feeToOut, _msg(c, "feeTo was never called"));
        // No fill reads `defaultProceeds`, on any token and any rung.
        assertEq(IERC20(tOut).balanceOf(sink), s0.sinkOut, _msg(c, "the owner's address"));

        // The permit2 promise, checked on every settled cell of that column: the maker granted
        // the relayer nothing, so a redeploy of this settlement costs them no second approval.
        if (c.rung == Rung.Permit2) {
            assertEq(IERC20(tIn).allowance(maker, relayer), 0, _msg(c, "no allowance to us"));
        }

        // The custody invariant, one asset at a time: what the contract holds is what its book
        // says it holds. The two rebasing rows break it on purpose and prove it in their own
        // tests, so they are the one exception and they are named.
        if (c.kind != Kind.RebaseUp && c.kind != Kind.RebaseDown) {
            assertEq(
                IERC20(tIn).balanceOf(address(settlement)),
                settlement.reserved(h),
                _msg(c, "held equals reserved")
            );
        }
    }

    /**
     * @dev The arithmetic the fill must produce, written out rather than read from `quote`. A
     *      test that asks the contract what it owes and then checks it paid that cannot fail.
     *
     * Every number divides exactly at both decimals the matrix uses, so nothing here rounds and
     * `_ceil` is only present to mirror the contract's direction on the gross.
     *
     * The fee comes out of the gross rather than on top of it, so the executor's outlay is
     * `e.gross` at every rate and the maker's receipt is what is left. The fee rounds down, and
     * at ten basis points on these amounts it divides exactly, so the direction is stated here
     * and pinned by `test/Fuzz.t.sol` rather than by this matrix.
     */
    function _expect(Cell memory c, uint256 take) private pure returns (Expect memory e) {
        uint256 unit = 10 ** c.dec;
        e.gross = _ceil(take * (100 * unit), 1_000 * unit);
        e.fee = (e.gross * FEE_RATE) / FEE_WAD;
        e.delivered = e.gross - e.fee;

        // What the maker parts with. Escrow already moved at deposit time and the fill costs the
        // maker nothing; an authorization redeems the whole `amountIn` however small the take is.
        //
        // A Permit2 signature draws the whole `amountIn` too, and for its own reason: Permit2
        // spends the nonce on the first call, whatever that call requested, so a smaller draw
        // would shut the door on the rest of a live intent. `_pullPermit2` says so at length.
        if (c.rung == Rung.Escrow) e.makerPaid = 0;
        else if (c.rung == Rung.Authorization || c.rung == Rung.Permit2) e.makerPaid = 1_000 * unit;
        else e.makerPaid = take;

        // And what reaches the executor, which is less whenever the token taxes its own transfer.
        e.execGot = _net(c, take);
    }

    // ── Building one cell's world ────────────────────────────────────────────

    /**
     * @dev Deploy this cell's pair, stock them, and grant the approvals the rung needs.
     *
     * `WeirdToken` carries the three misbehaviours and signs nothing; `FaucetToken` signs three
     * ways and misbehaves in none. Two of the three gasless rungs need both at once, so
     * `SigningWeirdToken` below is the intersection and it is used for those two columns only.
     * The plain rungs stay on the shipped mock, which keeps it the reference for the rows.
     *
     * **The permit2 column asks the token for no signature at all**, so it runs on the shipped
     * `WeirdToken` like the two ungasless rungs do. That is the rung's whole selling point in
     * one line of fixture: the maker signs, and the asset is not consulted.
     */
    function _deploy(Cell memory c) private {
        uint256 amountIn = 1_000 * 10 ** c.dec;
        bool signs = c.rung == Rung.Permit || c.rung == Rung.Authorization;

        if (c.kind == Kind.Standard) {
            FaucetToken t = new FaucetToken("Std", "STD", c.dec, 1, 0, address(this));
            t.mint(maker, amountIn);
            tIn = address(t);
        } else if (c.kind == Kind.RebaseUp || c.kind == Kind.RebaseDown) {
            RebasingToken t = new RebasingToken();
            t.mint(maker, amountIn);
            tIn = address(t);
        } else if (c.kind == Kind.ParWrapper) {
            tIn = _wrapper(c, amountIn);
        } else if (signs) {
            SigningWeirdToken t = new SigningWeirdToken(c.dec);
            t.mint(maker, amountIn);
            _misbehave(c, address(t));
            tIn = address(t);
        } else {
            WeirdToken t = new WeirdToken("Weird", "WRD", c.dec);
            t.mint(maker, amountIn);
            _misbehave(c, address(t));
            tIn = address(t);
        }

        MockERC20 out = new MockERC20("Out", "OUT", c.dec);
        out.mint(executor, 1_000_000 * 10 ** c.dec);
        tOut = address(out);

        // The permit rung must find no allowance, or `_grantAllowance` skips the permit and the
        // column tests nothing. The authorization rung never needs one.
        if (c.rung == Rung.Approval || c.rung == Rung.Escrow) {
            vm.prank(maker);
            IERC20(tIn).approve(relayer, type(uint256).max);
        }
        // The permit2 maker's one grant, and it does not name anything of ours. Permit2 sits at
        // the same address on every chain, so this approval survives a settlement redeploy —
        // which is why the rung exists. `_assertSettled` checks the relayer still holds nothing.
        if (c.rung == Rung.Permit2) {
            vm.prank(maker);
            IERC20(tIn).approve(address(permit2), type(uint256).max);
        }
        vm.prank(executor);
        IERC20(tOut).approve(relayer, type(uint256).max);
    }

    /**
     * @dev The switch this row is about. One per row, so no cell mixes two hazards.
     *
     * The cast holds for both mocks because `SigningWeirdToken` keeps `WeirdToken`'s three names
     * and signatures. That is the whole reason it copies them rather than inventing its own.
     */
    function _misbehave(Cell memory c, address token) private {
        if (c.kind == Kind.FeeOnTransfer) WeirdToken(token).setFeeBps(TAX_BPS);
        if (c.kind == Kind.Silent) WeirdToken(token).setSilent(true);
        if (c.kind == Kind.BlockedExecutor) WeirdToken(token).setBlocked(executor, true);
    }

    /// @dev The maker mints the underlying and wraps it, which is how an x402 balance is made.
    function _wrapper(Cell memory c, uint256 amountIn) private returns (address) {
        MockERC20 under = new MockERC20("Under", "UND", c.dec);
        under.mint(maker, amountIn);
        MockWrapper wrapped = new MockWrapper(address(under), c.dec);
        vm.startPrank(maker);
        under.approve(address(wrapped), amountIn);
        wrapped.wrap(amountIn);
        vm.stopPrank();
        return address(wrapped);
    }

    /**
     * @dev Arm the rung, move the index if the row is a rebasing one, and answer with the size to
     *      fill. The rebase lands after the funding and before the fill, which is the window the
     *      escrow book cannot see.
     */
    function _fund(Cell memory c, ProveSettlement.Intent memory i, bytes32 h)
        private
        returns (uint256)
    {
        if (c.rung == Rung.Escrow) {
            vm.prank(maker);
            settlement.deposit(i, i.amountIn);
            // `deposit` credits the balance that arrived. A taxed deposit therefore under-funds
            // the intent, and it never over-credits it.
            assertEq(settlement.reserved(h), _net(c, i.amountIn), _msg(c, "credited the delta"));
        }

        if (c.kind == Kind.RebaseUp) RebasingToken(tIn).rebase(2 * BPS);
        if (c.kind == Kind.RebaseDown) RebasingToken(tIn).rebase(BPS / 2);

        if (c.fullTake) return i.amountIn;
        // What the funding actually delivered. The same number for every token that does not tax.
        return _net(c, i.amountIn);
    }

    // ── Small parts ──────────────────────────────────────────────────────────

    function _intent(Cell memory c) private returns (ProveSettlement.Intent memory i) {
        uint256 unit = 10 ** c.dec;
        uint8 flags = settlement.FLAG_PARTIAL();
        if (c.rung == Rung.Escrow || c.rung == Rung.Authorization) {
            flags |= settlement.FLAG_ESCROW();
        }
        // Never both. `_termsOk` refuses an intent wearing the escrow flag and this one at once.
        if (c.rung == Rung.Permit2) flags |= settlement.FLAG_PERMIT2();

        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: tIn,
            tokenOut: tOut,
            amountIn: 1_000 * unit,
            minOutStart: 100 * unit,
            minOutEnd: 100 * unit,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(feeTo),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: FEE_RATE,
            minFill: 0,
            authNonce: bytes32(0),
            flags: flags,
            nonce: ++caseNonce,
            curve: bytes32(0)
        });
    }

    function _sign(ProveSettlement.Intent memory i) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /// @dev The maker's EIP-2612 signature over the relayer's allowance, never this contract's.
    function _permit(Cell memory c, uint256 deadline)
        private
        view
        returns (ProveSettlement.Permit memory p)
    {
        p.value = 1_000 * 10 ** c.dec;
        p.deadline = deadline;
        bytes32 structHash = keccak256(
            abi.encode(
                IPermitToken(tIn).PERMIT_TYPEHASH(),
                maker,
                relayer,
                p.value,
                IPermitToken(tIn).nonces(maker),
                deadline
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", IPermitToken(tIn).DOMAIN_SEPARATOR(), structHash)
        );
        (p.v, p.r, p.s) = vm.sign(makerKey, digest);
    }

    /// @dev The EIP-3009 authorization `_redeem` submits. Its nonce is the intent hash, which is
    ///      what binds one signature to one intent.
    function _auth(Cell memory c, bytes32 h)
        private
        view
        returns (ProveSettlement.Authorization memory a)
    {
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        a.nonce = h;
        bytes32 structHash = keccak256(
            abi.encode(
                IAuthToken(tIn).RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                maker,
                address(settlement),
                1_000 * 10 ** c.dec,
                a.validAfter,
                a.validBefore,
                a.nonce
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", IAuthToken(tIn).DOMAIN_SEPARATOR(), structHash));
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(makerKey, digest);
        a.signature = abi.encodePacked(ar, as_, av);
    }

    /**
     * @dev The maker's Permit2 SignatureTransfer, stored in `p2Arm` for `_execute` to present.
     *
     * Two things here are unlike every other EIP-712 digest in this repository, and both decide
     * whether the column tests anything. Permit2's domain carries **no version string**. And the
     * spender is **not a field** — Permit2 hashes `msg.sender` in, so this signature names the
     * relayer and is worth nothing to any other address that finds it.
     *
     * The nonce is the intent hash, which is what the settlement expects when the intent names
     * none of its own. It welds one signature to one offer.
     */
    function _sign2(Cell memory c, bytes32 h, uint256 deadline) private {
        p2Arm.token = tIn;
        p2Arm.amount = 1_000 * 10 ** c.dec;
        p2Arm.nonce = uint256(h);
        p2Arm.deadline = deadline;

        bytes32 structHash = keccak256(
            abi.encode(
                permit2.PERMIT_TRANSFER_FROM_TYPEHASH(),
                keccak256(
                    abi.encode(permit2.TOKEN_PERMISSIONS_TYPEHASH(), p2Arm.token, p2Arm.amount)
                ),
                relayer,
                p2Arm.nonce,
                p2Arm.deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", permit2.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(makerKey, digest);
        p2Arm.signature = abi.encodePacked(r, sv, v);
    }

    function _snap() private view returns (Snap memory s) {
        s.makerIn = IERC20(tIn).balanceOf(maker);
        s.execIn = IERC20(tIn).balanceOf(executor);
        s.makerOut = IERC20(tOut).balanceOf(maker);
        s.execOut = IERC20(tOut).balanceOf(executor);
        s.sinkOut = IERC20(tOut).balanceOf(sink);
        s.feeToOut = IERC20(tOut).balanceOf(feeTo);
        s.feeToBook = settlement.pendingFees(feeCfg(feeTo), tOut);
    }

    /// @dev What arrives when `amount` is sent, which is less on the taxing row alone.
    function _net(Cell memory c, uint256 amount) private pure returns (uint256) {
        return c.kind == Kind.FeeOnTransfer ? (amount * (BPS - TAX_BPS)) / BPS : amount;
    }

    function _ceil(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    function _msg(Cell memory c, string memory what) private pure returns (string memory) {
        return string.concat(c.name, ": ", what);
    }

    // ── The three findings the table points at ───────────────────────────────

    /**
     * @notice A taxing `tokenIn` settles and shorts the executor. A taxing `tokenOut` does not
     *         settle at all.
     *
     * One guard is the whole difference. `_deliverTo` brackets the delivery with a balance read,
     * so a token that eats a tenth of the maker's payout fails the fill with `Underpaid`.
     * `_release` reads nothing, so the same token on the other leg hands the executor a tenth
     * less than the maker paid and the fill stands. The maker's side is exact either way — the
     * gross they signed less the fee their intent named — and neither tax reaches it. That is the
     * promise the contract makes and keeps.
     */
    function test_ATaxingTokenInShortsTheExecutorAndATaxingTokenOutIsRefused() public {
        WeirdToken taxing = new WeirdToken("Tax", "TAX", 18);
        taxing.setFeeBps(TAX_BPS);
        MockERC20 clean = new MockERC20("Clean", "CLN", 18);
        taxing.mint(maker, 1_000e18);
        clean.mint(executor, 1_000_000e18);
        taxing.mint(executor, 1_000_000e18);

        vm.prank(maker);
        taxing.approve(relayer, type(uint256).max);
        vm.prank(executor);
        clean.approve(relayer, type(uint256).max);
        vm.prank(executor);
        taxing.approve(relayer, type(uint256).max);

        tIn = address(taxing);
        tOut = address(clean);
        ProveSettlement.Intent memory i = _intent(_plain(Rung.Approval));
        bytes memory sig = _sign(i);

        vm.prank(executor);
        settlement.fill(i, sig, 1_000e18, ANY_FEE);

        assertEq(taxing.balanceOf(maker), 0, "the maker parts with exactly what they signed");
        assertEq(taxing.balanceOf(executor), 1_000_900e18, "and the executor is short the tax");
        assertEq(
            clean.balanceOf(maker),
            100e18 - (uint256(100e18) * FEE_RATE) / FEE_WAD,
            "the maker is paid their whole side"
        );

        // The same token on the delivery leg, where the guard is.
        tIn = address(clean);
        tOut = address(taxing);
        clean.mint(maker, 1_000e18);
        vm.prank(maker);
        clean.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory j = _intent(_plain(Rung.Approval));
        bytes memory jsig = _sign(j);
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.Underpaid.selector);
        settlement.fill(j, jsig, 1_000e18, ANY_FEE);
    }

    /**
     * @notice A rebase down leaves the book claiming money the contract does not hold.
     *
     * This is the finding the matrix exists to record. The reservation is a number and the
     * balance behind every reservation of one asset is shared, so an index that falls makes the
     * two disagree with nothing to notice. The contract pays out in full until it cannot, and the
     * loss lands on whoever asks second. A share-denominated reservation would spread that loss
     * fairly, and it would also spend the guarantee that a donation cannot pay for a fill, which
     * is worth more. So the answer is a token allowlist off chain.
     */
    function test_ARebaseDownLeavesTheEscrowBookShortOfTheBalance() public {
        RebasingToken token = new RebasingToken();
        MockERC20 out = new MockERC20("Out", "OUT", 18);
        token.mint(maker, 1_000e18);
        out.mint(executor, 1_000_000e18);
        tIn = address(token);
        tOut = address(out);

        vm.prank(maker);
        token.approve(relayer, type(uint256).max);
        vm.prank(executor);
        out.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent(_plain(Rung.Escrow));
        bytes32 h = settlement.hashIntent(i);
        bytes memory sig = _sign(i);
        vm.prank(maker);
        settlement.deposit(i, 1_000e18);

        token.rebase(BPS / 2);

        assertEq(settlement.reserved(h), 1_000e18, "the book has not moved");
        assertEq(token.balanceOf(address(settlement)), 500e18, "the money has");

        // The whole reservation is unreachable: the token refuses what the book promises.
        vm.prank(executor);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientBalance.selector);
        settlement.fill(i, sig, 1_000e18, ANY_FEE);

        // Half of it fills, and takes every token the contract holds for this asset.
        vm.prank(executor);
        settlement.fill(i, sig, 500e18, ANY_FEE);
        assertEq(token.balanceOf(executor), 500e18, "the first caller is paid in full");
        assertEq(settlement.reserved(h), 500e18, "and the book still promises 500 more");
        assertEq(token.balanceOf(address(settlement)), 0, "against a balance of nothing");

        // Which the maker cannot have, because it is not there.
        vm.prank(maker);
        vm.expectPartialRevert(IERC20Errors.ERC20InsufficientBalance.selector);
        settlement.withdraw(i);
    }

    /**
     * @notice A rebase up strands the gain where nobody can reach it.
     *
     * The mirror of the loss and much the cheaper half. Escrow pays the number it booked, so the
     * tokens the index created above that number belong to no reservation. `withdraw` pays
     * `reserved` and refuses an empty one, so the surplus is not the maker's, not the executor's
     * and not the protocol's. It is dust, and it grows with every rebase.
     */
    function test_ARebaseUpStrandsTheGainInsideTheContract() public {
        RebasingToken token = new RebasingToken();
        MockERC20 out = new MockERC20("Out", "OUT", 18);
        token.mint(maker, 1_000e18);
        out.mint(executor, 1_000_000e18);
        tIn = address(token);
        tOut = address(out);

        vm.prank(maker);
        token.approve(relayer, type(uint256).max);
        vm.prank(executor);
        out.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent(_plain(Rung.Escrow));
        bytes32 h = settlement.hashIntent(i);
        bytes memory sig = _sign(i);
        vm.prank(maker);
        settlement.deposit(i, 1_000e18);

        token.rebase(2 * BPS);
        assertEq(token.balanceOf(address(settlement)), 2_000e18, "the contract holds twice");
        assertEq(settlement.reserved(h), 1_000e18, "and owes what it booked");

        vm.prank(executor);
        settlement.fill(i, sig, 1_000e18, ANY_FEE);

        assertEq(token.balanceOf(executor), 1_000e18, "the executor is paid the booked amount");
        assertEq(settlement.reserved(h), 0, "the reservation is spent");
        assertEq(token.balanceOf(address(settlement)), 1_000e18, "and the gain is still here");

        // Nobody owns it. `withdraw` reads the book, and the book says nothing is left.
        vm.prank(maker);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.withdraw(i);
    }

    /// @dev A plain 18-decimal cell, for the three tests that build their own tokens and only
    ///      need `_intent` to know which rung it is shaping.
    function _plain(Rung rung) private pure returns (Cell memory) {
        return Cell("finding", Kind.Standard, rung, 18, true, Verdict.Settles, 0);
    }
}

/// @dev The three EIP-2612 members `_permit` reads, on whichever row's token carries them.
interface IPermitToken {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function PERMIT_TYPEHASH() external view returns (bytes32);
    function nonces(address owner) external view returns (uint256);
}

/// @dev The two EIP-3009 members `_auth` reads.
interface IAuthToken {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
}

/**
 * @notice `WeirdToken`'s three misbehaviours on a token that can also sign.
 *
 * The matrix needs a taxing, silent or blocking token on the permit and authorization rungs, and
 * neither shipped fixture reaches that state: `WeirdToken` signs nothing and `FaucetToken`
 * misbehaves in nothing. This is the intersection and nothing more — the switches keep
 * `WeirdToken`'s names and semantics, and the signatures are `FaucetToken`'s, inherited whole.
 *
 * The tax and the block sit in `_update` rather than in `transfer`, because EIP-3009 redeems
 * through `_transfer` and a token that taxed only its two public entry points would let the
 * gasless column pass for the wrong reason.
 */
contract SigningWeirdToken is FaucetToken {
    uint256 private constant BPS_ = 10_000;

    uint16 public feeBps;
    bool public silent;
    mapping(address => bool) public blocked;

    error Blocked(address account);

    constructor(uint8 decimals_) FaucetToken("Weird Signer", "WSGN", decimals_, 1, 0, msg.sender) {}

    function setFeeBps(uint16 bps) external {
        feeBps = bps;
    }

    function setSilent(bool on) external {
        silent = on;
    }

    function setBlocked(address account, bool on) external {
        blocked[account] = on;
    }

    function transfer(address to, uint256 value) public override returns (bool ok) {
        ok = super.transfer(to, value);
        _answer();
    }

    function transferFrom(address from, address to, uint256 value)
        public
        override
        returns (bool ok)
    {
        ok = super.transferFrom(from, to, value);
        _answer();
    }

    /// @dev Minting is exempt, so a fixture can stock a wallet and then arm the tax.
    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);

        uint256 fee = (value * feeBps) / BPS_;
        if (fee > 0) super._update(from, address(0), fee);
        super._update(from, to, value - fee);
    }

    /// @dev End the call with an empty return buffer, the way USDT does. `WeirdToken` says why
    ///      only assembly can do it.
    function _answer() private view {
        if (!silent) return;
        assembly ("memory-safe") {
            return(0, 0)
        }
    }
}
