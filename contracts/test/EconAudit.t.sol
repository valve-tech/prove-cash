// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, MockERC20, MockERC3009, NO_PERMIT2} from "./Mocks.sol";
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
 * @notice An ERC-20 that answers `allowance` with a revert while its owner says so. Everything
 *         else about it is ordinary, so it passes every check a board reader can make off chain.
 */
contract ChameleonToken is ERC20 {
    bool public hostile;

    constructor() ERC20("Chameleon", "CHAM") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function setHostile(bool v) external {
        hostile = v;
    }

    function allowance(address o, address s) public view override returns (uint256) {
        require(!hostile, "CHAM: no");
        return super.allowance(o, s);
    }
}

/// @notice Answers every call with three megabytes. The caller pays to copy it.
contract ReturnBomb {
    fallback() external {
        assembly ("memory-safe") {
            return(0, 3000000)
        }
    }
}

/**
 * @notice Economic and griefing findings, 2026-08-12, now written as the defence. Each test still
 *         drives its attack to completion and then asserts on the money — but the money now stays
 *         where it belongs. A failure here means the finding is open again.
 *
 * Each header keeps the narrative the audit wrote, so the reason for the shape of the code is
 * still on the page. Under it, the assertions say what the fix makes true.
 *
 * F-2 is not here. It was a sandwich against `FeeSink`'s slippage floor, and `FeeSink` is gone:
 * this repository deploys no burner and no contract here calls a router or sells anything. The
 * finding stays on the record in docs/AUDIT-SCOPE.md. Every other finding still has a
 * subject, and every test below still drives its attack to completion.
 *
 *   forge test --match-path test/EconAudit.t.sol -vv
 */
contract EconAuditTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address owner = address(0xB0B);
    /// @dev Where an unattributed token goes, and where this fixture's intents send their fee.
    address proceeds = address(0x7EA);
    address executor = address(0xE0E);
    address attacker = address(0xBAD);
    address maker;
    uint256 makerKey;

    uint256 constant AMOUNT_IN = 100_000e18;
    uint256 constant MIN_OUT = 3_000e18;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();

        tokenA.mint(maker, 10_000_000e18);
        tokenB.mint(executor, 10_000_000e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);
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
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(proceeds),
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

    function _sign(ProveSettlement.Intent memory i, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // F-1  depositFor takes a bare hash, so the first caller owns the escrow
    //      CRITICAL — economic extraction (theft) and griefing
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * FIXED. `deposit` takes the preimage, so poisoning is not expressible.
     *
     * `depositFor` keyed on a bare intent hash and handed `r.maker` to whoever called it first.
     * One wei of the correct token, front-run into the mempool ahead of the maker's own deposit,
     * made the attacker the owner of the reservation. The maker's real deposit then landed
     * *inside the attacker's reservation* — same token, so no revert warned anybody — and the
     * attacker walked it out after the cooldown. The maker could not withdraw and no executor
     * could fill.
     *
     * The hash already commits to `maker` and `tokenIn`, so the preimage settles both. The
     * attacker's wei is now a gift to the maker and nothing more.
     */
    function test_F1a_FrontRunningDepositForStealsTheWholeEscrow() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i, makerKey);
        bytes32 h = settlement.hashIntent(i);

        // The maker's deposit is in the mempool. The attacker still gets in front of it.
        tokenA.mint(attacker, 1);
        vm.startPrank(attacker);
        tokenA.approve(relayer, type(uint256).max);
        settlement.deposit(i, 1);
        vm.stopPrank();

        assertEq(settlement.reserved(h), 1, "a gift to the maker, not a claim on the slot");

        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);
        assertEq(settlement.reserved(h), AMOUNT_IN + 1, "the maker funded their own intent");

        // The attacker cannot start the cooldown, and cannot collect.
        vm.startPrank(attacker);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.withdraw(i);
        vm.stopPrank();

        // The fill the maker signed goes through.
        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(tokenA.balanceOf(executor), AMOUNT_IN, "the executor took token A");
        assertEq(
            tokenB.balanceOf(maker),
            MIN_OUT - (MIN_OUT * uint256(0.001e18)) / 1e18,
            "the maker was paid the signed rate, less their own fee"
        );
        assertEq(tokenA.balanceOf(attacker), 0, "the attacker is out one wei and nothing else");
    }

    /**
     * FIXED. No argument is left with which to name a foreign token.
     *
     * The gasless mode needed no race at all. An EIP-3009 intent is broadcast to the public board
     * with no deposit behind it, so its hash is common knowledge before any reservation exists.
     * One wei of a token the attacker minted for free claimed the slot, and `r.token` and
     * `r.maker` were never cleared — not by `withdraw`, not by anything — so the intent hash was
     * dead for ever. The maker's only recovery was to re-sign under a fresh nonce, which the
     * attacker poisoned again for another wei.
     *
     * `deposit` now moves `i.tokenIn`. The attacker holds none of it, so the poisoning
     * transaction dies inside the real token before it reaches any state of ours.
     */
    function test_F1b_OneWeiOfJunkBricksAGaslessIntentForever() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, 1_000_000e18);

        ProveSettlement.Intent memory i = _intent();
        i.tokenIn = address(auth);
        i.amountIn = 10_000e18;
        i.flags = settlement.FLAG_ESCROW();
        i.nonce = 7;
        bytes memory sig = _sign(i, makerKey);
        bytes32 h = settlement.hashIntent(i);
        ProveSettlement.Authorization memory a = _authFor(auth, i.amountIn, h);

        // Free-to-mint junk. The attacker reads `h` off the board and finds nowhere to put it.
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        junk.mint(attacker, 1);
        vm.startPrank(attacker);
        junk.approve(relayer, type(uint256).max);
        auth.approve(relayer, type(uint256).max);
        vm.expectRevert(); // the 3009 token refuses: the attacker holds none of it
        settlement.deposit(i, 1);
        vm.stopPrank();

        assertEq(settlement.reserved(h), 0, "the slot is untouched");

        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, i.amountIn, a, ANY_FEE);

        assertEq(auth.balanceOf(executor), i.amountIn, "the gasless fill went through");
        assertEq(settlement.reserved(h), 0, "and spent the whole redemption");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // F-3  `skipInvalid` skips the reasons it knows and nothing else
    //      HIGH — griefing
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * FIXED. The token probes are metered, so a hostile answer is a reason.
     *
     * `_evaluate`'s deep branch calls `allowance` and `balanceOf` on a token the *intent author*
     * chose. A token that reverted there took the whole batch with it, because a revert is not a
     * `Reason`. Note where in the order this lands: the token is probed before the signature is
     * checked, so the griefer does not even need a valid signature — 65 bytes of zero will do.
     *
     * Both probes are now `staticcall`s under a gas cap, and any failure reads as
     * `Reason.EscrowShort`. The griefer's intent is stepped over and the honest one fills.
     */
    function test_F3a_OneHostileTokenKillsTheWholeBatch() public {
        ChameleonToken hostile = new ChameleonToken();
        hostile.setHostile(true);
        (address griefer,) = makeAddrAndKey("griefer");
        hostile.mint(griefer, 1_000e18);

        ProveSettlement.Intent memory good = _intent();
        bytes memory goodSig = _sign(good, makerKey);

        ProveSettlement.Intent memory bad = _intent();
        bad.maker = griefer;
        bad.recipient = griefer;
        bad.tokenIn = address(hostile);
        bad.amountIn = 1_000e18;
        bad.nonce = 42;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: bad,
            signature: new bytes(65), // not even a signature
            take: 1_000e18,
            arming: ""
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: good, signature: goodSig, take: AMOUNT_IN, arming: ""
        });

        assertEq(
            uint256(settlement.fillability(bad, new bytes(65), 1_000e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.EscrowShort),
            "a token that will not answer is a reason"
        );

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 1, "the batch survived");
        assertEq(
            settlement.filled(settlement.hashIntent(good)), AMOUNT_IN, "the honest fill landed"
        );
    }

    /**
     * FIXED, by the same meter. The chameleon no longer needs catching in advance.
     *
     * "Simulate first" was the answer the design gave to F-3a, and it did not hold. The token is
     * the griefer's code: it can be benign when the executor simulates and hostile one transaction
     * later, in the same block, for the price of a 30k-gas flag write.
     *
     * That is still true, and it no longer matters. Whichever way the token answers at execution
     * time, the worst it can do is drop itself out of the batch.
     */
    function test_F3b_SimulateThenSubmitDoesNotSurviveAChameleon() public {
        ChameleonToken cham = new ChameleonToken();
        (address griefer, uint256 grieferKey) = makeAddrAndKey("griefer");
        cham.mint(griefer, 1_000e18);
        vm.prank(griefer);
        cham.approve(relayer, type(uint256).max);
        tokenB.mint(executor, 1_000e18);

        ProveSettlement.Intent memory good = _intent();
        bytes memory goodSig = _sign(good, makerKey);

        ProveSettlement.Intent memory cha = _intent();
        cha.maker = griefer;
        cha.recipient = griefer;
        cha.tokenIn = address(cham);
        cha.amountIn = 1_000e18;
        cha.minOutStart = 1e18;
        cha.minOutEnd = 1e18;
        cha.nonce = 43;
        bytes memory chaSig = _sign(cha, grieferKey);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: cha, signature: chaSig, take: 1_000e18, arming: ""
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: good, signature: goodSig, take: AMOUNT_IN, arming: ""
        });

        // The executor's simulation, one block before inclusion.
        uint256 snap = vm.snapshotState();
        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 2, "simulation says both fill");
        vm.revertToState(snap);

        // The griefer flips the flag while the batch waits in the mempool.
        cham.setHostile(true);

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 1, "the chameleon dropped out alone");
        assertEq(
            settlement.filled(settlement.hashIntent(good)), AMOUNT_IN, "the honest fill landed"
        );
    }

    /**
     * FIXED. One word is copied, so three megabytes cost what one word costs.
     *
     * The same probe, unmetered. `_validSignature` caps its ERC-1271 staticcall at 60,000 gas,
     * but the token probes in `_evaluate` were plain high-level calls: Solidity copied the whole
     * return buffer into memory before it looked at it. Three megabytes of returndata was
     * quadratic memory expansion in both frames.
     *
     * Measured before the fix: an honest batch cost 149,294 gas and the bombed one cost 9,846,699
     * and reverted. The `returndatacopy` of one word, under a 30,000-gas cap, is what closed it.
     */
    function test_F3c_AReturnBombBurnsTheExecutorsWholeGasBudget() public {
        ReturnBomb bomb = new ReturnBomb();
        (address griefer,) = makeAddrAndKey("griefer");

        ProveSettlement.Intent memory good = _intent();
        bytes memory goodSig = _sign(good, makerKey);

        ProveSettlement.Intent memory bad = _intent();
        bad.maker = griefer;
        bad.recipient = griefer;
        bad.tokenIn = address(bomb);
        bad.amountIn = 1_000e18;
        bad.nonce = 44;

        ProveSettlement.FillRequest[] memory clean = new ProveSettlement.FillRequest[](1);
        clean[0] = ProveSettlement.FillRequest({
            intent: good, signature: goodSig, take: AMOUNT_IN, arming: ""
        });

        ProveSettlement.FillRequest[] memory bombed = new ProveSettlement.FillRequest[](2);
        bombed[0] = ProveSettlement.FillRequest({
            intent: bad, signature: new bytes(65), take: 1_000e18, arming: ""
        });
        bombed[1] = ProveSettlement.FillRequest({
            intent: good, signature: goodSig, take: AMOUNT_IN, arming: ""
        });

        uint256 snap = vm.snapshotState();
        vm.prank(executor);
        uint256 g0 = gasleft();
        settlement.fillBatch(clean, true, ANY_FEE);
        uint256 honestGas = g0 - gasleft();
        vm.revertToState(snap);

        vm.prank(executor);
        g0 = gasleft();
        (bool ok,) = address(settlement).call{gas: 10_000_000}(
            abi.encodeCall(ProveSettlement.fillBatch, (bombed, true, ANY_FEE))
        );
        uint256 burned = g0 - gasleft();

        emit log_named_uint("F-3c honest batch gas", honestGas);
        emit log_named_uint("F-3c bombed batch gas", burned);
        assertTrue(ok, "the batch survived");
        // Relative, not absolute: the coverage build runs unoptimised and every number moves.
        // One capped probe is what the bomb buys, and that is less than one more honest fill.
        assertLt(burned, 2 * honestGas, "the bomb bought the griefer one capped probe");
        assertEq(
            settlement.filled(settlement.hashIntent(good)), AMOUNT_IN, "the honest fill landed"
        );
    }

    /**
     * FIXED. An unbounded price is now `Reason.BadTerms_`, which `skipInvalid` does catch.
     *
     * No hostile token needed, only a hostile number. `minOutStart` is a free field in a signed
     * struct, and `_quote` multiplied it by `take` without a bound. Two wei of a real token in
     * escrow was enough to get past every `Reason` in `_evaluate` and land on a panic that
     * `skipInvalid` cannot catch.
     *
     * `_evaluate` now bounds `minOutStart` and `amountIn` at `uint128`, so their product stays
     * inside a word. Two calldata comparisons, alongside the rising-minimum test they belong with.
     */
    function test_F3d_AnUnboundedPriceIsAPanicNotAReason() public {
        (address griefer, uint256 grieferKey) = makeAddrAndKey("griefer");
        tokenA.mint(griefer, 2);

        ProveSettlement.Intent memory bomb = _intent();
        bomb.maker = griefer;
        bomb.recipient = griefer;
        bomb.amountIn = 2;
        bomb.minOutStart = 2 ** 255;
        bomb.minOutEnd = 2 ** 255;
        bomb.flags = settlement.FLAG_ESCROW();
        bomb.nonce = 45;
        bytes memory bombSig = _sign(bomb, grieferKey);

        vm.startPrank(griefer);
        tokenA.approve(relayer, type(uint256).max);
        settlement.deposit(bomb, 2);
        vm.stopPrank();

        // The validator names it now, instead of walking into a panic.
        assertEq(
            uint256(settlement.fillability(bomb, bombSig, 2, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.BadTerms_),
            "an unbounded price is a reason"
        );

        ProveSettlement.Intent memory good = _intent();
        bytes memory goodSig = _sign(good, makerKey);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] =
            ProveSettlement.FillRequest({intent: bomb, signature: bombSig, take: 2, arming: ""});
        reqs[1] = ProveSettlement.FillRequest({
            intent: good, signature: goodSig, take: AMOUNT_IN, arming: ""
        });

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 1, "the batch survived");
        assertEq(
            settlement.filled(settlement.hashIntent(good)), AMOUNT_IN, "the honest fill landed"
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // F-4  cancel and invalidateBefore walk straight past the escrow cooldown
    //      SUPERSEDED 2026-08-14 — there is no cooldown left to walk past
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * WITHDRAWN, not fixed. The finding was real against the design of the time and the design
     * changed underneath it.
     *
     * F-4 said a cancellation should not outrun the notice an executor was promised, because an
     * executor who had already bought token B would be left holding it. That premise depended on
     * an executor who commits capital in one transaction and fills in another. Every path this
     * contract ships settles in a single transaction — `fill` for an executor holding inventory,
     * `fillWithCallback` for one holding none — and a single transaction cannot be front-run by
     * the maker. It fills at the signed rate or it reverts and nothing moved.
     *
     * So the notice protected only an executor who chose the exposed path when an atomic one was
     * available, and it charged every maker two transactions and a wait to get their own money
     * back. It is gone. `cancel`, `invalidateBefore` and `withdraw` all bite on the block they
     * land, on every custody mode.
     *
     * What replaces the protection is the thing that always did the real work: atomicity.
     */
    function test_F4_EveryWayOutIsImmediateNowAndAtomicityIsWhatProtectsTheExecutor() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i, makerKey);
        bytes32 h = settlement.hashIntent(i);

        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);
        assertEq(
            uint256(settlement.fillability(i, sig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "funded and fillable"
        );

        // Cancel lands and the intent is dead in the same block. No deferral anywhere.
        vm.prank(maker);
        settlement.cancel(i);
        assertEq(settlement.cancelledAt(h), uint64(block.timestamp), "immediate, not deferred");

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.IsCancelled.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        // The executor lost gas and nothing else: the release is inside the same transaction as
        // the payment, so a fill that cannot complete never moved a token.
        assertEq(settlement.reserved(h), AMOUNT_IN, "the maker's escrow never left");
        assertEq(tokenA.balanceOf(executor), 0, "and the executor was handed nothing");

        // The maker takes it back in one call, with no unlock step and no wait.
        vm.prank(maker);
        settlement.withdraw(i);
        assertEq(settlement.reserved(h), 0, "one transaction out");
    }

    /**
     * WITHDRAWN with F-4a, and for the same reason. `invalidateBefore` used to carry an
     * effective-at time so a wholesale kill could not outrun the notice either. The notice is
     * gone, so the field is gone, and the nonce floor is one number that bites at once.
     */
    function test_F4b_InvalidateBeforeIsImmediateAndKeepsTheEscrowRecoverable() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i, makerKey);
        bytes32 h = settlement.hashIntent(i);

        vm.startPrank(maker);
        settlement.deposit(i, AMOUNT_IN);
        settlement.invalidateBefore(i.nonce + 1);
        vm.stopPrank();

        assertEq(settlement.nonceFloor(maker), i.nonce + 1, "the floor is a plain number");
        assertEq(
            uint256(settlement.fillability(i, sig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.NonceTooLow),
            "dead on the block it landed"
        );

        // Killing the signature does not strand the money.
        vm.prank(maker);
        settlement.withdraw(i);
        assertEq(settlement.reserved(h), 0, "still recoverable in one call");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // F-5  a matured cooldown never re-arms, so it matures into a free option
    //      OPEN BY DESIGN, 2026-08-14 — it is now permanent and universal
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * NOT FIXED, and the commit that removed the cooldown said otherwise. Recording that.
     *
     * F-5 was that a matured reservation is simultaneously fillable and withdrawable, so the
     * maker holds an American option on their own intent: let it fill when the market moves their
     * way, withdraw in front of the fill when it does not, and the executor pays gas either way.
     * The fix closed the withdrawal window so the option expired and had to be re-armed.
     *
     * Removing the cooldown removed the arming step, and the commit reasoned that "a free option
     * needs an armed state". That is wrong. The arming was never the finding — the simultaneity
     * was, and the arming was the only thing that ever made it intermittent. Every escrow intent
     * is now permanently in the state F-5 rated MEDIUM.
     *
     * It stays, because the alternative is worse and because the same option was always free in
     * allowance custody, which this test measures. The cooldown was taxing every escrow maker to
     * close a hole that stayed wide open one rung down. What is not defensible is calling it
     * fixed, so this section says open.
     */
    function test_F5_TheMakersFreeOptionIsPermanentNowAndCostsTheSameInBothCustodyModes() public {
        ProveSettlement.Intent memory escrowed = _intent();
        escrowed.flags = settlement.FLAG_ESCROW();
        escrowed.endTime = uint64(block.timestamp + 30 days);
        bytes memory escrowSig = _sign(escrowed, makerKey);
        bytes32 h = settlement.hashIntent(escrowed);

        vm.prank(maker);
        settlement.deposit(escrowed, AMOUNT_IN);

        // Fillable and withdrawable at the same instant, with no waiting and no re-arming.
        assertEq(
            uint256(settlement.fillability(escrowed, escrowSig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "fillable"
        );
        uint256 gasBefore = gasleft();
        vm.prank(maker);
        settlement.withdraw(escrowed);
        uint256 escrowGrief = gasBefore - gasleft();
        assertEq(settlement.reserved(h), 0, "and withdrawable, in the same breath");

        // The same option, in allowance custody, where it was never closed at all.
        ProveSettlement.Intent memory loose = _intent();
        loose.nonce = 77;
        gasBefore = gasleft();
        vm.prank(maker);
        tokenA.approve(settlement.relayer(), 0);
        uint256 allowanceGrief = gasBefore - gasleft();

        emit log_named_uint("escrow: withdraw            ", escrowGrief);
        emit log_named_uint("allowance: revoke           ", allowanceGrief);

        /*
         * Both are one transaction, which is the point: the deposit buys firmness for exactly one
         * block either way, and the badge should not claim more than that.
         *
         * They are not the same price, and an economic review that reported them as identical at
         * ~13.1k each does not reproduce here. Revoking is ~6.7k. Withdrawing is ~34k, because it
         * now writes `cancelledAt` as well — an intent is armed by its deposit and undoing that
         * undoes the offer, which costs a storage word on the way out.
         *
         * So griefing an escrow offer costs the maker five times what griefing an allowance offer
         * does, and it is the *only* one of the two that actually ends the offer. Revoking an
         * allowance is the dormant case all over again: re-approve and every old signature is
         * live. Neither number is large enough to deter anybody; the asymmetry is the interesting
         * part, and it runs in escrow's favour.
         */
        /*
         * Ordering only, never a magnitude. `forge coverage` compiles with the optimizer off, so
         * every absolute figure moves — this very line asserted `< 40_000` and failed coverage at
         * 41,111 while passing `forge test` at 12,237. `Gas.t.sol` asserts nothing at all for the
         * same reason, and the checkpoint note lists this as a standing trap. The numbers above
         * are printed for a human; only the comparison is a test.
         */
        assertLt(allowanceGrief, escrowGrief, "revoking is the cheaper grief");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // F-6  the executor signs no fee bound
    //      LOW/MEDIUM — economic extraction by the owner
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * DISSOLVED, and then fixed anyway. The owner holds no fee dial to raise.
     *
     * The finding was that `fill` read a floor out of storage at execution time, so an owner
     * could raise it under a transaction an executor had already priced. There is no floor now
     * and no storage read: the rate is signed into the intent, which means an executor who has
     * read the intent has read the price.
     *
     * `maxFeeRate` survives, because an executor filling from a list has not read every intent.
     * A leg that asks for more than they will pay is refused rather than filled at the higher
     * rate, and the executor pays exactly what they priced.
     */
    function test_F6_AnIntentCannotChargeMoreThanTheExecutorPriced() public {
        ProveSettlement.Intent memory i = _intent();
        i.feeRate = 0.005e18;
        i.feeRateProceeds = 0; // the caller's bound is on P1 + P2, the solver-borne points
        bytes memory sig = _sign(i, makerKey);

        uint256 quotedFee = settlement.quote(i, AMOUNT_IN, block.timestamp).feeOut;

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.FeeTooHigh.selector);
        settlement.fill(i, sig, AMOUNT_IN, uint256(i.feeRate) - 1);

        // The book, not the balance. A fee is booked to the destination at fill time and moves
        // only when somebody calls `claim`, so the balance would read zero here whatever the
        // executor paid.
        uint256 before = settlement.pendingFees(feeCfg(proceeds), address(tokenB));
        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, i.feeRate);
        uint256 paid = settlement.pendingFees(feeCfg(proceeds), address(tokenB)) - before;

        emit log_named_decimal_uint("F-6 fee quoted", quotedFee, 18);
        emit log_named_decimal_uint("F-6 fee paid  ", paid, 18);
        assertEq(paid, quotedFee, "the executor paid exactly what they priced");
    }

    // ═════════════════════════════════════════════════════════════════════════
    // E-5  the fee is voluntary for anybody who can coordinate
    //      ACCEPTED outside the contract. Inside it, every fill is charged the rate on its
    //      gross, and a fill too small for the rate to reach is charged nothing.
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * FIXED. A rate above one is `Reason.BadTerms_`, and it used to be an arithmetic panic.
     *
     * `_quote` carves the fee out of the gross and subtracts, so a `feeRate` above `WAD` makes
     * `fee` larger than `gross` and `gross - fee` panics. A panic is not a `Reason`: `skipInvalid`
     * cannot step over it, so one signature carrying an absurd rate took every other leg of a
     * batch with it. `uint64` against a `WAD` denominator reaches 1,844%, so the field allowed it
     * and nothing else refused it.
     *
     * `_termsOk` refuses the intent now. It reads `i.feeRate` rather than `_rateOf(i)`, so an
     * intent that names nowhere is refused too — the maker could have written `feeRate = 0`.
     */
    function test_F3e_ARateAboveOneIsAReasonNotAPanic() public {
        (address griefer, uint256 grieferKey) = makeAddrAndKey("rateGriefer");
        tokenA.mint(griefer, AMOUNT_IN);

        ProveSettlement.Intent memory bomb = _intent();
        bomb.maker = griefer;
        bomb.recipient = griefer;
        bomb.feeRateProceeds = 1.5e18;
        bomb.nonce = 46;
        bytes memory bombSig = _sign(bomb, grieferKey);

        vm.prank(griefer);
        tokenA.approve(relayer, type(uint256).max);

        // The validator names it before any money moves, and `quote` no longer walks into a panic
        // for anyone who asks it what the leg is worth.
        assertEq(
            uint256(settlement.fillability(bomb, bombSig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.BadTerms_),
            "a rate above one is a reason"
        );

        ProveSettlement.Intent memory good = _intent();
        bytes memory goodSig = _sign(good, makerKey);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: bomb, signature: bombSig, take: AMOUNT_IN, arming: ""
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: good, signature: goodSig, take: AMOUNT_IN, arming: ""
        });

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 1, "the batch stepped over it");
        assertEq(
            settlement.filled(settlement.hashIntent(good)), AMOUNT_IN, "the honest fill landed"
        );

        // And the single fill refuses rather than panicking.
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadTerms.selector);
        settlement.fill(bomb, bombSig, AMOUNT_IN, ANY_FEE);
    }

    /**
     * The fee was never the protocol's, and now it is not the protocol's in the code either. The
     * claim that survives is about rounding rather than about revenue: an intent that signs a
     * rate is charged that rate on the gross of every fill.
     *
     * **The rounding direction reversed, and the finding it answered partly reopened.** `_quote`
     * used to ceiling-divide the fee so that a one-wei delivery owed one wei. It floor-divides
     * now, because the fee comes out of the maker's own number and the dust of the split belongs
     * to the party that signed. So an executor who splits a fill small enough pays no fee at all.
     *
     * That is a real avoidance route and it is priced out rather than closed. At ten basis points
     * a fill has to stay under a gross of 1,000 wei to charge nothing, so avoiding one token of
     * fee costs about 1e15 fills of roughly 100,000 gas each. A maker who cares can also set
     * `minFill`. The protocol earns nothing from a fill either way, so the loss falls on a
     * destination the maker chose, and the maker keeps every wei of it.
     */
    function testFuzz_E5_EveryFillPaysTheRateOnItsGross(uint256 take) public {
        take = bound(take, 1, AMOUNT_IN);
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);

        TakePoints.Quote memory q_fee = settlement.quote(i, take, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        uint256 gross = delivered + fee;
        assertGt(gross, 0, "the contract quoted a delivery of nothing");
        assertEq(
            fee, (gross * i.feeRateProceeds) / settlement.WAD(), "the rate on the gross, floored"
        );

        // Read the fee first. `vm.prank` is single-shot, and a call inside the pranked line
        // spends it — the fill would then come from this contract, which has no allowance.
        uint64 rate = i.feeRate;
        uint256 before = settlement.pendingFees(feeCfg(proceeds), address(tokenB));
        uint256 makerBefore = tokenB.balanceOf(maker);
        vm.prank(executor);
        settlement.fill(i, sig, take, rate);
        uint256 paid = settlement.pendingFees(feeCfg(proceeds), address(tokenB)) - before;

        assertEq(paid, fee, "the destination was charged something other than the quote");
        assertEq(tokenB.balanceOf(maker) - makerBefore, gross - paid, "the maker keeps the rest");
        // And the money is reachable. Charged but unclaimable would satisfy the two above.
        assertEq(claimFor(settlement, proceeds, address(tokenB)), before + paid, "and it comes out");
    }

    /**
     * The smallest fill the contract accepts, and the floor-rounded fee lets it through free.
     *
     * One wei of token A against this curve grosses one wei of token B. Ten basis points of that
     * is 0.001 wei, which floors to nothing. The ceiling used to make it one, and this test used
     * to be `test_E5_ADustFillStillPaysTheFee` asserting exactly that.
     *
     * The wei goes to the maker, which is the direction the split chose deliberately: the fee
     * comes out of the number the maker signed, so the rounding decides whose money it is and it
     * answers "the signer's". A protocol that earns nothing from a fill has nothing to lose here.
     */
    function test_E5_ADustFillPaysNoFeeAndTheMakerKeepsTheWei() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);

        uint64 rate = i.feeRate;
        uint256 before = settlement.pendingFees(feeCfg(proceeds), address(tokenB));
        uint256 makerBefore = tokenB.balanceOf(maker);
        vm.prank(executor);
        settlement.fill(i, sig, 1, rate);

        assertEq(
            settlement.pendingFees(feeCfg(proceeds), address(tokenB)) - before,
            0,
            "a dust fill was charged a fee the rate does not reach"
        );
        assertEq(tokenB.balanceOf(maker) - makerBefore, 1, "and the maker kept the whole wei");
    }

    /**
     * And an intent that names no destination is charged nothing. That is the whole of the switch
     * now — there is no second path that keeps charging, and none that keeps paying.
     */
    function test_E5_TheFeeOffMeansTheFeeOff() public {
        ProveSettlement.Intent memory i = _intent();
        i.feeConfig = bytes32(0);
        // A positive rate with no sink is refused as bad terms. The fee is off at a zero rate.
        i.feeRateProceeds = 0;
        bytes memory sig = _sign(i, makerKey);

        uint256 before = settlement.pendingFees(feeCfg(proceeds), address(tokenB));
        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, 0);

        assertEq(
            settlement.pendingFees(feeCfg(proceeds), address(tokenB)),
            before,
            "the destination was charged with the fee off"
        );
        assertEq(tokenB.balanceOf(proceeds), 0, "and paid nothing");
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _authFor(MockERC3009 auth, uint256 value, bytes32 nonce)
        internal
        view
        returns (ProveSettlement.Authorization memory a)
    {
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        a.nonce = nonce;
        bytes32 structHash = keccak256(
            abi.encode(
                auth.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                maker,
                address(settlement),
                value,
                a.validAfter,
                a.validBefore,
                a.nonce
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", auth.DOMAIN_SEPARATOR(), structHash));
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(makerKey, digest);
        a.signature = abi.encodePacked(ar, as_, av);
    }
}
