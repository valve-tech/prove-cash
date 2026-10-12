// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ProveRelayer} from "../src/ProveRelayer.sol";
import {ISignatureTransfer} from "../src/interfaces/IPermit2.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockERC20, MockPermit2} from "./Mocks.sol";
import {WeirdToken} from "./tokens/WeirdToken.sol";
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
 * @notice The allowance split, and the properties it exists to buy.
 *
 *   forge test --match-path test/Relayer.t.sol -vv
 *
 * `ProveSettlement` was the contract that held every maker's approval *and* the contract that
 * called addresses a caller chose. One implicit property kept those apart — every call it makes
 * carries a selector it chose itself — and a property nobody wrote down is one a future call site
 * can drop without noticing. The allowance now lives on `ProveRelayer`, which holds nothing and
 * can do one thing.
 *
 * The split is only worth its gas if three things are true, so each gets a test:
 *
 *   1. Nobody but the settlement can make the relayer move anything.
 *   2. The settlement's own arbitrary-call context can never target the relayer. Without this the
 *      split is decorative, because the relayer obeys the settlement.
 *   3. One approval, to one address, whichever side of the trade you are on and whichever custody
 *      rung the maker climbed to.
 *
 * The relayer gained a second function for the permit2 rung, and the first of those three claims
 * is what makes it safe. `pullWithPermit2` calls one address fixed at construction, sends to one
 * address fixed at construction, and refuses every caller but the settlement — so it is strictly
 * narrower than `pull`, which does take a destination.
 */
contract RelayerTest is Test {
    ProveSettlement settlement;
    ProveRelayer relayer;
    MockPermit2 permit2;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address sink = address(0x5152);
    address executor = address(0xE0E);
    address maker;
    uint256 makerKey;

    uint256 constant AMOUNT_IN = 100e18;
    uint256 constant MIN_OUT = 90e18;
    /// @dev What the maker keeps out of a gross of `MIN_OUT`. The fee comes out of the number
    ///      the maker signed, so the curve's figure is the executor's outlay and this is the
    ///      maker's receipt. Ten basis points, and it divides exactly here.
    uint256 constant NET_OUT = MIN_OUT - (MIN_OUT * 0.001e18) / 1e18;
    uint256 constant ANY_FEE = type(uint256).max;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        permit2 = new MockPermit2();
        settlement = newSettlement(address(permit2));
        relayer = ProveRelayer(settlement.relayer());

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenA.mint(maker, 1_000e18);
        tokenB.mint(executor, 1_000e18);

        vm.prank(maker);
        tokenA.approve(address(relayer), type(uint256).max);
        vm.prank(executor);
        tokenB.approve(address(relayer), type(uint256).max);

        vm.warp(1_700_000_000);
    }

    function _intent() internal view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: AMOUNT_IN,
            minOutStart: MIN_OUT,
            minOutEnd: MIN_OUT,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 3600),
            executor: address(0),
            feeConfig: feeCfg(sink),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0.001e18,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL(),
            nonce: 1,
            curve: bytes32(0)
        });
    }

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    // ── 1. The relayer obeys one caller ──────────────────────────────────────

    /// @notice The relayer knows its settlement from birth, and cannot be re-pointed.
    function test_TheRelayerIsBoundToItsSettlementAtConstruction() public view {
        assertEq(relayer.settlement(), address(settlement), "the deployer is the settlement");
    }

    /// @notice The maker's whole allowance sits here, and a stranger cannot touch a wei of it.
    function test_OnlyTheSettlementCanMakeTheRelayerMoveAnything() public {
        assertEq(tokenA.allowance(maker, address(relayer)), type(uint256).max, "the honeypot");

        address thief = address(0xBAD);
        vm.prank(thief);
        vm.expectRevert(ProveRelayer.NotSettlement.selector);
        relayer.pull(address(tokenA), maker, thief, AMOUNT_IN);

        // Not even the maker, and not even the owner of the settlement.
        vm.prank(maker);
        vm.expectRevert(ProveRelayer.NotSettlement.selector);
        relayer.pull(address(tokenA), maker, thief, AMOUNT_IN);

        vm.prank(address(0xB0B));
        vm.expectRevert(ProveRelayer.NotSettlement.selector);
        relayer.pull(address(tokenA), maker, thief, AMOUNT_IN);

        assertEq(tokenA.balanceOf(thief), 0, "nothing left the maker");
    }

    /**
     * @notice A token that answers `false` is a refusal, not a payment.
     *
     * `pull` is the whole contract, and the one line in it is `safeTransferFrom` rather than
     * `transferFrom`. Two token shapes make that choice load-bearing and they pull in opposite
     * directions. USDT and its imitators return nothing on success, so a caller that decodes the
     * answer reverts on a payment that was made. Older tokens return `false` on failure instead
     * of reverting, so a caller that ignores the answer books a payment that was never made.
     *
     * The second is the dangerous one here. The settlement credits a leg once this call returns,
     * so a silent `false` would release the maker's token A against a payment that never landed.
     * Every other fixture in this repo inherits OpenZeppelin and reverts instead, which is why
     * `WeirdToken` grew a switch for it: without one, deleting `safe` from this line changes
     * nothing anywhere in the suite.
     */
    function test_ATransferThatAnswersFalseIsNotAPayment() public {
        WeirdToken bad = new WeirdToken("Bad", "BAD", 18);
        bad.mint(maker, 1_000e18);
        // A finite approval, so the allowance below says something: an infinite one never moves.
        vm.prank(maker);
        bad.approve(address(relayer), AMOUNT_IN);

        address payee = address(0xFEE);
        bad.setReturnsFalse(true);

        vm.prank(address(settlement));
        vm.expectRevert(
            abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(bad))
        );
        relayer.pull(address(bad), maker, payee, AMOUNT_IN);

        assertEq(bad.balanceOf(payee), 0, "the payee was paid nothing");
        assertEq(bad.balanceOf(maker), 1_000e18, "and the maker still holds every token");
        assertEq(bad.allowance(maker, address(relayer)), AMOUNT_IN, "and no allowance was spent");

        // The same call, the same token, an honest answer: it goes through. So `false` was the
        // only fault, and the revert above cannot have been anything else.
        bad.setReturnsFalse(false);
        vm.prank(address(settlement));
        relayer.pull(address(bad), maker, payee, AMOUNT_IN);
        assertEq(bad.balanceOf(payee), AMOUNT_IN, "the honest answer paid the payee");
    }

    /**
     * @notice And a token that answers with nothing at all is still a payment.
     *
     * The other half of the same choice. `safeTransferFrom` has to accept an empty return buffer
     * or every USDT-shaped token is unfillable, so this pins the tolerance next to the refusal
     * above rather than leaving `pull` proved in one direction only.
     */
    function test_ATransferThatAnswersWithNothingIsStillAPayment() public {
        WeirdToken quiet = new WeirdToken("Quiet", "QUI", 18);
        quiet.mint(maker, 1_000e18);
        vm.prank(maker);
        quiet.approve(address(relayer), type(uint256).max);

        address payee = address(0xFEE);
        quiet.setSilent(true);

        vm.prank(address(settlement));
        relayer.pull(address(quiet), maker, payee, AMOUNT_IN);

        assertEq(quiet.balanceOf(payee), AMOUNT_IN, "the payee was paid");
    }

    /// @notice The relayer knows its Permit2 from birth as well, and cannot be re-pointed at
    ///         another one. It is the address makers on that rung approve.
    function test_TheRelayerIsBoundToItsPermit2AtConstruction() public view {
        assertEq(relayer.permit2(), address(permit2), "the settlement handed it down");
    }

    /**
     * @notice A maker's Permit2 signature is spendable by the settlement and by nobody else.
     *
     * Two locks, and the test turns both. Permit2 hashes `msg.sender` in as the spender, so a
     * thief calling Permit2 directly presents a signature that names somebody else. And the
     * relayer, which is the address the signature does name, refuses every caller but the
     * settlement — so the thief cannot borrow it either.
     */
    function test_OnlyTheSettlementCanSpendAPermit2Signature() public {
        address thief = address(0xBAD);
        uint256 nonce = uint256(keccak256("a lot the maker offered"));
        uint256 deadline = block.timestamp + 1 days;

        // A real signature, the maker's own, naming the relayer as its spender.
        bytes memory signature = _permit2Signature(nonce, deadline);
        vm.prank(maker);
        tokenA.approve(address(permit2), type(uint256).max);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({
                token: address(tokenA), amount: AMOUNT_IN
            }),
            nonce: nonce,
            deadline: deadline
        });

        // The relayer is the address the signature names, and it answers to one caller.
        vm.prank(thief);
        vm.expectRevert(ProveRelayer.NotSettlement.selector);
        relayer.pullWithPermit2(permit, maker, AMOUNT_IN, signature);

        // Permit2 itself refuses the thief, because the spender it checks is whoever is calling.
        vm.prank(thief);
        vm.expectRevert(MockPermit2.InvalidSigner.selector);
        permit2.permitTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails({to: thief, requestedAmount: AMOUNT_IN}),
            maker,
            signature
        );

        assertEq(tokenA.balanceOf(thief), 0, "nothing left the maker");
        assertEq(permit2.nonceBitmap(maker, nonce >> 8), 0, "and nothing was spent trying");
    }

    /// @dev One Permit2 SignatureTransfer of the maker's, signed for the relayer as spender.
    ///      Permit2's domain carries no version string, which is unlike every other one here.
    function _permit2Signature(uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                permit2.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        permit2.PERMIT_TRANSFER_FROM_TYPEHASH(),
                        keccak256(
                            abi.encode(
                                permit2.TOKEN_PERMISSIONS_TYPEHASH(), address(tokenA), AMOUNT_IN
                            )
                        ),
                        address(relayer),
                        nonce,
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(makerKey, digest);
        return abi.encodePacked(r, sv, v);
    }

    /**
     * @notice The relayer never holds a balance, so there is nothing in it to steal.
     *
     * `pull` is a directed `transferFrom` from the maker to the payee. The tokens do not stop
     * here on the way past, which is what makes "it holds nothing" a fact about the code rather
     * than a hope about how it is called.
     */
    function test_TheRelayerHoldsNothingOnTheWayThrough() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(tokenA.balanceOf(address(relayer)), 0, "no token A rested here");
        assertEq(tokenB.balanceOf(address(relayer)), 0, "no token B either");
        assertEq(tokenB.balanceOf(maker), NET_OUT, "and the maker was paid");
    }

    // ── 2. The call surface cannot be aimed at it ────────────────────────────

    /**
     * @notice (a′). The callback context may not be the relayer, nor the settlement itself.
     *
     * Neither can call in today — the relayer has one function, and `nonReentrant` stops a
     * self-call. `vm.prank` puts the check under the only conditions that could ever reach it, so
     * the guard is proved rather than assumed, and it goes on being proved for call sites nobody
     * has written yet.
     */
    function test_TheCallbackTargetCanNeverBeTheRelayerOrTheSettlement() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        vm.prank(address(relayer));
        vm.expectRevert(ProveSettlement.ForbiddenTarget.selector);
        settlement.fillWithCallback(i, sig, AMOUNT_IN, "", ANY_FEE);

        vm.prank(address(settlement));
        vm.expectRevert(ProveSettlement.ForbiddenTarget.selector);
        settlement.fillWithCallback(i, sig, AMOUNT_IN, "", ANY_FEE);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] =
            ProveSettlement.FillRequest({intent: i, signature: sig, take: AMOUNT_IN, arming: ""});

        vm.prank(address(relayer));
        vm.expectRevert(ProveSettlement.ForbiddenTarget.selector);
        settlement.fillBatchWithCallback(reqs, false, "", ANY_FEE);

        vm.prank(address(settlement));
        vm.expectRevert(ProveSettlement.ForbiddenTarget.selector);
        settlement.fillBatchWithCallback(reqs, false, "", ANY_FEE);
    }

    /**
     * @notice The guard refuses before anything moves, not after.
     *
     * A check that fires after the release would leave the maker's tokens sitting at a forbidden
     * address inside a reverted frame — harmless today, and exactly the kind of ordering that
     * stops being harmless when a call site changes.
     */
    function test_TheForbiddenTargetIsRefusedBeforeAnyReleaseHappens() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        uint256 before = tokenA.balanceOf(maker);

        vm.prank(address(relayer));
        vm.expectRevert(ProveSettlement.ForbiddenTarget.selector);
        settlement.fillWithCallback(i, sig, AMOUNT_IN, "", ANY_FEE);

        assertEq(tokenA.balanceOf(maker), before, "the maker still holds everything");
        assertEq(settlement.filled(settlement.hashIntent(i)), 0, "and nothing was booked");
    }

    // ── 3. One approval, one address, both custody modes ─────────────────────

    /**
     * @notice The migration, stated as a test: the old approval target no longer works.
     *
     * Every approval granted to the settlement before this change points at the wrong address.
     * This is the whole cost of the split, and it is the reason to take it before the first real
     * maker rather than after.
     */
    function test_ApprovingTheSettlementNoLongerFundsAFill() public {
        address late = makeAddr("late");
        uint256 lateKey = uint256(keccak256("lateKey"));
        late = vm.addr(lateKey);

        tokenA.mint(late, 1_000e18);
        vm.prank(late);
        tokenA.approve(address(settlement), type(uint256).max); // the old target

        ProveSettlement.Intent memory i = _intent();
        i.maker = late;
        i.recipient = late;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(lateKey, settlement.hashIntent(i));

        vm.prank(executor);
        vm.expectRevert();
        settlement.fill(i, abi.encodePacked(r, s, v), AMOUNT_IN, ANY_FEE);

        // And the view says so first, so the board greys the row out rather than letting an
        // executor discover it by burning gas.
        assertEq(
            uint256(
                settlement.fillability(i, abi.encodePacked(r, s, v), AMOUNT_IN, executor, ANY_FEE)
            ),
            uint256(ProveSettlement.Reason.EscrowShort),
            "the pre-screen reads the relayer's allowance, not the settlement's"
        );
    }

    /// @notice One approval covers a wallet fill and an escrow deposit. The maker signs one
    ///         `approve` whichever rung they climb to.
    function test_OneApprovalCoversBothCustodyModes() public {
        assertEq(tokenA.allowance(maker, address(settlement)), 0, "nothing approved to the old one");

        // Wallet custody, straight through. The signature is taken first: `_sign` reads the
        // contract, and an inline call there would eat the prank.
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        vm.prank(executor);
        settlement.fill(i, sig, 1e18, ANY_FEE);

        // Escrow custody, same allowance, no second approval anywhere.
        ProveSettlement.Intent memory e = _intent();
        e.nonce = 2;
        e.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        vm.prank(maker);
        settlement.deposit(e, AMOUNT_IN);

        assertEq(settlement.reserved(settlement.hashIntent(e)), AMOUNT_IN, "the escrow funded");
        assertEq(
            tokenA.allowance(maker, address(settlement)), 0, "and still nothing to the old one"
        );
    }

    /**
     * @notice The property the whole section is for, with no exception in it.
     *
     * Both sides of a completed trade approved the relayer and neither approved the settlement.
     * The first version of this split moved only the maker, which left the rule as "no *maker*
     * allowance lives here" — true, and a rule a contributor has to hold two cases in mind to
     * apply. This asserts the one-clause version.
     */
    function test_NoAllowanceOfAnyKindEndsUpOnTheSettlement() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(tokenA.allowance(maker, address(settlement)), 0, "the maker approved elsewhere");
        assertEq(tokenB.allowance(executor, address(settlement)), 0, "so did the executor");
        assertGt(tokenA.allowance(maker, address(relayer)), 0, "the relayer carries the maker's");
        assertGt(tokenB.allowance(executor, address(relayer)), 0, "and the executor's");
    }

    /**
     * @notice The executor's side is dead on the old address too, not just the maker's.
     *
     * An executor who approves the settlement gets a revert on the payment leg rather than on the
     * release, which is a different and more confusing failure than the maker's. Both are the
     * same migration, so both are pinned.
     */
    function test_AnExecutorWhoApprovesTheSettlementCannotPay() public {
        address late = makeAddr("lateExecutor");
        tokenB.mint(late, 1_000e18);
        vm.prank(late);
        tokenB.approve(address(settlement), type(uint256).max); // the old target

        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        vm.prank(late);
        vm.expectRevert();
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    // ── Fuzzed, because the guards are about *every* address ─────────────────

    /**
     * @notice One caller, out of every address there is.
     *
     * `test_OnlyTheSettlementCanMakeTheRelayerMoveAnything` names three callers it expects to
     * fail. This is the general statement: `pull` succeeds for the settlement and reverts for
     * everything else, with no address anywhere that slips through. The maker's whole allowance
     * sits behind this one comparison.
     */
    function testFuzz_PullRefusesEveryCallerButTheSettlement(address caller, uint256 amount)
        public
    {
        vm.assume(caller != address(settlement));
        amount = bound(amount, 1, 1_000e18);

        uint256 before = tokenA.balanceOf(maker);
        vm.prank(caller);
        vm.expectRevert(ProveRelayer.NotSettlement.selector);
        relayer.pull(address(tokenA), maker, caller, amount);
        assertEq(tokenA.balanceOf(maker), before, "the maker still holds it all");
    }

    /**
     * @notice The guard refuses exactly two addresses — no more, no fewer.
     *
     * A guard that is too broad breaks honest executors, and one that is too narrow is the hole it
     * was written to close. Fuzzing the caller pins both edges at once: every address that is not
     * the relayer or the settlement must get past `_requireCallableTarget` and fail later, on its
     * own merits, rather than on the guard.
     */
    function testFuzz_TheCallbackGuardRefusesTheRelayerAndTheSettlementAndNothingElse(address caller)
        public
    {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        bool forbidden = caller == address(relayer) || caller == address(settlement);

        vm.prank(caller);
        try settlement.fillWithCallback(i, sig, AMOUNT_IN, "", ANY_FEE) {
            assertFalse(forbidden, "a forbidden target got through");
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            if (forbidden) {
                assertEq(sel, ProveSettlement.ForbiddenTarget.selector, "wrong reason for a ban");
            } else {
                // An EOA has no `proveCallback` and no allowance, so it fails — but never here.
                assertTrue(sel != ProveSettlement.ForbiddenTarget.selector, "guard too broad");
            }
        }
    }

    /**
     * @notice Whatever moves through the relayer, none of it stays.
     *
     * The relayer is worth attacking only if it can hold something. `pull` is a directed
     * `transferFrom`, so the claim is structural, and this says so for every amount rather than
     * for the one a unit test picked.
     */
    function testFuzz_TheRelayerKeepsNothingWhateverPassesThrough(uint256 take) public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        take = bound(take, 1, AMOUNT_IN);

        vm.prank(executor);
        settlement.fill(i, sig, take, ANY_FEE);

        assertEq(tokenA.balanceOf(address(relayer)), 0, "token A rested in the relayer");
        assertEq(tokenB.balanceOf(address(relayer)), 0, "token B rested in the relayer");
    }

    /**
     * @notice Both sides approve one address, and the settlement is a spender for nobody.
     *
     * The single-fill version of this asserts it once. Fuzzing the size runs it across partial
     * fills, exact fills, and the rounding boundary between them, where the fee and the delivery
     * are two separate pulls that could each have been left behind.
     */
    function testFuzz_TheSettlementIsNeverASpender(uint256 take) public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        take = bound(take, 1, AMOUNT_IN);

        vm.prank(executor);
        settlement.fill(i, sig, take, ANY_FEE);

        assertEq(tokenA.allowance(maker, address(settlement)), 0, "the maker approved it");
        assertEq(tokenB.allowance(executor, address(settlement)), 0, "the executor approved it");
    }

    // ── What the split costs ─────────────────────────────────────────────────

    /// @notice The price of the structure, on the path that pays it. Reporting only; gas
    ///         assertions do not survive coverage instrumentation. See `Gas.t.sol`.
    function test_GasReportTheRelayerHop() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        // Warm every account and slot this fill touches, so the row is a marginal fill.
        vm.prank(executor);
        settlement.fill(i, sig, 1e18, ANY_FEE);

        uint256 g = gasleft();
        vm.prank(executor);
        settlement.fill(i, sig, 1e18, ANY_FEE);
        console.log("fill, approval custody, through the relayer", g - gasleft());

        ProveSettlement.Intent memory e = _intent();
        e.nonce = 3;
        e.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        vm.startPrank(maker);
        settlement.deposit(e, 10e18);
        g = gasleft();
        settlement.deposit(e, 10e18);
        console.log("deposit, through the relayer               ", g - gasleft());
        vm.stopPrank();
    }
}
