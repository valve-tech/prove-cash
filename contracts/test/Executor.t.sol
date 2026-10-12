// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IProveCallback} from "../src/interfaces/IProveCallback.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ProveExecutor, IProveSettlementFill} from "../src/ProveExecutor.sol";
import {ProveCallSink} from "../src/ProveCallSink.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MockERC20, MockRouter, NO_PERMIT2} from "./Mocks.sol";
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
 * @notice The public periphery: fill with no inventory, from any venue.
 *
 *   forge test --match-path test/Executor.t.sol -vv
 *
 * `ProveExecutor` takes a call target and a calldata blob from whoever calls it. That is the
 * shape that cost Transit Swap $23M and CoW Protocol $166k, so most of this file is about what
 * the arbitrary call cannot reach rather than about the trade working.
 *
 * The one thing that makes it admissible is that this contract has no standing authority and
 * holds nothing. Every test here is a way of asking whether that is still true.
 */
/// @notice A venue that writes down who called it, and pays whoever the caller names.
///
/// @dev The security design says the caller is a sink clone and never the executor. This is how
///      a test asks, because a `create` address on its own proves nothing to a reader.
contract SinkProbe {
    address public lastCaller;
    MockERC20 public immutable tokenIn;
    MockERC20 public immutable tokenOut;

    constructor(MockERC20 _in, MockERC20 _out) {
        tokenIn = _in;
        tokenOut = _out;
    }

    function sell(uint256 amountIn, address to) external {
        lastCaller = msg.sender;
        tokenIn.transferFrom(msg.sender, address(this), amountIn);
        tokenOut.transfer(to, amountIn * 2);
    }
}

/**
 * @notice A venue that turns round and calls the executor again, mid-swap.
 *
 * The arbitrary call means the caller chooses who runs inside the callback, so the caller can
 * choose themselves. Nothing here is holding tokens at that moment except the maker's released
 * token A, which is exactly what a second entry would try to spend twice.
 */
contract ReentrantVenue {
    ProveExecutor immutable exec;
    IProveSettlementFill.Intent intent;
    bytes signature;

    constructor(ProveExecutor _exec) {
        exec = _exec;
    }

    function arm(IProveSettlementFill.Intent calldata i, bytes calldata sig) external {
        intent = i;
        signature = sig;
    }

    /// @dev Any selector lands here, so the executor's `swap.data` can be anything at all.
    fallback() external {
        ProveExecutor.Swap memory nothing = ProveExecutor.Swap({
            spender: address(this), target: address(this), data: "", extra: new address[](0)
        });
        exec.fill(intent, signature, 1e18, type(uint256).max, nothing);
    }
}

/**
 * @notice A venue that spends its whole allowance, not the amount it was asked to sell.
 *
 * Real routers pull the number in their own calldata, so they cannot show what the approval is
 * worth. This one can. It pays out for the sale it was asked for and keeps the rest, which is
 * what any venue could do with an approval wider than the fill.
 */
contract GreedyVenue {
    MockERC20 public immutable tokenIn;
    MockERC20 public immutable tokenOut;

    constructor(MockERC20 _in, MockERC20 _out) {
        tokenIn = _in;
        tokenOut = _out;
    }

    function sell(uint256 amountIn, address to) external {
        uint256 allowed = tokenIn.allowance(msg.sender, address(this));
        tokenIn.transferFrom(msg.sender, address(this), allowed);
        tokenOut.transfer(to, amountIn * 2);
    }
}

/**
 * @notice A venue that pays without pulling, so it needs no allowance at all.
 *
 * Every other venue in this file calls `transferFrom`, which makes a missing allowance a second
 * fault. A test that aims the sink's approval at a forbidden address and then watches for any
 * revert cannot tell the guard from the missing allowance — remove the guard and the venue still
 * reverts, for the wrong reason, and the test still passes.
 *
 * This one hands over `tokenOut` and asks for nothing. A fill through it either completes or was
 * refused by the sink, and there is no third answer.
 */
contract GiftVenue {
    MockERC20 public immutable tokenOut;

    constructor(MockERC20 _out) {
        tokenOut = _out;
    }

    /// @dev Paid to whoever called, which is the sink clone.
    function pay(uint256 amount) external {
        tokenOut.transfer(msg.sender, amount);
    }
}

/**
 * @notice A share token: a plain ERC-20 to `approve`, with a second way to spend that allowance.
 *
 * `redeem(shares, receiver, owner)` moves the owner's shares without the word `transferFrom`
 * appearing anywhere. It is the counter-example that killed the selector denylist.
 */
contract MockVault is MockERC20 {
    MockERC20 public immutable asset;

    constructor(address _asset) MockERC20("Vault", "vB", 18) {
        asset = MockERC20(_asset);
    }

    function mintShares(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function redeem(uint256 shares, address receiver, address owner) external returns (uint256) {
        if (owner != msg.sender) _spendAllowance(owner, msg.sender, shares);
        _burn(owner, shares);
        asset.transfer(receiver, shares);
        return shares;
    }
}

/// @notice One hop, so a call that `_forbidden` would refuse arrives from somewhere else.
contract Hop {
    function relay(address target, bytes calldata data) external {
        (bool ok, bytes memory reason) = target.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(reason, 0x20), mload(reason))
            }
        }
    }
}

/// @notice Reverts with 60kB of reason, to see whether the caller pays for copying it.
contract Screamer {
    function scream() external pure {
        bytes memory huge = new bytes(60_000);
        assembly ("memory-safe") {
            revert(add(huge, 0x20), mload(huge))
        }
    }

    /**
     * @notice Reverts with `n` bytes of reason, none of them zero.
     *
     * `scream` answers with zeros, so a clip that copied the wrong window, or copied nothing at
     * all, would look exactly like a clip that worked. Here every byte is a function of its own
     * position, so the bytes that come back name where they were taken from.
     */
    function screamPattern(uint256 n) external pure {
        bytes memory reason = pattern(n);
        assembly ("memory-safe") {
            revert(add(reason, 0x20), mload(reason))
        }
    }

    /**
     * @dev The reason `screamPattern` sends, so a test compares against one definition of it.
     *
     * The period is 251 rather than 256, so byte 0 and byte 256 differ. A clip that took the
     * back of the reason instead of the front would otherwise be indistinguishable.
     */
    function pattern(uint256 n) public pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 k = 0; k < n; k++) {
            out[k] = bytes1(uint8(1 + (k % 251)));
        }
    }
}

/// @notice Has code and answers `relayer()`, but with nothing. A wrong address, not a typo.
contract HollowSettlement {
    function relayer() external pure returns (address) {
        return address(0);
    }
}

contract ExecutorTest is Test {
    /// @dev The test needs it for the same reason the sink does: one fixture below
    ///      answers an `approve` with nothing, and a plain one reverts decoding that.
    using SafeERC20 for IERC20;

    ProveSettlement settlement;
    ProveExecutor exec;
    MockRouter venue;
    MockERC20 tokenA;
    MockERC20 tokenB;

    /// @dev Read once. `vm.prank` is single-shot, so `settlement.relayer()` on the pranked line
    ///      eats the prank and the approval comes from the test contract instead.
    address relayer;

    address sink = address(0x5152);
    address caller = address(0xCA11);
    address maker;
    uint256 makerKey;

    uint256 constant AMOUNT_IN = 100e18;
    uint256 constant MIN_OUT = 150e18; // the venue pays 2:1, so there is a spread
    /// @dev What the maker keeps out of a gross of `MIN_OUT` at the fixture's ten basis points.
    ///      The fee comes out of the number the maker signed, so `MIN_OUT` is the caller's outlay
    ///      and this is the maker's receipt.
    uint256 constant NET_OUT = MIN_OUT - (MIN_OUT * 0.001e18) / 1e18;
    uint256 constant ANY_FEE = type(uint256).max;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        exec = new ProveExecutor(address(settlement));
        relayer = settlement.relayer();

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        venue = new MockRouter();

        tokenA.mint(maker, 1_000e18);
        tokenB.mint(address(venue), 1_000_000e18);

        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    function _intent() internal view returns (IProveSettlementFill.Intent memory i) {
        i = IProveSettlementFill.Intent({
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

    /// @dev The same intent in the settlement's own type, for hashing and signing.
    function _asSettlement(IProveSettlementFill.Intent memory i)
        internal
        pure
        returns (ProveSettlement.Intent memory o)
    {
        o = ProveSettlement.Intent({
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
            minFill: 0,
            authNonce: bytes32(0),
            flags: i.flags,
            nonce: i.nonce,
            curve: i.curve
        });
    }

    function _sign(IProveSettlementFill.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(_asSettlement(i)));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Sell the whole released amount at the venue, back to this contract.
    function _swap(uint256 amountIn) internal view returns (ProveExecutor.Swap memory) {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        return ProveExecutor.Swap({
            spender: address(venue),
            target: address(venue),
            data: abi.encodeCall(
                MockRouter.swapExactTokensForTokens,
                (amountIn, 0, path, address(exec), block.timestamp)
            ),
            extra: new address[](0)
        });
    }

    /// @dev The same sale as `_swap`, paid to an address the caller names rather than home.
    function _swapTo(uint256 amountIn, address to)
        internal
        view
        returns (ProveExecutor.Swap memory)
    {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        return ProveExecutor.Swap({
            spender: address(venue),
            target: address(venue),
            data: abi.encodeCall(
                MockRouter.swapExactTokensForTokens, (amountIn, 0, path, to, block.timestamp)
            ),
            extra: new address[](0)
        });
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

    // ── It does the trade ────────────────────────────────────────────────────

    /**
     * @notice The whole point: an address holding nothing fills an intent and keeps the spread.
     *
     * The caller starts with no token A and no token B. The maker's own tokens fund the trade
     * inside the transaction, and the caller ends up with what the venue paid above the maker's
     * signed floor and the protocol fee.
     */
    function test_ACallerWithNoInventoryFillsAnIntentAndKeepsTheSpread() public {
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        assertEq(tokenA.balanceOf(caller), 0, "the caller holds no token A");
        assertEq(tokenB.balanceOf(caller), 0, "and no token B");

        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, _swap(AMOUNT_IN));

        // The venue paid 2:1 on 100, the maker signed for 150, and the fee is ten basis points of
        // 150. Whatever is left is the caller's.
        assertEq(tokenB.balanceOf(maker), NET_OUT, "the maker got exactly the signed rate");
        assertGt(tokenB.balanceOf(caller), 0, "and the caller kept the difference");
        assertEq(tokenA.balanceOf(address(exec)), 0, "nothing rests in the executor");
        assertEq(tokenB.balanceOf(address(exec)), 0, "in either token");
    }

    /// @notice The fee reaches the sink, so a buyback is funded wherever the liquidity came from.
    function test_TheProtocolFeeIsPaidWhateverVenueTheCallerUsed() public {
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, _swap(AMOUNT_IN));

        assertGt(settlement.pendingFees(feeCfg(sink), address(tokenB)), 0, "the sink was paid");
    }

    /// @notice A partial fill sells only what was released.
    function test_APartialFillOnlySellsWhatItWasGiven() public {
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN / 4, ANY_FEE, _swap(AMOUNT_IN / 4));

        assertEq(tokenA.balanceOf(maker), 1_000e18 - AMOUNT_IN / 4, "a quarter left the maker");
        assertEq(tokenA.balanceOf(address(exec)), 0, "and none of it stayed here");
    }

    // ── What the arbitrary call cannot reach ─────────────────────────────────

    /**
     * @notice The call may not be aimed at the relayer, which holds every allowance.
     *
     * The relayer would refuse anyway — `pull` checks that its caller is the settlement — but the
     * rule is stated and enforced here too, because the next version of the relayer might not.
     */
    function test_TheCallCanNeverBeAimedAtTheRelayer() public {
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory bad = _swap(AMOUNT_IN);
        bad.target = relayer;

        vm.prank(caller);
        vm.expectRevert(ProveExecutor.ForbiddenTarget.selector);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, bad);

        // And not through the approval either.
        bad = _swap(AMOUNT_IN);
        bad.spender = relayer;
        vm.prank(caller);
        vm.expectRevert(ProveExecutor.ForbiddenTarget.selector);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, bad);
    }

    /// @notice Nor at the settlement, whose reentrancy guard is the only other thing in the way.
    function test_TheCallCanNeverBeAimedAtTheSettlement() public {
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory bad = _swap(AMOUNT_IN);
        bad.target = address(settlement);

        vm.prank(caller);
        vm.expectRevert(ProveExecutor.ForbiddenTarget.selector);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, bad);
    }

    /**
     * @notice The attack this shape invites, and the split that closes it by construction.
     *
     * Somebody approves `ProveExecutor` — out of habit, or because a phishing page said to, or
     * because they approved the settlement once and assumed. An attacker then points a swap at
     * the token and says `transferFrom(victim, me, everything)`. That is Transit Swap.
     *
     * It fails because the call does not run here. `ProveCallSink` makes it, and the victim never
     * approved the sink. Filtering the selector was the first attempt and it was wrong: an
     * allowance can be spent through ERC-4626 `redeem` too, which the second half of this test
     * shows, and through Permit2, ERC-777, ERC-1155 and a `multicall` wrapping any of them. That
     * set is open, so it had to be closed by construction rather than by list.
     */
    function test_AStandingApprovalToTheExecutorIsUnreachableByAnyCaller() public {
        address victim = makeAddr("victim");
        address attacker = makeAddr("attacker");
        tokenA.mint(victim, 500e18);
        vm.prank(victim);
        tokenA.approve(address(exec), type(uint256).max);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory theft = ProveExecutor.Swap({
            spender: address(venue),
            target: address(tokenA),
            data: abi.encodeCall(IERC20.transferFrom, (victim, attacker, 500e18)),
            extra: new address[](0)
        });

        vm.prank(attacker);
        vm.expectRevert();
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, theft);

        assertEq(tokenA.balanceOf(victim), 500e18, "the victim keeps everything");
        assertEq(tokenA.balanceOf(attacker), 0, "and the attacker gets nothing");
    }

    /**
     * @notice The same, through a selector no denylist would have carried.
     *
     * A share token is a plain ERC-20 to `approve`, and `redeem(shares, receiver, owner)` spends
     * the allowance without ever saying `transferFrom`. This is the case that proved a selector
     * filter could not be the answer.
     */
    function test_AnAllowanceCannotBeSpentThroughAFourSixTwoSixRedeemEither() public {
        address victim = makeAddr("victim");
        address attacker = makeAddr("attacker");
        MockVault vault = new MockVault(address(tokenB));
        tokenB.mint(address(vault), 1_000e18);
        vault.mintShares(victim, 1_000e18);

        vm.prank(victim);
        vault.approve(address(exec), type(uint256).max);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory theft = ProveExecutor.Swap({
            spender: address(venue),
            target: address(vault),
            data: abi.encodeCall(MockVault.redeem, (1_000e18, attacker, victim)),
            extra: new address[](0)
        });

        vm.prank(attacker);
        vm.expectRevert();
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, theft);

        assertEq(vault.balanceOf(victim), 1_000e18, "the victim keeps their shares");
        assertEq(tokenB.balanceOf(attacker), 0, "and the attacker got no assets");
    }

    /**
     * @notice An `approve` written by the caller's own calldata lands on the sink, not here.
     *
     * The arbitrary call can always write a permanent approval out of whoever makes it — that is
     * inherent. What matters is whose. The sink is empty between transactions and nothing is ever
     * left there, so the claim is on nothing; the executor, which people might actually approve,
     * grants nothing it did not intend.
     */
    function test_ACallerCannotLeaveAStandingApprovalOnTheExecutor() public {
        address attacker = makeAddr("attacker");
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory grab = ProveExecutor.Swap({
            spender: address(venue),
            target: address(tokenB),
            data: abi.encodeCall(IERC20.approve, (attacker, type(uint256).max)),
            extra: new address[](0)
        });

        vm.prank(caller);
        vm.expectRevert(); // the venue was approved but never traded, so the pull comes up short
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, grab);

        assertEq(tokenB.allowance(address(exec), attacker), 0, "nothing granted from the executor");
        assertEq(tokenA.allowance(address(exec), attacker), 0, "in either token");
    }

    /**
     * @notice A balance donated to this contract is not a way to pay for a fill.
     *
     * `ProveSettlement` pulls rather than measures, so that a donation cannot discharge a debt.
     * It pulls from here — so if this contract swept its whole balance, a donation sitting in it
     * would pay the maker and the attacker would keep the rest. Snapshotting spends nobody's
     * guarantee: a fill has to end with at least what it started with.
     */
    function test_ADonatedBalanceCannotPayForAFillAndCannotBeSweptAway() public {
        address attacker = makeAddr("attacker");
        tokenB.mint(address(exec), 500e18); // a misrouted aggregator output, say

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        // A swap that does nothing at all: an empty call to a codeless address returns success.
        ProveExecutor.Swap memory nothing = ProveExecutor.Swap({
            spender: address(venue), target: address(0xDEAD), data: "", extra: new address[](0)
        });

        vm.prank(attacker);
        vm.expectRevert(ProveExecutor.BalanceWentDown.selector);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, nothing);

        assertEq(tokenB.balanceOf(address(exec)), 500e18, "the donation is still there");
        assertEq(tokenB.balanceOf(attacker), 0, "and the attacker took none of it");
        assertEq(tokenA.balanceOf(maker), 1_000e18, "the maker paid for nothing");
    }

    /// @notice Only the settlement may call the callback, so nobody can drive it directly.
    function test_TheCallbackRefusesEveryCallerButTheSettlement() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(ProveExecutor.NotSettlement.selector);
        exec.proveCallback(
            address(exec),
            IProveCallback.Terms({
                tokenIn: address(tokenA),
                amountIn: AMOUNT_IN,
                feeIn: 0,
                feeInDue: 0,
                tokenOut: address(tokenB),
                owedToMaker: MIN_OUT,
                feeOut: 0,
                feeProceeds: 0,
                delivered: MIN_OUT,
                owed: MIN_OUT
            }),
            abi.encode(_swap(AMOUNT_IN), address(0xBAD))
        );
    }

    /**
     * @notice The venue's allowance does not outlive the transaction that granted it.
     *
     * A leftover approval on a contract that anyone can aim a call at is a slow leak: any token
     * that later lands here could be spent by whoever still holds it.
     */
    function test_TheVenueAllowanceIsSetBackToZero() public {
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, _swap(AMOUNT_IN));

        assertEq(tokenA.allowance(address(exec), address(venue)), 0, "no standing approval left");
    }

    /**
     * @notice A token whose `approve` answers with nothing is still sellable.
     *
     * The sink has to grant the venue an allowance over the maker's token, and USDT and its
     * imitators answer an `approve` with an empty buffer rather than the `bool` the interface
     * promises. A plain `IERC20.approve` reverts decoding that, so the sink would be unable to
     * grant an allowance over the most-held stablecoin shape on any chain — the whole trade,
     * refused at the approval.
     *
     * `SafeERC20.forceApprove` is what makes it work, and every approval in `src/` uses it. No
     * fixture in this repo overrode `approve` until now, so swapping all four call sites for a
     * plain one left the suite green. This is the row that goes red.
     *
     * The token misbehaves on `approve` alone. Its transfers are ordinary, so nothing else in
     * this fill has a second reason to fail.
     */
    function test_ATokenThatAnswersAnApproveWithNothingIsStillSellable() public {
        WeirdToken odd = new WeirdToken("Odd", "ODD", 18);
        odd.setSilentApprove(true);
        odd.mint(maker, 1_000e18);

        // The test grants its own approval the same way, because a plain one reverts here too.
        vm.startPrank(maker);
        IERC20(address(odd)).forceApprove(relayer, type(uint256).max);
        vm.stopPrank();

        IProveSettlementFill.Intent memory i = _intent();
        i.tokenIn = address(odd);
        bytes memory sig = _sign(i);

        address[] memory path = new address[](2);
        path[0] = address(odd);
        path[1] = address(tokenB);
        ProveExecutor.Swap memory s = ProveExecutor.Swap({
            spender: address(venue),
            target: address(venue),
            data: abi.encodeCall(
                MockRouter.swapExactTokensForTokens,
                (AMOUNT_IN, 0, path, address(exec), block.timestamp)
            ),
            extra: new address[](0)
        });

        address theSink = _sinkOf(caller);
        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, s);

        // The venue pulled, so the allowance was granted; and it is gone again.
        assertEq(odd.balanceOf(address(venue)), AMOUNT_IN, "the venue pulled its allowance");
        assertEq(tokenB.balanceOf(maker), NET_OUT, "the maker got exactly the signed rate");
        assertEq(odd.allowance(theSink, address(venue)), 0, "and no standing approval survived");
    }

    // ── When the trade does not work ─────────────────────────────────────────

    /// @notice A swap that reverts takes the whole fill with it, and says why.
    function test_AFailingSwapRevertsTheFillAndBubblesTheReason() public {
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        // Ask for more out than the venue will give, so its own slippage check fires.
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        ProveExecutor.Swap memory greedy = ProveExecutor.Swap({
            spender: address(venue),
            target: address(venue),
            data: abi.encodeCall(
                MockRouter.swapExactTokensForTokens,
                (AMOUNT_IN, 10_000e18, path, address(exec), block.timestamp)
            ),
            extra: new address[](0)
        });

        vm.prank(caller);
        vm.expectRevert();
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, greedy);

        assertEq(tokenA.balanceOf(maker), 1_000e18, "the maker still holds everything");
    }

    /**
     * @notice A venue that pays too little cannot half-fill: the settlement reverts it all.
     *
     * This is the property that makes the maker safe from the executor. The release and the
     * payment are the same transaction, so an executor who cannot pay never got the tokens.
     */
    function test_AVenueThatPaysTooLittleTakesNothingFromTheMaker() public {
        venue.setRate(1, 100); // 100 token A now buys 1 token B, far under the signed floor

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        vm.prank(caller);
        vm.expectRevert();
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, _swap(AMOUNT_IN));

        assertEq(tokenA.balanceOf(maker), 1_000e18, "the maker is untouched");
        assertEq(tokenB.balanceOf(maker), 0, "and unpaid, which is the same thing here");
    }

    /**
     * @notice A venue cannot call the executor back into a second fill.
     *
     * The caller picks the code that runs inside the callback, so they can pick their own. At
     * that moment the executor is holding the maker's released token A and has an allowance out
     * to the venue, which is the state a second entry would try to spend twice.
     */
    function test_AVenueCannotReenterTheExecutor() public {
        ReentrantVenue attacker = new ReentrantVenue(exec);
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        attacker.arm(i, sig);

        ProveExecutor.Swap memory s = ProveExecutor.Swap({
            spender: address(attacker),
            target: address(attacker),
            data: abi.encodeWithSignature("anything()"),
            extra: new address[](0)
        });

        vm.prank(caller);
        vm.expectRevert();
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, s);

        assertEq(tokenA.balanceOf(maker), 1_000e18, "the maker kept every token");
        assertEq(tokenA.balanceOf(address(exec)), 0, "and nothing stuck in the executor");
    }

    /**
     * @notice What actually protects the relayer, once a hop defeats the target check.
     *
     * `_forbidden` is a tripwire, not a boundary — one intermediate contract walks round it. That
     * is fine, and worth proving, because it shows the real protection is the relayer's own
     * caller check. This test fails loudly the day that check goes away.
     */
    function test_AHopReachesTheRelayerAndTheRelayerRefusesIt() public {
        Hop hop = new Hop();
        address victim = makeAddr("victim");
        tokenA.mint(victim, 1_000e18);
        vm.prank(victim);
        tokenA.approve(relayer, type(uint256).max);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory viaHop = ProveExecutor.Swap({
            spender: address(venue),
            target: address(hop),
            data: abi.encodeCall(
                Hop.relay,
                (
                    relayer,
                    abi.encodeWithSignature(
                        "pull(address,address,address,uint256)",
                        address(tokenA),
                        victim,
                        address(this),
                        1_000e18
                    )
                )
            ),
            extra: new address[](0)
        });

        vm.prank(caller);
        vm.expectRevert();
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, viaHop);

        assertEq(tokenA.balanceOf(victim), 1_000e18, "the relayer refused a caller it did not know");
    }

    /// @notice And the settlement's reentrancy guard, for the same reason.
    function test_AHopReachesTheSettlementAndTheGuardRefusesIt() public {
        Hop hop = new Hop();
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory viaHop = ProveExecutor.Swap({
            spender: address(venue),
            target: address(hop),
            data: abi.encodeCall(
                Hop.relay,
                (
                    address(settlement),
                    abi.encodeWithSignature(
                        "fill((address,address,address,address,uint256,uint256,uint256,uint64,uint64,address,uint8,uint256),bytes,uint256,uint256)",
                        _asSettlement(i),
                        sig,
                        AMOUNT_IN,
                        ANY_FEE
                    )
                )
            ),
            extra: new address[](0)
        });

        vm.prank(caller);
        vm.expectRevert();
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, viaHop);

        assertEq(tokenA.balanceOf(maker), 1_000e18, "the guard held and nothing moved");
    }

    // ── The sink's own guards ────────────────────────────────────────────────

    /**
     * @notice A clone reads its executor out of the TEMPLATE's code, not out of its own storage.
     *
     * `ProveCallSink.executor` is `immutable`, so the compiler writes the value into the
     * template's runtime code and a clone delegatecalls that code. The whole design rests on it.
     * Were a clone to read zero there, `msg.sender != executor` would pass for nobody — or, worse
     * on a different layout, for everybody — and the sink would take orders from strangers.
     *
     * So this checks the claim instead of assuming it, on a clone nothing else drives.
     */
    function test_ACloneKnowsWhichExecutorItAnswersTo() public {
        ProveCallSink template = exec.sinkTemplate();
        ProveCallSink clone = ProveCallSink(Clones.clone(address(template)));

        assertEq(clone.executor(), address(exec), "the clone answers to the executor");
        assertEq(clone.executor(), template.executor(), "which is what the template reads too");
        assertEq(clone.template(), address(template), "and it knows whose code it runs");
        assertTrue(address(clone) != address(template), "while being a different address");
        assertEq(address(clone).code.length, 45, "45 bytes of proxy, not 1,860 bytes of sink");

        // The guard that reads the immutable still turns a stranger away.
        vm.prank(address(0xBAD));
        vm.expectRevert(ProveCallSink.NotExecutor.selector);
        clone.run(
            address(tokenA),
            1e18,
            address(tokenB),
            address(venue),
            address(venue),
            "",
            new address[](0)
        );
    }

    /**
     * @notice The venue sees the caller's clone, the clone sweeps home, and no two callers share.
     *
     * Four claims a plain deployment could not make. `msg.sender` at the venue is the clone
     * rather than the template, which is what says `address(this)` inside delegatecalled code is
     * the proxy. `_sweep` sends to `executor`, so the proceeds arrive whichever address made the
     * call. The same caller's second fill runs from the SAME address, because a caller's sink is
     * minted once and reused for ever. And another caller's fill runs from a different one,
     * which is the property the whole design exists for.
     *
     * This test used to assert the opposite of the third claim: the sink was ephemeral, so the
     * second fill got a fresh clone. That bought safety by throwing away anything the first fill
     * stranded. A per-caller sink keeps the safety and gives the strand back.
     */
    function test_TheVenueSeesTheCallersCloneAndNoTwoCallersShare() public {
        SinkProbe probe = new SinkProbe(tokenA, tokenB);
        tokenB.mint(address(probe), 10_000e18);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        uint256 take = AMOUNT_IN / 2;

        address mine = _sinkOf(caller);
        vm.prank(caller);
        exec.fill(
            i,
            sig,
            take,
            ANY_FEE,
            ProveExecutor.Swap({
                spender: address(probe),
                // The venue pays the address that called it, so the sweep is what brings it home.
                target: address(probe),
                data: abi.encodeCall(SinkProbe.sell, (take, mine)),
                extra: new address[](0)
            })
        );

        assertEq(probe.lastCaller(), mine, "this caller's own clone made the call");
        assertTrue(probe.lastCaller() != address(exec), "the executor never did");
        assertTrue(probe.lastCaller() != address(exec.sinkTemplate()), "nor the template");
        assertEq(tokenB.balanceOf(mine), 0, "and the clone kept none of the proceeds");
        assertGt(tokenB.balanceOf(caller), 0, "which reached the caller through the executor");

        vm.prank(caller);
        exec.fill(
            i,
            sig,
            take,
            ANY_FEE,
            ProveExecutor.Swap({
                spender: address(probe),
                target: address(probe),
                data: abi.encodeCall(SinkProbe.sell, (take, mine)),
                extra: new address[](0)
            })
        );
        assertEq(probe.lastCaller(), mine, "the same caller drives the same sink again");

        // A different caller, on an intent of their own, because the first one is filled.
        address other = address(0xB0B0);
        address theirs = _sinkOf(other);
        assertTrue(theirs != mine, "and no two callers share a sink");

        IProveSettlementFill.Intent memory j = _intent();
        j.nonce = 2;
        bytes memory jsig = _sign(j);

        vm.prank(other);
        exec.fill(
            j,
            jsig,
            take,
            ANY_FEE,
            ProveExecutor.Swap({
                spender: address(probe),
                target: address(probe),
                data: abi.encodeCall(SinkProbe.sell, (take, theirs)),
                extra: new address[](0)
            })
        );
        assertEq(probe.lastCaller(), theirs, "the other caller drove their own sink");
    }

    /**
     * @notice A caller cannot aim the call at the clone that is making it, or at the template.
     *
     * `address(this)` in delegatecalled code is the proxy, so the self-target guard now names the
     * clone. The template is the address `sinkTemplate()` publishes, so rule 2 has to answer for it too —
     * `template` is an immutable for exactly this line.
     */
    function test_ACloneRefusesToBeAimedAtItselfOrAtItsTemplate() public {
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory atSelf = _swap(AMOUNT_IN);
        atSelf.target = _sinkOf(caller);
        vm.prank(caller);
        vm.expectRevert(ProveCallSink.ForbiddenTarget.selector);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, atSelf);

        ProveExecutor.Swap memory atTemplate = _swap(AMOUNT_IN);
        atTemplate.target = address(exec.sinkTemplate());
        vm.prank(caller);
        vm.expectRevert(ProveCallSink.ForbiddenTarget.selector);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, atTemplate);

        assertEq(tokenA.balanceOf(maker), 1_000e18, "and the maker is untouched by both");
    }

    /// @notice Only the executor drives the sink, so nobody can borrow its call surface.
    function test_TheSinkRefusesEveryCallerButTheExecutor() public {
        ProveCallSink s = exec.sinkTemplate();

        vm.prank(address(0xBAD));
        vm.expectRevert(ProveCallSink.NotExecutor.selector);
        s.run(
            address(tokenA),
            1e18,
            address(tokenB),
            address(venue),
            address(venue),
            "",
            new address[](0)
        );
    }

    /**
     * @notice The sink refuses to be aimed at the executor, or at itself.
     *
     * Nothing there is reachable today — `fill` is guarded and `proveCallback` checks its caller
     * — but a caller picking the address is exactly the case the settlement's own rule 2 covers,
     * and the sink should keep the same rule for the code nobody has written yet.
     */
    function test_TheSinkRefusesToBeAimedAtTheExecutorOrItself() public {
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory atExec = _swap(AMOUNT_IN);
        atExec.target = address(exec);
        vm.prank(caller);
        vm.expectRevert(ProveCallSink.ForbiddenTarget.selector);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, atExec);

        ProveExecutor.Swap memory viaExec = _swap(AMOUNT_IN);
        viaExec.spender = address(exec);
        vm.prank(caller);
        vm.expectRevert(ProveCallSink.ForbiddenTarget.selector);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, viaExec);

        ProveExecutor.Swap memory atSink = _swap(AMOUNT_IN);
        atSink.target = address(exec.sinkTemplate());
        vm.prank(caller);
        vm.expectRevert(ProveCallSink.ForbiddenTarget.selector);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, atSink);

        assertEq(tokenA.balanceOf(maker), 1_000e18, "and the maker is untouched by all three");
    }

    /**
     * @notice The spender clause on its own: nothing else about this fill is wrong.
     *
     * The test above changes one field of a swap that already needs an allowance, so a missing
     * allowance reverts it too. Naming the selector narrows that but does not close it, because
     * `ProveExecutor` and `ProveCallSink` both declare `error ForbiddenTarget()` and the two
     * selectors are identical.
     *
     * So this fill has exactly one fault. `GiftVenue` pulls nothing, so the approval the sink
     * writes is never spent and its address cannot matter to the trade. The same swap with the
     * spender left alone settles the intent and pays the maker. Delete `spender == executor` and
     * the refused call becomes the second one: it goes through.
     *
     * Why the clause is there at all: the sink approves `spender` for the caller's tokens and
     * then makes a call the caller wrote. Pointing that approval at the executor hands the
     * caller's own arbitrary calldata a standing claim on the sink, held by an address the sink
     * exists to keep out of its allowances.
     */
    function test_TheSinkRefusesAnApprovalAimedAtTheExecutorWithNothingElseWrong() public {
        GiftVenue gift = new GiftVenue(tokenB);
        tokenB.mint(address(gift), 1_000e18);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        // Enough token B to cover the maker's floor and the fee, from a venue that asks for no
        // allowance to pay it.
        ProveExecutor.Swap memory honest = ProveExecutor.Swap({
            spender: address(gift),
            target: address(gift),
            data: abi.encodeCall(GiftVenue.pay, (300e18)),
            extra: new address[](0)
        });

        // Built again rather than copied: a `memory` struct assignment aliases, so editing a
        // copy would edit the swap this test compares it against.
        ProveExecutor.Swap memory viaExec = ProveExecutor.Swap({
            spender: address(exec),
            target: address(gift),
            data: abi.encodeCall(GiftVenue.pay, (300e18)),
            extra: new address[](0)
        });
        vm.prank(caller);
        vm.expectRevert(ProveCallSink.ForbiddenTarget.selector);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, viaExec);

        assertEq(tokenA.balanceOf(maker), 1_000e18, "the maker is untouched");
        assertEq(tokenB.balanceOf(maker), 0, "and unpaid");

        // One field back, and the same fill settles. The spender was the only thing wrong.
        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, honest);

        assertEq(tokenB.balanceOf(maker), NET_OUT, "the maker got exactly the signed rate");
        assertEq(tokenA.balanceOf(address(exec)), 0, "and the executor kept nothing");
    }

    /// @notice A venue that answers with megabytes does not get to charge quadratically for it.
    function test_AHugeRevertReasonIsClipped() public {
        Screamer loud = new Screamer();
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory s = ProveExecutor.Swap({
            spender: address(venue),
            target: address(loud),
            data: abi.encodeWithSignature("scream()"),
            extra: new address[](0)
        });

        vm.prank(caller);
        try exec.fill(i, sig, AMOUNT_IN, ANY_FEE, s) {
            revert("should have reverted");
        } catch (bytes memory err) {
            // SwapFailed(bytes) with the reason clipped to 256 bytes, not the 60kB it emitted.
            assertLt(err.length, 1_000, "the reason was clipped");
        }
    }

    /**
     * @notice The clip keeps the front of the reason: 256 bytes, and the venue's own first 256.
     *
     * The test above proves the caller is not billed for 60kB. It cannot say what the surviving
     * bytes are, because a venue screaming zeros reads the same whether the clip took the front,
     * took the back, or took nothing. A clipped reason is only worth having if it is the front,
     * since that is where a revert string and an error selector live — so this venue screams a
     * pattern keyed to each byte's position and the test reads the window back.
     */
    function test_ALongRevertReasonKeepsItsFirst256BytesAndLosesTheRest() public {
        Screamer loud = new Screamer();
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory s = ProveExecutor.Swap({
            spender: address(venue),
            target: address(loud),
            data: abi.encodeCall(Screamer.screamPattern, (1_000)),
            extra: new address[](0)
        });

        vm.prank(caller);
        try exec.fill(i, sig, AMOUNT_IN, ANY_FEE, s) {
            revert("should have reverted");
        } catch (bytes memory err) {
            bytes memory reason = _swapFailureReason(err);
            assertEq(reason.length, 256, "the reason came back at exactly the cap");
            assertEq(reason, loud.pattern(256), "and it is the venue's own first 256 bytes");
        }
    }

    /**
     * @notice A reason the cap already fits comes back whole, up to and including 256 bytes.
     *
     * The clip has to leave the ordinary case alone. A venue's own error — a selector, a revert
     * string — is all the caller has to debug with, and 256 bytes is the longest one that must
     * arrive intact. Both lengths are pinned rather than one, so a cap moved down is caught here
     * rather than quietly shortening every reason a caller ever reads.
     */
    function test_AShortRevertReasonComesBackWholeRightUpToTheCap() public {
        Screamer loud = new Screamer();
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        uint256[2] memory lengths = [uint256(200), 256];
        for (uint256 k = 0; k < lengths.length; k++) {
            ProveExecutor.Swap memory s = ProveExecutor.Swap({
                spender: address(venue),
                target: address(loud),
                data: abi.encodeCall(Screamer.screamPattern, (lengths[k])),
                extra: new address[](0)
            });

            vm.prank(caller);
            try exec.fill(i, sig, AMOUNT_IN, ANY_FEE, s) {
                revert("should have reverted");
            } catch (bytes memory err) {
                assertEq(
                    _swapFailureReason(err),
                    loud.pattern(lengths[k]),
                    "a reason inside the cap reaches the caller untouched"
                );
            }
        }
    }

    /// @dev The `bytes` a `SwapFailed` carries, taken out of the raw revert data the sink threw.
    function _swapFailureReason(bytes memory err) internal pure returns (bytes memory) {
        assertTrue(
            bytes4(err) == ProveCallSink.SwapFailed.selector,
            "the sink's own error is what came out of the executor"
        );
        bytes memory body = new bytes(err.length - 4);
        for (uint256 k = 0; k < body.length; k++) {
            body[k] = err[k + 4];
        }
        return abi.decode(body, (bytes));
    }

    /**
     * @notice A settlement that is not a contract, or that names no relayer, is refused at deploy.
     *
     * Neither check catches the interesting mistake — a wrong contract that happens to answer
     * `relayer()` with something plausible — so this is a typo guard, not a safety property.
     */
    function test_TheConstructorRefusesASettlementThatCannotBeOne() public {
        // Everything that is a call comes first: `vm.expectRevert` arms the very next one.
        // The factory deploys through a plain CREATE, so the constructor runs in an ordinary
        // frame rather than the cheatcode one `new` is rewritten into.
        ExecutorFactory factory = new ExecutorFactory();
        address nothing = makeAddr("nothing");
        address hollow = address(new HollowSettlement());

        vm.expectRevert(ProveExecutor.BadSettlement.selector);
        factory.make(nothing);

        vm.expectRevert(ProveExecutor.BadSettlement.selector);
        factory.make(hollow);
    }

    /**
     * @notice A third token the venue pays comes home only if the caller names it — and a caller
     *         who forgets can name it in a later fill and take it back.
     *
     * Routes pay in more than the pair being traded: a keeper tip, a router reward, a rebate. The
     * sink swept `tokenIn` and `tokenOut` and nothing else, and its own comment called anything
     * more impossible — so a third token stranded there. `extra` is how the caller says what
     * their route pays.
     *
     * This test has now said three different things, and the middle one is why the design moved.
     * With one shared sink the strand was recoverable BY ANYBODY, which was the finding. With a
     * clone per transaction it was recoverable by nobody, which was safe and wasteful. With a
     * clone per caller it is recoverable by its owner alone: the strand waits on their sink, and
     * their next fill sweeps the sink's whole balance. Name the token anyway — the recovery
     * costs a second transaction.
     */
    function test_AThirdTokenComesHomeOnlyIfTheCallerNamesIt() public {
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        tokenC.mint(address(venue), 100e18);
        venue.setTip(address(tokenC), 100e18);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        // Unnamed: the tip rests on this caller's own sink.
        address mine = _sinkOf(caller);
        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN / 2, ANY_FEE, _swap(AMOUNT_IN / 2));
        assertEq(tokenC.balanceOf(caller), 0, "the caller never saw the tip");
        assertEq(tokenC.balanceOf(mine), 100e18, "it rests on the caller's own sink");
        assertEq(tokenC.balanceOf(address(exec.sinkTemplate())), 0, "and never in the template");

        // Named: the new tip comes home, and so does the strand. `_sweep` moves the sink's whole
        // balance, and the second fill drives the same address as the first.
        tokenC.mint(address(venue), 100e18);
        venue.setTip(address(tokenC), 100e18);
        ProveExecutor.Swap memory named = _swap(AMOUNT_IN / 2);
        named.extra = new address[](1);
        named.extra[0] = address(tokenC);

        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN / 2, ANY_FEE, named);
        assertEq(tokenC.balanceOf(mine), 0, "the sink handed over everything it held");
        assertEq(tokenC.balanceOf(caller), 200e18, "the new tip and the old strand, both home");
    }

    /**
     * @notice One caller's strand is out of every other caller's reach, and still its owner's.
     *
     * This is the property the whole design turns on, and the one a per-transaction clone could
     * not offer. The first caller forgets to name a tip, so it waits on their sink. A second
     * caller names that same token in their own route and drives their own sink, which never
     * held it and hands over nothing. Then the owner comes back and takes it.
     */
    function test_AStrandOnOneCallersSinkIsOutOfAnotherCallersReach() public {
        address other = address(0xB0B0);
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        tokenC.mint(address(venue), 100e18);
        venue.setTip(address(tokenC), 100e18);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        address mine = _sinkOf(caller);
        address theirs = _sinkOf(other);
        assertTrue(theirs != mine, "the two callers do not share a sink");

        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN / 2, ANY_FEE, _swap(AMOUNT_IN / 2));
        assertEq(tokenC.balanceOf(mine), 100e18, "the strand is on the first caller's sink");

        // The venue pays no tip now, so anything the second caller ends up with could only have
        // come out of somebody else's sink.
        venue.setTip(address(0), 0);
        ProveExecutor.Swap memory named = _swap(AMOUNT_IN / 2);
        named.extra = new address[](1);
        named.extra[0] = address(tokenC);

        vm.prank(other);
        exec.fill(i, sig, AMOUNT_IN / 2, ANY_FEE, named);

        assertEq(tokenC.balanceOf(other), 0, "another caller reached the strand");
        assertEq(tokenC.balanceOf(theirs), 0, "their own sink never held it");
        assertEq(tokenC.balanceOf(mine), 100e18, "it is still where its owner left it");

        // And its owner takes it back, on an intent of their own because the first is filled.
        IProveSettlementFill.Intent memory j = _intent();
        j.nonce = 2;
        bytes memory jsig = _sign(j);

        vm.prank(caller);
        exec.fill(j, jsig, AMOUNT_IN / 2, ANY_FEE, named);
        assertEq(tokenC.balanceOf(mine), 0, "the owner's own fill swept their sink");
        assertEq(tokenC.balanceOf(caller), 100e18, "and the strand came home to them");
    }

    /**
     * @notice A donation in a third token stays here, even when a caller names it as an extra.
     *
     * `extra` swept from a mark of zero, so a token sent here by mistake left with whoever asked
     * for it. The sibling test below refuses the intent's own two tokens in that list; this is
     * the same argument for every other token, and it was missing.
     */
    function test_ADonationInAnExtraTokenIsNotSwept() public {
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        tokenC.mint(address(exec), 900e18);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory sw = _swap(AMOUNT_IN);
        sw.extra = new address[](1);
        sw.extra[0] = address(tokenC);

        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN, ANY_FEE, sw);

        assertEq(tokenC.balanceOf(address(exec)), 900e18, "the donation should have stayed put");
        assertEq(tokenC.balanceOf(caller), 0, "and the caller should have taken none of it");
    }

    /**
     * @notice Naming an intent's own token as an extra is refused, so the snapshot still holds.
     *
     * `extra` sweeps from a mark of zero. Point it at token A or token B and it runs one line
     * after the snapshot swept the same token to its mark, and hands the caller the balance the
     * mark exists to protect. A donation would become the next caller's.
     */
    function test_TheExtraListCannotNameAnIntentToken() public {
        tokenB.mint(address(exec), 5e18);
        tokenA.mint(address(exec), 7e18);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory out = _swap(AMOUNT_IN / 2);
        out.extra = new address[](1);
        out.extra[0] = address(tokenB);
        vm.prank(caller);
        vm.expectRevert(ProveExecutor.IntentTokenInExtra.selector);
        exec.fill(i, sig, AMOUNT_IN / 2, ANY_FEE, out);

        ProveExecutor.Swap memory into = _swap(AMOUNT_IN / 2);
        into.extra = new address[](1);
        into.extra[0] = address(tokenA);
        vm.prank(caller);
        vm.expectRevert(ProveExecutor.IntentTokenInExtra.selector);
        exec.fill(i, sig, AMOUNT_IN / 2, ANY_FEE, into);

        assertEq(tokenB.balanceOf(address(exec)), 5e18, "the donation stayed put");
        assertEq(tokenA.balanceOf(address(exec)), 7e18, "and so did the other one");
        assertEq(tokenB.balanceOf(caller), 0, "the caller took nothing");
    }

    /**
     * @notice A token sitting in the sink does not widen the venue's allowance.
     *
     * The sink empties itself at the end of every `run`, so its balance and this fill's delta
     * agree — until a token reaches it another way. Approve on the balance and the venue may
     * spend more than the settlement released, and the donation walks out with it.
     *
     * The sink is a fresh clone now, so "another way" is narrower than it was: a `create` address
     * is predictable, so somebody has to fund the clone in the same block and ahead of the fill.
     * The test funds the address the next fill will use, which is exactly that front-run.
     */
    function test_ADonationToTheSinkDoesNotWidenTheVenueAllowance() public {
        GreedyVenue greedy = new GreedyVenue(tokenA, tokenB);
        tokenB.mint(address(greedy), 1_000e18);

        uint256 donation = 400e18;
        address theSink = _sinkOf(caller);
        tokenA.mint(theSink, donation);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        uint256 take = AMOUNT_IN / 2;
        ProveExecutor.Swap memory swap = ProveExecutor.Swap({
            spender: address(greedy),
            target: address(greedy),
            data: abi.encodeCall(GreedyVenue.sell, (take, theSink)),
            extra: new address[](0)
        });

        vm.prank(caller);
        exec.fill(i, sig, take, ANY_FEE, swap);

        assertEq(tokenA.balanceOf(address(greedy)), take, "the venue spent the fill and no more");
        assertEq(tokenA.balanceOf(caller), donation, "so the donation came back out to the caller");
        assertEq(tokenA.balanceOf(theSink), 0, "and the sink is empty again");
    }

    // ── Properties ───────────────────────────────────────────────────────────

    /**
     * @notice Whatever the venue pays, the maker gets their signed rate less their own fee, or the
     *         trade does not happen. The caller's profit is the only thing that varies.
     *
     * `owed` is the gross the curve asks for, less the fee the intent carves out of it. The fee
     * rounds down, so this floor is exact rather than generous.
     */
    function testFuzz_TheMakerNeverGetsLessThanTheySignedWhateverTheVenuePays(
        uint256 num,
        uint256 take
    ) public {
        venue.setRate(bound(num, 1, 20), 1);
        take = bound(take, 1e18, AMOUNT_IN);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        uint256 gross = (take * MIN_OUT + AMOUNT_IN - 1) / AMOUNT_IN;
        uint256 owed = gross - (gross * i.feeRateProceeds) / 1e18;

        vm.prank(caller);
        try exec.fill(i, sig, take, ANY_FEE, _swap(take)) {
            assertGe(tokenB.balanceOf(maker), owed, "paid at least the signed rate");
        } catch {
            assertEq(tokenB.balanceOf(maker), 0, "or paid nothing at all");
            assertEq(tokenA.balanceOf(maker), 1_000e18, "and kept every token");
        }
        assertEq(tokenA.balanceOf(address(exec)), 0, "the executor never keeps token A");
        assertEq(tokenB.balanceOf(address(exec)), 0, "nor token B");
    }

    /**
     * @notice No call this contract can be asked to make leaves it holding an allowance.
     *
     * Fuzzed over the spender, because the caller picks it. A standing approval on an address
     * anyone can aim a call at is the only way value could leak out of a contract that holds
     * nothing.
     */
    function testFuzz_NoSpenderKeepsAnAllowanceAfterTheFill(address spender) public {
        vm.assume(spender != relayer && spender != address(settlement));
        vm.assume(spender != address(0) && spender.code.length == 0);

        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveExecutor.Swap memory s = _swap(AMOUNT_IN);
        s.spender = spender;

        // The venue is not approved, so the swap fails and the fill reverts — but the point is
        // what the state looks like afterwards, and a reverted call leaves none.
        vm.prank(caller);
        try exec.fill(i, sig, AMOUNT_IN, ANY_FEE, s) {} catch {}

        assertEq(tokenA.allowance(address(exec), spender), 0, "no allowance survives");
    }

    /**
     * @notice A payout aimed at the sink TEMPLATE is refused by name, and both right targets pay.
     *
     * `sinkTemplate()` is the address every sink clone is made from. Nothing calls it and nothing
     * sweeps it, so a router told to pay it strands the proceeds there. The fill used to die
     * inside the token on the settlement's own pull — `ERC20: transfer amount exceeds balance` —
     * frames below the swap that named the wrong address. That cost the 369 fork rehearsal a run,
     * and a solver reading the ABI had no way to know.
     *
     * The executor checks that it holds what the settlement is about to pull, so the revert names
     * the token, what is here and what is owed. A reader gets the answer from the message.
     *
     * The two addresses that DO work are asserted beside it, because a revert refusing everything
     * is not a fix. The executor takes the proceeds under the fill's own mark. The caller's own
     * clone, which `sinkFor` publishes, sweeps them here before the callback returns.
     */
    function test_APayoutAimedAtTheSinkTemplateIsRefusedByName() public {
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        uint256 take = AMOUNT_IN / 2;

        // Every external call happens before the prank, which is single-shot.
        TakePoints.Quote memory q_fee = settlement.quote(_asSettlement(i), take, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        address template = address(exec.sinkTemplate());
        address clone = exec.sinkFor(caller);
        assertTrue(template != clone, "the template is not the address that sweeps");

        ProveExecutor.Swap memory atTemplate = _swapTo(take, template);
        ProveExecutor.Swap memory atExec = _swapTo(take, address(exec));
        ProveExecutor.Swap memory atClone = _swapTo(take, clone);

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveExecutor.ProceedsNotHere.selector, address(tokenB), 0, delivered + fee
            )
        );
        exec.fill(i, sig, take, ANY_FEE, atTemplate);

        assertEq(tokenB.balanceOf(template), 0, "the template kept nothing, having never run");
        assertEq(tokenA.balanceOf(maker), 1_000e18, "and the maker is untouched by the attempt");

        // The executor itself. The proceeds land under the fill's own mark and sweep home.
        vm.prank(caller);
        exec.fill(i, sig, take, ANY_FEE, atExec);
        assertEq(tokenB.balanceOf(maker), delivered, "the maker was paid");
        uint256 spread = tokenB.balanceOf(caller);
        assertGt(spread, 0, "and the spread reached the caller");

        // The caller's own clone, the address the ABI now publishes.
        vm.prank(caller);
        exec.fill(i, sig, take, ANY_FEE, atClone);
        assertEq(tokenB.balanceOf(maker), delivered * 2, "the maker was paid a second time");
        assertGt(tokenB.balanceOf(caller), spread, "and the caller kept the second spread too");
        assertEq(tokenB.balanceOf(clone), 0, "the clone swept itself empty on the way out");
    }

    // ── The handover fee on the approval rung (P1) ───────────────────────────

    /// P1 is approved to the relayer with the delivery and pulled back at the flush, out of the
    /// part of the take the executor kept for it.
    function test_AHandoverFeeOnTheApprovalRungIsApprovedAndPulledBack() public {
        IProveSettlementFill.Intent memory i = _intent();
        i.feeRateIn = 0.002e18;
        bytes memory sig = _sign(i);
        uint256 take = AMOUNT_IN / 2;
        TakePoints.Quote memory q = settlement.quote(_asSettlement(i), take, block.timestamp);
        assertGt(q.feeIn, 0, "there is a handover fee to pay");
        ProveExecutor.Swap memory s = _swap(take - q.feeIn);

        vm.prank(caller);
        exec.fill(i, sig, take, ANY_FEE, s);

        assertEq(settlement.pendingFees(i.feeConfig, address(tokenA)), q.feeIn, "booked in tokenIn");
    }

    /// Reached only if the executor's own tokenIn went missing between the swap and the flush,
    /// which no honest swap can do, so the callback is driven directly as the settlement and the
    /// refusal is caught inside the transaction.
    function test_TheCallbackRefusesByNameWhatItCannotCover() public {
        // Mint the caller's sink with an ordinary fill, so a real sink answers the swap below.
        IProveSettlementFill.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        vm.prank(caller);
        exec.fill(i, sig, AMOUNT_IN / 4, ANY_FEE, _swap(AMOUNT_IN / 4));

        ProveExecutor.Swap memory s = ProveExecutor.Swap({
            spender: address(tokenB),
            target: address(tokenB),
            data: abi.encodeWithSignature("totalSupply()"),
            extra: new address[](0)
        });
        bytes memory data = abi.encode(s, exec.sinkFor(caller));

        IProveCallback.Terms memory t;
        t.tokenIn = address(tokenA);
        t.tokenOut = address(tokenB);
        t.feeInDue = 5e18;
        uint256 heldIn = tokenA.balanceOf(address(exec));
        assertLt(heldIn, 5e18);

        vm.prank(address(settlement));
        (bool ok, bytes memory ret) =
            address(exec).call(abi.encodeCall(exec.proveCallback, (address(0), t, data)));
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(
                ProveExecutor.ProceedsNotHere.selector, address(tokenA), heldIn, 5e18
            ),
            "tokenIn short"
        );

        t.feeInDue = 0;
        t.owed = 7e18;
        uint256 heldOut = tokenB.balanceOf(address(exec));
        vm.prank(address(settlement));
        (ok, ret) = address(exec).call(abi.encodeCall(exec.proveCallback, (address(0), t, data)));
        assertFalse(ok);
        assertEq(
            ret,
            abi.encodeWithSelector(
                ProveExecutor.ProceedsNotHere.selector, address(tokenB), heldOut, 7e18
            ),
            "tokenOut short"
        );
    }
}

/**
 * @notice Deploys a `ProveExecutor` through a plain CREATE.
 *
 * forge rewrites `new ProveExecutor(...)` written inside a test into a cheatcode, and the
 * coverage counters of a constructor that reverts in that frame are lost. Going through a
 * contract keeps the CREATE ordinary, which is the only variable this factory changes.
 */
contract ExecutorFactory {
    function make(address settlement) external returns (ProveExecutor) {
        return new ProveExecutor(settlement);
    }
}
