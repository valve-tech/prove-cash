// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
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
import {
    ANY_FEE,
    BatchExecutor,
    MockERC3009,
    MockERC7598Wallet,
    MockPermit2,
    SmartWallet
} from "./Mocks.sol";
import {MockERC2612} from "./Permit.t.sol";
import {ReturnBomb} from "./ReturnBomb.t.sol";

/**
 * @notice A gasless token that keeps one per cent of everything it moves.
 *
 * This is the griefing bait. A redemption asks for `amountIn` and credits the reservation with
 * what actually arrived, so the escrow comes up short and the leg cannot fill. It costs the maker
 * one signature and no gas at all to post.
 */
contract TaxedERC3009 is MockERC3009 {
    address constant TAX = address(0xdead);

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 tax = value / 100;
            if (tax != 0) {
                super._update(from, TAX, tax);
                value -= tax;
            }
        }
        super._update(from, to, value);
    }
}

/**
 * @notice A gasless token that answers the settlement's own balance with 960KB of it.
 *
 * The other half of the same griefing bait. `_redeem` brackets the redemption with two reads of
 * this contract's balance, because a token that keeps a cut credits the escrow with less than it
 * was asked for — so those reads are a measurement the reservation depends on. A high-level read
 * copies the whole answer into memory before it looks at a word of it, and memory is priced
 * quadratically, so a token that answers with megabytes spends the solver's gas rather than
 * failing. Thirty thousand words costs some 1.85M gas to produce and the same again to copy,
 * against the thirty thousand `_probe` hands it.
 *
 * **The true balance is the first word, and the padding follows it.** A bomb of plain zeros would
 * be refused by the arithmetic rather than by the cap — the delta would read as nothing moved and
 * the leg would be stepped over for the wrong reason, which is a test that passes whatever the
 * contract does. This one answers correctly and expensively, so the only thing standing between
 * the solver and the gas is the bound.
 */
contract BombingERC3009 is MockERC3009 {
    /// @dev The one reader it bombs. Every other balance is answered plainly, so the leg gets all
    ///      the way to the redemption before anything goes wrong.
    address public target;

    function aimAt(address who) external {
        target = who;
    }

    function balanceOf(address who) public view override returns (uint256) {
        uint256 held = super.balanceOf(who);
        if (who != target) return held;
        assembly {
            mstore(0x00, held)
            return(0x00, 960000)
        }
    }
}

/**
 * @notice Arming a leg from inside a batch — the permit, the authorization and the Permit2
 *         signature.
 *
 *   forge test --match-path test/Arming.t.sol -vv
 *
 * A batch used to reach two of the five custody rungs. `FillRequest.arming` reaches the other
 * three, so a maker who signed and sent nothing can be a leg of somebody's ring. The intent's own
 * custody flags say which kind of signature the bytes hold, which is the same rule
 * `fillWithPermit`, `fillWithAuthorization` and `fillWithPermit2` run at their own doors — all
 * four reach `_armLeg`, and only this one wraps it in a frame it can revert.
 *
 * The tests that earn their keep are the ones about failure. Arming spends a maker's nonce and
 * moves their money, so the question is not whether it works — it is what is left behind when it
 * does not. The answer has to be nothing, because a failure that burned a nonce would hand
 * anybody with a signature a free way to cost solvers a batch each, over and over.
 *
 * **The permit2 rung is the one that survives a redeploy, and that is why it is here.** Every
 * other rung that reaches a wallet needs an ERC-20 approval to `ProveRelayer`, and the settlement
 * makes the relayer — so a new settlement orphans every one of those approvals. A permit2 maker
 * approves Permit2, once, at an address that never moves. Several tests below assert the
 * consequence directly: that maker's allowance to the relayer is zero before, during and after
 * the fill, and the only grant they ever made was to Permit2.
 */
contract ArmingTest is Test {
    ProveSettlement settlement;
    /// @dev Read once. `vm.prank` is single-shot and a call inside a pranked line eats the prank.
    address relayer;
    BatchExecutor exec;

    MockERC2612 tokenA;
    MockERC3009 tokenB;
    /// @dev The one address in this file that a redeploy would not move. Deployed before the
    ///      settlement, because the settlement hands it to the relayer it creates.
    MockPermit2 permit2;

    address owner = address(0x0117E1);
    address proceeds = address(0x9BEE);

    uint256 constant SIZE = 100e18;

    /// @dev One maker per rung, so a test can say which rung failed by which maker went unpaid.
    address permitMaker;
    uint256 permitKey;
    address approvalMaker;
    uint256 approvalKey;
    address gaslessMaker;
    uint256 gaslessKey;
    address escrowMaker;
    uint256 escrowKey;
    address permit2Maker;
    uint256 permit2Key;

    function setUp() public {
        (permitMaker, permitKey) = makeAddrAndKey("permit maker");
        (approvalMaker, approvalKey) = makeAddrAndKey("approval maker");
        (gaslessMaker, gaslessKey) = makeAddrAndKey("gasless maker");
        (escrowMaker, escrowKey) = makeAddrAndKey("escrow maker");
        (permit2Maker, permit2Key) = makeAddrAndKey("permit2 maker");

        permit2 = new MockPermit2();
        settlement = newSettlement(address(permit2));
        relayer = settlement.relayer();
        exec = new BatchExecutor();

        tokenA = new MockERC2612();
        tokenB = new MockERC3009();

        tokenA.mint(permitMaker, SIZE);
        tokenA.mint(approvalMaker, SIZE);
        tokenA.mint(permit2Maker, SIZE);
        tokenB.mint(gaslessMaker, SIZE);
        // Twice, because the escrow leg is the one that carries the odd size in the five-rung
        // ring. Three legs sell token A and two sell token B, so one of the two has to be worth
        // both of the odd ones or the ring cannot close.
        tokenB.mint(escrowMaker, 2 * SIZE);

        // The only standing grant to the relayer in the file. Every other maker's funds are
        // reached by a signature, which is the point.
        vm.prank(approvalMaker);
        tokenA.approve(relayer, type(uint256).max);

        /*
         * The permit2 maker's only approval, ever, and it does not name anything of ours.
         *
         * `ProveSettlement`'s constructor makes `ProveRelayer`, so a settlement redeploy moves
         * the relayer and every allowance pointing at it becomes an allowance to a dead
         * contract. That is what happened on testnet and it cost every maker a re-approval.
         * Permit2 is at one address on every chain and moves for nobody, so this grant outlives
         * every settlement we will ever deploy.
         */
        vm.prank(permit2Maker);
        tokenA.approve(address(permit2), type(uint256).max);

        // The solver holds nothing and pays from what the releases hand it.
        exec.approveMax(address(tokenA), relayer);
        exec.approveMax(address(tokenB), relayer);

        vm.warp(1_700_000_000);
    }

    // ── The two rungs a batch could not reach ────────────────────────────────

    function test_APermitLegRidesInABatch() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permitLeg();

        assertEq(tokenA.allowance(permitMaker, relayer), 0, "no allowance before");
        assertEq(vm.getNonce(permitMaker), 0, "and the maker sent no transaction");

        // The solver fills from inventory here, so the leg is the only thing under test.
        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        uint256 count = settlement.fillBatch(reqs, false, ANY_FEE);

        assertEq(count, 1, "the leg settled");
        assertEq(tokenB.balanceOf(permitMaker), SIZE, "the maker got the rate they signed");
        assertEq(vm.getNonce(permitMaker), 0, "and still sent no transaction");
    }

    function test_AGaslessLegRidesInABatch() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _gaslessLeg(tokenB, gaslessMaker, gaslessKey);

        assertEq(vm.getNonce(gaslessMaker), 0, "the maker sent no transaction");

        tokenA.mint(address(exec), SIZE);
        vm.prank(address(exec));
        uint256 count = settlement.fillBatch(reqs, false, ANY_FEE);

        assertEq(count, 1, "the leg settled");
        assertEq(tokenA.balanceOf(gaslessMaker), SIZE, "the maker got the rate they signed");
        assertEq(vm.getNonce(gaslessMaker), 0, "and still sent no transaction");
    }

    /**
     * @notice Five rungs, one ring, and a solver that starts and ends with nothing.
     *
     * Three makers sell token A and two sell token B, at one for one, and the escrow leg is
     * worth two so the two sides come to the same number — the releases pay for the deliveries
     * exactly and the solver never has to hold inventory. That the five legs are funded five
     * different ways is invisible by the time anybody is paid, which is the whole claim this
     * file exists to make.
     */
    function test_AllFiveRungsSettleInOneRingHoldingNothing() public {
        assertEq(tokenA.balanceOf(address(exec)), 0, "the solver starts with nothing");
        assertEq(tokenB.balanceOf(address(exec)), 0);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](5);
        reqs[0] = _permitLeg();
        reqs[1] = _approvalLeg();
        reqs[2] = _gaslessLeg(tokenB, gaslessMaker, gaslessKey);
        reqs[3] = _escrowLeg(2 * SIZE);
        reqs[4] = _permit2Leg();

        uint256 count = exec.settle(settlement, reqs, false, "", ANY_FEE);

        assertEq(count, 5, "every leg settled");
        assertEq(tokenB.balanceOf(permitMaker), SIZE, "the permit maker was paid");
        assertEq(tokenB.balanceOf(approvalMaker), SIZE, "the approval maker was paid");
        assertEq(tokenA.balanceOf(gaslessMaker), SIZE, "the gasless maker was paid");
        assertEq(tokenA.balanceOf(escrowMaker), 2 * SIZE, "the escrow maker was paid");
        assertEq(tokenB.balanceOf(permit2Maker), SIZE, "the permit2 maker was paid");
        assertEq(tokenA.balanceOf(address(exec)), 0, "and the solver ends with nothing");
        assertEq(tokenB.balanceOf(address(exec)), 0);

        // The claim the rung is for. Nothing this maker granted points at an address the next
        // settlement will move.
        assertEq(tokenA.allowance(permit2Maker, relayer), 0, "the permit2 maker granted us nothing");
    }

    // ── The permit2 rung ─────────────────────────────────────────────────────

    /**
     * @notice A permit2 leg fills in a batch, and the maker never granted us anything.
     *
     * The assertions either side of the fill are the point of the rung. The maker's allowance to
     * the relayer is zero before and zero after — there is nothing there for a redeploy to
     * orphan — and the one grant they ever made names Permit2, which no redeploy of ours can
     * move.
     */
    function test_APermit2LegRidesInABatch() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2Leg();

        assertEq(tokenA.allowance(permit2Maker, relayer), 0, "no allowance to the relayer");
        assertEq(
            tokenA.allowance(permit2Maker, address(permit2)),
            type(uint256).max,
            "and one to Permit2, which is the whole of what this maker did"
        );

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        uint256 count = settlement.fillBatch(reqs, false, ANY_FEE);

        assertEq(count, 1, "the leg settled");
        assertEq(tokenB.balanceOf(permit2Maker), SIZE, "the maker got the rate they signed");
        assertEq(tokenA.balanceOf(permit2Maker), 0, "and parted with what they sold");
        assertEq(tokenA.allowance(permit2Maker, relayer), 0, "still no allowance to the relayer");
        assertEq(settlement.reserved(settlement.hashIntent(reqs[0].intent)), 0, "nothing left here");
    }

    /// @notice The same leg through the single-fill door. `fillWithPermit2` is `_armLeg` and
    ///         `_book`, exactly as `fillWithAuthorization` is, so both doors run one set of rules.
    function test_APermit2LegFillsThroughItsOwnDoor() public {
        ProveSettlement.FillRequest memory req = _permit2Leg();
        ProveSettlement.Permit2Transfer memory p =
            abi.decode(req.arming, (ProveSettlement.Permit2Transfer));

        tokenB.mint(address(exec), SIZE);
        vm.startPrank(address(exec));
        tokenB.approve(relayer, SIZE);
        settlement.fillWithPermit2(req.intent, req.signature, req.take, p, ANY_FEE);
        vm.stopPrank();

        assertEq(tokenB.balanceOf(permit2Maker), SIZE, "the maker got the rate they signed");
        assertEq(tokenA.balanceOf(address(exec)), SIZE, "and the solver holds its token A");
        assertEq(tokenA.allowance(permit2Maker, relayer), 0, "with no allowance granted to us");
    }

    /**
     * @notice The first partial fill draws the whole intent into escrow, and the rest is fillable.
     *
     * This test used to assert the opposite, and called it the one thing this rung did better
     * than EIP-3009: Permit2 allows a request under the permitted amount, so a partial fill drew
     * only what it filled and stranded nothing.
     *
     * The saving was never real. A non-partial intent must take exactly what is left, and on its
     * only fill that is `amountIn` — so `take` and the whole amount were already the same number
     * and there was nothing to save. The behaviours differed for a PARTIAL intent alone, and
     * there the small draw was not a saving, it was the bug: a Permit2 nonce is spent on the
     * first `permitTransferFrom` however little it requested, so the first partial shut the door
     * behind itself and the rest of a live offer became unreachable. `remaining` said the offer
     * was open and nothing on chain could fill it.
     *
     * So the first fill promotes the signature into a reservation, exactly as `_redeem` does for
     * EIP-3009. What a one-shot signature must buy on its way through is not a smaller draw but a
     * custody position that outlives it.
     */
    function test_TheFirstPermit2FillPromotesTheWholeIntentIntoEscrow() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2LegOf(SIZE, SIZE / 4, settlement.FLAG_PARTIAL());
        bytes32 h = settlement.hashIntent(reqs[0].intent);

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 1, "the leg settled");

        assertEq(tokenA.balanceOf(permit2Maker), 0, "the whole lot left the wallet at once");
        assertEq(settlement.reserved(h), (SIZE * 3) / 4, "and three quarters wait in escrow");
        assertEq(tokenB.balanceOf(permit2Maker), SIZE / 4, "the maker was paid for a quarter");
    }

    /**
     * @notice The rest of the intent fills from the reservation, without asking Permit2 again.
     *
     * The replay property is untouched and is Permit2's own: a nonce is a bitmap slot and it is
     * spent once. What changed is that nothing asks a second time. `_pullPermit2In` reads
     * `_reserved[h]` first, finds the promotion covers this fill, and never reaches the signature
     * at all — so the second half settles out of the maker's own escrowed money.
     *
     * The old behaviour was for this to come back `EscrowShort` with the remainder unreachable,
     * and the comment here called that fine because the maker could sign again. A maker who signs
     * a partial-fillable offer is asking for several fills; needing a fresh signature after each
     * one is not a partial fill, it is a series of single ones they have to attend.
     */
    function test_TheRestOfAPermit2IntentFillsFromTheReservation() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2LegOf(SIZE, SIZE / 2, settlement.FLAG_PARTIAL());
        bytes32 h = settlement.hashIntent(reqs[0].intent);

        tokenB.mint(address(exec), SIZE);
        vm.startPrank(address(exec));
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 1, "the first half settled");
        assertEq(settlement.reserved(h), SIZE / 2, "the other half is held for this intent");
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 1, "and the second half settled too");
        vm.stopPrank();

        assertEq(tokenA.balanceOf(permit2Maker), 0, "the maker parted with the whole lot");
        assertEq(tokenB.balanceOf(permit2Maker), SIZE, "and was paid for all of it");
        assertEq(settlement.reserved(h), 0, "with nothing left reserved");
    }

    /**
     * @notice Filling it out exactly exhausts the intent, and a further attempt takes nothing.
     *
     * The bound is `filled[h]`, not the reservation. A promotion that outlived the intent would
     * be the real hazard here — money in this contract with no offer left to spend it — so the
     * two have to run out together.
     */
    function test_APermit2IntentCannotBeFilledPastItsAmount() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2LegOf(SIZE, SIZE / 2, settlement.FLAG_PARTIAL());
        bytes32 h = settlement.hashIntent(reqs[0].intent);

        tokenB.mint(address(exec), SIZE * 2);
        vm.startPrank(address(exec));
        settlement.fillBatch(reqs, false, ANY_FEE);
        settlement.fillBatch(reqs, false, ANY_FEE);
        // Nothing left to fill: `_evaluate` refuses on the take before it looks at any signature.
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "a third fill takes nothing");
        vm.stopPrank();

        assertEq(settlement.filled(h), SIZE, "exactly the amount signed for, and no more");
        assertEq(tokenA.balanceOf(permit2Maker), 0, "the maker parted with that and nothing else");
        assertEq(settlement.reserved(h), 0, "and the reservation ran out with the offer");
    }

    /**
     * @notice The maker can take back whatever the offer never filled.
     *
     * The promotion moves money earlier than the old behaviour did, so the way back has to be
     * plain. `withdraw` is the maker's alone, it returns the whole reservation, and it cancels
     * the offer on the way out so the two cannot disagree afterwards.
     */
    function test_APermit2MakerWithdrawsWhatWentUnfilled() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2LegOf(SIZE, SIZE / 4, settlement.FLAG_PARTIAL());
        bytes32 h = settlement.hashIntent(reqs[0].intent);

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        settlement.fillBatch(reqs, false, ANY_FEE);
        assertEq(settlement.reserved(h), (SIZE * 3) / 4, "three quarters are in escrow");

        vm.prank(permit2Maker);
        settlement.withdraw(reqs[0].intent);

        assertEq(tokenA.balanceOf(permit2Maker), (SIZE * 3) / 4, "and they came home");
        assertEq(settlement.reserved(h), 0, "the reservation is empty");
        assertGt(settlement.cancelledAt(h), 0, "and the offer is off the board");
    }

    /**
     * @notice A permission smaller than the intent draws only what it permits.
     *
     * The draw is capped at `amountIn` because that is all the offer could ever consume, but the
     * permission is the other bound and it is the maker's. A maker who signs a permission for
     * less than they offered keeps the difference in their own wallet — nothing here reaches for
     * more of somebody's money than they put their name to.
     */
    function test_APermit2DrawNeverExceedsThePermissionSigned() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2LegOf(SIZE, SIZE / 4, settlement.FLAG_PARTIAL());
        bytes32 h = settlement.hashIntent(reqs[0].intent);

        // Re-sign the permission for half the offer, leaving the intent itself alone.
        ProveSettlement.Permit2Transfer memory p =
            abi.decode(reqs[0].arming, (ProveSettlement.Permit2Transfer));
        reqs[0].arming = abi.encode(
            _permit2Transfer(address(tokenA), SIZE / 2, p.nonce, p.deadline, permit2Key)
        );

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 1, "the quarter still filled");

        assertEq(tokenA.balanceOf(permit2Maker), SIZE / 2, "half never left the wallet");
        assertEq(settlement.reserved(h), SIZE / 4, "and the rest of the permission is escrowed");
    }

    /**
     * @notice A whole fill behaves exactly as it did before, which is most of the book.
     *
     * A non-partial intent takes what is left on its only fill, so the promotion and the old draw
     * are the same number and this rung is unchanged for it. Worth a test of its own: the change
     * would be a poor trade if it moved money differently for the ordinary case.
     */
    function test_AWholePermit2FillDrawsExactlyTheIntent() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2LegOf(SIZE, SIZE, 0);
        bytes32 h = settlement.hashIntent(reqs[0].intent);

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 1, "it settled");

        assertEq(tokenA.balanceOf(permit2Maker), 0, "the whole lot moved, as it always did");
        assertEq(settlement.reserved(h), 0, "and nothing was left behind");
        assertEq(tokenB.balanceOf(permit2Maker), SIZE, "the maker got the rate they signed");
    }

    /**
     * @notice Many small fills move the maker's money exactly once, in total.
     *
     * The property the promotion has to keep across any number of fills: Permit2 is asked once,
     * the wallet is drawn once, and the sum of the fills is bounded by the offer. A fuzz over the
     * fill size, because a fencepost in the promotion would show up at one size and not another.
     */
    function testFuzz_ManyPermit2PartialsDrawTheWalletOnce(uint8 slices) public {
        uint256 n = bound(uint256(slices), 2, 10);
        uint256 take = SIZE / n;
        vm.assume(take > 0);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2LegOf(SIZE, take, settlement.FLAG_PARTIAL());
        bytes32 h = settlement.hashIntent(reqs[0].intent);

        tokenB.mint(address(exec), SIZE * 2);
        vm.startPrank(address(exec));
        uint256 filled;
        for (uint256 k = 0; k < n; k++) {
            filled += settlement.fillBatch(reqs, true, ANY_FEE);
        }
        vm.stopPrank();

        assertEq(filled, n, "every slice settled");
        assertEq(tokenA.balanceOf(permit2Maker), 0, "the wallet was drawn once, at the start");
        assertEq(settlement.filled(h), take * n, "and the fills add up to what was taken");
        assertEq(settlement.reserved(h), SIZE - take * n, "the unfilled remainder is still held");
    }

    /**
     * @notice A rival takes the floor's worth, and the remainder still fills — but only exactly.
     *
     * The question this answers: a hundred tokens with a floor of sixty, and another solver takes
     * the first sixty. Forty are left, which is under the floor. Is the rest of the offer dead?
     *
     * No, and the carve-out that saves it is `take != remaining` on the floor check. A fill may
     * not go under the floor UNLESS it closes the offer out — otherwise a floor of sixty on a
     * hundred would strand the last forty for good, unreachable from both sides: too small for
     * the floor, too large for nothing.
     *
     * So the remainder fills at exactly forty and at no other size. Asking for sixty is `TooMuch`
     * and asking for thirty is `BelowMinFill_`. A solver that sizes its take off a book loaded
     * before the rival landed asks for sixty and is stepped over — cheaply, and it should ask
     * again with what is actually left rather than treat the offer as gone.
     *
     * The escrow is what makes the remainder reachable at all. The rival's fill promoted the
     * Permit2 signature into a reservation of the whole hundred, so the forty are already here
     * and no signature is needed to spend them.
     */
    function test_ARivalTakesTheFloorAndTheRemainderStillClosesOut() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2LegWithFloor(SIZE, (SIZE * 3) / 5, (SIZE * 3) / 5);
        bytes32 h = settlement.hashIntent(reqs[0].intent);

        tokenB.mint(address(exec), SIZE * 3);
        vm.startPrank(address(exec));

        // The rival takes the floor's worth. That promotes the whole hundred into escrow.
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 1, "the rival took sixty");
        assertEq(settlement.reserved(h), (SIZE * 2) / 5, "and forty are held for this offer");

        // Asking again for sixty: there is not sixty left.
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "sixty more is too much");

        // Asking for thirty: under the floor, and it would not close the offer out.
        reqs[0].take = (SIZE * 3) / 10;
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "thirty is under the floor");

        // Asking for exactly what is left: under the floor too, and allowed for that reason.
        reqs[0].take = (SIZE * 2) / 5;
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 1, "forty closes it out");

        vm.stopPrank();

        assertEq(settlement.filled(h), SIZE, "the offer filled to the wei");
        assertEq(settlement.reserved(h), 0, "with nothing left reserved");
        assertEq(tokenA.balanceOf(permit2Maker), 0, "and the maker parted with it once");
        assertEq(tokenB.balanceOf(permit2Maker), SIZE, "paid for all of it");
    }

    /// @notice The three sizes named above, each refused for its own reason on a ring.
    function test_TheReasonsAPartialRemainderIsRefusedAreDistinct() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2LegWithFloor(SIZE, (SIZE * 3) / 5, (SIZE * 3) / 5);

        tokenB.mint(address(exec), SIZE * 3);
        vm.startPrank(address(exec));
        settlement.fillBatch(reqs, false, ANY_FEE);

        // A ring cannot step over, so the reason reaches the caller instead of a skip. Which
        // reason it is decides what a solver should do next, and they want opposite answers:
        // TooMuch means ask for less, BelowMinFill_ means this size will never work.
        vm.expectRevert(ProveSettlement.TooMuch.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);

        reqs[0].take = (SIZE * 3) / 10;
        vm.expectRevert(ProveSettlement.BelowMinFill.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);
        vm.stopPrank();
    }

    /**
     * @notice A leg whose Permit2 signature is not the maker's leaves nothing behind.
     *
     * The same claim the gasless rung makes, asked of this one: a failure that spent the nonce
     * would let anybody with a copy of the intent cost solvers a batch each, for ever. Permit2
     * spends the nonce before it checks the signature, so the unwind is the whole of the
     * defence — and the unwind is `armLeg`'s frame.
     */
    function test_ABadPermit2SignatureLeavesNothingBehind() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2Leg();

        // A real permit for the right maker, over the right lot, signed by somebody else.
        ProveSettlement.Permit2Transfer memory p =
            abi.decode(reqs[0].arming, (ProveSettlement.Permit2Transfer));
        (, uint256 stranger) = makeAddrAndKey("a stranger");
        (uint8 v, bytes32 r, bytes32 sv) =
            vm.sign(stranger, _permit2Digest(p.token, p.amount, p.nonce, p.deadline));
        p.signature = abi.encodePacked(r, sv, v);
        reqs[0].arming = abi.encode(p);

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "nothing settled");

        assertEq(tokenA.balanceOf(permit2Maker), SIZE, "the maker's tokens never moved");
        assertEq(permit2.nonceBitmap(permit2Maker, p.nonce >> 8), 0, "and the nonce is unspent");

        // A ring says so out loud rather than reading Permit2's own error, which names nothing a
        // solver could act on.
        vm.prank(address(exec));
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);
    }

    /**
     * @notice A Permit2 signature over another token does not arm this leg.
     *
     * `_receive` gets this for free — it names `i.tokenIn` in the call it makes — and a Permit2
     * permit carries its own token, so the settlement checks it instead. Without the check the
     * other asset would land here belonging to no reservation, and `sweepUnowned` would hand it
     * to `defaultProceeds`.
     */
    function test_APermit2SignatureOverAnotherTokenDoesNotArmThisLeg() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2Leg();

        ProveSettlement.Permit2Transfer memory p =
            abi.decode(reqs[0].arming, (ProveSettlement.Permit2Transfer));
        p.token = address(tokenB);
        reqs[0].arming = abi.encode(p);

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "nothing settled");
        assertEq(tokenA.balanceOf(permit2Maker), SIZE, "the maker's tokens never moved");
        assertEq(permit2.nonceBitmap(permit2Maker, p.nonce >> 8), 0, "and the nonce is unspent");
    }

    /**
     * @notice A Permit2 signature naming another nonce does not arm this leg.
     *
     * The intent says which nonce funds it, exactly as it does for a 3009 authorization. Without
     * this one check a maker who signed once would have armed every same-size intent they ever
     * sign, and calling off the intent it was meant for would not have revoked it.
     */
    function test_APermit2SignatureNamingAnotherNonceDoesNotArmThisLeg() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2Leg();

        ProveSettlement.Permit2Transfer memory p = _permit2Transfer(
            address(tokenA),
            SIZE,
            uint256(keccak256("a permit for somewhere else")),
            block.timestamp + 1 days,
            permit2Key
        );
        reqs[0].arming = abi.encode(p);

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "nothing settled");
        assertEq(tokenA.balanceOf(permit2Maker), SIZE, "the maker's tokens never moved");
        assertEq(permit2.nonceBitmap(permit2Maker, p.nonce >> 8), 0, "and the nonce is unspent");
    }

    /**
     * @notice A maker who names their own `authNonce` gets exclusion on this rung too.
     *
     * The field was written for EIP-3009 and it means the same thing here, because Permit2 spends
     * a nonce once as well: two offers over one lot naming one nonce are mutually exclusive, and
     * whichever is armed first kills the other. One signed field, two rungs, no new field.
     */
    function test_APermit2IntentMayNameTheNonceThatFundsIt() public {
        bytes32 named = keccak256("one lot, two prices");

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0].intent =
            _intent(permit2Maker, address(tokenA), address(tokenB), settlement.FLAG_PERMIT2());
        reqs[0].intent.authNonce = named;
        reqs[0].signature = _sign(reqs[0].intent, permit2Key);
        reqs[0].take = SIZE;
        reqs[0].arming = abi.encode(
            _permit2Transfer(
                address(tokenA), SIZE, uint256(named), block.timestamp + 1 days, permit2Key
            )
        );

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        assertEq(
            settlement.fillBatch(reqs, false, ANY_FEE), 1, "the leg settled on the named nonce"
        );
        assertEq(tokenB.balanceOf(permit2Maker), SIZE, "the maker got the rate they signed");

        // Spent, so a sibling naming the same nonce can never be funded.
        assertTrue(
            permit2.nonceBitmap(permit2Maker, uint256(named) >> 8) != 0, "the nonce is spent"
        );
    }

    /**
     * @notice A permit2 leg somebody has already funded spends no signature at all.
     *
     * `deposit` is permissionless and names no flags, so a reservation can exist behind an intent
     * on this rung. The arming call asks Permit2 only when the reservation cannot cover the
     * fill — the same rule `_redeemInto` runs — so the maker's signature survives for the next
     * time.
     */
    function test_APermit2LegAlreadyFundedSpendsNoSignature() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permit2Leg();
        ProveSettlement.Permit2Transfer memory p =
            abi.decode(reqs[0].arming, (ProveSettlement.Permit2Transfer));

        // A stranger funds it, out of their own pocket and through the ordinary door.
        address donor = makeAddr("donor");
        tokenA.mint(donor, SIZE);
        vm.startPrank(donor);
        tokenA.approve(relayer, SIZE);
        settlement.deposit(reqs[0].intent, SIZE);
        vm.stopPrank();

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 1, "the leg settled");

        assertEq(tokenA.balanceOf(permit2Maker), SIZE, "out of the donor's tokens, not the maker's");
        assertEq(permit2.nonceBitmap(permit2Maker, p.nonce >> 8), 0, "and the nonce is unspent");
    }

    /**
     * @notice The single door looks at the intent before it spends the maker's signature.
     *
     * A Permit2 nonce is single-use, so spending one on an intent that is already expired,
     * cancelled or below the maker's nonce floor burns a signature the maker cannot get back.
     * Worse, Permit2 often fails first — a past deadline, a nonce already gone — so without the
     * look the caller reads Permit2's error and never learns that the offer itself was dead.
     *
     * `EscrowShort` is the one reason to carry on, because funding an empty reservation is what
     * this door is for. Every other reason stops here, with the reason.
     */
    function test_FillWithPermit2LooksAtTheIntentBeforeSpendingTheSignature() public {
        ProveSettlement.FillRequest memory req = _permit2Leg();
        ProveSettlement.Permit2Transfer memory p =
            abi.decode(req.arming, (ProveSettlement.Permit2Transfer));

        vm.warp(uint256(req.intent.endTime) + 1);

        vm.prank(address(exec));
        vm.expectRevert(ProveSettlement.Expired.selector);
        settlement.fillWithPermit2(req.intent, req.signature, req.take, p, ANY_FEE);

        assertEq(permit2.nonceBitmap(permit2Maker, p.nonce >> 8), 0, "the signature is unspent");
        assertEq(tokenA.balanceOf(permit2Maker), SIZE, "and the maker's tokens never moved");
    }

    // ── Which door takes which flag ──────────────────────────────────────────

    /**
     * @notice An intent wearing two custody flags is not an intent.
     *
     * Escrow is funded by a deposit or an authorization; permit2 is funded by a Permit2
     * signature. An intent wearing both says which arm `_armLeg` takes only by the order two
     * `if`s happen to be written in, and a maker should not have to read the settlement to know
     * which of their two signatures a solver will spend.
     */
    function test_AnIntentCannotWearTwoCustodyFlags() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0].intent = _intent(
            permit2Maker,
            address(tokenA),
            address(tokenB),
            settlement.FLAG_ESCROW() | settlement.FLAG_PERMIT2()
        );
        reqs[0].signature = _sign(reqs[0].intent, permit2Key);
        reqs[0].take = SIZE;

        assertEq(
            uint8(
                settlement.fillability(
                    reqs[0].intent, reqs[0].signature, SIZE, address(exec), ANY_FEE
                )
            ),
            uint8(ProveSettlement.Reason.BadTerms_),
            "the terms are dead against every caller and every clock"
        );

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        vm.expectRevert(ProveSettlement.BadTerms.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);
    }

    /// @notice `fillWithPermit2` is the permit2 door and refuses everything else, the way the
    ///         other two doors refuse what is not theirs.
    function test_FillWithPermit2RefusesAnIntentOffTheRung() public {
        ProveSettlement.Intent memory i = _intent(permit2Maker, address(tokenA), address(tokenB), 0);
        ProveSettlement.Permit2Transfer memory p = _permit2Transfer(
            address(tokenA),
            SIZE,
            uint256(settlement.hashIntent(i)),
            block.timestamp + 1 days,
            permit2Key
        );

        // Signed first. `vm.expectRevert` arms the next call, and `_sign` makes one of its own.
        bytes memory sig = _sign(i, permit2Key);

        vm.prank(address(exec));
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.fillWithPermit2(i, sig, SIZE, p, ANY_FEE);
    }

    /// @notice And the EIP-2612 door refuses a permit2 intent, because a permit grants an
    ///         allowance and this rung has none to grant.
    function test_FillWithPermitRefusesAPermit2Intent() public {
        ProveSettlement.FillRequest memory req = _permit2Leg();
        ProveSettlement.Permit memory p;
        p.value = SIZE;
        p.deadline = block.timestamp + 1 days;

        vm.prank(address(exec));
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.fillWithPermit(req.intent, req.signature, SIZE, p, ANY_FEE);
    }

    // ── What a leg that cannot be armed leaves behind ────────────────────────

    /**
     * @notice A requested leg that cannot be armed is stepped over, and the maker's signature
     *         survives it.
     *
     * The token keeps a cut, so the redemption credits less than the leg needs and the escrow is
     * still short. Everything the arming did unwinds with its own frame: the nonce is unspent,
     * the tokens never left the maker, and the batch settles the legs that were fine.
     */
    function test_ARequestedLegThatCannotBeArmedIsSteppedOver() public {
        TaxedERC3009 taxed = new TaxedERC3009();
        taxed.mint(gaslessMaker, SIZE);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _gaslessLeg(taxed, gaslessMaker, gaslessKey);
        reqs[1] = _approvalLeg();

        bytes32 doomed = settlement.hashIntent(reqs[0].intent);

        tokenA.mint(address(exec), SIZE);
        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        uint256 count = settlement.fillBatch(reqs, true, ANY_FEE);

        assertEq(count, 1, "only the leg that could be armed settled");
        assertEq(tokenB.balanceOf(approvalMaker), SIZE, "and it settled in full");

        assertFalse(taxed.authorizationState(gaslessMaker, doomed), "the nonce is unspent");
        assertEq(taxed.balanceOf(gaslessMaker), SIZE, "the maker's tokens never moved");
        assertEq(settlement.reserved(doomed), 0, "nothing is stranded in escrow");
    }

    /**
     * @notice A token that will not say what it moved cannot arm a leg, and cannot bill the
     *         solver for asking.
     *
     * `_redeem` measures the redemption by the change in this contract's balance. The token
     * answers that one read truthfully and with 960KB of padding behind the answer, and every
     * other read plainly, so the leg looks ordinary right up to the moment the authorization is
     * spent. Both reads go through `_probe`, so the token is handed thirty thousand gas, cannot
     * afford the bytes, and the arming refuses.
     *
     * `EscrowShort`, which is what the leg already said, so the batch steps over it exactly as it
     * steps over the taxed token above and the maker's authorization survives unspent.
     *
     * Take the bound away and this leg arms: the answer is correct, so the reservation is
     * credited in full and the batch settles both legs — for some 3.7M gas of memory it never
     * needed. That is what the count, the spent nonce and the ceiling below are each measuring.
     */
    function test_ATokenThatWillNotSayWhatItMovedCannotArmALeg() public {
        BombingERC3009 bomb = new BombingERC3009();
        bomb.aimAt(address(settlement));
        bomb.mint(gaslessMaker, SIZE);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _gaslessLeg(bomb, gaslessMaker, gaslessKey);
        reqs[1] = _approvalLeg();

        bytes32 doomed = settlement.hashIntent(reqs[0].intent);

        tokenA.mint(address(exec), SIZE);
        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        uint256 before = gasleft();
        uint256 count = settlement.fillBatch(reqs, true, ANY_FEE);
        uint256 used = before - gasleft();
        emit log_named_uint("a batch stepping over a token that bombs the redemption", used);

        assertEq(count, 1, "only the leg that could be armed settled");
        assertEq(tokenB.balanceOf(approvalMaker), SIZE, "and it settled in full");

        assertFalse(bomb.authorizationState(gaslessMaker, doomed), "the nonce is unspent");
        assertEq(bomb.balanceOf(gaslessMaker), SIZE, "the maker's tokens never moved");
        assertEq(settlement.reserved(doomed), 0, "nothing is stranded in escrow");
        // The whole batch, honest leg and all, for less than the bytes alone used to cost.
        assertLt(used, 400_000, "the bomb costs the cap, not the gas limit");
    }

    /// @notice The same leg in a ring, where a missing leg is a broken ring rather than a
    ///         smaller one. The batch reverts, and the signature still survives it.
    function test_ARequestedLegThatCannotBeArmedRevertsARing() public {
        TaxedERC3009 taxed = new TaxedERC3009();
        taxed.mint(gaslessMaker, SIZE);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _gaslessLeg(taxed, gaslessMaker, gaslessKey);
        bytes32 doomed = settlement.hashIntent(reqs[0].intent);

        tokenA.mint(address(exec), SIZE);
        vm.prank(address(exec));
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);

        assertFalse(taxed.authorizationState(gaslessMaker, doomed), "the nonce is unspent");
        assertEq(taxed.balanceOf(gaslessMaker), SIZE, "the maker's tokens never moved");
    }

    /**
     * @notice A permit that cannot be granted reads as `EscrowShort`, not as the token's error.
     *
     * This is the case a ring meets, and the one `_arm` used to get wrong. `deep` is false when
     * `skipInvalid` is, so a permit leg with no allowance evaluates to `Ok` before arming is
     * tried. `_arm` kept that `Ok` when the arming failed, and the leg went on to die inside the
     * token's own `transferFrom` — so a ring, which has to pass `skipInvalid = false` because a
     * ring missing a leg is broken rather than smaller, reverted with an ERC-20 error naming
     * nothing a solver could act on.
     */
    function test_APermitThatCannotBeGrantedReadsAsEscrowShort() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _permitLeg();

        // A real permit for the right maker, signed by somebody else.
        ProveSettlement.Permit memory p = abi.decode(reqs[0].arming, (ProveSettlement.Permit));
        (, uint256 stranger) = makeAddrAndKey("a stranger");
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                tokenA.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        tokenA.PERMIT_TYPEHASH(),
                        permitMaker,
                        relayer,
                        p.value,
                        tokenA.nonces(permitMaker),
                        p.deadline
                    )
                )
            )
        );
        (p.v, p.r, p.s) = vm.sign(stranger, digest);
        reqs[0].arming = abi.encode(p);

        tokenB.mint(address(exec), SIZE);
        vm.prank(address(exec));
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);

        assertEq(tokenA.allowance(permitMaker, relayer), 0, "and no allowance was granted");
        assertEq(tokenA.nonces(permitMaker), 0, "nor was the maker's permit nonce spent");
    }

    /**
     * @notice A worthless intent signature never spends a real authorization.
     *
     * `_evaluate` reads a maker's funds before it reads their signature, so an unfunded leg says
     * `EscrowShort` whatever the signature is worth. Arming on that alone would redeem against
     * an intent that can never fill. The re-check inside the frame is what refuses it.
     */
    function test_ABadIntentSignatureNeverSpendsTheAuthorization() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _gaslessLeg(tokenB, gaslessMaker, gaslessKey);
        // A real authorization, kept. Only the intent signature is replaced.
        reqs[0].signature = hex"00";
        bytes32 h = settlement.hashIntent(reqs[0].intent);

        tokenA.mint(address(exec), SIZE);
        vm.prank(address(exec));
        uint256 count = settlement.fillBatch(reqs, true, ANY_FEE);

        assertEq(count, 0, "nothing settled");
        assertFalse(tokenB.authorizationState(gaslessMaker, h), "the nonce is unspent");
        assertEq(tokenB.balanceOf(gaslessMaker), SIZE, "the maker's tokens never moved");
    }

    /**
     * @notice An authorization that names another intent does not arm this one.
     *
     * The 3009 nonce is the intent hash, so one signature funds one intent. Without that check a
     * maker who signed once would have armed every same-size intent they ever sign, and calling
     * off the intent it was meant for would not have revoked it.
     */
    function test_AnAuthorizationForAnotherIntentDoesNotArmThisOne() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _gaslessLeg(tokenB, gaslessMaker, gaslessKey);

        // A real authorization, signed by the real maker, naming a different intent.
        ProveSettlement.Authorization memory a =
            abi.decode(reqs[0].arming, (ProveSettlement.Authorization));
        a.nonce = keccak256("some other intent");
        reqs[0].arming = abi.encode(a);

        tokenA.mint(address(exec), SIZE);
        vm.prank(address(exec));
        uint256 count = settlement.fillBatch(reqs, true, ANY_FEE);

        assertEq(count, 0, "nothing settled");
        assertEq(tokenB.balanceOf(gaslessMaker), SIZE, "the maker's tokens never moved");
    }

    /**
     * @notice An authorization whose window has not opened cannot arm the leg yet, and trying
     *         costs the maker nothing. It arms once the clock reaches the window.
     *
     * The intent and the authorization carry separate windows and nothing reconciles them: the
     * settlement checks `startTime` and `endTime`, the token checks `validAfter` and
     * `validBefore`, and a gasless leg is only alive where the two overlap. This is the half a
     * solver has to reason about, because the leg comes back `EscrowShort` either way — the same
     * answer a taxed token gives, and the same one a maker who never signed anything gives.
     *
     * So `EscrowShort` on a requested leg means "not armable now". The same bytes work later.
     */
    function test_AnAuthorizationWindowThatHasNotOpenedIsNotArmableYet() public {
        uint256 opensAt = block.timestamp + 10 minutes;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0].intent =
            _intent(gaslessMaker, address(tokenB), address(tokenA), settlement.FLAG_ESCROW());
        reqs[0].signature = _sign(reqs[0].intent, gaslessKey);
        reqs[0].take = SIZE;
        bytes32 h = settlement.hashIntent(reqs[0].intent);
        reqs[0].arming = abi.encode(_authIn(opensAt, block.timestamp + 1 days, h));

        tokenA.mint(address(exec), SIZE);

        // Too early. The token refuses, the frame reverts, and the leg is stepped over.
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "nothing settled yet");
        assertFalse(tokenB.authorizationState(gaslessMaker, h), "the nonce is unspent");
        assertEq(tokenB.balanceOf(gaslessMaker), SIZE, "the maker's tokens never moved");
        assertEq(settlement.reserved(h), 0, "and nothing is stranded in escrow");

        // The same bytes, one second inside the window.
        vm.warp(opensAt + 1);
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 1, "the same leg settled");
        assertEq(tokenA.balanceOf(gaslessMaker), SIZE, "the maker got the rate they signed");
    }

    /// @dev An authorization over the whole `SIZE`, with a window the caller picks.
    function _authIn(uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (ProveSettlement.Authorization memory a)
    {
        a.validAfter = validAfter;
        a.validBefore = validBefore;
        a.nonce = nonce;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                tokenB.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        tokenB.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        gaslessMaker,
                        address(settlement),
                        SIZE,
                        validAfter,
                        validBefore,
                        nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(gaslessKey, digest);
        a.signature = abi.encodePacked(r, sv, v);
    }

    /**
     * @notice A contract wallet's leg arms in a batch, through ERC-7598.
     *
     * The wallet holds no key, so both its signatures are ERC-1271 answers: one for the intent,
     * one for the authorization that funds it. The authorization is 65 bytes — a key's signature
     * relayed — so the settlement tries the EIP-3009 overload first, the token's `ecrecover`
     * refuses it, and the fall-through to the `bytes` overload is what settles the leg.
     *
     * `test/ProveSettlement.t.sol` fills the same shape through `fillWithAuthorization`. Both
     * doors reach `_armLeg`, and this is the one with the revertable frame around it.
     */
    function test_AContractWalletLegArmsInABatch() public {
        SmartWallet wallet = new SmartWallet(gaslessMaker);
        MockERC7598Wallet token = new MockERC7598Wallet();
        token.mint(address(wallet), SIZE);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0].intent =
            _intent(address(wallet), address(token), address(tokenA), settlement.FLAG_ESCROW());
        reqs[0].signature = _sign(reqs[0].intent, gaslessKey);
        reqs[0].take = SIZE;
        reqs[0].arming = abi.encode(_walletAuth(token, address(wallet), reqs[0].intent));

        tokenA.mint(address(exec), SIZE);
        vm.prank(address(exec));
        uint256 count = settlement.fillBatch(reqs, false, ANY_FEE);

        assertEq(count, 1, "the leg settled");
        assertEq(tokenA.balanceOf(address(wallet)), SIZE, "the wallet got the rate it signed");
        assertEq(token.balanceOf(address(exec)), SIZE, "and the solver holds its token A");
    }

    function _walletAuth(MockERC7598Wallet token, address from, ProveSettlement.Intent memory i)
        internal
        view
        returns (ProveSettlement.Authorization memory a)
    {
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        a.nonce = settlement.hashIntent(i);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        from,
                        address(settlement),
                        SIZE,
                        a.validAfter,
                        a.validBefore,
                        a.nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(gaslessKey, digest);
        a.signature = abi.encodePacked(r, sv, v);
    }

    // ── Which overload the width picks ───────────────────────────────────────

    /**
     * @notice The width of an authorization's signature decides which `receiveWithAuthorization`
     *         the token is asked for, and the answer is not the same on both tokens.
     *
     * `_receive` reads the length and nothing else. Sixty-five bytes is what a key produces, so
     * it tries the EIP-3009 overload first and falls through to the ERC-7598 one when that
     * reverts; any other width cannot be `v, r, s` at all and goes straight to 7598. The
     * fall-through is the branch that costs nothing to get wrong and everything to leave
     * untested: it is the only thing that lets a contract wallet back an offer it can sign.
     *
     * Four combinations, and this asserts all of them:
     *
     *   - **a key, either token, 65 bytes** — arms. A legacy-only token has one overload and
     *     that is the one asked; a 7598 token charges nothing extra for being asked the old way.
     *   - **a key, either token, any other width** — never arms. The legacy token has no `bytes`
     *     overload to fall through to, and the 7598 one asks an address with no code whether it
     *     signed.
     *   - **a contract wallet, the 7598 token, 64 or 65 bytes** — arms. At 65 the token's own
     *     `ecrecover` refuses and the fall-through settles it; at 64 the compact form skips
     *     straight there. Two routes to the same fill, which is what makes 7598 the gasless rung
     *     with a different encoding rather than a rung of its own.
     *   - **a contract wallet, the legacy token, any width** — never arms. That is the finding
     *     worth stating plainly: a maker who holds no key cannot back an offer in a token that
     *     stopped at EIP-3009, whatever they sign.
     */
    function testFuzz_TheSignatureWidthDecidesWhichOverloadTheTokenIsAsked(
        uint16 lengthSeed,
        bool wallet,
        bool wide
    ) public {
        // Sixty-four, sixty-five and sixty-six by name, and any other width the fuzzer likes.
        uint256 pick = lengthSeed % 4;
        uint256 len =
            pick == 0 ? 64 : (pick == 1 ? 65 : (pick == 2 ? 66 : bound(lengthSeed, 0, 200)));

        SmartWallet signer = new SmartWallet(gaslessMaker);
        address maker = wallet ? address(signer) : gaslessMaker;
        address token = wide ? address(new MockERC7598Wallet()) : address(new MockERC3009());
        MockERC3009(token).mint(maker, SIZE);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0].intent = _intent(maker, token, address(tokenA), settlement.FLAG_ESCROW());
        // Always sixty-five, and always the same key. Only the authorization's width is under
        // test: an ordinary account's signature recovers to itself, and the wallet's falls
        // through to ERC-1271, which is a rule `_validSignature` has run since long before this.
        reqs[0].signature = _sign(reqs[0].intent, gaslessKey);
        reqs[0].take = SIZE;
        bytes32 h = settlement.hashIntent(reqs[0].intent);
        reqs[0].arming = abi.encode(_authOfWidth(token, maker, h, len));

        // Only a token with the `bytes` overload can be asked anything but the old way, and only
        // a contract wallet has an answer to give it.
        bool arms = wallet ? (wide && (len == 64 || len == 65)) : len == 65;

        tokenA.mint(address(exec), SIZE);
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), arms ? 1 : 0, "the leg armed, or not");

        // Whichever way it went, nothing was spent that the fill did not pay for.
        assertEq(
            MockERC3009(token).authorizationState(maker, h), arms, "the nonce follows the fill"
        );
        assertEq(MockERC3009(token).balanceOf(maker), arms ? 0 : SIZE, "and so do the tokens");
    }

    /**
     * @dev One authorization for the whole `SIZE`, with its signature cut to `len` bytes.
     *
     * Sixty-four is the real EIP-2098 compact form — the parity folded into the top bit of `s` —
     * and not a truncation, because a truncated signature would fail for being wrong rather than
     * for being the width it is. Every other width is a padded or clipped `r, s, v`, which is
     * the shape a client bug actually produces.
     */
    function _authOfWidth(address token, address from, bytes32 nonce, uint256 len)
        internal
        view
        returns (ProveSettlement.Authorization memory a)
    {
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        a.nonce = nonce;

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                MockERC3009(token).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        MockERC3009(token).RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        from,
                        address(settlement),
                        SIZE,
                        a.validAfter,
                        a.validBefore,
                        a.nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(gaslessKey, digest);

        if (len == 64) {
            a.signature = abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)));
            return a;
        }
        bytes memory full = abi.encodePacked(r, s, v);
        bytes memory cut = new bytes(len);
        for (uint256 k = 0; k < len && k < full.length; k++) {
            cut[k] = full[k];
        }
        a.signature = cut;
    }

    /// @notice `armLeg` is external because it needs a frame of its own, and that is the only
    ///         reason. Nobody but the contract may call it.
    function test_ArmLegRefusesEveryCallerButTheContract() public {
        ProveSettlement.Intent memory i = _intent(gaslessMaker, address(tokenB), address(tokenA), 2);

        vm.expectRevert(ProveSettlement.ForbiddenTarget.selector);
        settlement.armLeg(i, hex"00", SIZE, address(exec), bytes32(0), ANY_FEE, hex"00");
    }

    // ── A token B nobody can read, through each of the three doors ────────────

    /**
     * @notice Each door that arms a leg refuses a `tokenOut` it cannot read with `Underpaid`,
     *         the same error `fill` gives for the same token. Never `BadSignature`.
     *
     * The three doors re-ask every question after arming, and that second pass reads token B.
     * It used to fall through `_revert` to its last line, which named the maker's signature as
     * the fault. A solver who reads that throws away a good signature. The signature here is
     * good; token B is the fault, and the error must say so.
     */
    function test_AnUnreadableTokenBIsUnderpaidThroughFillWithPermit() public {
        ProveSettlement.FillRequest memory req = _permitLeg();
        req.intent.tokenOut = address(new ReturnBomb(4_000));
        req.signature = _sign(req.intent, permitKey);
        ProveSettlement.Permit memory p = abi.decode(req.arming, (ProveSettlement.Permit));

        vm.prank(address(exec));
        vm.expectRevert(ProveSettlement.Underpaid.selector);
        settlement.fillWithPermit(req.intent, req.signature, SIZE, p, ANY_FEE);
    }

    function test_AnUnreadableTokenBIsUnderpaidThroughFillWithAuthorization() public {
        ProveSettlement.FillRequest memory req = _gaslessLegPaying(address(new ReturnBomb(4_000)));
        ProveSettlement.Authorization memory a =
            abi.decode(req.arming, (ProveSettlement.Authorization));

        vm.prank(address(exec));
        vm.expectRevert(ProveSettlement.Underpaid.selector);
        settlement.fillWithAuthorization(req.intent, req.signature, SIZE, a, ANY_FEE);
    }

    function test_AnUnreadableTokenBIsUnderpaidThroughFillWithPermit2() public {
        ProveSettlement.Intent memory i = _intent(
            permit2Maker, address(tokenA), address(new ReturnBomb(4_000)), settlement.FLAG_PERMIT2()
        );
        ProveSettlement.Permit2Transfer memory p = _permit2Transfer(
            address(tokenA),
            SIZE,
            uint256(settlement.hashIntent(i)),
            block.timestamp + 1 days,
            permit2Key
        );
        bytes memory sig = _sign(i, permit2Key);

        vm.prank(address(exec));
        vm.expectRevert(ProveSettlement.Underpaid.selector);
        settlement.fillWithPermit2(i, sig, SIZE, p, ANY_FEE);
    }

    /// @dev `_gaslessLeg` on token B, paying out in `tokenOut`. The authorization's nonce is the
    ///      intent's hash, so it is signed after `tokenOut` is set.
    function _gaslessLegPaying(address tokenOut)
        internal
        view
        returns (ProveSettlement.FillRequest memory req)
    {
        req.intent = _intent(gaslessMaker, address(tokenB), tokenOut, settlement.FLAG_ESCROW());
        req.signature = _sign(req.intent, gaslessKey);
        req.take = SIZE;

        ProveSettlement.Authorization memory a;
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        a.nonce = settlement.hashIntent(req.intent);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                tokenB.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        tokenB.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        gaslessMaker,
                        address(settlement),
                        SIZE,
                        a.validAfter,
                        a.validBefore,
                        a.nonce
                    )
                )
            )
        );
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(gaslessKey, digest);
        a.signature = abi.encodePacked(ar, as_, av);
        req.arming = abi.encode(a);
    }

    // ── Building the legs ────────────────────────────────────────────────────

    function _intent(address maker, address tokenIn, address tokenOut, uint8 flags)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        return _intentOf(maker, tokenIn, tokenOut, flags, SIZE);
    }

    /// @dev The same terms at a size the caller picks. Only the ring needs this: five legs at
    ///      one size cannot split evenly across two tokens, so one leg carries the difference.
    function _intentOf(
        address maker,
        address tokenIn,
        address tokenOut,
        uint8 flags,
        uint256 amount
    ) internal view returns (ProveSettlement.Intent memory i) {
        i.maker = maker;
        i.recipient = maker;
        i.tokenIn = tokenIn;
        i.tokenOut = tokenOut;
        i.amountIn = amount;
        // Flat, and one for one, so the ring's arithmetic closes to the wei.
        i.minOutStart = amount;
        i.minOutEnd = amount;
        i.startTime = uint64(block.timestamp);
        // Half an hour. Nothing bounds this any more; the suite just wants a window that is
        // open now and shut soon, so an expiry test has something to expire.
        i.endTime = uint64(block.timestamp + 30 minutes);
        // Nowhere to send a fee is no fee at all, which keeps the ring exactly balanced.
        i.feeConfig = bytes32(0);
        i.feeRateProceeds = 0;
        i.flags = flags;
        i.nonce = uint256(uint160(maker));
    }

    function _sign(ProveSettlement.Intent memory i, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function _permitLeg() internal view returns (ProveSettlement.FillRequest memory req) {
        req.intent = _intent(permitMaker, address(tokenA), address(tokenB), 0);
        req.signature = _sign(req.intent, permitKey);
        req.take = SIZE;

        ProveSettlement.Permit memory p;
        p.value = SIZE;
        p.deadline = block.timestamp + 1 days;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                tokenA.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        tokenA.PERMIT_TYPEHASH(),
                        permitMaker,
                        relayer,
                        p.value,
                        tokenA.nonces(permitMaker),
                        p.deadline
                    )
                )
            )
        );
        (p.v, p.r, p.s) = vm.sign(permitKey, digest);
        req.arming = abi.encode(p);
    }

    function _approvalLeg() internal view returns (ProveSettlement.FillRequest memory req) {
        req.intent = _intent(approvalMaker, address(tokenA), address(tokenB), 0);
        req.signature = _sign(req.intent, approvalKey);
        req.take = SIZE;
        // Nothing to arm. The maker granted the allowance themselves.
    }

    function _gaslessLeg(MockERC3009 token, address maker, uint256 key)
        internal
        view
        returns (ProveSettlement.FillRequest memory req)
    {
        req.intent = _intent(maker, address(token), address(tokenA), settlement.FLAG_ESCROW());
        req.signature = _sign(req.intent, key);
        req.take = SIZE;

        ProveSettlement.Authorization memory a;
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        // The authorization names the intent it funds, so it arms that one and nothing else.
        a.nonce = settlement.hashIntent(req.intent);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        maker,
                        address(settlement),
                        SIZE,
                        a.validAfter,
                        a.validBefore,
                        a.nonce
                    )
                )
            )
        );
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(key, digest);
        a.signature = abi.encodePacked(ar, as_, av);
        req.arming = abi.encode(a);
    }

    function _escrowLeg(uint256 amount) internal returns (ProveSettlement.FillRequest memory req) {
        req.intent = _intentOf(
            escrowMaker, address(tokenB), address(tokenA), settlement.FLAG_ESCROW(), amount
        );
        req.signature = _sign(req.intent, escrowKey);
        req.take = amount;

        vm.startPrank(escrowMaker);
        tokenB.approve(relayer, amount);
        settlement.deposit(req.intent, amount);
        vm.stopPrank();
        // Nothing to arm. The tokens are already here.
    }

    // ── The rung that survives a redeploy ────────────────────────────────────

    /// @dev A permit2 leg for the whole lot, its Permit2 nonce welded to its own intent hash.
    function _permit2Leg() internal view returns (ProveSettlement.FillRequest memory req) {
        return _permit2LegOf(SIZE, SIZE, 0);
    }

    /**
     * @dev A permit2 leg: the intent, the maker's signature over it, and one Permit2
     *      SignatureTransfer signed for the relayer.
     *
     * @param amount what the intent sells and what the maker's Permit2 signature permits.
     * @param take what this fill draws, which Permit2 allows to be less than `amount`.
     * @param flags extra flags on top of `FLAG_PERMIT2`, for the partial cases.
     */
    function _permit2LegOf(uint256 amount, uint256 take, uint8 flags)
        internal
        view
        returns (ProveSettlement.FillRequest memory req)
    {
        req.intent = _intentOf(
            permit2Maker,
            address(tokenA),
            address(tokenB),
            settlement.FLAG_PERMIT2() | flags,
            amount
        );
        req.signature = _sign(req.intent, permit2Key);
        req.take = take;

        // The intent names no nonce of its own, so the settlement expects its hash — which welds
        // this signature to this offer and to nothing else the maker ever signs.
        req.arming = abi.encode(
            _permit2Transfer(
                address(tokenA),
                amount,
                uint256(settlement.hashIntent(req.intent)),
                block.timestamp + 1 days,
                permit2Key
            )
        );
    }

    /**
     * @dev A partial-fillable permit2 leg with a floor under its fills.
     *
     * `minFill` has to be set before the hash, because the hash is the Permit2 nonce the
     * settlement expects — so it cannot be poked onto the intent afterwards without the arming
     * pointing at a different offer.
     */
    function _permit2LegWithFloor(uint256 amount, uint256 take, uint256 minFill)
        internal
        view
        returns (ProveSettlement.FillRequest memory req)
    {
        req.intent = _intentOf(
            permit2Maker,
            address(tokenA),
            address(tokenB),
            settlement.FLAG_PERMIT2() | settlement.FLAG_PARTIAL(),
            amount
        );
        req.intent.minFill = minFill;
        req.signature = _sign(req.intent, permit2Key);
        req.take = take;
        req.arming = abi.encode(
            _permit2Transfer(
                address(tokenA),
                amount,
                uint256(settlement.hashIntent(req.intent)),
                block.timestamp + 1 days,
                permit2Key
            )
        );
    }

    function _permit2Transfer(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        uint256 key
    ) internal view returns (ProveSettlement.Permit2Transfer memory p) {
        p.token = token;
        p.amount = amount;
        p.nonce = nonce;
        p.deadline = deadline;
        (uint8 v, bytes32 r, bytes32 sv) =
            vm.sign(key, _permit2Digest(token, amount, nonce, deadline));
        p.signature = abi.encodePacked(r, sv, v);
    }

    /**
     * @dev Permit2's own digest, built the way Permit2 builds it.
     *
     * Two things here are not like every other EIP-712 digest in this repository, and both are
     * load-bearing. Permit2's domain carries **no version string**. And the spender is **not a
     * field of the permit** — Permit2 hashes `msg.sender` in, so this signature names the relayer
     * because the relayer is the only address that will ever present it.
     */
    function _permit2Digest(address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                permit2.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        permit2.PERMIT_TRANSFER_FROM_TYPEHASH(),
                        keccak256(abi.encode(permit2.TOKEN_PERMISSIONS_TYPEHASH(), token, amount)),
                        relayer,
                        nonce,
                        deadline
                    )
                )
            )
        );
    }
}
