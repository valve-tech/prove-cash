// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {IProveBatchCallback} from "../src/interfaces/IProveBatchCallback.sol";
import {
    ANY_FEE,
    BatchExecutor,
    BatchRecorder,
    MockERC20,
    NO_PERMIT2,
    ReentrantBatchExecutor
} from "./Mocks.sol";
import {TaxToken} from "./Security.t.sol";
import {
    proceedsRate,
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
 * @notice `fillBatchWithCallback` — release everything, call once, pull every payment.
 *
 * The contract pays the makers itself. It does not watch balances and infer that somebody paid.
 * These tests are written against the three things a balance-delta proof gets wrong: a donation
 * looks like a payment, one payee's two debts share one measurement, and any code inside the
 * window can satisfy the check with somebody else's money.
 */
contract BatchCallbackTest is Test {
    /// @dev The solver-borne P2 rate the next ring is built with. The caller\'s `maxFeeRate`
    ///      bounds P1 + P2 and not the maker-borne P3, so a bound test needs a P2.
    uint64 p2Rate;

    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;
    BatchExecutor exec;

    MockERC20 tokenA;
    MockERC20 tokenB;

    address sink = address(0x5152);
    address stash = address(0x57A5);

    address makerA;
    uint256 keyA;
    address makerB;
    uint256 keyB;

    function setUp() public {
        (makerA, keyA) = makeAddrAndKey("makerA");
        (makerB, keyB) = makeAddrAndKey("makerB");

        settlement = newSettlement(NO_PERMIT2);

        relayer = settlement.relayer();
        exec = new BatchExecutor();
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);

        tokenA.mint(makerA, 1_000_000e18);
        tokenB.mint(makerB, 1_000_000e18);
        tokenA.mint(stash, 1_000_000e18);
        tokenB.mint(stash, 1_000_000e18);

        vm.prank(makerA);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(makerB);
        tokenB.approve(relayer, type(uint256).max);
        vm.startPrank(stash);
        tokenA.approve(address(exec), type(uint256).max);
        tokenB.approve(address(exec), type(uint256).max);
        vm.stopPrank();

        // The contract pulls out of the executor, so the executor approves it. This is the same
        // allowance `fillBatch` already needs, and it is the executor's own risk.
        exec.approveMax(address(tokenA), relayer);
        exec.approveMax(address(tokenB), relayer);

        vm.warp(1_700_000_000);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _intent(
        address maker,
        address recipient,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 nonce
    ) internal view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: recipient,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minOutStart: minOut,
            minOutEnd: minOut,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(sink),
            feeRate: p2Rate,
            feeRateIn: 0,
            feeRateProceeds: 0.001e18,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL(),
            nonce: nonce,
            curve: bytes32(0)
        });
    }

    function _sign(ProveSettlement.Intent memory i, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function _req(ProveSettlement.Intent memory i, uint256 key, uint256 take)
        internal
        view
        returns (ProveSettlement.FillRequest memory)
    {
        return ProveSettlement.FillRequest({
            intent: i, signature: _sign(i, key), take: take, arming: ""
        });
    }

    /// @dev The two-leg ring most of these tests use. Maker A sells token A for token B, maker B
    ///      sells token B for token A, and between them they concede enough to pay for both.
    function _ring() internal view returns (ProveSettlement.FillRequest[] memory reqs) {
        ProveSettlement.Intent memory legA =
            _intent(makerA, makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        ProveSettlement.Intent memory legB =
            _intent(makerB, makerB, address(tokenB), address(tokenA), 100e18, 900e18, 2);
        reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _req(legA, keyA, 1_000e18);
        reqs[1] = _req(legB, keyB, 100e18);
    }

    /// @dev The two fees a ring cannot generate, minted to the executor and nothing else.
    /**
     * @dev Each leg's fee, and nothing is minted for it.
     *
     * This used to mint the two fees to the executor, because the fee was charged on top of the
     * delivery and a ring that released exactly the deliveries could not cover it. The fee comes
     * out of the maker's number now, so a ring's releases pay its deliveries and its fees
     * together and the solver needs no capital at all — not even a wei of it.
     */
    function _feesOn(ProveSettlement.FillRequest[] memory reqs)
        internal
        view
        returns (uint256 feeA, uint256 feeB)
    {
        feeA = settlement.quote(reqs[0].intent, reqs[0].take, block.timestamp).feeProceeds;
        feeB = settlement.quote(reqs[1].intent, reqs[1].take, block.timestamp).feeProceeds;
    }

    // ── The capital claim, tested for real ───────────────────────────────────

    /**
     * @notice A solver with nothing settles a ring.
     *
     * The executor holds no token A and no token B, and no stash backs it. Both releases land
     * before either payment is pulled, so maker A's token A pays maker B and maker B's token B
     * pays maker A. The fees come out of the same two releases, so nothing has to be funded —
     * which was not true while the fee rode on top of the delivery.
     */
    function test_ARingSettlesWithNoWorkingCapital() public {
        assertEq(tokenA.balanceOf(address(exec)), 0, "the solver starts with nothing");
        assertEq(tokenB.balanceOf(address(exec)), 0);

        ProveSettlement.FillRequest[] memory reqs = _ring();

        uint256 count = exec.settle(settlement, reqs, false, "", ANY_FEE);

        assertEq(count, 2, "both legs settled");
        assertEq(tokenB.balanceOf(makerA), 99.9e18, "maker A got the rate they signed");
        assertEq(tokenA.balanceOf(makerB), 899.1e18, "maker B got the rate they signed");
        assertEq(tokenA.balanceOf(address(exec)), 100e18, "and the solver kept the spread");
        assertEq(tokenB.balanceOf(address(exec)), 0, "having brought nothing and kept nothing");
    }

    /// @notice The same ring through `fillBatch` cannot settle, which is the whole reason this
    ///         function exists. `fillBatch` pays leg one before it releases leg two.
    function test_TheSameRingThroughFillBatchNeedsInventory() public {
        ProveSettlement.FillRequest[] memory reqs = _ring();

        vm.prank(address(exec));
        vm.expectRevert();
        settlement.fillBatch(reqs, false, ANY_FEE);
    }

    // ── What the pull kills that a delta check cannot ────────────────────────

    /**
     * @notice A donation is not a payment.
     *
     * The callback sends the payee the full delivery before the contract pulls. Under a balance
     * delta that discharges the debt and the executor pays nothing. Under a pull the payee ends
     * up with both.
     */
    function test_ADonationDoesNotDischargeADebt() public {
        exec.setStash(stash);
        exec.setDonate(100e18);

        ProveSettlement.FillRequest[] memory reqs = _ring();
        exec.settle(settlement, reqs, false, "", ANY_FEE);

        assertEq(tokenB.balanceOf(makerA), 199.9e18, "the gift and the payment both landed");
    }

    /**
     * @notice Two legs to one payee are two debts, not one measurement.
     *
     * A snapshot per leg reads the same balance twice and lets one payment satisfy both. Two
     * directed transfers cannot make that mistake, and no aggregation is needed to avoid it.
     */
    function test_TwoLegsToOneRecipientAreBothPaid() public {
        exec.setStash(stash);

        ProveSettlement.Intent memory one =
            _intent(makerA, makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        ProveSettlement.Intent memory two =
            _intent(makerA, makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 2);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _req(one, keyA, 1_000e18);
        reqs[1] = _req(two, keyA, 1_000e18);

        exec.settle(settlement, reqs, false, "", ANY_FEE);

        assertEq(exec.lastLines(), 2, "one line a leg, no merging");
        assertEq(tokenB.balanceOf(makerA), 199.8e18, "and both were paid");
    }

    /**
     * @notice A recipient that is also the fee sink is paid twice, correctly.
     *
     * This is the case a delta check cannot answer, because it cannot tell the delivery from the
     * fee when the payee is the same. A pull does not need to tell them apart.
     */
    function test_ARecipientThatIsTheSinkGetsBothTransfers() public {
        exec.setStash(stash);

        ProveSettlement.Intent memory i =
            _intent(makerA, sink, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        TakePoints.Quote memory q_fee = settlement.quote(i, 1_000e18, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertGt(fee, 0, "there is a fee to confuse");

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _req(i, keyA, 1_000e18);

        exec.settle(settlement, reqs, false, "", ANY_FEE);
        // Two things, not one balance: the delivery is transferred to the recipient and the fee
        // is a row in the settlement's book, so this test can name each of them.
        assertEq(tokenB.balanceOf(sink), delivered, "the delivery landed");
        assertEq(
            settlement.pendingFees(feeCfg(sink), address(tokenB)),
            fee,
            "and the fee was booked to it"
        );
    }

    /**
     * @notice A release is not a payment, and the contract never confuses the two.
     *
     * Token A is `tokenIn` for leg one and `tokenOut` for leg two, so 1,000 token A lands on the
     * executor before maker B is paid 900 token A. Under a balance delta the two are the same
     * event. Under a pull they are transfers in opposite directions, and the arithmetic shows
     * it: the executor ends up 100 token A better off, which is the spread and nothing more.
     */
    function test_TheReleaseIsNotAPayment() public {
        ProveSettlement.FillRequest[] memory reqs = _ring();

        exec.settle(settlement, reqs, false, "", ANY_FEE);

        assertEq(tokenA.balanceOf(makerB), 899.1e18, "maker B was paid, out of maker A's release");
        assertEq(tokenA.balanceOf(address(exec)), 100e18, "1,000 in, 900 out, fee inside the 900");
        assertEq(tokenB.balanceOf(address(exec)), 0, "and the token B fee was booked to the sink");
    }

    /// @notice One wei short anywhere and nothing settles.
    ///
    /// @dev The ring covers itself exactly now, so being short is a matter of parting with a wei
    ///      rather than of never having had it. The callback donates one wei of token B to
    ///      maker A before the pull; a donation discharges nothing, so the pull then finds the
    ///      executor a wei light and the whole batch unwinds.
    function test_AnExecutorOneWeiShortSettlesNothing() public {
        ProveSettlement.FillRequest[] memory reqs = _ring();
        (uint256 feeA,) = _feesOn(reqs);
        assertGt(feeA, 0, "there was a fee to be short of");
        exec.setDonate(1);

        vm.expectRevert();
        exec.settle(settlement, reqs, false, "", ANY_FEE);
    }

    function test_ATaxedOutputTokenStillFailsTheFill() public {
        TaxToken tax = new TaxToken();
        tax.mint(address(exec), 1_000_000e18);
        exec.approveMax(address(tax), relayer);

        ProveSettlement.Intent memory i =
            _intent(makerA, makerA, address(tokenA), address(tax), 1_000e18, 100e18, 1);
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _req(i, keyA, 1_000e18);

        // The delta inside `_deliverTo` is still doing its real job: catching a token that
        // shortens its own transfers.
        vm.expectRevert(ProveSettlement.Underpaid.selector);
        exec.settle(settlement, reqs, false, "", ANY_FEE);
    }

    // ── The rest of the contract's promises still hold ───────────────────────

    function test_SkipInvalidStepsOverALegAndStillSettlesTheOthers() public {
        exec.setStash(stash);

        ProveSettlement.FillRequest[] memory reqs = _ring();
        reqs[1].intent.endTime = uint64(block.timestamp); // already over
        reqs[1].signature = _sign(reqs[1].intent, keyB);

        assertEq(exec.settle(settlement, reqs, true, "", ANY_FEE), 1);
        assertEq(exec.lastLines(), 1, "only the surviving leg is on the list");
        assertEq(tokenB.balanceOf(makerA), 99.9e18);
    }

    function test_WithoutSkipInvalidTheWholeBatchReverts() public {
        exec.setStash(stash);

        ProveSettlement.FillRequest[] memory reqs = _ring();
        reqs[1].intent.endTime = uint64(block.timestamp);
        reqs[1].signature = _sign(reqs[1].intent, keyB);

        vm.expectRevert(ProveSettlement.Expired.selector);
        exec.settle(settlement, reqs, false, "", ANY_FEE);
    }

    /// @notice An empty request list calls back with an empty line list and settles nothing.
    function test_AnEmptyBatchCallsBackWithNothingOwed() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](0);
        assertEq(exec.settle(settlement, reqs, false, "", ANY_FEE), 0);
        assertEq(exec.lastLines(), 0, "the callback still ran, with nothing on the list");
    }

    /// @notice A batch where every leg is skipped still calls back, with nothing owed.
    function test_ABatchWhereEveryLegIsSkippedOwesNothing() public {
        ProveSettlement.FillRequest[] memory reqs = _ring();
        reqs[0].intent.endTime = uint64(block.timestamp);
        reqs[0].signature = _sign(reqs[0].intent, keyA);
        reqs[1].intent.endTime = uint64(block.timestamp);
        reqs[1].signature = _sign(reqs[1].intent, keyB);

        assertEq(exec.settle(settlement, reqs, true, "", ANY_FEE), 0);
        assertEq(exec.lastLines(), 0, "nothing survived, so nothing is owed");
        assertEq(tokenB.balanceOf(makerA), 0, "and nobody was paid");
    }

    function test_TheCallbackCannotReenterAFill() public {
        ProveSettlement.Intent memory i =
            _intent(makerA, makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        bytes memory sig = _sign(i, keyA);

        ReentrantBatchExecutor bad = new ReentrantBatchExecutor(settlement);
        tokenB.mint(address(bad), 1_000e18);
        bad.approveMax(address(tokenB), relayer);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = ProveSettlement.FillRequest({intent: i, signature: sig, take: 500e18, arming: ""});

        vm.expectRevert(ProveSettlement.Reentrant.selector);
        bad.settle(reqs, abi.encode(i, sig, uint256(100e18)));
    }

    function test_EscrowCustodyReleasesFromTheReservation() public {
        exec.setStash(stash);

        ProveSettlement.Intent memory i =
            _intent(makerA, makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes32 h = settlement.hashIntent(i);

        vm.prank(makerA);
        settlement.deposit(i, 1_000e18);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _req(i, keyA, 1_000e18);

        exec.settle(settlement, reqs, false, "", ANY_FEE);

        assertEq(settlement.reserved(h), 0, "the reservation paid for the fill");
        assertEq(tokenB.balanceOf(makerA), 99.9e18);
    }

    /// @notice The caller's fee bound covers this path too. A ring whose legs ask for more than
    ///         the caller agreed to pay does not settle.
    function test_TheFeeBoundIsHonouredHere() public {
        exec.setStash(stash);
        p2Rate = 0.001e18;
        ProveSettlement.FillRequest[] memory reqs = _ring();

        // Read the rate first. `vm.expectRevert` arms the *next* call, and a view call counts.
        uint256 justUnder = uint256(reqs[0].intent.feeRate) - 1;

        vm.expectRevert(ProveSettlement.FeeTooHigh.selector);
        exec.settle(settlement, reqs, false, "", justUnder);
    }

    /// @notice Fees for legs sharing an output token coalesce into one transfer, as `fillBatch`
    ///         does. Two legs paying out token B pay the sink once.
    function test_FeesForOneTokenCoalesceIntoASingleTransfer() public {
        exec.setStash(stash);

        ProveSettlement.Intent memory one =
            _intent(makerA, makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        ProveSettlement.Intent memory two =
            _intent(makerA, makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 2);
        uint256 fee = settlement.quote(one, 1_000e18, block.timestamp).feeProceeds;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _req(one, keyA, 1_000e18);
        reqs[1] = _req(two, keyA, 1_000e18);

        vm.recordLogs();
        exec.settle(settlement, reqs, false, "", ANY_FEE);

        uint256 toSink;
        uint256 toSettlement;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 k = 0; k < logs.length; k++) {
            // Transfer(address,address,uint256). The fee run targets the settlement now, so both
            // counts matter: one says the run coalesced, the other says the destination was
            // never called.
            if (
                logs[k].topics.length != 3
                    || logs[k].topics[0] != keccak256("Transfer(address,address,uint256)")
            ) continue;
            address to = address(uint160(uint256(logs[k].topics[2])));
            if (to == sink) toSink++;
            if (to == address(settlement)) toSettlement++;
        }

        // The run's transfer targets the settlement now, so the sink is never called at all —
        // which is the stronger form of "one transfer, not two".
        assertEq(toSink, 0, "no transfer reaches the destination during a fill");
        assertEq(toSettlement, 1, "one transfer for the run, not two");
        assertEq(
            settlement.pendingFees(feeCfg(sink), address(tokenB)),
            fee * 2,
            "and it carried both fees"
        );
    }

    /**
     * @notice The same tripwire the single-fill path has, on this call site.
     *
     * The contract calls an address it did not choose. It is safe only because the calldata
     * always opens with the `proveBatchCallback` selector and the caller's `data` rides inside
     * that frame as an argument. Point the payload at a drain and the contract still says
     * `proveBatchCallback`.
     */
    function test_TheFixedSelectorProtectsTheBatchCallbackPath() public {
        BatchRecorder rec = new BatchRecorder();
        tokenB.mint(address(rec), 1_000_000e18);
        rec.approveMax(address(tokenB), relayer);

        ProveSettlement.Intent memory i =
            _intent(makerA, makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _req(i, keyA, 1_000e18);

        bytes memory drain =
            abi.encodeCall(IERC20.transferFrom, (makerA, address(this), tokenA.balanceOf(makerA)));

        vm.expectCall(
            address(rec), abi.encodePacked(IProveBatchCallback.proveBatchCallback.selector)
        );
        rec.settle(settlement, reqs, drain, ANY_FEE);

        assertEq(
            rec.lastSelector(),
            IProveBatchCallback.proveBatchCallback.selector,
            "the contract said the selector it chose, not the one it was handed"
        );
        assertEq(rec.lastData(), drain, "the payload arrived as an argument, never as a call");
        assertEq(tokenA.balanceOf(address(this)), 0, "and nothing was drained");
    }
}
