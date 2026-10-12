// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ProveExecutor, IProveSettlementFill} from "../src/ProveExecutor.sol";
import {ISignatureTransfer} from "../src/interfaces/IPermit2.sol";
import {IPulseXFactory} from "../src/interfaces/IPulseXFactory.sol";
import {IPulseXPair} from "../src/interfaces/IPulseXPair.sol";
import {IPulseXRouter} from "../src/interfaces/IPulseXRouter.sol";
import {ANY_FEE} from "./Mocks.sol";
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
 * @notice The settlement against the tokens people actually hold on chain 369, rather than
 *         against mocks shaped to suit it.
 *
 *   PULSECHAIN_RPC=https://one.valve.city/rpc/evm/369 \
 *     FOUNDRY_PROFILE=fork forge test --match-path test/Fork369RealTokens.t.sol -vv
 *
 * Without PULSECHAIN_RPC every test skips, so plain `forge test` stays offline.
 *
 * ## What this file asks that the other four fork files do not
 *
 * Every one of them trades WPLS against PLSX. Both are eighteen decimals and both behave, so the
 * whole suite proves the settlement works on the easiest assets on the chain. Four things it has
 * never been held against are here:
 *
 *   HEX      eight decimals, and the widest-held token on 369. Nothing else in this repository
 *            carries that width, and a fee is a division — so eight decimals is where a rounding
 *            rule stops being theoretical.
 *   USDC     six decimals, bridged from Ethereum, and a 329-byte proxy rather than a token.
 *   USDT     six decimals, bridged, and an ordinary ERC-20 despite the name.
 *   Tether   the Ethereum USDT contract, which PulseChain forked whole. It returns NO data from
 *            `approve` and `transfer`, and it refuses to raise a live non-zero allowance. This is
 *            the shape `SafeERC20` exists for, and the shape the mocks imitate.
 *   WPLS     the wrapped native token. The solver values gas in it, so an intent it cannot price
 *            against WPLS is one the bot skips — `sdk/src/solver/price.ts` prices every token
 *            from that token's WPLS pool, and `gasCostNative` spends the same unit.
 *
 * `test/TokenMatrix.t.sol` crosses these widths with every custody rung on mocks, and its eight
 * decimal row exists because of this file. A mock proves our arithmetic; only the chain proves
 * the asset agrees with it.
 *
 * ## Two traps inherited from the fork suites, and one of this file's own
 *
 *   1. The fork is created inside each test, not in `setUp`. A fork taken in `setUp` and then
 *      snapshotted loses the lazy account fetch a delegatecall proxy needs, and both bridged
 *      stablecoins here are proxies.
 *   2. `evm_version = "paris"` on the default profile gives up PUSH0, so forge reads `0x5f` in
 *      somebody else's mainnet bytecode as an undefined opcode and the frame burns every
 *      remaining unit of gas. A billion-gas revert here is that pin, never these contracts.
 *      `FOUNDRY_PROFILE=fork` sets shanghai and states the measurement behind it.
 *   3. **A real token is not an `IERC20`.** `IERC20(Tether).transfer(...)` reverts in the CALLER,
 *      on a decode of a bool that was never returned — measured here before this file was
 *      written. So every approval below goes through a low-level call, the way a wallet sends
 *      one, and every claim about what the settlement does rests on `SafeERC20` doing it.
 *
 * The fork is taken at the head of 369 and never at a pin, so every price is the price now. No
 * assertion writes a rate down; the amounts are read from the pools at the moment of the test.
 */
contract Fork369RealTokensTest is Test {
    // ── Mainnet, as it is ────────────────────────────────────────────────────

    uint256 constant MAINNET = 369;

    /// @dev Permit2's canonical deterministic deployment, which is not ours and is the same
    ///      address on every chain that has it.
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address constant WPLS = 0xA1077a294dDE1B09bB078844df40758a5D0f9a27;
    /// @dev Eight decimals. `test/ForkBuyAndBurn.t.sol` already relies on `deal` working here.
    address constant HEX_ = 0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39;
    /// @dev "USDC from Ethereum", six decimals, behind a proxy.
    address constant USDC = 0x15D38573d2feeb82e7ad5187aB8c1D52810B1f07;
    /// @dev "USDT from Ethereum", six decimals, behind a proxy. An ordinary ERC-20 inside.
    address constant USDT = 0x0Cb6F5a34ad42ec934882A05265A7d5F59b51A2f;
    /// @dev The Ethereum Tether contract, forked whole onto 369 at its Ethereum address. This is
    ///      the one with the famous shape, and it is a different token from `USDT` above.
    address constant TETHER = 0xdAC17F958D2ee523a2206206994597C13D831ec7;

    address constant PULSEX_V2 = 0x165C3410fC91EF562C50559f7d2289fEbed552d9;
    address constant PULSEX_V2_FACTORY = 0x29eA7545DEf87022BAdc76323F373EA1e707C523;

    /// @dev One, in the unit a fee rate is counted in, and the rate every intent here signs.
    uint256 constant WAD = 1e18;
    uint64 constant FEE_RATE = 0.001e18;

    // ── The deployment under test ────────────────────────────────────────────

    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot, and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;

    address owner = address(0xB0B);
    /// @dev Where an unattributed token would go. No test here reaches it, and each asserts so.
    address proceeds = address(0x7EA);
    /// @dev An EOA solver holding inventory, which is how most real fills are paid.
    address solver = address(0xE0E);
    /// @dev A scratch fee destination, so every fee assertion is exact.
    address feeTo = address(0xFEE);

    address maker;
    uint256 makerKey;

    /// @dev The pair under test. State rather than arguments, for the reason `TokenMatrix.t.sol`
    ///      gives: a fork test frame is already as deep as the coverage build can carry.
    address tIn;
    address tOut;

    /// @dev One per intent, so no two intents in a test share a hash.
    uint256 caseNonce;

    string rpc;

    function setUp() public {
        rpc = vm.envOr("PULSECHAIN_RPC", string(""));
    }

    /**
     * @dev Fork mainnet and deploy a settlement on it. False when there is no RPC — and the test
     *      is marked SKIPPED, not passed.
     *
     * A skip that returned false and nothing else is how fourteen fork tests reported green while
     * asserting nothing at all. `vm.skip` is the difference between a suite honest about its
     * coverage and one that manufactures it.
     */
    function _boot() internal returns (bool) {
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }
        vm.createSelectFork(rpc); // the head, only to learn its number; see below
        vm.createSelectFork(rpc, block.number - 64); // 64 back: a head block reorged away on 2026-09-23
        assertEq(block.chainid, MAINNET, "these addresses mean these tokens only on 369");

        (maker, makerKey) = makeAddrAndKey("369 real-token maker");

        // The real Permit2, so the custody rung below is the deployed contract rather than a mock.
        settlement = newSettlement(PERMIT2);
        relayer = settlement.relayer();
        return true;
    }

    // ── The chain, before any of ours is on it ───────────────────────────────

    /**
     * @notice The widths this file is about are the chain's, not this file's.
     *
     * Every number below is read off mainnet rather than typed here, so a token that moved, a
     * bridge that redeployed or an address copied wrong fails this test rather than quietly
     * making every test after it meaningless.
     */
    function test_TheChainHoldsTheseTokensAtTheseWidths() public {
        if (!_boot()) return;

        assertEq(_decimalsOf(WPLS), 18, "WPLS is the wrapped native, at eighteen");
        assertEq(_decimalsOf(HEX_), 8, "HEX is eight, and no mock in this suite was until now");
        assertEq(_decimalsOf(USDC), 6, "bridged USDC is six");
        assertEq(_decimalsOf(USDT), 6, "bridged USDT is six");
        assertEq(_decimalsOf(TETHER), 6, "the forked Tether is six");

        // Both stablecoins are proxies, which is the reason the fork is taken inside each test.
        assertGt(USDC.code.length, 0, "bridged USDC has code");
        assertGt(USDT.code.length, 0, "bridged USDT has code");
        assertGt(TETHER.code.length, 0, "the forked Tether has code");

        // And each has a live pool against the wrapped native, which is what lets the solver
        // value it — and therefore what lets it decide a fill beats the gas.
        assertGt(_reserveOf(HEX_), 0, "HEX trades against WPLS today");
        assertGt(_reserveOf(USDC), 0, "bridged USDC trades against WPLS today");
        assertGt(_reserveOf(USDT), 0, "bridged USDT trades against WPLS today");
    }

    // ── Eight decimals ───────────────────────────────────────────────────────

    /**
     * @notice A maker sells HEX and both sides are exact to the unit.
     *
     * Eight decimals is the width this repository had never settled. The claim is small and it is
     * the one that matters: the maker parts with exactly the `amountIn` they signed, counted in
     * the token's own units, and the solver receives exactly that.
     */
    function test_HexSellsAtEightDecimalsAndBothSidesAreExact() public {
        if (!_boot()) return;
        tIn = HEX_;
        tOut = WPLS;

        uint256 amountIn = 1_000e8;
        deal(HEX_, maker, amountIn);
        _approve(HEX_, maker, relayer);
        _stockSolver(WPLS, 10_000_000e18);

        uint256 floor = (_market(HEX_, WPLS, amountIn) * 90) / 100;
        assertGt(floor, 0, "the pool prices HEX against WPLS right now");

        (uint256 delivered, uint256 fee) = _fill(_intentFor(amountIn, floor, 1), amountIn);

        assertEq(IERC20(HEX_).balanceOf(maker), 0, "the maker parted with every unit they signed");
        assertEq(IERC20(HEX_).balanceOf(solver), amountIn, "and the solver has them, to the unit");
        assertEq(
            IERC20(WPLS).balanceOf(maker), delivered, "the maker was paid the rate they signed"
        );
        assertEq(delivered + fee, floor, "the maker signed a gross and got it less the fee");
        assertEq(settlement.pendingFees(feeCfg(feeTo), WPLS), fee, "the fee was booked, not pushed");
    }

    /**
     * @notice A fee charged in an eight-decimal token is a whole number of units, and the dust of
     *         the split stays with the maker.
     *
     * `_quote` rounds the gross up and the fee down, so the two never sum to more than the maker
     * signed and the remainder of the division is the maker's. The rate here is one thousandth,
     * so the fee is `floor / 1000` — computed here rather than read back from the contract, since
     * a test that asks what it owes and then checks it paid that cannot fail.
     */
    function test_AFeeInHexIsWholeUnitsAndTheDustStaysWithTheMaker() public {
        if (!_boot()) return;
        tIn = WPLS;
        tOut = HEX_;

        uint256 amountIn = 1_000_000e18;
        deal(WPLS, maker, amountIn);
        _approve(WPLS, maker, relayer);
        _buyFor(solver, HEX_, 5_000_000e18);
        _approve(HEX_, solver, relayer);

        uint256 floor = (_market(WPLS, HEX_, amountIn) * 90) / 100;
        (uint256 delivered, uint256 fee) = _fill(_intentFor(amountIn, floor, 1), amountIn);

        assertEq(fee, floor / 1_000, "one thousandth of the gross, floored, in HEX units");
        assertEq(delivered, floor - fee, "and the maker keeps the remainder of that division");
        assertEq(IERC20(HEX_).balanceOf(maker), delivered, "which is what reached their wallet");

        // The book pays out in the asset it was charged in, which is the half a mock cannot show.
        assertEq(claimFor(settlement, feeTo, HEX_), fee, "the HEX fee claims out");
        assertEq(IERC20(HEX_).balanceOf(feeTo), fee, "to the destination, in full");
    }

    // ── Six decimals ─────────────────────────────────────────────────────────

    /**
     * @notice A bridged stablecoin funds an escrow, and the custody book is exact at six decimals.
     *
     * The escrow rung is the one that keeps a number of its own. `reserved` is credited with what
     * arrived rather than what was asked for, so a token whose units are a millionth rather than
     * a billionth of a billionth has to agree with that book to the unit both ways.
     */
    function test_BridgedUsdcFundsAnEscrowAndTheBookIsExactAtSixDecimals() public {
        if (!_boot()) return;
        tIn = USDC;
        tOut = WPLS;

        uint256 amountIn = 1_000e6;
        deal(USDC, maker, amountIn);
        _approve(USDC, maker, relayer);
        _stockSolver(WPLS, 200_000_000e18);

        uint256 floor = (_market(USDC, WPLS, amountIn) * 90) / 100;
        ProveSettlement.Intent memory i = _intentFor(amountIn, floor, settlement.FLAG_ESCROW() | 1);
        bytes32 h = settlement.hashIntent(i);

        vm.prank(maker);
        settlement.deposit(i, amountIn);
        assertEq(settlement.reserved(h), amountIn, "the book credits six-decimal units exactly");
        assertEq(IERC20(USDC).balanceOf(address(settlement)), amountIn, "and holds what it booked");

        (uint256 delivered,) = _fill(i, amountIn);

        assertEq(settlement.reserved(h), 0, "the reservation is spent");
        assertEq(IERC20(USDC).balanceOf(address(settlement)), 0, "and the contract holds nothing");
        assertEq(IERC20(USDC).balanceOf(solver), amountIn, "the solver was released the whole lot");
        assertEq(IERC20(WPLS).balanceOf(maker), delivered, "and the maker was paid");
    }

    /**
     * @notice **A gross under 1,000 units books no fee at all, and that is the contract working.**
     *
     * `_quote` floors the fee, so at one thousandth a gross of 999 units charges nothing and the
     * dust goes to the maker rather than to the destination they named. `_quote`'s own comment
     * states this rule and calls it the right direction for a protocol that earns nothing from a
     * fill. It is stated there and measured here, on a real six-decimal token.
     *
     * What decimals change is what that floor is WORTH. A thousand units of USDC is a tenth of a
     * cent, so a real payment can land under it; a thousand units of an eighteen-decimal token is
     * dust no one would ever send. This is the whole reason the width matters.
     */
    function test_ASixDecimalGrossUnderAThousandUnitsBooksNoFee() public {
        if (!_boot()) return;
        tIn = WPLS;
        tOut = USDC;

        // Enough WPLS to pay for both intents, priced well under the pool so a solver would fill.
        deal(WPLS, maker, 200e18);
        _approve(WPLS, maker, relayer);
        _buyFor(solver, USDC, 1_000_000e18);
        _approve(USDC, solver, relayer);

        (uint256 deliveredA, uint256 feeA) = _fill(_intentFor(100e18, 999, 1), 100e18);
        assertEq(feeA, 0, "999 units of USDC is under the floor, so nothing is charged");
        assertEq(deliveredA, 999, "and the whole gross reaches the maker");
        assertEq(
            settlement.pendingFees(feeCfg(feeTo), USDC), 0, "the destination's book did not move"
        );

        // One unit more, and the same rate charges exactly one unit. The floor is measured from
        // both sides, because a test that only sees zero cannot tell a floor from a broken fee.
        (uint256 deliveredB, uint256 feeB) = _fill(_intentFor(100e18, 1_000, 1), 100e18);
        assertEq(feeB, 1, "a gross of 1,000 units charges the first whole unit");
        assertEq(deliveredB, 999, "and the maker is paid the rest");
        assertEq(settlement.pendingFees(feeCfg(feeTo), USDC), 1, "which is what the book now holds");
    }

    /**
     * @notice A bridged stablecoin on the rung a settlement redeploy cannot orphan.
     *
     * The maker approves the real Permit2 and grants this deployment nothing, and the reservation
     * that the signature funds is counted in six-decimal units. `Fork369Rehearsal.t.sol` runs
     * this rung against WPLS; the width is what is new here, and it is the width the payment
     * tokens on this chain actually use.
     */
    function test_TheRealPermit2CarriesASixDecimalReservation() public {
        if (!_boot()) return;
        tIn = USDT;
        tOut = WPLS;

        uint256 amountIn = 1_000e6;
        deal(USDT, maker, amountIn);
        _approve(USDT, maker, PERMIT2);
        _stockSolver(WPLS, 200_000_000e18);

        uint256 floor = (_market(USDT, WPLS, amountIn) * 90) / 100;
        ProveSettlement.Intent memory i = _intentFor(amountIn, floor, settlement.FLAG_PERMIT2() | 1);
        uint256 nonce = uint256(settlement.hashIntent(i));
        (uint256 delivered, uint256 fee) = _quote(i, amountIn);

        // Both built before the prank: `vm.prank` is single-shot, and each of these makes an
        // external call of its own that would eat it.
        bytes memory sig = _sign(i);
        ProveSettlement.Permit2Transfer memory p =
            _permit2Transfer(USDT, amountIn, nonce, block.timestamp + 1 days);

        vm.prank(solver);
        settlement.fillWithPermit2(i, sig, amountIn, p, ANY_FEE);

        assertEq(IERC20(USDT).balanceOf(solver), amountIn, "the solver got every six-decimal unit");
        assertEq(IERC20(WPLS).balanceOf(maker), delivered, "the maker was paid the signed rate");
        assertEq(delivered + fee, floor, "gross less fee, as at every other width");
        assertEq(IERC20(USDT).allowance(maker, relayer), 0, "the maker granted the relayer nothing");
        assertTrue(
            ISignatureTransfer(PERMIT2).nonceBitmap(maker, nonce >> 8) & (1 << (nonce & 0xff)) != 0,
            "the real Permit2 spent the maker's nonce"
        );
    }

    // ── The token that returns nothing ───────────────────────────────────────

    /**
     * @notice The forked Tether's two famous refusals, measured on 369 rather than remembered.
     *
     * It answers `approve` and `transfer` with an EMPTY return buffer, so a caller that decodes a
     * bool reverts on the decode with the transfer already done. And it refuses to raise a live
     * non-zero allowance, so a maker topping one up must set it to zero first.
     *
     * Both are the reason `ProveRelayer.pull`, `ProveSettlement._deliverTo` and
     * `ProveCallSink.run` go through `SafeERC20` and `forceApprove` rather than through a plain
     * `IERC20`. This test is what says those two facts are still true of the chain, rather than
     * of a mock built to imitate it.
     */
    function test_TheForkedTetherReturnsNothingAndRefusesToRaiseALiveAllowance() public {
        if (!_boot()) return;
        address spender = makeAddr("some spender");

        vm.prank(maker);
        (bool granted, bytes memory ret) =
            TETHER.call(abi.encodeCall(IERC20.approve, (spender, 100)));
        assertTrue(granted, "a first approval, from zero, is accepted");
        assertEq(ret.length, 0, "and it answers with no return data at all");

        // The raise every eighteen-decimal token allows, refused.
        vm.prank(maker);
        (bool raised,) = TETHER.call(abi.encodeCall(IERC20.approve, (spender, 200)));
        assertFalse(raised, "a raise over a live non-zero allowance is refused by the token");
        assertEq(IERC20(TETHER).allowance(maker, spender), 100, "so the old allowance still stands");

        // Zero first, then the new figure. This is what `forceApprove` does, and what a maker's
        // wallet has to do by hand.
        vm.prank(maker);
        (bool zeroed,) = TETHER.call(abi.encodeCall(IERC20.approve, (spender, 0)));
        assertTrue(zeroed, "clearing it is always allowed");
        vm.prank(maker);
        (bool again,) = TETHER.call(abi.encodeCall(IERC20.approve, (spender, 200)));
        assertTrue(again, "and the raise lands once the allowance is zero");
        assertEq(IERC20(TETHER).allowance(maker, spender), 200, "at the figure the maker meant");
    }

    /// @notice A maker sells the forked Tether. Every leg of the fill moves a token that answers
    ///         `transfer` with nothing, and `SafeERC20` is the whole reason it settles.
    function test_TheForkedTetherSellsThroughTheApprovalRung() public {
        if (!_boot()) return;
        tIn = TETHER;
        tOut = WPLS;

        uint256 amountIn = 1_000e6;
        deal(TETHER, maker, amountIn);
        _approve(TETHER, maker, relayer);
        _stockSolver(WPLS, 10_000_000e18);

        (uint256 delivered, uint256 fee) = _fill(_intentFor(amountIn, 1_000e18, 1), amountIn);

        assertEq(IERC20(TETHER).balanceOf(maker), 0, "the maker parted with the whole balance");
        assertEq(IERC20(TETHER).balanceOf(solver), amountIn, "and the solver holds it");
        assertEq(IERC20(WPLS).balanceOf(maker), delivered, "the maker was paid");
        assertEq(delivered + fee, 1_000e18, "the split is the same at this width and this shape");
    }

    /**
     * @notice The forked Tether on the DELIVERY leg, where the settlement measures rather than
     *         trusts.
     *
     * `_deliverTo` brackets the payment with a `balanceOf` read of the recipient and refuses the
     * fill unless the balance really rose by the amount owed. A token that returns nothing tells
     * it nothing, so the bracket is the only thing that knows the payment happened — and the fee
     * booked in that token has to claim out through `safeTransfer` as well.
     */
    function test_TheForkedTetherIsDeliveredAndItsFeeClaimsOut() public {
        if (!_boot()) return;
        tIn = WPLS;
        tOut = TETHER;

        uint256 amountIn = 1_000_000e18;
        deal(WPLS, maker, amountIn);
        _approve(WPLS, maker, relayer);
        deal(TETHER, solver, 10_000e6);
        _approve(TETHER, solver, relayer);

        (uint256 delivered, uint256 fee) = _fill(_intentFor(amountIn, 1_000e6, 1), amountIn);
        assertGt(fee, 0, "there is a fee to book");

        assertEq(IERC20(TETHER).balanceOf(maker), delivered, "the maker was paid in Tether");
        assertEq(delivered + fee, 1_000e6, "gross less fee, in six-decimal units");
        assertEq(claimFor(settlement, feeTo, TETHER), fee, "and the fee claims out of the book");
        assertEq(IERC20(TETHER).balanceOf(feeTo), fee, "to the destination, in full");
        assertEq(IERC20(TETHER).balanceOf(address(settlement)), 0, "nothing rests in the contract");
    }

    // ── The wrapped native token ─────────────────────────────────────────────

    /**
     * @notice WPLS is the unit the solver prices gas in, and every token in this file can be
     *         valued in it.
     *
     * `sdk/src/solver/price.ts` builds its price book from each token's own WPLS pool, as a
     * marginal reserve ratio, and `gasCostNative` is a product in the same unit. An intent whose
     * `tokenOut` nothing can price against WPLS is one the bot logs and skips. So "the pool
     * exists and both reserves are non-zero" is not trivia — it is the precondition for the
     * executor being able to tell a profitable fill from a loss.
     *
     * The wrapper itself is checked at par in both directions, because that identity is what
     * makes the native currency and WPLS one unit rather than two.
     */
    function test_WplsIsTheUnitTheSolverPricesGasIn() public {
        if (!_boot()) return;

        // WETH9's two entry points, at par, on the real contract.
        vm.deal(address(this), 3e18);
        IWrappedNative(WPLS).deposit{value: 1e18}();
        assertEq(IERC20(WPLS).balanceOf(address(this)), 1e18, "one PLS wrapped to one WPLS");
        IWrappedNative(WPLS).withdraw(1e18);
        assertEq(IERC20(WPLS).balanceOf(address(this)), 0, "and unwrapped back at par");

        // The ratio the price book is built from, for every token this file settles.
        assertGt(_reserveOf(HEX_), 0, "HEX has a WPLS side to price against");
        assertGt(_reserveOf(USDC), 0, "bridged USDC has one");
        assertGt(_reserveOf(USDT), 0, "bridged USDT has one");
        assertGt(
            _market(WPLS, HEX_, 1e24), 0, "and a live quote comes back for the eight-decimal one"
        );
    }

    /**
     * @notice The whole product in one transaction, paying an eight-decimal token out of a real
     *         PulseX swap: a maker signs, a caller holding nothing fills, and the spread is theirs.
     *
     * The executor path is where a width error would hide best. It releases the maker's WPLS,
     * sells it at the pool, and pays the maker in HEX — three different token movements, two of
     * them in eight-decimal units, and an approval to the router in between.
     */
    function test_AnExecutorFillPaysEightDecimalsOutOfRealPulseX() public {
        if (!_boot()) return;
        tIn = WPLS;
        tOut = HEX_;
        ProveExecutor executor = new ProveExecutor(address(settlement));

        uint256 amountIn = 1_000_000e18;
        uint256 floor = (_market(WPLS, HEX_, amountIn) * 90) / 100;
        assertGt(floor, 0, "the pool prices this pair right now");

        deal(WPLS, maker, amountIn);
        _approve(WPLS, maker, relayer);

        ProveSettlement.Intent memory i = _intentFor(amountIn, floor, 1);
        bytes memory sig = _sign(i);
        (uint256 delivered, uint256 fee) = _quote(i, amountIn);

        // This caller's own sink clone, which every fill mints. Aiming the swap at the TEMPLATE
        // pays an address that never sweeps; the proceeds go to the executor, which sweeps its
        // own increase. `Fork369Rehearsal.t.sol` measured both ways round.
        address sink = Clones.predictDeterministicAddress(
            address(executor.sinkTemplate()),
            bytes32(uint256(uint160(address(this)))),
            address(executor)
        );

        executor.fill(_asExec(i), sig, amountIn, ANY_FEE, _pulseXSwap(amountIn, address(executor)));

        assertEq(IERC20(HEX_).balanceOf(maker), delivered, "the maker was paid HEX from the pool");
        assertEq(delivered + fee, floor, "the maker signed a gross and got it less the fee");
        assertEq(
            settlement.pendingFees(feeCfg(feeTo), HEX_), fee, "the fee reached the intent's feeTo"
        );
        assertGt(IERC20(HEX_).balanceOf(address(this)), 0, "the spread went to the caller");

        // Neither address holds anything between transactions, at this width as at any other.
        assertEq(IERC20(HEX_).balanceOf(address(executor)), 0, "the executor kept nothing");
        assertEq(IERC20(HEX_).balanceOf(sink), 0, "the call sink kept nothing");
        assertEq(IERC20(WPLS).balanceOf(sink), 0, "and nothing of token A either");
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /**
     * @dev The token's own answer to `decimals()`, read as a word.
     *
     * Not `IERC20Metadata`. The forked Tether declares `uint public decimals`, so it returns a
     * full word where a modern token returns a `uint8`, and both are the same 32 bytes on the
     * wire. Decoding as `uint256` reads either; decoding as `uint8` is a decision about which
     * token shape is allowed to answer.
     */
    function _decimalsOf(address token) internal view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        assertTrue(ok, "the token answers decimals()");
        return abi.decode(ret, (uint256));
    }

    /// @dev This token's side of its PulseX v2 pool against WPLS. Reserves come back in
    ///      token0/token1 order, so the pair decides which of the two this is.
    function _reserveOf(address token) internal view returns (uint256) {
        address pair = IPulseXFactory(PULSEX_V2_FACTORY).getPair(token, WPLS);
        if (pair == address(0)) return 0;
        (uint112 reserve0, uint112 reserve1,) = IPulseXPair(pair).getReserves();
        return token == IPulseXPair(pair).token0() ? reserve0 : reserve1;
    }

    /**
     * @dev Grant an allowance the way a wallet does: a low-level call, with nothing decoded.
     *
     * `IERC20(token).approve(...)` cannot be used here. The forked Tether answers with an empty
     * buffer and the caller reverts on the decode — measured on chain before this file was
     * written, and the reason every rung the settlement uses goes through `SafeERC20`.
     */
    function _approve(address token, address from, address spender) internal {
        vm.prank(from);
        (bool ok,) = token.call(abi.encodeCall(IERC20.approve, (spender, type(uint256).max)));
        assertTrue(ok, "the token accepted the maker's approval");
    }

    /// @dev Give the solver inventory it did not have to buy, and let the relayer spend it.
    function _stockSolver(address token, uint256 amount) internal {
        deal(token, solver, amount);
        _approve(token, solver, relayer);
    }

    /// @dev Buy a token with real liquidity, the way a solver stocks up.
    function _buyFor(address to, address token, uint256 wplsIn) internal {
        deal(WPLS, address(this), wplsIn);
        IERC20(WPLS).approve(PULSEX_V2, wplsIn);
        address[] memory path = new address[](2);
        path[0] = WPLS;
        path[1] = token;
        IPulseXRouter(PULSEX_V2).swapExactTokensForTokens(wplsIn, 0, path, to, block.timestamp);
    }

    /// @dev What the pool pays for `amountIn` of `from` right now. Nothing here writes a rate down.
    function _market(address from, address to, uint256 amountIn) internal view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = from;
        path[1] = to;
        return IPulseXRouter(PULSEX_V2).getAmountsOut(amountIn, path)[1];
    }

    /**
     * @dev Sign the intent, quote it, and have the solver fill the whole of it.
     *
     * Its own frame on purpose. `forge coverage` compiles with `--ir-minimum`, and a test that
     * held the intent, the signature, the quote and three balances at once ran out of stack at
     * the fill — "too deep in the stack by 1 slots". `Fork369Rehearsal.t.sol` records the same
     * measurement against `_quote`.
     */
    function _fill(ProveSettlement.Intent memory i, uint256 take)
        internal
        returns (uint256 delivered, uint256 fee)
    {
        bytes memory sig = _sign(i);
        (delivered, fee) = _quote(i, take);
        vm.prank(solver);
        settlement.fill(i, sig, take, ANY_FEE);
    }

    /// @dev What the settlement says the maker receives, and what it books as the fee. In its own
    ///      frame for the stack reason `_fill` states.
    function _quote(ProveSettlement.Intent memory i, uint256 take)
        internal
        view
        returns (uint256 delivered, uint256 fee)
    {
        TakePoints.Quote memory q_4 = settlement.quote(i, take, block.timestamp);
        delivered = q_4.delivered;
        fee = q_4.feeProceeds;
    }

    /// @dev A flat intent over the pair in `tIn`/`tOut`. Flat, so `gross` is `minOut` exactly when
    ///      the take is the whole `amountIn`, and every fee assertion is about the rate alone.
    function _intentFor(uint256 amountIn, uint256 minOut, uint8 flags)
        internal
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: tIn,
            tokenOut: tOut,
            amountIn: amountIn,
            minOutStart: minOut,
            minOutEnd: minOut,
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

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /**
     * @dev One Permit2 SignatureTransfer of the maker's, signed for the relayer as spender and
     *      against the live contract's own domain.
     *
     * Permit2's domain carries no version string, and the spender is not a field of the permit —
     * Permit2 hashes `msg.sender` in, so this signature names the relayer because the relayer is
     * the only address that will ever present it. The type hashes are the strings from Uniswap's
     * `SignatureTransfer.sol`, computed here because the deployed contract keeps both private.
     */
    function _permit2Transfer(address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (ProveSettlement.Permit2Transfer memory p)
    {
        p.token = token;
        p.amount = amount;
        p.nonce = nonce;
        p.deadline = deadline;

        bytes32 tokenPermissions = keccak256(
            abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), token, amount)
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                ISignatureTransfer(PERMIT2).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256(
                            "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
                        ),
                        tokenPermissions,
                        relayer,
                        nonce,
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, digest);
        p.signature = abi.encodePacked(r, s, v);
    }

    /// @dev Sell the released token A for token B at PulseX, paid to `to`. The caller writes this
    ///      blob off chain; `sdk/src/solver/abi.ts` builds the same bytes for the bot.
    function _pulseXSwap(uint256 amountIn, address to)
        internal
        view
        returns (ProveExecutor.Swap memory)
    {
        address[] memory path = new address[](2);
        path[0] = tIn;
        path[1] = tOut;
        return ProveExecutor.Swap({
            spender: PULSEX_V2,
            target: PULSEX_V2,
            data: abi.encodeCall(
                IPulseXRouter.swapExactTokensForTokens, (amountIn, 0, path, to, block.timestamp)
            ),
            extra: new address[](0)
        });
    }

    /// @dev The executor's copy of the struct. The two must stay field-for-field, and a fill
    ///      through the deployed pair is what proves they still are.
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

    /// @dev This contract takes the native currency back from `withdraw`.
    receive() external payable {}
}

/// @notice WETH9's two entry points, which is what WPLS is. Declared here rather than in `src/`,
///         because no contract this repository deploys touches the native currency at all.
interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}
