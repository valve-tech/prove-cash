// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION,
    availableOf
} from "../Fees.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../../src/ProveSettlement.sol";
import {ProveBatchExecutor, IProveSettlementBatch} from "../../src/ProveBatchExecutor.sol";
import {IProveSettlementFill} from "../../src/ProveExecutor.sol";
import {ProveCallSink} from "../../src/ProveCallSink.sol";
import {ANY_FEE, MockERC20} from "../Mocks.sol";
import {MockERC2612} from "../Permit.t.sol";
import {ReentrantVenue} from "../BatchExecutor.t.sol";

/**
 * @notice A venue with one price and a memory.
 *
 * It pays two units of the output token for every unit in, out of its own inventory, so any leg
 * the fuzzer shapes closes at a profit and the run spends its depth on state rather than on
 * reverts. `MockRouter` prices the same way, but it does not write down who called it, and that
 * is the one thing this suite has to be able to ask: the security design says the caller is the
 * sink and never the executor.
 *
 * It also pays a tip in a third token, to whoever called rather than to the trade's recipient.
 * That is how a keeper reward actually arrives, and it is the token that reaches the executor
 * only because the route named it in `extra`.
 */
contract RingVenue {
    /// @notice The last address that drove a sale. The suite asserts this is never the executor.
    address public lastCaller;

    address public tipToken;
    uint256 public tipAmount;

    function setTip(address token, uint256 amount) external {
        tipToken = token;
        tipAmount = amount;
    }

    function sell(address tokenIn, uint256 amountIn, address tokenOut, address to) external {
        lastCaller = msg.sender;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).transfer(to, amountIn * 2);
        if (tipToken != address(0) && tipAmount > 0) {
            IERC20(tipToken).transfer(msg.sender, tipAmount);
        }
    }
}

/**
 * @notice Drives `ProveBatchExecutor` the way a solver desk would: rings of one, two and three
 *         legs, some closed on credit alone and some through a venue, a ring that steps over a
 *         dead leg, a leg the solver has to arm from a signature it carries, four rings the
 *         contract must refuse, strangers donating tokens to the executor, and a clock that
 *         moves.
 *
 * The fuzzer picks the order, the sizes and the shapes. This contract only bounds each action so
 * that the good path lands, and keeps the books the invariants check.
 *
 * Every ghost here is worked out from the route and the signed terms. None of it asks the
 * executor or the settlement what happened, because a ghost that asks can only ever agree.
 */
contract RingHandler is Test {
    ProveSettlement public immutable settlement;
    ProveBatchExecutor public immutable exec;
    ProveCallSink public immutable sink;
    address public immutable relayer;
    RingVenue public immutable venue;
    ReentrantVenue public immutable reentrant;

    uint256 public constant MAKERS = 4;
    uint256 public constant SOLVERS = 2;
    uint256 public constant TOKENS = 3;

    /// @dev Every maker sells this much and asks a quarter of it back. The concession is wide
    ///      enough that a ring closes on credit alone, whatever take the fuzzer picks.
    uint256 public constant AMOUNT_IN = 1_000e18;
    uint256 public constant MIN_OUT = 250e18;
    /// @dev Below this a fill is not worth a call, and the fee rounds to nothing.
    uint256 public constant MIN_TAKE = 1e16;

    uint256 public constant MAKER_MINT = 1_000_000_000e18;
    uint256 public constant VENUE_MINT = 1_000_000_000e18;
    /// @dev What the venue pays the caller on top of the trade, in token index 2.
    uint256 public constant TIP = 1e18;

    MockERC20[3] public tokens;
    address[4] public makers;
    uint256[4] private makerKeys;

    /// @dev Which token each maker sells, and which one they want back. Makers 0 and 1 face each
    ///      other, so a two-leg ring closes with no venue. Makers 0, 2 and 3 close a three-leg
    ///      one the same way.
    uint256[4] public sells = [uint256(0), 1, 1, 2];
    uint256[4] public buys = [uint256(1), 0, 2, 0];

    address[2] public solvers = [address(0x50111), address(0x50122)];

    /**
     * @notice The maker a ring has to arm for itself, and the token that lets it.
     *
     * Every other maker here granted the relayer a standing allowance in the constructor, so a
     * ring reaches their funds without asking. This one granted nothing: the only way to their
     * tokens is an EIP-2612 signature the solver carries in `FillRequest.arming`, and the whole
     * point of putting one in a ring is that a ring is not a smaller batch. A leg that drops out
     * of a batch costs the caller that leg; a leg that drops out of a ring leaves every other
     * leg unhedged, which is why `Route.legs` refuses the callback rather than settling short.
     */
    MockERC2612 public immutable permitToken;
    address public permitMaker;
    uint256 private permitKey;

    /// @dev Where a burned permit nonce sends its allowance. Nothing here ever spends it.
    address private constant NOWHERE = address(0xDEAD00);
    /// @dev The floor the armed leg signs. It is under `MIN_TAKE`, so it never refuses a fill —
    ///      it is here because `_mirror` has to carry it, and a mirror that drops it turns every
    ///      armed ring into `BadSignature` with nothing to say why.
    uint256 public constant ARMED_MIN_FILL = MIN_TAKE / 2;

    /// @dev One live intent per maker, re-signed when the clock or the fill count kills it. A
    ///      standing intent is what makes `skipTime` mean something: it decays a maker's price
    ///      mid-window and eventually expires them.
    ProveSettlement.Intent[4] private standing;
    bytes[4] private sigs;
    uint256 private nextNonce = 1;

    // ── Ghost books ──────────────────────────────────────────────────────────

    /// @notice Every token a stranger has pushed into the executor, by token.
    mapping(address => uint256) public ghostDonated;
    /// @notice Every wei a maker has parted with, by maker and token.
    mapping(address => mapping(address => uint256)) public ghostSent;
    /// @notice Every wei a maker has been delivered, by maker and token.
    mapping(address => mapping(address => uint256)) public ghostGot;

    /// @notice Set if a ring the contract must refuse ever settled. Each one is a hole.
    bool public forbiddenTargetSettled;
    bool public reentrantRingSettled;
    bool public unnamedOutputSettled;
    bool public donationSaleSettled;
    /// @notice Set when a ring the contract must refuse reverted, but not for the rule this
    ///         action is about. A refusal that arrives by luck downstream is not the rule
    ///         holding. Read the call summary to see which action stopped counting.
    bool public refusedForTheWrongReason;
    /// @notice Set if a ring carrying bytes that cannot arm ever settled. `Route.legs` is what
    ///         must stop it: the leg drops out, the count no longer matches, and the callback
    ///         refuses rather than leaving the solver holding an unhedged half of a ring.
    bool public ringWithUnarmableBytesSettled;

    uint256 public callsOneLeg;
    uint256 public callsTwoLeg;
    uint256 public callsThreeLeg;
    uint256 public callsSkipped;
    uint256 public callsForbidden;
    uint256 public callsReentrant;
    uint256 public callsUnnamed;
    uint256 public callsTheft;
    uint256 public callsDonate;
    uint256 public callsRefresh;
    uint256 public callsWarp;
    uint256 public callsArmedRing;
    uint256 public callsArmRefusedRing;
    uint256 public callsArmDroppedFromRing;

    constructor(
        ProveSettlement _settlement,
        ProveBatchExecutor _exec,
        MockERC20 a,
        MockERC20 b,
        MockERC20 c
    ) {
        settlement = _settlement;
        exec = _exec;
        sink = _exec.sinkTemplate();
        relayer = _settlement.relayer();

        tokens[0] = a;
        tokens[1] = b;
        tokens[2] = c;

        venue = new RingVenue();
        reentrant = new ReentrantVenue(_exec);
        venue.setTip(address(c), TIP);

        for (uint256 k = 0; k < TOKENS; k++) {
            tokens[k].mint(address(venue), VENUE_MINT);
        }

        for (uint256 m = 0; m < MAKERS; m++) {
            (address who, uint256 key) = makeAddrAndKey(string.concat("ringMaker", vm.toString(m)));
            makers[m] = who;
            makerKeys[m] = key;
            tokens[sells[m]].mint(who, MAKER_MINT);
            vm.prank(who);
            tokens[sells[m]].approve(relayer, type(uint256).max);
            _refresh(m);
        }

        permitToken = new MockERC2612();
        (permitMaker, permitKey) = makeAddrAndKey("ring permit maker");
        permitToken.mint(permitMaker, MAKER_MINT);
        // No approval, and no venue inventory. A signature is the only way to these tokens, and
        // the only ones the venue ever holds are the ones an armed ring sold it.
    }

    /// @notice What the permit maker started with. Their book closes like anybody else's.
    function permitStartBalance() external pure returns (uint256) {
        return MAKER_MINT;
    }

    /// @notice What maker `m` started with in token `t`, so an invariant can close their books.
    function startBalance(uint256 m, uint256 t) external view returns (uint256) {
        return sells[m] == t ? MAKER_MINT : 0;
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    /**
     * @notice One leg, closed entirely at the venue.
     *
     * The batch entry point does the single-intent case too, and it is the shape where the whole
     * delivery comes out of a swap rather than out of another maker.
     */
    function settleOneLeg(uint256 whoSeed, uint256 takeSeed) external {
        uint256 m = whoSeed % MAKERS;
        uint256 take = _usable(m, takeSeed);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _reqFor(m, take);

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _venueSwap(sells[m], buys[m], take, address(venue), address(venue));

        vm.prank(solvers[whoSeed % SOLVERS]);
        try exec.settleRing(reqs, false, ANY_FEE, _route(1, swaps)) returns (uint256) {
            callsOneLeg++;
            _bookLeg(m, take);
        } catch {}
    }

    /**
     * @notice Two legs that pay for each other, and sometimes a venue leg on top.
     *
     * Makers 0 and 1 face each other, so the executor needs no inventory in either token. The
     * optional swap sells half of one release, which the ring can spare: each leg owes a quarter
     * of its own take back.
     */
    function settleTwoLegRing(uint256 whoSeed, uint256 takeSeed, uint256 shape) external {
        uint256 r0 = _usable(0, takeSeed);
        uint256 r1 = _usable(1, takeSeed);
        uint256 take = r0 < r1 ? r0 : r1;

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _reqFor(0, take);
        reqs[1] = _reqFor(1, take);

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](shape % 2);
        if (swaps.length == 1) {
            swaps[0] = _venueSwap(sells[0], buys[0], take / 2, address(venue), address(venue));
        }

        vm.prank(solvers[whoSeed % SOLVERS]);
        try exec.settleRing(reqs, false, ANY_FEE, _route(2, swaps)) returns (uint256) {
            callsTwoLeg++;
            _bookLeg(0, take);
            _bookLeg(1, take);
        } catch {}
    }

    /// @notice Three legs round a cycle, on credit alone. The solver goes up to three, and this
    ///         is the shape where one token carries a release and a payment at the same time.
    function settleThreeLegRing(uint256 whoSeed, uint256 takeSeed) external {
        uint256 r0 = _usable(0, takeSeed);
        uint256 r2 = _usable(2, takeSeed);
        uint256 r3 = _usable(3, takeSeed);
        uint256 take = r0 < r2 ? r0 : r2;
        if (r3 < take) take = r3;

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](3);
        reqs[0] = _reqFor(0, take);
        reqs[1] = _reqFor(2, take);
        reqs[2] = _reqFor(3, take);

        vm.prank(solvers[whoSeed % SOLVERS]);
        try exec.settleRing(reqs, false, ANY_FEE, _route(3, _noSwaps())) returns (uint256) {
            callsThreeLeg++;
            _bookLeg(0, take);
            _bookLeg(2, take);
            _bookLeg(3, take);
        } catch {}
    }

    /**
     * @notice A ring with one dead leg in the middle, stepped over.
     *
     * `Route.legs` says two, so the ring settles only if exactly two legs survive. The middle
     * request is an intent whose window closed an hour ago, and the two standing ones face each
     * other, so a success means the settlement stepped over the dead one and nothing else.
     */
    function settleSkippingADeadLeg(uint256 whoSeed, uint256 takeSeed) external {
        uint256 r0 = _usable(0, takeSeed);
        uint256 r1 = _usable(1, takeSeed);
        uint256 take = r0 < r1 ? r0 : r1;

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](3);
        reqs[0] = _reqFor(0, take);
        reqs[1] = _expiredReq(1);
        reqs[2] = _reqFor(1, take);

        vm.prank(solvers[whoSeed % SOLVERS]);
        try exec.settleRing(reqs, true, ANY_FEE, _route(2, _noSwaps())) returns (uint256) {
            callsSkipped++;
            _bookLeg(0, take);
            _bookLeg(1, take);
        } catch {}
    }

    /**
     * @notice A ring whose leg the solver has to arm itself, sometimes with bytes that cannot.
     *
     * The permit maker granted nothing, so the only way to their tokens is the signature the
     * solver carries. Three shapes, and the last two are why this action exists:
     *
     *   - a sound permit, alone in the ring, which settles;
     *   - a permit against a nonce the token has already moved past, alone in the ring, which
     *     must not settle. The leg drops out under `skipInvalid`, `Route.legs` no longer matches
     *     what survived, and the callback refuses. A ring is not a smaller batch: settling the
     *     rest would leave the solver holding one side of a trade they never made;
     *   - the same broken leg beside a sound ordinary one, with the route priced for one leg. It
     *     settles, and the leg that could not be armed is the one that dropped.
     *
     * A run of only the first shape would prove nothing about the `try`/`catch` frame, which is
     * the whole reason arming is safe to offer a stranger.
     */
    function settleArmedRing(uint256 seed, uint256 takeSeed) external {
        uint256 shape = seed % 4;
        uint256 take = bound(takeSeed, MIN_TAKE, AMOUNT_IN);
        bool sound = shape < 2;

        IProveSettlementBatch.FillRequest[] memory reqs =
            new IProveSettlementBatch.FillRequest[](shape == 3 ? 2 : 1);
        ProveSettlement.Intent memory armed = _permitIntent(take);
        reqs[0] = IProveSettlementBatch.FillRequest({
            intent: _mirror(armed),
            signature: _signAs(permitKey, armed),
            take: take,
            arming: _permitArming(take, sound)
        });

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        uint256 other;
        if (shape == 3) {
            // The ring the broken leg rides in: one honest leg, priced for one leg, so the
            // route is right only if the armed one drops out.
            other = _usable(0, takeSeed);
            reqs[1] = _reqFor(0, other);
            swaps[0] = _venueSwap(sells[0], buys[0], other, address(venue), address(venue));
        } else {
            swaps[0] = _sale(
                address(permitToken), address(tokens[0]), take, address(venue), address(venue)
            );
            // The swap exists only because of the armed leg, so it names it. When the leg cannot
            // be armed and `skipInvalid` steps it over, the swap goes with it and the batch
            // settles nothing rather than reverting on a bag it was never handed.
            swaps[0].leg = 0;
        }

        vm.prank(solvers[seed % SOLVERS]);
        try exec.settleRing(reqs, true, ANY_FEE, _route(1, swaps)) returns (uint256 count) {
            if (shape == 3) {
                callsArmDroppedFromRing++;
                _bookLeg(0, other);
            } else if (sound) {
                callsArmedRing++;
                _bookArmedLeg(armed, take);
            } else if (count == 0) {
                // The leg that could not be armed was stepped over, and its swap with it, so the
                // batch settled nothing and spent nothing. This used to be a revert: the callback
                // refused any batch that skipped a leg, because it could not tell WHICH one had
                // gone. Dropping it is the better answer and the cheaper one — the caller pays
                // for the attempt instead of for a reverted transaction.
                callsArmRefusedRing++;
            } else {
                ringWithUnarmableBytesSettled = true;
            }
        } catch {
            if (sound || shape == 3) return;
            // Nothing settled and nothing was spent, so no shape of failure is left that this
            // action should produce. A revert here is the surprise worth reporting.
            refusedForTheWrongReason = true;
        }
    }

    /**
     * @notice Point a swap at the settlement or at the relayer, as target and as spender.
     *
     * Those two addresses hold the authority the whole design keeps away from arbitrary
     * calldata. A ring that reaches either one is the hole, so this action counts refusals and
     * raises a flag if one ever settles.
     */
    function attemptForbiddenTarget(uint256 pick, uint256 takeSeed) external {
        uint256 take = _usable(0, takeSeed);

        uint256 which = pick % 4;
        address bad = which < 2 ? address(settlement) : relayer;
        address target = which % 2 == 0 ? bad : address(venue);
        address spender = which % 2 == 0 ? address(venue) : bad;

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _reqFor(0, take);
        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _venueSwap(sells[0], buys[0], take, target, spender);

        vm.prank(solvers[pick % SOLVERS]);
        try exec.settleRing(reqs, false, ANY_FEE, _route(1, swaps)) returns (uint256) {
            forbiddenTargetSettled = true;
        } catch (bytes memory err) {
            if (bytes4(err) == ProveBatchExecutor.ForbiddenTarget.selector) {
                callsForbidden++;
            } else {
                refusedForTheWrongReason = true;
            }
        }
    }

    /// @notice A venue that starts a second ring mid-swap. The guard must take the whole thing
    ///         down, and it must be back open by the time the next action runs.
    function attemptReentrantRing(uint256 takeSeed) external {
        uint256 take = _usable(0, takeSeed);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _reqFor(0, take);
        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](1);
        swaps[0] = _venueSwap(sells[0], buys[0], take, address(reentrant), address(reentrant));

        vm.prank(solvers[takeSeed % SOLVERS]);
        try exec.settleRing(reqs, false, ANY_FEE, _route(1, swaps)) returns (uint256) {
            reentrantRingSettled = true;
        } catch (bytes memory err) {
            if (bytes4(err) == ProveCallSink.SwapFailed.selector) {
                callsReentrant++;
            } else {
                refusedForTheWrongReason = true;
            }
        }
    }

    /**
     * @notice A route that leaves the payout token off the sweep list.
     *
     * An owed token with no entry there is one the settlement could pull a maker's payment out of
     * a donation for, so the callback has to refuse the route rather than the payment.
     */
    function attemptUnnamedOutput(uint256 takeSeed) external {
        uint256 take = _usable(0, takeSeed);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _reqFor(0, take);

        // Only the input token. The payout token is the one deliberately missing.
        address[] memory sweep = new address[](1);
        sweep[0] = address(tokens[sells[0]]);
        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 1, swaps: _noSwaps(), sweep: sweep, disposal: new ProveBatchExecutor.Swap[](0)
        });

        vm.prank(solvers[takeSeed % SOLVERS]);
        try exec.settleRing(reqs, false, ANY_FEE, route) returns (uint256) {
            unnamedOutputSettled = true;
        } catch (bytes memory err) {
            if (bytes4(err) == ProveBatchExecutor.OwedTokenNotSwept.selector) {
                callsUnnamed++;
            } else {
                refusedForTheWrongReason = true;
            }
        }
    }

    /**
     * @notice Name a donated token as a swap's input, and leave it off the sweep list.
     *
     * This is the theft the sweep list alone missed. The ring neither releases nor pays the third
     * token, so every wei of it in the executor belongs to whoever left it there. Every swap's
     * input carries a mark now, whether the caller asks for the token back or not, so the ring
     * ends below that mark and reverts. Mark only `Route.sweep` again and the donation is sold
     * and the proceeds walk out under a mark of zero.
     */
    function attemptSellingADonation(uint256 takeSeed, uint256 amountSeed) external {
        // Both sales tip in the token being stolen, so the theft has to be larger than the two
        // tips put together. A smaller one ends the ring above the mark and settles honestly,
        // which would say nothing about the rule under test.
        uint256 pot = ghostDonated[address(tokens[2])];
        if (pot <= 2 * TIP) return;

        uint256 take = _usable(0, takeSeed);
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](1);
        reqs[0] = _reqFor(0, take);

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](2);
        // The first sale closes the leg honestly. Without it the ring could fail for want of the
        // payout token, and a refusal that arrives that way says nothing about the mark.
        swaps[0] = _venueSwap(sells[0], buys[0], take, address(venue), address(venue));
        swaps[1] = _venueSwap(
            2, buys[0], bound(amountSeed, 2 * TIP + 1, pot), address(venue), address(venue)
        );

        // The ring's own two tokens, and deliberately not the one being sold.
        address[] memory sweep = new address[](2);
        sweep[0] = address(tokens[sells[0]]);
        sweep[1] = address(tokens[buys[0]]);

        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 1, swaps: swaps, sweep: sweep, disposal: new ProveBatchExecutor.Swap[](0)
        });

        vm.prank(solvers[takeSeed % SOLVERS]);
        try exec.settleRing(reqs, false, ANY_FEE, route) returns (uint256) {
            donationSaleSettled = true;
        } catch (bytes memory err) {
            if (bytes4(err) == ProveBatchExecutor.BalanceWentDown.selector) {
                callsTheft++;
            } else {
                refusedForTheWrongReason = true;
            }
        }
    }

    /**
     * @notice A stranger pushes tokens into the executor and walks away.
     *
     * Every route in this handler names all three tokens, so the donation always sits under a
     * mark rather than being protected by being ignored. It must still be there after every ring
     * the run goes on to settle.
     */
    function donate(uint256 tokenSeed, uint256 amount) external {
        uint256 t = tokenSeed % TOKENS;
        uint256 value = bound(amount, 1, 10_000e18);
        tokens[t].mint(address(exec), value);
        ghostDonated[address(tokens[t])] += value;
        callsDonate++;
    }

    /**
     * @notice Move the clock.
     *
     * The standing intents decay across their hour and then expire, so time changes what a maker
     * is owed and eventually forces a re-signing. The jump is bounded at ninety minutes against a
     * one-hour window, so a run reaches both halves of that: most warps land mid-decay, and some
     * step over the end.
     */
    function skipTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 90 minutes));
        callsWarp++;
    }

    // ── Route building ───────────────────────────────────────────────────────

    /// @dev Every route names all four tokens, so every donation is covered by a mark and the
    ///      callback never refuses a payout token.
    function _route(uint256 legs, ProveBatchExecutor.Swap[] memory swaps)
        private
        view
        returns (ProveBatchExecutor.Route memory)
    {
        address[] memory sweep = new address[](TOKENS + 1);
        for (uint256 k = 0; k < TOKENS; k++) {
            sweep[k] = address(tokens[k]);
        }
        sweep[TOKENS] = address(permitToken);
        return ProveBatchExecutor.Route({
            legs: legs, swaps: swaps, sweep: sweep, disposal: new ProveBatchExecutor.Swap[](0)
        });
    }

    function _noSwaps() private pure returns (ProveBatchExecutor.Swap[] memory) {
        return new ProveBatchExecutor.Swap[](0);
    }

    /// @dev One sale at the venue, by token index. Most routes here name the ring's own three.
    function _venueSwap(
        uint256 inIdx,
        uint256 outIdx,
        uint256 amountIn,
        address target,
        address spender
    ) private view returns (ProveBatchExecutor.Swap memory) {
        return _sale(address(tokens[inIdx]), address(tokens[outIdx]), amountIn, target, spender);
    }

    /// @dev One sale at the venue. `extra` names the tip token, because the venue pays it to
    ///      whoever called and the sink hands on only what the route asks for.
    function _sale(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address target,
        address spender
    ) private view returns (ProveBatchExecutor.Swap memory) {
        address[] memory extra = new address[](1);
        extra[0] = address(tokens[2]);
        return ProveBatchExecutor.Swap({
            tokenIn: tokenIn,
            amountIn: amountIn,
            tokenOut: tokenOut,
            spender: spender,
            target: target,
            data: abi.encodeCall(RingVenue.sell, (tokenIn, amountIn, tokenOut, address(exec))),
            extra: extra,
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });
    }

    // ── Intents ──────────────────────────────────────────────────────────────

    /// @dev How much of maker `m`'s standing intent this call may take.
    ///
    /// A maker whose hour has run out, or whose intent is nearly full, signs another one here and
    /// the ring goes ahead on it. Dropping the call instead would spend the run's depth on
    /// bookkeeping rather than on state transitions.
    function _usable(uint256 m, uint256 seed) private returns (uint256) {
        (uint256 remaining, bool live) = availableOf(settlement, standing[m]);
        if (!live || remaining < MIN_TAKE) {
            _refresh(m);
            callsRefresh++;
            remaining = AMOUNT_IN;
        }
        return bound(seed, MIN_TAKE, remaining);
    }

    /// @dev Sign maker `m` a fresh hour. Half the makers decay, so the clock changes a price and
    ///      not only a deadline.
    function _refresh(uint256 m) private {
        ProveSettlement.Intent memory i = ProveSettlement.Intent({
            maker: makers[m],
            recipient: makers[m],
            tokenIn: address(tokens[sells[m]]),
            tokenOut: address(tokens[buys[m]]),
            amountIn: AMOUNT_IN,
            minOutStart: MIN_OUT,
            minOutEnd: m % 2 == 0 ? MIN_OUT : MIN_OUT / 2,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: bytes32(0),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL(),
            nonce: nextNonce++,
            curve: bytes32(0)
        });
        standing[m] = i;

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKeys[m], settlement.hashIntent(i));
        sigs[m] = abi.encodePacked(r, s, v);
    }

    function _reqFor(uint256 m, uint256 take)
        private
        view
        returns (IProveSettlementBatch.FillRequest memory)
    {
        return IProveSettlementBatch.FillRequest({
            intent: _mirror(standing[m]), signature: sigs[m], take: take, arming: ""
        });
    }

    /// @dev A leg that is already dead, so `skipInvalid` has something real to step over.
    function _expiredReq(uint256 m) private returns (IProveSettlementBatch.FillRequest memory) {
        ProveSettlement.Intent memory i = ProveSettlement.Intent({
            maker: makers[m],
            recipient: makers[m],
            tokenIn: address(tokens[sells[m]]),
            tokenOut: address(tokens[buys[m]]),
            amountIn: AMOUNT_IN,
            minOutStart: MIN_OUT,
            minOutEnd: MIN_OUT,
            startTime: uint64(block.timestamp - 2 hours),
            endTime: uint64(block.timestamp - 1 hours),
            executor: address(0),
            feeConfig: bytes32(0),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL(),
            nonce: nextNonce++,
            curve: bytes32(0)
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKeys[m], settlement.hashIntent(i));
        return IProveSettlementBatch.FillRequest({
            intent: _mirror(i), signature: abi.encodePacked(r, s, v), take: AMOUNT_IN, arming: ""
        });
    }

    /**
     * @dev The settlement's `Intent` in the executor's mirror of it. Field for field, which is
     *      the property the compiler will not check for us.
     *
     * `minFill` and `authNonce` used to be written as zeroes here rather than carried, which
     * held only because nothing in this file ever set either. The two structs are one ABI
     * encoding: drop a field and the calldata the executor builds no longer hashes to the intent
     * the maker signed, so every fill comes back `BadSignature` and no test says why. The armed
     * ring leg below signs a real floor, which is what makes this line load-bearing rather than
     * a thing a reader has to take on trust.
     */
    function _mirror(ProveSettlement.Intent memory i)
        private
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

    // ── Books ────────────────────────────────────────────────────────────────

    /// @dev What one leg moves, from the signed terms and the clock. The contract is never asked:
    ///      a ghost that asks it can only ever agree with it.
    function _delivered(ProveSettlement.Intent memory i, uint256 take)
        private
        view
        returns (uint256)
    {
        uint256 rate;
        if (block.timestamp <= i.startTime || i.minOutEnd == i.minOutStart) {
            rate = i.minOutStart;
        } else if (block.timestamp >= i.endTime) {
            rate = i.minOutEnd;
        } else {
            uint256 span = uint256(i.endTime) - uint256(i.startTime);
            uint256 elapsed = block.timestamp - uint256(i.startTime);
            rate = i.minOutStart - ((i.minOutStart - i.minOutEnd) * elapsed) / span;
        }
        uint256 n = take * rate;
        return n == 0 ? 0 : (n - 1) / i.amountIn + 1;
    }

    function _bookLeg(uint256 m, uint256 take) private {
        ProveSettlement.Intent memory i = standing[m];
        ghostSent[makers[m]][i.tokenIn] += take;
        ghostGot[makers[m]][i.tokenOut] += _delivered(i, take);
    }

    // ── The leg a ring has to arm ────────────────────────────────────────────

    /**
     * @dev A fresh intent for the permit maker, signed for exactly this take.
     *
     * Fresh every call, because a permit is spent on the fill it arms: the allowance is set to
     * the take and the take consumes it, so the next ring needs its own signature. A standing
     * intent would arm once and then read `EscrowShort` for the rest of the run.
     *
     * The floor is real, and it is under `MIN_TAKE` so it never refuses a fill. It is here so
     * that `_mirror` carrying `minFill` is a thing this campaign proves rather than assumes.
     */
    function _permitIntent(uint256 take) private returns (ProveSettlement.Intent memory) {
        return ProveSettlement.Intent({
            maker: permitMaker,
            recipient: permitMaker,
            tokenIn: address(permitToken),
            tokenOut: address(tokens[0]),
            amountIn: take,
            minOutStart: take / 4,
            minOutEnd: take / 4,
            startTime: uint64(block.timestamp),
            // Half an hour, because a ring settles in one transaction and needs no more.
            endTime: uint64(block.timestamp + 30 minutes),
            executor: address(0),
            feeConfig: bytes32(0),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0,
            minFill: ARMED_MIN_FILL,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL(),
            nonce: nextNonce++,
            curve: bytes32(0)
        });
    }

    function _signAs(uint256 key, ProveSettlement.Intent memory i)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /**
     * @dev A permit for the relayer, for exactly the take, sound or against a spent nonce.
     *
     * The broken shape is not the front-running race — a stranger's copy of the maker's own
     * permit sets the allowance and `_grantAllowance` then never calls the token at all. This is
     * the other half: the token moved past the nonce and granted nothing, so the call is made
     * and refused and the whole arming frame unwinds around it.
     */
    function _permitArming(uint256 take, bool sound) private returns (bytes memory) {
        ProveSettlement.Permit memory p;
        p.value = take;
        p.deadline = block.timestamp + 1 days;
        (p.v, p.r, p.s) = vm.sign(
            permitKey, _permitDigest(relayer, take, permitToken.nonces(permitMaker), p.deadline)
        );
        if (!sound) _burnPermitNonce();
        return abi.encode(p);
    }

    /// @dev Move the token past the nonce the maker just signed against, granting nothing.
    function _burnPermitNonce() private {
        uint256 deadline = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(permitKey, _permitDigest(NOWHERE, 0, permitToken.nonces(permitMaker), deadline));
        permitToken.permit(permitMaker, NOWHERE, 0, deadline, v, r, s);
    }

    function _permitDigest(address spender, uint256 value, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                permitToken.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        permitToken.PERMIT_TYPEHASH(), permitMaker, spender, value, nonce, deadline
                    )
                )
            )
        );
    }

    function _bookArmedLeg(ProveSettlement.Intent memory i, uint256 take) private {
        ghostSent[permitMaker][address(permitToken)] += take;
        ghostGot[permitMaker][address(tokens[0])] += _delivered(i, take);
    }
}
