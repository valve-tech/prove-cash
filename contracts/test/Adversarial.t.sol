// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ProveBatchExecutor, IProveSettlementBatch} from "../src/ProveBatchExecutor.sol";
import {IProveSettlementFill} from "../src/ProveExecutor.sol";
import {ProveCallSink} from "../src/ProveCallSink.sol";
import {IProveBatchCallback} from "../src/interfaces/IProveBatchCallback.sol";
import {ANY_FEE, MockERC20, MockPermit2, NO_PERMIT2} from "./Mocks.sol";
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
 * @notice A venue that writes down every call it was given, and pays a fixed rate out of stock.
 *
 * The tests below are about WHICH swaps ran, not about what they earned, so the record is the
 * point and the price is a constant.
 */
contract Tally {
    address[] public soldToken;
    uint256[] public soldAmount;

    uint256 public rateNum = 2;
    uint256 public rateDen = 1;

    /// @dev A third token paid to whoever called, the way a keeper tip or a router rebate does.
    address public tipToken;
    uint256 public tipAmount;

    function setTip(address token, uint256 amount) external {
        tipToken = token;
        tipAmount = amount;
    }

    function calls() external view returns (uint256) {
        return soldAmount.length;
    }

    function swap(address tokenIn, uint256 amountIn, address tokenOut, address to) external {
        soldToken.push(tokenIn);
        soldAmount.push(amountIn);
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(to, (amountIn * rateNum) / rateDen);
        if (tipToken != address(0) && tipAmount > 0) {
            uint256 tip = tipAmount;
            tipAmount = 0;
            IERC20(tipToken).transfer(msg.sender, tip);
        }
    }
}

/**
 * @notice A venue that tries every door back into the executor before it does its job.
 *
 * Each attempt is caught and recorded, so one ring proves the whole re-entrancy surface at once
 * rather than costing six tests that each revert for a different reason.
 */
contract Reenterer {
    ProveBatchExecutor public immutable exec;
    ProveSettlement public immutable settlement;

    bool public callbackBlocked;
    bool public ringBlocked;
    bool public disposalBlocked;
    bool public batchBlocked;
    bool public fillBlocked;
    bool public sinkBlocked;

    constructor(ProveBatchExecutor _exec, ProveSettlement _settlement) {
        exec = _exec;
        settlement = _settlement;
    }

    function swap(address tokenIn, uint256 amountIn, address tokenOut, address to) external {
        _tryEveryDoor();
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(to, amountIn * 2);
    }

    function _tryEveryDoor() private {
        IProveBatchCallback.Payment[] memory none = new IProveBatchCallback.Payment[](0);
        try exec.proveBatchCallback(none, "") {}
        catch {
            callbackBlocked = true;
        }

        IProveSettlementBatch.FillRequest[] memory noReqs =
            new IProveSettlementBatch.FillRequest[](0);
        ProveBatchExecutor.Route memory empty = ProveBatchExecutor.Route({
            legs: 0,
            swaps: new ProveBatchExecutor.Swap[](0),
            disposal: new ProveBatchExecutor.Swap[](0),
            sweep: new address[](0)
        });
        try exec.settleRing(noReqs, false, ANY_FEE, empty) returns (uint256) {}
        catch {
            ringBlocked = true;
        }

        ProveBatchExecutor.Swap memory s;
        s.leg = exec.ANY_LEG();
        s.amountOffset = exec.NO_PATCH();
        s.minOutOffset = exec.NO_PATCH();
        s.tokenIn = address(this);
        s.tokenOut = address(this);
        // The sink address is a don't-care: the caller check refuses this before it is read.
        try exec.sellSurplus(s, 0, address(0)) {}
        catch {
            disposalBlocked = true;
        }

        try settlement.fillBatchWithCallback(
            new ProveSettlement.FillRequest[](0), false, "", ANY_FEE
        ) returns (
            uint256
        ) {}
        catch {
            batchBlocked = true;
        }

        ProveSettlement.Intent memory i;
        try settlement.fill(i, "", 1, ANY_FEE) {}
        catch {
            fillBlocked = true;
        }

        try ProveCallSink(exec.sinkTemplate())
            .run(
                address(this), 0, address(this), address(this), address(this), "", new address[](0)
            ) {}
        catch {
            sinkBlocked = true;
        }
    }
}

/**
 * @notice Adversarial review of the newest executor code, before an external audit sees it.
 *
 *   forge test --match-path 'test/Adversarial.t.sol' -vv
 *
 * Nothing here is a regression test for behaviour the contracts promise. Every test is an attempt
 * to break a stated invariant; a test that passes says the attempt failed.
 */
contract AdversarialLegTest is Test {
    ProveSettlement settlement;
    ProveBatchExecutor exec;
    Tally tally;

    MockERC20 tokenA;
    MockERC20 tokenB;

    address relayer;
    address feeDest = address(0x5152);
    address proceeds = address(0xD0D);
    address caller = address(0xCA11);
    address stranger = address(0x57A);

    address makerA;
    uint256 keyA;
    address makerB;
    uint256 keyB;

    function setUp() public {
        (makerA, keyA) = makeAddrAndKey("makerA");
        (makerB, keyB) = makeAddrAndKey("makerB");

        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        exec = new ProveBatchExecutor(address(settlement));

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tally = new Tally();

        tokenA.mint(makerA, 1_000_000e18);
        tokenB.mint(makerB, 1_000_000e18);
        tokenA.mint(address(tally), 1_000_000e18);
        tokenB.mint(address(tally), 1_000_000e18);

        vm.prank(makerA);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(makerB);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── Fixture ──────────────────────────────────────────────────────────────

    function _intent(
        address maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 nonce
    ) internal view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minOutStart: minOut,
            minOutEnd: minOut,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(feeDest),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0.001e18,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL(),
            nonce: nonce,
            curve: bytes32(0)
        });
    }

    function _mirror(ProveSettlement.Intent memory i)
        internal
        pure
        returns (IProveSettlementFill.Intent memory)
    {
        return IProveSettlementFill.Intent({
            maker: i.maker,
            recipient: i.recipient,
            tokenIn: i.tokenIn,
            tokenOut: i.tokenOut,
            amountIn: i.amountIn,
            minOutStart: i.minOutStart,
            minOutEnd: i.minOutEnd,
            startTime: i.startTime,
            endTime: i.endTime,
            executor: i.executor,
            feeConfig: i.feeConfig,
            feeRate: i.feeRate,
            feeRateIn: i.feeRateIn,
            feeRateProceeds: i.feeRateProceeds,
            minFill: i.minFill,
            authNonce: i.authNonce,
            flags: i.flags,
            nonce: i.nonce,
            curve: i.curve
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
        returns (IProveSettlementBatch.FillRequest memory)
    {
        return IProveSettlementBatch.FillRequest({
            intent: _mirror(i), signature: _sign(i, key), take: take, arming: ""
        });
    }

    /// @dev Maker A sells 1,000 A for 100 B; maker B sells 110 B for 900 A. The ring pays its
    ///      own fee out of what the two makers concede.
    function _ring(uint256 base)
        internal
        view
        returns (IProveSettlementBatch.FillRequest[] memory reqs)
    {
        reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, base),
            keyA,
            1_000e18
        );
        reqs[1] = _req(
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, base + 1),
            keyB,
            110e18
        );
    }

    function _sweepAB() internal view returns (address[] memory list) {
        list = new address[](2);
        list[0] = address(tokenA);
        list[1] = address(tokenB);
    }

    function _route(uint256 legs, ProveBatchExecutor.Swap[] memory swaps)
        internal
        view
        returns (ProveBatchExecutor.Route memory)
    {
        return ProveBatchExecutor.Route({
            legs: legs, swaps: swaps, disposal: new ProveBatchExecutor.Swap[](0), sweep: _sweepAB()
        });
    }

    /// @dev Sell `amountIn` of token A at the tally, paid back to the executor.
    function _sellA(uint256 amountIn, uint256 leg)
        internal
        view
        returns (ProveBatchExecutor.Swap memory s)
    {
        s.tokenIn = address(tokenA);
        s.amountIn = amountIn;
        s.tokenOut = address(tokenB);
        s.spender = address(tally);
        s.target = address(tally);
        s.data =
            abi.encodeCall(Tally.swap, (address(tokenA), amountIn, address(tokenB), address(exec)));
        s.extra = new address[](0);
        s.leg = leg;
        s.amountOffset = exec.NO_PATCH();
        s.minOutOffset = exec.NO_PATCH();
    }

    /**
     * @dev The sink clone the executor drives for `who`.
     *
     * One sink per caller, at a deterministic address. The executor predicts it from the
     * caller's own address and mints it on their first entry that needs a venue call, so this
     * names the same address before that entry and after it.
     */
    function _sinkOf(address who) internal view returns (address) {
        return Clones.predictDeterministicAddress(
            address(exec.sinkTemplate()), bytes32(uint256(uint160(who))), address(exec)
        );
    }

    function _ran() internal view returns (uint256[] memory out) {
        out = new uint256[](tally.calls());
        for (uint256 k = 0; k < out.length; k++) {
            out[k] = tally.soldAmount(k);
        }
    }

    // ── 1. WHEN_ABSENT ───────────────────────────────────────────────────────

    /**
     * @notice A fallback and its paired ordinary swap: exactly one runs, whichever way it goes.
     *
     * The contract claims this pair is "mutually exclusive by construction". Both halves are
     * asserted here, on the same route, over the same leg.
     */
    function test_ExactlyOneOfAPairRunsWhateverTheBatchDid() public {
        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](2);
        swaps[0] = _sellA(1e18, 1); // leg 1 settled -> runs
        swaps[1] = _sellA(2e18, 1 | exec.WHEN_ABSENT()); // leg 1 settled -> skipped

        IProveSettlementBatch.FillRequest[] memory ring = _ring(1);
        vm.prank(caller);
        assertEq(exec.settleRing(ring, true, ANY_FEE, _route(2, swaps)), 2, "healthy ring");
        uint256[] memory ran = _ran();
        assertEq(ran.length, 1, "one of the pair ran");
        assertEq(ran[0], 1e18, "and it was the ordinary half");

        // Now the same pair against a batch that loses leg 1.
        ProveSettlement.Intent memory legA =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 10);
        ProveSettlement.Intent memory legB =
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, 11);
        legB.endTime = uint64(block.timestamp);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(legA, keyA, 1_000e18);
        reqs[1] = _req(legB, keyB, 110e18);

        ProveBatchExecutor.Swap[] memory two = new ProveBatchExecutor.Swap[](2);
        two[0] = _sellA(3e18, 1);
        two[1] = _sellA(60e18, 1 | exec.WHEN_ABSENT());

        vm.prank(caller);
        assertEq(exec.settleRing(reqs, true, ANY_FEE, _route(2, two)), 1, "one leg settled");
        ran = _ran();
        assertEq(ran.length, 2, "one more call, not two");
        assertEq(ran[1], 60e18, "and it was the fallback half");
    }

    /**
     * @notice The leg index a fallback reads survives compaction, so a hole in the MIDDLE of a
     *         batch fires the right fallback and no other.
     *
     * `owed` is compacted, so line `k` is not request `k`. If `fillBatchWithCallback` wrote the
     * wrong index the pairing would silently shift by one and a fallback would fire for a leg
     * that settled — which pays a maker out of a bag the settlement is about to pull from.
     *
     * Six swaps, one per case, each a distinct size so the record says exactly which ran.
     */
    function test_TheLegIndexSurvivesAHoleInTheMiddle() public {
        ProveSettlement.Intent memory leg0 =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 20);
        ProveSettlement.Intent memory leg1 =
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, 21);
        leg1.endTime = uint64(block.timestamp); // the hole
        ProveSettlement.Intent memory leg2 =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 22);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](3);
        reqs[0] = _req(leg0, keyA, 1_000e18);
        reqs[1] = _req(leg1, keyB, 110e18);
        reqs[2] = _req(leg2, keyA, 1_000e18);

        uint256 absent = exec.WHEN_ABSENT();
        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](6);
        swaps[0] = _sellA(1e18, 0); // leg 0 settled     -> runs
        swaps[1] = _sellA(2e18, 1); // leg 1 missing     -> skipped
        swaps[2] = _sellA(3e18, 1 | absent); // leg 1 missing -> runs
        swaps[3] = _sellA(4e18, 2 | absent); // leg 2 settled -> skipped
        swaps[4] = _sellA(5e18, 0 | absent); // leg 0 settled -> skipped
        swaps[5] = _sellA(150e18, exec.ANY_LEG()); // always runs

        vm.prank(caller);
        assertEq(exec.settleRing(reqs, true, ANY_FEE, _route(3, swaps)), 2, "two of three");

        uint256[] memory ran = _ran();
        assertEq(ran.length, 3, "three of six swaps ran");
        assertEq(ran[0], 1e18, "the ordinary call for the leg that survived");
        assertEq(ran[1], 3e18, "the fallback for the leg that did not");
        assertEq(ran[2], 150e18, "and the unconditional one");
    }

    /**
     * @notice A fallback keyed to a leg the batch never carried is refused, not fired.
     *
     * THE FINDING THIS GUARDS. `_wanted` answered "did any surviving line carry index `want`",
     * and a `want` past the end of the batch could never match — so the inverted test read true
     * and the call ran on a ring where nothing at all went missing. `route.legs` was right there
     * and was not consulted.
     *
     * The route is the solver's own data, so this cost nobody but the solver. It cost them in the
     * least visible way available: the phantom fallback spent tokens the settlement was about to
     * pull, so the batch reverted on a token shortfall if the ring was priced tightly, and quietly
     * overtraded if it was not. An off-by-one in a solver's leg numbering — which is the ordinary
     * way to reach this — produced both.
     *
     * `_wanted` now bounds the index, and the second half is why bounding it against `route.legs`
     * alone would have been theatre. `route.legs` is a number the caller writes: inflate it and
     * every phantom comes back, keyed to a leg the route claims and the request never sent. So
     * `settleRing` ties that number to `reqs.length`, which is the batch itself.
     */
    function test_AFallbackKeyedPastTheEndOfTheBatchIsRefused() public {
        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _sellA(1e18, 7 | exec.WHEN_ABSENT()); // a two-leg batch has no leg 7

        IProveSettlementBatch.FillRequest[] memory ring = _ring(30);
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveBatchExecutor.LegOutOfRange.selector, 7 | exec.WHEN_ABSENT(), 2
            )
        );
        exec.settleRing(ring, true, ANY_FEE, _route(2, swaps));
        assertEq(tally.calls(), 0, "the phantom fallback never reached the venue");

        // The same phantom, bought with the route's own count of its legs. Eight lines claimed
        // against two sent, so legs 2 through 7 would every one of them read absent.
        IProveSettlementBatch.FillRequest[] memory again = _ring(32);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ProveBatchExecutor.LegsExceedBatch.selector, 8, 2));
        exec.settleRing(again, true, ANY_FEE, _route(8, swaps));
        assertEq(tally.calls(), 0, "nor did the one a route could have claimed a leg for");
    }

    /**
     * @notice A disposal reads its own `Swap.leg`, in both directions.
     *
     * THE FINDING THIS GUARDS. `Swap.leg` was ignored on a disposal, so every disposal ran,
     * always. `proveBatchCallback` filtered `route.swaps` through `_wanted`; the disposal loop in
     * `settleRing` did not, so a `Swap` was filtered or not depending only on which array it sat
     * in — and nothing in `Swap.leg`'s own documentation said so. A solver carrying a per-leg
     * disposal beside a per-leg buy (which is exactly the shape "a fallback beside each leg"
     * suggests) got one of the two honoured.
     *
     * Only the callback knows which legs settled, and the disposal loop runs in a later frame, so
     * the callback decides for the disposals as well and carries the answer back to it.
     *
     * Leg 0 settles here. So the `0 | WHEN_ABSENT` disposal must not run, and the plain `0` one
     * must — the pair rule, stated over the array that used to ignore it.
     */
    function test_ADisposalReadsItsOwnLegIndex() public {
        ProveBatchExecutor.Swap[] memory disposal = new ProveBatchExecutor.Swap[](1);
        disposal[0] = _sellA(1e18, 0 | exec.WHEN_ABSENT());

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: new ProveBatchExecutor.Swap[](0), disposal: disposal, sweep: _sweepAB()
        });

        IProveSettlementBatch.FillRequest[] memory ring = _ring(40);
        vm.prank(caller);
        assertEq(exec.settleRing(ring, true, ANY_FEE, route), 2, "both legs settled");
        assertEq(tally.calls(), 0, "the fallback disposal stood down, its leg being present");

        // The other half of the pair, on the same leg and the same ring, so the only difference
        // is the bit. This one has its reason to run.
        route.disposal[0] = _sellA(1e18, 0);
        IProveSettlementBatch.FillRequest[] memory more = _ring(42);
        vm.prank(caller);
        assertEq(exec.settleRing(more, true, ANY_FEE, route), 2, "both legs settled again");

        uint256[] memory ran = _ran();
        assertEq(ran.length, 1, "and the disposal keyed to a leg that did settle ran");
        assertEq(ran[0], 1e18, "for the amount it named");
    }

    /**
     * @notice A route carrying more disposals than one word can answer for is refused.
     *
     * The callback decides which disposals to skip and hands the answer back as one bit each, so
     * a list longer than the word is a list this contract cannot answer for. It fails closed
     * rather than filtering on a bit that wrapped — which would skip disposal 0 in place of
     * disposal 256, and sell the wrong bag.
     */
    function test_ARouteWithMoreDisposalsThanOneWordIsRefused() public {
        uint256 many = exec.MAX_DISPOSALS() + 1;
        ProveBatchExecutor.Swap[] memory disposal = new ProveBatchExecutor.Swap[](many);
        for (uint256 k = 0; k < many; k++) {
            disposal[k] = _sellA(1, exec.ANY_LEG());
            disposal[k].data = "";
        }

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: new ProveBatchExecutor.Swap[](0), disposal: disposal, sweep: _sweepAB()
        });

        IProveSettlementBatch.FillRequest[] memory ring = _ring(44);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ProveBatchExecutor.TooManyDisposals.selector, many));
        exec.settleRing(ring, true, ANY_FEE, route);
    }

    /**
     * @notice `ANY_LEG` cannot be reached down a `WHEN_ABSENT` path, and vice versa.
     *
     * `ANY_LEG` is `type(uint256).max`, which carries the `WHEN_ABSENT` bit. The ordering of the
     * tests inside `_wanted` is the whole of what keeps them apart, so this pins the ordering:
     * the one index whose fallback encoding collides with `ANY_LEG` is `2**255 - 1`, and a batch
     * cannot have a leg there.
     *
     * The bound on the leg index sharpens both halves. The colliding index no longer merely fails
     * to match — no route can name it at all, because it points outside every batch a chain can
     * carry. And `ANY_LEG` has to be answered BEFORE that bound, or the sentinel every route in
     * the SDK carries would be refused as a fallback for leg `2**255 - 1`. That is the ordering,
     * and this is what asserts it.
     */
    function test_AnyLegAndWhenAbsentDoNotCollide() public {
        assertEq(exec.ANY_LEG(), exec.WHEN_ABSENT() | (exec.WHEN_ABSENT() - 1), "the collision");

        // The one index whose inverted form IS `ANY_LEG`. Plain, it names a leg no batch has.
        ProveBatchExecutor.Swap[] memory one = new ProveBatchExecutor.Swap[](1);
        one[0] = _sellA(1e18, exec.WHEN_ABSENT() - 1);

        IProveSettlementBatch.FillRequest[] memory ring = _ring(50);
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveBatchExecutor.LegOutOfRange.selector, exec.WHEN_ABSENT() - 1, 2
            )
        );
        exec.settleRing(ring, true, ANY_FEE, _route(2, one));

        // And the sentinel itself, on the same ring, which the bound must never see.
        ProveBatchExecutor.Swap[] memory two = new ProveBatchExecutor.Swap[](1);
        two[0] = _sellA(2e18, exec.ANY_LEG());

        IProveSettlementBatch.FillRequest[] memory again = _ring(52);
        vm.prank(caller);
        assertEq(exec.settleRing(again, true, ANY_FEE, _route(2, two)), 2, "healthy ring");
        uint256[] memory ran = _ran();
        assertEq(ran.length, 1, "the ANY_LEG call ran");
        assertEq(ran[0], 2e18, "and nothing else did");
    }

    /**
     * @notice A donation cannot be sold out from under the mark, whatever the leg encoding says.
     *
     * The mark is the executor's whole safety argument. A ring of no legs at all still reaches
     * the swap loop through `ANY_LEG`, and the swap can name the donated token. It ends below
     * its mark and the contract refuses.
     */
    function test_ADonationSurvivesAnEmptyRingThatTriesToSellIt() public {
        tokenA.mint(address(exec), 500e18);

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _sellA(500e18, exec.ANY_LEG());

        vm.prank(stranger);
        vm.expectRevert(ProveBatchExecutor.BalanceWentDown.selector);
        exec.settleRing(
            new IProveSettlementBatch.FillRequest[](0), false, ANY_FEE, _route(0, swaps)
        );

        assertEq(tokenA.balanceOf(address(exec)), 500e18, "the donation is still here");
        assertEq(tokenB.balanceOf(stranger), 0, "and the stranger got nothing");
    }

    // ── 2. The credit path and the callback ──────────────────────────────────

    /**
     * @notice Every door back into the executor is shut while a ring is mid-flight.
     *
     * The venue call is the one moment a stranger's code runs with the executor holding every
     * leg's released token A and no payment made yet. Six re-entries are tried from inside that
     * frame; all six have to fail, and the ring then has to settle anyway.
     */
    function test_EveryDoorBackIntoTheExecutorIsShutMidRing() public {
        Reenterer venue = new Reenterer(exec, settlement);
        tokenB.mint(address(venue), 1_000e18);

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _sellA(1e18, exec.ANY_LEG());
        swaps[0].spender = address(venue);
        swaps[0].target = address(venue);
        swaps[0].data =
            abi.encodeCall(Reenterer.swap, (address(tokenA), 1e18, address(tokenB), address(exec)));

        IProveSettlementBatch.FillRequest[] memory ring = _ring(60);
        vm.prank(caller);
        assertEq(exec.settleRing(ring, true, ANY_FEE, _route(2, swaps)), 2, "ring settled");

        assertTrue(venue.callbackBlocked(), "proveBatchCallback let a stranger in");
        assertTrue(venue.ringBlocked(), "settleRing re-entered");
        assertTrue(venue.disposalBlocked(), "sellSurplus let a stranger in");
        assertTrue(venue.batchBlocked(), "fillBatchWithCallback re-entered");
        assertTrue(venue.fillBlocked(), "fill re-entered");
        assertTrue(venue.sinkBlocked(), "the sink took an order from a stranger");
    }

    /// @notice No allowance to the relayer outlives a ring that lost a leg and used a fallback.
    function test_NoAllowanceOutlivesAPartialRing() public {
        ProveSettlement.Intent memory legA =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 70);
        ProveSettlement.Intent memory legB =
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, 71);
        legB.endTime = uint64(block.timestamp);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(legA, keyA, 1_000e18);
        reqs[1] = _req(legB, keyB, 110e18);

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _sellA(60e18, 1 | exec.WHEN_ABSENT());

        vm.prank(caller);
        exec.settleRing(reqs, true, ANY_FEE, _route(2, swaps));

        assertEq(tokenA.allowance(address(exec), relayer), 0, "token A allowance survived");
        assertEq(tokenB.allowance(address(exec), relayer), 0, "token B allowance survived");
        assertEq(tokenA.balanceOf(address(exec)), 0, "the executor kept token A");
        assertEq(tokenB.balanceOf(address(exec)), 0, "the executor kept token B");
    }

    /**
     * @notice A disposal cannot oversell into a mark, so it cannot undo a settled batch.
     *
     * THE FINDING THIS GUARDS. A disposal's failure was NOT always swallowed. It could undo a
     * settled batch, and a stranger could arm that with one donation.
     *
     * `Route.disposal` promises "best effort, and that is deliberate": the call runs in its own
     * frame, a failure is caught, and "a batch that has already paid every maker must not be
     * undone because a pool moved under the caller's own tidying up". The sizing note said an
     * oversized disposal was safe for the same reason — "ask for more and the transfer to the sink
     * finds the balance short, the frame catches it, and everything sweeps home".
     *
     * That held only while the executor's balance in the token was exactly what the ring earned.
     * The mark is what broke it. An oversized disposal spent into the mark, the venue call
     * succeeded, the `try` caught nothing — and then `_sweepAbove`, which runs AFTER the loop and
     * outside every frame, found the balance below the mark and reverted the whole `settleRing`.
     * Every maker was unpaid and the solver had bought the gas.
     *
     * A donation is permanent — `_sweepAbove` hands out only the increase, on purpose — so this
     * was bought once and stayed armed against every solver afterwards, for any oversell up to
     * the size of the gift.
     *
     * `sellSurplus` now measures the ask against `have` before it calls anything, so the promise
     * holds whatever else is sitting here. The two halves below are the same route and the same
     * oversell, and the only difference is that somebody sent the executor a token first. They
     * must end the same way, which is what this asserts.
     */
    function test_ADisposalCannotOversellIntoAMark() public {
        ProveBatchExecutor.Swap[] memory disposal = new ProveBatchExecutor.Swap[](1);
        // 150 against a surplus of 99.1: oversized, which the contract says is safe.
        disposal[0] = _sellA(150e18, exec.ANY_LEG());

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: new ProveBatchExecutor.Swap[](0), disposal: disposal, sweep: _sweepAB()
        });

        // Half one: no donation. The transfer to the sink is short, the frame catches it, and
        // the batch settles with the surplus swept home unsold. This is the documented behaviour.
        IProveSettlementBatch.FillRequest[] memory first = _ring(100);
        vm.prank(caller);
        assertEq(exec.settleRing(first, true, ANY_FEE, route), 2, "the batch settled");
        assertEq(tally.calls(), 0, "the oversized disposal never reached the venue");
        // 99.9, not 100: the gross is the hundred the maker signed and ten basis points of it is
        // the destination's. The executor's outlay is the hundred either way.
        assertEq(tokenB.balanceOf(makerA), 99.9e18, "and maker A was paid");

        // Half two: a stranger sends the executor some token A first. Nothing else changes, and
        // nothing about the outcome may change either.
        tokenA.mint(stranger, 500e18);
        vm.prank(stranger);
        tokenA.transfer(address(exec), 500e18);

        IProveSettlementBatch.FillRequest[] memory reqs = _ring(200);
        uint256 paidBefore = tokenB.balanceOf(makerA);

        // The disposal is given up on, and the executor says which one.
        vm.expectEmit(true, true, false, false, address(exec));
        emit ProveBatchExecutor.SurplusUnsold(address(tokenA), address(tokenB));

        vm.prank(caller);
        assertEq(exec.settleRing(reqs, true, ANY_FEE, route), 2, "the second batch settled too");

        assertEq(tokenB.balanceOf(makerA), paidBefore + 99.9e18, "and maker A was paid again");
        assertEq(tally.calls(), 0, "the oversized disposal still never reached the venue");
        assertEq(tokenA.balanceOf(address(exec)), 500e18, "the donation stayed exactly put");
        // `BalanceWentDown` is thrown by `_sweepAbove` and by nothing else, and `_sweepAbove`
        // runs after `_collect`. Its absence is therefore the proof: nothing spent below the mark,
        // so no settled batch could be undone outside the frame that was meant to hold it.
    }

    /**
     * @notice A donation cannot discharge a maker's debt, even on a ring that lost a leg.
     *
     * This is the case the mark exists for, stated against the newest path: leg 1 is gone, no
     * fallback replaces it, and the executor is holding a stranger's token B that would cover
     * maker A's delivery exactly. The settlement pulls it — it pulls rather than measures — and
     * the sweep then refuses to end below the mark, so the whole ring unwinds.
     */
    function test_ADonationCannotPayAMakerOnARingThatLostALeg() public {
        tokenB.mint(stranger, 200e18);
        vm.prank(stranger);
        tokenB.transfer(address(exec), 200e18);

        ProveSettlement.Intent memory legA =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 110);
        ProveSettlement.Intent memory legB =
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, 111);
        legB.endTime = uint64(block.timestamp);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(legA, keyA, 1_000e18);
        reqs[1] = _req(legB, keyB, 110e18);
        ProveBatchExecutor.Route memory route = _route(2, new ProveBatchExecutor.Swap[](0));

        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.BalanceWentDown.selector);
        exec.settleRing(reqs, true, ANY_FEE, route);

        assertEq(tokenB.balanceOf(makerA), 0, "a maker was paid out of a stranger's gift");
        assertEq(tokenB.balanceOf(address(exec)), 200e18, "the gift is still here");
    }

    /**
     * @notice A caller's own recovered strand CAN pay their own ring. A donation still cannot,
     *         and neither can anybody else's strand.
     *
     * This is the one consequence of the per-caller sink that is not obvious from the design, so
     * it is pinned rather than left for a reader to derive. `route.swaps` runs inside the
     * callback, BEFORE `_collect` pulls the makers' payments. A token recovered off the sink
     * therefore lands in this contract while the ring is still open, above its mark, and the
     * settlement can pull against it. Under the per-transaction sink it could not: the strand sat
     * on a clone nothing drove again.
     *
     * **Why that is acceptable, and why it does not weaken the mark rule.** The value is the
     * caller's own capital. It was paid to a sink only they can drive, it was recovered by a
     * route they wrote, and it is spent inside a transaction they sent. A donation is different
     * in kind: somebody else's capital, arriving unbidden at an address that holds nothing. The
     * mark was written against the second, and phase four below shows it still refuses it.
     *
     * Four phases, one ring shape throughout — leg 1 expired, so the caller owes maker A 100
     * token B and the ring itself raises none.
     */
    function test_ARecoveredStrandPaysTheCallersOwnRing() public {
        MockERC20 junk = new MockERC20("Junk", "JUNK", 18); // named, so nothing else is
        address mine = _sinkOf(caller);

        // Everything the helpers touch is built before its `vm.prank`. `_sinkOf`, `ANY_LEG` and
        // `NO_PATCH` all make a staticcall, and a prank is single-shot.
        ProveBatchExecutor.Swap[] memory strandIt = new ProveBatchExecutor.Swap[](1);
        strandIt[0] = _idleAt(junk, junk);
        address[] memory onlyJunk = new address[](1);
        onlyJunk[0] = address(junk);
        ProveBatchExecutor.Route memory strandRoute = ProveBatchExecutor.Route({
            legs: 0, swaps: strandIt, disposal: new ProveBatchExecutor.Swap[](0), sweep: onlyJunk
        });

        // The same idle call, but naming token B as its `tokenOut`, so `run` sweeps whatever
        // token B the sink is holding. This is the recovery a solver writes after they notice.
        ProveBatchExecutor.Swap[] memory recover = new ProveBatchExecutor.Swap[](1);
        recover[0] = _idleAt(junk, tokenB);
        ProveBatchExecutor.Route memory recovery = _route(2, recover);

        // ── 1. The strand. The venue tips a token the route does not name. ───
        tokenB.mint(address(tally), 200e18);
        tally.setTip(address(tokenB), 200e18);

        vm.prank(caller);
        exec.settleRing(new IProveSettlementBatch.FillRequest[](0), false, ANY_FEE, strandRoute);

        assertEq(tokenB.balanceOf(mine), 200e18, "the tip rests on the caller's own sink");
        assertEq(tokenB.balanceOf(address(exec)), 0, "and none of it is in the executor");
        // Tally pays its tip once and zeroes it, so no later swap here pays another. Every wei of
        // token B that moves from now on came off a sink.

        // ── 2. A different caller cannot reach it, from the settlement's side. ───
        //
        // `test_AStrandOnOneCallersSinkIsOutOfAnotherCallersReach` in `test/Executor.t.sol` says
        // the same thing about the SWEEP. This says it about the PULL, which is the half that
        // matters here: the stranger writes the identical route, their own sink hands over
        // nothing, and the settlement finds no token B to take.
        IProveSettlementBatch.FillRequest[] memory theirs = _shortRing(110);
        vm.prank(stranger);
        // Named rather than bare, because the reason IS the finding: this contract was about to
        // be pulled for maker A's 100 token B and held zero. Nothing came off the stranger's
        // sink.
        //
        // The revert used to come out of the token on the settlement's own pull, as
        // `ERC20InsufficientBalance(exec, 0, 99.9e18)`. It is `ProceedsNotHere` now: the executor
        // checks what it holds before it approves the relayer, so the refusal arrives in the
        // frame that still knows whose route named which address, and it names the whole debt —
        // the maker's 99.9 and the fee's 0.1 — rather than the first pull of the two. #153.
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveBatchExecutor.ProceedsNotHere.selector, address(tokenB), 0, 100e18
            )
        );
        exec.settleRing(theirs, true, ANY_FEE, recovery);

        assertEq(tokenB.balanceOf(makerA), 0, "a stranger's ring was paid from another's strand");
        assertEq(tokenB.balanceOf(mine), 200e18, "and the strand is where its owner left it");

        // ── 3. Its owner settles the identical ring, and it closes. ───
        IProveSettlementBatch.FillRequest[] memory ours = _shortRing(110);
        vm.prank(caller);
        assertEq(exec.settleRing(ours, true, ANY_FEE, recovery), 1, "one leg settled");

        assertEq(tokenB.balanceOf(mine), 0, "the sink handed the whole strand over");
        // 99.9 to the maker and 0.1 to the fee — a hundred between them, out of 200 that reached
        // the executor from the sink and from nowhere else. The rest goes home with the caller.
        assertEq(tokenB.balanceOf(makerA), 99.9e18, "the maker was paid out of the strand");
        assertEq(
            settlement.pendingFees(feeCfg(feeDest), address(tokenB)), 0.1e18, "and so was the fee"
        );
        assertEq(tokenB.balanceOf(caller), 100e18, "what the ring did not need came back");
        assertEq(tokenB.balanceOf(address(exec)), 0, "the executor kept none of it");

        // ── 4. The same 200 as a donation buys nothing. ───
        //
        // Same caller, same ring shape, same token, same amount — arriving at the executor as a
        // stranger's gift instead of off the caller's sink. `_sweepAbove` refuses to end below
        // the mark, so the ring unwinds. This is `test_ADonationCannotPayAMakerOnARingThatLostALeg`
        // asserted again, beside the case above, so nobody reads phase 3 as the mark relaxing.
        tokenB.mint(stranger, 200e18);
        vm.prank(stranger);
        tokenB.transfer(address(exec), 200e18);

        IProveSettlementBatch.FillRequest[] memory again = _shortRing(120);
        uint256 paid = tokenB.balanceOf(makerA);
        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.BalanceWentDown.selector);
        exec.settleRing(again, true, ANY_FEE, recovery);

        assertEq(tokenB.balanceOf(makerA), paid, "a donation paid a maker");
        assertEq(tokenB.balanceOf(address(exec)), 200e18, "and the gift is still sitting here");
    }

    /**
     * @dev A venue call that sells nothing, so the only thing it does is drive the sink.
     *
     * `amountIn` is zero, so `_sell` transfers nothing and the venue is approved for nothing.
     * What matters is `tokenOut`: `run` sweeps the sink's whole balance of it on the way out.
     * Name a token the sink is holding and this call is a recovery; name the junk token and it
     * recovers nothing.
     */
    function _idleAt(MockERC20 tokenIn, MockERC20 tokenOut)
        internal
        view
        returns (ProveBatchExecutor.Swap memory s)
    {
        s.tokenIn = address(tokenIn);
        s.amountIn = 0;
        s.tokenOut = address(tokenOut);
        s.spender = address(tally);
        s.target = address(tally);
        s.data = abi.encodeCall(Tally.swap, (address(tokenIn), 0, address(tokenIn), address(exec)));
        s.extra = new address[](0);
        s.leg = exec.ANY_LEG();
        s.amountOffset = exec.NO_PATCH();
        s.minOutOffset = exec.NO_PATCH();
    }

    /**
     * @dev A ring whose second leg has already expired, so the caller owes maker A 100 token B
     *      and the ring raises none of it. Whatever pays that maker came from somewhere else,
     *      which is what makes it the right shape for asking where.
     */
    function _shortRing(uint256 base)
        internal
        view
        returns (IProveSettlementBatch.FillRequest[] memory reqs)
    {
        ProveSettlement.Intent memory legA =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, base);
        ProveSettlement.Intent memory legB =
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, base + 1);
        legB.endTime = uint64(block.timestamp);

        reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(legA, keyA, 1_000e18);
        reqs[1] = _req(legB, keyB, 110e18);
    }

    /**
     * @notice Every token a route names anywhere is marked and swept, with all four arrays in
     *         play at once.
     *
     * `_tokensNamedBy` writes the disposal's names at an offset it computes rather than reads
     * back, which is the newest index arithmetic in the file. An off-by-one there leaves a token
     * unmarked or reads past the array. This route names a token in every field it can: the
     * sweep list, a swap's two tokens, a swap's `extra`, and a disposal's two.
     */
    function test_EveryFieldOfARouteIsMarkedAndSwept() public {
        MockERC20 tip = new MockERC20("Tip", "TIP", 18);
        tip.mint(address(tally), 1_000e18);

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _sellA(1e18, exec.ANY_LEG());
        swaps[0].extra = new address[](1);
        swaps[0].extra[0] = address(tip);

        ProveBatchExecutor.Swap[] memory disposal = new ProveBatchExecutor.Swap[](1);
        disposal[0] = _sellA(10e18, exec.ANY_LEG());

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: swaps, disposal: disposal, sweep: _sweepAB()
        });

        IProveSettlementBatch.FillRequest[] memory ring = _ring(120);
        vm.prank(caller);
        assertEq(exec.settleRing(ring, true, ANY_FEE, route), 2, "the ring settled");

        assertEq(tokenA.balanceOf(address(exec)), 0, "token A stranded in the executor");
        assertEq(tokenB.balanceOf(address(exec)), 0, "token B stranded in the executor");
        assertEq(tip.balanceOf(address(exec)), 0, "the extra token stranded in the executor");
        assertGt(tokenA.balanceOf(caller), 0, "the caller got no token A back");
        assertGt(tokenB.balanceOf(caller), 0, "the caller got no token B back");
    }

    /**
     * @notice REGRESSION: a stranger can still write the approval, and it is now worth nothing.
     *
     * This was the finding, and it was the worst one in the repository. `ProveCallSink` named the
     * hazard — "an `approve` the caller's own calldata writes does outlive it" — and then framed
     * the loss as the writer's own: "whatever the caller forgets to name is theirs to lose". The
     * two halves were not the same party. One sink served every solver on the chain, so the
     * approval one caller wrote was a standing claim on what a DIFFERENT caller later stranded.
     *
     * The attack cost nothing. A route with no legs, one swap, an `amountIn` of zero, and a
     * `target` that is the token itself: `_sell` transfers nothing, the sink approves the
     * attacker's chosen spender for nothing, and the attacker's own calldata writes
     * `approve(attacker, max)` — which the sink's reset does not touch, because the reset names
     * a different spender. Then any solver whose venue paid an unnamed token lost it.
     *
     * The sink is one clone per CALLER now. Both halves below still run, exactly as they did. The
     * attacker still gets their `approve` written — nothing stops a caller writing calldata — but
     * it lands on their own sink, and the honest solver's tip rests on a sink of theirs. The
     * `transferFrom` that used to take it now has no allowance to spend.
     *
     * The attacker cannot arm the solver's sink instead. Its address is easy to predict and that
     * buys nothing: writing an approval there means making it execute `approve`, and only the
     * solver's own ring makes the solver's sink execute anything.
     *
     * The test was called `test_AStrangerCanPreArmAStandingApprovalOutOfTheSharedSink` and it
     * passed. Its first assertion is what fails against the fix.
     */
    function test_AStrangerCanNoLongerPreArmAStandingApprovalOutOfTheSink() public {
        MockERC20 tip = new MockERC20("Tip", "TIP", 18);
        address template = address(exec.sinkTemplate());
        address spender = address(0x5DEE); // not the attacker, so the reset misses the grant

        // Half one: arm it. No legs, nothing sold, no tokens spent.
        ProveBatchExecutor.Swap[] memory arm = new ProveBatchExecutor.Swap[](1);
        arm[0].tokenIn = address(tip);
        arm[0].amountIn = 0;
        arm[0].tokenOut = address(tip);
        arm[0].spender = spender;
        arm[0].target = address(tip);
        arm[0].data = abi.encodeCall(IERC20.approve, (stranger, type(uint256).max));
        arm[0].extra = new address[](0);
        arm[0].leg = exec.ANY_LEG();
        arm[0].amountOffset = exec.NO_PATCH();
        arm[0].minOutOffset = exec.NO_PATCH();

        address[] memory only = new address[](1);
        only[0] = address(tip);
        ProveBatchExecutor.Route memory armRoute = ProveBatchExecutor.Route({
            legs: 0, swaps: arm, disposal: new ProveBatchExecutor.Swap[](0), sweep: only
        });

        address armed = _sinkOf(stranger);
        vm.prank(stranger);
        exec.settleRing(new IProveSettlementBatch.FillRequest[](0), false, ANY_FEE, armRoute);

        // The grant is written, and it is written over the attacker's own address.
        assertEq(tip.allowance(armed, stranger), type(uint256).max, "the attacker armed a clone");
        assertEq(
            tip.allowance(template, stranger), 0, "and never the address `sinkTemplate()` names"
        );
        // Their own, and only their own. The victim's sink is one prediction away and it grants
        // nobody anything, because the attacker cannot make it run.
        assertEq(tip.allowance(_sinkOf(caller), stranger), 0, "the attacker armed the victim's");

        // Half two: an honest solver's ring, at a venue that pays a tip the route did not name.
        tip.mint(address(tally), 5e18);
        tally.setTip(address(tip), 5e18);

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _sellA(1e18, exec.ANY_LEG()); // `extra` is empty: the tip is not named

        IProveSettlementBatch.FillRequest[] memory ring = _ring(130);
        address honest = _sinkOf(caller);
        assertTrue(honest != armed, "the solver's ring runs from a sink of their own");

        vm.prank(caller);
        assertEq(exec.settleRing(ring, true, ANY_FEE, _route(2, swaps)), 2, "the ring settled");

        assertEq(tip.balanceOf(honest), 5e18, "the unnamed tip rests on the solver's own sink");
        assertEq(tip.balanceOf(armed), 0, "and none of it is where the attacker armed");
        assertEq(tip.allowance(honest, stranger), 0, "the solver's own sink grants nobody");

        // And the stranger, who has never met this solver, gets nothing.
        vm.prank(stranger);
        vm.expectRevert();
        IERC20(address(tip)).transferFrom(honest, stranger, 5e18);
        assertEq(tip.balanceOf(stranger), 0, "a stranger took another caller's tip");
    }

    /**
     * @notice A solver takes back what they stranded, and no other caller can reach it.
     *
     * This is the property the per-transaction sink gave up, and the reason the sink is now one
     * clone per caller. A venue pays a token the route did not name, so it rests on the solver's
     * own sink. Two claims follow, and both are asserted here rather than argued.
     *
     * A DIFFERENT caller names that same token in a route of their own and gets nothing, because
     * their ring drives a different address that never held it. Then the owner names it and takes
     * it home. Name the token in the first place — the recovery costs a whole second ring.
     */
    function test_ASolverRecoversTheirOwnStrandAndNobodyElseCan() public {
        MockERC20 tip = new MockERC20("Tip", "TIP", 18);
        tip.mint(address(tally), 5e18);
        tally.setTip(address(tip), 5e18);

        address mine = _sinkOf(caller);
        address theirs = _sinkOf(stranger);
        assertTrue(mine != theirs, "the two callers do not share a sink");

        // The tip is not named, so it rests where the venue paid it.
        //
        // Every ring below is built BEFORE its `vm.prank`. `_ring` and `_route` both make a
        // staticcall, and a prank is single-shot: build inside the call and the helper eats it,
        // so `settleRing` runs as this test contract and drives a sink of its own.
        ProveBatchExecutor.Swap[] memory blind = new ProveBatchExecutor.Swap[](1);
        blind[0] = _sellA(1e18, exec.ANY_LEG());
        IProveSettlementBatch.FillRequest[] memory first = _ring(300);
        ProveBatchExecutor.Route memory blindRoute = _route(2, blind);
        vm.prank(caller);
        assertEq(exec.settleRing(first, true, ANY_FEE, blindRoute), 2, "ring settled");
        assertEq(tip.balanceOf(mine), 5e18, "the strand is on the solver's own sink");

        // The venue pays no tip from here on, so anything anybody ends up holding came out of a
        // sink rather than out of this ring.
        tally.setTip(address(0), 0);

        ProveBatchExecutor.Swap[] memory named = new ProveBatchExecutor.Swap[](1);
        named[0] = _sellA(1e18, exec.ANY_LEG());
        named[0].extra = new address[](1);
        named[0].extra[0] = address(tip);

        // A different caller asks for the same token, and their own sink hands over nothing.
        IProveSettlementBatch.FillRequest[] memory second = _ring(310);
        ProveBatchExecutor.Route memory namedRoute = _route(2, named);
        vm.prank(stranger);
        assertEq(exec.settleRing(second, true, ANY_FEE, namedRoute), 2, "ring settled");
        assertEq(tip.balanceOf(stranger), 0, "another caller reached the strand");
        assertEq(tip.balanceOf(theirs), 0, "their own sink never held it");
        assertEq(tip.balanceOf(mine), 5e18, "it is still where its owner left it");

        // And the owner takes it back.
        IProveSettlementBatch.FillRequest[] memory third = _ring(320);
        vm.prank(caller);
        assertEq(exec.settleRing(third, true, ANY_FEE, namedRoute), 2, "ring settled");
        assertEq(tip.balanceOf(mine), 0, "the owner's own ring swept their sink");
        assertEq(tip.balanceOf(caller), 5e18, "and the strand came home to them");
    }

    /**
     * @notice REGRESSION: naming different tokens still walks past any `target` check, and the
     *         approval it writes is still worthless.
     *
     * The cheap answer to the finding above was to have `run` refuse a `target` or a `spender`
     * that equals `tokenIn`, `tokenOut` or any `extra`. It looked sufficient, because that
     * exploit set all three to the same token. That was a property of one exploit, not of the
     * class: the attacker picks every field on their own.
     *
     * Here `tokenIn` and `tokenOut` are a worthless token the attacker deployed, and `target` is
     * the victim token. No named token matches the target, so the check would pass — and
     * `approve(attacker, max)` still runs against the victim token, still for free. The check
     * would have matched one signature rather than closing a hole.
     *
     * So the assertions below are unchanged from the version that ran against the shared sink:
     * the approval IS written, and no target check stopped it. What changed is the address it is
     * written over. The half that used to steal an honest solver's tip now takes nothing.
     */
    function test_NamingDifferentTokensWalksPastAnyTargetCheck() public {
        MockERC20 junk = new MockERC20("Junk", "JUNK", 18); // the attacker's own, worth nothing
        MockERC20 tip = new MockERC20("Tip", "TIP", 18); // the token the victim will strand
        address spender = address(0x5DEE); // not the attacker, so the reset misses the grant

        ProveBatchExecutor.Swap[] memory arm = new ProveBatchExecutor.Swap[](1);
        arm[0].tokenIn = address(junk);
        arm[0].amountIn = 0;
        arm[0].tokenOut = address(junk);
        arm[0].spender = spender;
        arm[0].target = address(tip);
        arm[0].data = abi.encodeCall(IERC20.approve, (stranger, type(uint256).max));
        arm[0].extra = new address[](0);
        arm[0].leg = exec.ANY_LEG();
        arm[0].amountOffset = exec.NO_PATCH();
        arm[0].minOutOffset = exec.NO_PATCH();

        // Every field the hypothetical check would read, and none of them is the target.
        assertTrue(arm[0].target != arm[0].tokenIn, "the target is not the input token");
        assertTrue(arm[0].target != arm[0].tokenOut, "nor the output token");
        assertEq(arm[0].extra.length, 0, "and there are no extras to match either");
        assertTrue(arm[0].spender != arm[0].tokenIn, "the spender names no token in the route");

        address[] memory only = new address[](1);
        only[0] = address(junk);
        ProveBatchExecutor.Route memory armRoute = ProveBatchExecutor.Route({
            legs: 0, swaps: arm, disposal: new ProveBatchExecutor.Swap[](0), sweep: only
        });

        address armed = _sinkOf(stranger);
        vm.prank(stranger);
        exec.settleRing(new IProveSettlementBatch.FillRequest[](0), false, ANY_FEE, armRoute);

        assertEq(
            tip.allowance(armed, stranger),
            type(uint256).max,
            "a target check on the named tokens would not have stopped this"
        );

        // And the standing claim reaches nothing. The solver's tip rests on a sink of their own.
        tip.mint(address(tally), 5e18);
        tally.setTip(address(tip), 5e18);

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _sellA(1e18, exec.ANY_LEG()); // `extra` is empty: the tip is not named

        IProveSettlementBatch.FillRequest[] memory ring = _ring(140);
        address honest = _sinkOf(caller);
        vm.prank(caller);
        assertEq(exec.settleRing(ring, true, ANY_FEE, _route(2, swaps)), 2, "the ring settled");

        assertEq(tip.balanceOf(armed), 0, "the armed clone never sees the tip");
        vm.prank(stranger);
        vm.expectRevert();
        IERC20(address(tip)).transferFrom(honest, stranger, 5e18);
        assertEq(tip.balanceOf(stranger), 0, "a stranger took another caller's tip");
    }

    /// @notice A route that plans for fewer legs than the batch settles is refused outright.
    function test_ARouteThatPlansForFewerLegsThanSettleIsRefused() public {
        // Built first: every helper here makes a staticcall, and a call between `expectRevert`
        // and the call under test is the call `expectRevert` watches.
        IProveSettlementBatch.FillRequest[] memory reqs = _ring(80);
        ProveBatchExecutor.Route memory route = _route(1, new ProveBatchExecutor.Swap[](0));

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ProveBatchExecutor.LegCountMismatch.selector, 1, 2));
        exec.settleRing(reqs, false, ANY_FEE, route);
    }

    /// @notice An owed token missing from the sweep list is refused, fallback or no fallback.
    function test_AnOwedTokenOffTheSweepListIsRefused() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring(90);
        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2,
            swaps: new ProveBatchExecutor.Swap[](0),
            disposal: new ProveBatchExecutor.Swap[](0),
            sweep: new address[](1)
        });
        route.sweep[0] = address(tokenA);

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(ProveBatchExecutor.OwedTokenNotSwept.selector, address(tokenB))
        );
        exec.settleRing(reqs, false, ANY_FEE, route);
    }
}

/**
 * @notice Permit2 nonce ordering against batch arming.
 *
 * Permit2 spends the nonce BEFORE it verifies the signature, and arming runs inside
 * `try this.armLeg(...)`. Two things have to hold: no maker's nonce can be spent by anybody
 * else's leg, and no nonce can be spent by a call that then fails to settle inside a
 * transaction that succeeds.
 */
contract AdversarialPermit2Test is Test {
    ProveSettlement settlement;
    MockPermit2 permit2;
    address relayer;

    MockERC20 tokenA;
    MockERC20 tokenB;

    address executor = address(0xE7EC);
    address proceeds = address(0xD0D);

    address maker;
    uint256 makerKey;
    address other;
    uint256 otherKey;

    uint256 constant SIZE = 100e18;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("permit2 maker");
        (other, otherKey) = makeAddrAndKey("another permit2 maker");

        permit2 = new MockPermit2();
        settlement = newSettlement(address(permit2));
        relayer = settlement.relayer();

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);

        tokenA.mint(maker, 4 * SIZE);
        tokenA.mint(other, 4 * SIZE);
        tokenB.mint(executor, 100 * SIZE);

        vm.prank(maker);
        tokenA.approve(address(permit2), type(uint256).max);
        vm.prank(other);
        tokenA.approve(address(permit2), type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── Fixture ──────────────────────────────────────────────────────────────

    function _intent(address m, uint256 nonce, bytes32 authNonce)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i.maker = m;
        i.recipient = m;
        i.tokenIn = address(tokenA);
        i.tokenOut = address(tokenB);
        i.amountIn = SIZE;
        i.minOutStart = SIZE;
        i.minOutEnd = SIZE;
        i.startTime = uint64(block.timestamp);
        i.endTime = uint64(block.timestamp + 30 minutes);
        i.flags = settlement.FLAG_PERMIT2();
        i.authNonce = authNonce;
        i.nonce = nonce;
    }

    function _digest(address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                permit2.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        permit2.PERMIT_TRANSFER_FROM_TYPEHASH(),
                        keccak256(abi.encode(permit2.TOKEN_PERMISSIONS_TYPEHASH(), token, amount)),
                        relayer,
                        nonce,
                        deadline
                    )
                )
            )
        );
    }

    function _transfer(uint256 amount, uint256 nonce, uint256 key)
        internal
        view
        returns (ProveSettlement.Permit2Transfer memory p)
    {
        p.token = address(tokenA);
        p.amount = amount;
        p.nonce = nonce;
        p.deadline = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(p.token, amount, nonce, p.deadline));
        p.signature = abi.encodePacked(r, s, v);
    }

    function _sign(ProveSettlement.Intent memory i, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function _spent(address who, uint256 nonce) internal view returns (bool) {
        return permit2.nonceBitmap(who, nonce >> 8) & (1 << (nonce & 0xff)) != 0;
    }

    // ── 3. Permit2 nonce ordering ────────────────────────────────────────────

    /**
     * @notice The sharp case: the Permit2 signature is GOOD, the intent's own signature is not.
     *
     * Permit2 spends the nonce before it checks anything of ours, so by the time `_armLeg`'s deep
     * re-evaluation reads the intent signature, the maker's nonce is gone and their tokens are in
     * the settlement's escrow. `armLeg` is external so that this unwinds. If the frame ever became
     * an internal call, a solver could burn any maker's live Permit2 signature — permanently,
     * because the bitmap bit does not come back — for the price of one batch, and the maker's
     * tokens would sit in a reservation attached to an intent that can never fill.
     *
     * The batch here SUCCEEDS overall, which is what makes this different from a revert test:
     * nothing outside the arming frame is rolled back.
     */
    function test_AGoodPermit2SignatureOnABadIntentLeavesTheNonceUnspent() public {
        ProveSettlement.Intent memory i = _intent(maker, 1, bytes32(0));
        bytes32 h = settlement.hashIntent(i);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0].intent = i;
        // Signed by somebody who is not the maker. The Permit2 half below is genuine.
        reqs[0].signature = _sign(i, otherKey);
        reqs[0].take = SIZE;
        reqs[0].arming = abi.encode(_transfer(SIZE, uint256(h), makerKey));

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "nothing settled");

        assertFalse(_spent(maker, uint256(h)), "the maker's permit2 nonce was burnt");
        assertEq(tokenA.balanceOf(maker), 4 * SIZE, "the maker's tokens moved");
        assertEq(settlement.reserved(h), 0, "a reservation survived a leg that cannot fill");
        assertEq(settlement.totalReserved(address(tokenA)), 0, "and the per-token sum with it");
    }

    /**
     * @notice A solver cannot aim one maker's leg at another maker's Permit2 nonce.
     *
     * The arming blob is the solver's own data, so the nonce in it is a number they choose. Two
     * things stop it being a weapon: the settlement insists the number equals the intent's own
     * hash (or the `authNonce` the maker signed), and `pullWithPermit2` names `i.maker` as the
     * owner, so only that maker's bitmap is ever reachable.
     */
    function test_OneMakersLegCannotBurnAnothersPermit2Nonce() public {
        // The nonce `other` is holding a live signature over.
        ProveSettlement.Intent memory victim = _intent(other, 9, bytes32(0));
        uint256 victimNonce = uint256(settlement.hashIntent(victim));

        // The solver's own leg, from a different maker, pointed at that nonce.
        ProveSettlement.Intent memory i = _intent(maker, 1, bytes32(0));
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0].intent = i;
        reqs[0].signature = _sign(i, makerKey);
        reqs[0].take = SIZE;
        reqs[0].arming = abi.encode(_transfer(SIZE, victimNonce, makerKey));

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "the mismatched leg settled");

        assertFalse(_spent(other, victimNonce), "the victim's nonce was burnt");
        assertFalse(_spent(maker, victimNonce), "and nobody else's bitmap moved either");
        assertEq(tokenA.balanceOf(other), 4 * SIZE, "the victim's tokens moved");
    }

    /**
     * @notice Two siblings sharing one `authNonce` are mutually exclusive inside ONE batch.
     *
     * This is the mutual exclusion the contract claims, tested where it is hardest to get right:
     * the first leg spends the nonce, the second leg's arming meets a spent nonce mid-batch, and
     * the batch has to step over exactly one of them and settle the other in full.
     */
    function test_SiblingsSharingAnAuthNonceCannotBothSettle() public {
        bytes32 shared = keccak256("one signature, two offers");
        ProveSettlement.Intent memory first = _intent(maker, 1, shared);
        ProveSettlement.Intent memory second = _intent(maker, 2, shared);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0].intent = first;
        reqs[0].signature = _sign(first, makerKey);
        reqs[0].take = SIZE;
        reqs[0].arming = abi.encode(_transfer(SIZE, uint256(shared), makerKey));
        reqs[1].intent = second;
        reqs[1].signature = _sign(second, makerKey);
        reqs[1].take = SIZE;
        reqs[1].arming = abi.encode(_transfer(SIZE, uint256(shared), makerKey));

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 1, "exactly one of the pair");

        assertTrue(_spent(maker, uint256(shared)), "the shared nonce is spent");
        assertEq(tokenA.balanceOf(maker), 3 * SIZE, "one lot left the wallet, not two");
        assertEq(tokenB.balanceOf(maker), SIZE, "and the maker was paid for one");
        assertEq(
            settlement.reserved(settlement.hashIntent(second)),
            0,
            "the skipped sibling holds no reservation"
        );
    }

    /// @notice A nonce a rival burnt first costs the batch that leg and nothing else.
    function test_AFrontRunNonceCostsTheBatchOneLeg() public {
        ProveSettlement.Intent memory i = _intent(maker, 1, bytes32(0));
        bytes32 h = settlement.hashIntent(i);

        // The rival's copy of the same signature lands first, straight at Permit2.
        vm.prank(maker);
        permit2.invalidateUnorderedNonces(uint256(h) >> 8, 1 << (uint256(h) & 0xff));

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0].intent = i;
        reqs[0].signature = _sign(i, makerKey);
        reqs[0].take = SIZE;
        reqs[0].arming = abi.encode(_transfer(SIZE, uint256(h), makerKey));

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "nothing settled");
        assertEq(settlement.reserved(h), 0, "and nothing was stranded");

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);
    }
}

/**
 * @notice Rounding in `_quote`, `minOutAt` and the delivery, at the extremes.
 *
 * The stated promise is that every rounding direction favours the maker, and that `minOut` is a
 * GROSS guarantee — the filler pays the curve's number whatever the rate is, and the fee is
 * carved out of it, so the maker receives `gross - fee` and the dust of the division is theirs.
 * Each test here is an attempt to find a take, a rate or a clock where that is false.
 */
contract AdversarialRoundingTest is Test {
    ProveSettlement settlement;
    address relayer;

    MockERC20 tokenIn;
    MockERC20 sixDecimals;

    address maker;
    uint256 makerKey;
    address executor = address(0xE7EC);
    address feeDest = address(0x5152);

    uint256 constant WAD = 1e18;
    uint64 constant T0 = 1_700_000_000;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();

        tokenIn = new MockERC20("In", "IN", 18);
        sixDecimals = new MockERC20("Six", "SIX", 6);

        tokenIn.mint(maker, type(uint128).max);
        sixDecimals.mint(executor, type(uint128).max);

        vm.prank(maker);
        tokenIn.approve(relayer, type(uint256).max);
        vm.prank(executor);
        sixDecimals.approve(relayer, type(uint256).max);

        vm.warp(T0);
    }

    function _i(uint256 amountIn, uint256 start, uint256 end, uint64 rate)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i.maker = maker;
        i.recipient = maker;
        i.tokenIn = address(tokenIn);
        i.tokenOut = address(sixDecimals);
        i.amountIn = amountIn;
        i.minOutStart = start;
        i.minOutEnd = end;
        i.startTime = T0;
        i.endTime = T0 + 1 hours;
        i.feeConfig = feeCfg(rate == 0 ? address(0) : feeDest);
        i.feeRateProceeds = rate;
        i.flags = settlement.FLAG_PARTIAL();
        i.nonce = 1;
    }

    // ── 4. Rounding ──────────────────────────────────────────────────────────

    /**
     * @notice The gross is never below the pro-rata share of the curve, and never more than one
     *         wei above it. The fee is the rate on that gross, rounded the other way.
     *
     * Both directions hand the odd wei to the maker. The gross rounds up so a partial fill never
     * shorts the curve; the fee rounds down so the dust of the split stays with the signer.
     *
     * The rate is bounded at `WAD` because `_termsOk` refuses anything above it. `quote` prices
     * the terms it is handed and validates none of them, so asking it about a refused intent
     * panics on the subtraction — see `test_F3e_ARateAboveOneIsAReasonNotAPanic` in
     * `EconAudit.t.sol` for the guard and the reason it lives where it does.
     */
    function testFuzz_TheGrossNeverShortsTheCurve(
        uint128 amountIn,
        uint128 start,
        uint128 take,
        uint32 dt,
        uint64 rawRate
    ) public view {
        amountIn = uint128(bound(amountIn, 1, type(uint128).max));
        take = uint128(bound(take, 1, amountIn));
        uint64 rate = uint64(bound(rawRate, 0, WAD));
        uint256 end = uint256(start) / 2;
        uint256 ts = T0 + (dt % 3600);

        ProveSettlement.Intent memory i = _i(amountIn, start, end, rate);
        uint256 m = settlement.minOutAt(i, ts);
        TakePoints.Quote memory q_fee = settlement.quote(i, take, ts);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        uint256 gross = delivered + fee;

        assertGe(gross * amountIn, uint256(take) * m, "the maker was shorted");
        if (gross > 0) {
            assertLt((gross - 1) * amountIn, uint256(take) * m, "rounded up by more than a wei");
        }
        uint256 charged = rate == 0 ? 0 : uint256(rate);
        assertLe(fee * WAD, gross * charged, "the fee was rounded up");
        assertGt((fee + 1) * WAD, gross * charged, "the fee was rounded away by more than a wei");
        assertLe(fee, gross, "and the maker's half can never go negative");
    }

    /// @notice A take of the whole intent delivers the curve exactly — never a wei under.
    function testFuzz_AWholeTakeIsExactlyTheCurve(uint128 amountIn, uint128 start, uint32 dt)
        public
        view
    {
        amountIn = uint128(bound(amountIn, 1, type(uint128).max));
        uint256 ts = T0 + (dt % 3600);
        ProveSettlement.Intent memory i = _i(amountIn, start, uint256(start) / 2, 0);
        uint256 delivered = settlement.quote(i, amountIn, ts).delivered;
        assertEq(delivered, settlement.minOutAt(i, ts), "a whole take is not the whole curve");
    }

    /**
     * @notice Splitting a fill can never pay the maker less in total than taking it whole.
     *
     * The interesting direction: a filler who wants to pay less looks for a split where the
     * roundings cancel. On a flat curve they cannot — every part rounds up — so the sum is at
     * least the floor and usually a wei or two above it.
     */
    function testFuzz_SplittingAFillNeverPaysLess(uint128 amountIn, uint128 minOut, uint8 parts)
        public
        view
    {
        amountIn = uint128(bound(amountIn, 2, type(uint128).max));
        parts = uint8(bound(parts, 2, 16));
        ProveSettlement.Intent memory i = _i(amountIn, minOut, minOut, 0);

        uint256 chunk = uint256(amountIn) / parts;
        vm.assume(chunk > 0);

        uint256 total;
        uint256 taken;
        for (uint256 k = 0; k < parts; k++) {
            uint256 take = k == parts - 1 ? amountIn - taken : chunk;
            uint256 d = settlement.quote(i, take, T0).delivered;
            total += d;
            taken += take;
        }
        assertEq(taken, amountIn, "the split did not cover the intent");
        assertGe(total, minOut, "a split fill paid the maker less than the floor");
    }

    /// @notice The Dutch decay rounds DOWN, so the floor it leaves rounds UP — the maker's way.
    function testFuzz_TheCurveDecaysNoFasterThanItSays(uint128 start, uint128 end, uint32 dt)
        public
        view
    {
        end = uint128(bound(end, 0, start));
        uint256 elapsed = dt % 3600;
        ProveSettlement.Intent memory i = _i(1e18, start, end, 0);
        uint256 m = settlement.minOutAt(i, T0 + elapsed);

        assertLe(m, start, "the curve went up");
        assertGe(m, end, "the curve went below its own end");
        // The decay taken is no more than the exact linear decay.
        assertLe((uint256(start) - m) * 3600, (uint256(start) - end) * elapsed, "decayed too far");
    }

    /**
     * @notice The four extremes the promise is hardest at, one assertion each.
     *
     * One wei of delivery; a six-decimal output where a small trade rounds a five basis point fee
     * away entirely; a rate of one, where every take must deliver itself; and `uint128` at both
     * ends, where the product `take x minOut` is 1.16e77 against a word's 1.157e77.
     *
     * The fee's ceiling is `WAD` now, not the field's own. `_termsOk` refuses anything above it,
     * so the largest rate this can ask about is a rate of 100% — where the destination takes the
     * whole gross and the maker receives nothing.
     */
    function test_TheStatedExtremes() public view {
        // A six-decimal output, a trade small enough that a percentage of it is sub-wei.
        ProveSettlement.Intent memory six = _i(1e18, 1000e6, 1000e6, 0.0005e18);
        TakePoints.Quote memory q_f = settlement.quote(six, 1, T0);
        uint256 d = q_f.delivered;
        uint256 f = q_f.feeProceeds;
        assertEq(f, 0, "five basis points of one wei rounds away to nothing");
        assertEq(d, 1, "and the maker keeps the whole wei");

        // A rate of one: every take delivers itself, whatever the size.
        ProveSettlement.Intent memory par = _i(1e18, 1e18, 1e18, 0);
        d = settlement.quote(par, 1, T0).delivered;
        assertEq(d, 1, "a rate of one shorted a one-wei take");
        d = settlement.quote(par, 333_333_333_333_333_333, T0).delivered;
        assertEq(d, 333_333_333_333_333_333, "a rate of one shorted an awkward take");

        // Both bounds at the type's ceiling, and the largest rate `_termsOk` admits.
        uint256 big = type(uint128).max;
        ProveSettlement.Intent memory edge = _i(big, big, big, uint64(WAD));
        TakePoints.Quote memory q_1 = settlement.quote(edge, big, T0);
        d = q_1.delivered;
        f = q_1.feeProceeds;
        assertEq(d + f, big, "the ceiling case did not gross the curve");
        assertEq(f, big, "a rate of one takes the whole gross");
        assertEq(d, 0, "and leaves the maker nothing");

        // One wei of input against the ceiling of a curve: the gross is over-served, never under.
        TakePoints.Quote memory q_2 = settlement.quote(edge, 1, T0);
        d = q_2.delivered;
        f = q_2.feeProceeds;
        assertEq(d + f, 1, "one wei of the largest intent there can be");
    }

    /**
     * @notice The fee comes out of the delivery, and the rounding of it favours the maker.
     *
     * A six-decimal output at five basis points, on a take that grosses 3,000 units. The nominal
     * fee is one and a half units; the maker keeps the half. The filler pays the gross either
     * way, so the rounding decides only whose money the dust is.
     *
     * This was `test_TheFeeNeverComesOutOfTheDelivery`, and it was true until the fee moved
     * inside the maker's number.
     */
    function test_TheFeeAlwaysComesOutOfTheDelivery() public {
        ProveSettlement.Intent memory i = _i(1e18, 1000e6, 1000e6, 0.0005e18);
        // A gross of 3,000 six-decimal units: `take x 1000e6 / 1e18`, so 3e12 buys 3,000.
        uint256 take = 3e12;
        TakePoints.Quote memory q_fee = settlement.quote(i, take, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        uint256 gross = delivered + fee;

        assertEq(gross, 3_000, "the take was chosen for a gross that does not divide by the rate");
        assertGt(fee, 0, "this case is only interesting when a fee is charged");
        assertEq(fee, 1, "one whole unit of a nominal one and a half");
        assertLt(fee * WAD, gross * uint256(i.feeRateProceeds), "so the fee rounded down, not up");
        assertEq(delivered, gross - fee, "and the half unit stayed with the maker");

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        uint256 before = sixDecimals.balanceOf(maker);
        uint256 execBefore = sixDecimals.balanceOf(executor);

        vm.prank(executor);
        settlement.fill(i, abi.encodePacked(r, s, v), take, ANY_FEE);

        assertEq(sixDecimals.balanceOf(maker) - before, delivered, "the maker got less than quoted");
        assertEq(
            settlement.pendingFees(feeCfg(feeDest), address(sixDecimals)),
            fee,
            "the fee did not go where the intent said"
        );
        assertEq(
            execBefore - sixDecimals.balanceOf(executor),
            gross,
            "the filler paid something other than the gross"
        );
    }

    function _ceil(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
