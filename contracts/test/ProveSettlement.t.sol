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
import {IProveCallback} from "../src/interfaces/IProveCallback.sol";
import {
    ANY_FEE,
    DonatingExecutor,
    MockERC20,
    MockERC3009,
    MockERC7598Wallet,
    MockRouter,
    MumblingWallet,
    NO_PERMIT2,
    PayingExecutor,
    Recorder,
    ReentrantExecutor,
    ReentryProbe,
    RevertingWallet,
    RoutingExecutor,
    SinkStiffingExecutor,
    SmartWallet,
    UnderpayingExecutor
} from "./Mocks.sol";

contract ProveSettlementTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address owner = address(0xB0B);
    /// @dev Where the fixture's intents send their fee. The intent names it and nothing else can.
    address feeDest = address(0x5152);
    /// @dev And where an unattributed token goes. A different address on purpose: the two are
    ///      unrelated, and a fixture that shared one could not tell a fee paid to the destination
    ///      the intent named from a fee paid to the address the owner set.
    address proceeds = address(0xD0D);
    address executor = address(0xE0E);
    address attacker = address(0xBAD);
    address maker;
    uint256 makerKey;

    uint256 constant AMOUNT_IN = 100_000e18;
    uint256 constant MIN_OUT = 3_000e18;
    /// @dev Ten basis points, signed into every fixture intent. The rate is the intent's own and
    ///      there is no other source for one.
    uint64 constant FEE_RATE = 0.001e18;
    /// @dev What the maker keeps out of a gross of `MIN_OUT`. The fee comes out of the number
    ///      the maker signed, so the curve's figure is the executor's outlay and this is the
    ///      maker's receipt. It divides exactly here, so no assertion below is about rounding.
    uint256 constant NET_OUT = MIN_OUT - (MIN_OUT * FEE_RATE) / 1e18;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        tokenA = new MockERC20("Token A", "A", 18);
        tokenB = new MockERC20("Token B", "B", 18);

        tokenA.mint(maker, 1_000_000e18);
        tokenB.mint(executor, 1_000_000e18);

        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
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
            feeConfig: feeCfg(feeDest),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: FEE_RATE,
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

    // ── The digest ───────────────────────────────────────────────────────────

    /**
     * @notice The contract hashes the whole `Intent` struct in one go. This holds that against
     *         the field-by-field EIP-712 encoding it replaced.
     *
     * Every member of `Intent` is a static type, so ABI encoding the struct lays the members
     * down as seventeen 32-byte words in declaration order — the same bytes the field-by-field
     * version produced. The contract cannot spell it out itself: that many values in one encoder
     * call is more than the legacy pipeline can reach, and that is what forced coverage through
     * `--ir-minimum`. The reference below is written in four chunks for the same reason.
     *
     * This is the tripwire for the struct changing. It fired when `feeTo` was added, again when
     * `feeRate` was, and again when `curve` was, which is the whole point: a field that reaches the wire without
     * reaching the typehash produces signatures the contract will not accept, and nothing else
     * in the suite would say so.
     */
    function test_TheStructHashIsTheFieldByFieldEncoding() public view {
        ProveSettlement.Intent memory i = _intent();

        bytes memory encoded = bytes.concat(
            abi.encode(settlement.INTENT_TYPEHASH(), i.maker, i.recipient, i.tokenIn),
            abi.encode(i.tokenOut, i.amountIn, i.minOutStart, i.minOutEnd),
            abi.encode(i.startTime, i.endTime, i.executor, i.feeConfig),
            abi.encode(i.feeRate, i.minFill, i.authNonce, i.flags, i.nonce),
            abi.encode(i.curve, i.feeRateIn, i.feeRateProceeds)
        );
        assertEq(encoded.length, 20 * 32, "twenty words, the typehash and nineteen fields");

        bytes32 expected = keccak256(
            abi.encodePacked(hex"1901", settlement.domainSeparator(), keccak256(encoded))
        );
        assertEq(settlement.hashIntent(i), expected, "the digest is unchanged");
    }

    /**
     * @dev The typehash string, stated a second time, because the first statement cannot defend
     *      itself.
     *
     * A mutation found this. Drop `,bytes32 curve` from `INTENT_TYPEHASH` and leave the member on
     * the struct, and **no forge test fails.** The contract hashes its own constant, so Solidity
     * stays perfectly self-consistent — and `test_TheStructHashIsTheFieldByFieldEncoding` above
     * cannot catch it either, because it reads that same constant. Every wallet on earth would
     * then compute a different digest from the one the contract verifies, and every signature
     * would be refused.
     *
     * Two layers out, CI does catch it: the fixture's digest moves and the TypeScript suite fails
     * against its own copy of the string. But a Solidity change that only a TypeScript test can
     * see is a change somebody lands on a red build they blame on the app.
     *
     * So the string is written here in full, once more, by hand. The duplication is the point: a
     * fact stated twice from two places is a fact a single edit cannot quietly move. Change the
     * struct and you must change both, and this line is where you find out.
     *
     * This is not a curve rule. It has always been true of every member.
     */
    function test_TheTypehashStringIsTheOneEveryWalletWillHash() public view {
        assertEq(
            settlement.INTENT_TYPEHASH(),
            keccak256(
                "Intent(address maker,address recipient,address tokenIn,address tokenOut,uint256 amountIn,uint256 minOutStart,uint256 minOutEnd,uint64 startTime,uint64 endTime,address executor,FeeConfig feeConfig,uint64 feeRate,uint256 minFill,bytes32 authNonce,uint8 flags,uint256 nonce,bytes32 curve,uint64 feeRateIn,uint64 feeRateProceeds)FeeConfig(address[] destinations,uint256[] weights)"
            ),
            "the typehash hashes the nineteen fields, in this order, spelled this way"
        );
    }

    // ── The rate the maker signed ────────────────────────────────────────────

    function test_FullFillPaysExactlyTheSignedRate() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);

        uint256 makerBefore = tokenB.balanceOf(maker);
        TakePoints.Quote memory q_fee = settlement.quote(i, AMOUNT_IN, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(delivered, NET_OUT, "maker receives the signed minimum, less the fee");
        assertEq(delivered + fee, MIN_OUT, "and the two halves are the signed minimum exactly");
        assertEq(tokenB.balanceOf(maker) - makerBefore, NET_OUT, "maker paid in full");
        assertEq(tokenA.balanceOf(executor), AMOUNT_IN, "executor took token A");
        // Booked, not transferred. The fill charges the executor and credits the destination's
        // row; nothing moves to the destination until somebody calls `claim`, and anybody may.
        assertEq(
            settlement.pendingFees(feeCfg(feeDest), address(tokenB)),
            fee,
            "the fee was booked to the address the intent named"
        );
        assertEq(tokenB.balanceOf(feeDest), 0, "and no token reached it during the fill");
        assertEq(claimFor(settlement, feeDest, address(tokenB)), fee, "and the money can get out");
        assertEq(tokenB.balanceOf(feeDest), fee, "to the address the intent named, in full");
        assertEq(settlement.filled(settlement.hashIntent(i)), AMOUNT_IN);
    }

    /// @notice The fee is carved out of the delivery, and the rate is the whole of it. The
    ///         executor pays the gross whatever the rate says, so the rate is invisible to them
    ///         and visible to the maker.
    ///
    ///         This was `test_FeeIsChargedOnTopOfTheDelivery`, which was true until the fee moved
    ///         inside the maker's number.
    function test_TheFeeIsCarvedOutOfTheDelivery() public {
        ProveSettlement.Intent memory i = _intent();
        TakePoints.Quote memory q_fee = settlement.quote(i, AMOUNT_IN, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;

        // Ten basis points of the gross, and the maker keeps the rest.
        assertEq(fee, (MIN_OUT * FEE_RATE) / settlement.WAD());
        assertEq(delivered, MIN_OUT - fee);

        bytes memory sig = _sign(i, makerKey);
        uint256 executorBefore = tokenB.balanceOf(executor);
        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
        assertEq(
            executorBefore - tokenB.balanceOf(executor), MIN_OUT, "the executor pays the gross"
        );
    }

    function test_RoundingFavoursTheMaker() public view {
        ProveSettlement.Intent memory i = _intent();
        // A take that does not divide evenly must round the gross up, and the fee down. Both
        // directions hand the odd wei to the maker.
        uint256 take = 3;
        TakePoints.Quote memory q_fee = settlement.quote(i, take, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertGe((delivered + fee) * AMOUNT_IN, take * MIN_OUT, "never short by a wei");
        assertEq(fee, ((delivered + fee) * FEE_RATE) / settlement.WAD(), "the fee rounds down");
    }

    // ── Partial fills ────────────────────────────────────────────────────────

    function test_PartialFillsAccumulate() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);

        vm.startPrank(executor);
        settlement.fill(i, sig, AMOUNT_IN / 4, ANY_FEE);
        settlement.fill(i, sig, AMOUNT_IN / 4, ANY_FEE);
        vm.stopPrank();

        assertEq(settlement.filled(settlement.hashIntent(i)), AMOUNT_IN / 2);
        assertEq(tokenB.balanceOf(maker), NET_OUT / 2, "half the proceeds for half the order");

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.TooMuch.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    function test_AllOrNothingRejectsAPartialTake() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = 0;
        bytes memory sig = _sign(i, makerKey);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.PartialNotAllowed.selector);
        settlement.fill(i, sig, AMOUNT_IN / 2, ANY_FEE);

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
        assertEq(tokenB.balanceOf(maker), NET_OUT);
    }

    // ── Dutch decay ──────────────────────────────────────────────────────────

    function test_DutchDecayWalksFromStartToEnd() public {
        ProveSettlement.Intent memory i = _intent();
        i.minOutEnd = MIN_OUT / 2;
        uint256 start = i.startTime;

        assertEq(settlement.minOutAt(i, start), MIN_OUT, "no decay at the start");
        assertEq(
            settlement.minOutAt(i, start + 1800), MIN_OUT - MIN_OUT / 4, "half way, half decayed"
        );
        assertEq(settlement.minOutAt(i, i.endTime), MIN_OUT / 2, "floor at expiry");
        assertEq(settlement.minOutAt(i, i.endTime + 1 days), MIN_OUT / 2, "never below the floor");

        bytes memory sig = _sign(i, makerKey);
        vm.warp(start + 1800);
        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
        // Half way down the curve the gross is three quarters of the start, and the maker keeps
        // that less the fee.
        uint256 gross = MIN_OUT - MIN_OUT / 4;
        assertEq(tokenB.balanceOf(maker), gross - (gross * FEE_RATE) / settlement.WAD());
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    function test_RejectsBeforeStartAndAfterExpiry() public {
        ProveSettlement.Intent memory i = _intent();
        i.startTime = uint64(block.timestamp + 100);
        i.endTime = uint64(block.timestamp + 200);
        bytes memory sig = _sign(i, makerKey);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.NotStarted.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        vm.warp(i.endTime);
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.Expired.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    function test_CancelStopsAFill() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);

        vm.prank(maker);
        settlement.cancel(i);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.IsCancelled.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    function test_OnlyTheMakerCancels() public {
        ProveSettlement.Intent memory i = _intent();
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.NotMaker.selector);
        settlement.cancel(i);
    }

    function test_InvalidateBeforeKillsAWholeRange() public {
        ProveSettlement.Intent memory i = _intent();
        i.nonce = 41;
        bytes memory sig = _sign(i, makerKey);

        vm.prank(maker);
        settlement.invalidateBefore(42);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.NonceTooLow.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    function test_RejectsAForgedSignature() public {
        (, uint256 strangerKey) = makeAddrAndKey("stranger");
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, strangerKey);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadSignature.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    function test_RejectsATamperedRate() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);
        i.minOutStart = 1; // executor tries to pay a wei
        i.minOutEnd = 1;

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadSignature.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    function test_PinnedExecutorLocksOthersOut() public {
        ProveSettlement.Intent memory i = _intent();
        i.executor = address(0xDEAD);
        bytes memory sig = _sign(i, makerKey);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.WrongExecutor.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    function test_ContractMakerSignsThroughErc1271() public {
        SmartWallet wallet = new SmartWallet(maker);
        tokenA.mint(address(wallet), AMOUNT_IN);
        wallet.approveToken(address(tokenA), relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent();
        i.maker = address(wallet);
        i.recipient = address(wallet);

        bytes memory sig = _sign(i, makerKey);
        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
        assertEq(tokenB.balanceOf(address(wallet)), NET_OUT);
    }

    /// @notice A contract wallet must work everywhere an EOA works. The view, the batch and the
    ///         callback fill each reach the ERC-1271 check by their own route.
    function test_AContractWalletFillsThroughTheBatchAndTheCallback() public {
        SmartWallet wallet = new SmartWallet(maker);
        tokenA.mint(address(wallet), 2 * AMOUNT_IN);
        wallet.approveToken(address(tokenA), relayer, type(uint256).max);

        ProveSettlement.Intent memory batched = _intent();
        batched.maker = address(wallet);
        batched.recipient = address(wallet);
        batched.nonce = 31;
        bytes memory batchedSig = _sign(batched, makerKey);

        assertEq(
            uint256(settlement.fillability(batched, batchedSig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "the view accepts the wallet"
        );

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = ProveSettlement.FillRequest({
            intent: batched, signature: batchedSig, take: AMOUNT_IN, arming: ""
        });
        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 1, "the batch fills it");

        ProveSettlement.Intent memory viaCallback = _intent();
        viaCallback.maker = address(wallet);
        viaCallback.recipient = address(wallet);
        viaCallback.nonce = 32;
        bytes memory callbackSig = _sign(viaCallback, makerKey);

        PayingExecutor bot = new PayingExecutor();
        tokenB.mint(address(bot), 1_000_000e18);
        bot.approveMax(address(tokenB), relayer);

        bot.settle(settlement, viaCallback, callbackSig, AMOUNT_IN, "", ANY_FEE);

        assertEq(tokenB.balanceOf(address(wallet)), 2 * NET_OUT, "paid on both routes");
    }

    /// @notice A contract maker that cannot answer is a bad signature, never a revert. One wallet
    ///         throws, the other returns four bytes where a word belongs.
    function test_AContractMakerThatCannotAnswerIsJustABadSignature() public {
        RevertingWallet reverter = new RevertingWallet();
        MumblingWallet mumbler = new MumblingWallet();
        tokenA.mint(address(reverter), AMOUNT_IN);
        tokenA.mint(address(mumbler), AMOUNT_IN);
        reverter.approveToken(address(tokenA), relayer, type(uint256).max);
        mumbler.approveToken(address(tokenA), relayer, type(uint256).max);

        ProveSettlement.Intent memory thrower = _intent();
        thrower.maker = address(reverter);
        thrower.recipient = address(reverter);
        bytes memory throwerSig = _sign(thrower, makerKey);

        ProveSettlement.Intent memory mumble = _intent();
        mumble.maker = address(mumbler);
        mumble.recipient = address(mumbler);
        bytes memory mumbleSig = _sign(mumble, makerKey);

        // The view answers for both, which is what stops one hostile maker killing a batch.
        assertEq(
            uint256(settlement.fillability(thrower, throwerSig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.BadSignature)
        );
        assertEq(
            uint256(settlement.fillability(mumble, mumbleSig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.BadSignature)
        );

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadSignature.selector);
        settlement.fill(thrower, throwerSig, AMOUNT_IN, ANY_FEE);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadSignature.selector);
        settlement.fill(mumble, mumbleSig, AMOUNT_IN, ANY_FEE);
    }

    // ── Escrow ───────────────────────────────────────────────────────────────

    function test_EscrowFillSpendsTheDeposit() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes32 h = settlement.hashIntent(i);

        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);
        assertEq(settlement.reserved(h), AMOUNT_IN);

        // Prove it is really spending escrow, not the wallet.
        bytes memory sig = _sign(i, makerKey);
        vm.prank(maker);
        tokenA.approve(relayer, 0);

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(settlement.reserved(h), 0);
        assertEq(tokenA.balanceOf(executor), AMOUNT_IN);
        assertEq(tokenB.balanceOf(maker), NET_OUT);
    }

    function test_EscrowFillRevertsWhenTheDepositIsShort() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i, makerKey);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    function test_EscrowIsCommittedToOneIntentOnly() public {
        ProveSettlement.Intent memory funded = _intent();
        funded.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();

        vm.prank(maker);
        settlement.deposit(funded, AMOUNT_IN);
        assertEq(settlement.reserved(settlement.hashIntent(funded)), AMOUNT_IN);

        // A second escrow intent from the same maker sees none of it.
        ProveSettlement.Intent memory other = _intent();
        other.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        other.nonce = 2;
        bytes memory otherSig = _sign(other, makerKey);

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fill(other, otherSig, 1, ANY_FEE);
    }

    // ── Gasless authorization ────────────────────────────────────────────────

    function test_AuthorizationFundsEscrowAndFillsWithNoMakerGas() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.tokenIn = address(auth);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i, makerKey);

        ProveSettlement.Authorization memory a =
            _authorization(auth, AMOUNT_IN, settlement.hashIntent(i));

        // The maker never sends a transaction and never approves anything.
        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, a, ANY_FEE);

        assertEq(auth.balanceOf(executor), AMOUNT_IN, "executor received token A");
        assertEq(tokenB.balanceOf(maker), NET_OUT, "maker received the signed rate");
        assertEq(settlement.reserved(settlement.hashIntent(i)), 0);
    }

    function test_AuthorizationRedeemsOnceAcrossPartialFills() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.tokenIn = address(auth);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i, makerKey);
        ProveSettlement.Authorization memory a =
            _authorization(auth, AMOUNT_IN, settlement.hashIntent(i));

        vm.startPrank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN / 2, a, ANY_FEE);
        // The second fill must not try to redeem the same authorization again.
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN / 2, a, ANY_FEE);
        vm.stopPrank();

        assertEq(auth.balanceOf(executor), AMOUNT_IN);
        assertEq(tokenB.balanceOf(maker), NET_OUT);
    }

    /**
     * @notice A smart account has no key, so both signatures it gives are ERC-1271 answers: one
     *         for the intent, one for the authorization that funds it.
     *
     * The authorization is 65 bytes, because the wallet's answer is a key's signature relayed —
     * so the settlement tries the EIP-3009 overload first and the token's `ecrecover` refuses
     * it, since the signer is a contract. ERC-7598 is what the fall-through reaches, and the
     * fill only works because it does.
     */
    function test_AContractWalletFillsGaslesslyThroughAnAuthorization() public {
        SmartWallet wallet = new SmartWallet(maker);
        MockERC7598Wallet auth = new MockERC7598Wallet();
        auth.mint(address(wallet), AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.maker = address(wallet);
        i.recipient = address(wallet);
        i.tokenIn = address(auth);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i, makerKey);

        ProveSettlement.Authorization memory a =
            _walletAuthorization(auth, address(wallet), AMOUNT_IN, settlement.hashIntent(i));
        assertEq(a.signature.length, 65, "the wallet relays a key's signature");

        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, a, ANY_FEE);

        assertEq(auth.balanceOf(executor), AMOUNT_IN, "executor received token A");
        assertEq(tokenB.balanceOf(address(wallet)), NET_OUT, "the wallet received the signed rate");
    }

    /**
     * @notice The same wallet, signing compactly. Sixty-four bytes cannot be a `v, r, s` triple,
     *         so the settlement goes straight to ERC-7598 and never tries the legacy overload.
     *
     * EIP-2098 is what makes this shape ordinary rather than contrived: a wallet that packs the
     * parity into `s` produces exactly 64 bytes, and under the old fixed-width `Authorization`
     * there was nowhere to put them.
     */
    function test_ACompactWalletSignatureGoesStraightToTheBytesOverload() public {
        SmartWallet wallet = new SmartWallet(maker);
        MockERC7598Wallet auth = new MockERC7598Wallet();
        auth.mint(address(wallet), AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.maker = address(wallet);
        i.recipient = address(wallet);
        i.tokenIn = address(auth);
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i, makerKey);

        ProveSettlement.Authorization memory a =
            _walletAuthorization(auth, address(wallet), AMOUNT_IN, settlement.hashIntent(i));
        // r and s with the parity folded into the top bit of s, which is EIP-2098's compact form.
        a.signature = _compact(a.signature);
        assertEq(a.signature.length, 64, "nothing that could be read as v, r, s");

        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN, a, ANY_FEE);

        assertEq(auth.balanceOf(executor), AMOUNT_IN, "executor received token A");
        assertEq(tokenB.balanceOf(address(wallet)), NET_OUT, "the wallet received the signed rate");
    }

    /// @dev A 65-byte signature as EIP-2098 writes it: `r`, then `s` carrying the parity bit.
    function _compact(bytes memory signature) private pure returns (bytes memory) {
        bytes32 r;
        bytes32 s;
        bytes32 word;
        (r, s, word) = abi.decode(bytes.concat(signature, bytes31(0)), (bytes32, bytes32, bytes32));
        bytes32 vs = uint8(word[0]) == 28 ? bytes32(uint256(s) | (uint256(1) << 255)) : s;
        return abi.encodePacked(r, vs);
    }

    function _walletAuthorization(
        MockERC7598Wallet auth,
        address from,
        uint256 value,
        bytes32 intentHash
    ) internal view returns (ProveSettlement.Authorization memory a) {
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        a.nonce = intentHash;
        bytes32 structHash = keccak256(
            abi.encode(
                auth.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                from,
                address(settlement),
                value,
                a.validAfter,
                a.validBefore,
                a.nonce
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", auth.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, digest);
        a.signature = abi.encodePacked(r, s, v);
    }

    function _authorization(MockERC3009 auth, uint256 value, bytes32 intentHash)
        internal
        view
        returns (ProveSettlement.Authorization memory a)
    {
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        // The 3009 nonce is the intent hash, so one authorization funds one intent.
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
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, digest);
        a.signature = abi.encodePacked(r, s, v);
    }

    // ── Callback fills ───────────────────────────────────────────────────────

    function test_CallbackFillNeedsNoInventory() public {
        MockRouter router = new MockRouter();
        // 100,000 A sells for 200,000 B; the maker wants 3,000.
        tokenB.mint(address(router), 1_000_000e18);
        RoutingExecutor bot = new RoutingExecutor(address(router), address(settlement));

        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);
        TakePoints.Quote memory q_fee = settlement.quote(i, AMOUNT_IN, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;

        assertEq(tokenB.balanceOf(address(bot)), 0, "the bot starts with nothing");

        bot.settle(settlement, i, sig, AMOUNT_IN, "", ANY_FEE);

        assertEq(tokenB.balanceOf(maker), delivered, "maker paid from the route");
        assertEq(
            settlement.pendingFees(feeCfg(feeDest), address(tokenB)),
            fee,
            "the fee destination booked from the route"
        );
        assertGt(tokenB.balanceOf(address(bot)), 0, "the spread is the bot's profit");
    }

    /**
     * @notice An executor that stands good for one wei less than it owes settles nothing.
     *
     * The contract pulls, so a short executor is refused by its own token rather than caught by
     * a post-condition. `Underpaid` no longer means "the executor came up short" — it means the
     * token taxed a transfer. `test_M3_ATaxedOutputTokenCannotUnderpayTheMaker` covers that.
     */
    function test_CallbackUnderpaymentReverts() public {
        UnderpayingExecutor bot = new UnderpayingExecutor();
        tokenB.mint(address(bot), 1_000_000e18);

        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);

        vm.expectRevert();
        bot.settle(settlement, i, sig, AMOUNT_IN, "", ANY_FEE);

        assertEq(tokenB.balanceOf(maker), 0, "the maker was paid nothing at all");
        assertEq(settlement.filled(settlement.hashIntent(i)), 0, "and the intent is untouched");
    }

    /// @notice The fee destination is pulled as surely as the maker. An executor that allows the
    ///         delivery and not the fee still fails the fill.
    function test_ACallbackThatStiffsTheSinkReverts() public {
        SinkStiffingExecutor bot = new SinkStiffingExecutor();
        tokenB.mint(address(bot), 1_000_000e18);

        ProveSettlement.Intent memory i = _intent();
        TakePoints.Quote memory q_fee = settlement.quote(i, AMOUNT_IN, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertGt(fee, 0, "this fill owes a fee");
        bytes memory sig = _sign(i, makerKey);

        vm.expectRevert();
        bot.settle(settlement, i, sig, AMOUNT_IN, abi.encode(delivered), ANY_FEE);

        assertEq(
            settlement.pendingFees(feeCfg(feeDest), address(tokenB)),
            0,
            "the destination was not stiffed, the fill was refused"
        );
        assertEq(tokenB.balanceOf(feeDest), 0, "and nothing reached it either");
    }

    /**
     * @notice A recipient that is also the fee destination is pulled twice, and both land.
     *
     * `SinkIsRecipient` used to refuse this fill. It had to: the old delta check could not tell
     * the delivery from the fee when one balance carried both. A directed pull does not have to
     * tell them apart, so the guard is gone and `fill` and `fillWithCallback` now agree.
     */
    function test_ARecipientThatIsTheFeeDestinationGetsBothTransfers() public {
        PayingExecutor bot = new PayingExecutor();
        tokenB.mint(address(bot), 1_000_000e18);
        bot.approveMax(address(tokenB), relayer);

        ProveSettlement.Intent memory i = _intent();
        i.recipient = feeDest;
        bytes memory sig = _sign(i, makerKey);
        TakePoints.Quote memory q_fee = settlement.quote(i, AMOUNT_IN, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertGt(fee, 0, "there is a fee to confuse the delivery with");

        bot.settle(settlement, i, sig, AMOUNT_IN, "", ANY_FEE);

        // The two are no longer one balance to confuse: the delivery is a transfer to the
        // recipient and the fee is a row in a book, so the test can name each of them.
        assertEq(tokenB.balanceOf(feeDest), delivered, "the delivery landed");
        assertEq(
            settlement.pendingFees(feeCfg(feeDest), address(tokenB)),
            fee,
            "and the fee was booked to it"
        );
    }

    /**
     * @notice A donation is not a payment.
     *
     * The callback gifts the recipient the whole delivery before the pull. Under a balance delta
     * that discharged the debt and the executor paid nothing. Under a pull the recipient ends up
     * with the gift and the payment, and the executor is out both.
     */
    function test_ADonationDoesNotDischargeADebt() public {
        DonatingExecutor bot = new DonatingExecutor();
        tokenB.mint(address(bot), 1_000_000e18);
        bot.approveMax(address(tokenB), relayer);

        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);
        uint256 delivered = settlement.quote(i, AMOUNT_IN, block.timestamp).delivered;

        bot.settle(settlement, i, sig, AMOUNT_IN, abi.encode(maker, delivered), ANY_FEE);

        assertEq(tokenB.balanceOf(maker), 2 * delivered, "the gift and the payment both landed");
    }

    function test_CallbackCannotReenter() public {
        ReentrantExecutor bot = new ReentrantExecutor(settlement);
        tokenB.mint(address(bot), 1_000_000e18);
        bot.approveMax(address(tokenB), relayer);

        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);

        vm.expectRevert(ProveSettlement.Reentrant.selector);
        bot.settle(settlement, i, sig, AMOUNT_IN / 2, abi.encode(i, sig, AMOUNT_IN / 2), ANY_FEE);
    }

    /// @notice Every guarded entry point refuses a callback that comes back in, and the fill it
    ///         interrupted still finishes. The guard is one modifier with a copy in each door.
    function test_NoGuardedEntryPointCanBeReenteredFromACallback() public {
        ReentryProbe bot = new ReentryProbe(settlement);
        tokenB.mint(address(bot), 1_000_000e18);
        bot.approveMax(address(tokenB), relayer);

        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);
        uint256 delivered = settlement.quote(i, AMOUNT_IN, block.timestamp).delivered;

        bot.settle(settlement, i, sig, AMOUNT_IN, abi.encode(i, sig), ANY_FEE);

        assertEq(bot.refusals(), 5, "every door said Reentrant");
        assertEq(tokenB.balanceOf(maker), delivered, "and the interrupted fill still paid");
    }

    /**
     * @notice The one property that keeps this contract's allowances safe.
     *
     * `ProveSettlement` holds every maker's approval and every escrowed balance, and it calls an
     * address it did not choose. It is safe for exactly one reason: the calldata always opens
     * with the `proveCallback` selector, and the executor's `data` rides inside that frame as an
     * argument. Point the payload at a drain and the contract still says `proveCallback`.
     *
     * Do not add a call site that takes a selector, or a whole calldata blob, from a caller.
     */
    function test_TheFixedSelectorIsTheOnlyThingProtectingTheCallbackPath() public {
        Recorder rec = new Recorder();
        tokenB.mint(address(rec), 1_000_000e18);
        rec.approveMax(address(tokenB), relayer);

        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);

        // The payload an attacker would want the contract to speak: spend the maker's allowance
        // straight into the attacker's pocket.
        bytes memory drain =
            abi.encodeCall(IERC20.transferFrom, (maker, attacker, tokenA.balanceOf(maker)));

        vm.expectCall(address(rec), abi.encodePacked(IProveCallback.proveCallback.selector));
        rec.settle(settlement, i, sig, AMOUNT_IN, drain, ANY_FEE);

        assertEq(
            rec.lastSelector(),
            IProveCallback.proveCallback.selector,
            "the contract said the selector it chose, not the one it was handed"
        );
        assertEq(rec.lastData(), drain, "the payload arrived as an argument, never as a call");
        assertEq(tokenA.balanceOf(attacker), 0, "and the attacker got nothing");
    }

    // ── Where the fee goes ───────────────────────────────────────────────────

    /**
     * The fee is an interface fee, and these hold what that means.
     *
     * The intent names its destination and the maker signs it, so whoever builds the intent
     * directs the whole charge. There is no second party: prove.cash keeps none of it and has
     * no address of its own to keep it at. What none of this may change is the two amounts that
     * matter — the maker's proceeds and the executor's cost.
     */
    address constant BUY_AND_BURN = address(0xB0F);

    function test_AnIntentSendsItsFeeWhereItSays() public {
        ProveSettlement.Intent memory i = _intent();
        i.feeConfig = feeCfg(BUY_AND_BURN);
        bytes memory sig = _sign(i, makerKey);
        uint256 fee = settlement.quote(i, AMOUNT_IN, block.timestamp).feeProceeds;
        assertGt(fee, 0, "a fee worth routing");

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(
            settlement.pendingFees(feeCfg(BUY_AND_BURN), address(tokenB)),
            fee,
            "the named address is owed all of it"
        );
        assertEq(
            settlement.pendingFees(feeCfg(proceeds), address(tokenB)),
            0,
            "and the owner's address is owed none of it"
        );
        assertEq(tokenB.balanceOf(proceeds), 0, "nor was it paid any");
    }

    function test_NamingNothingChargesNothing() public {
        ProveSettlement.Intent memory i = _intent();
        i.feeConfig = bytes32(0);
        i.feeRateProceeds = 0;
        bytes memory sig = _sign(i, makerKey);
        TakePoints.Quote memory q_fee = settlement.quote(i, AMOUNT_IN, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertEq(fee, 0, "no rate, no fee");

        uint256 before = tokenB.balanceOf(executor);
        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(before - tokenB.balanceOf(executor), delivered, "the executor paid the delivery");
        assertEq(tokenB.balanceOf(proceeds), 0, "and nothing reached the owner's address");
    }

    /**
     * The destination is a signed term, so moving it invalidates the signature.
     */
    function test_TheDestinationCannotBeChangedAfterSigning() public {
        ProveSettlement.Intent memory i = _intent();
        i.feeConfig = feeCfg(BUY_AND_BURN);
        bytes memory sig = _sign(i, makerKey);

        // Even a registered sink cannot be swapped in. The signature is what stops it.
        i.feeConfig = feeCfg(attacker);
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadSignature.selector);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);
    }

    /**
     * Whoever is paid, the maker gets the same and the executor pays the same.
     */
    function test_TheDestinationChangesNeitherSideOfTheTrade() public {
        ProveSettlement.Intent memory a = _intent();
        a.nonce = 801;
        ProveSettlement.Intent memory b = _intent();
        b.nonce = 802;
        b.feeConfig = feeCfg(BUY_AND_BURN);

        TakePoints.Quote memory q_feeA = settlement.quote(a, AMOUNT_IN, block.timestamp);
        uint256 deliveredA = q_feeA.delivered;
        uint256 feeA = q_feeA.feeProceeds;
        TakePoints.Quote memory q_feeB = settlement.quote(b, AMOUNT_IN, block.timestamp);
        uint256 deliveredB = q_feeB.delivered;
        uint256 feeB = q_feeB.feeProceeds;
        assertEq(deliveredA, deliveredB, "the maker is owed the same either way");
        assertEq(feeA, feeB, "and the executor is charged the same");

        // Sign first. `_sign` calls `hashIntent`, and a call inside a pranked line eats the
        // prank — the fixture's standing warning, and it cost this test one run.
        bytes memory sigA = _sign(a, makerKey);
        bytes memory sigB = _sign(b, makerKey);

        uint256 before = tokenB.balanceOf(executor);
        vm.prank(executor);
        settlement.fill(a, sigA, AMOUNT_IN, ANY_FEE);
        uint256 costA = before - tokenB.balanceOf(executor);

        before = tokenB.balanceOf(executor);
        vm.prank(executor);
        settlement.fill(b, sigB, AMOUNT_IN, ANY_FEE);
        assertEq(before - tokenB.balanceOf(executor), costA, "the same cost to execute");
    }

    /**
     * A batch coalesces a fee per run of matching (token, destination). Two legs to the same
     * place merge; a third going elsewhere starts a new run rather than joining the old one.
     */
    function test_ABatchSplitsItsFeesByDestination() public {
        address other = address(0xB11);
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](3);
        address[3] memory targets = [BUY_AND_BURN, BUY_AND_BURN, other];
        uint256 expectedBurn;
        uint256 expectedOther;

        for (uint256 k = 0; k < 3; k++) {
            ProveSettlement.Intent memory i = _intent();
            i.nonce = k + 900;
            i.feeConfig = feeCfg(targets[k]);
            uint256 fee = settlement.quote(i, AMOUNT_IN / 10, block.timestamp).feeProceeds;
            if (targets[k] == BUY_AND_BURN) expectedBurn += fee;
            else expectedOther += fee;
            reqs[k] = ProveSettlement.FillRequest({
                intent: i, signature: _sign(i, makerKey), take: AMOUNT_IN / 10, arming: ""
            });
        }

        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 3);

        assertEq(
            settlement.pendingFees(feeCfg(BUY_AND_BURN), address(tokenB)),
            expectedBurn,
            "the first two merged"
        );
        assertEq(
            settlement.pendingFees(feeCfg(other), address(tokenB)),
            expectedOther,
            "the third went its own way"
        );
        assertEq(
            settlement.totalPendingFees(address(tokenB)),
            expectedBurn + expectedOther,
            "and the total is the sum of the two rows"
        );
        assertEq(tokenB.balanceOf(proceeds), 0, "and no run reached the owner's address");
    }

    // ── Batches ──────────────────────────────────────────────────────────────

    function test_BatchFillsSeveralIntents() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](3);
        for (uint256 k = 0; k < 3; k++) {
            ProveSettlement.Intent memory i = _intent();
            i.nonce = k + 10;
            reqs[k] = ProveSettlement.FillRequest({
                intent: i, signature: _sign(i, makerKey), take: AMOUNT_IN / 10, arming: ""
            });
        }

        vm.prank(executor);
        uint256 count = settlement.fillBatch(reqs, false, ANY_FEE);

        assertEq(count, 3);
        assertEq(tokenA.balanceOf(executor), 3 * (AMOUNT_IN / 10));
    }

    function test_BatchSkipsWhatSomebodyElseAlreadyTook() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        for (uint256 k = 0; k < 2; k++) {
            ProveSettlement.Intent memory i = _intent();
            i.nonce = k + 20;
            i.flags = 0; // all or nothing, so a race really does lose the whole intent
            reqs[k] = ProveSettlement.FillRequest({
                intent: i, signature: _sign(i, makerKey), take: AMOUNT_IN, arming: ""
            });
        }

        // Somebody wins the race for the first one.
        address rival = address(0xB1D);
        tokenB.mint(rival, 1_000_000e18);
        vm.startPrank(rival);
        tokenB.approve(relayer, type(uint256).max);
        settlement.fill(reqs[0].intent, reqs[0].signature, AMOUNT_IN, ANY_FEE);
        vm.stopPrank();

        vm.prank(executor);
        uint256 count = settlement.fillBatch(reqs, true, ANY_FEE);
        assertEq(count, 1, "the batch stepped over the lost race and took the other");

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.TooMuch.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    // ── Properties ───────────────────────────────────────────────────────────

    function testFuzz_FillsNeverExceedTheSignedAmount(uint96 a, uint96 b, uint96 c) public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i, makerKey);
        bytes32 h = settlement.hashIntent(i);

        uint256[3] memory takes = [uint256(a), uint256(b), uint256(c)];
        for (uint256 k = 0; k < 3; k++) {
            uint256 take = takes[k];
            uint256 remaining = i.amountIn - settlement.filled(h);
            vm.prank(executor);
            if (take == 0 || take > remaining) {
                vm.expectRevert();
                settlement.fill(i, sig, take, ANY_FEE);
            } else {
                settlement.fill(i, sig, take, ANY_FEE);
            }
        }

        assertLe(settlement.filled(h), i.amountIn);
    }

    function testFuzz_TheGrossNeverFallsBelowTheSignedRate(uint96 rawTake, uint32 skip) public {
        ProveSettlement.Intent memory i = _intent();
        i.minOutEnd = MIN_OUT / 3;
        uint256 take = bound(uint256(rawTake), 1, AMOUNT_IN);
        vm.warp(i.startTime + bound(uint256(skip), 0, 3599));

        bytes memory sig = _sign(i, makerKey);
        uint256 before = tokenB.balanceOf(maker);
        TakePoints.Quote memory q_fee = settlement.quote(i, take, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;

        vm.prank(executor);
        settlement.fill(i, sig, take, ANY_FEE);

        uint256 received = tokenB.balanceOf(maker) - before;
        uint256 rate = settlement.minOutAt(i, block.timestamp);
        assertEq(received, delivered, "the maker receives the split's own half");
        assertGe((received + fee) * AMOUNT_IN, take * rate, "and the gross is never short");
        assertGe(rate, i.minOutEnd, "the rate never falls through the floor");
    }
}
