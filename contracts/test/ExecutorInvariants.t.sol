// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
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
import {ProveBatchExecutor} from "../src/ProveBatchExecutor.sol";
import {ProveCallSink} from "../src/ProveCallSink.sol";
import {MockERC20, NO_PERMIT2} from "./Mocks.sol";
import {RingHandler} from "./handlers/RingHandler.sol";

/**
 * @notice What must hold of `ProveBatchExecutor` after any sequence of rings, refusals,
 *         arming attempts, donations and time skips the fuzzer can invent.
 *
 * The headline claim is one sentence: this address never spends a balance it did not earn in the
 * same transaction. A unit test shows that of one donation and one ring. It cannot show it of a
 * donation made early, three unrelated rings later, and a fourth ring that names the donated
 * token in every field of its route. That ordering is what this file buys.
 *
 * The handler bounds the inputs. Nothing here bounds the order.
 *
 * Each `invariant_` function is its own fuzzing campaign, so related statements share one where
 * they are the same rule read twice. Eight campaigns of sixty-four calls is the budget this file
 * spends; splitting every assertion out would multiply the run time without widening the search.
 */
contract ExecutorInvariantsTest is Test {
    ProveSettlement settlement;
    ProveBatchExecutor exec;
    ProveCallSink sink;
    RingHandler handler;

    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 tokenC;

    address constant OWNER = address(0xB0B);
    address constant FEE_SINK = address(0x5152);

    /// @dev `_entered` is the executor's only storage variable, so the guard lives in slot 0.
    ///      `forge inspect ProveBatchExecutor storage` says so, and this suite reads the slot
    ///      directly because the contract keeps the variable private.
    bytes32 constant GUARD_SLOT = bytes32(uint256(0));

    function setUp() public {
        vm.warp(1_700_000_000);
        settlement = newSettlement(NO_PERMIT2);
        exec = new ProveBatchExecutor(address(settlement));
        sink = exec.sinkTemplate();

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenC = new MockERC20("C", "C", 18);

        handler = new RingHandler(settlement, exec, tokenA, tokenB, tokenC);
        targetContract(address(handler));
    }

    /// @dev The tokens, in the order the handler's books name them. The fourth is the one no
    ///      maker approved: a ring reaches it through the permit a solver carries, or not at all.
    uint256 constant TOKENS = 4;

    function _token(uint256 k) internal view returns (MockERC20) {
        if (k == 0) return tokenA;
        if (k == 1) return tokenB;
        if (k == 2) return tokenC;
        return MockERC20(address(handler.permitToken()));
    }

    // ── The mark ─────────────────────────────────────────────────────────────

    /**
     * @notice The headline, and the sharper form of it, in one statement per token.
     *
     * `settleRing` marks the balance of every token the route names before the ring, and
     * `_sweepAbove` hands on only what came in above that mark. So a donation survives every ring
     * that runs after it — that is the first assertion, and it is the one the design argues for.
     *
     * The equality says the rest: the executor holds nothing else. It holds nothing between
     * transactions, so every wei still here is either a donation or something a ring failed to
     * hand on, and every route this handler writes names all four tokens. That makes the second
     * assertion the strict reading of "everything a settled ring owed was swept" — the token an
     * armed leg released included, which is the one no maker ever approved.
     *
     * Both need a donation and a later unrelated ring in the same run, which is why no single
     * test reaches them.
     */
    function invariant_ADonationIsNeverSpent() public view {
        for (uint256 k = 0; k < TOKENS; k++) {
            MockERC20 t = _token(k);
            uint256 held = t.balanceOf(address(exec));
            uint256 donated = handler.ghostDonated(address(t));
            assertGe(held, donated, "the executor spent a balance it did not earn");
            assertEq(held, donated, "the executor kept something a ring should have swept");
        }
    }

    /**
     * @notice Nothing rests in the sink, and nothing rests in the settlement.
     *
     * The sink hands everything back before it returns, so no balance survives the transaction
     * that put it there. These rings are all wallet-mode, so the settlement custodies nothing
     * either, and a balance in it would mean a release or a payment stopped halfway.
     *
     * Asked of the LAST clone to run and of the template, not of every clone ever minted. A run
     * mints one per SOLVER, and holding the whole list would cost a storage write and a scan per
     * check. `invariant_TokensAreConserved` is the wider net: it sums every address this suite
     * knows about against the supply, so a wei left in ANY clone breaks it.
     */
    function invariant_NothingRestsInTheSinkOrTheSettlement() public view {
        address last = handler.venue().lastCaller();
        for (uint256 k = 0; k < TOKENS; k++) {
            MockERC20 t = _token(k);
            assertEq(t.balanceOf(address(sink)), 0, "a token rested in the sink template");
            if (last != address(0)) assertEq(t.balanceOf(last), 0, "a token rested in a clone");
            assertEq(t.balanceOf(address(settlement)), 0, "a token rested in the settlement");
        }
    }

    /**
     * @notice No allowance outlives a ring, on either address that grants one.
     *
     * The executor approves the relayer for exactly what the settlement pulls, and the sink
     * approves a venue for exactly what it sells and writes that back to zero. A surviving
     * allowance is a standing claim on the next donation, which is the same harm as spending one
     * — reached by a different route, and reached across two transactions rather than inside one.
     */
    function invariant_NoAllowanceOutlivesARing() public view {
        address relayer = settlement.relayer();
        address venue = address(handler.venue());
        // The clone that actually granted it. The template grants nothing, because nothing ever
        // drives the template.
        address last = handler.venue().lastCaller();
        for (uint256 k = 0; k < TOKENS; k++) {
            MockERC20 t = _token(k);
            assertEq(t.allowance(address(exec), relayer), 0, "the relayer kept an allowance");
            if (last != address(0)) {
                assertEq(t.allowance(last, venue), 0, "the venue kept an allowance");
            }
        }

        // The third address that grants one, and the only one that grants it from a signature.
        // A permit sets the allowance to the take and the release spends exactly that, so an
        // armed leg leaves the maker no wider a claim on their wallet than they signed for. A
        // solver who asked for the whole lot instead would leave one standing here for ever.
        assertEq(
            handler.permitToken().allowance(handler.permitMaker(), relayer),
            0,
            "an armed leg left the maker with a standing allowance"
        );
    }

    /**
     * @notice A ring carrying bytes that cannot arm never settles.
     *
     * A ring is not a smaller batch. A leg that drops out of a batch costs the caller that leg;
     * a leg that drops out of a ring leaves every other leg unhedged, because the route was
     * priced against releases that never happened. `Route.legs` is what turns the second into a
     * refusal, and this is that rule meeting a leg the settlement stepped over for a reason no
     * view function could have seen — a permit the token refused, a moment ago, inside a frame
     * that reverted.
     *
     * The maker's signature survives it. Nothing here asserts that, because `RingHandler` only
     * ever spoils a permit and a permit spends no counter the maker cannot replace;
     * `test/Invariants.t.sol` holds that claim for the rung where it costs something.
     */
    function invariant_ARingCarryingBytesThatCannotArmNeverSettles() public view {
        assertFalse(
            handler.ringWithUnarmableBytesSettled(), "a ring settled around a leg it could not arm"
        );
    }

    // ── What the arbitrary call cannot reach ─────────────────────────────────

    /**
     * @notice The three rings this contract has to refuse, and the one address that may call a
     *         venue.
     *
     * The settlement and the relayer hold authority over other people's tokens, so a swap that
     * names either — as its target or as its spender, and the handler tries all four — is the
     * Transit Swap shape. A venue that turns round and starts a second ring must take the first
     * one down. A route that leaves a payout token off the sweep list must be refused, because
     * that payment would otherwise come out from under a mark. A swap that names a donated token
     * as its input and leaves it off that list must be refused for the same reason.
     *
     * The last assertion is the positive form of the same rule: the venue call comes from the
     * sink, never from the executor. That is the whole reason the sink is a separate address, and
     * it has to survive every route the fuzzer writes rather than the one a unit test picks.
     */
    function invariant_ARingTheContractMustRefuseNeverSettles() public view {
        assertFalse(handler.forbiddenTargetSettled(), "a swap reached a forbidden address");
        assertFalse(handler.reentrantRingSettled(), "a ring reentered and survived");
        assertFalse(handler.unnamedOutputSettled(), "a payout escaped the mark");
        assertFalse(handler.donationSaleSettled(), "a donation was sold at a venue");
        // A refusal that arrives by luck at a venue is not the rule holding. Each of those four
        // rings must be turned away by the rule it is about, and the call summary says which one
        // stopped counting.
        assertFalse(handler.refusedForTheWrongReason(), "a ring was refused for the wrong reason");

        address who = handler.venue().lastCaller();
        // Zero means no sale has happened yet in this run, which is not a failure.
        if (who != address(0)) {
            assertTrue(_isSinkClone(who), "somebody other than a sink clone drove the venue");
            assertTrue(who != address(exec), "the executor drove the venue itself");
            assertTrue(who != address(sink), "the template drove the venue");
        }
    }

    /**
     * @dev Is `who` an EIP-1167 clone of this executor's sink template?
     *
     * The whole of a minimal proxy is 45 bytes: ten bytes of prologue, the template's address,
     * and fifteen bytes that delegate and return. So the code itself says both that the address
     * is a clone and whose template it runs, which is a stronger claim than "not the executor".
     */
    function _isSinkClone(address who) internal view returns (bool) {
        bytes memory expected = abi.encodePacked(
            hex"363d3d373d3d3d363d73", address(sink), hex"5af43d82803e903d91602b57fd5bf3"
        );
        return keccak256(who.code) == keccak256(expected);
    }

    /**
     * @notice The reentrancy guard is open between rings, whatever happened during the last one.
     *
     * A modifier that sets the flag and does not clear it bricks the contract for everyone, and
     * it does so silently — the ring that breaks it succeeds. This reads the flag between calls:
     * after settled rings, after refused ones, and after reverted ones.
     */
    function invariant_TheGuardIsOpenBetweenRings() public view {
        assertEq(uint256(vm.load(address(exec), GUARD_SLOT)), 1, "the guard stayed shut");
    }

    // ── The books ────────────────────────────────────────────────────────────

    /**
     * @notice Every maker holds what they started with, less what they sold, plus what they were
     *         owed.
     *
     * Both halves come from the signed terms. The take is what the handler asked for, and the
     * delivery is the handler's own arithmetic over `minOutStart`, `minOutEnd` and the clock.
     * Neither number is read back off the contract, so this can disagree with it. A maker short
     * by one wei is a rounding rule that moved.
     */
    function invariant_MakersHoldExactlyWhatTheRingsMoved() public view {
        for (uint256 m = 0; m < 4; m++) {
            address maker = handler.makers(m);
            for (uint256 k = 0; k < TOKENS; k++) {
                MockERC20 t = _token(k);
                uint256 expected = handler.startBalance(m, k) + handler.ghostGot(maker, address(t))
                    - handler.ghostSent(maker, address(t));
                assertEq(t.balanceOf(maker), expected, "a maker's book does not close");
            }
        }

        // The maker whose funds a ring has to reach for itself. Their book closes the same way,
        // which is the point: whether the tokens came out of a standing allowance or out of a
        // permit the solver carried is invisible by the time anybody is paid.
        address armed = handler.permitMaker();
        for (uint256 k = 0; k < TOKENS; k++) {
            MockERC20 t = _token(k);
            uint256 start = k == 3 ? handler.permitStartBalance() : 0;
            uint256 expected =
                start + handler.ghostGot(armed, address(t)) - handler.ghostSent(armed, address(t));
            assertEq(t.balanceOf(armed), expected, "the armed maker's book does not close");
        }
    }

    /// @notice Routing mints and burns nothing. Every wei of every token is with somebody this
    ///         suite knows about, so a ring cannot quietly strand one in a contract it forgot.
    function invariant_TokensAreConserved() public view {
        address[12] memory holders = [
            handler.makers(0),
            handler.makers(1),
            handler.makers(2),
            handler.makers(3),
            handler.permitMaker(),
            handler.solvers(0),
            handler.solvers(1),
            address(exec),
            // The template, which holds nothing because nothing drives it. A clone that kept a
            // token is caught by the shortfall rather than by a line of its own: no clone is on
            // this list, so a wei left in one makes the total miss the supply.
            address(sink),
            address(settlement),
            FEE_SINK,
            address(handler.venue())
        ];

        for (uint256 k = 0; k < TOKENS; k++) {
            MockERC20 t = _token(k);
            uint256 total;
            for (uint256 h = 0; h < holders.length; h++) {
                total += t.balanceOf(holders[h]);
            }
            total += t.balanceOf(settlement.relayer());
            total += t.balanceOf(address(handler.reentrant()));
            total += t.balanceOf(address(handler));
            assertEq(total, t.totalSupply(), "a token was minted or burned by routing");
        }
    }

    /// @notice Not a property — a receipt, printed when a run fails, so a green suite can never
    ///         be a suite that bounced every call before touching state.
    function invariant_CallSummary() public {
        emit log_named_uint("one leg  ", handler.callsOneLeg());
        emit log_named_uint("two legs ", handler.callsTwoLeg());
        emit log_named_uint("three leg", handler.callsThreeLeg());
        emit log_named_uint("skipped  ", handler.callsSkipped());
        emit log_named_uint("forbidden", handler.callsForbidden());
        emit log_named_uint("reentrant", handler.callsReentrant());
        emit log_named_uint("unnamed  ", handler.callsUnnamed());
        emit log_named_uint("theft    ", handler.callsTheft());
        emit log_named_uint("donations", handler.callsDonate());
        emit log_named_uint("re-signed", handler.callsRefresh());
        emit log_named_uint("warps    ", handler.callsWarp());
        emit log_named_uint("armed    ", handler.callsArmedRing());
        emit log_named_uint("arm short", handler.callsArmRefusedRing());
        emit log_named_uint("arm drop ", handler.callsArmDroppedFromRing());
    }

    /// @notice The invariants are only worth their runtime if the handler's actions land. This
    ///         proves each one does, without depending on the fuzzer's mood.
    function test_HandlerActionsReallyDoSomething() public {
        handler.donate(2, 100e18);
        assertEq(handler.callsDonate(), 1, "donate");

        handler.settleOneLeg(0, 1e18);
        assertEq(handler.callsOneLeg(), 1, "one leg");

        handler.settleTwoLegRing(0, 1e18, 1);
        assertEq(handler.callsTwoLeg(), 1, "two legs, with a venue leg");

        handler.settleTwoLegRing(1, 2e18, 0);
        assertEq(handler.callsTwoLeg(), 2, "two legs, on credit alone");

        handler.settleThreeLegRing(0, 1e18);
        assertEq(handler.callsThreeLeg(), 1, "three legs");

        handler.settleSkippingADeadLeg(0, 1e18);
        assertEq(handler.callsSkipped(), 1, "a dead leg stepped over");

        for (uint256 pick = 0; pick < 4; pick++) {
            handler.attemptForbiddenTarget(pick, 1e18);
        }
        assertEq(handler.callsForbidden(), 4, "all four ways to name a forbidden address");

        handler.attemptReentrantRing(1e18);
        assertEq(handler.callsReentrant(), 1, "reentrancy");

        handler.attemptUnnamedOutput(1e18);
        assertEq(handler.callsUnnamed(), 1, "an unnamed payout token");

        handler.attemptSellingADonation(1e18, 50e18);
        assertEq(handler.callsTheft(), 1, "a donation offered to a venue");

        // The three shapes of an armed ring leg. The second is the one the whole `try`/`catch`
        // frame exists for, and the third is a ring that survives one.
        handler.settleArmedRing(0, 1e18);
        assertEq(handler.callsArmedRing(), 1, "a ring armed a leg of its own");
        handler.settleArmedRing(2, 1e18);
        assertEq(handler.callsArmRefusedRing(), 1, "and refused one it could not arm");
        assertFalse(handler.ringWithUnarmableBytesSettled(), "that ring must never settle");
        handler.settleArmedRing(3, 1e18);
        assertEq(handler.callsArmDroppedFromRing(), 1, "a ring priced for the leg that survived");

        // Ninety minutes is the widest jump the handler makes, and it is wider than the hour a
        // standing intent lives, so every maker is dead by the next action.
        handler.skipTime(90 minutes);
        assertEq(handler.callsWarp(), 1, "the clock moved");

        handler.settleOneLeg(0, 1e18);
        assertGe(handler.callsRefresh(), 1, "a dead intent was re-signed");
        assertEq(handler.callsOneLeg(), 2, "and the ring settled on the new signature");

        // And the donation is still exactly where the stranger left it.
        assertEq(tokenC.balanceOf(address(exec)), 100e18, "the donation survived the whole cast");
    }

    /// @notice Runs once after every invariant run. With `fail_on_revert = false` a handler whose
    ///         every call reverted would leave each invariant green about an untouched state.
    ///         So each run must have landed the actions the invariants exist to judge.
    function afterInvariant() public view {
        assertGt(
            handler.callsOneLeg() + handler.callsTwoLeg() + handler.callsThreeLeg(),
            0,
            "no ring settled in this run"
        );
    }
}
