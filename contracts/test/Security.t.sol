// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

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

/// @notice Ten percent of every transfer goes up in smoke.
contract TaxToken is ERC20 {
    constructor() ERC20("Tax", "TAX") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            super._update(from, address(0xdead), value / 10);
            super._update(from, to, value - value / 10);
        } else {
            super._update(from, to, value);
        }
    }
}

/// @notice Taxes only what arrives at `target`, so a delivery to anyone else is whole.
contract ShortingToken is ERC20 {
    address public target;

    constructor() ERC20("Short", "SHRT") {}

    function mint(address to, uint256 a) external {
        _mint(to, a);
    }

    function aim(address t) external {
        target = t;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (to == target && from != address(0)) value -= value / 10;
        super._update(from, to, value);
    }
}

/// @notice An ERC-1271 maker whose answer is 32 bytes of rubbish.
contract GarbageMaker {
    fallback(bytes calldata) external returns (bytes memory) {
        return abi.encode(type(uint256).max);
    }
}

/**
 * @notice Regression tests for the findings of the 2026-08-11 audit. Each one is an attack that
 *         worked against the first version of these contracts. They are written as the defence:
 *         a failure here means the hole is open again.
 */
contract SecurityTest is Test {
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

    /*
     * C-1 and L-1 are gone with the contract they defended.
     *
     * Both were about `FeeSink`, the buy-and-burn this repository used to deploy. C-1 held that
     * no caller could route a fee through a pool of their own, and L-1 that a token lying about
     * what it wraps could not redirect a sale. Neither claim has a subject any more: nothing here
     * sells anything. A fee goes to the `feeTo` the intent signed, and a token no reservation
     * claims goes to `defaultProceeds`. Both are plain transfers to an address somebody named.
     *
     * The findings are recorded in docs/AUDIT-SCOPE.md. Deleting a regression test is
     * normally how a hole reopens, so it is worth saying plainly why this one cannot: the code
     * that could be attacked is not in this repository, and no contract here calls a router.
     */

    // ── H-1: escrow must not be spendable by a competing intent ──────────────

    function test_H1_MakerCannotEmptyEscrowWithASelfDealingIntent() public {
        ProveSettlement.Intent memory real = _intent();
        real.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory realSig = _sign(real, makerKey);
        bytes32 realHash = settlement.hashIntent(real);

        vm.prank(maker);
        settlement.deposit(real, AMOUNT_IN);
        assertEq(settlement.reserved(realHash), AMOUNT_IN, "committed to this intent");

        // The maker mints a worthless token and signs a second escrow intent to themselves,
        // trying to pull the same funds back out before the executor's fill lands.
        MockERC20 junk = new MockERC20("Junk", "JNK", 18);
        junk.mint(maker, 1e18);
        vm.prank(maker);
        junk.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory escape = _intent();
        escape.tokenOut = address(junk);
        escape.minOutStart = 1;
        escape.minOutEnd = 1;
        escape.executor = maker;
        escape.flags = settlement.FLAG_ESCROW();
        escape.nonce = 2;
        bytes memory escapeSig = _sign(escape, makerKey);

        vm.prank(maker);
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fill(escape, escapeSig, AMOUNT_IN, ANY_FEE);

        // The executor's fill still goes through, which is the whole promise of "proven".
        vm.prank(executor);
        settlement.fill(real, realSig, AMOUNT_IN, ANY_FEE);
        assertEq(tokenA.balanceOf(executor), AMOUNT_IN);
    }

    // ── M-1: skipInvalid must really skip ────────────────────────────────────

    function test_M1_AnUnfundedIntentDoesNotKillTheBatch() public {
        (address griefer, uint256 grieferKey) = makeAddrAndKey("griefer");
        tokenA.mint(griefer, 10_000e18); // signs, but never approves

        ProveSettlement.Intent memory good = _intent();
        bytes memory goodSig = _sign(good, makerKey);

        ProveSettlement.Intent memory bad = _intent();
        bad.maker = griefer;
        bad.recipient = griefer;
        bad.amountIn = 1_000e18;
        bad.nonce = 99;
        bytes memory badSig = _sign(bad, grieferKey);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: bad, signature: badSig, take: 1_000e18, arming: ""
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: good, signature: goodSig, take: AMOUNT_IN, arming: ""
        });

        vm.prank(executor);
        uint256 count = settlement.fillBatch(reqs, true, ANY_FEE);

        assertEq(count, 1, "the unfundable one was stepped over");
        assertEq(settlement.filled(settlement.hashIntent(good)), AMOUNT_IN, "the good one filled");
    }

    function test_M1_ARisingMinimumIsRejectedNotReverted() public {
        ProveSettlement.Intent memory bad = _intent();
        bad.minOutStart = 1e18;
        bad.minOutEnd = 2e18; // rising, which used to underflow inside minOutAt
        bytes memory sig = _sign(bad, makerKey);

        assertEq(
            uint256(settlement.fillability(bad, sig, 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.BadTerms_),
            "a rising minimum is a reason, not a revert"
        );

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = ProveSettlement.FillRequest({intent: bad, signature: sig, take: 1e18, arming: ""});

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "skipped, not reverted");
    }

    // ── M-2: a hostile ERC-1271 answer must not bomb the decoder ─────────────

    function test_M2_DirtyErc1271ReturnIsJustABadSignature() public {
        GarbageMaker gm = new GarbageMaker();
        tokenA.mint(address(gm), 1e24);

        ProveSettlement.Intent memory i = _intent();
        i.maker = address(gm);
        i.recipient = address(gm);

        // The view must answer, not revert. Which reason it lands on is not the point — a
        // hostile maker used to blow up the decoder and take the caller's frame with it.
        uint256 reason = uint256(settlement.fillability(i, hex"00", AMOUNT_IN, executor, ANY_FEE));
        assertTrue(reason != uint256(ProveSettlement.Reason.Ok), "not fillable");

        ProveSettlement.Intent memory good = _intent();
        bytes memory goodSig = _sign(good, makerKey);
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: i, signature: hex"00", take: AMOUNT_IN, arming: ""
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: good, signature: goodSig, take: AMOUNT_IN, arming: ""
        });

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 1, "the honest intent survives");
    }

    // ── R2: a reservation the solver cannot back reverts the whole call ──────

    function test_AReservationTheSolverCannotBackRevertsByName() public {
        ShortingToken short = new ShortingToken();
        short.aim(address(settlement));
        short.mint(executor, 1_000_000e18);
        vm.prank(executor);
        short.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent();
        i.tokenOut = address(short);
        bytes memory sig = _sign(i, makerKey);

        vm.prank(executor);
        (bool ok, bytes memory ret) =
            address(settlement).call(abi.encodeCall(settlement.fill, (i, sig, AMOUNT_IN, ANY_FEE)));
        assertFalse(ok, "the shorted pull reverts the fill");
        bytes4 sel;
        assembly {
            sel := mload(add(ret, 0x20))
        }
        assertEq(sel, ProveSettlement.ReservationUnbacked.selector);
    }

    // ── M-3: the maker gets the signed rate, or the fill reverts ─────────────

    function test_M3_ATaxedOutputTokenCannotUnderpayTheMaker() public {
        TaxToken tax = new TaxToken();
        tax.mint(executor, 1_000_000e18);
        vm.prank(executor);
        tax.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent();
        i.tokenOut = address(tax);
        bytes memory sig = _sign(i, makerKey);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.Underpaid.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    // ── L-2: the callback must not count the maker's own tokens ──────────────

    function test_L2_SameTokenBothSidesIsRejected() public {
        ProveSettlement.Intent memory i = _intent();
        i.tokenOut = address(tokenA); // same as tokenIn
        bytes memory sig = _sign(i, makerKey);

        assertEq(
            uint256(settlement.fillability(i, sig, 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.BadTerms_)
        );

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadTerms.selector);
        settlement.fill(i, sig, 1e18, ANY_FEE);
    }

    // ── M-4: an authorization belongs to one intent ──────────────────────────

    function test_M4_AnAuthorizationCannotFundADifferentIntent() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, 1_000_000e18);

        ProveSettlement.Intent memory i1 = _intent();
        i1.tokenIn = address(auth);
        i1.amountIn = 10_000e18;
        i1.flags = settlement.FLAG_ESCROW();
        i1.nonce = 11;
        bytes32 h1 = settlement.hashIntent(i1);

        ProveSettlement.Intent memory i2 = _intent();
        i2.tokenIn = address(auth);
        i2.amountIn = 10_000e18;
        i2.flags = settlement.FLAG_ESCROW();
        i2.nonce = 12;
        bytes memory sig2 = _sign(i2, makerKey);

        // The authorization names the first intent, so it cannot fund the second.
        ProveSettlement.Authorization memory a = _authFor(auth, 10_000e18, h1);

        // `_redeemInto` refuses the mismatch. A single fill has nothing to step over, so the
        // reason reaches the caller rather than being swallowed by an arming frame.
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadTerms.selector);
        settlement.fillWithAuthorization(i2, sig2, 10_000e18, a, ANY_FEE);

        assertFalse(auth.authorizationState(maker, h1), "the first intent's nonce is unspent");
        assertEq(auth.balanceOf(maker), 1_000_000e18, "and the maker's tokens never moved");
    }

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
