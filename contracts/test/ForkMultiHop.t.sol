// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ProveExecutor, IProveSettlementFill} from "../src/ProveExecutor.sol";
import {ProveCallSink} from "../src/ProveCallSink.sol";
import {IPulseXRouter} from "../src/interfaces/IPulseXRouter.sol";
import {ANY_FEE, NO_PERMIT2} from "./Mocks.sol";

/**
 * @notice A zero-inventory fill whose swap is a multi-hop route, against real PulseX on 369.
 *
 *   PULSECHAIN_RPC=https://one.valve.city/rpc/evm/369 \
 *     FOUNDRY_PROFILE=fork forge test --match-path test/ForkMultiHop.t.sol -vv
 *
 * Without PULSECHAIN_RPC every test skips, so plain `forge test` stays offline.
 *
 * ## The question
 *
 * The executor bot now prices routes of up to three hops (`sdk/src/solver/graph.ts`) and sends
 * the whole path in one `swapExactTokensForTokens` (`app/scripts/executor.ts`). Nothing in
 * `ProveExecutor` names a path: the swap is an opaque call the sink makes. So the question is
 * whether that holds for a path longer than two tokens. The intermediate tokens must move pair to
 * pair inside the router and rest nowhere: not in the executor, and not in the caller's sink. If
 * one did, `extra` would have to name it, or it would strand.
 *
 * And the other half: a route priced on reserves that moved before the fill lands must revert at
 * the router, with nothing moved. That is what makes the bot's on-chain simulation, and the
 * `amountOutMin` it sends, the last word on freshness.
 *
 * ## The routes
 *
 * Both on PulseX v2, measured on 2026-09-23 for one million WPLS into PLSX:
 *
 *   direct                  1,233,050.8 PLSX
 *   WPLS > DAI > PLSX       1,233,186.8 PLSX   (bridged DAI; beats the direct pool)
 *   WPLS > HEX > pDAI > PLSX 1,221,943.6 PLSX  (three hops, through the forked DAI)
 *
 * The fork is taken 64 blocks behind the head, as `Fork369Rehearsal.t.sol` does, so every rate
 * comes from recent pools, a reorg of the head cannot fail it, and no assertion writes one down.
 */
contract ForkMultiHopTest is Test {
    address constant WPLS = 0xA1077a294dDE1B09bB078844df40758a5D0f9a27;
    address constant PLSX = 0x95B303987A60C71504D99Aa1b13B4DA07b0790ab;
    address constant HEX = 0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39;
    /// @dev The bridged DAI, about $1.00. Not pDAI below: the two share a symbol and nothing else.
    address constant DAI = 0xefD766cCb38EaF1dfd701853BFCe31359239F305;
    /// @dev The DAI forked from Ethereum at launch, about $0.0022.
    address constant PDAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address constant PULSEX_V2 = 0x165C3410fC91EF562C50559f7d2289fEbed552d9;

    ProveSettlement settlement;
    ProveExecutor executor;
    address relayer;
    address owner = address(0xB0B);
    address proceeds = address(0x7EA);
    address maker;
    uint256 makerKey;
    string rpc;

    function setUp() public {
        rpc = vm.envOr("PULSECHAIN_RPC", string(""));
    }

    /// @dev False when there is no RPC, and the test is marked SKIPPED rather than passed.
    function _boot() internal returns (bool) {
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }
        // Fork 64 blocks behind the head, not at it. On 2026-09-23 block 27,619,329 was canonical for
        // 5.6 seconds, then a one-block reorg replaced it, and a suite forked at that hash failed
        // with "block not found". Every node answered correctly: the block was gone. 64 blocks is
        // about ten minutes, inside the ~68-block gap the gateway reported between head and final.
        vm.createSelectFork(rpc);
        vm.createSelectFork(rpc, block.number - 64);
        assertEq(block.chainid, 369, "the fork is chain 369");
        (maker, makerKey) = makeAddrAndKey("multi-hop maker");
        settlement = newSettlement(NO_PERMIT2);
        // The intents name `proceeds` as their fee sink, paying itself. See `Sinks.sol`.
        executor = new ProveExecutor(address(settlement));
        relayer = settlement.relayer();
        // WPLS is a WETH9 clone: no checkpoints, so writing the balance slot is safe.
        deal(WPLS, maker, 10_000_000e18);
        vm.prank(maker);
        IERC20(WPLS).approve(relayer, type(uint256).max);
        return true;
    }

    function _twoHops() internal pure returns (address[] memory path) {
        path = new address[](3);
        path[0] = WPLS;
        path[1] = DAI;
        path[2] = PLSX;
    }

    function _threeHops() internal pure returns (address[] memory path) {
        path = new address[](4);
        path[0] = WPLS;
        path[1] = HEX;
        path[2] = PDAI;
        path[3] = PLSX;
    }

    /// @notice Two hops: the maker is paid, the caller keeps the spread, nothing rests anywhere.
    function test_TwoHopRouteSettlesThroughTheExecutor() public {
        if (!_boot()) return;
        _fillAlong(_twoHops());
    }

    /// @notice Three hops, the longest the bot will price: the same, with two tokens in between.
    function test_ThreeHopRouteSettlesThroughTheExecutor() public {
        if (!_boot()) return;
        _fillAlong(_threeHops());
    }

    function _fillAlong(address[] memory path) internal {
        uint256 amountIn = 1_000_000e18;
        uint256 market = IPulseXRouter(PULSEX_V2).getAmountsOut(amountIn, path)[path.length - 1];
        // Ask for 95% of the route's rate; the rest is the caller's spread.
        ProveSettlement.Intent memory i = _intent(amountIn, (market * 95) / 100);
        bytes memory sig = _sign(i);
        TakePoints.Quote memory q_fee = settlement.quote(i, amountIn, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;

        // The bot's bound: what the fill owes, which is the floor it sends as `amountOutMin`.
        uint256 owed = delivered + fee;
        executor.fill(_asExec(i), sig, amountIn, ANY_FEE, _swap(amountIn, owed, path));

        assertEq(IERC20(PLSX).balanceOf(maker), delivered, "the maker was paid from the route");
        assertEq(settlement.pendingFees(feeCfg(proceeds), PLSX), fee, "the fee was booked");
        assertGt(IERC20(PLSX).balanceOf(address(this)), 0, "the spread went to the caller");

        // Nothing rests on the executor or on this caller's sink, in any token on the path.
        address sink = executor.sinkFor(address(this));
        for (uint256 k = 0; k < path.length; k++) {
            assertEq(IERC20(path[k]).balanceOf(address(executor)), 0, "the executor kept nothing");
            assertEq(IERC20(path[k]).balanceOf(sink), 0, "the sink kept nothing");
        }
    }

    /**
     * @notice A route priced before a pool moved reverts at the router, and nothing moves.
     *
     * The bot prices on reserves from its last read, and a pool can move in the block between the
     * quote and the fill. Here someone sells ten million WPLS into WPLS/HEX, the first hop of the
     * three-hop route, after the quote. The fill goes out with the bound the stale quote implied
     * and must fail on the router's own output check, with the maker's tokens and the caller's
     * balance where they were.
     */
    function test_AReserveThatMovedAfterTheQuoteRevertsTheFill() public {
        if (!_boot()) return;
        address[] memory path = _threeHops();
        uint256 amountIn = 1_000_000e18;
        uint256 quoted = IPulseXRouter(PULSEX_V2).getAmountsOut(amountIn, path)[path.length - 1];
        ProveSettlement.Intent memory i = _intent(amountIn, (quoted * 95) / 100);
        bytes memory sig = _sign(i);

        // The pool moves.
        address whale = address(0xAB0BA);
        deal(WPLS, whale, 10_000_000e18);
        vm.startPrank(whale);
        IERC20(WPLS).approve(PULSEX_V2, type(uint256).max);
        address[] memory hop = new address[](2);
        hop[0] = WPLS;
        hop[1] = HEX;
        IPulseXRouter(PULSEX_V2)
            .swapExactTokensForTokens(10_000_000e18, 0, hop, whale, block.timestamp);
        vm.stopPrank();
        uint256 now_ = IPulseXRouter(PULSEX_V2).getAmountsOut(amountIn, path)[path.length - 1];
        assertLt(now_, quoted, "the route pays less than it was quoted at");

        uint256 makerWpls = IERC20(WPLS).balanceOf(maker);
        // The bound the stale quote implied: the quoted output, which the route no longer pays.
        // The router refuses on its own output check, and the sink carries its reason up whole.
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveCallSink.SwapFailed.selector,
                abi.encodeWithSignature("Error(string)", "PulseXRouter: INSUFFICIENT_OUTPUT_AMOUNT")
            )
        );
        executor.fill(_asExec(i), sig, amountIn, ANY_FEE, _swap(amountIn, quoted, path));

        assertEq(IERC20(WPLS).balanceOf(maker), makerWpls, "the maker kept their tokens");
        assertEq(IERC20(PLSX).balanceOf(maker), 0, "and was paid nothing");
        assertEq(
            IERC20(PLSX).balanceOf(address(this)),
            0,
            "the caller earned nothing, and lost nothing but gas"
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// @dev The swap blob the bot builds: `executorRouterSwap` in `sdk/src/solver/abi.ts`. The
    ///      router pays the executor directly, and `extra` stays empty: nothing on the path rests.
    function _swap(uint256 amountIn, uint256 amountOutMin, address[] memory path)
        internal
        view
        returns (ProveExecutor.Swap memory)
    {
        return ProveExecutor.Swap({
            spender: PULSEX_V2,
            target: PULSEX_V2,
            data: abi.encodeCall(
                IPulseXRouter.swapExactTokensForTokens,
                (amountIn, amountOutMin, path, address(executor), block.timestamp + 300)
            ),
            extra: new address[](0)
        });
    }

    function _intent(uint256 amountIn, uint256 minOut)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: WPLS,
            tokenOut: PLSX,
            amountIn: amountIn,
            minOutStart: minOut,
            minOutEnd: minOut,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(proceeds),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0.001e18,
            minFill: 0,
            authNonce: bytes32(0),
            flags: 1,
            nonce: 1,
            curve: bytes32(0)
        });
    }

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function _asExec(ProveSettlement.Intent memory i)
        internal
        pure
        returns (IProveSettlementFill.Intent memory o)
    {
        o = IProveSettlementFill.Intent({
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
}
