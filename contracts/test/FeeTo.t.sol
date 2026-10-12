// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {IProveBatchCallback} from "../src/interfaces/IProveBatchCallback.sol";
import {ANY_FEE, BatchExecutor, MockERC20, NO_PERMIT2, PayingExecutor} from "./Mocks.sol";
import {WeirdToken} from "./tokens/WeirdToken.sol";
import {
    proceedsRate,
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION,
    ratesOf
} from "./Fees.sol";

/**
 * @notice `Intent.feeTo` — the sink a maker signs, and the only fee destination there is.
 *
 * **The claim these tests pin: the intent names the destination, and nothing else can redirect
 * it.** When `feeRate > 0`, `feeTo` must be a sink in the settlement's registry, and a sink names
 * one destination for all time. The settlement holds no fee address of its own, only
 * `defaultProceeds` for sweeps. A fee reaches `i.feeTo`'s book or it is not charged, on every
 * custody rung and through every entry point.
 *
 * That was not always so. A `feeSink` in storage used to take a share of every fee, an owner-set
 * floor used to raise a rate the maker never signed, and a replaceable policy used to divide the
 * result. prove.cash earns nothing from a fill, so all three are gone — and a test has to say so,
 * because the shape they left behind is easy to rebuild by accident.
 *
 * Naming a destination costs the maker the whole fee: it is carved out of the number they signed,
 * and the executor pays that number whatever the rate is.
 */
contract FeeToTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;

    MockERC20 tokenA;
    MockERC20 tokenB;

    /**
     * @dev Where an unattributed token goes. Every assertion below that this address received
     *      nothing is the point of the file: it is the one address the owner picked, so a fee
     *      arriving here is a fee the contract chose the destination for.
     */
    address proceeds = address(0xD0D);
    /// @dev Two named destinations. `burner` stands in for the PulseX buy-and-burn the registry
    ///      offers by default; `rival` is any other address a maker might name instead.
    address burner = address(0xB4B4);
    address rival = address(0x21FA);

    address executor = address(0xE0E);

    address makerA;
    uint256 keyA;
    address makerB;
    uint256 keyB;
    address makerC;
    uint256 keyC;

    /// @dev Ten basis points. The intent's own, because an intent's own is all there is.
    uint64 constant FEE_RATE = 0.001e18;

    /// @dev The ERC-20 event, so a test can count transfers rather than only weigh balances.
    event Transfer(address indexed from, address indexed to, uint256 value);

    function setUp() public {
        (makerA, keyA) = makeAddrAndKey("makerA");
        (makerB, keyB) = makeAddrAndKey("makerB");
        (makerC, keyC) = makeAddrAndKey("makerC");

        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);

        tokenA.mint(makerA, 1_000_000e18);
        tokenA.mint(makerB, 1_000_000e18);
        tokenA.mint(makerC, 1_000_000e18);
        // The executor buys token A and pays out token B, so it stocks token B and the fees.
        tokenB.mint(executor, 1_000_000e18);

        vm.prank(makerA);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(makerB);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(makerC);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        // A charging intent must name a registered sink. Each of these is a sink whose
        // destination is its own address, so a claim pays the address the intent named.

        vm.warp(1_700_000_000);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// @dev Both makers sell token A for token B, so a batch's legs differ only where a test
    ///      makes them differ. That keeps `feeTo` the one variable in the coalescing tests.
    function _intent(address maker, address feeTo, uint256 nonce)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: 1_000e18,
            minOutStart: 100e18,
            minOutEnd: 100e18,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(feeTo),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: FEE_RATE,
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

    function _req(ProveSettlement.Intent memory i, uint256 key)
        internal
        view
        returns (ProveSettlement.FillRequest memory)
    {
        return ProveSettlement.FillRequest({
            intent: i, signature: _sign(i, key), take: i.amountIn, arming: ""
        });
    }

    /// @dev The same request, signed against a settlement a test built for itself. The digest is
    ///      domain-separated by `verifyingContract`, so a signature from `_req` is worthless here.
    function _reqOn(ProveSettlement s, ProveSettlement.Intent memory i, uint256 key)
        internal
        view
        returns (ProveSettlement.FillRequest memory)
    {
        (uint8 v, bytes32 r, bytes32 vs) = vm.sign(key, s.hashIntent(i));
        return ProveSettlement.FillRequest({
            intent: i, signature: abi.encodePacked(r, vs, v), take: i.amountIn, arming: ""
        });
    }

    /// @dev Move an intent onto the escrow rung and fund it, so one test body can drive both
    ///      custody rungs. The deposit is the maker's own, through the relayer they approved.
    function _escrow(ProveSettlement.Intent memory i) internal {
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        vm.prank(i.maker);
        settlement.deposit(i, i.amountIn);
    }

    /**
     * @dev How many token B transfers landed on `to` in the logs just recorded.
     *
     * The fee run's target is `address(this)` on the settlement now, not the destination the
     * intent named, so the coalescing tests below count transfers **to the settlement**. That is
     * a stronger reading of the same claim than the old one: it says one transfer per run and it
     * says the destination was never called.
     */
    function _transfersTo(Vm.Log[] memory logs, address to) internal view returns (uint256 n) {
        for (uint256 k = 0; k < logs.length; k++) {
            if (
                logs[k].emitter == address(tokenB) && logs[k].topics.length == 3
                    && logs[k].topics[0] == Transfer.selector
                    && address(uint160(uint256(logs[k].topics[2]))) == to
            ) {
                n++;
            }
        }
    }

    // ── The intent names the destination ─────────────────────────────────────

    /**
     * @notice Every entry point that moves money, on both custody rungs, pays the fee to the
     *         address the intent named and pays `defaultProceeds` nothing.
     *
     * Eight fills in one body, and one body on purpose: the claim is that they agree, and eight
     * tests asserting the same sentence separately would let one of them drift. Each combination
     * gets its own maker, nonce and destination, so a fee that landed in the wrong place shows up
     * as a balance rather than as a sum that happens to add up.
     *
     * The two gasless rungs are absent and are not a gap. Both are a batch leg that arms itself
     * and then settles through the same `_settleLeg` every other leg does; they differ in how the
     * maker's tokens are freed and not at all in where the fee goes. `test/Arming.t.sol`,
     * `test/Custody.t.sol` and `test/Permit.t.sol` cover the freeing.
     */
    function test_EveryPathPaysTheDestinationTheIntentNamed() public {
        PayingExecutor solo = new PayingExecutor();
        BatchExecutor ring = new BatchExecutor();
        tokenB.mint(address(solo), 1_000_000e18);
        tokenB.mint(address(ring), 1_000_000e18);
        solo.approveMax(address(tokenB), relayer);
        ring.approveMax(address(tokenB), relayer);

        uint256 expected;

        for (uint256 rung = 0; rung < 2; rung++) {
            for (uint256 path = 0; path < 4; path++) {
                uint256 nonce = rung * 10 + path + 1;
                ProveSettlement.Intent memory i = _intent(makerA, burner, nonce);
                if (rung == 1) _escrow(i);

                uint256 fee = settlement.quote(i, i.amountIn, block.timestamp).feeProceeds;
                assertGt(fee, 0, "each of these fills owes something");
                expected += fee;

                bytes memory sig = _sign(i, keyA);
                if (path == 0) {
                    vm.prank(executor);
                    settlement.fill(i, sig, i.amountIn, ANY_FEE);
                } else if (path == 1) {
                    ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
                    reqs[0] = ProveSettlement.FillRequest(i, sig, i.amountIn, "");
                    vm.prank(executor);
                    settlement.fillBatch(reqs, false, ANY_FEE);
                } else if (path == 2) {
                    solo.settle(settlement, i, sig, i.amountIn, "", ANY_FEE);
                } else {
                    ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
                    reqs[0] = ProveSettlement.FillRequest(i, sig, i.amountIn, "");
                    ring.settle(settlement, reqs, false, "", ANY_FEE);
                }

                assertEq(
                    settlement.pendingFees(feeCfg(burner), address(tokenB)),
                    expected,
                    "the fee went where the intent said"
                );
                assertEq(tokenB.balanceOf(burner), 0, "booked, and never transferred to it");
                assertEq(
                    settlement.pendingFees(feeCfg(proceeds), address(tokenB)),
                    0,
                    "and never to the address the owner set"
                );
                assertEq(tokenB.balanceOf(proceeds), 0, "in the book or in the balance");
            }
        }
    }

    /**
     * @notice A zero rate charges nothing, whatever destination is named.
     *
     * Settlement earns nothing from a fill. The free encoding is `feeRate = 0` (prefer `feeTo =
     * 0` too). A positive rate with `feeTo = 0` is BadTerms under the FeeSink allowlist — zero is
     * never allowlisted. `_rateOf` still folds a zero destination to a zero rate for quote views.
     */
    function test_NamingNoDestinationChargesNothing() public {
        ProveSettlement.Intent memory i = _intent(makerA, address(0), 1);
        i.feeRateProceeds = 0;

        assertEq(proceedsRate(settlement, i), 0, "no destination, no rate");
        TakePoints.Quote memory q_fee = settlement.quote(i, i.amountIn, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertEq(fee, 0, "and no fee");

        bytes memory sig = _sign(i, keyA);
        uint256 before = tokenB.balanceOf(executor);
        vm.recordLogs();
        vm.prank(executor);
        settlement.fill(i, sig, i.amountIn, ANY_FEE);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(before - tokenB.balanceOf(executor), delivered, "the executor paid the delivery");
        assertEq(tokenB.balanceOf(makerA), delivered, "and the maker received all of it");
        assertEq(tokenB.balanceOf(proceeds), 0, "nothing fell through to the owner's address");
        assertEq(_transfersTo(logs, proceeds), 0, "no transfer was even attempted");
    }

    function test_PositiveRateWithZeroFeeToIsBadTerms() public view {
        ProveSettlement.Intent memory i = _intent(makerA, address(0), 1);
        i.feeRateProceeds = 0.2e18;
        assertEq(proceedsRate(settlement, i), 0, "quote still folds");
        bytes memory sig = _sign(i, keyA);
        assertEq(
            uint256(settlement.fillability(i, sig, i.amountIn, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.BadTerms_),
            "but fill refuses: feeRate>0 needs an allowlisted sink"
        );
    }

    /**
     * @notice A caller that will not pay this rate steps over the leg rather than reverting.
     *
     * `maxFeeRate` is the only bound on a fee that exists anywhere — the settlement caps no rate
     * and neither does `_termsOk`. It has to be checked while skipping is still possible, so one
     * greedy signature cannot take a whole batch down.
     */
    function test_TheCallersOwnBoundIsTheOnlyCeiling() public {
        ProveSettlement.Intent memory greedy = _intent(makerA, burner, 1);
        greedy.feeRate = 0.5e18;
        ProveSettlement.Intent memory ordinary = _intent(makerB, burner, 2);

        (, uint256 greedyP2,) = ratesOf(greedy);
        assertEq(greedyP2, 0.5e18, "the contract caps nothing");

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _req(greedy, keyA);
        reqs[1] = _req(ordinary, keyB);

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, FEE_RATE), 1, "the batch took the other one");

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.FeeTooHigh.selector);
        settlement.fill(greedy, reqs[0].signature, greedy.amountIn, FEE_RATE);
    }

    /**
     * @notice A leg that owes nothing does not break the run the paying legs share.
     *
     * `_accrue` returns before it touches the run when a leg owes nothing. A free leg that closed
     * the open run instead would cost the batch an extra transfer, and every balance would still
     * come out right — so the count of transfers is the only assertion that can see it.
     */
    function test_ALegThatOwesNothingDoesNotBreakTheRun() public {
        ProveSettlement.Intent memory paying = _intent(makerA, burner, 1);
        ProveSettlement.Intent memory owesNothing = _intent(makerB, address(0), 2);
        owesNothing.feeRateProceeds = 0;

        uint256 fee = settlement.quote(paying, paying.amountIn, block.timestamp).feeProceeds;
        assertGt(fee, 0, "the paying leg does pay");

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _req(paying, keyA);
        reqs[1] = _req(owesNothing, keyB);

        vm.recordLogs();
        vm.prank(executor);
        settlement.fillBatch(reqs, false, ANY_FEE);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_transfersTo(logs, address(settlement)), 1, "one run, one transfer");
        assertEq(_transfersTo(logs, burner), 0, "and no fill ever calls the destination");
        assertEq(
            settlement.pendingFees(feeCfg(burner), address(tokenB)),
            fee,
            "the free leg added nothing to the line"
        );
        assertEq(settlement.pendingFees(feeCfg(proceeds), address(tokenB)), 0);
    }

    /**
     * @notice The maker pays the whole fee for naming a destination, and the executor pays the
     *         same number either way.
     *
     * Two identical intents, one naming a destination and one not. The executor's outlay is the
     * signed gross in both, so the rate is invisible to them; the maker's receipt falls by
     * exactly the fee. That is the change stated in one body: the fee moved from the executor's
     * pocket into the maker's number, and it moved nowhere else.
     *
     * This file used to hold `test_TheMakerPaysNothingForNamingADestination`, which asserted the
     * opposite. It is not a stale assertion — it was true, and the split made it false.
     */
    function test_TheMakerPaysTheWholeFeeForNamingADestination() public {
        ProveSettlement.Intent memory named = _intent(makerA, burner, 1);
        ProveSettlement.Intent memory plain = _intent(makerB, address(0), 2);
        plain.feeRateProceeds = 0;

        TakePoints.Quote memory q_feeNamed =
            settlement.quote(named, named.amountIn, block.timestamp);
        uint256 deliveredNamed = q_feeNamed.delivered;
        uint256 feeNamed = q_feeNamed.feeProceeds;
        TakePoints.Quote memory q_feePlain =
            settlement.quote(plain, plain.amountIn, block.timestamp);
        uint256 deliveredPlain = q_feePlain.delivered;
        uint256 feePlain = q_feePlain.feeProceeds;

        assertGt(feeNamed, 0);
        assertEq(feePlain, 0, "the unnamed one charges nothing");
        assertEq(deliveredNamed, deliveredPlain - feeNamed, "and the maker's side falls by the fee");
        assertEq(deliveredNamed + feeNamed, deliveredPlain, "the two halves are one gross");

        uint256 makerBefore = tokenB.balanceOf(makerA);
        uint256 before = tokenB.balanceOf(executor);
        vm.startPrank(executor);
        settlement.fill(named, _sign(named, keyA), named.amountIn, ANY_FEE);
        uint256 costOfNamed = before - tokenB.balanceOf(executor);
        uint256 makerGot = tokenB.balanceOf(makerA) - makerBefore;
        before = tokenB.balanceOf(executor);
        settlement.fill(plain, _sign(plain, keyB), plain.amountIn, ANY_FEE);
        uint256 costOfPlain = before - tokenB.balanceOf(executor);
        vm.stopPrank();

        assertEq(costOfNamed, costOfPlain, "the rate costs the executor nothing");
        assertEq(makerGot, deliveredPlain - feeNamed, "and costs the maker the whole of it");
        assertEq(settlement.pendingFees(feeCfg(burner), address(tokenB)), feeNamed);
    }

    // ── A batch whose legs disagree ──────────────────────────────────────────

    /**
     * @notice Two legs, one token, two destinations — each is paid its own fee.
     *
     * This is the case the fee-coalescing run exists to get right. It groups consecutive legs
     * that share an output token *and* a destination, so a batch that mixes destinations has to
     * break the run and pay twice.
     */
    function test_ABatchPaysEachNamedDestinationItsOwn() public {
        ProveSettlement.Intent memory toBurner = _intent(makerA, burner, 1);
        ProveSettlement.Intent memory toRival = _intent(makerB, rival, 2);

        uint256 feeBurner =
            settlement.quote(toBurner, toBurner.amountIn, block.timestamp).feeProceeds;
        uint256 feeRival = settlement.quote(toRival, toRival.amountIn, block.timestamp).feeProceeds;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _req(toBurner, keyA);
        reqs[1] = _req(toRival, keyB);

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 2, "both legs filled");

        assertEq(
            settlement.pendingFees(feeCfg(burner), address(tokenB)),
            feeBurner,
            "the first destination got its own"
        );
        assertEq(
            settlement.pendingFees(feeCfg(rival), address(tokenB)),
            feeRival,
            "the second got its own"
        );
        assertEq(
            settlement.totalPendingFees(address(tokenB)),
            feeBurner + feeRival,
            "and the total is the two rows and nothing else"
        );
        assertEq(
            settlement.pendingFees(feeCfg(proceeds), address(tokenB)), 0, "no run reached the owner"
        );
    }

    /**
     * @notice Legs charging different rates each pay their own maker correctly, and a shared
     *         destination still costs one fee run.
     *
     * Three legs to the same place at three rates. The run coalesces on the token and the
     * destination, and the rate is no part of that key, so the whole batch is one transfer to the
     * settlement and one row in the book. Each maker's own net is worked out independently and
     * none of them can be moved by another leg's rate.
     */
    function test_ABatchWhoseLegsChargeDifferentRatesPaysEachMakerRight() public {
        uint64[3] memory rates = [uint64(0), 0.001e18, 0.05e18];
        address[3] memory sellers = [makerA, makerB, makerC];
        uint256[3] memory keys = [keyA, keyB, keyC];

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](3);
        uint256[3] memory expectedNet;
        uint256 expectedFees;
        uint256 expectedOutlay;

        for (uint256 k = 0; k < 3; k++) {
            ProveSettlement.Intent memory i = _intent(sellers[k], burner, k + 1);
            i.feeRateProceeds = rates[k];
            TakePoints.Quote memory q_fee = settlement.quote(i, i.amountIn, block.timestamp);
            uint256 delivered = q_fee.delivered;
            uint256 fee = q_fee.feeProceeds;
            expectedNet[k] = delivered;
            expectedFees += fee;
            expectedOutlay += delivered + fee;
            reqs[k] = _req(i, keys[k]);
        }

        uint256 executorBefore = tokenB.balanceOf(executor);
        vm.recordLogs();
        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 3, "all three legs filled");
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 k = 0; k < 3; k++) {
            assertEq(tokenB.balanceOf(sellers[k]), expectedNet[k], "a maker's own net");
        }
        assertEq(
            settlement.pendingFees(feeCfg(burner), address(tokenB)),
            expectedFees,
            "one row, three legs"
        );
        assertEq(_transfersTo(logs, address(settlement)), 1, "and one coalesced run for all three");
        assertEq(_transfersTo(logs, burner), 0, "no fill ever calls the destination");
        // Three legs of the same size and the same curve, so the outlay is three identical
        // grosses whatever the three rates say.
        assertEq(
            executorBefore - tokenB.balanceOf(executor), expectedOutlay, "the executor's outlay"
        );
        assertEq(expectedOutlay, 3 * 100e18, "which is three grosses and no rate at all");
    }

    /**
     * @notice Two legs that agree still coalesce into one transfer.
     *
     * The gas claim in `fillBatch` is that fees accumulate in memory and are paid in as few
     * transfers as the leg order allows. The destination is half the run's key, so every leg
     * naming the same place must still cost one transfer and not one each.
     */
    function test_ABatchCoalescesLegsThatShareATokenAndADestination() public {
        ProveSettlement.Intent memory one = _intent(makerA, burner, 1);
        ProveSettlement.Intent memory two = _intent(makerB, burner, 2);

        uint256 feeOne = settlement.quote(one, one.amountIn, block.timestamp).feeProceeds;
        uint256 feeTwo = settlement.quote(two, two.amountIn, block.timestamp).feeProceeds;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _req(one, keyA);
        reqs[1] = _req(two, keyB);

        vm.recordLogs();
        vm.prank(executor);
        settlement.fillBatch(reqs, false, ANY_FEE);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(
            settlement.pendingFees(feeCfg(burner), address(tokenB)),
            feeOne + feeTwo,
            "both fees arrived"
        );
        assertEq(_transfersTo(logs, address(settlement)), 1, "in one transfer, not two");
    }

    /// @notice And a batch that mixes destinations still pays ONE transfer per token. The fee
    ///         ledger is summed per token and flushed once, so naming a destination costs
    ///         nothing in transfers: two legs, two destinations, one pull.
    function test_AMixedBatchPaysOnePullPerToken() public {
        ProveSettlement.Intent memory toBurner = _intent(makerA, burner, 1);
        ProveSettlement.Intent memory toRival = _intent(makerB, rival, 2);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _req(toBurner, keyA);
        reqs[1] = _req(toRival, keyB);

        vm.recordLogs();
        vm.prank(executor);
        settlement.fillBatch(reqs, false, ANY_FEE);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(_transfersTo(logs, address(settlement)), 1, "two destinations, one pull");
        assertEq(_transfersTo(logs, burner), 0, "and neither destination was called");
        assertEq(_transfersTo(logs, rival), 0);
        assertEq(_transfersTo(logs, proceeds), 0, "and nothing at all to the owner's address");
    }

    // ── The callback path ────────────────────────────────────────────────────

    /**
     * @notice The callback tells the solver where each fee is going.
     *
     * A solver settling a ring on credit is handed one `Payment` per leg before it pays anything.
     * That line carries the sink, so a solver can see a fee it is about to fund and where it
     * lands. An intent that signed a zero `feeTo` pays no fee, and its line names no sink.
     */
    function test_TheCallbackTellsTheSolverWhereEachFeeGoes() public {
        RecordingRing exec = new RecordingRing();
        tokenB.mint(address(exec), 1_000_000e18);
        exec.approveMax(address(tokenB), relayer);

        ProveSettlement.Intent memory toBurner = _intent(makerA, burner, 1);
        ProveSettlement.Intent memory plain = _intent(makerB, address(0), 2);
        plain.feeRateProceeds = 0;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _req(toBurner, keyA);
        reqs[1] = _req(plain, keyB);

        uint256 feeNamed =
            settlement.quote(toBurner, toBurner.amountIn, block.timestamp).feeProceeds;

        exec.settle(settlement, reqs, false, "", ANY_FEE);

        (uint256 fee0, bytes32 to0) = exec.line(0);
        (uint256 fee1, bytes32 to1) = exec.line(1);
        assertEq(to0, feeCfg(burner), "the named leg's line carries the address the intent named");
        assertEq(fee0, feeNamed);
        assertEq(to1, bytes32(0), "and the unnamed leg's line names no sink");
        assertEq(fee1, 0, "and no fee");

        assertEq(
            settlement.pendingFees(feeCfg(burner), address(tokenB)),
            feeNamed,
            "the fee was booked where the line said"
        );
        assertEq(settlement.pendingFees(feeCfg(proceeds), address(tokenB)), 0, "and nowhere else");
    }

    // ── The signature covers it ──────────────────────────────────────────────

    /**
     * @notice An executor cannot redirect the fee. `feeTo` is inside the signed struct, so
     *         changing it invalidates the signature the maker gave.
     *
     * This is the reason the field is worth having at all. A destination the executor could
     * rewrite would be a suggestion rather than an instruction.
     */
    function test_AnExecutorCannotRedirectTheFee() public {
        ProveSettlement.Intent memory signed = _intent(makerA, burner, 1);
        bytes memory sig = _sign(signed, keyA);

        ProveSettlement.Intent memory tampered = signed;
        tampered.feeConfig = feeCfg(rival);

        vm.prank(executor);
        vm.expectRevert();
        settlement.fill(tampered, sig, tampered.amountIn, ANY_FEE);

        assertEq(tokenB.balanceOf(rival), 0, "the redirect paid nobody");
        assertEq(
            settlement.pendingFees(feeCfg(rival), address(tokenB)), 0, "and booked nothing either"
        );
    }

    /// @notice Moving `defaultProceeds` moves no fee. It is not a fee address and no fill reads it.
    function test_TheOwnersOneSwitchTouchesNoFill() public {
        ProveSettlement.Intent memory i = _intent(makerA, burner, 1);
        bytes memory sig = _sign(i, keyA);
        uint256 fee = settlement.quote(i, i.amountIn, block.timestamp).feeProceeds;

        vm.prank(executor);
        settlement.fill(i, sig, i.amountIn, ANY_FEE);

        assertEq(
            settlement.pendingFees(feeCfg(burner), address(tokenB)),
            fee,
            "the fee still went where the intent said"
        );
        assertEq(
            settlement.pendingFees(feeCfg(rival), address(tokenB)),
            0,
            "and the owner's new address is owed nothing"
        );
    }

    // ── The fee is booked, and `claim` is the only way out ───────────────────

    /**
     * @notice A destination the token refuses no longer kills the fill.
     *
     * **This is the hazard the whole change exists for.** `feeTo` is an address the maker signed
     * and nobody vetted. When the fee was transferred inside the fill, a destination on a
     * stablecoin's deny list reverted the transfer, took the whole fill down with it, and left
     * the maker with nothing and no explanation. The maker had signed something dead and could
     * not tell.
     *
     * Now the fill settles, the maker is paid in full, and the fee waits in a book. The loss —
     * if the destination never becomes payable — falls on whoever named it.
     */
    function test_ADestinationTheTokenRefusesDoesNotKillTheFill() public {
        WeirdToken denying = new WeirdToken("Denying", "DNY", 18);
        denying.mint(executor, 1_000_000e18);
        vm.prank(executor);
        denying.approve(relayer, type(uint256).max);
        // The destination may neither send nor receive, exactly as a deny-listed address cannot.
        denying.setBlocked(burner, true);

        ProveSettlement.Intent memory i = _intent(makerA, burner, 1);
        i.tokenOut = address(denying);
        bytes memory sig = _sign(i, keyA);
        TakePoints.Quote memory q_fee = settlement.quote(i, i.amountIn, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertGt(fee, 0, "there is a fee for the token to refuse");

        vm.prank(executor);
        settlement.fill(i, sig, i.amountIn, ANY_FEE);

        assertEq(denying.balanceOf(makerA), delivered, "the maker was paid in full");
        assertEq(settlement.filled(settlement.hashIntent(i)), i.amountIn, "and the fill counted");
        assertEq(
            settlement.pendingFees(feeCfg(burner), address(denying)),
            fee,
            "the fee waits in the book"
        );
        assertEq(denying.balanceOf(address(settlement)), fee, "and the tokens are really here");
    }

    /**
     * @notice And that destination's `claim` reverts, for ever, with its book intact.
     *
     * **Stated so nobody later reads it as a bug.** A destination that cannot receive its token
     * has money that is booked and unreachable. That is the accepted outcome and it is strictly
     * better than what it replaces: the fill settled, the maker was paid, and the only party out
     * of pocket is whoever named an address that cannot be paid. With a whitelist of buy-and-burn
     * destinations it is close to theoretical.
     */
    function test_ADestinationThatCannotReceiveHasAClaimThatReverts() public {
        WeirdToken denying = new WeirdToken("Denying", "DNY", 18);
        denying.mint(executor, 1_000_000e18);
        vm.prank(executor);
        denying.approve(relayer, type(uint256).max);
        denying.setBlocked(burner, true);

        ProveSettlement.Intent memory i = _intent(makerA, burner, 1);
        i.tokenOut = address(denying);
        bytes memory sig = _sign(i, keyA);
        uint256 fee = settlement.quote(i, i.amountIn, block.timestamp).feeProceeds;

        vm.prank(executor);
        settlement.fill(i, sig, i.amountIn, ANY_FEE);

        vm.expectRevert(abi.encodeWithSelector(WeirdToken.Blocked.selector, burner));
        claimFor(settlement, burner, address(denying));

        // The revert took the writes with it, so the book is exactly where the fill left it.
        assertEq(
            settlement.pendingFees(feeCfg(burner), address(denying)), fee, "the book is intact"
        );
        assertEq(settlement.totalPendingFees(address(denying)), fee, "and so is the total");

        // Nobody else can reach it either. The sweep sees a balance that is wholly owed.
        assertEq(settlement.sweepUnowned(address(denying)), 0, "the owner cannot take it");
        assertEq(denying.balanceOf(proceeds), 0);

        // And it becomes payable the moment the token stops refusing, without a redeploy.
        denying.setBlocked(burner, false);
        assertEq(claimFor(settlement, burner, address(denying)), fee, "then it comes out");
        assertEq(denying.balanceOf(burner), fee, "in full");
    }

    /**
     * @notice No fill ever transfers to a fee destination, through any entry point.
     *
     * The class-removal claim, asserted rather than described. The destination of the fee pull is
     * `address(this)` on every path, so the address the maker chose is never the target of a
     * transfer during a fill — and a token that would refuse it, or a contract that would run
     * code on being paid, is never reached at all.
     */
    function test_NoFillEverTransfersToAFeeDestination() public {
        PayingExecutor solo = new PayingExecutor();
        tokenB.mint(address(solo), 1_000_000e18);
        solo.approveMax(address(tokenB), relayer);

        uint256 expected;
        for (uint256 path = 0; path < 3; path++) {
            ProveSettlement.Intent memory i = _intent(makerA, burner, path + 1);
            bytes memory sig = _sign(i, keyA);
            uint256 fee = settlement.quote(i, i.amountIn, block.timestamp).feeProceeds;
            expected += fee;

            vm.recordLogs();
            if (path == 0) {
                vm.prank(executor);
                settlement.fill(i, sig, i.amountIn, ANY_FEE);
            } else if (path == 1) {
                ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
                reqs[0] = ProveSettlement.FillRequest(i, sig, i.amountIn, "");
                vm.prank(executor);
                settlement.fillBatch(reqs, false, ANY_FEE);
            } else {
                solo.settle(settlement, i, sig, i.amountIn, "", ANY_FEE);
            }
            Vm.Log[] memory logs = vm.getRecordedLogs();

            assertEq(_transfersTo(logs, burner), 0, "a fill reached the destination");
            assertEq(_transfersTo(logs, address(settlement)), 1, "the fee went here instead");
        }

        assertEq(
            settlement.pendingFees(feeCfg(burner), address(tokenB)), expected, "all three booked"
        );
        assertEq(tokenB.balanceOf(burner), 0, "and none of it moved");
    }

    /**
     * @notice Anybody may claim, and the money goes to the destination whatever the caller wants.
     *
     * `msg.sender` decides nothing: the destination is the map key, so the caller chooses the
     * timing and the gas and nothing else. That is the whole design — the destinations this
     * feature exists for are buy-and-burn contracts that will never send a transaction of their
     * own, and a claim only they could call is a claim nobody calls.
     */
    function test_AnybodyMayClaimAndItAlwaysPaysTheRecordedDestination() public {
        ProveSettlement.Intent memory i = _intent(makerA, burner, 1);
        bytes memory sig = _sign(i, keyA);
        uint256 fee = settlement.quote(i, i.amountIn, block.timestamp).feeProceeds;

        vm.prank(executor);
        settlement.fill(i, sig, i.amountIn, ANY_FEE);

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        assertEq(claimFor(settlement, burner, address(tokenB)), fee, "a stranger spent the gas");

        assertEq(tokenB.balanceOf(burner), fee, "and the destination was paid");
        assertEq(tokenB.balanceOf(stranger), 0, "while the caller kept nothing");
        assertEq(settlement.pendingFees(feeCfg(burner), address(tokenB)), 0, "the book is empty");
        assertEq(settlement.totalPendingFees(address(tokenB)), 0, "and so is the total");
        assertEq(tokenB.balanceOf(address(settlement)), 0, "and nothing rests here");
    }

    /// @notice Claiming an empty book returns zero and moves nothing. No transfer, no event, no
    ///         revert — a keeper walking a list of destinations must not lose the list to one
    ///         that has already been emptied.
    function test_ClaimingAnEmptyBookMovesNothing() public {
        assertEq(claimFor(settlement, burner, address(tokenB)), 0, "an untouched destination");
        assertEq(tokenB.balanceOf(burner), 0);

        ProveSettlement.Intent memory i = _intent(makerA, burner, 1);
        bytes memory sig = _sign(i, keyA);
        vm.prank(executor);
        settlement.fill(i, sig, i.amountIn, ANY_FEE);

        claimFor(settlement, burner, address(tokenB));
        assertEq(claimFor(settlement, burner, address(tokenB)), 0, "and a second claim after it");
        assertEq(
            claimFor(settlement, burner, address(tokenA)), 0, "or a token nothing was booked in"
        );
    }

    /**
     * @notice A destination that reenters `claim` while being paid finds both books at zero.
     *
     * `claim` writes both books before it transfers, and holds `nonReentrant` for the whole of
     * it, so the reentrant call reverts before it can read anything. Belt and braces: even
     * without the guard the zeroed book would pay the second call nothing.
     *
     * The token here calls its recipient on transfer, which a plain ERC-20 does not. That is the
     * point — the destination is a contract now receiving a transfer at a moment it did not
     * choose, and this is the shape of token that would let it act on that.
     */
    function test_ADestinationThatReentersClaimFindsAnEmptyBook() public {
        HookToken hooked = new HookToken();
        hooked.mint(executor, 1_000_000e18);
        vm.prank(executor);
        hooked.approve(relayer, type(uint256).max);

        ReenteringDestination dest = new ReenteringDestination(settlement, address(hooked));
        // The destination is a contract of its own, so the sink is a separate address.
        address sink = address(dest);
        dest.setSink(sink);

        ProveSettlement.Intent memory i = _intent(makerA, sink, 1);
        i.tokenOut = address(hooked);
        bytes memory sig = _sign(i, keyA);
        uint256 fee = settlement.quote(i, i.amountIn, block.timestamp).feeProceeds;
        assertGt(fee, 0, "there is a fee worth reentering for");

        vm.prank(executor);
        settlement.fill(i, sig, i.amountIn, ANY_FEE);

        assertEq(claimFor(settlement, sink, address(hooked)), fee, "paid once");
        assertTrue(dest.reentered(), "the destination did try to come back in");
        assertFalse(dest.secondPaid(), "and the second call paid it nothing");

        assertEq(hooked.balanceOf(address(dest)), fee, "it holds exactly one payout");
        assertEq(settlement.pendingFees(feeCfg(sink), address(hooked)), 0, "the book is empty");
        assertEq(settlement.totalPendingFees(address(hooked)), 0, "and so is the total");
    }
}

/// @notice An ERC-20 that tells its recipient it has been paid. Plain ERC-20s do not, so nothing
///         else in this suite can put a destination in a position to act inside its own payout.
contract HookToken is MockERC20 {
    constructor() MockERC20("Hooked", "HOOK", 18) {}

    function transfer(address to, uint256 value) public override returns (bool) {
        bool ok = super.transfer(to, value);
        if (to.code.length > 0) {
            // Swallowed on purpose. A recipient that reverts must not decide whether the transfer
            // stands; this token is here to give one a chance to act, not a veto.
            (bool hit,) = to.call(abi.encodeWithSignature("onPaid()"));
            hit;
        }
        return ok;
    }
}

/// @notice A fee destination that tries to claim a second time from inside its first payout.
contract ReenteringDestination {
    ProveSettlement private immutable settlement;
    address private immutable token;

    bool public reentered;
    bool public secondPaid;
    /// @dev The sink whose book pays this contract. Set once the sink exists.
    address public sink;

    constructor(ProveSettlement s, address t) {
        settlement = s;
        token = t;
    }

    function setSink(address s) external {
        sink = s;
    }

    function onPaid() external {
        reentered = true;
        try settlement.claim(singleConfig(sink), token) returns (uint256 paid) {
            secondPaid = paid > 0;
        } catch {}
    }
}

/// @notice A ring executor that keeps every `Payment` line it was handed, so a test can read the
///         destination the settlement wrote rather than infer it from a balance.
contract RecordingRing is IProveBatchCallback {
    uint256[] internal _fees;
    bytes32[] internal _tos;

    function approveMax(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    function settle(
        ProveSettlement s,
        ProveSettlement.FillRequest[] calldata reqs,
        bool skipInvalid,
        bytes calldata data,
        uint256 maxFeeRate
    ) external returns (uint256) {
        return s.fillBatchWithCallback(reqs, skipInvalid, data, maxFeeRate);
    }

    function line(uint256 k) external view returns (uint256 fee, bytes32 feeConfig) {
        return (_fees[k], _tos[k]);
    }

    function proveBatchCallback(Payment[] calldata owed, bytes calldata) external {
        delete _fees;
        delete _tos;
        for (uint256 k = 0; k < owed.length; k++) {
            _fees.push(owed[k].feeProceeds);
            _tos.push(owed[k].feeConfig);
        }
    }
}
