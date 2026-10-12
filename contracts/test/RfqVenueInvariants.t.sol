// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {RfqVenue} from "../src/RfqVenue.sol";
import {MockERC20, NO_PERMIT2} from "./Mocks.sol";
import {RfqVenueHandler} from "./handlers/RfqVenueHandler.sol";
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
 * @notice The properties `RfqVenue` must keep after any sequence of exclusive fills, refused
 *         pairings, donations and time skips the fuzzer can invent.
 *
 *   forge test --match-path test/RfqVenueInvariants.t.sol -vv
 *
 * The headline is the donation mark, and it is the reason this suite exists. `settleExclusive`
 * marks both tokens before the ring and hands on only the increase, so a token somebody pushed
 * at this address is still here at the end. A unit test can show that for one donation and one
 * fill. Only a run can show it for a donation, four unrelated fills, an expired binding and a
 * time skip in whatever order the fuzzer likes — and that ordering is exactly the shape a
 * regression would need.
 *
 * `test/RfqVenue.t.sol` already proves each refusal one at a time. Nothing here repeats that.
 * These statements are about what survives a sequence.
 */
contract RfqVenueInvariantsTest is Test {
    ProveSettlement settlement;
    RfqVenue venue;
    MockERC20 tokenA;
    MockERC20 tokenB;
    RfqVenueHandler handler;

    address constant SINK = address(0x5152);
    address constant OWNER = address(0xB0B);

    function setUp() public {
        vm.warp(1_700_000_000);
        settlement = newSettlement(NO_PERMIT2);
        venue = new RfqVenue(address(settlement));
        tokenA = new MockERC20("Token A", "A", 18);
        tokenB = new MockERC20("Token B", "B", 18);
        handler = new RfqVenueHandler(settlement, venue, tokenA, tokenB);

        targetContract(address(handler));
    }

    /**
     * @notice The venue never spends a balance it did not earn in the same transaction.
     *
     * This is the whole point of the mark. A stranger's tokens are not the submitter's to take,
     * they cannot discharge a maker's payment, and they cannot pay a fee. The venue holds no
     * inventory of its own between transactions, so every wei sitting here is a donation and the
     * ghost book knows exactly how many there are.
     */
    function invariant_ADonationIsNeverSpentAndNothingElseRests() public view {
        assertEq(
            tokenA.balanceOf(address(venue)),
            handler.ghostDonatedA(),
            "the venue moved token A it did not earn"
        );
        assertEq(
            tokenB.balanceOf(address(venue)),
            handler.ghostDonatedB(),
            "the venue moved token B it did not earn"
        );
    }

    /// @notice A binding is one-shot and stays that way. Nothing in a run turns `spent` back off.
    function invariant_EveryBindingItSettledIsStillSpent() public view {
        uint256 n = handler.trackedCount();
        for (uint256 k = 0; k < n; k++) {
            assertTrue(venue.spent(handler.trackedAt(k)), "a spent binding came back to life");
        }
    }

    /**
     * @notice No binding hash ever settles twice.
     *
     * The handler records every binding it settled in a mapping, so this holds however many
     * rings ran — the bounded array the loop above walks is only there to keep the run fast.
     */
    function invariant_NoBindingSettlesTwice() public view {
        assertFalse(handler.ghostDoubleSettle(), "one binding settled two rings");
        uint256 tracked = handler.trackedCount();
        assertLe(tracked, handler.ghostSettles(), "more bindings than settlements");
    }

    /// @notice Every pairing the venue had to turn away, it turned away. A stranger's mirror, a
    ///         spent binding, an expired one, an open quote, a size the maker did not sign.
    function invariant_NoPairingItMustRefuseEverSettles() public view {
        assertEq(handler.ghostBadAccepted(), 0, "the venue settled a ring it had to refuse");
    }

    /**
     * @notice The ring is two legs, always, and a settled ring moved exactly two.
     *
     * `LEGS` is the number the callback counts `owed` against and the number `settleExclusive`
     * compares the settlement's answer to. A change to it that nothing else followed would show
     * up here as a ring that moved a different number of legs.
     */
    function invariant_ARingIsExactlyTwoLegs() public view {
        assertEq(venue.LEGS(), 2, "the ring stopped being two legs");
        assertEq(handler.ghostLegs(), 2 * handler.ghostSettles(), "a ring moved the wrong count");
    }

    /**
     * @notice The venue holds no allowance to anybody, and nobody owes it one.
     *
     * The callback approves the relayer for exactly what the settlement then pulls, so no
     * allowance survives a ring. And the counterparty's whole promise is that accepting costs
     * them one signature: they approve the relayer once, like everybody else, and never this
     * address. An allowance resting on either side is money somebody else can reach.
     */
    function invariant_NoAllowanceRestsOnEitherSideOfTheVenue() public view {
        address at = address(venue);
        address pull = settlement.relayer();

        assertEq(tokenA.allowance(at, pull), 0, "the venue still owes the relayer token A");
        assertEq(tokenB.allowance(at, pull), 0, "the venue still owes the relayer token B");
        assertEq(tokenA.allowance(at, address(settlement)), 0, "the venue approved the settlement");
        assertEq(tokenB.allowance(at, address(settlement)), 0, "in token B as well");

        assertEq(tokenA.allowance(handler.maker(), at), 0, "the maker approved the venue");
        assertEq(tokenB.allowance(handler.counterparty(), at), 0, "the counterparty approved it");
        assertEq(tokenB.allowance(handler.stranger(), at), 0, "the stranger approved it");
        for (uint256 s = 0; s < 2; s++) {
            address who = handler.submitters(s);
            assertEq(tokenA.allowance(who, at), 0, "a submitter approved the venue");
            assertEq(tokenB.allowance(who, at), 0, "in token B as well");
        }
    }

    /// @notice Both sides were paid exactly the rate they signed — not a wei less, and not a wei
    ///         more out of somebody else's balance. The ghost is worked out from the signed
    ///         terms, so agreeing with it means the settlement priced the legs the same way.
    function invariant_BothSidesGotExactlyTheSignedRate() public view {
        assertEq(
            tokenB.balanceOf(handler.maker()), handler.ghostMakerOwedB(), "the maker was mispaid"
        );
        assertEq(
            tokenA.balanceOf(handler.counterparty()),
            handler.ghostCounterOwedA(),
            "the counterparty was mispaid"
        );
    }

    /**
     * @notice The submitters kept exactly the spread, and the spread is what the terms say.
     *
     * This is the mark read from the other end. Sweeping a wei too much would mean a donation
     * left the building; sweeping a wei too little would mean the venue kept inventory. Both
     * fail here, and the number the ghost holds never asked the contract anything.
     */
    function invariant_TheSubmittersKeptExactlyTheSpread() public view {
        uint256 heldA;
        uint256 heldB;
        for (uint256 s = 0; s < 2; s++) {
            address who = handler.submitters(s);
            heldA += tokenA.balanceOf(who);
            heldB += tokenB.balanceOf(who);
        }
        assertEq(heldA, handler.ghostSweptA(), "the token A spread is wrong");
        assertEq(heldB, handler.ghostSweptB(), "the token B spread is wrong");
    }

    /// @notice The destination each quote named took exactly what its signed rate charged, and
    ///         the whole of it came out of the ring rather than out of a donation.
    ///
    /// `SINK` is `defaultProceeds` here and no fill reads it, so its balance staying at zero is
    /// half the claim: a fee that reached it would be a fee the settlement chose a home for.
    function invariant_TheFeeDestinationsTookExactlyTheSignedFee() public view {
        address feeTo = handler.QUOTE_FEE_TO();
        // The book, not the balance. A fee is booked at the settlement and moves only when
        // somebody calls `claim`; nothing in this run does, so the balances stay at zero and it
        // is the book that has to carry the whole of what was charged.
        assertEq(
            settlement.pendingFees(feeCfg(feeTo), address(tokenA)),
            handler.ghostFeeA(),
            "token A fees"
        );
        assertEq(
            settlement.pendingFees(feeCfg(feeTo), address(tokenB)),
            handler.ghostFeeB(),
            "token B fees"
        );
        assertEq(tokenA.balanceOf(feeTo), 0, "and no fill ever transferred to the destination");
        assertEq(tokenB.balanceOf(feeTo), 0);
        assertEq(tokenA.balanceOf(SINK), 0, "no fill pays the owner's address");
        assertEq(tokenB.balanceOf(SINK), 0);
    }

    /// @notice Nothing is minted or burned by trading, and neither the settlement nor the relayer
    ///         keeps a wei. The venue settles no escrow, so both of those hold nothing at all.
    function invariant_TokensAreConserved() public view {
        assertEq(tokenA.balanceOf(settlement.relayer()), 0, "token A rested in the relayer");
        assertEq(tokenB.balanceOf(settlement.relayer()), 0, "token B rested in the relayer");
        // The settlement holds the fees it has booked and nothing else. It settles no escrow
        // for this venue, so every other wei still passes straight through.
        assertEq(
            tokenA.balanceOf(address(settlement)),
            settlement.totalPendingFees(address(tokenA)),
            "token A rested in the settlement"
        );
        assertEq(
            tokenB.balanceOf(address(settlement)),
            settlement.totalPendingFees(address(tokenB)),
            "token B rested in the settlement"
        );

        // The settlement is in the sum now, because the fees it has booked live in its balance
        // until somebody claims them.
        uint256 a = tokenA.balanceOf(address(venue)) + tokenA.balanceOf(SINK)
            + tokenA.balanceOf(address(settlement)) + tokenA.balanceOf(handler.QUOTE_FEE_TO())
            + tokenA.balanceOf(handler.maker()) + tokenA.balanceOf(handler.counterparty())
            + tokenA.balanceOf(handler.stranger());
        uint256 b = tokenB.balanceOf(address(venue)) + tokenB.balanceOf(SINK)
            + tokenB.balanceOf(address(settlement)) + tokenB.balanceOf(handler.QUOTE_FEE_TO())
            + tokenB.balanceOf(handler.maker()) + tokenB.balanceOf(handler.counterparty())
            + tokenB.balanceOf(handler.stranger());
        for (uint256 s = 0; s < 2; s++) {
            a += tokenA.balanceOf(handler.submitters(s));
            b += tokenB.balanceOf(handler.submitters(s));
        }
        assertEq(a, tokenA.totalSupply(), "token A conserved");
        assertEq(b, tokenB.totalSupply(), "token B conserved");
    }

    /// @notice Not a property — a receipt, printed when a run fails, so a green suite can never
    ///         be a suite that bounced every call before touching state.
    function invariant_CallSummary() public {
        emit log_named_uint("settles     ", handler.callsSettle());
        emit log_named_uint("replays     ", handler.callsReplay());
        emit log_named_uint("wrong party ", handler.callsWrongParty());
        emit log_named_uint("expired     ", handler.callsExpired());
        emit log_named_uint("open quote  ", handler.callsOpenExecutor());
        emit log_named_uint("wrong take  ", handler.callsWrongTake());
        emit log_named_uint("donations   ", handler.callsDonate());
        emit log_named_uint("time skips  ", handler.callsSkip());
    }

    /// @notice The invariants are only worth their runtime if the handler's actions land. This
    ///         proves each one does, without depending on the fuzzer's mood.
    function test_HandlerActionsReallyDoSomething() public {
        handler.donate(0, 5e18);
        handler.donate(1, 7e18);
        assertEq(handler.callsDonate(), 2, "donate");

        handler.settleAnExclusive(100e18, 0, 1, 0);
        assertEq(handler.callsSettle(), 1, "settle");

        handler.skipTime(60);
        assertEq(handler.callsSkip(), 1, "skip");

        handler.settleASpentBinding(1);
        assertEq(handler.callsReplay(), 1, "replay");

        handler.settleForTheWrongCounterparty(200e18, 0, 2);
        assertEq(handler.callsWrongParty(), 1, "wrong counterparty");

        handler.settleAnExpiredBinding(300e18, 0, 3);
        assertEq(handler.callsExpired(), 1, "expired");

        handler.settleAnOpenQuote(400e18, 0, 4);
        assertEq(handler.callsOpenExecutor(), 1, "open quote");

        handler.settleATakeTheMakerDidNotSign(500e18, 0, 5, 1e18);
        assertEq(handler.callsWrongTake(), 1, "wrong take");

        // A second good ring after all of that, so the run has more than one settled binding to
        // check and the replay above is not the last thing that touched the venue.
        handler.settleAnExclusive(600e18, 0, 6, 1);
        assertEq(handler.callsSettle(), 2, "a second settle");

        assertEq(handler.ghostBadAccepted(), 0, "nothing that had to be refused landed");
        assertEq(handler.trackedCount(), 2, "two bindings spent");
        assertEq(tokenA.balanceOf(address(venue)), 5e18, "and the donation never moved");
        assertEq(tokenB.balanceOf(address(venue)), 7e18);
    }

    /// @notice Runs once after every invariant run. With `fail_on_revert = false` a handler whose
    ///         every call reverted would leave each invariant green about an untouched state.
    ///         So each run must have landed the actions the invariants exist to judge.
    function afterInvariant() public view {
        assertGt(handler.callsSettle(), 0, "no binding settled in this run");
    }
}
