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
import {IPulseXRouter} from "../src/interfaces/IPulseXRouter.sol";
import {ANY_FEE, NO_PERMIT2, RoutingExecutor} from "./Mocks.sol";

/**
 * @notice The tests that only mean something against real state: real WPLS, real PLSX and the
 *         real PulseX router. Anvil forks mainnet at a pinned block, so a run today and a run
 *         next month see the same liquidity.
 *
 *   PULSECHAIN_RPC=https://one.valve.city/rpc/evm/369 \
 *     FOUNDRY_PROFILE=fork forge test --match-path test/Fork.t.sol
 *
 * Without PULSECHAIN_RPC every test returns at once. The fork profile sends the key as a header.
 *
 * Two traps this file exists to remember:
 *   1. The fork is created inside each test, not in `setUp`. A fork taken in `setUp` and then
 *      snapshotted loses the lazy account fetch that a delegatecall proxy needs.
 *   2. PLSX is a governance token with delegate checkpoints. `deal` writes the balance slot and
 *      leaves the checkpoints alone, so the next transfer underflows. Buy it from the pool
 *      instead, which is what a real executor does anyway.
 */
contract ForkTest is Test {
    uint256 constant PIN = 27_260_000;

    address constant WPLS = 0xA1077a294dDE1B09bB078844df40758a5D0f9a27;
    address constant PLSX = 0x95B303987A60C71504D99Aa1b13B4DA07b0790ab;
    address constant PULSEX_V2 = 0x165C3410fC91EF562C50559f7d2289fEbed552d9;

    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;

    address owner = address(0xB0B);
    /// @dev Where an unattributed token goes, and where this fixture's intents send their fee.
    address proceeds = address(0x7EA);
    address executor = address(0xE0E);
    address maker;
    uint256 makerKey;

    string rpc;

    function setUp() public {
        rpc = vm.envOr("PULSECHAIN_RPC", string(""));
    }

    /**
     * @dev False when there is no RPC — and the test is marked SKIPPED, not passed.
     *
     * It used to return false and nothing else, so every call site's `if (!_boot()) return;` ended
     * the test early and forge counted it a pass. CI holds no `PULSECHAIN_RPC` secret, so all
     * fourteen fork tests reported green while asserting nothing at all, for as long as they have
     * existed. `vm.skip` is the difference between a suite that is honest about its coverage and
     * one that manufactures it.
     */
    function _boot() internal returns (bool) {
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }

        vm.createSelectFork(rpc, PIN);
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        // The intents name `proceeds` as their fee sink, paying itself. See `Sinks.sol`.
        relayer = settlement.relayer();

        // WPLS is a WETH9 clone: no checkpoints, so writing the balance slot is safe.
        deal(WPLS, maker, 10_000_000e18);

        vm.prank(maker);
        IERC20(WPLS).approve(relayer, type(uint256).max);
        vm.prank(executor);
        IERC20(PLSX).approve(relayer, type(uint256).max);
        return true;
    }

    /// @dev Buy a token with real liquidity, the way an executor stocks up.
    function _buyFor(address to, address token, uint256 wplsIn) internal {
        deal(WPLS, address(this), wplsIn);
        IERC20(WPLS).approve(PULSEX_V2, wplsIn);
        address[] memory path = new address[](2);
        path[0] = WPLS;
        path[1] = token;
        IPulseXRouter(PULSEX_V2).swapExactTokensForTokens(wplsIn, 0, path, to, block.timestamp);
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

    // ── Real tokens ──────────────────────────────────────────────────────────

    function test_FillWithRealTokens() public {
        if (!_boot()) return;
        _buyFor(executor, PLSX, 5_000_000e18);

        ProveSettlement.Intent memory i = _intent(1_000_000e18, 25_000e18);
        bytes memory sig = _sign(i);
        TakePoints.Quote memory q_fee = settlement.quote(i, i.amountIn, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;

        uint256 makerBefore = IERC20(PLSX).balanceOf(maker);
        vm.prank(executor);
        settlement.fill(i, sig, i.amountIn, ANY_FEE);

        assertEq(IERC20(PLSX).balanceOf(maker) - makerBefore, delivered, "maker got the rate");
        assertEq(IERC20(WPLS).balanceOf(executor), i.amountIn, "executor got token A");
        assertEq(
            settlement.pendingFees(feeCfg(proceeds), PLSX),
            fee,
            "the fee was booked to the address the intent named"
        );
        // And it comes out against a real token, not a mock. Anybody may spend the gas.
        assertEq(claimFor(settlement, proceeds, PLSX), fee, "and it claims out");
        assertEq(IERC20(PLSX).balanceOf(proceeds), fee, "to the destination, in full");
    }

    /// @notice The executor holds nothing and pays the maker out of a real PulseX swap.
    function test_CallbackFillThroughRealPulseX() public {
        if (!_boot()) return;
        uint256 amountIn = 1_000_000e18;

        address[] memory path = new address[](2);
        path[0] = WPLS;
        path[1] = PLSX;
        uint256 marketOut = IPulseXRouter(PULSEX_V2).getAmountsOut(amountIn, path)[1];
        emit log_named_uint("market out (PLSX)", marketOut);

        // Ask for 90% of the market rate; the rest is the executor's spread.
        ProveSettlement.Intent memory i = _intent(amountIn, (marketOut * 90) / 100);
        bytes memory sig = _sign(i);
        TakePoints.Quote memory q_fee = settlement.quote(i, amountIn, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;

        RoutingExecutor bot = new RoutingExecutor(PULSEX_V2, address(settlement));
        assertEq(IERC20(PLSX).balanceOf(address(bot)), 0, "the bot starts empty");

        // The caller is the callback target, so the bot sends the transaction itself.
        bot.settle(settlement, i, sig, amountIn, "", ANY_FEE);

        assertEq(IERC20(PLSX).balanceOf(maker), delivered, "maker paid from the pool");
        assertEq(settlement.pendingFees(feeCfg(proceeds), PLSX), fee, "fee charged out of the pool");
        assertGt(IERC20(PLSX).balanceOf(address(bot)), 0, "the spread is the bot's");
    }
}
