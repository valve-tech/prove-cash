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
import {ANY_FEE, MockERC20, NO_PERMIT2} from "./Mocks.sol";

/**
 * @notice Escrow that outlives the intent it was deposited for — `park`, `withdrawParked` and
 *         the fourth arming source.
 *
 *   forge test --match-path test/Parked.t.sol -vv
 *
 * A maker who wanted to re-price used to need two transactions and two token transfers:
 * `withdraw` to take the money out of a dead offer, `deposit` to put the same money back into a
 * new one. The tokens never had to leave the contract for any of it. `park` moves the dead
 * reservation to a row keyed by the maker, and a solver arms the next leg out of that row inside
 * the fill — so the round trip costs one call by anybody and no transfer at all.
 *
 * **The theft attempts are the tests that earn their keep.** Every one of them is a stranger
 * answering "who owns this" on behalf of somebody who is not present, which is the shape of the
 * defect the roadmap records as #112. A stranger parking a live intent, a stranger withdrawing
 * somebody else's row, a solver arming one maker's leg from another's capital, a solver arming
 * across tokens, a solver taking more than the leg spends, and the sweep taking the lot.
 *
 * **The hazard this feature accepts is here too**, in
 * `test_AnUnfundedEscrowSignatureIsNoLongerInert`. Read it before the others: it is the one
 * property a maker loses, and losing it was a decision rather than an oversight.
 */
contract ParkedTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;

    MockERC20 tokenA;
    MockERC20 tokenB;
    /// @dev A second input token, so "same token" is a claim a test can break rather than a
    ///      sentence in a comment.
    MockERC20 tokenC;

    address owner = address(0xB0B);
    address proceeds = STRAY_DESTINATION;
    address executor = address(0xE0E);
    address stranger = address(0x57A);

    address maker;
    uint256 makerKey;
    address rival;
    uint256 rivalKey;

    uint256 constant SIZE = 1_000e18;
    uint256 constant MIN_OUT = 100e18;

    event Parked(
        bytes32 indexed intentHash, address indexed maker, address indexed token, uint256 amount
    );
    event Unparked(address indexed maker, address indexed token, uint256 amount);
    event Deposited(
        bytes32 indexed intentHash, address indexed maker, address indexed token, uint256 amount
    );
    event Cancelled(bytes32 indexed intentHash, address indexed maker);

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        (rival, rivalKey) = makeAddrAndKey("rival");

        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenC = new MockERC20("C", "C", 18);

        tokenA.mint(maker, 10 * SIZE);
        tokenA.mint(rival, 10 * SIZE);
        tokenC.mint(maker, 10 * SIZE);
        tokenB.mint(executor, 10 * SIZE);

        vm.startPrank(maker);
        tokenA.approve(relayer, type(uint256).max);
        tokenC.approve(relayer, type(uint256).max);
        vm.stopPrank();
        vm.prank(rival);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    /**
     * @notice A signature killed by the nonce floor never traps the money behind it.
     *
     * This is the property, and it is the one that has to hold whatever else changes. A maker
     * retires signatures in bulk with `invalidateBefore` — one transaction, every nonce below a
     * floor — and the escrow behind each of them is still theirs to take. Today `withdraw` is
     * how they take it. After #131 `park` will be another way. Either is a pass here, because
     * what a maker is owed is access, not a particular function.
     *
     * Written this way on purpose. The first version of this test asserted that `park` reverts,
     * which pins the gap rather than the guarantee — and a test that asserts a defect goes red on
     * the day somebody repairs it, so the cheapest way to make it green is to delete it. That is
     * a trap for whoever lands #131, not a guard for the maker.
     */
    function test_ADeadSignatureNeverTrapsTheEscrowBehindIt() public {
        ProveSettlement.Intent memory i = _escrow(7);
        bytes memory sig = _sign(makerKey, i);

        vm.prank(maker);
        settlement.deposit(i, SIZE);
        assertEq(
            uint256(settlement.fillability(i, sig, SIZE, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "the offer starts fillable"
        );

        vm.prank(maker);
        settlement.invalidateBefore(8);
        assertEq(
            uint256(settlement.fillability(i, sig, SIZE, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.NonceTooLow),
            "and the floor killed it"
        );

        // The window has not closed and no cancel was written, so this is the state where the
        // signature is dead and the money is still tied to it.
        assertLt(block.timestamp, i.endTime, "the window is still open");
        assertEq(settlement.cancelledAt(settlement.hashIntent(i)), 0, "no cancel was written");

        uint256 before = tokenA.balanceOf(maker);
        vm.prank(maker);
        settlement.withdraw(i);
        assertEq(tokenA.balanceOf(maker) - before, SIZE, "the maker got every unit back");
        assertEq(settlement.reserved(settlement.hashIntent(i)), 0, "and the reservation is empty");
    }

    /**
     * @notice `park` reads the nonce floor. #131.
     *
     * `park` used to ask only whether the window had closed or `cancelledAt` was set. The floor
     * was neither, so the one bulk off switch a maker has was the one rollover could not see:
     * they killed fifty signatures in a transaction and then paid `withdraw` and `deposit` per
     * offer to move the capital, which is the two-step parked capital exists to remove.
     *
     * **This test asserted the fix and skipped until the fix landed.** It said SKIP rather than
     * PASS — `f8ee9b6` and #97 are what that sentence is worth here, where fourteen tests once
     * reported green while running nothing. The `vm.skip` is gone and this is the regression
     * test for the third door.
     */
    function test_ParkAcceptsAnIntentTheNonceFloorKilled() public {
        ProveSettlement.Intent memory i = _escrow(7);
        vm.prank(maker);
        settlement.deposit(i, SIZE);

        vm.prank(maker);
        settlement.invalidateBefore(8);

        // Dead by the floor, inside its window, never cancelled: the case park cannot see today.
        settlement.park(i);

        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "the capital rolled forward");
        assertEq(settlement.reserved(settlement.hashIntent(i)), 0, "and left the dead hash");
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _intent(address tIn, address who, uint256 nonce, uint64 life)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: who,
            recipient: who,
            tokenIn: tIn,
            tokenOut: address(tokenB),
            amountIn: SIZE,
            minOutStart: MIN_OUT,
            minOutEnd: MIN_OUT,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + life,
            executor: address(0),
            // No destination is no fee at all, so nothing here turns on the fee split.
            feeConfig: bytes32(0),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW(),
            nonce: nonce,
            curve: bytes32(0)
        });
    }

    /// @dev An hour is long enough for every test here that wants a live offer, and short enough
    ///      that one `vm.warp` kills it.
    function _escrow(uint256 nonce) internal view returns (ProveSettlement.Intent memory) {
        return _intent(address(tokenA), maker, nonce, 1 hours);
    }

    function _sign(uint256 key, ProveSettlement.Intent memory i)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /// @dev Fund an offer and then kill it by letting its window close. What is left is exactly
    ///      the case `park` exists for: a maker's money behind a signature that can never fill.
    function _deadFundedIntent(uint256 nonce, uint256 amount)
        internal
        returns (ProveSettlement.Intent memory i)
    {
        i = _escrow(nonce);
        vm.prank(maker);
        settlement.deposit(i, amount);
        vm.warp(uint256(i.endTime) + 1);
    }

    /// @dev The whole of the fourth arming shape: one word, and the word only asks.
    function _parkedArming() internal view returns (bytes memory) {
        return abi.encode(settlement.ARM_FROM_PARKED());
    }

    function _leg(ProveSettlement.Intent memory i, bytes memory sig, uint256 take, bytes memory arm)
        internal
        pure
        returns (ProveSettlement.FillRequest[] memory reqs)
    {
        reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = ProveSettlement.FillRequest({intent: i, signature: sig, take: take, arming: arm});
    }

    /// @dev A one-leg batch is the only door onto the parked source, which is a cost this design
    ///      accepts: the arm carries no signature, so no single-fill entry point can be typed for
    ///      it without a fifth external function.
    function _fillFromParked(ProveSettlement.Intent memory i, bytes memory sig, uint256 take)
        internal
        returns (uint256 count)
    {
        // Built before the prank, never inside it. `_parkedArming` reads a constant off the
        // settlement, and a call inside a pranked line eats the prank — the batch would then be
        // sent by this test contract, which holds no allowance.
        ProveSettlement.FillRequest[] memory reqs = _leg(i, sig, take, _parkedArming());
        vm.prank(executor);
        count = settlement.fillBatch(reqs, true, ANY_FEE);
    }

    // ── The feature ──────────────────────────────────────────────────────────

    /**
     * @notice **The hazard, and the reason it is the first test in the file.** An escrow
     *         signature the maker never funded is no longer inert.
     *
     * Before this, "I just will not deposit" was a real off switch, and it was the one property
     * escrow had that no other rung had. Here the maker funds one offer, that offer dies, and a
     * solver fills a *different* signature of theirs out of the capital it left — with no action
     * by the maker, at a moment the solver picked. The maker sent one transaction in this whole
     * test, and it was the deposit against the offer that died.
     *
     * It is the same shape as a decision already taken: a revoked allowance leaves a wallet
     * signature alive, and re-approving revives it. `cancel` and `invalidateBefore` are the off
     * switches now, and the app has to say so.
     */
    function test_AnUnfundedEscrowSignatureIsNoLongerInert() public {
        ProveSettlement.Intent memory dead = _deadFundedIntent(1, SIZE);
        // Signed at the same moment as the first, never funded, and still inside its window.
        ProveSettlement.Intent memory next = _escrow(2);
        next.startTime = uint64(block.timestamp);
        next.endTime = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(makerKey, next);

        assertEq(
            settlement.reserved(settlement.hashIntent(next)), 0, "the second offer was never funded"
        );
        uint256 sentBefore = vm.getNonce(maker);

        // Anybody. The solver does both halves in its own transactions.
        vm.prank(stranger);
        settlement.park(dead);
        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "the capital is resting");

        assertEq(_fillFromParked(next, sig, SIZE), 1, "the unfunded signature filled");
        assertEq(tokenB.balanceOf(maker), MIN_OUT, "and the maker was paid the curve they signed");
        assertEq(vm.getNonce(maker), sentBefore, "having sent no transaction for any of it");
        assertEq(settlement.parked(maker, address(tokenA)), 0, "the capital was spent, all of it");
    }

    /// @notice The ordinary case, end to end: one dead offer pays for the next one, and nothing
    ///         is transferred to do it. The contract's balance never moves.
    function test_AParkedReservationFundsTheNextOfferWithoutATransfer() public {
        ProveSettlement.Intent memory dead = _deadFundedIntent(1, SIZE);
        uint256 held = tokenA.balanceOf(address(settlement));

        settlement.park(dead);

        assertEq(tokenA.balanceOf(address(settlement)), held, "no token moved");
        assertEq(settlement.reserved(settlement.hashIntent(dead)), 0, "the reservation is empty");
        assertEq(settlement.totalReserved(address(tokenA)), 0, "and so is the book behind it");
        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "it is all in the maker's row");
        assertEq(settlement.totalParked(address(tokenA)), SIZE, "and in the book behind that");
    }

    /**
     * @notice Parked capital is not a reservation, so the badge a solver reads still means what
     *         it meant.
     *
     * This is the whole answer to "is this pooled escrow by another name". `_evaluate` reads
     * `_reserved[h]` and only that, so a leg with the maker's entire parked capital behind it
     * reads exactly like an unfunded one until somebody arms it. A plain `fill` — the door with
     * no arming bytes — cannot reach a wei of it.
     */
    function test_ParkedCapitalBacksNoOfferUntilSomebodyArmsIt() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        ProveSettlement.Intent memory next = _escrow(2);
        bytes memory sig = _sign(makerKey, next);

        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "the capital is here");
        assertEq(settlement.reserved(settlement.hashIntent(next)), 0, "and it backs nothing");

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fill(next, sig, SIZE, ANY_FEE);
    }

    /**
     * @notice Cancelling is how a maker re-prices before their window closes, and it is the case
     *         #120 is really about.
     *
     * Waiting for `endTime` is not re-pricing. The maker calls off the offer they no longer
     * want — one transaction they were always going to send — and the capital is free the same
     * block, with no withdrawal and no second deposit.
     */
    function test_ACancelledOfferParksSoAMakerCanRePriceEarly() public {
        ProveSettlement.Intent memory old = _escrow(1);
        vm.startPrank(maker);
        settlement.deposit(old, SIZE);
        settlement.cancel(old);
        vm.stopPrank();

        uint64 killed = settlement.cancelledAt(settlement.hashIntent(old));
        vm.warp(block.timestamp + 1);

        settlement.park(old);

        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "the capital is free");
        assertEq(
            settlement.cancelledAt(settlement.hashIntent(old)),
            killed,
            "and the offer still died at the moment the maker chose, not this one"
        );
    }

    /// @notice `park` says what it did, and it says the offer died too when it was the thing
    ///         that killed it.
    function test_ParkingEmitsTheCancelItWritesAndTheMoveItMakes() public {
        ProveSettlement.Intent memory dead = _deadFundedIntent(1, SIZE);
        bytes32 h = settlement.hashIntent(dead);

        vm.expectEmit(true, true, false, true, address(settlement));
        emit Cancelled(h, maker);
        vm.expectEmit(true, true, true, true, address(settlement));
        emit Parked(h, maker, address(tokenA), SIZE);
        settlement.park(dead);
    }

    /// @notice Arming from parked capital credits a reservation, so it says `Deposited` — the
    ///         same word the other three sources say, for the same thing having happened.
    function test_ArmingFromParkedCapitalSaysDeposited() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        ProveSettlement.Intent memory next = _escrow(2);
        bytes memory sig = _sign(makerKey, next);

        vm.expectEmit(true, true, true, true, address(settlement));
        emit Deposited(settlement.hashIntent(next), maker, address(tokenA), SIZE / 2);
        _fillFromParked(next, sig, SIZE / 2);
    }

    // ── The guards ───────────────────────────────────────────────────────────

    /**
     * @notice A live offer cannot be parked, by anybody, including its own maker.
     *
     * This is the guard that keeps "escrow is committed to one intent" true. Without it a
     * stranger could empty a funded reservation out from under an executor about to fill it, and
     * the promise the "proven" badge makes would be worth nothing.
     */
    function test_ParkingRefusesALiveOffer() public {
        ProveSettlement.Intent memory live = _escrow(1);
        vm.prank(maker);
        settlement.deposit(live, SIZE);

        vm.prank(stranger);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.park(live);

        // Not even the maker, who has `withdraw` for exactly this.
        vm.prank(maker);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.park(live);

        assertEq(settlement.reserved(settlement.hashIntent(live)), SIZE, "still committed");
        assertEq(settlement.parked(maker, address(tokenA)), 0, "and nothing was freed");
    }

    /// @notice An intent with nothing behind it cannot be parked, so parking twice is refused
    ///         and a stranger cannot cancel somebody's unfunded signature with it.
    function test_ParkingRefusesAnOfferWithNothingBehindIt() public {
        ProveSettlement.Intent memory dead = _deadFundedIntent(1, SIZE);
        settlement.park(dead);

        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.park(dead);

        // The other half of the same guard: an expired offer that was never funded at all.
        ProveSettlement.Intent memory never = _escrow(2);
        vm.warp(uint256(never.endTime) + 1);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.park(never);
        assertEq(settlement.cancelledAt(settlement.hashIntent(never)), 0, "nothing was written");
    }

    /**
     * @notice Parking ends the offer, so a stranger's deposit cannot bring the signature back.
     *
     * `withdraw` writes `cancelledAt` for this reason and `park` writes it for the same one.
     * `deposit` is permissionless: without the write, anybody could fund the emptied hash and
     * the maker's abandoned signature would fill months later, unasked.
     */
    function test_ParkingEndsTheOfferSoNobodyCanRefundItBackToLife() public {
        ProveSettlement.Intent memory dead = _deadFundedIntent(1, SIZE);
        settlement.park(dead);

        tokenA.mint(stranger, SIZE);
        vm.startPrank(stranger);
        tokenA.approve(relayer, type(uint256).max);
        vm.expectRevert(ProveSettlement.IsCancelled.selector);
        settlement.deposit(dead, SIZE);
        vm.stopPrank();
    }

    /**
     * @notice The draw is bounded by the leg, never by the pot.
     *
     * A solver must not be able to sweep a maker's whole parked capital into one hash on a
     * one-wei fill. The money would still be the maker's and still recoverable, but it would sit
     * behind an offer the solver chose while every other offer of theirs starved.
     */
    function test_TheDrawIsBoundedByTheLegAndNotByThePot() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        ProveSettlement.Intent memory next = _escrow(2);
        bytes memory sig = _sign(makerKey, next);

        assertEq(_fillFromParked(next, sig, 1), 1, "the one-wei fill settled");

        assertEq(settlement.parked(maker, address(tokenA)), SIZE - 1, "and took one wei with it");
        assertEq(settlement.reserved(settlement.hashIntent(next)), 0, "nothing stayed behind");
    }

    /// @notice A second leg of the same intent draws again, so a partial series works without
    ///         the maker touching anything.
    function test_ASecondLegDrawsAgainFromWhatIsLeft() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        ProveSettlement.Intent memory next = _escrow(2);
        bytes memory sig = _sign(makerKey, next);

        assertEq(_fillFromParked(next, sig, SIZE / 4), 1, "the first quarter settled");
        assertEq(_fillFromParked(next, sig, SIZE / 4), 1, "and so did the second");

        assertEq(settlement.parked(maker, address(tokenA)), SIZE / 2, "half the capital is left");
        assertEq(tokenB.balanceOf(maker), MIN_OUT / 2, "and the maker was paid for half the lot");
    }

    /**
     * @notice A solver cannot arm one maker's leg out of another maker's capital.
     *
     * The keys are `i.maker` and `i.tokenIn`, read from the preimage the signature covers, so
     * there is no hash whose owner has to be established. This is that claim under attack.
     */
    function test_ASolverCannotArmOneMakersLegFromAnothersCapital() public {
        // The rival funds an offer of their own and lets it die.
        ProveSettlement.Intent memory rivalsOld = _intent(address(tokenA), rival, 1, 1 hours);
        vm.prank(rival);
        settlement.deposit(rivalsOld, SIZE);
        vm.warp(uint256(rivalsOld.endTime) + 1);
        settlement.park(rivalsOld);
        assertEq(settlement.parked(rival, address(tokenA)), SIZE, "the rival's capital is here");

        ProveSettlement.Intent memory mine = _escrow(2);
        mine.startTime = uint64(block.timestamp);
        mine.endTime = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(makerKey, mine);

        assertEq(_fillFromParked(mine, sig, SIZE), 0, "the leg was stepped over");
        assertEq(settlement.parked(rival, address(tokenA)), SIZE, "and the rival kept every wei");
        assertEq(settlement.filled(settlement.hashIntent(mine)), 0, "nothing was booked");
    }

    /**
     * @notice The source is keyed by the maker, and `recipient` is not the maker.
     *
     * An intent may pay somebody else — a maker selling into a treasury address does it every
     * day — and the two fields sit next to each other in the struct. The capital that funds a
     * leg is the *signer's*, because the signature is what authorises the move. Reading the
     * recipient's row instead would let anybody who can name a maker as their recipient spend
     * that maker's parked capital.
     */
    function test_TheSourceIsTheMakersRowAndNotTheRecipients() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        ProveSettlement.Intent memory next = _escrow(2);
        next.recipient = rival;
        bytes memory sig = _sign(makerKey, next);

        assertEq(settlement.parked(rival, address(tokenA)), 0, "the recipient has no capital");
        assertEq(_fillFromParked(next, sig, SIZE), 1, "and the leg filled out of the maker's");

        assertEq(settlement.parked(maker, address(tokenA)), 0, "the maker's row paid for it");
        assertEq(tokenB.balanceOf(rival), MIN_OUT, "and the recipient was paid");
    }

    /// @notice A solver cannot arm across tokens. One hash belongs to one token because
    ///         `hashIntent` commits to `tokenIn`, and the draw reads that field and no other.
    function test_ASolverCannotArmAcrossTokens() public {
        ProveSettlement.Intent memory inC = _intent(address(tokenC), maker, 1, 1 hours);
        vm.prank(maker);
        settlement.deposit(inC, SIZE);
        vm.warp(uint256(inC.endTime) + 1);
        settlement.park(inC);
        assertEq(settlement.parked(maker, address(tokenC)), SIZE, "the C capital is here");

        ProveSettlement.Intent memory inA = _escrow(2);
        inA.startTime = uint64(block.timestamp);
        inA.endTime = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(makerKey, inA);

        assertEq(_fillFromParked(inA, sig, SIZE), 0, "the leg was stepped over");
        assertEq(settlement.parked(maker, address(tokenC)), SIZE, "and the C row is untouched");
        assertEq(settlement.parked(maker, address(tokenA)), 0, "with nothing conjured in A");
    }

    /**
     * @notice A word that is not the word is `BadTerms`, and it takes the single-leg batch down
     *         rather than filling something.
     *
     * The length settles which of the escrow rung's two shapes these bytes are before anything
     * is decoded. Without the check on the word itself, any thirty-two bytes a caller invented
     * would arm the parked source, and this leg would fill.
     *
     * The reason the caller reads is `EscrowShort`, not the arm's own `BadTerms`. `_arm` throws
     * the arming reason away on purpose — the leg keeps the reason it already had, which is the
     * point of that catch — so what is asserted here is the outcome: the leg does not settle and
     * the capital does not move.
     */
    function test_AWrongWordIsRefused() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        ProveSettlement.Intent memory next = _escrow(2);
        bytes memory sig = _sign(makerKey, next);
        ProveSettlement.FillRequest[] memory reqs =
            _leg(next, sig, SIZE, abi.encode(keccak256("not the word")));

        // `skipInvalid` off, so a leg that would not settle takes the call down with it.
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);

        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "and nothing was drawn");
        assertEq(settlement.filled(settlement.hashIntent(next)), 0, "and nothing was booked");
    }

    /**
     * @notice An offer welded to a sibling cannot be funded this way, and one lot stays one lot.
     *
     * A maker who names an `authNonce` is posting one lot at two prices: the token spends that
     * nonce once, so whichever sibling is armed first kills the other. This source spends no
     * nonce at all, so without a guard it funds both of them — with the maker's own capital, so
     * nothing else in the contract would notice. The invariant campaign found it; this pins it.
     */
    function test_AnOfferWeldedToASiblingCannotBeFundedFromParkedCapital() public {
        settlement.park(_deadFundedIntent(1, 2 * SIZE));

        bytes32 lot = keccak256("one lot, two prices");
        ProveSettlement.Intent memory cheap = _escrow(2);
        cheap.authNonce = lot;
        ProveSettlement.Intent memory dear = _escrow(3);
        dear.authNonce = lot;

        assertEq(_fillFromParked(cheap, _sign(makerKey, cheap), SIZE), 0, "the first was refused");
        assertEq(_fillFromParked(dear, _sign(makerKey, dear), SIZE), 0, "and so was the second");
        assertEq(settlement.parked(maker, address(tokenA)), 2 * SIZE, "the lot is still one lot");
    }

    /**
     * @notice A leg armed from parked capital is still evaluated in full, so a cancelled intent
     *         and one under the maker's nonce floor both refuse it — and the frame gives the
     *         capital back.
     *
     * The re-evaluation inside `_armLeg` is the whole intent and not just its funding. Without
     * the revertable frame around it, a solver could move a maker's capital into a hash that can
     * never fill and leave it there.
     */
    function test_AParkedDrawCannotFillADeadIntentAndTheFrameGivesItBack() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        ProveSettlement.Intent memory cancelled = _escrow(2);
        bytes memory cancelledSig = _sign(makerKey, cancelled);
        vm.prank(maker);
        settlement.cancel(cancelled);

        assertEq(_fillFromParked(cancelled, cancelledSig, SIZE), 0, "a cancelled leg took nothing");
        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "and the capital came back");

        ProveSettlement.Intent memory low = _escrow(3);
        bytes memory lowSig = _sign(makerKey, low);
        vm.prank(maker);
        settlement.invalidateBefore(low.nonce + 1);

        assertEq(_fillFromParked(low, lowSig, SIZE), 0, "a leg under the floor took nothing");
        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "and the capital came back");
    }

    /// @notice A leg the parked capital cannot cover moves nothing at all, rather than moving a
    ///         part that the fill then refuses.
    function test_ALegTheCapitalCannotCoverDrawsNothing() public {
        settlement.park(_deadFundedIntent(1, SIZE / 2));

        ProveSettlement.Intent memory next = _escrow(2);
        bytes memory sig = _sign(makerKey, next);

        assertEq(_fillFromParked(next, sig, SIZE), 0, "the leg was stepped over");
        assertEq(settlement.parked(maker, address(tokenA)), SIZE / 2, "and the capital sat still");
    }

    /// @notice Asking to arm a leg that needs nothing draws nothing. A solver may send the bytes
    ///         on a leg that already reads `Ok`, and the source has to notice.
    function test_ArmingALegThatIsAlreadyFundedDrawsNothing() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        ProveSettlement.Intent memory next = _escrow(2);
        bytes memory sig = _sign(makerKey, next);
        vm.prank(maker);
        settlement.deposit(next, SIZE);

        assertEq(_fillFromParked(next, sig, SIZE), 1, "the leg filled out of its own reservation");
        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "and the parked row was spared");
    }

    // ── The way out ──────────────────────────────────────────────────────────

    /// @notice A maker takes their parked capital home, and both books fall with it.
    function test_AMakerTakesTheirParkedCapitalHome() public {
        settlement.park(_deadFundedIntent(1, SIZE));
        uint256 held = tokenA.balanceOf(maker);

        vm.expectEmit(true, true, false, true, address(settlement));
        emit Unparked(maker, address(tokenA), SIZE);
        vm.prank(maker);
        assertEq(settlement.withdrawParked(address(tokenA)), SIZE, "it paid the whole row");

        assertEq(tokenA.balanceOf(maker), held + SIZE, "the maker holds it");
        assertEq(settlement.parked(maker, address(tokenA)), 0, "the row is empty");
        assertEq(settlement.totalParked(address(tokenA)), 0, "and so is the book behind it");
    }

    /**
     * @notice `withdrawParked` pays `msg.sender` and can pay nobody else.
     *
     * There is no argument naming a maker, so there is nothing for a caller to point at somebody
     * else. A stranger asking finds their own empty row.
     */
    function test_OnlyTheMakerReachesTheirOwnParkedCapital() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        vm.prank(stranger);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.withdrawParked(address(tokenA));

        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "the maker's row is untouched");
        assertEq(tokenA.balanceOf(stranger), 0, "and the stranger got nothing");
    }

    /// @notice An empty row reverts rather than returning zero quietly. A maker asking about
    ///         their own money with the wrong token argument has to hear about it.
    function test_WithdrawingAnEmptyRowReverts() public {
        vm.prank(maker);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.withdrawParked(address(tokenA));
    }

    // ── The sweep ────────────────────────────────────────────────────────────

    /**
     * @notice **The hazard `_totalParked` exists for.** The sweep cannot take parked capital.
     *
     * `sweepUnowned` pays `balanceOf(this) − booked` to `defaultProceeds`, so a book the
     * subtraction does not know about is money handed to that address. Parked capital belongs to
     * a maker rather than to an intent hash, so it looks unowned to anything reading only the
     * reservations — and this is the first sweep after the first `park`, not an edge a fuzzer
     * has to find.
     */
    function test_TheSweepCannotTakeParkedCapital() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        assertEq(settlement.sweepUnowned(address(tokenA)), 0, "there was nothing unowned");
        assertEq(
            claimedBalance(settlement, proceeds, address(tokenA)),
            0,
            "and the destination got nothing"
        );
        assertEq(
            settlement.parked(maker, address(tokenA)), SIZE, "the capital is still the maker's"
        );

        vm.prank(maker);
        assertEq(settlement.withdrawParked(address(tokenA)), SIZE, "and they can still take it");
    }

    /// @notice A donation beside parked capital is still swept, and only the donation. The third
    ///         term narrows the sweep rather than switching it off.
    function test_ADonationBesideParkedCapitalIsStillSwept() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        tokenA.mint(stranger, 7e18);
        vm.prank(stranger);
        tokenA.transfer(address(settlement), 7e18);

        assertEq(settlement.sweepUnowned(address(tokenA)), 7e18, "the donation left");
        assertEq(claimedBalance(settlement, proceeds, address(tokenA)), 7e18, "for the destination");
        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "and the capital stayed");
    }

    /// @notice A withdrawal clears the book as well as the balance, so the sweep finds nothing
    ///         afterwards. The pair of writes is what the third term rests on.
    function test_AParkedWithdrawalClearsTheBookAsWellAsTheBalance() public {
        settlement.park(_deadFundedIntent(1, SIZE));
        vm.prank(maker);
        settlement.withdrawParked(address(tokenA));

        assertEq(settlement.sweepUnowned(address(tokenA)), 0, "nothing was left to sweep");
        assertEq(tokenA.balanceOf(address(settlement)), 0, "because nothing is here");
    }

    /// @notice A fill armed from parked capital leaves both per-token books where the sweep
    ///         expects them: the capital left as `take`, and nothing became unowned on the way.
    function test_AFillArmedFromParkedCapitalLeavesNothingUnowned() public {
        settlement.park(_deadFundedIntent(1, SIZE));

        ProveSettlement.Intent memory next = _escrow(2);
        bytes memory sig = _sign(makerKey, next);
        _fillFromParked(next, sig, SIZE / 4);

        assertEq(settlement.totalParked(address(tokenA)), (SIZE * 3) / 4, "the book fell by a take");
        assertEq(settlement.totalReserved(address(tokenA)), 0, "the reservation was consumed");
        assertEq(settlement.sweepUnowned(address(tokenA)), 0, "and nothing became unowned");
    }
}
