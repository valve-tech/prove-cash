// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
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
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, NO_PERMIT2, SmartWallet} from "./Mocks.sol";
import {FaucetToken} from "./tokens/FaucetToken.sol";
import {WeirdToken} from "./tokens/WeirdToken.sol";

/**
 * @notice The test tokens, and the settlement paths that only a real token can prove.
 *
 * The centre of this file is `test_GaslessFillNeedsNoMakerTransaction`. Until it existed, the
 * gasless path had only ever run against a mock written alongside it, which proves the two agree
 * and nothing else. Here the maker signs an intent, signs an EIP-3009 authorization over a token
 * that implements the standard on its own terms, and sends nothing.
 */
contract FaucetTokenTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;

    /// @dev Eighteen decimals in, six out. The quote rounds differently on each side, and a
    ///      fixture with one decimal count everywhere would never show it.
    FaucetToken tokenIn;
    FaucetToken tokenOut;

    address sink = address(0x5152);
    address executor = address(0xE0E);
    address stranger = address(0x57A);
    address maker;
    uint256 makerKey;

    uint256 constant AMOUNT_IN = 100_000e18;
    uint256 constant MIN_OUT = 3_000e6;
    /// @dev What the maker keeps out of a gross of `MIN_OUT`. The fee comes out of the number
    ///      the maker signed, so the curve's figure is the executor's outlay and this is the
    ///      maker's receipt. Ten basis points, and it divides exactly here.
    uint256 constant NET_OUT = MIN_OUT - (MIN_OUT * 0.001e18) / 1e18;
    uint256 constant DRIP_IN = 25_000e18;
    uint64 constant COOLDOWN = 6 hours;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();

        // This contract owns both tokens, so the suite can seed a portfolio without a prank.
        tokenIn = new FaucetToken("Test PulseX", "tPLSX", 18, DRIP_IN, COOLDOWN, address(this));
        tokenOut = new FaucetToken("Test USD Coin", "tUSDC", 6, 1_000e6, COOLDOWN, address(this));

        tokenIn.mint(maker, 1_000_000e18);
        tokenOut.mint(executor, 1_000_000e6);

        vm.prank(executor);
        tokenOut.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _intent() internal view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenIn),
            tokenOut: address(tokenOut),
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

    /// @dev The 3009 nonce is the intent hash, so one authorization funds one intent and nothing
    ///      else. This is the shape the app and the executor bot both produce.
    function _authorize(FaucetToken token, uint256 value, bytes32 intentHash)
        internal
        view
        returns (ProveSettlement.Authorization memory a)
    {
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        a.nonce = intentHash;
        // The settlement redeems through `receiveWithAuthorization`, so this signs that
        // typehash. `_authDigest` stays on the Transfer variant, which the token's own tests
        // drive directly.
        bytes32 digest = _receiveDigest(
            token, maker, address(settlement), value, a.validAfter, a.validBefore, a.nonce
        );
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(makerKey, digest);
        a.signature = abi.encodePacked(ar, as_, av);
    }

    function _receiveDigest(
        FaucetToken token,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    function _authDigest(
        FaucetToken token,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                token.TRANSFER_WITH_AUTHORIZATION_TYPEHASH(),
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
    }

    // ── The gasless fill, end to end ─────────────────────────────────────────

    function test_GaslessFillNeedsNoMakerTransaction() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);

        ProveSettlement.Authorization memory a = _authorize(tokenIn, AMOUNT_IN, h);
        TakePoints.Quote memory q_fee = settlement.quote(i, AMOUNT_IN, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;

        // The maker holds no allowance and has sent no transaction of any kind.
        assertEq(tokenIn.allowance(maker, address(settlement)), 0, "no allowance");
        assertFalse(tokenIn.authorizationState(maker, h), "authorization unspent");

        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, a, ANY_FEE);

        assertEq(tokenIn.balanceOf(executor), AMOUNT_IN, "executor took token A");
        assertEq(tokenOut.balanceOf(maker), delivered, "maker paid the signed rate");
        assertEq(delivered, NET_OUT, "at six decimals, to the wei");
        assertEq(
            settlement.pendingFees(feeCfg(sink), address(tokenOut)),
            fee,
            "fee was booked to the sink"
        );
        assertEq(settlement.reserved(h), 0, "escrow drained");
        assertTrue(tokenIn.authorizationState(maker, h), "authorization spent");
    }

    function test_GaslessFillRedeemsOnceAcrossPartialFills() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);
        ProveSettlement.Authorization memory a =
            _authorize(tokenIn, AMOUNT_IN, settlement.hashIntent(i));

        vm.startPrank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN / 4, a, ANY_FEE);
        // The second call must not redeem again: the token would refuse the spent nonce.
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN - AMOUNT_IN / 4, a, ANY_FEE);
        vm.stopPrank();

        assertEq(tokenIn.balanceOf(executor), AMOUNT_IN);
        assertEq(tokenOut.balanceOf(maker), NET_OUT);
    }

    /// @notice A cancelled authorization cannot fund a fill, even with a valid intent signature.
    function test_GaslessFillFailsOnceTheMakerCancels() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);
        ProveSettlement.Authorization memory a = _authorize(tokenIn, AMOUNT_IN, h);

        _cancel(h);

        // The intent is alive, so the pre-flight lets this through and the token is what refuses
        // the spent nonce. A single fill carries that error out rather than swallowing it.
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(FaucetToken.AuthorizationUsedUp.selector, maker, h));
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, a, ANY_FEE);

        assertEq(settlement.reserved(h), 0, "and nothing was escrowed on the way past");
    }

    /**
     * @notice A contract wallet fills gaslessly against the real token, through ERC-7598.
     *
     * The wallet holds no key, so its authorization is an ERC-1271 answer and not a `v, r, s`
     * triple. Under EIP-3009 alone there was nowhere to put one: the struct was 65 fixed bytes
     * and the token's only overload ran `ecrecover`. This signs compactly, at 64 bytes, so the
     * settlement cannot mistake it for a triple and goes straight to the `bytes` overload.
     */
    function test_AContractWalletFillsGaslesslyThroughTheRealToken() public {
        SmartWallet wallet = new SmartWallet(maker);

        ProveSettlement.Intent memory i = _intent();
        i.maker = address(wallet);
        i.recipient = address(wallet);
        i.flags = settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);

        // This contract owns both tokens, so no prank is needed to seed the wallet.
        tokenIn.mint(address(wallet), AMOUNT_IN);

        ProveSettlement.Authorization memory a;
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        a.nonce = h;
        bytes32 digest = _receiveDigest(
            tokenIn, address(wallet), address(settlement), AMOUNT_IN, a.validAfter, a.validBefore, h
        );
        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(makerKey, digest);
        // EIP-2098 compact form: the parity rides in the top bit of `s`.
        a.signature =
            abi.encodePacked(ar, av == 28 ? bytes32(uint256(as_) | (uint256(1) << 255)) : as_);
        assertEq(a.signature.length, 64, "nothing that could be read as v, r, s");

        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, a, ANY_FEE);

        assertEq(tokenIn.balanceOf(executor), AMOUNT_IN, "the executor took token A");
        assertGt(tokenOut.balanceOf(address(wallet)), 0, "and the wallet was paid");
        assertTrue(tokenIn.authorizationState(address(wallet), h), "the authorization is spent");
    }

    /// @dev Rounding at six decimals still favours the maker: one wei in never pays zero out.
    function test_SmallestFillStillPaysTheMaker() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        vm.prank(maker);
        tokenIn.approve(relayer, type(uint256).max);

        vm.prank(executor);
        settlement.fill(i, sig, 1, ANY_FEE);

        assertEq(tokenOut.balanceOf(maker), 1, "rounded up, not down");
    }

    // ── The faucet ───────────────────────────────────────────────────────────

    function test_ClaimPaysTheDripAndArmsTheCooldown() public {
        vm.prank(stranger);
        vm.expectEmit(true, false, false, true, address(tokenIn));
        emit FaucetToken.Claimed(stranger, DRIP_IN, uint64(block.timestamp) + COOLDOWN);
        uint256 amount = tokenIn.claim();

        assertEq(amount, DRIP_IN);
        assertEq(tokenIn.balanceOf(stranger), DRIP_IN);
        assertEq(tokenIn.nextClaimAt(stranger), uint64(block.timestamp) + COOLDOWN);
    }

    function test_ClaimRefusesInsideTheCooldown() public {
        vm.startPrank(stranger);
        tokenIn.claim();
        uint64 readyAt = uint64(block.timestamp) + COOLDOWN;

        vm.warp(block.timestamp + COOLDOWN - 1);
        vm.expectRevert(abi.encodeWithSelector(FaucetToken.CooldownActive.selector, readyAt));
        tokenIn.claim();
        vm.stopPrank();

        assertEq(tokenIn.balanceOf(stranger), DRIP_IN, "one drip, not two");
    }

    function test_ClaimWorksAgainOnceTheCooldownPasses() public {
        vm.startPrank(stranger);
        tokenIn.claim();
        vm.warp(block.timestamp + COOLDOWN);
        tokenIn.claim();
        vm.stopPrank();

        assertEq(tokenIn.balanceOf(stranger), 2 * DRIP_IN);
    }

    /// @notice The cooldown is per address, so one account cannot drain the faucet in a loop.
    function test_CooldownIsPerAddress() public {
        vm.prank(stranger);
        tokenIn.claim();
        vm.prank(executor);
        tokenIn.claim();

        assertEq(tokenIn.balanceOf(stranger), DRIP_IN);
        assertEq(tokenIn.balanceOf(executor), DRIP_IN);
    }

    function test_MintIsOwnerOnly() public {
        vm.prank(stranger);
        vm.expectRevert(FaucetToken.NotOwner.selector);
        tokenIn.mint(stranger, 1e18);
    }

    function test_ConstructorRefusesNonsense() public {
        vm.expectRevert(FaucetToken.BadParameter.selector);
        new FaucetToken("Zero Owner", "ZO", 18, DRIP_IN, COOLDOWN, address(0));

        vm.expectRevert(FaucetToken.BadParameter.selector);
        new FaucetToken("Zero Drip", "ZD", 18, 0, COOLDOWN, address(this));
    }

    function test_DecimalsAreWhatTheConstructorSaid() public view {
        assertEq(tokenIn.decimals(), 18);
        assertEq(tokenOut.decimals(), 6);
    }

    // ── EIP-2612 ─────────────────────────────────────────────────────────────

    function test_PermitApprovesBySignature() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(address(settlement), AMOUNT_IN, deadline, 0);

        // Anyone may submit it. The maker never appears as a sender.
        vm.prank(executor);
        tokenIn.permit(maker, address(settlement), AMOUNT_IN, deadline, v, r, s);

        assertEq(tokenIn.allowance(maker, address(settlement)), AMOUNT_IN);
        assertEq(tokenIn.nonces(maker), 1, "counter advanced");
    }

    function test_PermitRefusesAReplay() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(address(settlement), AMOUNT_IN, deadline, 0);
        tokenIn.permit(maker, address(settlement), AMOUNT_IN, deadline, v, r, s);

        // The counter moved, so the same signature now recovers to the wrong address.
        vm.expectRevert(FaucetToken.BadSignature.selector);
        tokenIn.permit(maker, address(settlement), AMOUNT_IN, deadline, v, r, s);
    }

    function test_PermitRefusesAfterTheDeadline() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(address(settlement), AMOUNT_IN, deadline, 0);

        vm.warp(deadline + 1);
        vm.expectRevert(abi.encodeWithSelector(FaucetToken.PermitExpired.selector, deadline));
        tokenIn.permit(maker, address(settlement), AMOUNT_IN, deadline, v, r, s);
    }

    /// @notice A permit signed for one token cannot be spent on another. The domain says which.
    function test_PermitIsBoundToItsToken() public {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(address(settlement), AMOUNT_IN, deadline, 0);

        vm.expectRevert(FaucetToken.BadSignature.selector);
        tokenOut.permit(maker, address(settlement), AMOUNT_IN, deadline, v, r, s);
    }

    function test_DomainSeparatorFollowsEIP712() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Test PulseX")),
                keccak256(bytes("1")),
                block.chainid,
                address(tokenIn)
            )
        );
        assertEq(tokenIn.DOMAIN_SEPARATOR(), expected);
    }

    function _signPermit(address spender, uint256 value, uint256 deadline, uint256 nonce)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(tokenIn.PERMIT_TYPEHASH(), maker, spender, value, nonce, deadline)
        );
        return vm.sign(
            makerKey,
            keccak256(abi.encodePacked("\x19\x01", tokenIn.DOMAIN_SEPARATOR(), structHash))
        );
    }

    // ── EIP-3009 ─────────────────────────────────────────────────────────────

    function test_AuthorizationMovesTheTokens() public {
        bytes32 nonce = keccak256("one");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            makerKey,
            _authDigest(tokenIn, maker, executor, 5e18, 0, block.timestamp + 1 days, nonce)
        );

        vm.prank(executor);
        vm.expectEmit(true, true, false, false, address(tokenIn));
        emit FaucetToken.AuthorizationUsed(maker, nonce);
        tokenIn.transferWithAuthorization(
            maker, executor, 5e18, 0, block.timestamp + 1 days, nonce, v, r, s
        );

        assertEq(tokenIn.balanceOf(executor), 5e18);
        assertTrue(tokenIn.authorizationState(maker, nonce));
    }

    function test_AuthorizationRefusesAReplay() public {
        bytes32 nonce = keccak256("two");
        uint256 validBefore = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(makerKey, _authDigest(tokenIn, maker, executor, 5e18, 0, validBefore, nonce));

        tokenIn.transferWithAuthorization(maker, executor, 5e18, 0, validBefore, nonce, v, r, s);
        vm.expectRevert(
            abi.encodeWithSelector(FaucetToken.AuthorizationUsedUp.selector, maker, nonce)
        );
        tokenIn.transferWithAuthorization(maker, executor, 5e18, 0, validBefore, nonce, v, r, s);
    }

    /**
     * @notice The authorization a maker signs for prove.cash cannot be relayed by anybody else.
     *
     * `transferWithAuthorization` is a permissionless relay: the signature names the recipient, so
     * whoever holds a copy can submit it and the recipient's code never runs. The settlement
     * credits `_reserved[h]` when the money lands, so a push that skipped it would leave the
     * tokens sitting in the contract attributed to nothing — `withdraw` refuses an empty
     * reservation, the nonce is spent, and the maker has lost the lot for the price of an
     * attacker's gas. The board hands signed intents to anyone who asks, so the copy is not hard
     * to come by.
     *
     * Signing the `Receive` typehash closes it: the two typehashes differ, so the relay cannot
     * verify what the maker signed for the settlement.
     */
    function test_AProveCashAuthorizationCannotBeRelayedByAStranger() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_ESCROW();
        bytes32 h = settlement.hashIntent(i);
        ProveSettlement.Authorization memory a = _authorize(tokenIn, AMOUNT_IN, h);

        (uint8 av, bytes32 ar, bytes32 as_) = vm.sign(
            makerKey,
            _receiveDigest(
                tokenIn, maker, address(settlement), AMOUNT_IN, a.validAfter, a.validBefore, h
            )
        );

        address stranger = makeAddr("relayer-stranger");
        vm.prank(stranger);
        vm.expectRevert(FaucetToken.BadSignature.selector);
        tokenIn.transferWithAuthorization(
            maker, address(settlement), AMOUNT_IN, a.validAfter, a.validBefore, h, av, ar, as_
        );

        assertEq(tokenIn.balanceOf(address(settlement)), 0, "nothing was pushed in");
        assertFalse(tokenIn.authorizationState(maker, h), "and the nonce is still the maker's");
    }

    function test_AuthorizationRefusesBeforeItsWindow() public {
        bytes32 nonce = keccak256("three");
        uint256 validAfter = block.timestamp + 1 hours;
        uint256 validBefore = block.timestamp + 2 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            makerKey, _authDigest(tokenIn, maker, executor, 5e18, validAfter, validBefore, nonce)
        );

        vm.expectRevert(abi.encodeWithSelector(FaucetToken.NotYetValid.selector, validAfter));
        tokenIn.transferWithAuthorization(
            maker, executor, 5e18, validAfter, validBefore, nonce, v, r, s
        );

        // One second past `validAfter` it goes through: the window is exclusive at that end.
        vm.warp(validAfter + 1);
        tokenIn.transferWithAuthorization(
            maker, executor, 5e18, validAfter, validBefore, nonce, v, r, s
        );
        assertEq(tokenIn.balanceOf(executor), 5e18);
    }

    function test_AuthorizationRefusesAfterItsWindow() public {
        bytes32 nonce = keccak256("four");
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(makerKey, _authDigest(tokenIn, maker, executor, 5e18, 0, validBefore, nonce));

        vm.warp(validBefore);
        vm.expectRevert(
            abi.encodeWithSelector(FaucetToken.AuthorizationExpired.selector, validBefore)
        );
        tokenIn.transferWithAuthorization(maker, executor, 5e18, 0, validBefore, nonce, v, r, s);
    }

    function test_AuthorizationRefusesAForgedSignature() public {
        bytes32 nonce = keccak256("five");
        (, uint256 otherKey) = makeAddrAndKey("thief");
        bytes32 digest =
            _authDigest(tokenIn, maker, executor, 5e18, 0, block.timestamp + 1 days, nonce);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(otherKey, digest);

        vm.expectRevert(FaucetToken.BadSignature.selector);
        tokenIn.transferWithAuthorization(
            maker, executor, 5e18, 0, block.timestamp + 1 days, nonce, v, r, s
        );
    }

    function test_CancelAuthorizationBurnsTheNonce() public {
        bytes32 nonce = keccak256("six");
        uint256 validBefore = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(makerKey, _authDigest(tokenIn, maker, executor, 5e18, 0, validBefore, nonce));

        vm.expectEmit(true, true, false, false, address(tokenIn));
        emit FaucetToken.AuthorizationCanceled(maker, nonce);
        _cancel(nonce);

        assertTrue(tokenIn.authorizationState(maker, nonce), "nonce spent by the cancel");
        vm.expectRevert(
            abi.encodeWithSelector(FaucetToken.AuthorizationUsedUp.selector, maker, nonce)
        );
        tokenIn.transferWithAuthorization(maker, executor, 5e18, 0, validBefore, nonce, v, r, s);
    }

    function test_CancelAuthorizationRefusesAStranger() public {
        bytes32 nonce = keccak256("seven");
        (, uint256 otherKey) = makeAddrAndKey("thief");
        bytes32 structHash =
            keccak256(abi.encode(tokenIn.CANCEL_AUTHORIZATION_TYPEHASH(), maker, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            otherKey,
            keccak256(abi.encodePacked("\x19\x01", tokenIn.DOMAIN_SEPARATOR(), structHash))
        );

        vm.expectRevert(FaucetToken.BadSignature.selector);
        tokenIn.cancelAuthorization(maker, nonce, v, r, s);
    }

    function test_ReceiveWithAuthorizationOnlyAnswersToThePayee() public {
        bytes32 nonce = keccak256("eight");
        uint256 validBefore = block.timestamp + 1 days;
        bytes32 structHash = keccak256(
            abi.encode(
                tokenIn.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                maker,
                executor,
                5e18,
                0,
                validBefore,
                nonce
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            makerKey,
            keccak256(abi.encodePacked("\x19\x01", tokenIn.DOMAIN_SEPARATOR(), structHash))
        );

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(FaucetToken.WrongCaller.selector, executor));
        tokenIn.receiveWithAuthorization(maker, executor, 5e18, 0, validBefore, nonce, v, r, s);

        vm.prank(executor);
        tokenIn.receiveWithAuthorization(maker, executor, 5e18, 0, validBefore, nonce, v, r, s);
        assertEq(tokenIn.balanceOf(executor), 5e18);
    }

    function _cancel(bytes32 nonce) internal {
        bytes32 structHash =
            keccak256(abi.encode(tokenIn.CANCEL_AUTHORIZATION_TYPEHASH(), maker, nonce));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            makerKey,
            keccak256(abi.encodePacked("\x19\x01", tokenIn.DOMAIN_SEPARATOR(), structHash))
        );
        tokenIn.cancelAuthorization(maker, nonce, v, r, s);
    }

    // ── The misbehaving token ────────────────────────────────────────────────

    /// @notice A tax on the proceeds must fail the fill. The contract promises the maker an amount
    ///         received, so shorting them quietly is the one outcome it may not produce.
    function test_FillRevertsAgainstAFeeOnTransferToken() public {
        WeirdToken weird = new WeirdToken("Weird", "WRD", 18);
        weird.setFeeBps(100);
        weird.mint(executor, 1_000_000e18);
        vm.prank(executor);
        weird.approve(relayer, type(uint256).max);
        vm.prank(maker);
        tokenIn.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent();
        i.tokenOut = address(weird);
        i.minOutStart = 3_000e18;
        i.minOutEnd = 3_000e18;
        bytes memory sig = _sign(i);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.Underpaid.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(weird.balanceOf(maker), 0, "the maker keeps nothing rather than too little");
        assertEq(tokenIn.balanceOf(maker), 1_000_000e18, "and still holds token A");
    }

    /// @notice A token that answers with no boolean still settles. SafeERC20 reads the absence of
    ///         a revert, not the absence of a return value, which is what USDT taught everyone.
    function test_FillWorksAgainstASilentToken() public {
        WeirdToken weird = new WeirdToken("Silent", "SIL", 18);
        weird.setSilent(true);
        weird.mint(executor, 1_000_000e18);
        vm.prank(executor);
        weird.approve(relayer, type(uint256).max);
        vm.prank(maker);
        tokenIn.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent();
        i.tokenOut = address(weird);
        i.minOutStart = 3_000e18;
        i.minOutEnd = 3_000e18;
        bytes memory sig = _sign(i);
        uint256 delivered = settlement.quote(i, AMOUNT_IN, block.timestamp).delivered;

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(weird.balanceOf(maker), delivered);
    }

    function test_BlocklistStopsTheFill() public {
        WeirdToken weird = new WeirdToken("Gated", "GTD", 18);
        weird.mint(executor, 1_000_000e18);
        weird.setBlocked(maker, true);
        vm.prank(executor);
        weird.approve(relayer, type(uint256).max);
        vm.prank(maker);
        tokenIn.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent();
        i.tokenOut = address(weird);
        i.minOutStart = 3_000e18;
        i.minOutEnd = 3_000e18;
        bytes memory sig = _sign(i);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(WeirdToken.Blocked.selector, maker));
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    function test_WeirdTokenSwitchesAreAdminOnly() public {
        WeirdToken weird = new WeirdToken("Gated", "GTD", 6);
        assertEq(weird.decimals(), 6);

        vm.startPrank(stranger);
        vm.expectRevert(WeirdToken.NotAdmin.selector);
        weird.setFeeBps(1);
        vm.expectRevert(WeirdToken.NotAdmin.selector);
        weird.setSilent(true);
        vm.expectRevert(WeirdToken.NotAdmin.selector);
        weird.setBlocked(stranger, true);
        vm.stopPrank();

        vm.expectRevert(WeirdToken.BadParameter.selector);
        weird.setFeeBps(10_001);
    }

    /// @dev The tax burns, so the supply falls by exactly what the recipient did not receive.
    function test_WeirdTokenTaxBurnsTheDifference() public {
        WeirdToken weird = new WeirdToken("Weird", "WRD", 18);
        weird.setFeeBps(250);
        weird.mint(address(this), 1_000e18);

        weird.transfer(stranger, 1_000e18);

        assertEq(weird.balanceOf(stranger), 975e18);
        assertEq(weird.totalSupply(), 975e18);
    }
}
