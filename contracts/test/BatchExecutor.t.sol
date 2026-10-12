// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ProveBatchExecutor, IProveSettlementBatch} from "../src/ProveBatchExecutor.sol";
import {IProveSettlementFill} from "../src/ProveExecutor.sol";
import {ProveCallSink} from "../src/ProveCallSink.sol";
import {IProveBatchCallback} from "../src/interfaces/IProveBatchCallback.sol";
import {ANY_FEE, MockERC20, MockRouter, NO_PERMIT2} from "./Mocks.sol";
import {MockVault} from "./Executor.t.sol";
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

/// @notice A venue that writes down who called it. The whole security design is that this is
///         never the executor, so a test has to be able to ask.
contract SenderProbe {
    address public lastCaller;
    MockERC20 public immutable tokenIn;
    MockERC20 public immutable tokenOut;
    uint256 public rateNum = 2;

    constructor(MockERC20 _in, MockERC20 _out) {
        tokenIn = _in;
        tokenOut = _out;
    }

    function setRate(uint256 num) external {
        rateNum = num;
    }

    function sell(uint256 amountIn, address to) external {
        lastCaller = msg.sender;
        tokenIn.transferFrom(msg.sender, address(this), amountIn);
        tokenOut.transfer(to, amountIn * rateNum);
    }
}

/// @notice A venue that turns round and starts another ring, mid-swap.
contract ReentrantVenue {
    ProveBatchExecutor immutable exec;

    constructor(ProveBatchExecutor _exec) {
        exec = _exec;
    }

    /// @dev Any selector lands here, so the caller's `swap.data` can be anything at all.
    fallback() external {
        IProveSettlementBatch.FillRequest[] memory none = new IProveSettlementBatch.FillRequest[](0);
        ProveBatchExecutor.Route memory empty = ProveBatchExecutor.Route({
            legs: 0,
            swaps: new ProveBatchExecutor.Swap[](0),
            sweep: new address[](0),
            disposal: new ProveBatchExecutor.Swap[](0)
        });
        exec.settleRing(none, false, ANY_FEE, empty);
    }
}

/**
 * @notice `ProveBatchExecutor` — a whole ring, no inventory, every venue call routed away.
 *
 *   forge test --match-path test/BatchExecutor.t.sol -vv
 *
 * Two claims are under test and they are not the same claim. The first is capital: a ring of
 * intents that pay for each other settles from an address holding nothing, because every release
 * lands before any payment is pulled. The second is safety: this contract takes a call target and
 * a calldata blob from whoever calls it, which is the shape that cost Transit Swap $23M, and it
 * is admissible only because that call never runs from this address.
 *
 * Most of this file is about the second one.
 */
contract BatchExecutorTest is Test {
    /// @dev The solver-borne P2 rate the next ring is built with. The caller\'s `maxFeeRate`
    ///      bounds P1 + P2 and not the maker-borne P3, so a bound test needs a P2.
    uint64 p2Rate;

    ProveSettlement settlement;
    ProveBatchExecutor exec;
    MockRouter venue;

    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 tokenC;

    /// @dev The address that pulls, which is not the address that calls. Read once: `vm.prank`
    ///      is single-shot and `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;

    /// @dev Where the fixture's intents send their fee. The intent names it and nothing else can.
    address feeDest = address(0x5152);
    /// @dev And where an unattributed token goes. A different address on purpose: no fill reads
    ///      it, so its balance staying at zero is what says a fee went where the intent said.
    address proceeds = address(0xD0D);
    address caller = address(0xCA11);

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
        tokenC = new MockERC20("C", "C", 18);
        venue = new MockRouter();

        tokenA.mint(makerA, 1_000_000e18);
        tokenB.mint(makerB, 1_000_000e18);
        tokenA.mint(address(venue), 1_000_000e18);
        tokenB.mint(address(venue), 1_000_000e18);

        vm.prank(makerA);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(makerB);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

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

    /// @dev The settlement's own `Intent` in the executor's mirror of it. Field for field, which
    ///      is the property `IProveSettlementFill` says the compiler will not check for us.
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
            minFill: 0,
            authNonce: bytes32(0),
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

    /**
     * @dev A ring that pays for its own fee.
     *
     * Maker A sells 1,000 token A and asks 100 token B. Maker B sells 110 token B and asks 900
     * token A. Between them they concede 100 token A and 10 token B, which is more than the
     * sixteen basis points the protocol charges — so nothing has to be funded from outside.
     */
    function _ring() internal view returns (IProveSettlementBatch.FillRequest[] memory reqs) {
        return _ring(1);
    }

    /// @dev The same ring on its own nonces, so a test can settle two of them and have the second
    ///      be as fresh as the first. Reuse one and the second fills past `amountIn`.
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

    /// @dev The two tokens a ring touches, in the order the sweep reads them.
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
            legs: legs, swaps: swaps, sweep: _sweepAB(), disposal: new ProveBatchExecutor.Swap[](0)
        });
    }

    function _noSwaps() internal pure returns (ProveBatchExecutor.Swap[] memory) {
        return new ProveBatchExecutor.Swap[](0);
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

    /// @dev Sell `amountIn` of token A at the mock router, paid back to the executor.
    function _sellAForB(uint256 amountIn, uint256 minOut)
        internal
        view
        returns (ProveBatchExecutor.Swap memory)
    {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        return ProveBatchExecutor.Swap({
            tokenIn: address(tokenA),
            amountIn: amountIn,
            tokenOut: address(tokenB),
            spender: address(venue),
            target: address(venue),
            data: abi.encodeCall(
                MockRouter.swapExactTokensForTokens,
                (amountIn, minOut, path, address(exec), block.timestamp)
            ),
            extra: new address[](0),
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });
    }

    /// @dev The same sale as `_sellAForB`, paid to an address the route names rather than home.
    function _sellAForBTo(uint256 amountIn, uint256 minOut, address to)
        internal
        view
        returns (ProveBatchExecutor.Swap memory s)
    {
        s = _sellAForB(amountIn, minOut);
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        s.data = abi.encodeCall(
            MockRouter.swapExactTokensForTokens, (amountIn, minOut, path, to, block.timestamp)
        );
    }

    /// @dev Sell `amountIn` of token A for token C at the mock router, paid back to the executor.
    function _sellAForC(uint256 amountIn, uint256 minOut)
        internal
        view
        returns (ProveBatchExecutor.Swap memory)
    {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenC);
        return ProveBatchExecutor.Swap({
            tokenIn: address(tokenA),
            amountIn: amountIn,
            tokenOut: address(tokenC),
            spender: address(venue),
            target: address(venue),
            data: abi.encodeCall(
                MockRouter.swapExactTokensForTokens,
                (amountIn, minOut, path, address(exec), block.timestamp)
            ),
            extra: new address[](0),
            // A disposal runs after every leg has settled, so it is tied to none of them.
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });
    }

    /// @dev Sell `amountIn` of one token for another at the mock router, paid back to the executor.
    function _venueSwap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        internal
        view
        returns (ProveBatchExecutor.Swap memory)
    {
        address[] memory path = new address[](2);
        path[0] = tokenIn;
        path[1] = tokenOut;
        return ProveBatchExecutor.Swap({
            tokenIn: tokenIn,
            amountIn: amountIn,
            tokenOut: tokenOut,
            spender: address(venue),
            target: address(venue),
            data: abi.encodeCall(
                MockRouter.swapExactTokensForTokens,
                (amountIn, minOut, path, address(exec), block.timestamp)
            ),
            extra: new address[](0),
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });
    }

    function _sellBForC(uint256 amountIn, uint256 minOut)
        internal
        view
        returns (ProveBatchExecutor.Swap memory)
    {
        return _venueSwap(address(tokenB), address(tokenC), amountIn, minOut);
    }

    function _one(ProveBatchExecutor.Swap memory s)
        internal
        pure
        returns (ProveBatchExecutor.Swap[] memory list)
    {
        list = new ProveBatchExecutor.Swap[](1);
        list[0] = s;
    }

    // ── The capital claim ────────────────────────────────────────────────────

    /**
     * @notice The whole point: an address holding nothing settles a two-leg ring.
     *
     * No token A, no token B, no stash, and no venue in the middle. Both releases land before
     * either payment is pulled, so maker A's token A pays maker B and maker B's token B pays
     * maker A. The fee comes out of the same spread, which is what makes the inventory zero
     * rather than merely small.
     */
    function test_ATwoLegRingSettlesFromAnAddressHoldingNothing() public {
        assertEq(tokenA.balanceOf(address(exec)), 0, "the executor starts with nothing");
        assertEq(tokenB.balanceOf(address(exec)), 0);
        assertEq(tokenA.balanceOf(caller), 0, "and so does the caller");
        assertEq(tokenB.balanceOf(caller), 0);

        IProveSettlementBatch.FillRequest[] memory reqs = _ring();

        vm.prank(caller);
        uint256 count = exec.settleRing(reqs, false, ANY_FEE, _route(2, _noSwaps()));

        assertEq(count, 2, "both legs settled");
        assertEq(tokenB.balanceOf(makerA), 99.9e18, "maker A got the rate they signed");
        assertEq(tokenA.balanceOf(makerB), 899.1e18, "maker B got the rate they signed");
        // 1,000 released less the 900 gross, and 110 less the 100 gross. The fee sits inside each
        // gross rather than beside it, so the caller's spread is the whole difference.
        assertEq(tokenA.balanceOf(caller), 100e18, "the caller kept the token A spread");
        assertEq(tokenB.balanceOf(caller), 10e18, "and the token B spread");
        assertEq(tokenA.balanceOf(address(exec)), 0, "nothing rests in the executor");
        assertEq(tokenB.balanceOf(address(exec)), 0, "in either token");
        assertGt(
            settlement.pendingFees(feeCfg(feeDest), address(tokenB)),
            0,
            "and the destination the intent named was charged"
        );
        assertEq(tokenB.balanceOf(proceeds), 0, "while the address the owner set took nothing");
    }

    /**
     * @notice A ring plus a pool leg, in one transaction.
     *
     * This ring concedes nothing: maker A wants 100 token B for 1,000 token A and maker B wants
     * 900 token A for 100 token B, so the two intents alone leave no room for the fee. The venue
     * supplies it. Before this contract the swap was a second transaction from the solver's own
     * wallet, and a pool that moved between the two left the solver holding the position.
     */
    function test_ARingWithAPoolLegClosesInsideTheSameTransaction() public {
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1), keyA, 1_000e18
        );
        reqs[1] = _req(
            _intent(makerB, address(tokenB), address(tokenA), 100e18, 900e18, 2), keyB, 100e18
        );

        // Sell 50 of the released token A at 2:1. That covers both fees and leaves a surplus.
        ProveBatchExecutor.Route memory route = _route(2, _one(_sellAForB(50e18, 100e18)));

        address theSink = _sinkOf(caller);
        vm.prank(caller);
        assertEq(exec.settleRing(reqs, false, ANY_FEE, route), 2);

        assertEq(tokenB.balanceOf(makerA), 99.9e18, "maker A was paid");
        assertEq(tokenA.balanceOf(makerB), 899.1e18, "maker B was paid");
        assertEq(tokenA.balanceOf(caller), 50e18, "1,000 in, 900 gross out, 50 sold");
        assertEq(tokenB.balanceOf(caller), 100e18, "and the venue's proceeds, fee already inside");
        assertEq(tokenA.balanceOf(address(exec)), 0, "nothing rests in the executor");
        assertEq(tokenB.balanceOf(address(exec)), 0);
        assertEq(tokenA.balanceOf(theSink), 0, "nor in the sink clone that made the call");
        assertEq(tokenB.balanceOf(theSink), 0);
    }

    /// @notice A single intent closed entirely through the venue. The batch entry point does the
    ///         one-leg case too, so a solver needs one contract and not two.
    function test_ASingleLegClosesThroughTheVenueAlone() public {
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 1), keyA, 100e18
        );

        vm.prank(caller);
        assertEq(
            exec.settleRing(reqs, false, ANY_FEE, _route(1, _one(_sellAForB(100e18, 150e18)))), 1
        );

        assertEq(tokenB.balanceOf(makerA), 149.85e18, "the maker got exactly the signed rate");
        assertGt(tokenB.balanceOf(caller), 0, "and the caller kept the difference");
        assertEq(tokenA.balanceOf(address(exec)), 0, "nothing rests in the executor");
        assertEq(tokenB.balanceOf(address(exec)), 0);
    }

    /**
     * @notice A route that pays the sink TEMPLATE is refused by name, and both right targets pay.
     *
     * The same defect as `test_APayoutAimedAtTheSinkTemplateIsRefusedByName` in
     * `test/Executor.t.sol`, one contract over. `sinkTemplate()` is the address every clone is
     * made from. Nothing calls it and nothing sweeps it, so a route that pays it leaves the ring
     * owing a maker money that is sitting where neither this contract nor the solver can reach.
     *
     * The revert names the token, what is here and what is owed, while the frame still knows
     * which route named the wrong address. It used to come out of the token on the settlement's
     * own pull, as `ERC20: transfer amount exceeds balance`.
     */
    function test_ARoutePayingTheSinkTemplateIsRefusedByName() public {
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 1), keyA, 100e18
        );

        address template = address(exec.sinkTemplate());
        address clone = exec.sinkFor(caller);
        assertTrue(template != clone, "the template is not the address that sweeps");

        ProveBatchExecutor.Route memory atTemplate =
            _route(1, _one(_sellAForBTo(100e18, 150e18, template)));

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveBatchExecutor.ProceedsNotHere.selector, address(tokenB), 0, 150e18
            )
        );
        exec.settleRing(reqs, false, ANY_FEE, atTemplate);

        assertEq(tokenB.balanceOf(template), 0, "the template kept nothing, having never run");
        assertEq(tokenA.balanceOf(makerA), 1_000_000e18, "and the maker is untouched by it");

        // The executor itself, which is what every route the SDK builds names.
        ProveBatchExecutor.Route memory atExec =
            _route(1, _one(_sellAForBTo(100e18, 150e18, address(exec))));
        vm.prank(caller);
        assertEq(exec.settleRing(reqs, false, ANY_FEE, atExec), 1);
        assertEq(tokenB.balanceOf(makerA), 149.85e18, "the maker was paid");

        // The caller's own clone, the address the ABI now publishes. It sweeps itself into this
        // contract before the callback returns, so the settlement finds the payment here.
        IProveSettlementBatch.FillRequest[] memory second =
            new IProveSettlementBatch.FillRequest[](1);
        second[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 2), keyA, 100e18
        );
        ProveBatchExecutor.Route memory atClone =
            _route(1, _one(_sellAForBTo(100e18, 150e18, clone)));

        vm.prank(caller);
        assertEq(exec.settleRing(second, false, ANY_FEE, atClone), 1);
        assertEq(tokenB.balanceOf(makerA), 299.7e18, "the maker was paid a second time");
        assertEq(tokenB.balanceOf(clone), 0, "the clone swept itself empty on the way out");
    }

    // ── What a venue cannot do to a maker ────────────────────────────────────

    /**
     * @notice A venue that answers with a very long reason has it clipped to 256 bytes.
     *
     * The caller chooses the target, and a target that reverts with megabytes charges the caller
     * quadratically for the memory it copies. `ProveSettlement._probe` bounds its read for the
     * same reason. Nobody is defended here — the caller pays their own bill — but a bounded copy
     * costs nothing and an unbounded one has no upside, and the clip must not lose the selector
     * a caller reads to find out what happened.
     */
    function test_ALongRevertReasonIsClippedAndStillIdentifiesItself() public {
        LoudVenue loud = new LoudVenue();
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();

        ProveBatchExecutor.Swap memory s = _sellAForB(50e18, 100e18);
        s.spender = address(loud);
        s.target = address(loud);
        s.data = abi.encodeCall(LoudVenue.shout, ());

        vm.prank(caller);
        try exec.settleRing(reqs, false, ANY_FEE, _route(2, _one(s))) returns (uint256) {
            fail();
        } catch (bytes memory err) {
            assertEq(bytes4(err), ProveCallSink.SwapFailed.selector, "still says what failed");
            bytes memory reason = abi.decode(_body(err), (bytes));
            assertEq(reason.length, 256, "clipped to the cap, not to nothing");
            assertEq(loud.REASON_LENGTH() > 256, true, "and the venue did send more than that");
            // The first bytes survive, so a reader still gets the head of the venue's answer.
            for (uint256 k = 0; k < 32; k++) {
                assertEq(reason[k], bytes1("x"), "the head of the reason is intact");
            }
        }
    }

    /// @dev Everything after a four-byte selector, for decoding a custom error's arguments.
    function _body(bytes memory err) internal pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 k = 4; k < err.length; k++) {
            out[k - 4] = err[k];
        }
    }

    /// @notice A venue whose own slippage guard fires takes the whole ring with it.
    function test_AVenueThatRefusesTheTradeRevertsTheWholeRing() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        ProveBatchExecutor.Route memory route = _route(2, _one(_sellAForB(50e18, 100e18)));
        venue.setRate(1, 100);

        vm.prank(caller);
        // The reason the sink clips and rethrows rides inside `SwapFailed`, so match the selector
        // and not the whole payload.
        vm.expectPartialRevert(ProveCallSink.SwapFailed.selector);
        exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(tokenB.balanceOf(makerA), 0, "no maker was paid");
        assertEq(tokenA.balanceOf(makerB), 0);
        assertEq(tokenA.balanceOf(makerA), 1_000_000e18, "and no maker lost anything");
    }

    /**
     * @notice A venue that underpays without complaining still cannot short a maker.
     *
     * The venue is asked for no minimum, so it settles happily at a hundredth of the price. The
     * settlement then pulls what the makers are owed out of this contract and finds it is not
     * there, and the whole ring reverts. That safety is `ProveSettlement`'s, not this contract's.
     */
    function test_AVenueThatUnderpaysQuietlyStillCannotShortAMaker() public {
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 1), keyA, 100e18
        );
        venue.setRate(1, 100);

        vm.prank(caller);
        vm.expectRevert();
        exec.settleRing(reqs, false, ANY_FEE, _route(1, _one(_sellAForB(100e18, 0))));

        assertEq(tokenB.balanceOf(makerA), 0, "the maker was not paid");
        assertEq(tokenA.balanceOf(makerA), 1_000_000e18, "and kept every token A");
    }

    // ── Who may drive it ─────────────────────────────────────────────────────

    /**
     * @notice Only the settlement contract may call the callback.
     *
     * Nothing rests here between transactions, so a stranger reaching this today drives the sink
     * with an empty bag and grants the relayer an allowance over tokens nobody holds. This test
     * is what keeps that true of a version that one day holds inventory.
     */
    function test_ACallerThatIsNotTheSettlementIsRefused() public {
        IProveBatchCallback.Payment[] memory owed = new IProveBatchCallback.Payment[](0);
        // The sink address the settlement would have carried. Nothing reads it: the caller
        // check refuses both calls first.
        bytes memory route = abi.encode(_route(0, _noSwaps()), address(0));

        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.NotSettlement.selector);
        exec.proveBatchCallback(owed, route);

        // Not through a plausible-looking address either.
        vm.prank(relayer);
        vm.expectRevert(ProveBatchExecutor.NotSettlement.selector);
        exec.proveBatchCallback(owed, route);
    }

    /// @notice An arbitrary caller cannot make it approve anything, which is the reason the
    ///         check above exists rather than being tidiness.
    function test_AnArbitraryCallerCannotMakeItApproveAnything() public {
        IProveBatchCallback.Payment[] memory owed = new IProveBatchCallback.Payment[](1);
        owed[0] = IProveBatchCallback.Payment({
            token: address(tokenA),
            to: caller,
            amount: type(uint128).max,
            fee: 0,
            feeConfig: feeCfg(feeDest),
            leg: 0,
            tokenIn: address(0),
            amountIn: 0,
            feeIn: 0,
            feeInDue: 0,
            feeProceeds: 0
        });

        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.NotSettlement.selector);
        exec.proveBatchCallback(owed, abi.encode(_route(1, _noSwaps()), address(0)));

        assertEq(tokenA.allowance(address(exec), relayer), 0, "no allowance was written");
    }

    /// @notice A venue that starts a second ring mid-swap is refused. The settlement's own guard
    ///         would refuse it too; this one is here so that stays true of a settlement that
    ///         reorganises its guard.
    function test_AVenueCannotStartASecondRingFromInsideTheFirst() public {
        ReentrantVenue bad = new ReentrantVenue(exec);
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();

        ProveBatchExecutor.Swap memory reenter = ProveBatchExecutor.Swap({
            tokenIn: address(tokenA),
            amountIn: 1e18,
            tokenOut: address(tokenB),
            spender: address(bad),
            target: address(bad),
            data: "",
            extra: new address[](0),
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });
        ProveBatchExecutor.Route memory route = _route(2, _one(reenter));

        vm.prank(caller);
        vm.expectRevert();
        exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(tokenB.balanceOf(makerA), 0, "nothing settled");
    }

    // ── A route that does not describe this ring ─────────────────────────────

    /**
     * @notice A leg the settlement steps over takes the route's plan for it with it, and the
     *         batch fails closed rather than settling on a bag it was never handed.
     *
     * This used to revert with `LegCountMismatch`, and that was the strongest thing the callback
     * could say: `owed` carried no leg index, so it knew only that two legs were planned and one
     * had settled, never which one. Refusing was the only safe answer to a question it could not
     * ask.
     *
     * It can ask now, and the answer here is still no — but for the honest reason rather than the
     * structural one. Leg A settles and hands over its token A. Nothing in the route buys the
     * token B that leg A's maker is owed, because the route expected leg B to supply it. So the
     * settlement's pull finds the balance short and the whole batch unwinds.
     *
     * That is the shape every wrong route should have: a plan that no longer matches the batch
     * fails on the money, not on a count. `test_ASteppedOverLegSettlesTheRestWhenTheRouteSaysHow`
     * is the same batch with a route that names its legs, and it settles.
     */
    function test_ASteppedOverLegFailsClosedWhenTheRouteCannotCoverIt() public {
        ProveSettlement.Intent memory legA =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        ProveSettlement.Intent memory legB =
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, 2);
        legB.endTime = uint64(block.timestamp); // already over

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(legA, keyA, 1_000e18);
        reqs[1] = _req(legB, keyB, 110e18);

        // No swap buys the token B that leg A's maker is owed, so the pull finds nothing.
        vm.prank(caller);
        vm.expectRevert();
        exec.settleRing(reqs, true, ANY_FEE, _route(2, _noSwaps()));

        assertEq(tokenB.balanceOf(makerA), 0, "the surviving leg did not settle on its own");
        assertEq(tokenA.balanceOf(makerA), 1_000_000e18, "and maker A released nothing");
    }

    /**
     * @notice The same broken ring, with a fallback beside the leg that went missing. It settles.
     *
     * `test_ASteppedOverLegFailsClosedWhenTheRouteCannotCoverIt` is this exact batch without the
     * fallback: leg B is over, leg A hands over its token A, nothing buys the token B that leg
     * A's maker is owed, and the pull unwinds the lot. That failure is honest and it is also
     * avoidable, because the missing token is one a market sells.
     *
     * `WHEN_ABSENT` is what makes it expressible. The swap keyed to leg 1 is skipped along with
     * leg 1 — that is the whole point of `Swap.leg` — so before this flag there was no way to say
     * "and if leg 1 does NOT settle, buy what its maker would have supplied". The pair is
     * mutually exclusive by construction: exactly one of them runs, whatever the batch did.
     *
     * **The caller decides, not this contract.** A solver that wants an unbroken ring passes
     * `skipInvalid` false and gets exactly that, unchanged. This is a second thing a solver may
     * ask for, not a different thing it gets.
     */
    function test_AFallbackBuysWhatTheMissingLegWouldHaveSupplied() public {
        ProveSettlement.Intent memory legA =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        ProveSettlement.Intent memory legB =
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, 2);
        legB.endTime = uint64(block.timestamp); // already over

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(legA, keyA, 1_000e18);
        reqs[1] = _req(legB, keyB, 110e18);

        // Sell part of leg A's token A for the token B that leg B was going to bring, and run it
        // only because leg B is gone.
        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _sellAForB(100e18, 100e18);
        swaps[0].leg = 1 | exec.WHEN_ABSENT();

        vm.prank(caller);
        uint256 count = exec.settleRing(reqs, true, ANY_FEE, _route(2, swaps));

        assertEq(count, 1, "one leg settled, and the ring did not unwind for the other");
        assertGe(tokenB.balanceOf(makerA), 99.9e18, "maker A was paid the floor they signed");
        // Maker B sells token B, so "left alone" is their whole starting balance still theirs
        // and nothing of token A received. Asserting a zero here would have asserted the wrong
        // side of their books.
        assertEq(tokenB.balanceOf(makerB), 1_000_000e18, "the expired maker released nothing");
        assertEq(tokenA.balanceOf(makerB), 0, "and was paid nothing");
    }

    /**
     * @notice The fallback does NOT run when its leg settles, so a whole ring pays for one route.
     *
     * The other half of the pair, and the one that would go wrong quietly. A fallback that fired
     * on a healthy ring would buy a token the ring already had, spending the caller's surplus on
     * nothing and — worse — spending it out of a bag the settlement is about to pull from.
     */
    function test_AFallbackStaysOutOfTheWayWhenItsLegSettles() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        // Sized so that running it would leave the ring short and the pull would revert.
        swaps[0] = _sellAForB(1_000e18, 0);
        swaps[0].leg = 1 | exec.WHEN_ABSENT();

        vm.prank(caller);
        assertEq(exec.settleRing(reqs, true, ANY_FEE, _route(2, swaps)), 2, "both legs settled");
    }

    /**
     * @notice Several fallbacks, fired in the funding order the planner emits. #130.
     *
     * `test_AFallbackBuysWhatTheMissingLegWouldHaveSupplied` proves ONE fires. Nothing proved
     * that two can, and two is the case where the ORDER of the route stops being cosmetic —
     * `swapOrder` in `sdk/src/solver/tolerant.ts` exists for exactly this and had no contract
     * test behind it.
     *
     * **Why the order is a funding order.** Every call in a ring's route consumes one token and
     * produces the one before it, so a call has to run after whatever funds it, and the
     * dependency runs backwards round the cycle. That is invisible while nothing is missing,
     * because the settlement releases every leg before the route runs. It bites the moment one
     * fallback has to raise a token another one spends.
     *
     * The ring here is A → B → C → A on three intents. Legs 1 and 2 are over, so:
     *
     *   - leg 0 settles and hands the executor 1,000 token A;
     *   - the fallback for leg 2 sells token A for the token C that maker C is not bringing;
     *   - the fallback for leg 1 spends that token C on the token B that maker B is not bringing;
     *   - and maker A is paid the token B they signed for.
     *
     * The second one cannot run before the first. `swapOrder(3, null)` returns `[0, 2, 1]`, and
     * that is the order this route is written in — position 0's fallback first, which does not
     * fire because leg 0 settled, then 2, then 1.
     *
     * The A balance is asserted to the wei on purpose. It is what says the first fallback stayed
     * out of the way: had it fired it would have sold token B for two more token A, and the
     * caller's sweep would read 952 rather than 950.
     */
    function test_SeveralFallbacksFireInTheFundingOrderThePlannerEmits() public {
        (address makerC, uint256 keyC) = makeAddrAndKey("makerC");
        tokenC.mint(makerC, 1_000_000e18);
        tokenC.mint(address(venue), 1_000_000e18);
        vm.prank(makerC);
        tokenC.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory leg0 =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 41);
        ProveSettlement.Intent memory leg1 =
            _intent(makerB, address(tokenB), address(tokenC), 1_000e18, 100e18, 42);
        ProveSettlement.Intent memory leg2 =
            _intent(makerC, address(tokenC), address(tokenA), 1_000e18, 100e18, 43);
        leg1.endTime = uint64(block.timestamp); // already over
        leg2.endTime = uint64(block.timestamp); // and so is this one

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](3);
        reqs[0] = _req(leg0, keyA, 1_000e18);
        reqs[1] = _req(leg1, keyB, 1_000e18);
        reqs[2] = _req(leg2, keyC, 1_000e18);

        // Built before the prank, never inside it. `exec.WHEN_ABSENT()` is an external call and
        // `vm.prank` is single-shot, so composing the route inside the pranked line hands the
        // ring to the test contract and sweeps the surplus there.
        ProveBatchExecutor.Route memory route = _route3(_fundingOrder());

        vm.prank(caller);
        uint256 count = exec.settleRing(reqs, true, ANY_FEE, route);

        assertEq(count, 1, "one leg settled and the ring did not unwind for the other two");
        assertGe(tokenB.balanceOf(makerA), 99.9e18, "maker A was paid the floor they signed");
        assertEq(tokenB.balanceOf(makerB), 1_000_000e18, "the first absent maker released nothing");
        assertEq(tokenC.balanceOf(makerC), 1_000_000e18, "and neither did the second");

        // 1,000 in, 50 spent by the fallback for leg 2, and not one wei more.
        assertEq(tokenA.balanceOf(caller), 950e18, "the fallback for the settled leg stayed put");
        assertEq(tokenB.balanceOf(caller), 100e18, "and the surplus token B came home");
        assertEq(tokenC.balanceOf(caller), 0, "the token C raised was spent, all of it");
        assertEq(tokenA.balanceOf(address(exec)), 0, "nothing was left in the executor");
    }

    /**
     * @notice Two lost legs on the wrong side of the walk revert, and that is the right failure.
     *
     * **No fixed order survives two lost legs in general**, and that is a property of the cycle
     * rather than a shortcoming of `swapOrder`. The two legs either side of the walk's start
     * depend on each other in the direction the walk does not go.
     *
     * The same ring and the same route as the test above, losing legs 0 and 1 instead of 1 and 2.
     * Now the fallback for leg 0 has to spend the token B that the fallback for leg 1 would
     * raise, and `[0, 2, 1]` runs it first. It finds the executor holding no token B and the
     * transaction unwinds having settled nothing.
     *
     * That fails closed, which is the only acceptable way for a plan to be wrong about the shape
     * of its own bag. A solver reads it as a ring to stop sending, not as a loss to absorb.
     */
    function test_TwoLostLegsOnTheWrongSideOfTheWalkFailClosed() public {
        (address makerC, uint256 keyC) = makeAddrAndKey("makerC");
        tokenC.mint(makerC, 1_000_000e18);
        tokenC.mint(address(venue), 1_000_000e18);
        vm.prank(makerC);
        tokenC.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory leg0 =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 51);
        ProveSettlement.Intent memory leg1 =
            _intent(makerB, address(tokenB), address(tokenC), 1_000e18, 100e18, 52);
        ProveSettlement.Intent memory leg2 =
            _intent(makerC, address(tokenC), address(tokenA), 1_000e18, 100e18, 53);
        leg0.endTime = uint64(block.timestamp);
        leg1.endTime = uint64(block.timestamp);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](3);
        reqs[0] = _req(leg0, keyA, 1_000e18);
        reqs[1] = _req(leg1, keyB, 1_000e18);
        reqs[2] = _req(leg2, keyC, 1_000e18);

        ProveBatchExecutor.Route memory route = _route3(_fundingOrder());

        // Named, not a bare `expectRevert`. The claim is that the FIRST fallback finds the bag
        // empty, and a test that accepts any revert would pass on a ring that broke somewhere
        // else entirely.
        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSignature(
                "ERC20InsufficientBalance(address,uint256,uint256)", address(exec), 0, 50e18
            )
        );
        exec.settleRing(reqs, true, ANY_FEE, route);

        assertEq(tokenC.balanceOf(makerC), 1_000_000e18, "the surviving leg did not settle alone");
        assertEq(tokenA.balanceOf(caller), 0, "and the caller took nothing home");
    }

    /**
     * @dev The three fallbacks of the A → B → C → A ring, in `swapOrder(3, null)` order: 0, 2, 1.
     *
     * Each one sells the token its missing maker was going to RECEIVE and buys the token that
     * maker was going to SUPPLY, which is what a stand-in for a maker is. The mock venue pays two
     * out for one in, so the sizes are half of what each bound asks for.
     */
    function _fundingOrder() internal view returns (ProveBatchExecutor.Swap[] memory swaps) {
        swaps = new ProveBatchExecutor.Swap[](3);

        // Maker A supplies token A and receives token B, so their stand-in sells B for A.
        swaps[0] = _venueSwap(address(tokenB), address(tokenA), 50e18, 100e18);
        swaps[0].leg = 0 | exec.WHEN_ABSENT();
        // Maker C supplies token C and receives token A: sell A, raise C.
        swaps[1] = _venueSwap(address(tokenA), address(tokenC), 50e18, 100e18);
        swaps[1].leg = 2 | exec.WHEN_ABSENT();
        // Maker B supplies token B and receives token C: spend that C, raise the B maker A is
        // owed. This is the one that cannot run before the line above it.
        swaps[2] = _venueSwap(address(tokenC), address(tokenB), 100e18, 200e18);
        swaps[2].leg = 1 | exec.WHEN_ABSENT();
    }

    /// @dev A three-leg route, sweeping all three tokens the ring touches.
    function _route3(ProveBatchExecutor.Swap[] memory swaps)
        internal
        view
        returns (ProveBatchExecutor.Route memory)
    {
        address[] memory sweep = new address[](3);
        sweep[0] = address(tokenA);
        sweep[1] = address(tokenB);
        sweep[2] = address(tokenC);
        return ProveBatchExecutor.Route({
            legs: 3, swaps: swaps, sweep: sweep, disposal: new ProveBatchExecutor.Swap[](0)
        });
    }

    /**
     * @notice What a fallback route costs a ring that does NOT need it.
     *
     * This is the number that decides whether tolerance is worth defaulting on, and it is the one
     * nobody had. A fallback is carried on EVERY ring and paid for on every ring, to save the
     * loss on the few that lose a leg. So it only pays if
     *
     *     cost carried x (1 - p)  <  loss avoided x p
     *
     * where `p` is how often a solver loses a race. The loss avoided is measured in
     * `contracts/test/Gas.t.sol`: a three-leg ring that loses a leg costs 222,044 gas and returns
     * nothing, against 283,087 to settle one.
     *
     * **A solver pays for the sink once in their life, not once per ring.** A ring that names no
     * venue call at all mints no sink. Name one — even a fallback that cannot fire — and a
     * solver who has never called a venue buys their sink then and there. Every ring after it
     * finds the sink already minted, so a fallback costs only its calldata and its decoding.
     *
     * So there are three numbers here, and only the middle one belongs in a break-even. The
     * first ever fallback is a one-off entry fee. What a live solver carries is the steady-state
     * figure, and each extra fallback on top of it.
     *
     * The assertions are ceilings rather than equalities, because these are costs to keep an eye
     * on and not constants to pin. The measured figures are printed beside them.
     */
    function test_WhatAFallbackCostsARingThatDoesNotNeedIt() public {
        ProveBatchExecutor.Swap[] memory none = _noSwaps();
        ProveBatchExecutor.Swap[] memory one = new ProveBatchExecutor.Swap[](1);
        // Fallbacks that cannot fire, because every leg of this ring settles.
        one[0] = _sellAForB(1e18, 0);
        one[0].leg = 0 | exec.WHEN_ABSENT();
        ProveBatchExecutor.Swap[] memory two = new ProveBatchExecutor.Swap[](2);
        two[0] = one[0];
        two[1] = _sellAForB(1e18, 0);
        two[1].leg = 1 | exec.WHEN_ABSENT();

        // Warm first, and measure second. Without this the rows differ by 52,000 in the WRONG
        // direction: the first ring pays for every cold slot the later ones then reuse, so the
        // run carrying fallbacks looked cheaper than the run without them.
        {
            IProveSettlementBatch.FillRequest[] memory warm = _ring(1);
            vm.prank(caller);
            exec.settleRing(warm, true, ANY_FEE, _route(2, none));
        }

        // The caller's very first ring that names a venue, so this one buys their sink. Measured
        // before the rest, because everything after it finds the sink already there.
        uint256 everFirst;
        {
            IProveSettlementBatch.FillRequest[] memory reqs = _ring(3);
            vm.prank(caller);
            uint256 g = gasleft();
            exec.settleRing(reqs, true, ANY_FEE, _route(2, one));
            everFirst = g - gasleft();
        }

        uint256 bare;
        {
            IProveSettlementBatch.FillRequest[] memory reqs = _ring(5);
            vm.prank(caller);
            uint256 g = gasleft();
            exec.settleRing(reqs, true, ANY_FEE, _route(2, none));
            bare = g - gasleft();
        }

        uint256 carriedOne;
        {
            IProveSettlementBatch.FillRequest[] memory reqs = _ring(7);
            vm.prank(caller);
            uint256 g = gasleft();
            exec.settleRing(reqs, true, ANY_FEE, _route(2, one));
            carriedOne = g - gasleft();
        }

        uint256 carriedTwo;
        {
            IProveSettlementBatch.FillRequest[] memory reqs = _ring(9);
            vm.prank(caller);
            uint256 g = gasleft();
            exec.settleRing(reqs, true, ANY_FEE, _route(2, two));
            carriedTwo = g - gasleft();
        }

        emit log_named_uint("ring with no fallback    ", bare);
        emit log_named_uint("ring carrying one        ", carriedOne);
        emit log_named_uint("ring carrying two        ", carriedTwo);
        emit log_named_uint("the first ever, sink too ", everFirst - bare);
        emit log_named_uint("one, once the sink exists", carriedOne - bare);
        emit log_named_uint("each one after that      ", carriedTwo - carriedOne);

        assertLt(
            carriedTwo - carriedOne,
            // 20,000 until the fee-config-hash change; 20,552 measured after it (optimizer_runs
            // 1000 -> 200 makes the per-line loop a little dearer). Re-price solver.ts to match.
            22_000,
            "a fallback got dearer to carry; re-price the break-even in solver.ts before shipping"
        );
        // Dearer than the row below it by the sink lookup: a route that names no venue at all
        // does not even predict an address, and this one does.
        assertLt(
            carriedOne - bare,
            22_000,
            "a carried fallback got dearer; re-price the break-even in solver.ts before shipping"
        );
        // Paid once per solver, not once per ring. The extra over the row above is the sink,
        // which is about 41,000 on its own.
        assertLt(
            everFirst - bare,
            62_000,
            "minting a sink got dearer; re-price the break-even in solver.ts before shipping"
        );
    }

    // ── Where the surplus goes ───────────────────────────────────────────────

    /**
     * @notice A ring that earns its surplus in token A ends holding token C instead.
     *
     * The whole point of the disposal phase. A solver gets a bag of tokens for one transaction
     * and could only ever say how to BUY the far side of each trade; the surplus fell out in
     * whatever token it landed in. Naming a disposal turns that into the token it wants, inside
     * the transaction that earned it, instead of a dust balance to clear later.
     *
     * The ordering is what makes this safe rather than clever: `route.swaps` runs before the
     * settlement pulls its payments, because it is raising the tokens those payments are made in.
     * This runs after `_collect`, when nothing is owed and everything still here is the caller's.
     */
    function test_TheSurplusIsSoldIntoTheTokenTheCallerWants() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();

        // Sell one token A of the surplus for token C at the mock venue, which pays two for one.
        ProveBatchExecutor.Swap[] memory out = new ProveBatchExecutor.Swap[](1);
        out[0] = _sellAForC(1e18, 1e18);

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: _noSwaps(), sweep: _sweepAB(), disposal: out
        });
        tokenC.mint(address(venue), 100e18);

        uint256 before = tokenC.balanceOf(caller);
        vm.prank(caller);
        exec.settleRing(reqs, false, ANY_FEE, route);

        assertGt(tokenC.balanceOf(caller), before, "the caller was paid in the token it asked for");
        assertEq(tokenC.balanceOf(address(exec)), 0, "and nothing was left behind in the executor");
    }

    /**
     * @notice A disposal that cannot be made leaves the batch settled and the token unsold.
     *
     * This is the half that decides whether the feature is safe to offer at all. The fills are
     * already paid for by the time a disposal runs, so a pool that moved under the caller's own
     * tidying up must not unwind eight legs that were fine. It runs in its own frame, the failure
     * is swallowed, and the token goes home as it is.
     *
     * Here the venue holds no token C, so the swap reverts inside the frame.
     */
    function test_ADisposalThatFailsDoesNotUndoTheBatch() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();

        ProveBatchExecutor.Swap[] memory out = new ProveBatchExecutor.Swap[](1);
        out[0] = _sellAForC(1e18, 1e18);

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: _noSwaps(), sweep: _sweepAB(), disposal: out
        });
        // No token C anywhere, so the venue cannot pay and the disposal reverts in its frame.
        assertEq(tokenC.balanceOf(address(venue)), 0, "the venue has nothing to pay with");

        vm.expectEmit(true, true, false, false, address(exec));
        emit ProveBatchExecutor.SurplusUnsold(address(tokenA), address(tokenC));

        address theSink = _sinkOf(caller);
        vm.prank(caller);
        uint256 filled = exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(filled, 2, "both legs settled anyway");
        assertEq(tokenC.balanceOf(caller), 0, "and the caller got no token C");
        assertEq(tokenA.allowance(theSink, address(venue)), 0, "no allowance survived");
    }

    /**
     * @notice A disposal sized to what actually arrived, not to what the caller guessed.
     *
     * Before this, a disposal could only name a definite `amountIn`, and the surplus is not
     * known until it exists — the Dutch curve moves with the block and a leg may be stepped
     * over. Guess low and the remainder sweeps home unsold; guess high and the whole call fails.
     *
     * The venue's calldata is opaque to read and impossible to rebuild, but the caller knows
     * where its own amount sits in it. `amountOffset` is byte 4 for `swapExactTokensForTokens`,
     * straight after the selector, and byte 36 for the bound. This contract writes the measured
     * increase into the first and `amount * minOutPerIn / 1e18` into the second.
     *
     * The bound has to travel as a rate for the reason `minOutOffset` gives: patch the amount up
     * and leave a fixed floor alone and the caller has silently agreed to sell more for the same
     * money. Here the surplus is far larger than any figure written off chain, and the venue
     * still pays two for one, so a bound that did not scale would be met by a fraction of what
     * it should.
     */
    function test_ADisposalSizesItselfToTheSurplusThatArrived() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        tokenC.mint(address(venue), 10_000e18);

        // One wei named, and half a token demanded per token sold. If nothing is patched the
        // venue takes one wei and pays two; patched, it takes the whole surplus.
        ProveBatchExecutor.Swap[] memory out = new ProveBatchExecutor.Swap[](1);
        out[0] = _sellAForC(1, 1);
        out[0].amountOffset = 4;
        out[0].minOutOffset = 36;
        out[0].minOutPerIn = 0.5e18;

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: _noSwaps(), sweep: _sweepAB(), disposal: out
        });

        vm.prank(caller);
        exec.settleRing(reqs, false, ANY_FEE, route);

        // The mock pays two for one, so a surplus of any size comes back doubled. One wei in
        // would have paid two wei out.
        assertGt(tokenC.balanceOf(caller), 1e18, "the whole surplus was sold, not the wei named");
        assertEq(tokenA.balanceOf(address(exec)), 0, "and no token A was left behind");
    }

    /**
     * @notice The scaled bound refuses a bad price. It is a floor, not a formality.
     *
     * The test above proves the bound is patched. It cannot prove the bound is BINDING, because
     * the mock pays two for one and every route in this file asks for a half or less — so the
     * written figure is met with four times the headroom it needs, and a bound written as zero
     * would pass every assertion in the file. That is the whole exposure: a disposal with no
     * working floor sells the caller's surplus at whatever price the venue names, and the sale
     * looks like an honest one.
     *
     * So this route asks for a half per token and the venue pays a quarter. The correct bound is
     * `have / 2`, the venue offers `have / 4`, and the sale must not happen. The batch is already
     * settled by then, so the refusal costs the caller nothing: the surplus goes home unsold and
     * the executor says which disposal it gave up on.
     *
     * The second half is the control. Same venue, same price, same offsets — only the rate the
     * caller signed up for is lower, and the sale goes through. So the bound is what refused the
     * first one, and not the price, the patch or the venue.
     */
    function test_ADisposalRefusesAPriceBelowItsScaledBound() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        tokenC.mint(address(venue), 10_000e18);

        // The venue now pays a quarter of what it takes.
        venue.setRate(1, 4);

        // And the caller demands a half. `_sellAForC(1, 1)` writes a wei and a wei into the
        // calldata; both words are patched, so those two figures never reach the venue.
        ProveBatchExecutor.Swap[] memory out = new ProveBatchExecutor.Swap[](1);
        out[0] = _sellAForC(1, 1);
        out[0].amountOffset = 4;
        out[0].minOutOffset = 36;
        out[0].minOutPerIn = 0.5e18;

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: _noSwaps(), sweep: _sweepAB(), disposal: out
        });

        vm.recordLogs();
        vm.prank(caller);
        uint256 filled = exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(filled, 2, "both legs settled anyway");
        assertEq(tokenC.balanceOf(caller), 0, "and not one wei was sold at the venue's price");
        assertGt(tokenA.balanceOf(caller), 0, "the surplus came home unsold instead");
        assertEq(tokenA.balanceOf(address(exec)), 0, "with nothing left behind");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool said;
        for (uint256 k = 0; k < logs.length && !said; k++) {
            said = logs[k].emitter == address(exec)
                && logs[k].topics[0] == ProveBatchExecutor.SurplusUnsold.selector
                && logs[k].topics[1] == bytes32(uint256(uint160(address(tokenA))));
        }
        assertTrue(said, "and the batch said which disposal it could not make");

        // The control. A fresh ring on its own nonces, the venue still paying a quarter, and a
        // caller who asked for a fifth. Nothing else changes and the sale is made.
        //
        // `route.disposal` is the same memory array as `out`, so writing the rate here is the
        // one field this second run differs by.
        IProveSettlementBatch.FillRequest[] memory more = _ring(3);
        out[0].minOutPerIn = 0.2e18;

        uint256 beforeC = tokenC.balanceOf(caller);
        vm.prank(caller);
        exec.settleRing(more, false, ANY_FEE, route);

        assertGt(tokenC.balanceOf(caller), beforeC, "a bound the venue can meet sells");
    }

    /**
     * @notice A disposal must not sell a donation, however large the balance looks.
     *
     * The mark is the whole reason `_sweepAbove` exists: a balance this contract did not earn
     * cannot leave, so a stranger's gift cannot discharge a maker's debt or ride out in somebody
     * else's sweep. A disposal sized to the BALANCE rather than the increase would sell it, which
     * is the same leak through a different door, and the sale would look like an honest one.
     */
    function test_ADisposalSellsWhatTheBatchEarnedAndNotADonation() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        tokenC.mint(address(venue), 10_000e18);

        // A donation, sitting here before the batch runs.
        uint256 donation = 500e18;
        tokenA.mint(address(exec), donation);

        ProveBatchExecutor.Swap[] memory out = new ProveBatchExecutor.Swap[](1);
        out[0] = _sellAForC(1, 1);
        out[0].amountOffset = 4;
        out[0].minOutOffset = 36;
        out[0].minOutPerIn = 0.5e18;

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: _noSwaps(), sweep: _sweepAB(), disposal: out
        });

        vm.prank(caller);
        exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(tokenA.balanceOf(address(exec)), donation, "the donation stayed exactly put");
    }

    /**
     * @notice A disposal of a token the batch did not earn is skipped, not sent.
     *
     * The route names token C — its mark is taken and it sweeps home — but this ring never touches
     * it, so the increase above that mark is zero. Asking a venue to sell nothing would approve it
     * for zero and call it for a swap of zero, which some venues accept and price at zero, so the
     * caller pays gas for a call that can only lose.
     *
     * It also walks past tokens A and B to reach C in the route's names, which a disposal of the
     * FIRST named token never exercises.
     */
    function test_ADisposalOfATokenTheBatchDidNotEarnIsSkipped() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        tokenA.mint(address(venue), 10_000e18);

        // Token C, which this ring never touches. Named on the sweep list so it is marked and
        // walked to, and earned by nothing, so the increase above its mark is zero.
        ProveBatchExecutor.Swap[] memory out = new ProveBatchExecutor.Swap[](1);
        out[0] = _venueSwap(address(tokenC), address(tokenA), 1, 1);
        out[0].amountOffset = 4;
        out[0].minOutOffset = 36;
        out[0].minOutPerIn = 0.5e18;

        address[] memory sweep = new address[](3);
        sweep[0] = address(tokenA);
        sweep[1] = address(tokenB);
        sweep[2] = address(tokenC);
        ProveBatchExecutor.Route memory route =
            ProveBatchExecutor.Route({legs: 2, swaps: _noSwaps(), sweep: sweep, disposal: out});

        // Recorded rather than expected: the fills emit their own transfers first, and
        // `expectEmit` wants the very next event. What matters is that the swallowed failure was
        // announced somewhere in the batch, not that it was announced immediately.
        vm.recordLogs();
        vm.prank(caller);
        uint256 filled = exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(filled, 2, "both legs settled anyway");
        assertEq(tokenA.balanceOf(address(exec)), 0, "and nothing was bought with nothing");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool said;
        for (uint256 k = 0; k < logs.length && !said; k++) {
            said = logs[k].emitter == address(exec)
                && logs[k].topics[0] == ProveBatchExecutor.SurplusUnsold.selector
                && logs[k].topics[1] == bytes32(uint256(uint160(address(tokenC))));
        }
        assertTrue(said, "and the batch said which disposal it could not make");
    }

    /**
     * @notice A disposal of the second-named token finds its own mark, not the first one's.
     *
     * The same walk as above on a batch that DID earn the token, so the loop is exercised on the
     * path that proceeds rather than only on the one that gives up. A disposal that read the
     * wrong mark would sell against somebody else's balance and the sale would look ordinary.
     */
    function test_ADisposalFindsTheMarkOfItsOwnToken() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        tokenC.mint(address(venue), 10_000e18);
        // Leg two pays token A out and leg one brings token B in, so both move. Sell the token B.
        ProveBatchExecutor.Swap[] memory out = new ProveBatchExecutor.Swap[](1);
        out[0] = _sellBForC(1, 1);
        out[0].amountOffset = 4;
        out[0].minOutOffset = 36;
        out[0].minOutPerIn = 0.5e18;

        // Seed the executor with token B above its mark, so the disposal has something to find.
        tokenB.mint(address(exec), 0);
        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: _one(_sellAForB(1e18, 1e18)), sweep: _sweepAB(), disposal: out
        });

        vm.prank(caller);
        exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(tokenB.balanceOf(address(exec)), 0, "the executor kept none of the token B");
    }

    /// @notice Patching the amount without the bound is refused, because it weakens the bound.
    function test_APatchWithoutABoundIsRefused() public {
        ProveBatchExecutor.Swap memory bad = _sellAForC(1e18, 1e18);
        bad.amountOffset = 4;

        vm.prank(address(exec));
        vm.expectRevert(ProveBatchExecutor.PatchWithoutBound.selector);
        exec.sellSurplus(bad, 1e18, address(0));
    }

    /// @notice An offset past the end of the calldata is refused rather than writing past it.
    function test_APatchOffThePlotIsRefused() public {
        ProveBatchExecutor.Swap memory bad = _sellAForC(1e18, 1e18);
        bad.amountOffset = 10_000;
        bad.minOutOffset = 36;

        vm.prank(address(exec));
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveBatchExecutor.PatchOutOfRange.selector, 10_000, bad.data.length
            )
        );
        exec.sellSurplus(bad, 1e18, address(0));
    }

    /**
     * @notice `_write`'s bound is exact: a patch on the blob's last word is written, one byte
     *         further is refused (docs/AUDIT-SCOPE.md, the Yul margins).
     *
     * The calldata gets 32 bytes the router never reads, so the bound can point at the very last
     * word and the sale still goes through on the real amount patch at byte 4.
     */
    function test_APatchOnTheLastWordIsWrittenAndOneBytePastItIsRefused() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        tokenC.mint(address(venue), 10_000e18);
        ProveBatchExecutor.Swap[] memory out = new ProveBatchExecutor.Swap[](1);
        out[0] = _sellAForC(1, 1);
        out[0].data = abi.encodePacked(out[0].data, bytes32(0));
        out[0].amountOffset = 4;
        out[0].minOutOffset = out[0].data.length - 32;
        out[0].minOutPerIn = 0.5e18;

        // A separate struct: memory structs are references, and this one must not move `out[0]`.
        ProveBatchExecutor.Swap memory onePast = _sellAForC(1, 1);
        onePast.data = out[0].data;
        onePast.amountOffset = 4;
        onePast.minOutOffset = onePast.data.length - 31;
        onePast.minOutPerIn = 0.5e18;
        vm.prank(address(exec));
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveBatchExecutor.PatchOutOfRange.selector,
                onePast.data.length - 31,
                onePast.data.length
            )
        );
        exec.sellSurplus(onePast, 1e18, address(0));

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: _noSwaps(), sweep: _sweepAB(), disposal: out
        });
        vm.prank(caller);
        exec.settleRing(reqs, false, ANY_FEE, route);
        assertGt(tokenC.balanceOf(caller), 1e18, "the last-word patch was written and the sale ran");
        assertEq(tokenA.balanceOf(address(exec)), 0, "and no token A was left behind");
    }

    /**
     * @notice The buy side may not patch, because it is spending money that is owed.
     *
     * `route.swaps` runs before the settlement pulls its payments and holds tokens destined for
     * makers. Sizing a call there to "everything I hold" would reach them. Refusing says so
     * instead of ignoring the field, which would leave a caller believing it worked.
     */
    function test_TheBuySideMayNotSizeItselfToTheBalance() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();

        ProveBatchExecutor.Swap memory s = _sellAForB(1e18, 1e18);
        s.amountOffset = 4;
        s.minOutOffset = 36;
        s.minOutPerIn = 0.5e18;

        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.PatchOnTheBuySide.selector);
        exec.settleRing(reqs, false, ANY_FEE, _route(2, _one(s)));
    }

    /**
     * @notice Only this contract may reach the frame the disposal runs in.
     *
     * It is external for the `try` and for nothing else. A stranger who could call it would be
     * driving an arbitrary venue call from an address the whole design keeps clean.
     */
    function test_OnlyTheExecutorItselfMaySellSurplus() public {
        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.ForbiddenTarget.selector);
        exec.sellSurplus(_sellAForC(1e18, 1e18), 1e18, address(0));
    }

    /**
     * @notice The executor's `ANY_LEG` is the number the TypeScript encoder writes.
     *
     * `RouteWireFormatTest` checks the sentinel survives the encoding but cannot reach a deployed
     * executor to ask what it expects. This is the other end of that: agreeing on the width is
     * not enough, because a `leg` that arrived as anything else would quietly mean "run for leg
     * zero only", and a route that stops closing itself is wrong only on chain.
     */
    function test_TheExecutorsAnyLegIsTheSentinelTheEncoderWrites() public view {
        assertEq(exec.ANY_LEG(), type(uint256).max);
        // The same pairing for the patch sentinel, and it matters more: an `amountOffset` that
        // arrived as any real offset would have this contract overwrite a word of somebody's
        // venue calldata with a balance.
        assertEq(exec.NO_PATCH(), type(uint256).max);
    }

    /**
     * @notice A route that expects fewer lines than actually settled is refused.
     *
     * This is the direction that stayed fatal, and it is the dangerous one. Fewer lines than
     * planned is what skipping looks like from inside the callback and is now ordinary. MORE
     * lines than planned cannot be: the route is describing some other batch, and every swap in
     * it is sized for legs that are not the ones the settlement just credited.
     */
    function test_ARouteExpectingFewerLinesThanSettledIsRefused() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();

        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ProveBatchExecutor.LegCountMismatch.selector, 1, 2));
        exec.settleRing(reqs, false, ANY_FEE, _route(1, _noSwaps()));
    }

    /**
     * @notice The capability the leg index buys: one leg goes, the rest settle.
     *
     * The same two-leg batch as `test_ASteppedOverLegFailsClosedWhenTheRouteCannotCoverIt` — leg
     * B is already over and gets stepped over — but here the route names which leg each swap is
     * for. Leg A's swap sells the token A it releases for the token B its maker is owed, so it
     * stands on its own, and the batch settles it without leg B.
     *
     * A batch is not a ring. Six of eight arming means the caller owes those six, and the other
     * two are filled, cancelled or expired, which is somebody else's business. This is that, at
     * one of two.
     */
    function test_ASteppedOverLegSettlesTheRestWhenTheRouteSaysHow() public {
        ProveSettlement.Intent memory legA =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 11);
        ProveSettlement.Intent memory legB =
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, 12);
        legB.endTime = uint64(block.timestamp); // already over

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(legA, keyA, 1_000e18);
        reqs[1] = _req(legB, keyB, 110e18);

        // One swap, named for leg 0: sell the token A that leg releases for the token B it owes.
        ProveBatchExecutor.Swap[] memory swaps = _one(_sellAForB(1_000e18, 100e18));
        swaps[0].leg = 0;

        vm.prank(caller);
        uint256 filled = exec.settleRing(reqs, true, ANY_FEE, _route(2, swaps));

        assertEq(filled, 1, "one leg settled and the expired one was stepped over");
        assertEq(tokenB.balanceOf(makerA), 99.9e18, "maker A was paid what they signed for");
    }

    /**
     * @notice A route that does not decode is refused before anything is approved.
     *
     * `settleRing` encodes the blob itself, so this shape cannot arrive through the public
     * surface today. It is driven straight at the callback because the guard has to hold for a
     * caller that reaches `fillBatchWithCallback` some other way.
     */
    function test_ARouteThatDoesNotDecodeIsRefused() public {
        IProveBatchCallback.Payment[] memory owed = new IProveBatchCallback.Payment[](1);
        owed[0] = IProveBatchCallback.Payment({
            token: address(tokenA),
            to: makerA,
            amount: 1e18,
            fee: 0,
            feeConfig: feeCfg(feeDest),
            leg: 0,
            tokenIn: address(0),
            amountIn: 0,
            feeIn: 0,
            feeInDue: 0,
            feeProceeds: 0
        });

        vm.prank(address(settlement));
        vm.expectRevert();
        exec.proveBatchCallback(owed, hex"c0ffee");

        vm.prank(address(settlement));
        vm.expectRevert();
        exec.proveBatchCallback(owed, abi.encode(uint256(1), uint256(2)));

        assertEq(tokenA.allowance(address(exec), relayer), 0, "nothing was approved");
    }

    // ── What the arbitrary call cannot reach ─────────────────────────────────

    /**
     * @notice The attack this shape invites, and the split that closes it by construction.
     *
     * Somebody approves this contract — out of habit, or because a phishing page said to, or
     * because they approved the settlement once and assumed. An attacker then points a swap at
     * the token and says `transferFrom(victim, me, everything)`. That is Transit Swap, and it is
     * the reason `ProveCallSink` exists.
     *
     * It fails because the call does not run here. The sink makes it, and the victim never
     * approved the sink.
     */
    function test_AStandingApprovalToTheExecutorIsUnreachableFromAVenueCall() public {
        address victim = makeAddr("victim");
        address attacker = makeAddr("attacker");
        tokenA.mint(victim, 500e18);
        vm.prank(victim);
        tokenA.approve(address(exec), type(uint256).max);

        ProveBatchExecutor.Swap memory theft = ProveBatchExecutor.Swap({
            tokenIn: address(tokenA),
            amountIn: 1e18,
            tokenOut: address(tokenB),
            spender: address(venue),
            target: address(tokenA),
            data: abi.encodeCall(IERC20.transferFrom, (victim, attacker, 500e18)),
            extra: new address[](0),
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });

        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        ProveBatchExecutor.Route memory route = _route(2, _one(theft));

        vm.prank(attacker);
        vm.expectRevert();
        exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(tokenA.balanceOf(victim), 500e18, "the victim keeps everything");
        assertEq(tokenA.balanceOf(attacker), 0, "and the attacker gets nothing");
    }

    /**
     * @notice The same, through a selector no denylist would have carried.
     *
     * A share token is a plain ERC-20 to `approve`, and `redeem(shares, receiver, owner)` spends
     * the allowance without ever saying `transferFrom`. This is the case that proved a selector
     * filter could not be the answer, and it is why the boundary is an address and not a list.
     */
    function test_AnAllowanceCannotBeSpentThroughAFourSixTwoSixRedeemEither() public {
        address victim = makeAddr("victim");
        address attacker = makeAddr("attacker");
        MockVault vault = new MockVault(address(tokenB));
        tokenB.mint(address(vault), 1_000e18);
        vault.mintShares(victim, 1_000e18);

        vm.prank(victim);
        vault.approve(address(exec), type(uint256).max);

        ProveBatchExecutor.Swap memory theft = ProveBatchExecutor.Swap({
            tokenIn: address(tokenA),
            amountIn: 1e18,
            tokenOut: address(tokenB),
            spender: address(venue),
            target: address(vault),
            data: abi.encodeCall(MockVault.redeem, (1_000e18, attacker, victim)),
            extra: new address[](0),
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });

        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        ProveBatchExecutor.Route memory route = _route(2, _one(theft));

        vm.prank(attacker);
        vm.expectRevert();
        exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(vault.balanceOf(victim), 1_000e18, "the victim keeps their shares");
        assertEq(tokenB.balanceOf(attacker), 0, "and the attacker got no assets");
    }

    /**
     * @notice The tripwire. The sink is the only thing keeping this contract out of the caller's
     *         call, and nothing in the type system says so.
     *
     * `ProveSettlement.t.sol` has the same test one level up, where a fixed selector is what
     * keeps the settlement's callback inside its own rule. Here it is an address: the venue is
     * asked who called it, and the answer must be the sink and never the executor. Route the
     * call through this contract instead and every allowance ever granted to it becomes
     * spendable by whoever writes the next `swap.data`.
     */
    function test_TheSinkIsTheOnlyThingKeepingTheExecutorOutOfTheVenueCall() public {
        SenderProbe probe = new SenderProbe(tokenA, tokenB);
        tokenB.mint(address(probe), 1_000e18);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 1), keyA, 100e18
        );

        ProveBatchExecutor.Swap memory s = ProveBatchExecutor.Swap({
            tokenIn: address(tokenA),
            amountIn: 100e18,
            tokenOut: address(tokenB),
            spender: address(probe),
            target: address(probe),
            data: abi.encodeCall(SenderProbe.sell, (100e18, address(exec))),
            extra: new address[](0),
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });

        address theSink = _sinkOf(caller);
        vm.prank(caller);
        exec.settleRing(reqs, false, ANY_FEE, _route(1, _one(s)));

        assertEq(probe.lastCaller(), theSink, "this caller's own sink clone made the call");
        assertTrue(probe.lastCaller() != address(exec), "and the executor never did");
        assertTrue(probe.lastCaller() != address(exec.sinkTemplate()), "nor the shared template");
        assertEq(tokenB.balanceOf(makerA), 149.85e18, "while the trade still worked");
    }

    /// @notice The call may not be aimed at the relayer, which holds every maker's allowance.
    function test_TheCallCanNeverBeAimedAtTheRelayer() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();

        ProveBatchExecutor.Swap memory bad = _sellAForB(50e18, 0);
        bad.target = relayer;
        ProveBatchExecutor.Route memory route = _route(2, _one(bad));

        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.ForbiddenTarget.selector);
        exec.settleRing(reqs, false, ANY_FEE, route);

        // And not through the approval either.
        bad = _sellAForB(50e18, 0);
        bad.spender = relayer;
        route = _route(2, _one(bad));

        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.ForbiddenTarget.selector);
        exec.settleRing(reqs, false, ANY_FEE, route);
    }

    /// @notice Nor at the settlement, whose reentrancy guard is the only other thing in the way.
    function test_TheCallCanNeverBeAimedAtTheSettlement() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();

        ProveBatchExecutor.Swap memory bad = _sellAForB(50e18, 0);
        bad.target = address(settlement);
        ProveBatchExecutor.Route memory route = _route(2, _one(bad));

        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.ForbiddenTarget.selector);
        exec.settleRing(reqs, false, ANY_FEE, route);

        bad = _sellAForB(50e18, 0);
        bad.spender = address(settlement);
        route = _route(2, _one(bad));

        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.ForbiddenTarget.selector);
        exec.settleRing(reqs, false, ANY_FEE, route);
    }

    /// @notice Nor at the executor itself, or at the sink. The sink states that rule and this
    ///         test is what proves the executor inherits it rather than restating it.
    function test_TheCallCanNeverBeAimedAtTheExecutorOrItsSink() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        address theSink = address(exec.sinkTemplate());

        ProveBatchExecutor.Swap memory bad = _sellAForB(50e18, 0);
        bad.target = address(exec);
        ProveBatchExecutor.Route memory route = _route(2, _one(bad));

        vm.prank(caller);
        vm.expectRevert(ProveCallSink.ForbiddenTarget.selector);
        exec.settleRing(reqs, false, ANY_FEE, route);

        bad = _sellAForB(50e18, 0);
        bad.target = theSink;
        route = _route(2, _one(bad));

        vm.prank(caller);
        vm.expectRevert(ProveCallSink.ForbiddenTarget.selector);
        exec.settleRing(reqs, false, ANY_FEE, route);
    }

    // ── The mark ─────────────────────────────────────────────────────────────

    /**
     * @notice A balance already sitting here belongs to whoever left it, not to the next caller.
     *
     * Sweeping whole balances would hand a stranger a donation. Worse, the settlement pulls its
     * payments out of this contract, so a donated balance could discharge a maker's debt — and
     * `ProveSettlement` refuses to infer a payment from a balance precisely so that cannot
     * happen. Measuring here would spend that guarantee on its behalf.
     */
    function test_ADonationIsNotSweptToTheNextCaller() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        ProveBatchExecutor.Route memory route = _route(2, _noSwaps());
        tokenA.mint(address(exec), 42e18);
        tokenB.mint(address(exec), 7e18);

        vm.prank(caller);
        exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(tokenA.balanceOf(caller), 100e18, "the caller got the ring's spread only");
        assertEq(tokenB.balanceOf(caller), 10e18);
        assertEq(tokenA.balanceOf(address(exec)), 42e18, "and the donation stayed where it was");
        assertEq(tokenB.balanceOf(address(exec)), 7e18);
    }

    /**
     * @notice A donation cannot be sold at a venue either, which the sweep list alone missed.
     *
     * The first version of this contract marked only `Route.sweep`, so a stranger could name a
     * donated token as a swap's `tokenIn`, leave it off the sweep list, sell it, and carry the
     * proceeds out under a mark of zero. The proceeds were swept legitimately; the input was
     * stolen. Every swap's input token now carries a mark whether the caller asks for it back
     * or not.
     */
    function test_ADonationCannotBeSoldAtAVenueEither() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        tokenC.mint(address(exec), 100e18);

        address[] memory path = new address[](2);
        path[0] = address(tokenC);
        path[1] = address(tokenB);
        ProveBatchExecutor.Swap memory theft = ProveBatchExecutor.Swap({
            tokenIn: address(tokenC),
            amountIn: 100e18,
            tokenOut: address(tokenB),
            spender: address(venue),
            target: address(venue),
            data: abi.encodeCall(
                MockRouter.swapExactTokensForTokens,
                (100e18, 0, path, address(exec), block.timestamp)
            ),
            extra: new address[](0),
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });
        // Token C is deliberately not on the sweep list. That is what used to make it free.
        ProveBatchExecutor.Route memory route = _route(2, _one(theft));

        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.BalanceWentDown.selector);
        exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(tokenC.balanceOf(address(exec)), 100e18, "the donation is still here");
        assertEq(tokenB.balanceOf(caller), 0, "and the attacker got nothing for it");
    }

    /**
     * @notice A route that does not name an output token is refused, so no payment escapes a mark.
     *
     * The settlement pulls every line out of this contract. An output token with no mark is one
     * a maker could be paid out of a donation with, and the ring would look like an ordinary
     * fill. Naming it is what puts it under the mark, so the callback insists.
     */
    function test_ARouteThatDoesNotNameAnOutputTokenIsRefused() public {
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 1), keyA, 100e18
        );

        address[] memory sweep = new address[](1);
        sweep[0] = address(tokenA); // token B, the payout, is missing
        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 1,
            swaps: _one(_sellAForB(100e18, 150e18)),
            sweep: sweep,
            disposal: new ProveBatchExecutor.Swap[](0)
        });

        vm.prank(caller);
        vm.expectRevert(
            abi.encodeWithSelector(ProveBatchExecutor.OwedTokenNotSwept.selector, address(tokenB))
        );
        exec.settleRing(reqs, false, ANY_FEE, route);
    }

    /**
     * @notice A donation cannot pay a maker, so it cannot buy a stranger a fill.
     *
     * With the output token named the mark covers it, and this is what the mark is worth: the
     * executor takes 100 token A, has no token B of its own, and would settle the whole fill out
     * of somebody else's donated token B while the caller pocketed the token A.
     */
    function test_ADonationCannotPayForAStrangersFill() public {
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 1), keyA, 100e18
        );
        ProveBatchExecutor.Route memory route = _route(1, _noSwaps());
        tokenB.mint(address(exec), 200e18);

        vm.prank(caller);
        vm.expectRevert(ProveBatchExecutor.BalanceWentDown.selector);
        exec.settleRing(reqs, false, ANY_FEE, route);

        assertEq(tokenB.balanceOf(address(exec)), 200e18, "the donation is untouched");
        assertEq(tokenA.balanceOf(caller), 0, "and the caller kept no released token A");
        assertEq(tokenB.balanceOf(makerA), 0, "the maker was not paid with it");
    }

    /**
     * @notice A token the route names in any field comes home, and `extra` is a field.
     *
     * `route.sweep` used to be the only way home, so a tip named only in `extra` stopped at the
     * executor. That was a trap rather than a feature. The mark makes a strand permanent — a
     * later ring reads the balance before it runs and sweeps only the increase — and a strand is
     * indistinguishable from a donation, which this contract protects on purpose. So there was no
     * rescue path, and one forgotten entry cost the tokens for good.
     *
     * A caller who writes a token into `extra` has already said they want it back.
     */
    function test_ATokenNamedOnlyInExtraStillComesHome() public {
        venue.setTip(address(tokenC), 25e18);
        tokenC.mint(address(venue), 1_000e18);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 1), keyA, 100e18
        );

        ProveBatchExecutor.Swap memory s = _sellAForB(100e18, 150e18);
        s.extra = new address[](1);
        s.extra[0] = address(tokenC);

        address theSink = _sinkOf(caller);
        vm.prank(caller);
        exec.settleRing(reqs, false, ANY_FEE, _route(1, _one(s)));

        assertEq(tokenC.balanceOf(theSink), 0, "the sink handed the tip over");
        assertEq(tokenC.balanceOf(address(exec)), 0, "the executor kept none of it");
        assertEq(tokenC.balanceOf(caller), 25e18, "and the caller has it");
    }

    /**
     * @notice The donation guarantee survives the wider sweep.
     *
     * Naming more tokens must not turn this contract into a place a stranger can drain. The mark
     * is read before the ring, so a balance that was already here is not an increase and does not
     * move — even when the caller names that exact token in every field of the route.
     */
    function test_TheWiderSweepStillCannotTakeADonation() public {
        tokenC.mint(address(exec), 100e18);
        venue.setTip(address(tokenC), 25e18);
        tokenC.mint(address(venue), 1_000e18);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 1), keyA, 100e18
        );

        ProveBatchExecutor.Swap memory s = _sellAForB(100e18, 150e18);
        s.extra = new address[](1);
        s.extra[0] = address(tokenC);

        address[] memory sweep = new address[](2);
        sweep[0] = address(tokenB);
        sweep[1] = address(tokenC);

        vm.prank(caller);
        exec.settleRing(
            reqs,
            false,
            ANY_FEE,
            ProveBatchExecutor.Route({
                legs: 1, swaps: _one(s), sweep: sweep, disposal: new ProveBatchExecutor.Swap[](0)
            })
        );

        assertEq(tokenC.balanceOf(caller), 25e18, "the caller takes the tip the venue paid");
        assertEq(tokenC.balanceOf(address(exec)), 100e18, "and the donation is untouched");
    }

    /// @notice Naming it in both halves brings it all the way home.
    function test_ATokenNamedInBothHalvesReachesTheCaller() public {
        venue.setTip(address(tokenC), 25e18);
        tokenC.mint(address(venue), 1_000e18);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 1), keyA, 100e18
        );

        ProveBatchExecutor.Swap memory s = _sellAForB(100e18, 150e18);
        s.extra = new address[](1);
        s.extra[0] = address(tokenC);

        address[] memory sweep = new address[](3);
        sweep[0] = address(tokenA);
        sweep[1] = address(tokenB);
        sweep[2] = address(tokenC);

        vm.prank(caller);
        exec.settleRing(
            reqs,
            false,
            ANY_FEE,
            ProveBatchExecutor.Route({
                legs: 1, swaps: _one(s), sweep: sweep, disposal: new ProveBatchExecutor.Swap[](0)
            })
        );

        assertEq(tokenC.balanceOf(caller), 25e18, "the caller got the tip");
        assertEq(tokenC.balanceOf(address(exec)), 0, "and nothing rests here");
    }

    /// @notice A token named twice sweeps once and reverts nothing. The mark of the second pass
    ///         is the same number, and the balance is already at it.
    function test_ATokenNamedTwiceInTheSweepIsHarmless() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        address[] memory sweep = new address[](3);
        sweep[0] = address(tokenA);
        sweep[1] = address(tokenB);
        sweep[2] = address(tokenA);

        vm.prank(caller);
        exec.settleRing(
            reqs,
            false,
            ANY_FEE,
            ProveBatchExecutor.Route({
                legs: 2, swaps: _noSwaps(), sweep: sweep, disposal: new ProveBatchExecutor.Swap[](0)
            })
        );

        assertEq(tokenA.balanceOf(caller), 100e18, "swept once, not twice");
        assertEq(tokenB.balanceOf(caller), 10e18);
    }

    // ── What it owes, and what it leaves behind ──────────────────────────────

    /**
     * @notice Two lines in one token are two allowances' worth, granted once.
     *
     * The settlement pulls each line with its own directed `transferFrom`, so a token carrying
     * two lines is pulled at least twice. An allowance per line would write the second over the
     * first and the ring would revert on a pull the first line had already spent.
     */
    function test_TwoLinesInOneTokenAreBothPaid() public {
        ProveSettlement.Intent memory one =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        ProveSettlement.Intent memory two =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 2);
        ProveSettlement.Intent memory back =
            _intent(makerB, address(tokenB), address(tokenA), 250e18, 1_800e18, 3);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](3);
        reqs[0] = _req(one, keyA, 1_000e18);
        reqs[1] = _req(two, keyA, 1_000e18);
        reqs[2] = _req(back, keyB, 250e18);

        vm.prank(caller);
        assertEq(exec.settleRing(reqs, false, ANY_FEE, _route(3, _noSwaps())), 3);

        assertEq(tokenB.balanceOf(makerA), 199.8e18, "both of maker A's legs were paid");
        assertEq(tokenA.balanceOf(makerB), 1_798.2e18, "and so was maker B");
    }

    /// @notice The ring grants exactly what the settlement takes, so no allowance outlives it.
    ///         An allowance left standing on the relayer would be a claim on the next donation.
    function test_NoAllowanceSurvivesTheRing() public {
        vm.prank(caller);
        exec.settleRing(_ring(), false, ANY_FEE, _route(2, _noSwaps()));

        assertEq(tokenA.allowance(address(exec), relayer), 0, "token A allowance spent exactly");
        assertEq(tokenB.allowance(address(exec), relayer), 0, "token B allowance spent exactly");
    }

    /**
     * @notice A ring that names no venue mints no sink, so a pure credit ring pays for nothing.
     *
     * The sink costs about 41,000 gas to mint. A ring that closes on its own never touches one,
     * and `_sinkFor` returns zero rather than minting an address nothing will drive. Then the
     * caller's first ring that DOES name a venue mints it, once, for ever.
     *
     * Everything is built before its `vm.prank`, because `_ring`, `_sinkOf` and the swap helper
     * all make a staticcall and a prank is single-shot.
     */
    function test_APureCreditRingMintsNoSink() public {
        address mine = _sinkOf(caller);
        assertEq(mine.code.length, 0, "nothing stands there before the first ring");

        IProveSettlementBatch.FillRequest[] memory credit = _ring();
        ProveBatchExecutor.Route memory bare = _route(2, _noSwaps());
        vm.prank(caller);
        assertEq(exec.settleRing(credit, false, ANY_FEE, bare), 2, "the ring settled on credit");
        assertEq(mine.code.length, 0, "a credit ring bought a sink it never uses");

        IProveSettlementBatch.FillRequest[] memory selling = _ring(3);
        ProveBatchExecutor.Route memory sells = _route(2, _one(_sellAForB(50e18, 100e18)));
        vm.prank(caller);
        assertEq(exec.settleRing(selling, false, ANY_FEE, sells), 2, "the second ring settled");
        assertGt(mine.code.length, 0, "the first ring that names a venue mints the sink");
    }

    /// @notice Nothing the sink was approved for outlives the swap either.
    function test_NoVenueAllowanceSurvivesTheSwap() public {
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 100e18, 150e18, 1), keyA, 100e18
        );

        address theSink = _sinkOf(caller);
        vm.prank(caller);
        exec.settleRing(reqs, false, ANY_FEE, _route(1, _one(_sellAForB(100e18, 150e18))));

        assertEq(tokenA.allowance(theSink, address(venue)), 0, "set back to zero");
    }

    // ── Configuration, and the fee ───────────────────────────────────────────

    /// @notice The caller's fee bound covers this path too. A ring whose legs ask for more than
    ///         the caller agreed to pay does not settle.
    function test_TheFeeBoundIsHonoured() public {
        p2Rate = 0.001e18;
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        ProveBatchExecutor.Route memory route = _route(2, _noSwaps());
        // Read the rate first. `vm.expectRevert` arms the *next* call, and a view call counts —
        // so does the `hashIntent` that signing every leg above goes through.
        uint256 justUnder = uint256(reqs[0].intent.feeRate) - 1;

        vm.prank(caller);
        vm.expectRevert(ProveSettlement.FeeTooHigh.selector);
        exec.settleRing(reqs, false, justUnder, route);
    }

    /// @notice It points at the settlement it was given, and at that settlement's own relayer
    ///         and its own sink. Nothing here is compiled in.
    function test_ItTakesEverythingItKnowsFromItsConstructor() public view {
        assertEq(address(exec.settlement()), address(settlement));
        assertEq(exec.relayer(), settlement.relayer());
        assertEq(
            exec.sinkTemplate().executor(), address(exec), "the sink answers only to this executor"
        );
    }

    /// @notice An address with no code is not a settlement, and neither is one that answers
    ///         `relayer()` with nothing. Either would deploy a contract that reverts on use.
    function test_ItRefusesASettlementThatIsNotOne() public {
        // The factory deploys through a plain CREATE, so the constructor runs in an ordinary
        // frame rather than the cheatcode one `new` is rewritten into.
        BatchExecutorFactory factory = new BatchExecutorFactory();

        vm.expectRevert(ProveBatchExecutor.BadSettlement.selector);
        factory.make(address(0xDEAD));

        HollowBatchSettlement hollow = new HollowBatchSettlement();
        vm.expectRevert(ProveBatchExecutor.BadSettlement.selector);
        factory.make(address(hollow));
    }

    /// @notice Only the executor drives the sink, so nobody can borrow its call surface.
    function test_NobodyElseCanDriveTheSink() public {
        ProveCallSink s = exec.sinkTemplate();
        vm.prank(caller);
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

    // ── What it costs ────────────────────────────────────────────────────────

    /**
     * @dev The same two-leg ring, measured both ways.
     *
     * The two tests below are separate transactions on purpose. Measuring both in one frame
     * would let the first warm every slot the second reads, and the second row would then be a
     * report on the first rather than on the path it names.
     *
     * Both executors start holding one wei of each token, so neither pays the empty-slot premium
     * the other avoids. That premium is real — an address whose balance starts at zero pays about
     * 20,000 gas the first time it becomes non-zero, and is refunded when it returns to zero —
     * but it belongs to the executor's history, not to the path.
     */
    function _seedDust(address who) internal {
        tokenA.mint(who, 1);
        tokenB.mint(who, 1);
    }

    /// @notice A two-leg ring on credit: one transaction, no inventory, the venue skipped.
    function test_GasACreditRing() public {
        IProveSettlementBatch.FillRequest[] memory reqs = _ring();
        ProveBatchExecutor.Route memory route = _route(2, _noSwaps());
        _seedDust(address(exec));

        vm.prank(caller);
        uint256 g = gasleft();
        exec.settleRing(reqs, false, ANY_FEE, route);
        emit log_named_uint("credit ring, two legs, via ProveBatchExecutor", g - gasleft());
    }

    /**
     * @notice The same two legs through `fillBatch`, which needs inventory to settle them.
     *
     * `fillBatch` pays leg one before it releases leg two, so this executor has to hold token B
     * before it starts. That is the capital the credit path removes, and this row is what the
     * removal costs.
     */
    function test_GasAnInventoryRing() public {
        ProveSettlement.Intent memory legA =
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1);
        ProveSettlement.Intent memory legB =
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, 2);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest(legA, _sign(legA, keyA), 1_000e18, "");
        reqs[1] = ProveSettlement.FillRequest(legB, _sign(legB, keyB), 110e18, "");

        _seedDust(caller);
        tokenA.mint(caller, 1_000e18);
        tokenB.mint(caller, 1_000e18);
        vm.startPrank(caller);
        tokenA.approve(relayer, type(uint256).max);
        tokenB.approve(relayer, type(uint256).max);
        vm.stopPrank();

        vm.prank(caller);
        uint256 g = gasleft();
        settlement.fillBatch(reqs, false, ANY_FEE);
        emit log_named_uint("inventory ring, two legs, via fillBatch  ", g - gasleft());
    }

    /**
     * @notice A ring with a pool leg, closed inside the callback. One transaction.
     *
     * This is the row that decides whether `--amm` is worth switching over. The old path settles
     * the ring and then sends the router swap from the solver's own wallet, so it pays a second
     * transaction's 21,000 gas floor and carries the position across a block boundary.
     */
    function test_GasACreditRingWithAPoolLeg() public {
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, 1), keyA, 1_000e18
        );
        reqs[1] = _req(
            _intent(makerB, address(tokenB), address(tokenA), 100e18, 900e18, 2), keyB, 100e18
        );
        ProveBatchExecutor.Route memory route = _route(2, _one(_sellAForB(50e18, 100e18)));
        _seedDust(address(exec));

        vm.prank(caller);
        uint256 g = gasleft();
        exec.settleRing(reqs, false, ANY_FEE, route);
        emit log_named_uint("credit ring + pool leg, one transaction  ", g - gasleft());
    }

    /// @notice A ring of nothing settles nothing and touches no allowance.
    function test_AnEmptyRingSettlesNothing() public {
        IProveSettlementBatch.FillRequest[] memory none = new IProveSettlementBatch.FillRequest[](0);

        vm.prank(caller);
        assertEq(exec.settleRing(none, false, ANY_FEE, _route(0, _noSwaps())), 0);
        assertEq(tokenA.allowance(address(exec), relayer), 0);
    }
}

/**
 * @notice The blob the TypeScript encoder produces, decoded by the contract that has to read it.
 *
 * `sdk/src/solver/abi.ts` builds `Route` with viem and the settlement carries it here untouched.
 * Nothing else in the repository crosses that boundary: the Solidity tests build a route in
 * Solidity and the TypeScript tests round-trip one in TypeScript, so both can agree with
 * themselves while disagreeing with each other. A wrong encoding does not fail either — it
 * reverts on chain, at the executor's expense.
 *
 * The fixture goes the opposite way from the EIP-712 one, which `Fixture.t.sol` writes for the
 * TypeScript tests to read. Here the contract is the reader, so the bytes are committed.
 *
 * Regenerate with:
 *   node --input-type=module -e "import {encodeRoute,routerSwap} from './dist/solver/abi.js'; \\
 *     console.log(encodeRoute({legs:2n, \\
 *       swaps:[routerSwap(R,B,C,10n**18n,5n*10n**17n,X,1800000000n)], sweep:[A,B,C]}))"
 */
contract RouteWireFormatTest is Test {
    address constant TOKEN_A = 0x00000000000000000000000000000000000000AA;
    address constant TOKEN_B = 0x00000000000000000000000000000000000000bb;
    address constant TOKEN_C = 0x00000000000000000000000000000000000000cc;
    address constant ROUTER = 0x00000000000000000000000000000000000000F0;
    address constant EXECUTOR = 0x00000000000000000000000000000000000000Be;

    /// @dev `encodeRoute({legs: 2n, swaps: [routerSwap(…)], sweep: [A, B, C]})`, verbatim.
    function _blob() internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"0000000000000000000000000000000000000000000000000000000000000020"
            hex"0000000000000000000000000000000000000000000000000000000000000002"
            hex"0000000000000000000000000000000000000000000000000000000000000080"
            hex"0000000000000000000000000000000000000000000000000000000000000380"
            hex"00000000000000000000000000000000000000000000000000000000000003a0"
            hex"0000000000000000000000000000000000000000000000000000000000000001"
            hex"0000000000000000000000000000000000000000000000000000000000000020"
            hex"00000000000000000000000000000000000000000000000000000000000000bb"
            hex"0000000000000000000000000000000000000000000000000de0b6b3a7640000"
            hex"00000000000000000000000000000000000000000000000000000000000000cc"
            hex"00000000000000000000000000000000000000000000000000000000000000f0"
            hex"00000000000000000000000000000000000000000000000000000000000000f0"
            hex"0000000000000000000000000000000000000000000000000000000000000160"
            hex"00000000000000000000000000000000000000000000000000000000000002a0"
            hex"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            hex"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            hex"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
            hex"0000000000000000000000000000000000000000000000000000000000000000"
            hex"0000000000000000000000000000000000000000000000000000000000000104"
            hex"38ed17390000000000000000000000000000000000000000000000000de0b6b3"
            hex"a764000000000000000000000000000000000000000000000000000006f05b59"
            hex"d3b2000000000000000000000000000000000000000000000000000000000000"
            hex"000000a000000000000000000000000000000000000000000000000000000000"
            hex"000000be00000000000000000000000000000000000000000000000000000000"
            hex"6b49d20000000000000000000000000000000000000000000000000000000000"
            hex"0000000200000000000000000000000000000000000000000000000000000000"
            hex"000000bb00000000000000000000000000000000000000000000000000000000"
            hex"000000cc00000000000000000000000000000000000000000000000000000000"
            hex"0000000000000000000000000000000000000000000000000000000000000000"
            hex"0000000000000000000000000000000000000000000000000000000000000000"
            hex"0000000000000000000000000000000000000000000000000000000000000003"
            hex"00000000000000000000000000000000000000000000000000000000000000aa"
            hex"00000000000000000000000000000000000000000000000000000000000000bb"
            hex"00000000000000000000000000000000000000000000000000000000000000cc"
        );
    }

    function test_TheTypeScriptEncoderSpeaksWhatTheExecutorReads() public pure {
        ProveBatchExecutor.Route memory r = abi.decode(_blob(), (ProveBatchExecutor.Route));

        assertEq(r.legs, 2, "the leg count survived");
        assertEq(r.swaps.length, 1, "one venue call");
        assertEq(r.sweep.length, 3, "three tokens to bring home");
        // A ring banks its surplus in one token by construction, so `routerSwap` names no
        // disposal. The field still has to survive the encoding, because a route that decoded
        // with a phantom disposal would sell the caller's take at an address nobody chose.
        assertEq(r.disposal.length, 0, "and no disposal, which is what the encoder wrote");

        assertEq(r.sweep[0], TOKEN_A);
        assertEq(r.sweep[1], TOKEN_B);
        assertEq(r.sweep[2], TOKEN_C);

        ProveBatchExecutor.Swap memory s = r.swaps[0];
        assertEq(s.tokenIn, TOKEN_B, "sells token B");
        assertEq(s.amountIn, 1e18);
        assertEq(s.tokenOut, TOKEN_C, "for token C");
        assertEq(s.spender, ROUTER);
        assertEq(s.target, ROUTER);
        assertEq(s.extra.length, 0);
        // A ring closes as a whole, so the SDK's `routerSwap` leaves this call tied to no single
        // leg. Both sides have to agree on the sentinel, not merely on its width: a `leg` that
        // decoded as anything else here would silently become "run for leg 0 only", and a route
        // that quietly stops closing itself is the kind of wrong that only shows up on chain.
        // A ring closes as a whole, so the SDK's `routerSwap` ties this call to no single leg.
        // `test_TheExecutorsAnyLegIsTheSentinelTheEncoderWrites` is the other half of this: it
        // holds an executor and can check the contract agrees on the value.
        assertEq(s.leg, type(uint256).max, "the sentinel survived the encoding");
        // `routerSwap` builds calldata to be sent exactly as written, so nothing is patched. The
        // sentinel has to cross intact: an `amountOffset` that decoded as any real offset would
        // have this contract overwrite a word of somebody's venue call with a balance.
        assertEq(s.amountOffset, type(uint256).max, "no patch asked for");
        assertEq(s.minOutOffset, type(uint256).max, "and no bound to patch either");
        assertEq(s.minOutPerIn, 0, "and no rate");

        // The router call the sink will make, read back out of the blob. `to` is the executor,
        // because the settlement pulls every payment out of it the moment the callback returns.
        assertEq(bytes4(s.data), bytes4(0x38ed1739), "swapExactTokensForTokens");
        (uint256 amountIn, uint256 minOut, address[] memory path, address to, uint256 deadline) =
            abi.decode(_slice(s.data), (uint256, uint256, address[], address, uint256));
        assertEq(amountIn, 1e18);
        assertEq(minOut, 0.5e18);
        assertEq(path[0], TOKEN_B);
        assertEq(path[1], TOKEN_C);
        assertEq(to, EXECUTOR, "the venue pays the executor, never the solver");
        assertEq(deadline, 1_800_000_000);
    }

    /// @dev The arguments of a call, without its selector.
    function _slice(bytes memory data) private pure returns (bytes memory out) {
        out = new bytes(data.length - 4);
        for (uint256 k = 0; k < out.length; k++) {
            out[k] = data[k + 4];
        }
    }
}

/// @notice Has code and answers `relayer()`, but with nothing. A wrong address, not a typo.
contract HollowBatchSettlement {
    function relayer() external pure returns (address) {
        return address(0);
    }
}

/**
 * @notice Deploys a `ProveBatchExecutor` through a plain CREATE.
 *
 * forge rewrites `new ProveBatchExecutor(...)` written inside a test into a cheatcode, and the
 * coverage counters of a constructor that reverts in that frame are lost. Going through a
 * contract keeps the CREATE ordinary, which is the only variable this factory changes.
 */
contract BatchExecutorFactory {
    function make(address settlement) external returns (ProveBatchExecutor) {
        return new ProveBatchExecutor(settlement);
    }
}

/// @notice A venue that refuses with far more reason than anybody needs. `ProveCallSink` clips it.
contract LoudVenue {
    uint256 public constant REASON_LENGTH = 4_096;

    function shout() external pure {
        bytes memory reason = new bytes(REASON_LENGTH);
        for (uint256 k = 0; k < REASON_LENGTH; k++) {
            reason[k] = bytes1("x");
        }
        assembly ("memory-safe") {
            revert(add(reason, 0x20), mload(reason))
        }
    }
}
