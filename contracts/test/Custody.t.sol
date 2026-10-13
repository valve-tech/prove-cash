// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {IProveCallback} from "../src/interfaces/IProveCallback.sol";
import {ANY_FEE, MockERC20, MockERC3009, NO_PERMIT2, PayingExecutor} from "./Mocks.sol";
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

/// @notice Takes the token A, returns, and stands good for nothing at all. Not the same executor
///         as `UnderpayingExecutor`, which allows one wei less than it owes: this one never
///         reaches the token, so the failure has to come from the pull rather than from a
///         shortfall the contract measured.
contract FreeloadingExecutor is IProveCallback {
    function settle(
        ProveSettlement s,
        ProveSettlement.Intent calldata i,
        bytes calldata signature,
        uint256 take,
        uint256 maxFeeRate
    ) external {
        s.fillWithCallback(i, signature, take, "", maxFeeRate);
    }

    function proveCallback(address, IProveCallback.Terms calldata, bytes calldata) external {}
}

/**
 * @notice Knocks on the three doors the `nonReentrant` guard does not cover, from inside the
 *         callback, and records which of them opened.
 *
 * The refusals are counted rather than thrown, so the outer fill runs to completion and the test
 * can assert what the reentrancy did and did not change.
 */
contract SiblingProbe is IProveCallback {
    ProveSettlement public immutable settlement;
    /**
     * @dev Private, not public. A public struct member makes solc write a getter that returns
     *      every field, and `Intent` is now wide enough that the ABI encoder for one runs the
     *      legacy pipeline out of stack the moment `forge coverage --ir-minimum` compiles this
     *      file. Nothing reads it from outside, so the getter bought nothing and cost the gate.
     */
    ProveSettlement.Intent private own;
    bool public cancelOpened;
    bool public invalidateOpened;

    constructor(ProveSettlement s) {
        settlement = s;
    }

    function approveMax(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    /// @dev The probe funds an escrow intent of its own, so `cancel` has a reservation to act
    ///      on. It takes no signature, so no key is needed.
    function arm(ProveSettlement.Intent calldata i, uint256 amount) external {
        own = i;
        IERC20(i.tokenIn).approve(settlement.relayer(), type(uint256).max);
        settlement.deposit(i, amount);
    }

    function settle(
        ProveSettlement.Intent calldata i,
        bytes calldata signature,
        uint256 take,
        uint256 maxFeeRate
    ) external {
        settlement.fillWithCallback(i, signature, take, "", maxFeeRate);
    }

    function proveCallback(address, IProveCallback.Terms calldata, bytes calldata) external {
        ProveSettlement.Intent memory mine = own;
        (cancelOpened,) = address(settlement).call(abi.encodeCall(ProveSettlement.cancel, (mine)));
        (invalidateOpened,) =
            address(settlement).call(abi.encodeCall(ProveSettlement.invalidateBefore, (99)));
    }
}

/// @notice Calls its receiver back on every transfer. A maker who names this as `tokenOut` buys
///         themselves a frame inside the settlement contract's own call stack, without being the
///         executor and without writing a callback.
contract HookToken is ERC20 {
    constructor() ERC20("Hook", "HOOK") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (from != address(0) && to.code.length > 0) {
            (bool ok,) = to.call(abi.encodeWithSignature("hook()"));
            ok; // a receiver that does not answer is not this token's problem
        }
    }
}

/// @notice A contract maker that cancels a chosen intent of its own the moment it is paid.
contract HookedMaker {
    ProveSettlement public immutable settlement;
    ProveSettlement.Intent private _target;
    bool public armed;

    constructor(ProveSettlement s) {
        settlement = s;
    }

    function approveMax(address token) external {
        IERC20(token).approve(settlement.relayer(), type(uint256).max);
    }

    function aim(ProveSettlement.Intent calldata i) external {
        _target = i;
        armed = true;
    }

    function hook() external {
        if (!armed) return;
        armed = false;
        settlement.cancel(_target);
    }

    /// @dev Signs everything. The signature is not what this test is about.
    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        return 0x1626ba7e;
    }
}

/**
 * @notice Custody, from the outside in: what the escrow window really promises, what the callback
 *         path really pulls, what an EIP-3009 authorization really commits the maker to, and the
 *         two places where the read-only view disagrees with the validator behind it.
 *
 * Several tests here pin behaviour that is arguably wrong rather than behaviour that is right.
 * Each of those says so in its own header and names what a fix would have to change, so the suite
 * is a record of the sharp edges rather than an endorsement of them.
 */
contract CustodyTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address owner = address(0xB0B);
    address sink = address(0x5152);
    address executor = address(0xE0E);
    address stranger = address(0x5747);
    address maker;
    uint256 makerKey;

    uint256 constant AMOUNT_IN = 1_000e18;
    uint256 constant MIN_OUT = 10e18;
    /// @dev What the maker keeps out of a gross of `MIN_OUT` at the fixture's ten basis points.
    ///      The fee comes out of the number the maker signed, so `MIN_OUT` is the executor's
    ///      outlay and this is the maker's receipt.
    uint256 constant NET_OUT = MIN_OUT - (MIN_OUT * 0.001e18) / 1e18;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);

        tokenA.mint(maker, 1_000_000e18);
        tokenB.mint(executor, 1_000_000e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── The reservation slot ─────────────────────────────────────────────────

    /**
     * @notice A reservation is one number, and `reserved` is the only way to read it.
     *
     * The slot used to carry the owner and the token as well, then an amount and an unlock time.
     * Every shape it has had, an off-chain reader has decoded wrong: four fields became two and
     * `readReservations` in the SDK went on destructuring four, so it read the unlock time as an
     * address and showed every escrow row as empty. That shipped.
     *
     * One value, one reader, no tuple. There is no field order left to get wrong, which is worth
     * more than any test — but this one still fails the day somebody adds a second field back.
     */
    function test_AReservationIsOneNumberWithNoFieldOrderToGetWrong() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_ESCROW();
        bytes32 h = settlement.hashIntent(i);

        assertEq(settlement.reserved(h), 0, "nothing reserved yet");

        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);
        assertEq(settlement.reserved(h), AMOUNT_IN, "the deposit is the whole of it");

        // `reserved` returns a plain uint256. If this ever becomes a tuple again, this line
        // stops compiling, which is the point.
        uint256 only = settlement.reserved(h);
        assertEq(only, AMOUNT_IN);

        vm.prank(maker);
        settlement.withdraw(i);
        assertEq(settlement.reserved(h), 0, "and it is gone in one call");
    }

    // ── The withdrawal window, to the second ─────────────────────────────────

    /**
     * @notice A third party's top-up is the maker's money, and it is fillable at once.
     *
     * `deposit` takes the preimage, so the intent decides both the owner and the token and the
     * payer decides neither. The other half of that is here: the top-up is not merely harmless,
     * it really does fund the fill.
     */
    function test_AStrangersTopUpFundsTheFillAndBelongsToTheMaker() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);

        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN / 2);

        tokenA.mint(stranger, AMOUNT_IN / 2);
        vm.startPrank(stranger);
        tokenA.approve(relayer, type(uint256).max);
        settlement.deposit(i, AMOUNT_IN / 2);
        vm.stopPrank();

        assertEq(settlement.reserved(h), AMOUNT_IN, "both halves landed in one reservation");

        // The maker had spent their allowance, so the whole fill has to come out of escrow.
        vm.prank(maker);
        tokenA.approve(relayer, 0);

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(tokenA.balanceOf(executor), AMOUNT_IN, "the stranger's half paid for the fill");
        assertEq(tokenB.balanceOf(maker), NET_OUT, "and the maker took the proceeds");
        assertEq(tokenA.balanceOf(stranger), 0, "the stranger got nothing back");
    }

    /**
     * @notice A deposit against an intent that has already expired is accepted, and recoverable.
     *
     * `deposit` reads no clock. That is defensible — the funds can only leave through this intent
     * or through the cooldown, and an expired intent cannot fill — but it means a maker can post
     * a reservation that nothing will ever spend. The recovery costs two more transactions and a
     * cooldown, and this test walks it, because an escrow the maker cannot get back would be a
     * far worse bug than an escrow they can.
     *
     * Worth a check in the UI rather than in the contract: the gas is charged on every honest
     * deposit and the recovery already exists.
     */
    function test_ADepositAgainstAnExpiredIntentIsAcceptedAndStillRecoverable() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);

        vm.warp(i.endTime + 1);

        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);
        assertEq(settlement.reserved(h), AMOUNT_IN, "the contract took it without complaint");

        assertEq(
            uint256(settlement.fillability(i, sig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Expired),
            "and nothing will ever spend it"
        );

        vm.startPrank(maker);
        settlement.withdraw(i);
        vm.stopPrank();

        assertEq(settlement.reserved(h), 0, "the cooldown is the way out");
        assertEq(tokenA.balanceOf(maker), 1_000_000e18, "and the maker is whole again");
    }

    // ── The callback path pulls; it does not measure ─────────────────────────

    /**
     * @notice A callback that stands good for nothing settles nothing, and the refusal comes from
     *         the token rather than from a post-condition of ours.
     *
     * `UnderpayingExecutor` allows one wei short, so the contract's pull fails on the amount. This
     * one never approves at all, so the pull fails on the allowance. Both are the same answer, and
     * that is the point of pulling: the contract does not have to distinguish a short executor
     * from an absent one, because it never infers a payment in the first place.
     */
    function test_ACallbackThatStandsGoodForNothingSettlesNothing() public {
        FreeloadingExecutor bot = new FreeloadingExecutor();
        tokenB.mint(address(bot), 1_000_000e18); // it has the money; it just never allows it

        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        vm.expectRevert();
        bot.settle(settlement, i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(tokenB.balanceOf(maker), 0, "the maker was paid nothing");
        assertEq(tokenA.balanceOf(address(bot)), 0, "and the token A went back with the revert");
        assertEq(settlement.filled(settlement.hashIntent(i)), 0, "the intent is untouched");
    }

    /**
     * @notice `cancel` and `invalidateBefore` are reachable from inside a callback, and neither
     *         can change the fill it interrupts.
     *
     * The three are the only state-changing entry points without the `nonReentrant` guard, so the
     * question is fair: an executor gets a frame in the middle of a settlement, holding the
     * maker's token A, before the contract has pulled token B back. What can they reach?
     *
     * All three doors open. None of them helps, for one structural reason: the callback runs as
     * `msg.sender`, and all three functions act only on the caller's own intents and the caller's
     * own nonce floor. The executor cannot cancel a maker's intent, cannot unlock a maker's
     * reservation, and cannot move a maker's floor. Their own escrow is untouched by any of it,
     * and the interrupted fill settles on exactly the terms it was priced at.
     *
     * Guarding the three would cost every honest fill nothing and buy nothing either. The reason
     * they are safe is the authorisation check, not the guard — which is worth knowing before
     * somebody adds a fourth door that authorises differently.
     */
    function test_TheUnguardedDoorsOpenFromACallbackAndChangeNothing() public {
        SiblingProbe bot = new SiblingProbe(settlement);
        tokenB.mint(address(bot), 1_000_000e18);
        bot.approveMax(address(tokenB), relayer);

        // The probe's own escrow intent, so `cancel` has something to bite.
        ProveSettlement.Intent memory mine = _intent();
        mine.maker = address(bot);
        mine.recipient = address(bot);
        mine.flags = settlement.FLAG_ESCROW();
        mine.nonce = 500;
        bytes32 mineHash = settlement.hashIntent(mine);
        tokenA.mint(address(bot), 100e18);
        bot.arm(mine, 100e18);

        ProveSettlement.Intent memory victim = _intent();
        bytes memory sig = _sign(victim);
        bytes32 victimHash = settlement.hashIntent(victim);
        TakePoints.Quote memory q_fee = settlement.quote(victim, AMOUNT_IN / 2, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;

        bot.settle(victim, sig, AMOUNT_IN / 2, ANY_FEE);

        // The doors are open. Say so out loud, so a future guard on any of them is a deliberate
        // change to what this test asserts rather than a silent one.
        assertTrue(bot.cancelOpened(), "cancel is not behind the guard");
        assertTrue(bot.invalidateOpened(), "invalidateBefore is not behind the guard");

        // And nothing they reached belongs to the maker being filled.
        assertEq(settlement.cancelledAt(victimHash), 0, "the victim's intent is not cancelled");
        assertEq(settlement.nonceFloor(maker), 0, "the victim's nonce floor did not move");
        assertEq(settlement.reserved(mineHash), 100e18, "the probe's own escrow is where it was");

        // The interrupted fill settled on the terms it was priced at, and no others.
        assertEq(tokenB.balanceOf(maker), delivered, "the maker was paid in full");
        assertEq(
            settlement.pendingFees(feeCfg(sink), address(tokenB)),
            fee,
            "the sink was charged in full"
        );
        assertEq(
            tokenA.balanceOf(address(bot)), AMOUNT_IN / 2, "the executor took exactly its take"
        );
        assertEq(settlement.filled(victimHash), AMOUNT_IN / 2, "and booked exactly its take");
    }

    /**
     * @notice The guard is not what keeps a maker out of the middle of a batch — the token is.
     *
     * A maker does not need to be the executor to get a frame. Naming a `tokenOut` that calls its
     * receiver back buys them one inside `_deliverTo`, and from there `cancel` is unguarded and
     * acts on their own intents, which is exactly what they need. They cancel a later leg of the
     * batch that is paying them, and a batch that was told not to skip dies with `IsCancelled`
     * after the executor has already released the earlier legs' token A.
     *
     * This is griefing, not theft: the revert takes the whole transaction with it, so the maker
     * keeps nothing and the executor loses gas. `skipInvalid` is the defence and it works — the
     * second half of this test proves the same batch survives with it set, which is one more
     * reason an executor should never run a batch of strangers' intents without it.
     *
     * The reentrancy guard would not help. `cancel` is a maker action and blocking it mid-fill
     * would block the honest case too. An executor's real defence is a token allowlist, which is
     * what `fillBatch`'s own documentation already says.
     */
    function test_AHookedMakerCanKillAnUnskippedBatchFromInsideItsOwnPayment() public {
        HookToken hook = new HookToken();
        HookedMaker hm = new HookedMaker(settlement);

        tokenA.mint(address(hm), 1_000e18);
        hm.approveMax(address(tokenA));
        hook.mint(executor, 1_000_000e18);
        vm.prank(executor);
        hook.approve(relayer, type(uint256).max);

        // Leg one pays the hooked maker in the hook token, so the token hands them a frame.
        ProveSettlement.Intent memory paid = _intent();
        paid.maker = address(hm);
        paid.recipient = address(hm);
        paid.tokenOut = address(hook);
        paid.amountIn = 500e18;
        paid.nonce = 600;

        // Leg two is the same maker's second intent, later in the batch. `cancel` only reaches
        // the caller's own intents, so this is the shape the griefer actually has.
        ProveSettlement.Intent memory doomed = _intent();
        doomed.maker = address(hm);
        doomed.recipient = address(hm);
        doomed.tokenOut = address(hook);
        doomed.amountIn = 500e18;
        doomed.nonce = 601;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: paid, signature: hex"00", take: 500e18, arming: ""
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: doomed, signature: hex"00", take: 500e18, arming: ""
        });

        uint256 snap = vm.snapshotState();

        hm.aim(doomed);
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.IsCancelled.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);

        vm.revertToState(snap);

        // The same attack against a batch that was told to skip costs the griefer their own leg
        // and costs the executor one wasted evaluation.
        hm.aim(doomed);
        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 1, "the batch survived");
        assertEq(settlement.filled(settlement.hashIntent(paid)), 500e18, "the first leg settled");
        assertEq(
            settlement.filled(settlement.hashIntent(doomed)), 0, "and the cancelled one did not"
        );
    }

    // ── The gasless path ─────────────────────────────────────────────────────

    /**
     * @notice A one-wei fill against an authorization escrows the maker's whole `amountIn`.
     *
     * `_redeem` moves `i.amountIn`, because that is the value the maker signed into the EIP-3009
     * authorization and a 3009 transfer is all-or-nothing. The fill that triggered it can be any
     * size at all. So an executor who takes one wei of a partial-fill intent moves the maker's
     * entire balance into escrow, and the remainder now leaves only through a further fill or
     * through `withdraw`.
     *
     * That is a real cost on a path whose whole promise is "the maker signed twice and sent
     * nothing": recovering the remainder is a transaction of the maker's own gas. It is bounded —
     * the maker authorised exactly this amount and gets all of it back — and nobody but the maker
     * can withdraw it. But an executor can impose it for the price of a one-wei fill, and a maker
     * signing a gasless partial-fill intent should be told so.
     *
     * **`minFill` prices this; it does not close it.** The next test sets a floor and the one-wei
     * take is refused, so the cheapest way to move a maker's balance costs a real fill instead of
     * a wei. The move itself is still all-or-nothing, because an EIP-3009 authorization is a
     * fixed value under a single-use nonce and cannot be redeemed in pieces. A fix would have to
     * redeem lazily or authorise per fill, and neither is expressible in that standard.
     *
     * This test leaves `minFill` at zero, which is what a maker who names no floor signs, so it
     * still measures the worst case.
     */
    function test_AOneWeiAuthorizationFillEscrowsTheMakersWholeBalance() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.tokenIn = address(auth);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);
        ProveSettlement.Authorization memory a = _authorization(auth, AMOUNT_IN, h);

        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, 1, a, ANY_FEE);

        assertEq(auth.balanceOf(maker), 0, "the maker's whole balance left their wallet");
        assertEq(settlement.reserved(h), AMOUNT_IN - 1, "and all but the wei sits in escrow");

        // Two transactions and a cooldown, paid for by the maker, on the gasless path.
        vm.startPrank(maker);
        settlement.withdraw(i);
        vm.stopPrank();

        assertEq(auth.balanceOf(maker), AMOUNT_IN - 1, "the maker got the remainder back");
    }

    /**
     * @notice A floor makes the one-wei take unfillable. The whole escrow still moves on the
     *         first fill that clears the floor, and that is the standard's constraint.
     *
     * Both halves are the point. `minFill` raises the price of moving a maker's balance from one
     * wei to a real commitment; it cannot stop the balance moving, because `_redeem` presents the
     * authorization for `amountIn` whatever the take is.
     */
    function test_AMinFillRefusesTheOneWeiTakeButNotTheWholeRedemption() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.tokenIn = address(auth);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        i.minFill = AMOUNT_IN / 4;
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);
        ProveSettlement.Authorization memory a = _authorization(auth, AMOUNT_IN, h);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BelowMinFill.selector);
        settlement.fillWithAuthorization(i, sig, 1, a, ANY_FEE);

        assertEq(auth.balanceOf(maker), AMOUNT_IN, "nothing left the maker's wallet");
        assertFalse(auth.authorizationState(maker, h), "and the authorization is unspent");

        // A take at the floor goes through, and the whole authorization is redeemed with it.
        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, i.minFill, a, ANY_FEE);

        assertEq(auth.balanceOf(maker), 0, "the standard moves the lot or nothing");
        assertEq(settlement.reserved(h), AMOUNT_IN - i.minFill, "the rest waits in escrow");
    }

    /**
     * @notice One authorization funds one intent once. The second redemption is refused by the
     *         token, and the contract never asks for it twice in the first place.
     *
     * Two halves. `_reserved[h] < take` stops the contract re-presenting an authorization it has
     * already spent, which is what makes a partial fill sequence work at all. Behind that, the
     * token's own nonce ledger stops a replay that gets past us. EIP-3009 mandates that ledger,
     * so a conforming token refuses; a token that skipped it would pull the maker's balance a
     * second time into an intent that can never spend it.
     */
    function test_AnAuthorizationCannotBeRedeemedTwice() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, 2 * AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.tokenIn = address(auth);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);
        ProveSettlement.Authorization memory a = _authorization(auth, AMOUNT_IN, h);

        // Spend the whole intent, which empties the reservation the first redemption filled.
        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, a, ANY_FEE);
        assertEq(settlement.reserved(h), 0, "the redemption was spent to the wei");
        assertTrue(auth.authorizationState(maker, h), "and the token has booked the nonce");

        // The same intent and the same authorization, presented again. The reservation is empty
        // and the intent is full. `fillWithAuthorization` looks before it pulls, so the second
        // attempt dies on our own reason and the token never hears about it. The token's refusal
        // is still behind that — `authorizationState` above is already set — but on this path
        // nothing reaches it.
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.TooMuch.selector);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, a, ANY_FEE);
        assertEq(auth.balanceOf(maker), AMOUNT_IN, "the maker's second balance is still theirs");

        // A second presentation of the same authorization is refused inside the token. Without
        // that, the maker's second `AMOUNT_IN` would be pulled by an intent already filled.
        ProveSettlement.Intent memory again = _intent();
        again.tokenIn = address(auth);
        again.flags = i.flags;
        again.nonce = 2;
        bytes memory againSig = _sign(again);
        ProveSettlement.Authorization memory replay = a;
        replay.nonce = settlement.hashIntent(again);

        vm.prank(executor);
        vm.expectRevert(); // the 3009 signature covers the nonce, so a swapped one will not verify
        settlement.fillWithAuthorization(again, againSig, AMOUNT_IN, replay, ANY_FEE);

        assertEq(auth.balanceOf(maker), AMOUNT_IN, "the maker's second balance is untouched");
    }

    // ── One nonce, two offers ────────────────────────────────────────────────

    /**
     * @notice Two intents that name the same 3009 nonce are mutually exclusive. Arming either
     *         one kills the other for good.
     *
     * This is what `Intent.authNonce` is for. A 3009 nonce is a value the signer picks and the
     * token spends once, so a maker can post the same inventory at two prices and know that only
     * one of them can ever be funded. The contract used to derive the nonce from the intent hash
     * and refuse anything else, which welded one authorization to one intent and made this
     * impossible to express.
     *
     * The maker's balance moves exactly once. That is the whole claim: two live offers, one lot
     * of inventory, and no way for a solver to take both.
     */
    function test_TwoIntentsSharingAnAuthNonceAreMutuallyExclusive() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, AMOUNT_IN);

        bytes32 shared = keccak256("one lot, two prices");

        // The same inventory at two prices. Only the price differs, so a solver would happily
        // take the cheaper one and come back for the other.
        ProveSettlement.Intent memory cheap = _intent();
        cheap.tokenIn = address(auth);
        cheap.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        cheap.authNonce = shared;
        cheap.nonce = 41;

        // Built again, not assigned from `cheap`. A memory struct assigned to a memory variable
        // is a reference, so `dear = cheap` would have edited one intent twice.
        ProveSettlement.Intent memory dear = _intent();
        dear.tokenIn = address(auth);
        dear.flags = cheap.flags;
        dear.authNonce = shared;
        dear.minOutStart = MIN_OUT * 2;
        dear.minOutEnd = MIN_OUT * 2;
        dear.nonce = 42;

        bytes memory cheapSig = _sign(cheap);
        bytes memory dearSig = _sign(dear);
        // One authorization, naming neither intent's hash and good for both.
        ProveSettlement.Authorization memory a = _authorization(auth, AMOUNT_IN, shared);

        vm.prank(executor);
        settlement.fillWithAuthorization(cheap, cheapSig, AMOUNT_IN, a, ANY_FEE);
        assertEq(auth.balanceOf(executor), AMOUNT_IN, "the first offer settled");
        assertEq(auth.balanceOf(maker), 0, "and the maker's balance moved once");

        // The token spent the nonce, so the second offer can never be funded. It is not
        // cancelled and its signature is fine — there is simply nothing left to arm it with.
        assertEq(
            uint256(settlement.fillability(dear, dearSig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.EscrowShort),
            "the second offer reads as unfunded"
        );
        vm.prank(executor);
        vm.expectRevert(); // the token refuses a nonce it has already spent
        settlement.fillWithAuthorization(dear, dearSig, AMOUNT_IN, a, ANY_FEE);

        assertEq(auth.balanceOf(maker), 0, "and the maker's balance moved once, not twice");
        assertEq(settlement.reserved(settlement.hashIntent(dear)), 0, "nothing reached it");
    }

    /**
     * @notice Exclusion only holds between siblings of the same size, and the token is what
     *         holds it. A sibling asking a different `amountIn` shares nothing.
     *
     * `_redeem` presents `i.amountIn` as the value, and the maker's 3009 signature commits to
     * that value, so an authorization signed for the whole amount does not verify against an
     * intent asking half of it. This contract does not check the size and does not need to.
     */
    function test_ASiblingOfADifferentSizeCannotShareTheAuthorization() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, AMOUNT_IN);

        bytes32 shared = keccak256("same nonce, different size");

        ProveSettlement.Intent memory half = _intent();
        half.tokenIn = address(auth);
        half.amountIn = AMOUNT_IN / 2;
        half.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        half.authNonce = shared;
        half.nonce = 43;
        bytes memory sig = _sign(half);

        // Signed for the whole amount, presented against an intent asking half.
        ProveSettlement.Authorization memory a = _authorization(auth, AMOUNT_IN, shared);

        vm.prank(executor);
        vm.expectRevert(); // the value is inside the signature, so the token refuses it
        settlement.fillWithAuthorization(half, sig, AMOUNT_IN / 2, a, ANY_FEE);

        assertEq(auth.balanceOf(maker), AMOUNT_IN, "the maker's tokens never moved");
        assertFalse(auth.authorizationState(maker, shared), "and the nonce is unspent");
    }

    /**
     * @notice A zero `authNonce` means the intent's own hash, which is what every intent carried
     *         before the field existed. An authorization naming anything else does not arm it.
     *
     * A maker cannot name their own hash, because naming it would change it. Zero is how they
     * ask for it.
     */
    function test_AZeroAuthNonceStillMeansTheIntentHash() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.tokenIn = address(auth);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        assertEq(i.authNonce, bytes32(0), "the default");
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);

        // A real authorization from the real maker, naming a nonce the intent did not ask for.
        ProveSettlement.Authorization memory wrong =
            _authorization(auth, AMOUNT_IN, keccak256("some other nonce"));
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadTerms.selector);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, wrong, ANY_FEE);
        assertEq(auth.balanceOf(maker), AMOUNT_IN, "the maker's tokens never moved");

        // The hash is what it asked for, and the hash is what arms it.
        ProveSettlement.Authorization memory right = _authorization(auth, AMOUNT_IN, h);
        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, right, ANY_FEE);
        assertEq(auth.balanceOf(executor), AMOUNT_IN, "the executor took token A");
    }

    /**
     * @notice An authorization funds an intent, the maker cancels it, and the remainder comes
     *         straight back.
     *
     * This used to be the most expensive exit in the product. A partly-filled gasless intent left
     * escrow behind, and cancelling it armed one cooldown for the intent and a second, independent
     * one for the withdrawal: thirty minutes and three transactions to recover a quarter of your
     * own money. It is now two transactions and no waiting, and the second one is optional —
     * `withdraw` empties the reservation, and an empty reservation cannot fill.
     */
    function test_AGaslessIntentCanBeCancelledAndTheEscrowStillComesBack() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.tokenIn = address(auth);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        i.endTime = uint64(block.timestamp + 30 days);
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);
        ProveSettlement.Authorization memory a = _authorization(auth, AMOUNT_IN, h);

        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN / 2, a, ANY_FEE);
        assertEq(settlement.reserved(h), AMOUNT_IN / 2, "half the redemption is still committed");

        vm.prank(maker);
        settlement.cancel(i);

        // Dead on the block the cancel landed. The executor gets no further fill.
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.IsCancelled.selector);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN / 4, a, ANY_FEE);

        // And the maker takes the redeemed-but-unfilled half back in one call.
        vm.prank(maker);
        settlement.withdraw(i);

        assertEq(settlement.reserved(h), 0, "the escrow came back");
        assertEq(auth.balanceOf(maker), AMOUNT_IN / 2, "and the unfilled half with it");
    }

    // ── Where the views meet the validator ───────────────────────────────────

    /**
     * @notice `available` refuses every term `_evaluate` refuses.
     *
     * Both read `_termsOk`, so the view cannot call an intent live that a fill would turn away.
     * A rising minimum, a same-token intent and a price above the `uint128` bound are all
     * `Reason.BadTerms_`. They can never fill, on any path.
     *
     * A long window is not among them any more, and the control below proves it: a week on a bare
     * allowance reads live on both sides.
     *
     * `available` still cannot speak for the signature, the maker's allowance, or an exclusive
     * executor, so `live` stays a ceiling. `fillability` answers for one executor and one size.
     */
    function test_AvailableRefusesEveryTermTheValidatorRefuses() public {
        ProveSettlement.Intent[3] memory bad;

        bad[0] = _intent();
        bad[0].tokenOut = bad[0].tokenIn;

        bad[1] = _intent();
        bad[1].minOutEnd = bad[1].minOutStart + 1;

        bad[2] = _intent();
        bad[2].minOutStart = uint256(type(uint128).max) + 1;
        bad[2].minOutEnd = bad[2].minOutStart;

        // A week on a bare allowance is a term the contract takes. It used to be the fourth
        // member of the array above.
        ProveSettlement.Intent memory week = _intent();
        week.endTime = uint64(block.timestamp + 7 days);
        (, bool weekLive) = availableOf(settlement, week);
        assertTrue(weekLive, "a long wallet window is live, not dead");

        // A clock two minutes fast costs the offer its first two minutes and nothing else.
        ProveSettlement.Intent memory fastClock = _intent();
        fastClock.startTime = uint64(block.timestamp + 2 minutes);
        fastClock.endTime = fastClock.startTime + 1 hours;
        assertEq(
            uint256(settlement.fillability(fastClock, _sign(fastClock), 1, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.NotStarted),
            "a fast clock costs two minutes, not the whole intent"
        );

        for (uint256 k = 0; k < bad.length; k++) {
            (, bool live) = availableOf(settlement, bad[k]);
            assertFalse(live, "the view calls it dead");
            assertEq(
                uint256(settlement.fillability(bad[k], _sign(bad[k]), 1, executor, ANY_FEE)),
                uint256(ProveSettlement.Reason.BadTerms_),
                "and the validator agrees"
            );
        }

        // The control: sound terms still read live on both sides.
        ProveSettlement.Intent memory good = _intent();
        (, bool ok) = availableOf(settlement, good);
        assertTrue(ok, "and a sound intent is still live");
    }

    // ── Fee arithmetic ───────────────────────────────────────────────────────

    /**
     * @notice `maxFeeRate` is a bound on the intent's own rate, exactly: equal passes, one less
     *         fails.
     *
     * The executor names the highest rate whose destination they will engage with, and the intent
     * names the rate it charges. A bound off by one in the strict direction would make every
     * honest executor's own quote reject their own fill; off by one the other way and the fill
     * touches a destination they refused. The rate costs the caller nothing either way — the fee
     * comes out of the maker's number — so this bound is about what a fill reaches, and the edge
     * still has to be exact.
     */
    function testFuzz_MaxFeeRateIsExactlyTheBound(uint256 rawFee, uint256 rawBound) public {
        uint64 cap = 0.005e18;
        uint64 live = uint64(bound(rawFee, 1, cap));
        uint256 named = bound(rawBound, 0, uint256(cap) * 2);

        ProveSettlement.Intent memory i = _intent();
        i.feeRate = live;
        bytes memory sig = _sign(i);

        vm.prank(executor);
        if (named < live) {
            vm.expectRevert(ProveSettlement.FeeTooHigh.selector);
            settlement.fill(i, sig, AMOUNT_IN, named);
            assertEq(settlement.filled(settlement.hashIntent(i)), 0, "nothing was booked");
        } else {
            settlement.fill(i, sig, AMOUNT_IN, named);
            assertEq(
                tokenB.balanceOf(maker),
                MIN_OUT - (MIN_OUT * i.feeRateProceeds) / 1e18,
                "the maker bears P3 only: P2 sits on top and the solver bears it"
            );
        }
    }

    /**
     * @notice Every rate the field can hold, on both sides of the ceiling: at or below `WAD` the
     *         intent is live and fills, above it every view says `BadTerms_` and no path moves.
     *
     * The ceiling is arithmetic, not policy. `_quote` carves the fee out of the gross and
     * subtracts, so a rate above 100% makes `fee` larger than `gross` and the subtraction panics.
     * A panic is not a `Reason`, so `skipInvalid` cannot step over it and one signature takes a
     * whole batch down. This fuzzes the whole `uint64` range — up to 1,844% — because the field
     * allows every value in it and only `_termsOk` refuses any.
     *
     * Four surfaces, because a view that disagreed with a fill would be worse than either being
     * wrong: `available`, `fillability`, the single `fill`, and a batch under `skipInvalid`.
     */
    function testFuzz_EveryRateAboveOneIsRefusedOnEverySurface(uint64 rawRate, uint256 rawTake)
        public
    {
        uint64 rate = uint64(bound(rawRate, 0, type(uint64).max));
        uint256 take = bound(rawTake, 1, AMOUNT_IN);
        bool tooHigh = rate > settlement.WAD();

        ProveSettlement.Intent memory i = _intent();
        i.feeRateProceeds = rate;
        i.nonce = 4242;
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);

        (, bool live) = availableOf(settlement, i);
        assertEq(live, !tooHigh, "the view and the ceiling disagree");
        ProveSettlement.Reason r = settlement.fillability(i, sig, take, executor, ANY_FEE);
        assertEq(
            r == ProveSettlement.Reason.BadTerms_, tooHigh, "the validator and the ceiling disagree"
        );

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = ProveSettlement.FillRequest({intent: i, signature: sig, take: take, arming: ""});

        vm.prank(executor);
        if (tooHigh) {
            // A reason, so the batch steps over it and settles nothing rather than dying.
            assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "the batch did not step over it");
            vm.prank(executor);
            vm.expectRevert(ProveSettlement.BadTerms.selector);
            settlement.fill(i, sig, take, ANY_FEE);
            assertEq(settlement.filled(h), 0, "and nothing was booked");
        } else {
            assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 1, "an honest rate did not fill");
            assertEq(settlement.filled(h), take, "and it was booked");
        }
    }

    /**
     * @notice Whatever rate an intent signs, the executor's outlay does not move — and the whole
     *         of the rate lands on the maker.
     *
     * This is the split's central claim, fuzzed. The gross is computed before any fee arithmetic
     * and nothing after it may change the total, so `delivered + fee` is the same number at every
     * rate. What the rate decides is how that number divides.
     *
     * It was `testFuzz_TheFeeRateNeverReachesTheMakersProceeds` and it asserted the opposite half:
     * that `delivered` was rate-independent. The rate reaches the maker's proceeds now, and it is
     * the only thing that does. The invariant simply moved one term to the left.
     */
    function testFuzz_TheFeeRateNeverReachesTheExecutorsOutlay(uint256 rawFee, uint128 rawTake)
        public
    {
        uint64 rate = uint64(bound(rawFee, 0, 0.005e18));
        uint256 take = bound(rawTake, 1, AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        TakePoints.Quote memory q_baseFee = settlement.quote(i, take, block.timestamp);
        uint256 baseDelivered = q_baseFee.delivered;
        uint256 baseFee = q_baseFee.feeProceeds;
        uint256 baseline = baseDelivered + baseFee;

        i.feeRateProceeds = rate;
        TakePoints.Quote memory q_fee = settlement.quote(i, take, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        uint256 gross = delivered + fee;

        assertEq(gross, baseline, "the rate never moves the executor's outlay");
        assertGe(gross * AMOUNT_IN, take * MIN_OUT, "and rounding still favours the maker");

        assertEq(
            fee, (gross * rate) / settlement.WAD(), "the fee is the rate on the gross, floored"
        );
        assertEq(delivered, gross - fee, "and the maker keeps the rest, dust included");
        if (rate == 0) assertEq(fee, 0, "no rate signed, no fee charged");

        // The executor pays exactly what they were quoted, whatever the settings.
        bytes memory sig = _sign(i);
        uint256 before = tokenB.balanceOf(executor);
        vm.prank(executor);
        settlement.fill(i, sig, take, ANY_FEE);
        assertEq(before - tokenB.balanceOf(executor), gross, "quoted is what is paid");
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

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

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function _authorization(MockERC3009 auth, uint256 value, bytes32 intentHash)
        internal
        view
        returns (ProveSettlement.Authorization memory a)
    {
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        a.nonce = intentHash;
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

    // ── Getting out ──────────────────────────────────────────────────────────

    /**
     * @notice The expired exit needs no cooldown because nothing can fill an expired intent.
     *
     * That is the whole safety argument, so state it as a property rather than trust the prose:
     * at any time at or past `endTime`, and whatever the reservation looks like, the intent is
     * unfillable — so releasing the funds takes nothing from anybody.
     */
    function testFuzz_NothingCanFillAnIntentTheExpiredExitWouldEmpty(uint256 dt, uint256 take)
        public
    {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);

        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);

        vm.warp(i.endTime + bound(dt, 0, 365 days));
        take = bound(take, 1, AMOUNT_IN);

        assertEq(
            uint256(settlement.fillability(i, sig, take, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Expired),
            "an expired intent is unfillable, so its escrow is nobody else's"
        );

        vm.prank(maker);
        settlement.withdraw(i);
        assertEq(settlement.reserved(settlement.hashIntent(i)), 0);
    }

    /**
     * @notice Taking the money out ends the offer, and a stranger cannot put it back.
     *
     * An intent is armed by one action, and undoing that action undoes the offer. Without this
     * the withdrawal only emptied the reservation: `deposit` is permissionless, so anybody could
     * fund the same intent hash and the maker's abandoned signature would fill months later and
     * pay them unasked. Nobody profits from doing it, which made it a footgun rather than an
     * attack — but a signature that can come back from the dead is not something a maker can
     * reason about, and the docs claimed the opposite in five places.
     */
    function test_WithdrawingEndsTheOfferAndNobodyCanFundItBack() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);

        vm.startPrank(maker);
        settlement.deposit(i, AMOUNT_IN);
        settlement.withdraw(i);
        vm.stopPrank();

        assertEq(settlement.cancelledAt(h), block.timestamp, "the withdrawal called it off");
        assertEq(
            uint256(settlement.fillability(i, sig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Cancelled),
            "dead, not merely empty"
        );

        // And it cannot be re-armed, by a stranger or by the maker.
        address outsider = makeAddr("stranger");
        tokenA.mint(outsider, AMOUNT_IN);
        vm.startPrank(outsider);
        IERC20(i.tokenIn).approve(relayer, type(uint256).max);
        vm.expectRevert(ProveSettlement.IsCancelled.selector);
        settlement.deposit(i, AMOUNT_IN);
        vm.stopPrank();

        vm.prank(maker);
        vm.expectRevert(ProveSettlement.IsCancelled.selector);
        settlement.deposit(i, AMOUNT_IN);
    }

    /**
     * @notice The same footgun, one rung down, where the contract cannot reach it.
     *
     * In allowance custody the arming action is an ERC-20 approval, which lives on the token. The
     * settlement never sees it granted or revoked, so it cannot make revoking mean cancelling.
     * A maker who revokes and later re-approves — to trade the same token anywhere, which is an
     * ordinary thing to do — brings every intent they ever signed back to life.
     *
     * That is inherent, not a bug to fix here. It is the strongest argument for a short expiry
     * that exists, and the reason `cancel` is the only real off switch on this rung.
     */
    function test_RevokingAnAllowanceIsNotCancellingAndReApprovingRevivesEveryOldIntent() public {
        ProveSettlement.Intent memory i = _intent(); // allowance custody, no escrow flag
        bytes memory sig = _sign(i);

        vm.prank(maker);
        tokenA.approve(relayer, 0);
        assertEq(
            uint256(settlement.fillability(i, sig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.EscrowShort),
            "unfillable while the allowance is zero"
        );
        assertEq(settlement.cancelledAt(settlement.hashIntent(i)), 0, "but never cancelled");

        // The maker re-approves months later, for some unrelated trade.
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        assertEq(
            uint256(settlement.fillability(i, sig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "and the old intent is live again"
        );

        // Only `cancel` and `endTime` are real off switches here.
        vm.prank(maker);
        settlement.cancel(i);
        assertEq(
            uint256(settlement.fillability(i, sig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Cancelled),
            "cancel is the off switch on this rung"
        );
    }

    // ── How long a signature may last ────────────────────────────────────────

    /**
     * @notice A wallet intent lasts exactly as long as the maker signed for. Nothing shortens it.
     *
     * The settlement used to refuse a wallet window wider than an hour, on the reasoning that an
     * ERC-20 approval is an off switch this contract cannot see. That reasoning is sound and the
     * rule was still wrong: the loss falls on the maker who signed and on nobody else, because a
     * wallet rung holds no reservation between transactions and no other maker's escrow can pay
     * for the fill. A contract that refuses a term you signed is the thing this one claims not to
     * be. The warning belongs in the app, where a maker can read it and step past it on purpose.
     */
    function test_AWalletIntentLastsAsLongAsTheMakerSignedFor() public view {
        ProveSettlement.Intent memory week = _intent();
        week.startTime = uint64(block.timestamp);
        week.endTime = uint64(block.timestamp + 7 days);
        assertEq(
            uint256(settlement.fillability(week, _sign(week), 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "a week on a bare allowance is the maker's call to make"
        );

        ProveSettlement.Intent memory year = _intent();
        year.startTime = uint64(block.timestamp);
        year.endTime = uint64(block.timestamp + 365 days);
        assertEq(
            uint256(settlement.fillability(year, _sign(year), 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "and a year is no different in kind"
        );

        // Escrow was always unbounded, and still is. It just needs funding to fill.
        ProveSettlement.Intent memory rested = _intent();
        rested.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        rested.startTime = uint64(block.timestamp);
        rested.endTime = uint64(block.timestamp + 365 days);
        assertEq(
            uint256(settlement.fillability(rested, _sign(rested), 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.EscrowShort),
            "unfunded, which is a different complaint"
        );
    }

    /**
     * @notice The zombie signature is real, and this is what accepting it looks like.
     *
     * A maker revokes their allowance believing that ends the offer, and re-approves the same
     * token a month later for something unrelated. The old signature comes back and fills. No cap
     * stands in the way any more, so this test states the hazard rather than proving it was
     * prevented: revoking an allowance does not cancel an intent, and `cancel` is the only thing
     * that does.
     */
    function test_ARevivedAllowanceRevivesEverySignatureStillInsideItsWindow() public {
        ProveSettlement.Intent memory i = _intent();
        i.startTime = uint64(block.timestamp);
        i.endTime = uint64(block.timestamp + 90 days);
        bytes memory sig = _sign(i);

        vm.prank(maker);
        tokenA.approve(relayer, 0);
        assertEq(
            uint256(settlement.fillability(i, sig, 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.EscrowShort),
            "revoking makes it unfillable"
        );

        // A month later the maker approves that token again, for something else entirely.
        vm.warp(block.timestamp + 30 days);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);

        assertEq(
            uint256(settlement.fillability(i, sig, 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "and the forgotten signature is live again"
        );

        vm.prank(maker);
        settlement.cancel(i);
        assertEq(
            uint256(settlement.fillability(i, sig, 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Cancelled),
            "the only real off switch, still real"
        );
    }

    /**
     * @notice A window at the top of the `uint64` range is a reason or a fill, never a panic.
     *
     * The old check added `MAX_WALLET_WINDOW` to `startTime` and needed a widening to 256 bits to
     * stay off a panic. Removing the check removed both sums, so there is nothing left to
     * overflow — but a batch must still step over an intent it cannot fill rather than die on it,
     * and that is what this pins.
     */
    function test_AnUnreachableWindowIsSteppedOverRatherThanFatal() public {
        ProveSettlement.Intent memory far = _intent();
        far.startTime = type(uint64).max - 10;
        far.endTime = type(uint64).max;
        far.nonce = 91;
        assertEq(
            uint256(settlement.fillability(far, _sign(far), 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.NotStarted),
            "no overflow, and not bad terms either - it simply has not opened"
        );

        ProveSettlement.Intent memory good = _intent();
        good.nonce = 92;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: far, signature: _sign(far), take: 1e18, arming: ""
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: good, signature: _sign(good), take: 1e18, arming: ""
        });

        vm.prank(executor);
        uint256 filled = settlement.fillBatch(reqs, true, ANY_FEE);
        assertEq(filled, 1, "the good one settled and the unreachable one was stepped over");
    }

    /**
     * @notice An offer may open ten years out on a bare allowance, and says so until it does.
     *
     * This was refused before, by the second of the two bounds. A scheduled offer is a thing a
     * maker may legitimately want, and on a wallet rung it costs them no locked capital, which is
     * the whole appeal. `NotStarted` is the honest answer, on every rung.
     */
    function test_AnOfferMayOpenFarInTheFutureOnEveryRung() public {
        ProveSettlement.Intent memory far = _intent();
        far.startTime = uint64(block.timestamp + 3650 days);
        far.endTime = far.startTime + 1 hours;
        far.nonce = 94;

        assertEq(
            uint256(settlement.fillability(far, _sign(far), 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.NotStarted),
            "waiting for its own start time, which is what a decade out should say"
        );
        (, bool live) = availableOf(settlement, far);
        assertFalse(live, "and the view says the same");

        ProveSettlement.Intent memory escrowed = far;
        escrowed.flags = settlement.FLAG_ESCROW();
        assertEq(
            uint256(settlement.fillability(escrowed, _sign(escrowed), 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.NotStarted),
            "escrow reads the same, as it always did"
        );
    }

    /**
     * @notice A gasless intent that is already dead reports our reason, and keeps its
     *         authorization.
     *
     * `fillWithAuthorization` used to redeem first and validate second. A cancelled intent then
     * spent an `ecrecover` and a token transfer before the settlement threw the lot away, and an
     * executor simulating it read whatever the token said rather than learning the intent was
     * dead. Worse, the token often failed first, on a stale `validBefore` or a spent nonce.
     */
    function test_ADeadGaslessIntentIsRefusedBeforeTheTokenIsTouched() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.tokenIn = address(auth);
        i.flags = settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);
        ProveSettlement.Authorization memory a = _authorization(auth, AMOUNT_IN, h);

        vm.prank(maker);
        settlement.cancel(i);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.IsCancelled.selector);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, a, ANY_FEE);

        assertFalse(auth.authorizationState(maker, h), "the authorization is still unspent");
        assertEq(auth.balanceOf(maker), AMOUNT_IN, "and the money never left the maker");
    }
}
