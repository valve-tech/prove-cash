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
    STRAY_DESTINATION,
    availableOf
} from "./Fees.sol";
import {ANY_FEE, MockERC20, NO_PERMIT2} from "./Mocks.sol";

/**
 * @notice The nonce floor has lanes — #131.
 *
 *   forge test --match-path test/Lanes.t.sol -vv
 *
 * A nonce is one signed `uint256` and this contract reads it as two numbers: the high 192 bits
 * are a lane, the low 64 are a position inside it. A floor is written against one lane, so one
 * word retires one group of signatures and spares every other group. That is selective bulk
 * revocation with no preimage, which is the thing `cancel` cannot do — `cancel` takes the whole
 * intent and kills exactly one of them.
 *
 * **Nothing a wallet signs changed.** `INTENT_TYPEHASH` does not move, the `Intent` struct does
 * not move, and `invalidateBefore` keeps its selector. The lane is a reading of bits the maker
 * was already signing, which is the move `FLAG_PERMIT2` made before it.
 *
 * **Two tests here are the compatibility claim and one is the hole.** Read them first:
 *
 * - `test_LaneZeroIsExactlyTheFloorTheContractAlwaysHad` — every nonce this repository builds is
 *   a millisecond epoch, so every one of them is in lane 0, and lane 0 behaves as the single
 *   floor always did. `app/src/lib/nonce-lane.test.ts` is the other half: it reads the sources
 *   and pins the set of places that make a nonce.
 * - `test_ANonceAboveTheLaneWidthMovesToADifferentLaneAndTheOldFloorMissesIt` — the migration
 *   hazard, stated rather than hoped away. A hand-rolled nonce past 2^64 is in a lane of its
 *   own and lane 0's floor does not cover it.
 * - `test_TheTopPositionInALaneIsTheOneAFloorCannotReach` — a strict floor can never retire the
 *   top value of its range. It was one nonce before this change and it is one per lane after it.
 */
contract LanesTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;

    MockERC20 tokenA;
    MockERC20 tokenB;

    address owner = address(0xB0B);
    address proceeds = address(0x7EA);
    address executor = address(0xE0E);
    address stranger = address(0x57A);

    address maker;
    uint256 makerKey;
    address rival;
    uint256 rivalKey;

    uint256 constant SIZE = 1_000e18;
    uint256 constant MIN_OUT = 10e18;

    /// @dev What both intent-building surfaces in the app pass: `BigInt(Date.now())`. About
    ///      1.8e12, against the 1.8e19 a lane position holds.
    uint256 constant EPOCH_NONCE = 1_757_000_000_000;

    /// @dev One lane width. A nonce of exactly this is position 0 of lane 1.
    uint256 constant LANE = 1 << 64;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        (rival, rivalKey) = makeAddrAndKey("rival");

        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);

        tokenA.mint(maker, 100 * SIZE);
        tokenA.mint(rival, 100 * SIZE);
        tokenB.mint(executor, 100 * SIZE);

        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(rival);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── The compatibility claim ──────────────────────────────────────────────

    /**
     * @notice Lane 0 is the floor this contract always had, on the nonces it actually meets.
     *
     * The claim the redeploy rests on, and it is measured rather than asserted in a comment.
     * Both surfaces that build an intent set `nonce: BigInt(Date.now())` —
     * `app/src/components/Compose.tsx` and `app/src/rfq/MakeQuote.tsx` — so every live nonce is
     * about 1.8e12 and every one of them has 192 zero high bits. A maker who passes a floor of
     * the same shape retires exactly what they used to retire: everything strictly below it.
     *
     * `nonceFloor(maker)` answers for lane 0 and returns the number that was passed, which is
     * what the SDK reads and what the app draws.
     */
    function test_LaneZeroIsExactlyTheFloorTheContractAlwaysHad() public {
        ProveSettlement.Intent memory below = _intent(maker, EPOCH_NONCE - 1);
        ProveSettlement.Intent memory at = _intent(maker, EPOCH_NONCE);
        ProveSettlement.Intent memory above = _intent(maker, EPOCH_NONCE + 1);

        assertEq(uint192(EPOCH_NONCE >> 64), 0, "a millisecond epoch is in lane 0");

        vm.prank(maker);
        settlement.invalidateBefore(EPOCH_NONCE);

        assertEq(settlement.nonceFloor(maker), EPOCH_NONCE, "the number the maker passed");
        assertEq(settlement.laneFloor(maker, 0), uint64(EPOCH_NONCE), "and the same in lane 0");

        _assertDead(below);
        _assertLive(at, "the floor is exclusive, exactly as it always was");
        _assertLive(above, "and a later nonce is untouched");
    }

    /**
     * @notice The migration hazard, said out loud: a nonce past the lane width changes lanes.
     *
     * The honest caveat in the spec, made into a test. Nothing in this repository signs a nonce
     * above 2^64, which is why the reading is safe to adopt. A maker who hand-rolled one would
     * find it sitting in a lane of its own, where the floor they set on lane 0 does not reach.
     *
     * This is the test that goes red if somebody starts minting wide nonces without also
     * teaching the client to raise the right lane's floor.
     */
    function test_ANonceAboveTheLaneWidthMovesToADifferentLaneAndTheOldFloorMissesIt() public {
        // Lane 1, position 5. Under the single floor this was simply "a very large nonce".
        ProveSettlement.Intent memory wide = _intent(maker, LANE + 5);

        vm.prank(maker);
        settlement.invalidateBefore(type(uint64).max);
        assertEq(settlement.nonceFloor(maker), type(uint64).max, "lane 0 is retired to its top");

        _assertLive(wide, "a wide nonce is in another lane, and lane 0's floor does not cover it");

        // The maker's answer is one more word, naming the lane the nonce is actually in.
        vm.prank(maker);
        settlement.invalidateBefore(LANE + 6);
        _assertDead(wide);
    }

    /**
     * @notice A strict floor can never retire the top value of its range. Break it on purpose.
     *
     * `_evaluate` asks `position < floor`, and a position is a `uint64`, so the largest floor
     * that can be written is `type(uint64).max` and the position equal to it survives every
     * floor there is. This is not new: before lanes the same argument made `type(uint256).max`
     * unretirable, because the comparison was the same comparison.
     *
     * **What a maker does about it is `cancel`**, which takes the preimage and kills exactly one
     * signature. The test proves both halves: no floor reaches it, and `cancel` does.
     */
    function test_TheTopPositionInALaneIsTheOneAFloorCannotReach() public {
        ProveSettlement.Intent memory top = _intent(maker, type(uint64).max);

        vm.prank(maker);
        settlement.invalidateBefore(type(uint64).max);
        _assertLive(top, "the top position of a lane outlives its own lane's highest floor");

        // And there is no higher floor to write in this lane: the position is already at its
        // width, so the monotonic check refuses.
        vm.prank(maker);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.invalidateBefore(type(uint64).max);

        // A floor in the NEXT lane is a different lane and says nothing about this one.
        vm.prank(maker);
        settlement.invalidateBefore(LANE + 1);
        _assertLive(top, "the neighbouring lane's floor is not this lane's floor");

        vm.prank(maker);
        settlement.cancel(top);
        assertEq(
            uint256(settlement.fillability(top, _sign(makerKey, top), SIZE, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Cancelled),
            "cancel reaches what no floor can"
        );
    }

    // ── What the lanes buy ───────────────────────────────────────────────────

    /**
     * @notice One word retires one lane and spares every other. The whole point of #131.
     *
     * A maker groups their signatures when they sign — one lane per pair, per strategy, per
     * session, whatever they choose. Here it is one lane per pair. Retiring the first pair's
     * lane leaves the second pair's book exactly where it was, and it took one transaction and
     * no preimage at all.
     */
    function test_OneWordRetiresOneLaneAndSparesEveryOther() public {
        ProveSettlement.Intent memory pairA1 = _intent(maker, (uint256(1) << 64) | 10);
        ProveSettlement.Intent memory pairA2 = _intent(maker, (uint256(1) << 64) | 11);
        ProveSettlement.Intent memory pairB1 = _intent(maker, (uint256(2) << 64) | 10);
        ProveSettlement.Intent memory pairB2 = _intent(maker, (uint256(2) << 64) | 11);

        vm.prank(maker);
        settlement.invalidateBefore((uint256(1) << 64) | 12);

        _assertDead(pairA1);
        _assertDead(pairA2);
        _assertLive(pairB1, "the other lane's book is untouched");
        _assertLive(pairB2, "both of it");

        assertEq(settlement.laneFloor(maker, 1), 12, "lane 1 took the floor");
        assertEq(settlement.laneFloor(maker, 2), 0, "lane 2 never heard about it");
        assertEq(settlement.nonceFloor(maker), 0, "and neither did lane 0");
    }

    /**
     * @notice A lane's floor stops at the lane boundary in both directions.
     *
     * The off-by-one that a packed field invites: the top position of lane 0 and position 0 of
     * lane 1 are adjacent as plain integers and are in different lanes. A floor on either one
     * must say nothing about the other.
     */
    function test_ALaneFloorNeverReachesTheNeighbouringLane() public {
        ProveSettlement.Intent memory lastOfZero = _intent(maker, LANE - 1);
        ProveSettlement.Intent memory firstOfOne = _intent(maker, LANE);

        // Retire all of lane 1 up to position 9.
        vm.prank(maker);
        settlement.invalidateBefore(LANE + 9);

        _assertDead(firstOfOne);
        _assertLive(lastOfZero, "lane 1's floor does not reach down into lane 0");
        assertEq(settlement.nonceFloor(maker), 0, "lane 0's floor never moved");
    }

    /**
     * @notice The floor is per maker as well as per lane. A stranger's floor kills nothing.
     *
     * `invalidateBefore` keys on `msg.sender` and takes no maker argument, so there is nothing
     * for a caller to point at somebody else. The rival raises the same lane to the same
     * position and the maker's book does not notice.
     */
    function test_AFloorBelongsToTheMakerWhoWroteItAndToNobodyElse() public {
        ProveSettlement.Intent memory mine = _intent(maker, (uint256(3) << 64) | 4);
        ProveSettlement.Intent memory theirs = _intent(rival, (uint256(3) << 64) | 4);

        vm.prank(rival);
        settlement.invalidateBefore((uint256(3) << 64) | 5);

        assertEq(settlement.laneFloor(rival, 3), 5, "the rival retired their own lane 3");
        assertEq(settlement.laneFloor(maker, 3), 0, "and reached none of the maker's");
        _assertLive(mine, "the maker's signature in the same lane still fills");

        assertEq(
            uint256(
                settlement.fillability(theirs, _sign(rivalKey, theirs), SIZE, executor, ANY_FEE)
            ),
            uint256(ProveSettlement.Reason.NonceTooLow),
            "and the rival's own is dead"
        );
    }

    /**
     * @notice A retired nonce is retired for good: a lane's floor only rises.
     *
     * The property `park` depends on. `park` writes `cancelledAt` when it moves the money, and
     * that write is only safe if the intent cannot come back to life — so a maker must not be
     * able to lower a floor and revive a signature whose escrow has already rolled forward.
     */
    function test_AFloorOnlyRisesSoARetiredSignatureNeverComesBack() public {
        vm.startPrank(maker);
        settlement.invalidateBefore((uint256(7) << 64) | 100);

        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.invalidateBefore((uint256(7) << 64) | 99);

        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.invalidateBefore((uint256(7) << 64) | 100);

        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.invalidateBefore(uint256(7) << 64); // position 0: no lane may be zeroed
        vm.stopPrank();

        assertEq(settlement.laneFloor(maker, 7), 100, "the floor stayed where it was put");
    }

    /// @notice `fill` refuses a retired nonce with `NonceTooLow`, not only `fillability`.
    function test_TheFillPathRefusesARetiredNonceInAnyLane() public {
        ProveSettlement.Intent memory i = _intent(maker, (uint256(9) << 64) | 1);
        bytes memory sig = _sign(makerKey, i);

        vm.prank(maker);
        settlement.invalidateBefore((uint256(9) << 64) | 2);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.NonceTooLow.selector);
        settlement.fill(i, sig, SIZE, ANY_FEE);

        (, bool live) = availableOf(settlement, i);
        assertFalse(live, "and `available` says the same thing");
    }

    // ── park, and the third door ─────────────────────────────────────────────

    /**
     * @notice `park` takes an intent any lane's floor killed, not only lane 0's.
     *
     * `Parked.t.sol::test_ParkAcceptsAnIntentTheNonceFloorKilled` is this in lane 0. This is the
     * same door in a lane a maker chose, because a bulk switch that only frees lane 0's capital
     * would be a bulk switch nobody uses.
     */
    function test_ParkTakesAnIntentAnyLanesFloorKilled() public {
        ProveSettlement.Intent memory i = _escrow(maker, (uint256(4) << 64) | 1);
        vm.prank(maker);
        settlement.deposit(i, SIZE);

        vm.prank(maker);
        settlement.invalidateBefore((uint256(4) << 64) | 2);

        // Inside its window, never cancelled, dead by the floor alone.
        assertLt(block.timestamp, i.endTime, "the window is still open");
        assertEq(settlement.cancelledAt(settlement.hashIntent(i)), 0, "no cancel was written");

        settlement.park(i);

        assertEq(settlement.parked(maker, address(tokenA)), SIZE, "the capital rolled forward");
        assertEq(settlement.reserved(settlement.hashIntent(i)), 0, "and left the dead hash");
    }

    /**
     * @notice `park` still refuses a live intent, and a neighbouring lane's floor does not make
     *         one dead.
     *
     * The guard on the new door. `park` is permissionless, so the only thing standing between a
     * stranger and a maker's live reservation is this condition — and the condition now has a
     * third clause that a stranger would love to be loose. Retiring lane 5 must not hand lane 6
     * to anybody.
     */
    function test_ParkStillRefusesALiveIntentInALaneNobodyRetired() public {
        ProveSettlement.Intent memory live_ = _escrow(maker, (uint256(6) << 64) | 1);
        vm.prank(maker);
        settlement.deposit(live_, SIZE);

        vm.prank(maker);
        settlement.invalidateBefore((uint256(5) << 64) | 99);

        vm.prank(stranger);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.park(live_);

        // And the position just under the floor's own lane is the same refusal: position 1 is
        // not below a floor of 1.
        ProveSettlement.Intent memory atTheFloor = _escrow(maker, (uint256(8) << 64) | 1);
        vm.prank(maker);
        settlement.deposit(atTheFloor, SIZE);
        vm.prank(maker);
        settlement.invalidateBefore((uint256(8) << 64) | 1);

        vm.prank(stranger);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.park(atTheFloor);

        assertEq(settlement.parked(maker, address(tokenA)), 0, "nothing was parked");
        assertEq(settlement.reserved(settlement.hashIntent(live_)), SIZE, "and nothing moved");
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _assertLive(ProveSettlement.Intent memory i, string memory why) private view {
        assertEq(
            uint256(settlement.fillability(i, _sign(makerKey, i), SIZE, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            why
        );
    }

    function _assertDead(ProveSettlement.Intent memory i) private view {
        assertEq(
            uint256(settlement.fillability(i, _sign(makerKey, i), SIZE, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.NonceTooLow),
            "the floor should have killed this one"
        );
    }

    function _intent(address who, uint256 nonce)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: who,
            recipient: who,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: SIZE,
            minOutStart: MIN_OUT,
            minOutEnd: MIN_OUT,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + 1 hours,
            executor: address(0),
            // No destination is no fee at all, so nothing here turns on the fee split.
            feeConfig: bytes32(0),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL(),
            nonce: nonce,
            curve: bytes32(0)
        });
    }

    /// @dev The same offer in escrow custody, which is the one `park` has anything to move.
    function _escrow(address who, uint256 nonce)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i = _intent(who, nonce);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
    }

    function _sign(uint256 key, ProveSettlement.Intent memory i)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }
}
