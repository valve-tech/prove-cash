// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {MockERC20, MockPermit2, NO_PERMIT2} from "./Mocks.sol";
import {WeirdToken} from "./tokens/WeirdToken.sol";
import {AwkwardHandler} from "./handlers/AwkwardHandler.sol";
import {IAuthToken, SettlementHandler} from "./handlers/SettlementHandler.sol";
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
 * @notice The properties that must hold after any sequence of fills, batches, deposits,
 *         withdrawals, cancellations, arming attempts, dry runs and time skips the fuzzer can
 *         invent.
 *
 * The handler bounds the inputs; nothing here bounds the order. That is the point: a fill in the
 * middle of a cooldown, a withdrawal between two halves of a partial fill, a batch that races
 * itself, a permit that lands between one leg and the next — the fuzzer finds those orderings,
 * and every statement below has to survive them.
 *
 * The arming statements are gathered under their own heading near the bottom. Read
 * `invariant_AnAuthorizationNonceIsSpentOnlyByALegThatFilled` first: it is the one that says
 * why `_arm` runs inside a frame it can revert, and the rest of them lean on it.
 */
contract InvariantsTest is Test {
    ProveSettlement settlement;
    MockERC20 tokenA;
    MockERC20 tokenB;
    SettlementHandler handler;

    address constant SINK = address(0x5152);
    address constant OWNER = address(0xB0B);

    /// @dev Where each of the handler's two fee sinks pays. A sink never holds a token, so the
    ///      balances that witness a claim are these, not the sinks'.
    address constant DEST_1 = address(0xD1);
    address constant DEST_2 = address(0xD2);

    /// @dev The default sink, and where it pays. No fill books here (OW-2, 2026-10-01). Its
    ///      PLACEHOLDER rate is above zero, so a fill that read the default would show up.
    address constant DEFAULT_SINK = address(0xF0);
    address constant DEST_0 = address(0xD0);
    uint256 constant DEFAULT_RATE = 0.003e18;

    /// @dev Three sinks: the handler's two, then the default.
    uint256 constant SINKS = 3;

    function _destination(uint256 f) internal view returns (address) {
        // A destination is the address the intent's config names, which is the handler's own.
        return handler.sinkAt(f);
    }

    function setUp() public {
        vm.warp(1_700_000_000);
        // Before the settlement, because the settlement hands it to the relayer it creates and
        // the handler reads it back off that relayer.
        settlement = newSettlement(address(new MockPermit2()));

        // The handler's two `feeTos`, as real sinks with destinations of their own.
        tokenA = new MockERC20("Token A", "A", 18);
        tokenB = new MockERC20("Token B", "B", 18);
        handler = new SettlementHandler(settlement, tokenA, tokenB);

        targetContract(address(handler));
    }

    /**
     * @notice The rule the relayer split exists to enforce, over any sequence the fuzzer invents.
     *
     * The whole point of splitting the allowance holder out is that the settlement — the contract
     * that calls addresses it did not choose — is never a spender for anyone. A single test can
     * only show that after one fill. This shows it after fills, batches, callbacks, deposits,
     * withdrawals, cancels and time skips in whatever order the fuzzer likes.
     *
     * It also covers a failure a unit test would miss: a call site added later that re-introduces
     * a `safeTransferFrom` from `msg.sender`. Nothing would revert; the executor would simply have
     * to approve the settlement again, and this is the assertion that would notice.
     */
    function invariant_NoAllowanceEverAccumulatesOnTheSettlement() public view {
        address at = address(settlement);
        for (uint256 m = 0; m < 3; m++) {
            address maker = handler.makers(m);
            assertEq(tokenA.allowance(maker, at), 0, "a maker approved the settlement");
            assertEq(tokenB.allowance(maker, at), 0, "a maker approved the settlement for B");
        }
        for (uint256 e = 0; e < 2; e++) {
            address executor = handler.executors(e);
            assertEq(tokenA.allowance(executor, at), 0, "an executor approved the settlement");
            assertEq(tokenB.allowance(executor, at), 0, "an executor approved the settlement for B");
        }
        assertEq(tokenB.allowance(address(handler.bot()), at), 0, "the callback bot approved it");

        /*
         * The rung that could break this without anybody noticing. A permit names its spender,
         * and the maker never sees the transaction that submits it — so a permit pointed at the
         * settlement would put a maker's whole allowance on the address that calls strangers,
         * silently, and every fill would still work. `_grantAllowance` names the relayer, and
         * this is the statement that it stays named.
         */
        for (uint256 t = 0; t < handler.tokenCount(); t++) {
            MockERC20 token = MockERC20(handler.tokenAt(t));
            assertEq(token.allowance(handler.permitMaker(), at), 0, "a permit maker approved it");
            assertEq(token.allowance(handler.keyMaker(), at), 0, "a gasless maker approved it");
            // The permit2 maker's one grant names Permit2. It must never name us — not the
            // settlement here, and not the relayer, which the assertion below says.
            assertEq(token.allowance(handler.permit2Maker(), at), 0, "the permit2 maker did too");
            assertEq(
                token.allowance(handler.permit2Maker(), settlement.relayer()),
                0,
                "the permit2 maker granted the relayer an allowance a redeploy would orphan"
            );
            assertEq(
                token.allowance(address(handler.walletMaker()), at),
                0,
                "the contract wallet approved it"
            );
        }
    }

    /**
     * @notice The relayer is a pipe, not a pocket.
     *
     * `pull` is a directed `transferFrom`, so tokens never rest here. If any ever did, the relayer
     * would stop being the thing the design claims — an address with nothing to steal — and a bug
     * that stranded a balance in it would be silent.
     */
    function invariant_TheRelayerNeverHoldsABalance() public view {
        address r = settlement.relayer();
        for (uint256 t = 0; t < handler.tokenCount(); t++) {
            assertEq(MockERC20(handler.tokenAt(t)).balanceOf(r), 0, "a token rested in the relayer");
        }
    }

    /// @notice An intent can never release more of token A than the maker signed for.
    function invariant_FilledNeverExceedsTheSignedAmount() public view {
        uint256 n = handler.intentCount();
        for (uint256 k = 0; k < n; k++) {
            ProveSettlement.Intent memory i = handler.intentAt(k);
            assertLe(settlement.filled(settlement.hashIntent(i)), i.amountIn);
        }
    }

    /// @notice The contract holds escrow and nothing else. Every wei of token A sitting here is
    ///         claimed by some maker's escrow balance.
    function invariant_ContractHoldsExactlyTheEscrow() public view {
        uint256 booked;
        uint256 n = handler.intentCount();
        for (uint256 k = 0; k < n; k++) {
            booked += settlement.reserved(settlement.hashIntent(handler.intentAt(k)));
        }
        assertEq(tokenA.balanceOf(address(settlement)), booked, "token A here is all reserved");
    }

    /**
     * @notice Token B passes through, except for the fees that rest here on their way out.
     *
     * This used to read `== 0`, and that was the stronger claim: a maker's proceeds never touch
     * this contract. It still holds for a maker's proceeds. It no longer holds for the contract's
     * whole balance, because a fee is booked here rather than transferred, so the settlement
     * carries token B continuously from the first fee-charging fill.
     *
     * Equality against the fee book, and not `assertLe`, is what keeps this a statement. A wei
     * of token B here that no destination is owed is a maker's delivery that got stuck.
     */
    function invariant_ContractNeverHoldsTokenOutBeyondTheFeesItOwes() public view {
        assertEq(
            tokenB.balanceOf(address(settlement)),
            settlement.totalPendingFees(address(tokenB)),
            "token B here is something other than a booked fee"
        );
    }

    /// @notice Nothing is minted or burned by trading. Every token is somewhere we know about.
    function invariant_TokensAreConserved() public view {
        uint256 a = tokenA.balanceOf(address(settlement)) + tokenA.balanceOf(SINK);
        uint256 b = tokenB.balanceOf(address(settlement)) + tokenB.balanceOf(SINK);
        for (uint256 m = 0; m < 3; m++) {
            a += tokenA.balanceOf(handler.makers(m));
            b += tokenB.balanceOf(handler.makers(m));
        }
        for (uint256 e = 0; e < 2; e++) {
            a += tokenA.balanceOf(handler.executors(e));
            b += tokenB.balanceOf(handler.executors(e));
        }
        // The intents that name a sink pay its destination in token B. The sinks are in the sum
        // too, so a wei that reached one would not vanish from this line; a separate invariant
        // says none ever does.
        for (uint256 f = 0; f < SINKS; f++) {
            a += tokenA.balanceOf(handler.sinkAt(f));
            b += tokenB.balanceOf(handler.sinkAt(f));
        }
        // The callback bot holds inventory too.
        a += tokenA.balanceOf(address(handler.bot()));
        b += tokenB.balanceOf(address(handler.bot()));
        // The armed makers are paid in token B like everybody else. They hold none of token A —
        // each of them sells a token of their own — and a wei of it here would be a release that
        // reached the wrong maker.
        for (uint256 w = 0; w < ARMED_MAKERS; w++) {
            a += tokenA.balanceOf(_armedMaker(w));
            b += tokenB.balanceOf(_armedMaker(w));
        }
        assertEq(a, tokenA.totalSupply(), "token A conserved");
        assertEq(b, tokenB.totalSupply(), "token B conserved");
    }

    /// @dev How many makers only a signature reaches. One per way of holding a key, plus the
    ///      one who granted Permit2 and nothing else.
    uint256 constant ARMED_MAKERS = 4;

    /// @dev The makers whose funds only a signature reaches.
    function _armedMaker(uint256 w) internal view returns (address) {
        if (w == 0) return handler.permitMaker();
        if (w == 1) return handler.keyMaker();
        if (w == 2) return handler.permit2Maker();
        return address(handler.walletMaker());
    }

    /// @notice The makers, taken together, hold every wei of token B that the fills owed them.
    function invariant_MakersReceivedWhatTheyWereOwed() public view {
        uint256 held;
        for (uint256 m = 0; m < 3; m++) {
            held += tokenB.balanceOf(handler.makers(m));
        }
        assertGe(held, handler.ghostTokenBOwed(), "no maker was short-changed");
    }

    /// @notice A reservation never claims more than the contract actually holds.
    function invariant_EscrowIsNeverNegative() public view {
        uint256 n = handler.intentCount();
        for (uint256 k = 0; k < n; k++) {
            assertLe(
                settlement.reserved(settlement.hashIntent(handler.intentAt(k))),
                tokenA.balanceOf(address(settlement))
            );
        }
    }

    // ── The fee ──────────────────────────────────────────────────────────────

    /**
     * @notice Every wei the executors paid in fees is owed to a destination an intent named, or
     *         has already reached one, and `SINK` (an address no config names) received none.
     *
     * The handler adds the fees up from the signed terms alone, and this compares that total
     * against what the contract actually holds for each destination plus what each has taken
     * out. It fails if the arithmetic mints a wei and if it strands one.
     *
     * **The balance alone stopped being the whole answer when the fee became a booking.** A fee
     * no longer moves during a fill, so a run in which nobody calls `claim` leaves every
     * destination at a balance of zero — and the old form of this statement would have passed
     * against a contract that charged the fee and then lost it. Booked plus claimed is the sum
     * that has to equal what was charged.
     *
     * `SINK` stands where `defaultProceeds` once did; no config names it. Its book and balance
     * staying at zero is the invariant form of the claim this whole change is about: a fee goes
     * where the intent said (the stray config takes only what `sweepUnowned` finds unowned).
     */
    function invariant_TheFeeReachesTheDestinationTheIntentNamed() public view {
        uint256 toFeeTos;
        for (uint256 f = 0; f < SINKS; f++) {
            address feeTo = handler.sinkAt(f);
            // Claimed fees are at the sink's destination, and booked ones are in the sink's book.
            toFeeTos += tokenB.balanceOf(_destination(f))
            + settlement.pendingFees(feeCfg(feeTo), address(tokenB));
        }
        assertEq(toFeeTos, handler.ghostToFeeTo(), "the intents' line");
        assertEq(toFeeTos, handler.ghostCharged(), "and it is the whole of what was charged");
        assertEq(tokenB.balanceOf(SINK), 0, "no fill pays the address the owner set");
        assertEq(
            settlement.pendingFees(feeCfg(SINK), address(tokenB)),
            0,
            "and no fill books against it either"
        );
    }

    /**
     * @notice A fee reaches the maker's own half and nothing else.
     *
     * Three halves. The makers receive the signed curve less the fee their own intents carve out
     * of it, to the wei. That fee plus what they received is the curve exactly, so no rate moves
     * what the executors part with — the claim the whole split rests on, witnessed over a fuzzed
     * sequence rather than one fill. And the escrow holds what the deposits put there less what
     * the fills took, which is the book a fee must never reach at all.
     *
     * This asserted the opposite first half until the fee moved inside the maker's number: that
     * a rate could not move what a fill delivered. It moves that and only that now.
     */
    function invariant_AFeeNeverReachesCommittedMoney() public view {
        assertEq(
            handler.ghostTokenBReceived(),
            handler.ghostTokenBOwed(),
            "a rate moved a fill by something other than its own share"
        );
        assertEq(
            handler.ghostTokenBOwed() + handler.ghostCharged(),
            handler.ghostTokenBGross(),
            "a rate moved what the executors parted with"
        );

        uint256 held;
        for (uint256 m = 0; m < 3; m++) {
            held += tokenB.balanceOf(handler.makers(m));
        }
        assertEq(held, handler.ghostTokenBOwed(), "a maker was paid something other than the curve");

        assertEq(
            tokenA.balanceOf(address(settlement)),
            handler.ghostEscrowNet(),
            "escrowed token A moved without a deposit, a withdrawal or a fill"
        );
    }

    // ── Arming ───────────────────────────────────────────────────────────────

    /**
     * @notice **The griefing argument.** A maker's EIP-3009 nonce is spent only by a leg that
     *         actually filled.
     *
     * A 3009 nonce is single use. Burn one on a leg that does not settle and the maker's
     * signature is dead for good — they have to sign again, and anybody holding a copy of the
     * intent can do it to them, over and over, for the price of gas. That is why `_arm` wraps
     * the arming in `try this.armLeg(...)`: a leg that cannot be armed reverts its own frame and
     * leaves nothing behind, so the same signature works next time.
     *
     * Three hand-written tests assert this of one leg each, and until now nothing asserted it of
     * a sequence. Here the fuzzer picks the rung, the shape of the bytes, the size of the fill
     * and the order, and both halves have to survive all of it.
     *
     * The two halves say different things. A leg that filled must have redeemed, or its escrow
     * was funded by something this handler never did. A nonce that is spent must have some offer
     * naming it that filled — *some*, because siblings share one on purpose, and the losing twin
     * is a leg whose nonce is spent and whose fill never happened.
     *
     * **A leg funded out of its maker's parked capital is skipped in the first half, and only
     * there.** That source spends no nonce at all, so such a leg filling with its authorization
     * still unspent is the feature rather than the fault — and the handler marks it only when
     * the maker's row really fell, so a leg that settled out of a leftover reservation is still
     * held to the redemption that put it there. The second half is untouched: a maker who welds
     * siblings to one nonce cannot use that source at all, so no twin's fill can be forgiven by
     * capital nobody spent a nonce for.
     */
    function invariant_AnAuthorizationNonceIsSpentOnlyByALegThatFilled() public view {
        uint256 n = handler.armedCount();
        for (uint256 k = 0; k < n; k++) {
            (bytes32 h, address token, address maker, bytes32 nonce,,) = handler.armedAt(k);
            // A permit grants an allowance, and a permit2 leg spends its nonce inside Permit2.
            // Neither touches the token's own ledger, and `permit2In` does not have one.
            if (nonce == bytes32(0) || handler.isPermit2Rung(k)) continue;
            if (settlement.filled(h) == 0) continue;
            // The fourth source pays for a leg without spending anything the token knows about.
            if (handler.armedFundedFromParked(k)) continue;
            assertTrue(
                IAuthToken(token).authorizationState(maker, nonce),
                "a gasless leg filled without redeeming the authorization that funds it"
            );
        }
        assertFalse(
            handler.aNonceWasBurnedForNothing(),
            "a maker's authorization was spent by a leg that never filled"
        );
    }

    /**
     * @notice The same statement for the rung whose nonce lives in Permit2.
     *
     * The griefing argument does not change with the counter's address. A leg that could not be
     * armed has to leave the bitmap bit clear, or anybody holding a copy of the intent could burn
     * a maker's Permit2 signature for the price of their own gas — and that maker would have to
     * sign again, every time, for ever. `armLeg`'s revertable frame is what makes it hold, and
     * this is the statement over every ordering the fuzzer can invent.
     */
    function invariant_APermit2NonceIsSpentOnlyByALegThatFilled() public view {
        assertFalse(
            handler.aPermit2NonceWasBurnedForNothing(),
            "a maker's Permit2 signature was spent by a leg that never filled"
        );
    }

    /**
     * @notice `dryRun` changes nothing. It arms for real and then throws all of it away.
     *
     * Whether a permit lands and whether a redemption comes up short are facts about a transfer
     * that has already happened, so the walk makes the calls: the maker's nonce is spent, their
     * tokens move into the escrow, the leg is booked and token A is released to the caller. Then
     * it reverts, and every one of those has to unwind. A walk that left one behind would be a
     * way for anybody to burn a maker's signature for free — the same griefing the frame above
     * exists to prevent, reached through the tool that was meant to price it.
     *
     * The handler fingerprints every reservation, every `filled`, every `totalReserved`, every
     * balance it knows of and every 3009 nonce, either side of the call. This is the count of
     * times the two disagreed.
     *
     * The second assertion is the other half of "always reverting is the feature". A `dryRun`
     * that returned would need access control, a story about half-applied state, and something
     * to clean up. It has none of those because it never returns.
     */
    function invariant_ADryRunLeavesTheStateExactlyWhereItFoundIt() public view {
        assertEq(
            handler.ghostDryRunsThatMovedSomething(),
            0,
            "a dry run left the chain somewhere other than where it found it"
        );
        assertEq(handler.ghostDryRunsThatReturned(), 0, "a dry run returned instead of reverting");
    }

    /**
     * @notice No fill lands below the intent's floor unless it closed the intent out.
     *
     * `take >= minFill || take == remaining`, over any sequence. The second clause is not a
     * courtesy: without it a floor of 30 on an amount of 100 leaves a final 10 that no fill can
     * ever reach, and every floored intent ends in dust behind which the maker's escrow sits
     * until they withdraw.
     *
     * Two readings of the same rule. The ghost counts the fills as they happen, against the
     * remainder each one faced. The walk below reads it out of storage afterwards, where a
     * `filled` between one wei and the floor with the intent still open is the same fault
     * arrived at from the other side.
     */
    function invariant_NoFillLandsBelowTheFloorUnlessItClosedTheIntent() public view {
        assertEq(
            handler.ghostFillsUnderTheFloor(),
            0,
            "a fill landed under the floor with the intent still open"
        );

        uint256 n = handler.armedCount();
        for (uint256 k = 0; k < n; k++) {
            (bytes32 h,,,, uint256 amountIn, uint256 minFill) = handler.armedAt(k);
            uint256 done = settlement.filled(h);
            if (done == 0 || done == amountIn) continue;
            assertGe(done, minFill, "an open intent is filled below its own floor");
        }
    }

    /**
     * @notice `totalReserved` is still the sum of the reservations, after arbitrary arming.
     *
     * The two books move in the same statement by the same amount everywhere they move, and a
     * redemption is a fifth place they do. Miss it and `sweepUnowned` either books a maker's
     * escrow to the stray config or reports less than is really unowned — a silent loss either
     * way, because nothing else in the contract reads `_totalReserved` at all.
     *
     * The redemption is the interesting credit, because it books what *arrived* rather than what
     * was asked for. A token that keeps a cut of its own transfers is the case that separates
     * the two, and a run has one of those in it.
     *
     * **There are two books now, and the sweep subtracts both.** A fee is booked here rather than
     * transferred, so `_totalPendingFees` claims part of the balance as surely as a reservation
     * does. It is proved on the same two axes the escrow half already had: the seven tokens the
     * handler moves, against the two destinations its intents name.
     *
     * **There are three books now.** Parked capital is a maker's own money between one offer and
     * the next, keyed by maker rather than by intent hash, so it claims part of the balance as
     * surely as a reservation or a booked fee does. `park` credits it, the escrow arm of a fill
     * spends it, and `withdrawParked` pays it out — three sites, and each one moves the row and
     * the per-token sum in the same breath.
     *
     * The balance assertion is the stronger claim, and it carries every term: the settlement
     * holds exactly the reservations, plus exactly the fees it owes, plus exactly the capital
     * resting here, in every token it touches. Nothing is stranded and nothing is missing.
     * **Without `+ totalPendingFees` it is false from the first fee-charging fill, and without
     * `+ totalParked` from the first `park`** — not from some hostile edge either time, because
     * both leave money here that no reservation claims.
     */
    function invariant_TheReservationsStillAddUpToTheBookTheSweepReads() public view {
        uint256[7] memory sums;

        uint256 n = handler.intentCount();
        for (uint256 k = 0; k < n; k++) {
            ProveSettlement.Intent memory i = handler.intentAt(k);
            sums[_tokenIndex(i.tokenIn)] += settlement.reserved(settlement.hashIntent(i));
        }
        uint256 m = handler.armedCount();
        for (uint256 k = 0; k < m; k++) {
            (bytes32 h, address token,,,,) = handler.armedAt(k);
            sums[_tokenIndex(token)] += settlement.reserved(h);
        }

        for (uint256 t = 0; t < 7; t++) {
            address token = handler.tokenAt(t);
            assertEq(settlement.totalReserved(token), sums[t], "the two escrow books disagree");

            // The fee half, on the destination axis the handler already had. Each destination's
            // row must match the ghost that never asks the contract, and the rows must add up to
            // the total the sweep reads — the same relation `_reserved` has to `_totalReserved`.
            uint256 owedToDestinations;
            for (uint256 f = 0; f < SINKS; f++) {
                address feeTo = handler.sinkAt(f);
                uint256 book = settlement.pendingFees(feeCfg(feeTo), token);
                assertEq(book, handler.ghostPendingFees(feeTo, token), "a destination's book");
                owedToDestinations += book;
            }
            assertEq(
                settlement.totalPendingFees(token), owedToDestinations, "the two fee books disagree"
            );

            // The parked half, on the maker axis. Each row is read off the contract and the
            // rows must add up to the total the sweep reads — the same relation the other two
            // books have to their own totals.
            uint256 resting = settlement.totalParked(token);
            assertEq(resting, handler.parkedRows(token), "the two parked books disagree");

            assertEq(
                MockERC20(token).balanceOf(address(settlement)),
                sums[t] + owedToDestinations + resting,
                "the settlement holds something other than the reservations, fees and rest"
            );
        }
    }

    /// @dev Which token this is, in the order the handler names them.
    function _tokenIndex(address token) internal view returns (uint256) {
        for (uint256 t = 0; t < 7; t++) {
            if (handler.tokenAt(t) == token) return t;
        }
        revert("a reservation names a token this suite does not know");
    }

    /**
     * @notice Two offers over one lot never both fill.
     *
     * A maker who names the same `authNonce` on two intents has posted the same inventory at two
     * prices, and the token's single-use nonce is what makes them exclusive: whichever is armed
     * first spends it, and the other can never be funded. Nothing in this contract enforces
     * that — the token does — so this is the statement that the contract does not get in the
     * way of it.
     */
    function invariant_TwoOffersSharingAnAuthorizationNeverBothFill() public view {
        uint256 n = handler.twinCount();
        for (uint256 k = 0; k < n; k++) {
            (bytes32 a, bytes32 b) = handler.twinAt(k);
            assertFalse(
                settlement.filled(a) > 0 && settlement.filled(b) > 0, "one lot was sold twice"
            );
        }
    }

    /// @notice An armed maker is paid the curve they signed, whichever rung reached their funds.
    ///         The ghost works the delivery out from the signed terms, so this can disagree with
    ///         the contract rather than only ever agreeing with it.
    function invariant_AnArmedMakerIsPaidTheCurve() public view {
        uint256 held;
        for (uint256 w = 0; w < ARMED_MAKERS; w++) {
            held += tokenB.balanceOf(_armedMaker(w));
        }
        assertEq(held, handler.ghostArmedOwed(), "an armed maker was paid something else");
    }

    /// @notice Not a property — a receipt, printed when a run fails, so a green suite can never
    ///         be a suite that bounced every call before touching state.
    function invariant_CallSummary() public {
        emit log_named_uint("fills   ", handler.callsFill());
        emit log_named_uint("dust    ", handler.callsDust());
        emit log_named_uint("batches ", handler.callsBatch());
        emit log_named_uint("deposits", handler.callsDeposit());
        emit log_named_uint("withdraw", handler.callsWithdraw());
        emit log_named_uint("cancels ", handler.callsCancel());
        emit log_named_uint("callback", handler.callsCallback());
        emit log_named_uint("signed  ", handler.callsSign());
        // A parked book nothing ever credits would make the sweep's third term a green
        // statement about nothing.
        emit log_named_uint("parks   ", handler.callsPark());
        emit log_named_uint("parkfill", handler.callsParkedFill());
        emit log_named_uint("unparks ", handler.callsUnpark());
        // A fee book that reads zero means the fee invariants passed on nothing.
        emit log_named_uint("to feeTo", handler.ghostToFeeTo());

        emit log_named_uint("armed   ", handler.callsArm());
        emit log_named_uint("refused ", handler.callsArmRefused());
        emit log_named_uint("re-armed", handler.callsArmAgain());
        emit log_named_uint("twins   ", handler.callsTwins());
        emit log_named_uint("dry runs", handler.callsDryRun());
        // Of those, the ones that really armed. Zero means the dry-run invariant passed on a run
        // of walks that never touched a maker's signature.
        emit log_named_uint("  armed ", handler.callsDryRunThatArmed());
        // The escape hatch. Zero here means the floor's second clause was never exercised, and
        // `invariant_NoFillLandsBelowTheFloorUnlessItClosedTheIntent` passed on nothing.
        emit log_named_uint("hatch   ", handler.ghostClosingFillsUnderTheFloor());
        // Every rung, so a green run can never be one where only the easy rung ever armed. The
        // two ERC-7598 lines are one token reached two ways.
        emit log_named_uint("  permit", handler.armFillsByRung(0));
        emit log_named_uint("  3009  ", handler.armFillsByRung(1));
        emit log_named_uint("  7598 k", handler.armFillsByRung(2));
        emit log_named_uint("  7598 w", handler.armFillsByRung(3));
        emit log_named_uint("  taxed ", handler.armFillsByRung(4));
        emit log_named_uint("  permit2", handler.armFillsByRung(5));
    }

    /// @notice The invariants are only worth their runtime if the handler's actions land. This
    ///         proves each one does, without depending on the fuzzer's mood.
    function test_HandlerActionsReallyDoSomething() public {
        handler.depositEscrow(2, 500_000e18);
        assertEq(handler.callsDeposit(), 1, "deposit");

        // Intent 0 signs a zero `feeTo`, so this fill is also the one that proves the zero-feeTo
        // path. It pays no fee, so nothing is booked to the default sink, whose rate is above
        // zero. The fee invariant above compares that empty book against the contract's.
        handler.fillSome(0, 1_000e18, 0);
        assertEq(handler.callsFill(), 1, "fill");
        assertGt(handler.ghostUnnamedFills(), 0, "and a zero-feeTo leg really was filled");
        assertEq(
            settlement.pendingFees(feeCfg(DEFAULT_SINK), address(tokenB)),
            0,
            "and paid the default nothing"
        );

        handler.fillBatchSome(1, 500e18, 1);
        assertEq(handler.callsBatch(), 1, "batch");

        // Intent 2, not intent 0: the fill above took intent 0 whole and a dead intent takes
        // no dust. Intent 2 is escrowed, so this also proves a one-wei escrow release.
        handler.fillDust(2, 1);
        assertEq(handler.callsDust(), 1, "dust");

        // Intent 4 asks for the widest rate the handler quotes. Nothing on chain caps it, so
        // the fill stands and the ghost books the whole of what it charged.
        handler.fillSome(4, 1_000e18, 0);
        assertEq(handler.callsFill(), 2, "fill at the widest rate");

        handler.withdrawEscrow(2);
        assertEq(handler.callsWithdraw(), 1, "withdraw");

        handler.cancelOne(3);
        assertEq(handler.callsCancel(), 1, "cancel");

        handler.signNewIntent(0, 1, 1_000e18);
        assertEq(handler.callsSign(), 1, "sign");

        handler.fillViaCallback(4, 100e18);
        assertEq(handler.callsCallback(), 1, "callback");

        // A destination empties its book. `8 % 7` is token B and `8 % 2` is the first of the two
        // destinations, which is the one intent 4 named. Without this the fuzzer would only ever
        // see a fee book that grows.
        assertGt(
            settlement.pendingFees(feeCfg(handler.feeTos(0)), address(tokenB)), 0, "a book to empty"
        );
        handler.claimFees(8);
        assertEq(handler.callsClaim(), 1, "claim");
        assertGt(tokenB.balanceOf(handler.sinkAt(0)), 0, "and a destination really was paid");

        assertEq(tokenB.balanceOf(SINK), 0, "and no fill reached the owner's address");
        assertGt(handler.ghostToFeeTo(), 0, "an intent's own destination was charged");
    }

    /**
     * @notice Every rung arms, and every shape of broken bytes is refused — one call each,
     *         without depending on the fuzzer's mood.
     *
     * The two halves are worth reading together. A campaign where only the permit rung ever
     * armed would pass every invariant above and prove nothing about the gasless one; a campaign
     * where nothing ever failed to arm would prove nothing about the frame that catches it.
     */
    function test_EveryRungArmsAndEveryBrokenShapeIsRefused() public {
        // Rung by rung, with sound bytes. The take is a third of the lot, which clears every
        // floor the handler quotes except the two that ask for the whole of it.
        for (uint256 rung = 0; rung < 6; rung++) {
            handler.armAndFill(rung, 0, 1, 0, 0);
        }
        assertEq(handler.armFillsByRung(0), 1, "the permit rung armed");
        assertEq(handler.armFillsByRung(1), 1, "the legacy 3009 rung armed");
        assertEq(handler.armFillsByRung(2), 1, "the 7598 token armed for a key");
        assertEq(
            handler.armFillsByRung(3), 1, "and for a contract wallet, through the fall-through"
        );
        assertEq(handler.armFillsByRung(4), 1, "a taxed token arms when the fill fits what landed");
        assertEq(handler.armFillsByRung(5), 1, "and the permit2 rung armed, granting us nothing");
        assertEq(handler.callsArmRefused(), 0, "and none of the six was refused");

        // Now the bytes that cannot arm. The stale permit nonce belongs to the permit rung and
        // the other three to a gasless one, so each is offered where it means something.
        handler.armAndFill(0, 1, 1, 0, 0);
        assertEq(handler.armRefusalsByShape(1), 1, "a permit against a nonce the token passed");
        handler.armAndFill(1, 2, 1, 0, 0);
        assertEq(handler.armRefusalsByShape(2), 1, "a window that has not opened");
        handler.armAndFill(1, 3, 1, 0, 0);
        assertEq(handler.armRefusalsByShape(3), 1, "a window that has closed");
        handler.armAndFill(1, 4, 1, 0, 0);
        assertEq(handler.armRefusalsByShape(4), 1, "an authorization naming another nonce");

        // A taxed token asked for the whole lot: the redemption works and still comes up short,
        // which is the case no view function could have predicted.
        handler.armAndFill(4, 0, type(uint256).max, 0, 0);
        assertEq(handler.callsArmRefused(), 5, "the taxed leg was refused on the size of the fill");

        // The two widths. A contract wallet's compact signature arms; a key's does not, because
        // the legacy overload is the only one its token has.
        handler.armAndFill(3, 5, 1, 0, 0);
        assertEq(handler.armFillsByRung(3), 2, "the wallet armed on 64 bytes");
        handler.armAndFill(1, 5, 1, 0, 0);
        assertEq(handler.armRefusalsByShape(5), 1, "and the legacy token could not read them");
        handler.armAndFill(3, 6, 1, 0, 0);
        assertEq(handler.armRefusalsByShape(6), 1, "sixty-six bytes are nobody's signature");

        // The permit2 rung's own three ways to fail. A deadline already past, a nonce naming
        // another offer, and a width that is nobody's signature.
        uint256 refusedBefore = handler.callsArmRefused();
        handler.armAndFill(5, 3, 1, 0, 0);
        handler.armAndFill(5, 4, 1, 0, 0);
        handler.armAndFill(5, 6, 1, 0, 0);
        assertEq(handler.callsArmRefused(), refusedBefore + 3, "the permit2 rung refused all three");

        // The width that arms here and nowhere else. Permit2 reads EIP-2098's compact form, so
        // sixty-four bytes settle a permit2 leg where the legacy EIP-3009 overload refuses them.
        handler.armAndFill(5, 5, 1, 0, 0);
        assertEq(handler.armFillsByRung(5), 2, "the compact signature armed the permit2 leg");

        assertFalse(
            handler.aPermit2NonceWasBurnedForNothing(), "a refusal cost the maker their signature"
        );

        // Nothing above burned a signature it did not spend.
        assertFalse(handler.aNonceWasBurnedForNothing(), "a refusal cost a maker their nonce");
    }

    /// @notice The three actions that walk the armed legs after they exist: a second fill out of
    ///         the escrow a redemption left, a pair of offers over one lot, and a dry run.
    function test_TheArmingActionsReallyDoSomething() public {
        // A one-wei take of a floorless gasless intent, which redeems the maker's whole lot and
        // leaves nearly all of it reserved for the next fill.
        handler.armAndFill(1, 0, 0, 0, 0);
        assertEq(handler.callsArm(), 1, "the leg armed");

        handler.fillArmedAgain(0, 4, 0);
        assertEq(handler.callsArmAgain(), 1, "and filled again out of the escrow");

        handler.armTwins(0, 1, 0);
        assertEq(handler.callsTwins(), 1, "two offers over one lot");
        (bytes32 a, bytes32 b) = handler.twinAt(0);
        assertFalse(
            settlement.filled(a) > 0 && settlement.filled(b) > 0, "only one of them could fill"
        );

        // A leg the floor kept from filling, so the walk below has a live authorization to spend
        // and hand back. Seed 3 is a floor of the whole lot and a take of one wei is under it,
        // so the leg is refused before anything is armed.
        handler.armAndFill(1, 0, 0, 3, 0);
        uint256 fresh = handler.armedCount() - 1;
        assertEq(handler.callsArmRefused(), 1, "the floor refused it and nothing was armed");

        bytes32 before = handler.fingerprint();
        handler.dryRunArmed(fresh, type(uint256).max, 0);
        assertEq(handler.callsDryRun(), 1, "a dry run");
        assertEq(handler.callsDryRunThatArmed(), 1, "which armed that leg for real");
        assertEq(handler.ghostDryRunsThatMovedSomething(), 0, "and moved nothing");
        assertEq(handler.ghostDryRunsThatReturned(), 0, "and never returned");
        assertEq(handler.fingerprint(), before, "the state is where the walk found it");

        // The instrument, proved. A fingerprint that never moved would pass the invariant above
        // whatever `dryRun` did with a maker's money.
        handler.armAndFill(1, 0, type(uint256).max, 0, 0);
        assertTrue(handler.fingerprint() != before, "a real fill moves the fingerprint");
    }

    /**
     * @notice The three parking actions really do something.
     *
     * An invariant over a book nothing ever credits is a green statement about nothing, and the
     * fuzzer's own call summary only prints on a failure. This drives each of the three by hand,
     * in the order a maker would meet them: a dead offer's escrow parked, a leg armed out of it,
     * and the rest taken home.
     */
    function test_TheParkingActionsReallyDoSomething() public {
        // A one-wei take of a floorless gasless intent. The redemption pulls the maker's whole
        // lot, so nearly all of it is still reserved when the offer dies.
        handler.armAndFill(1, 0, 0, 0, 0);
        handler.parkDeadArmed(0, 0);
        assertEq(handler.callsPark(), 1, "the dead offer's escrow was parked");

        // A leg on the same rung whose arming was refused, so its reservation is empty and the
        // parked capital is the only thing that can fund it. Shape 3 is a window already closed.
        handler.armAndFill(1, 3, 0, 0, 0);
        uint256 unarmed = handler.armedCount() - 1;
        assertEq(handler.callsArmRefused(), 1, "the closed window refused it");

        handler.fillFromParked(unarmed, 0, 0);
        assertEq(handler.callsParkedFill(), 1, "and the parked capital filled it instead");
        assertTrue(handler.armedFundedFromParked(unarmed), "the maker's row is what paid");

        // 31 is the one seed under 42 that names the legacy rung's maker and the legacy token at
        // once: 31 % 6 is the rung and 31 % 7 is the token.
        handler.unparkRow(31);
        assertEq(handler.callsUnpark(), 1, "and the maker took the rest home");
    }

    /**
     * @notice The escape hatch, by name. A floor of a third of the lot leaves a remainder under
     *         its own floor, and closing the intent out is the only fill that can reach it.
     *
     * A uniform draw lands on the remainder about never, so a campaign can run for a long time
     * without exercising the clause that stops a floor stranding dust. This asks for it.
     */
    function test_AFillUnderTheFloorThatClosesTheIntentIsAllowed() public {
        // `minFillSeed` of 2 is a floor of a third of the lot; a take of one clears nothing.
        handler.armAndFill(1, 0, 0, 2, 0);
        assertEq(handler.callsArmRefused(), 1, "one wei is under the floor");

        // The whole lot instead, which is both above the floor and the closing fill.
        handler.armAndFill(1, 0, type(uint256).max, 2, 0);
        assertEq(handler.callsArm(), 1, "the whole lot went through");

        // A third of the lot, then the remainder — which is two thirds, still above the floor —
        // and then a floor that bites. Seed 3 is a floor of the whole lot, so every partial take
        // is refused and only the closing one is legal.
        handler.armAndFill(1, 0, 0, 3, 0);
        assertEq(handler.callsArmRefused(), 2, "a floor of the whole lot refuses one wei");
        handler.fillArmedAgain(2, 0, 0);
        assertEq(handler.callsArmAgain(), 0, "and the escrow is empty, because nothing armed it");

        // The hatch itself. Seed 4 is a floor of one more than the lot, so no take can ever
        // clear it — and the whole lot goes through anyway, because it closes the intent.
        handler.armAndFill(1, 0, type(uint256).max, 4, 0);
        assertEq(handler.callsArm(), 2, "a take under a floor nothing can clear still filled");
        assertEq(handler.ghostClosingFillsUnderTheFloor(), 1, "because it closed the intent out");

        assertEq(handler.ghostFillsUnderTheFloor(), 0, "no fill ever landed under an open floor");
    }

    /// @notice With `fail_on_revert = false` a run of reverted calls proves nothing. Some runs land
    ///         no fill or no deposit (measured), so the floor is any state change per run.
    function afterInvariant() public view {
        uint256 landed = handler.callsDeposit() + handler.callsFill() + handler.callsBatch()
            + handler.callsWithdraw() + handler.callsCancel() + handler.callsPark();
        assertGt(landed, 0, "no deposit, fill, batch, withdrawal, cancel or park landed");
    }
}

/**
 * @notice The same contract, driven with the tokens and the makers the plain run leaves out: an
 *         input token that taxes its own transfers, an output token with six decimals, and a
 *         maker that is a contract signing through ERC-1271.
 *
 * It runs against its own settlement instance. `AwkwardHandler` says why: a taxing token
 * destroys value on every transfer, and folding a term for that into the plain pair's
 * conservation invariant would weaken the one statement there that has no exceptions.
 *
 * The finding this run exists to state is `invariant_TheTaxIsPaidByTheExecutor`. Read it before
 * the others.
 */
contract AwkwardTokenInvariantsTest is Test {
    ProveSettlement settlement;
    AwkwardHandler handler;
    WeirdToken taxIn;
    WeirdToken outSix;

    address constant SINK = address(0x5153);
    address constant OWNER = address(0xB0B);
    /// @dev Where the handler's one fee sink pays.

    function setUp() public {
        vm.warp(1_700_000_000);
        settlement = newSettlement(NO_PERMIT2);
        handler = new AwkwardHandler(settlement);
        taxIn = handler.taxIn();
        outSix = handler.outSix();

        targetContract(address(handler));
    }

    function _makersHold(WeirdToken t) internal view returns (uint256 held) {
        for (uint256 m = 0; m < 3; m++) {
            held += t.balanceOf(handler.makers(m));
        }
    }

    function _executorsHold(WeirdToken t) internal view returns (uint256 held) {
        for (uint256 e = 0; e < 2; e++) {
            held += t.balanceOf(handler.executors(e));
        }
        held += t.balanceOf(address(handler.bot()));
    }

    /**
     * @notice **The finding.** A taxing input token shorts the executor, by exactly the tax.
     *
     * The contract books `take` as filled, the maker parts with `take`, and the executor is
     * credited `take` less what the token burned in flight. `_deliverTo` brackets the delivery
     * with a balance read and refuses a short payment to the maker; the release leg has no such
     * guard, so nothing notices that the executor bought less than they paid for.
     *
     * This is not a hole an attacker walks through — the maker is not paid twice and nothing is
     * stranded in the contract — and `fillBatch` already tells an executor they need a token
     * allowlist. It is a statement of who carries the loss when they do not have one.
     */
    function invariant_TheTaxIsPaidByTheExecutor() public view {
        assertEq(
            _executorsHold(taxIn),
            handler.ghostTakes() - handler.ghostReleaseTax(),
            "the executors hold the takes less the tax, and nothing else"
        );
    }

    /// @notice The maker parts with exactly what the fills and deposits said, tax included. The
    ///         tax comes out of the `take` they signed for, never out of a second transfer.
    function invariant_TheMakersPartWithExactlyWhatTheySigned() public view {
        assertEq(
            handler.initialTaxSupply() - _makersHold(taxIn),
            handler.ghostMakerDebit(),
            "a maker's balance moved by something other than a fill, a deposit or a withdrawal"
        );
    }

    /**
     * @notice Every unit of the taxed token is accounted for: held by somebody we know, or
     *         burned by an amount the handler predicted before the transfer happened.
     */
    function invariant_TheTaxedTokenIsAccountedFor() public view {
        uint256 all = _makersHold(taxIn) + _executorsHold(taxIn)
            + taxIn.balanceOf(address(settlement)) + taxIn.balanceOf(settlement.relayer());
        assertEq(all, taxIn.totalSupply(), "the taxed token is conserved");
        assertEq(
            handler.initialTaxSupply() - taxIn.totalSupply(),
            handler.ghostTaxBurned(),
            "the token burned an amount the books did not predict"
        );
    }

    /// @notice The escrow accounting survives a token that delivers less than it is told to.
    ///         `deposit` credits what arrived, so a taxed deposit under-funds the intent rather
    ///         than over-crediting it.
    function invariant_TheContractHoldsExactlyTheEscrow() public view {
        uint256 booked;
        uint256 n = handler.intentCount();
        for (uint256 k = 0; k < n; k++) {
            booked += settlement.reserved(settlement.hashIntent(handler.intentAt(k)));
        }
        assertEq(taxIn.balanceOf(address(settlement)), booked, "the taxed token here is reserved");
        assertEq(booked, handler.ghostEscrowNet(), "the reservations match the books");
    }

    /// @notice The output token passes through, whatever its decimals — except for the fees the
    ///         settlement has booked and not yet paid out. Equality, not `assertLe`: a wei here
    ///         that no destination is owed is a maker's delivery that got stuck.
    function invariant_TheContractNeverHoldsTheOutputBeyondTheFeesItOwes() public view {
        assertEq(
            outSix.balanceOf(address(settlement)),
            settlement.totalPendingFees(address(outSix)),
            "the six-decimal output here is something other than a booked fee"
        );
    }

    /**
     * @notice The maker is paid the signed curve less their own fee, in a six-decimal token, and
     *         the ERC-1271 maker is paid the same as the two with keys.
     *
     * The gross is checked beside it, because the two together are the split: the executors part
     * with the curve and the makers keep what the rate leaves.
     */
    function invariant_TheSixDecimalMakersArePaidTheCurve() public view {
        assertEq(handler.ghostOutReceived(), handler.ghostOutOwed(), "the quote left the curve");
        assertEq(_makersHold(outSix), handler.ghostOutOwed(), "a maker was short-changed");
        assertEq(
            handler.ghostOutOwed() + handler.ghostCharged(),
            handler.ghostOutGross(),
            "a rate moved what the executors parted with"
        );
    }

    /**
     * @notice Six decimals is where the fee rounds away, and the ghost rounds away with it.
     *
     * A hundred millionths of a six-decimal token is a gross of a hundred wei. At a ten basis
     * point rate the fee on it is a tenth of a wei, and `_quote` floors, so the destination is
     * paid nothing and the maker keeps the whole hundred. That is the direction the split chose:
     * the dust belongs to the party that signed. The claim here is that the two books agree
     * about it wei for wei, in the token where the rounding actually bites.
     */
    function invariant_TheDestinationEarnsExactlyTheRateOnTheGross() public view {
        address feeTo = handler.FEE_TO();
        uint256 book = settlement.pendingFees(feeCfg(feeTo), address(outSix));
        // Booked plus claimed, because a fee no longer moves during a fill. A run where nobody
        // claims leaves the balance at zero, and the balance alone would witness nothing.
        assertEq(outSix.balanceOf(feeTo) + book, handler.ghostToFeeTo(), "the intents' line");
        assertEq(book, handler.ghostPendingFees(feeTo, address(outSix)), "and the book agrees");
        assertEq(
            settlement.totalPendingFees(address(outSix)), book, "one destination, one whole total"
        );
        assertEq(outSix.balanceOf(SINK), 0, "no fill pays the address the owner set");
    }

    function invariant_CallSummary() public {
        emit log_named_uint("fills   ", handler.callsFill());
        emit log_named_uint("dust    ", handler.callsDust());
        emit log_named_uint("callback", handler.callsCallback());
        emit log_named_uint("deposits", handler.callsDeposit());
        emit log_named_uint("withdraw", handler.callsWithdraw());
        emit log_named_uint("cancels ", handler.callsCancel());
        emit log_named_uint("quirks  ", handler.callsQuirks());
        emit log_named_uint("tax paid", handler.ghostReleaseTax());
        emit log_named_uint("to feeTo", handler.ghostToFeeTo());
    }

    function test_HandlerActionsReallyDoSomething() public {
        handler.setTokenQuirks(500, 1);
        assertEq(handler.callsQuirks(), 1, "quirks");
        assertEq(handler.taxBps(), 500, "the token taxes five per cent");
        assertTrue(handler.silent(), "the token answers with no data");

        handler.fillSome(0, 1e18, 0);
        assertEq(handler.callsFill(), 1, "fill");
        assertGt(handler.ghostReleaseTax(), 0, "the tax bit");

        // Intent 5 belongs to the contract wallet, and one wei of it delivers a hundred wei of a
        // six-decimal token. Both awkward cases in one call.
        handler.fillDust(5, 0);
        assertEq(handler.callsDust(), 1, "dust");
        assertGt(outSix.balanceOf(handler.makers(2)), 0, "the ERC-1271 maker was paid");

        handler.fillViaCallback(2, 1e18);
        assertEq(handler.callsCallback(), 1, "callback");

        handler.depositEscrow(1, 10_000e18);
        assertEq(handler.callsDeposit(), 1, "deposit");

        handler.fillSome(1, 1e18, 1);
        assertEq(handler.callsFill(), 2, "escrow fill");

        handler.withdrawEscrow(1);
        assertEq(handler.callsWithdraw(), 1, "withdraw");

        // Intent 3 is the only one that signs a rate, so it is the only fill that books a fee.
        // It is escrowed, so it needs funding before it will settle at all.
        handler.depositEscrow(3, 10_000e18);
        handler.fillSome(3, 1e18, 0);
        assertGt(handler.ghostToFeeTo(), 0, "the one rate-bearing intent charged something");
        assertGt(
            settlement.pendingFees(feeCfg(handler.FEE_TO()), address(outSix)),
            0,
            "and it was booked here"
        );

        // And the destination takes it out again. Without this the fuzzer would only ever see a
        // fee book that grows.
        handler.claimFees(0);
        assertEq(handler.callsClaim(), 1, "claim");
        assertGt(outSix.balanceOf(handler.FEE_TO()), 0, "the destination really was paid");

        handler.cancelOne(3);
        assertEq(handler.callsCancel(), 1, "cancel");
    }

    /**
     * @notice The guard the output token never gets to test in the stateful run.
     *
     * `_deliverTo` reads the recipient's balance either side of the transfer, so a taxing output
     * token fails the fill instead of shorting the maker. That is why the run's output token is
     * honest: a taxing one reverts every fill and explores nothing.
     */
    function test_ATaxedOutputTokenFailsTheFill() public {
        vm.prank(address(handler));
        outSix.setFeeBps(100);

        // Both reads happen before the cheatcode is armed. An `expectRevert` in flight watches
        // the next call whatever it is, and a getter that answers would discharge it.
        ProveSettlement.Intent memory i = handler.intentAt(0);
        bytes memory sig = handler.signatures(0);

        vm.prank(handler.executors(0));
        vm.expectRevert(ProveSettlement.Underpaid.selector);
        settlement.fill(i, sig, 1_000e18, type(uint256).max);
    }

    /// @notice With `fail_on_revert = false` a run of reverted calls proves nothing. Some runs land
    ///         no fill or no deposit (measured), so the floor is any state change per run.
    function afterInvariant() public view {
        uint256 landed = handler.callsDeposit() + handler.callsFill() + handler.callsClaim()
            + handler.callsWithdraw() + handler.callsCancel() + handler.callsDust();
        assertGt(landed, 0, "no deposit, fill, claim, withdrawal, cancel or dust landed");
    }
}
