// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPulseXFactory} from "../src/interfaces/IPulseXFactory.sol";
import {IPulseXPair} from "../src/interfaces/IPulseXPair.sol";
import {IPulseXRouter} from "../src/interfaces/IPulseXRouter.sol";
import {IWrappedToken} from "../src/interfaces/IWrappedToken.sol";

/// @notice The live PulseX buy-and-burn, as far as this file needs it. The proxy at
///         `BUY_AND_BURN` is UUPS, and the implementation is verified as
///         `PLSXBuyAndBurnUpgradeable`. Every getter here is a live setting we assert on.
interface IPlsxBuyAndBurn {
    /// @notice True means any caller passes the authorisation check.
    function anyAuth() external view returns (bool);
    /// @notice The dev's share of the PLSX, in basis points.
    function devCut() external view returns (uint256);
    /// @notice The caller's share of what is left after the dev cut, in basis points.
    function BOUNTY_FEE() external view returns (uint256);
    function devAddr() external view returns (address);
    /// @notice The guard divisor. A swap needs `reserveIn / amountIn > slippage`.
    function slippage() external view returns (uint256);
    /// @notice The token a conversion hops through. It defaults to WPLS.
    function bridgeFor(address token) external view returns (address);
    /// @notice Burns the LP it holds for each named pair, then converts the whole balance of
    ///         every named token to PLSX and burns it.
    function convertLps(address[] calldata tokens0, address[] calldata tokens1) external;
}

/**
 * @notice What happens to a token that reaches PulseX's own buy-and-burn. Anvil forks mainnet at
 *         a pinned block, so the numbers here are the numbers today and next month.
 *
 * This is not a hypothetical any more. `defaultProceeds` on 369 is that buy-and-burn, so every
 * token `sweepUnowned` pays out lands where these two tests send theirs. What they measure is
 * therefore the cost and the limit of that setting: 14.29% of every PLSX a forwarded token
 * produces goes to an address that is not ours, and a token with no PulseX pool against WPLS is
 * stranded there for good. Both apply to strays only — a fee goes wherever the intent signed.
 *
 *   PULSECHAIN_RPC=https://rpc.pulsechain.com \
 *     forge test --match-path test/ForkBuyAndBurn.t.sol
 *
 * Without PULSECHAIN_RPC every test returns immediately, so plain `forge test` stays offline.
 *
 * Four traps this file exists to remember:
 *   1. The fork is created inside each test, not in `setUp`. A fork taken in `setUp` and then
 *      snapshotted loses the lazy account fetch that a delegatecall proxy needs, and both the
 *      buy-and-burn and the x402 wrapper are proxies.
 *   2. PLSX is a governance token with delegate checkpoints. `deal` writes the balance slot and
 *      leaves the checkpoints alone, so the next transfer underflows. Buy it from the pool
 *      instead. HEX keeps no checkpoints, so `deal` gives HEX that really moves, and the first
 *      test proves that before it relies on it.
 *   3. `convertLps` is `onlyEOA`, which compares `msg.sender` against `tx.origin`. A test
 *      contract fails that. Two-argument `vm.prank(eoa, eoa)` sets both.
 *   4. Every swap inside the buy-and-burn asserts `reserveIn / amountIn > slippage`, and
 *      `slippage` is 9 on chain. A donation of a ninth of the reserve or more reverts the whole
 *      call, so the donations here stay far under that and the test says so out loud.
 */
contract ForkBuyAndBurnTest is Test {
    uint256 constant PIN = 27_260_000;

    address constant WPLS = 0xA1077a294dDE1B09bB078844df40758a5D0f9a27;
    address constant PLSX = 0x95B303987A60C71504D99Aa1b13B4DA07b0790ab;
    address constant HEX_ = 0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39;
    address constant PULSEX_V2 = 0x165C3410fC91EF562C50559f7d2289fEbed552d9;
    address constant PULSEX_V2_FACTORY = 0x29eA7545DEf87022BAdc76323F373EA1e707C523;
    address constant X402_PLSX = 0x1EABe4a39B404ae7Cd386194f1b10A011f430135;

    address constant BUY_AND_BURN = 0xd6cA7ee047a6F45d20d2962E4394E070cF27724F;
    address constant DEV_ADDR = 0x3239713576e11082CF9B9cDA9b77468Ea644c682;

    uint256 constant WAD = 10_000;

    IPlsxBuyAndBurn constant BB = IPlsxBuyAndBurn(BUY_AND_BURN);

    /// @dev The caller of `convertLps`, and the address the bounty lands on.
    address eoa;

    string rpc;

    function setUp() public {
        rpc = vm.envOr("PULSECHAIN_RPC", string(""));
    }

    /// @dev Returns false when there is no RPC, so each test can bail out quietly.
    function _boot() internal returns (bool) {
        // `vm.skip`, not a bare return. Without it these two tests reported PASS while executing
        // one line, and `docs/AUDIT-SCOPE.md` section 6.4 cites them as where the cost of #117 is
        // measured. Two of 612 green tests asserted nothing, and the count said otherwise.
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }

        vm.createSelectFork(rpc, PIN);
        eoa = makeAddr("burner");
        return true;
    }

    /// @dev The live settings the two tests below reason about. Read them from the chain rather
    ///      than trusting a note, because the owner can move every one of them.
    function _assertLiveSettings() internal view {
        assertTrue(BB.anyAuth(), "anyAuth is on, so any caller passes the authorisation check");
        assertEq(BB.devCut(), 1429, "devCut is 1429 bps");
        assertEq(BB.BOUNTY_FEE(), 10, "BOUNTY_FEE is 10 bps");
        assertEq(BB.devAddr(), DEV_ADDR, "devAddr is the address we measure");
        assertEq(BB.slippage(), 9, "the slippage guard divisor is 9");
        assertEq(IPulseXRouter(PULSEX_V2).factory(), PULSEX_V2_FACTORY, "one factory, two callers");
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

    /// @dev A one-entry batch. `convertLps` walks two parallel lists and names a pair per index.
    function _batch(address token0, address token1)
        internal
        pure
        returns (address[] memory tokens0, address[] memory tokens1)
    {
        tokens0 = new address[](1);
        tokens1 = new address[](1);
        tokens0[0] = token0;
        tokens1[0] = token1;
    }

    /// @dev The reserve the guard divides. Pair reserves come back in token0/token1 order.
    function _reserveOf(address token, address other) internal view returns (uint256) {
        address pair = IPulseXFactory(PULSEX_V2_FACTORY).getPair(token, other);
        (uint112 reserve0, uint112 reserve1,) = IPulseXPair(pair).getReserves();
        return token == IPulseXPair(pair).token0() ? reserve0 : reserve1;
    }

    // ── A plain donated token ────────────────────────────────────────────────

    /**
     * @notice A plain ERC-20 sent to the buy-and-burn really is converted and burned, and the
     *         forwarder loses a share of it on the way.
     *
     * `convertLps` burns any LP it holds for the named pair, then converts the whole balance of
     * each named token. So a donation with no LP behind it is swept up all the same. The PLSX
     * that comes out is split three ways before the burn: the dev cut, the caller's bounty, and
     * the rest. This test measures the first split, because that is what a forward costs us.
     */
    function test_DonatedHexIsConvertedAndBurnedMinusTheDevCut() public {
        if (!_boot()) return;
        _assertLiveSettings();
        assertEq(BB.bridgeFor(HEX_), WPLS, "HEX hops through WPLS on its way to PLSX");

        // 100k HEX against a reserve of roughly 118M. The guard needs at least ten times the
        // donation in the pool, and this is four orders of magnitude clear of it.
        uint256 donation = 100_000e8;
        assertLe(donation * 10, _reserveOf(HEX_, WPLS), "the donation clears the slippage guard");

        // HEX keeps no delegate checkpoints, so `deal` gives a balance that really transfers.
        // The transfer below is the proof, and the assertion after it is the receipt.
        deal(HEX_, address(this), donation);
        uint256 sinkHexBefore = IERC20(HEX_).balanceOf(BUY_AND_BURN);
        IERC20(HEX_).transfer(BUY_AND_BURN, donation);
        assertEq(IERC20(HEX_).balanceOf(BUY_AND_BURN) - sinkHexBefore, donation, "the HEX arrived");

        uint256 supplyBefore = IERC20(PLSX).totalSupply();
        uint256 devBefore = IERC20(PLSX).balanceOf(DEV_ADDR);

        (address[] memory tokens0, address[] memory tokens1) = _batch(HEX_, WPLS);
        vm.prank(eoa, eoa); // two arguments, because `onlyEOA` reads `tx.origin`
        BB.convertLps(tokens0, tokens1);

        uint256 burned = supplyBefore - IERC20(PLSX).totalSupply();
        uint256 devGot = IERC20(PLSX).balanceOf(DEV_ADDR) - devBefore;
        uint256 bounty = IERC20(PLSX).balanceOf(eoa);
        uint256 produced = burned + devGot + bounty;

        emit log_named_uint("PLSX produced", produced);
        emit log_named_uint("PLSX to devAddr", devGot);
        emit log_named_uint("PLSX burned", burned);

        assertGt(burned, 0, "the burn is real: PLSX total supply falls");
        assertEq(IERC20(HEX_).balanceOf(BUY_AND_BURN), 0, "it swept the whole balance, not a fee");
        assertEq(IERC20(PLSX).balanceOf(BUY_AND_BURN), 0, "it kept no PLSX back");

        // The two words a future reader needs are in this message. Forwarding hands 14.29% of
        // every PLSX the conversion produces to an address that is not ours.
        assertApproxEqAbs(
            devGot,
            (produced * 1429) / WAD,
            2,
            "devAddr keeps 14.29% of every PLSX a forwarded token produces"
        );
        assertApproxEqAbs(
            bounty, ((produced - devGot) * 10) / WAD, 2, "the caller keeps 0.10% as a bounty"
        );
        assertLt(burned, produced, "the burn is not the whole of it");
    }

    // ── The real x402 wrapper ────────────────────────────────────────────────

    /**
     * @notice An x402-wrapped token sent to the buy-and-burn is stranded there for good.
     *
     * `convertLps` calls `_getValidPair` for every named pair and reverts before it converts
     * anything. x402-PLSX has no pool against WPLS and none against PLSX, so no caller can name
     * it: the whole batch reverts. A batch that leaves it out succeeds, and the wrapper balance
     * sits there untouched, because `_convertStep` only ever runs on a named token.
     *
     * Those two facts together say unreachable, not merely unconverted. Nothing can name it, and
     * nothing unnamed is converted. A pool against some third token would not help either. The
     * bridge for the wrapper is WPLS, and `_swap` reverts on the missing x402/WPLS pool. That is
     * why "never forward a wrapper" is a rule and not a preference.
     */
    function test_WrappedTokenIsStrandedInTheBuyAndBurn() public {
        if (!_boot()) return;
        _assertLiveSettings();

        assertEq(IWrappedToken(X402_PLSX).underlying(), PLSX, "x402PLSX wraps PLSX");
        assertEq(BB.bridgeFor(X402_PLSX), WPLS, "the wrapper's bridge is WPLS, like every default");
        IPulseXFactory factory = IPulseXFactory(PULSEX_V2_FACTORY);
        assertEq(factory.getPair(X402_PLSX, WPLS), address(0), "no x402/WPLS pool exists");
        assertEq(factory.getPair(X402_PLSX, PLSX), address(0), "no x402/PLSX pool exists");

        // Buy PLSX and wrap it, the way a payer produces the wrapper in the first place.
        _buyFor(address(this), PLSX, 1_000_000e18);
        uint256 amount = IERC20(PLSX).balanceOf(address(this));
        assertGt(amount, 0, "the PLSX pool paid out");

        IERC20(PLSX).approve(X402_PLSX, amount);
        IWrappedToken(X402_PLSX).wrap(amount);
        assertEq(IERC20(X402_PLSX).balanceOf(address(this)), amount, "wrapped 1:1");
        IERC20(X402_PLSX).transfer(BUY_AND_BURN, amount);
        assertEq(IERC20(X402_PLSX).balanceOf(BUY_AND_BURN), amount, "the wrapper arrived");

        // Name it, and the pair check kills the batch before any conversion runs.
        (address[] memory tokens0, address[] memory tokens1) = _batch(X402_PLSX, WPLS);
        vm.prank(eoa, eoa);
        vm.expectRevert(bytes("PLSXBuyAndBurn: Invalid pair"));
        BB.convertLps(tokens0, tokens1);

        // Leave it out, and the same call goes through on a pair that does exist.
        uint256 supplyBefore = IERC20(PLSX).totalSupply();
        (tokens0, tokens1) = _batch(HEX_, WPLS);
        vm.prank(eoa, eoa);
        BB.convertLps(tokens0, tokens1);

        assertLt(IERC20(PLSX).totalSupply(), supplyBefore, "the batch without it ran and burned");
        assertEq(
            IERC20(X402_PLSX).balanceOf(BUY_AND_BURN),
            amount,
            "the wrapper is still there, to the wei, and nothing can ever name it"
        );
    }
}
