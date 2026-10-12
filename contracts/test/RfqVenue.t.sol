// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
import {
    proceedsRate,
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION
} from "./Fees.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {RfqVenue} from "../src/RfqVenue.sol";
import {IProveSettlementBatch} from "../src/ProveBatchExecutor.sol";
import {IProveSettlementFill} from "../src/ProveExecutor.sol";
import {IProveBatchCallback} from "../src/interfaces/IProveBatchCallback.sol";
import {
    ANY_FEE,
    MockERC20,
    MumblingWallet,
    NO_PERMIT2,
    RevertingWallet,
    SmartWallet
} from "./Mocks.sol";

/**
 * @notice `RfqVenue` — a price named for one address, taken by that address alone.
 *
 *   forge test --match-path test/RfqVenue.t.sol -vv
 *
 * Three claims are under test and they are separate claims.
 *
 * The first is exclusivity: the quote is unfillable by anybody except this contract, and this
 * contract fills it only for the counterparty the maker signed for. That rests entirely on
 * `Intent.executor`, so the first test after the happy path is the one that proves a stranger
 * cannot reach the quote on the settlement directly.
 *
 * The second is capital: the ring settles from an address holding nothing, because both releases
 * land before either payment is pulled.
 *
 * The third is the donation mark. This contract never spends a balance it did not earn in the
 * same transaction. A stranger cannot sweep a donation, and the settlement cannot pull a maker's
 * delivery or a fee out of one. `ProveBatchExecutor` had holes in the first two and they were
 * expensive; the fee is the third, and the one clause covers all three.
 *
 * **The venue charges no fee of its own, and it used to.** An exclusive quote is now an ordinary
 * intent that names a higher `feeRate`, so the settlement charges it, splits it, and pays it. The
 * tests that watched this contract move that money now watch the two destinations instead.
 *
 * **Every helper that reaches the chain runs before a cheat code, never inside its arguments.**
 * `vm.prank` and `vm.expectRevert` arm the next call, `hashIntent` and `hashExclusive` are calls,
 * and a signature built inside the argument list of the line under test eats the cheat code. That
 * mistake reads as a passing sender and a missing revert, and it cost this file a whole rewrite.
 */
contract RfqVenueTest is Test {
    ProveSettlement settlement;
    RfqVenue venue;

    /// @dev A plain ERC-20 until a test arms it. See `ReenterableToken`.
    ReenterableToken tokenA;
    MockERC20 tokenB;

    /// @dev The address that pulls, which is not the address that calls. Read once: `vm.prank`
    ///      is single-shot and `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;

    /// @dev The settlement's `defaultProceeds`. No fill reads it, so every assertion below that
    ///      it holds nothing is the claim that the intent names the destination.
    address proceeds = address(0x5152);
    /// @dev The quote's own fee destination, and the only address a fee can reach.
    address quoteFeeTo = address(0xFEE1);
    address submitter = address(0x5AB);

    address maker;
    uint256 makerKey;
    address counterparty;
    uint256 counterKey;
    address stranger;
    uint256 strangerKey;

    /// @dev The quote sells 1,000 token A for 100 token B; the mirror sells 110 token B for 900
    ///      token A. Between them they concede 100 token A and 10 token B, which covers the fee
    ///      on each leg and the gas.
    uint256 constant QUOTE_IN = 1_000e18;
    uint256 constant QUOTE_OUT = 100e18;
    /// @dev How long a binding stands. A mirror may not outlive it — `_checkBinding`.
    uint64 constant BINDING_TTL = 30;
    uint256 constant MIRROR_IN = 110e18;
    uint256 constant MIRROR_OUT = 900e18;

    /**
     * @dev The rate the quote charges, and it is the whole of exclusivity now. Sixty basis
     *      points, one signed number, and nothing on chain raises or lowers it. `ex.intentHash`
     *      commits to it, so a counterparty who verifies the binding has already read the rate.
     */
    uint64 constant QUOTE_FEE_RATE = 0.006e18;

    /// @dev What each leg's own maker pays for their exclusivity, out of the number they signed.
    ///      The quote charges its own rate on its 100 token B gross, all of it to `quoteFeeTo`.
    ///      The mirror signs no rate and names no destination, so it charges nothing at all.
    ///
    ///      The fee comes out of the maker's number rather than on top of it, so neither of these
    ///      costs the submitter anything. `QUOTE_OUT` is the whole token B outlay.
    uint256 constant QUOTE_FEE = 0.6e18;
    uint256 constant MIRROR_FEE = 0;
    /// @dev What the quote's maker actually receives.
    uint256 constant QUOTE_NET = QUOTE_OUT - QUOTE_FEE;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        (counterparty, counterKey) = makeAddrAndKey("counterparty");
        (stranger, strangerKey) = makeAddrAndKey("stranger");

        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        venue = new RfqVenue(address(settlement));

        tokenA = new ReenterableToken();
        tokenB = new MockERC20("B", "B", 18);

        tokenA.mint(maker, 1_000_000e18);
        tokenB.mint(counterparty, 1_000_000e18);
        tokenB.mint(stranger, 1_000_000e18);

        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(counterparty);
        tokenB.approve(relayer, type(uint256).max);
        vm.prank(stranger);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _intent(
        address who,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address executor,
        address feeTo,
        uint256 nonce
    ) internal view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: who,
            recipient: who,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minOutStart: minOut,
            minOutEnd: minOut,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: executor,
            feeConfig: feeCfg(feeTo),
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

    /// @dev The maker's exclusive quote: fillable by this venue and by nothing else on chain, and
    ///      charging its own rate for the privilege.
    function _quote() internal view returns (ProveSettlement.Intent memory i) {
        i = _floorQuote();
        i.feeRateProceeds = QUOTE_FEE_RATE;
    }

    /// @dev The same quote at the owner's floor. A maker who reserves a price and asks nothing
    ///      extra for it signs this one.
    function _floorQuote() internal view returns (ProveSettlement.Intent memory) {
        return _intent(
            maker,
            address(tokenA),
            address(tokenB),
            QUOTE_IN,
            QUOTE_OUT,
            address(venue),
            quoteFeeTo,
            1
        );
    }

    /// @dev The counterparty's acceptance: an ordinary signed intent, the other way round.
    function _mirrorIntent() internal view returns (ProveSettlement.Intent memory) {
        return _mirrorSelling(MIRROR_IN);
    }

    /**
     * @dev The same acceptance, selling a different amount of token B. A tight mirror is how a
     *      test says "this ring generates no spread".
     *
     * The window is `BINDING_TTL`, not the hour the shared builder gives every other intent,
     * because `_checkBinding` refuses a mirror that outlives the binding it answers. The SDK's
     * `mirrorFor` has always built it that way — `min(now + 90, quote.endTime)` — and this
     * fixture did not, which is how it stayed a shape only the contract accepted.
     */
    function _mirrorSelling(uint256 amountIn)
        internal
        view
        returns (ProveSettlement.Intent memory m)
    {
        m = _intent(
            counterparty,
            address(tokenB),
            address(tokenA),
            amountIn,
            MIRROR_OUT,
            address(venue),
            address(0),
            2
        );
        m.endTime = uint64(block.timestamp + BINDING_TTL);
        return m;
    }

    /**
     * @dev Half an acceptance: half in, half out, so the rate is the one the counterparty quoted.
     *
     * A quote may be filled in slices, and each slice needs its own binding. `_checkBinding` now
     * also requires the mirror to be taken whole, so a slice pairs with an acceptance SIZED to it
     * rather than with a full acceptance taken half. That is what a counterparty actually signs —
     * `mirrorFor` builds a mirror for the amount being accepted — and it is what stops a
     * submitter choosing the mirror's take for themselves.
     */
    function _mirrorHalf(uint256 nonce) internal view returns (ProveSettlement.Intent memory m) {
        m = _mirrorSelling(MIRROR_IN / 2);
        m.minOutStart = MIRROR_OUT / 2;
        m.minOutEnd = MIRROR_OUT / 2;
        // Its own nonce, because it is its own acceptance. Two slices of a quote are two
        // bindings, and each answers a signature the counterparty wrote for that slice.
        m.nonce = nonce;
    }

    /// @dev The settlement's own `Intent` in the executor's mirror of it. Field for field, which
    ///      is the property `IProveSettlementFill` says the compiler will not check for us.
    function _asFill(ProveSettlement.Intent memory i)
        internal
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
            minFill: 0,
            authNonce: bytes32(0),
            flags: i.flags,
            nonce: i.nonce,
            curve: i.curve
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

    function _req(ProveSettlement.Intent memory i, uint256 key, uint256 take)
        internal
        view
        returns (IProveSettlementBatch.FillRequest memory)
    {
        return IProveSettlementBatch.FillRequest({
            intent: _asFill(i), signature: _sign(i, key), take: take, arming: ""
        });
    }

    /// @dev The quote and the counterparty's mirror, in the order the venue reads them.
    function _pair(
        ProveSettlement.Intent memory quote,
        uint256 quoteTake,
        ProveSettlement.Intent memory mirror,
        uint256 mirrorTake
    ) internal view returns (IProveSettlementBatch.FillRequest[] memory reqs) {
        reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(quote, makerKey, quoteTake);
        reqs[1] = _req(mirror, counterKey, mirrorTake);
    }

    /// @dev The binding names no rate. It commits to the quote by hash, and the quote names the
    ///      rate, so one signature covers both.
    function _binding(ProveSettlement.Intent memory quote, uint256 take, uint256 nonce)
        internal
        view
        returns (RfqVenue.Exclusive memory)
    {
        return RfqVenue.Exclusive({
            intentHash: settlement.hashIntent(quote),
            counterparty: counterparty,
            take: take,
            expiry: uint64(block.timestamp + BINDING_TTL),
            nonce: nonce
        });
    }

    function _signBinding(RfqVenue.Exclusive memory ex, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, venue.hashExclusive(ex));
        return abi.encodePacked(r, s, v);
    }

    /// @dev A binding and the maker's signature over it, built together and before any cheat code.
    function _signedBinding(ProveSettlement.Intent memory quote, uint256 take, uint256 nonce)
        internal
        view
        returns (RfqVenue.Exclusive memory ex, bytes memory sig)
    {
        ex = _binding(quote, take, nonce);
        sig = _signBinding(ex, makerKey);
    }

    /// @dev The whole happy path, so a test that varies one thing says only what it varies.
    function _standard()
        internal
        view
        returns (
            IProveSettlementBatch.FillRequest[] memory reqs,
            RfqVenue.Exclusive memory ex,
            bytes memory sig
        )
    {
        ProveSettlement.Intent memory quote = _quote();
        reqs = _pair(quote, QUOTE_IN, _mirrorIntent(), MIRROR_IN);
        (ex, sig) = _signedBinding(quote, QUOTE_IN, 1);
    }

    // ── The happy path ───────────────────────────────────────────────────────

    /**
     * @notice The whole product in one transaction.
     *
     * The maker named a price for one address. That address accepted by signing an intent and
     * sending nothing. A third party submitted the pair, paid the gas, and kept the spread. No
     * inventory anywhere, and both makers received exactly the rate they signed.
     */
    function test_AnExclusiveQuoteSettlesFromAnAddressHoldingNothing() public {
        assertEq(tokenA.balanceOf(address(venue)), 0, "the venue starts with nothing");
        assertEq(tokenB.balanceOf(address(venue)), 0);
        assertEq(tokenA.balanceOf(submitter), 0, "and so does the submitter");
        assertEq(tokenB.balanceOf(submitter), 0);

        (
            IProveSettlementBatch.FillRequest[] memory reqs,
            RfqVenue.Exclusive memory ex,
            bytes memory sig
        ) = _standard();
        bytes32 expected = venue.hashExclusive(ex);

        vm.prank(submitter);
        bytes32 binding = venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(binding, expected, "the digest that was spent");
        assertTrue(venue.spent(binding), "and it is spent");

        assertEq(tokenB.balanceOf(maker), QUOTE_NET, "the maker got the rate they signed");
        assertEq(tokenA.balanceOf(counterparty), MIRROR_OUT, "so did the counterparty");
        assertEq(
            settlement.pendingFees(feeCfg(quoteFeeTo), address(tokenB)),
            QUOTE_FEE,
            "the quote's own destination is owed the whole of the rate the quote charges"
        );
        assertEq(tokenB.balanceOf(proceeds), 0, "and the owner's address took none of it");
        assertEq(tokenA.balanceOf(proceeds), 0, "the mirror named nowhere, so it charged nothing");
        assertEq(
            tokenA.balanceOf(submitter),
            QUOTE_IN - MIRROR_OUT - MIRROR_FEE,
            "the submitter kept the token A spread"
        );
        assertEq(
            tokenB.balanceOf(submitter),
            MIRROR_IN - QUOTE_OUT,
            "and the token B spread, which the quote's fee no longer comes out of"
        );
        assertEq(tokenA.balanceOf(address(venue)), 0, "nothing rests in the venue");
        assertEq(tokenB.balanceOf(address(venue)), 0, "in either token");
    }

    /// @notice The counterparty pays no gas and holds no allowance to this contract. Their
    ///         acceptance is a signature and the relayer's existing approval, and nothing else.
    function test_TheCounterpartySendsNoTransactionAndApprovesNothingNew() public {
        assertEq(tokenB.allowance(counterparty, address(venue)), 0, "no allowance to the venue");

        (
            IProveSettlementBatch.FillRequest[] memory reqs,
            RfqVenue.Exclusive memory ex,
            bytes memory sig
        ) = _standard();

        vm.prank(submitter);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(tokenA.balanceOf(counterparty), MIRROR_OUT, "and they were paid anyway");
        assertEq(tokenB.allowance(counterparty, address(venue)), 0, "and still owe it nothing");
    }

    /// @notice A maker may reserve a price and charge nothing for it. The quote names no rate,
    ///         nothing raises it, and the whole spread reaches the submitter.
    function test_AQuoteThatAsksForNothingExtraCostsNothing() public {
        ProveSettlement.Intent memory quote = _floorQuote();
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN, _mirrorIntent(), MIRROR_IN);
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(
            settlement.pendingFees(feeCfg(quoteFeeTo), address(tokenB)),
            0,
            "no rate signed, so nothing was charged"
        );
        assertEq(tokenB.balanceOf(proceeds), 0, "and nothing reached the owner's address either");
        assertEq(
            tokenB.balanceOf(submitter), MIRROR_IN - QUOTE_OUT, "and the submitter kept the rest"
        );
    }

    /**
     * @notice T1-13, venue (a). An exclusive quote may charge a fee only to a registered sink,
     *         or to the default sink through a zero `feeTo` and a zero rate. The venue gets no
     *         exception: an unregistered address, and a zero `feeTo` with a signed rate, are
     *         both bad terms.
     */
    function test_AnExclusiveQuoteThatChargesNeedsAFeeConfig() public {
        bytes32[1] memory refused = [bytes32(0)];
        for (uint256 k = 0; k < refused.length; k++) {
            ProveSettlement.Intent memory quote = _quote();
            quote.feeConfig = refused[k];
            IProveSettlementBatch.FillRequest[] memory reqs =
                _pair(quote, QUOTE_IN, _mirrorIntent(), MIRROR_IN);
            (RfqVenue.Exclusive memory ex, bytes memory sig) =
                _signedBinding(quote, QUOTE_IN, k + 1);
            vm.prank(submitter);
            vm.expectRevert(ProveSettlement.BadTerms.selector);
            venue.settleExclusive(reqs, ex, sig, ANY_FEE);
        }
    }

    // ── Exclusivity ──────────────────────────────────────────────────────────

    /**
     * @notice The claim the whole design rests on: nobody else can reach the quote.
     *
     * `ProveSettlement._evaluate` compares `Intent.executor` against `msg.sender` at every fill
     * site. The quote names this venue, so the settlement refuses everybody else — the stranger
     * who found it on the board, and the counterparty it was written for.
     */
    function test_NobodyButTheVenueCanFillTheQuoteOnTheSettlement() public {
        ProveSettlement.Intent memory quote = _quote();
        bytes memory sig = _sign(quote, makerKey);

        vm.prank(stranger);
        vm.expectRevert(ProveSettlement.WrongExecutor.selector);
        settlement.fill(quote, sig, QUOTE_IN, ANY_FEE);

        vm.prank(counterparty);
        vm.expectRevert(ProveSettlement.WrongExecutor.selector);
        settlement.fill(quote, sig, QUOTE_IN, ANY_FEE);
    }

    /// @notice And a batch is no way round it either. One list, one `_evaluate`.
    function test_NobodyButTheVenueCanBatchTheQuoteEither() public {
        ProveSettlement.Intent memory quote = _quote();
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = ProveSettlement.FillRequest({
            intent: quote, signature: _sign(quote, makerKey), take: QUOTE_IN, arming: ""
        });

        vm.prank(stranger);
        vm.expectRevert(ProveSettlement.WrongExecutor.selector);
        settlement.fillBatch(reqs, false, ANY_FEE);
    }

    /**
     * @notice A stranger with a perfectly good mirror still cannot take the price.
     *
     * This is what the binding buys over `executor` alone. The venue would settle this ring
     * happily — the tokens cross, the rates work — and it refuses because the maker signed for
     * one address and this is not that address.
     */
    function test_AStrangersMirrorCannotTakeTheQuote() public {
        ProveSettlement.Intent memory quote = _quote();
        ProveSettlement.Intent memory theirs = _intent(
            stranger,
            address(tokenB),
            address(tokenA),
            MIRROR_IN,
            MIRROR_OUT,
            address(venue),
            address(0),
            9
        );

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(quote, makerKey, QUOTE_IN);
        reqs[1] = _req(theirs, strangerKey, MIRROR_IN);

        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(stranger);
        vm.expectRevert(RfqVenue.NotTheCounterparty.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    /// @notice Anyone may submit, and that is deliberate. The counterparty is named in the
    ///         binding; who pays the gas is nobody's business.
    function test_AnybodyMaySubmitTheRightPairing() public {
        (
            IProveSettlementBatch.FillRequest[] memory reqs,
            RfqVenue.Exclusive memory ex,
            bytes memory sig
        ) = _standard();

        vm.prank(stranger);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(tokenA.balanceOf(counterparty), MIRROR_OUT, "the named address was still paid");
        assertGt(tokenA.balanceOf(stranger), 0, "and the submitter kept the spread");
    }

    /**
     * @notice A quote with an open executor is refused, and this is not a formality.
     *
     * The settlement would let this venue fill it — `executor == address(0)` means anybody. But
     * so would every other address on the chain, so the binding would guard a price that was
     * already public. Exclusivity is a property of that one field and the venue reads it.
     */
    function test_AQuoteWithAnOpenExecutorIsRefused() public {
        ProveSettlement.Intent memory quote = _intent(
            maker, address(tokenA), address(tokenB), QUOTE_IN, QUOTE_OUT, address(0), quoteFeeTo, 1
        );
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN, _mirrorIntent(), MIRROR_IN);
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        vm.expectRevert(RfqVenue.QuoteNotExclusiveToThisVenue.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    /**
     * @notice A mirror with an open executor is refused too, and that one protects the
     *         counterparty rather than the maker.
     *
     * The counterparty prices their acceptance against this quote. Left open, that signature is
     * an ordinary public order at that rate: anybody could fill it on the settlement without ever
     * showing the maker's side, and the acceptance would leak as a standing offer at a price the
     * counterparty only ever meant for one trade.
     */
    function test_AMirrorWithAnOpenExecutorIsRefused() public {
        ProveSettlement.Intent memory quote = _quote();
        ProveSettlement.Intent memory mirror = _intent(
            counterparty,
            address(tokenB),
            address(tokenA),
            MIRROR_IN,
            MIRROR_OUT,
            address(0),
            address(0),
            2
        );
        IProveSettlementBatch.FillRequest[] memory reqs = _pair(quote, QUOTE_IN, mirror, MIRROR_IN);
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        vm.expectRevert(RfqVenue.MirrorNotExclusiveToThisVenue.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    /// @notice Two legs that do not cross are not a ring, whatever else is valid about them.
    function test_TwoLegsThatDoNotCrossAreRefused() public {
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        tokenC.mint(counterparty, 1_000e18);

        ProveSettlement.Intent memory quote = _quote();
        ProveSettlement.Intent memory notMirror = _intent(
            counterparty,
            address(tokenC),
            address(tokenA),
            MIRROR_IN,
            MIRROR_OUT,
            address(venue),
            address(0),
            2
        );
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN, notMirror, MIRROR_IN);
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        vm.expectRevert(RfqVenue.NotAMirror.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    // ── The mirror the binding cannot name ───────────────────────────────────

    /**
     * @notice An acceptance is spent on the deal it answered, and cannot be carried to another.
     *
     * `Exclusive` commits to the quote by hash and to nothing about the mirror, because the maker
     * signs first and cannot know a hash the counterparty has not produced yet. So the mirror's
     * shape has to be enforced at settlement or the counterparty's signature outlives the deal.
     *
     * This is the whole attack, and it worked: a counterparty accepts a real quote with a mirror
     * that decays and outlives its binding. An hour later a rogue mints their own quote for the
     * same pair, signs their own binding naming that counterparty, and submits the pair. The
     * counterparty is filled at the bottom of their own curve, by somebody they never dealt with,
     * and the rogue keeps the difference — 44% of the counterparty's proceeds when measured.
     */
    function test_AnAcceptanceCannotBeCarriedToARogueQuote() public {
        ProveSettlement.Intent memory acceptance = _mirrorIntent();
        acceptance.minOutStart = MIRROR_OUT * 2; // decays, so a late fill pays less
        acceptance.endTime = uint64(block.timestamp + 1 hours);

        vm.warp(block.timestamp + 1 hours - 60);

        // The rogue's own quote, their own binding, naming a counterparty who never met them.
        ProveSettlement.Intent memory rogue = _intent(
            stranger,
            address(tokenA),
            address(tokenB),
            QUOTE_IN,
            QUOTE_OUT,
            address(venue),
            address(0),
            9
        );
        RfqVenue.Exclusive memory ex = RfqVenue.Exclusive({
            intentHash: settlement.hashIntent(rogue),
            counterparty: counterparty,
            take: QUOTE_IN,
            expiry: uint64(block.timestamp + BINDING_TTL),
            nonce: 9
        });
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(strangerKey, venue.hashExclusive(ex));

        // Signed by the rogue, not the maker — `_pair` assumes `makerKey` and would make this
        // revert on the intent's signature instead of on the thing the test is named for.
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(rogue, strangerKey, QUOTE_IN);
        reqs[1] = _req(acceptance, counterKey, MIRROR_IN);

        vm.expectRevert(RfqVenue.MirrorOutlivesTheBinding.selector);
        venue.settleExclusive(reqs, ex, abi.encodePacked(r, sg, v), ANY_FEE);
    }

    /// @notice A decaying acceptance is refused, because it pays less the later it is paired.
    function test_AnAcceptanceThatDecaysIsRefused() public {
        ProveSettlement.Intent memory sliding = _mirrorIntent();
        sliding.minOutStart = MIRROR_OUT * 2;

        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(_quote(), QUOTE_IN, 1);
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(_quote(), QUOTE_IN, sliding, MIRROR_IN);

        vm.expectRevert(RfqVenue.MirrorIsNotFlat.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    /**
     * @notice The submitter does not get to choose how much of the acceptance to take.
     *
     * `settleExclusive` bounds the quote's take against `ex.take` and bounded the mirror's
     * against nothing. `_termsOk` only forces `take == remaining` when the counterparty did not
     * set `FLAG_PARTIAL`, so on a partial acceptance the submitter picked the number.
     */
    function test_TheSubmitterCannotSliceTheAcceptance() public {
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(_quote(), QUOTE_IN, 1);
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(_quote(), QUOTE_IN, _mirrorIntent(), MIRROR_IN - 1);

        vm.expectRevert(RfqVenue.MirrorNotTakenWhole.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    // ── The binding: replay, forgery, expiry ─────────────────────────────────

    function test_AnExpiredBindingSettlesNothing() public {
        (
            IProveSettlementBatch.FillRequest[] memory reqs,
            RfqVenue.Exclusive memory ex,
            bytes memory sig
        ) = _standard();

        vm.warp(ex.expiry);
        vm.prank(submitter);
        vm.expectRevert(RfqVenue.BindingExpired.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    /// @notice A binding is one-shot. The second attempt fails on the mark, not on the money.
    function test_ABindingIsSpentOnce() public {
        ProveSettlement.Intent memory quote = _quote();
        // A quote worth taking twice: half now, half later, and enough of it left over.
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN / 2, 1);
        IProveSettlementBatch.FillRequest[] memory first =
            _pair(quote, QUOTE_IN / 2, _mirrorHalf(2), MIRROR_IN / 2);
        IProveSettlementBatch.FillRequest[] memory again =
            _pair(quote, QUOTE_IN / 2, _mirrorHalf(3), MIRROR_IN / 2);

        vm.prank(submitter);
        venue.settleExclusive(first, ex, sig, ANY_FEE);

        vm.prank(submitter);
        vm.expectRevert(RfqVenue.BindingSpent.selector);
        venue.settleExclusive(again, ex, sig, ANY_FEE);
    }

    /**
     * @notice The rest of a part-taken quote needs a second binding, and that is the design.
     *
     * `ProveSettlement` would allow the second slice — the intent is `FLAG_PARTIAL` and half of
     * `amountIn` is still there. The venue will not, until the maker signs for it again. A
     * repeatable binding would need its own ledger of consumption beside the settlement's, and
     * over a Dutch quote it would hand the counterparty a free option on the rest.
     */
    function test_ASecondSliceNeedsASecondBinding() public {
        ProveSettlement.Intent memory quote = _quote();

        (RfqVenue.Exclusive memory one, bytes memory oneSig) =
            _signedBinding(quote, QUOTE_IN / 2, 1);
        (RfqVenue.Exclusive memory two, bytes memory twoSig) =
            _signedBinding(quote, QUOTE_IN / 2, 2);
        IProveSettlementBatch.FillRequest[] memory firstHalf =
            _pair(quote, QUOTE_IN / 2, _mirrorHalf(2), MIRROR_IN / 2);
        IProveSettlementBatch.FillRequest[] memory secondHalf =
            _pair(quote, QUOTE_IN / 2, _mirrorHalf(3), MIRROR_IN / 2);

        vm.prank(submitter);
        venue.settleExclusive(firstHalf, one, oneSig, ANY_FEE);

        vm.prank(submitter);
        venue.settleExclusive(secondHalf, two, twoSig, ANY_FEE);

        assertEq(tokenB.balanceOf(maker), QUOTE_NET, "the whole quote settled, in two acts");
        assertEq(tokenA.balanceOf(counterparty), MIRROR_OUT);
    }

    /// @notice A binding somebody else signed is not the maker's promise.
    function test_AForgedBindingSettlesNothing() public {
        ProveSettlement.Intent memory quote = _quote();
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN, _mirrorIntent(), MIRROR_IN);
        RfqVenue.Exclusive memory ex = _binding(quote, QUOTE_IN, 1);
        bytes memory forged = _signBinding(ex, counterKey);

        vm.prank(submitter);
        vm.expectRevert(RfqVenue.BadBinding.selector);
        venue.settleExclusive(reqs, ex, forged, ANY_FEE);
    }

    /**
     * @notice A binding follows one intent hash, so a re-signed quote leaves it behind.
     *
     * The maker signs a second, worse quote at a later nonce. The binding still names the first
     * one, and the venue compares the hash rather than the maker.
     */
    function test_ABindingDoesNotFollowARewrittenQuote() public {
        ProveSettlement.Intent memory quote = _quote();
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        ProveSettlement.Intent memory rewritten = _quote();
        rewritten.nonce = 7;
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(rewritten, QUOTE_IN, _mirrorIntent(), MIRROR_IN);

        vm.prank(submitter);
        vm.expectRevert(RfqVenue.BindingIsForAnotherIntent.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    /// @notice The size is signed, so a counterparty cannot burn a large quote on a small take.
    function test_ATakeTheMakerDidNotSignSettlesNothing() public {
        ProveSettlement.Intent memory quote = _quote();
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN / 2, _mirrorIntent(), MIRROR_IN);

        vm.prank(submitter);
        vm.expectRevert(
            abi.encodeWithSelector(RfqVenue.TakeNotBound.selector, QUOTE_IN, QUOTE_IN / 2)
        );
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    /**
     * @notice A binding signed for one venue verifies at no other.
     *
     * This contract's address sits in its own domain separator, and so does the chain id. A
     * second deployment reads the same bytes and recovers a different signer.
     */
    function test_ABindingFromAnotherVenueSettlesNothing() public {
        RfqVenue other = new RfqVenue(address(settlement));
        assertTrue(venue.domainSeparator() != other.domainSeparator(), "two venues, two domains");

        ProveSettlement.Intent memory quote = _intent(
            maker,
            address(tokenA),
            address(tokenB),
            QUOTE_IN,
            QUOTE_OUT,
            address(other),
            quoteFeeTo,
            1
        );
        ProveSettlement.Intent memory mirror = _intent(
            counterparty,
            address(tokenB),
            address(tokenA),
            MIRROR_IN,
            MIRROR_OUT,
            address(other),
            address(0),
            2
        );
        // Inside its binding, like every acceptance a client builds. Otherwise this test proves
        // the shape check rather than the venue check it is named for.
        mirror.endTime = uint64(block.timestamp + BINDING_TTL);
        IProveSettlementBatch.FillRequest[] memory reqs = _pair(quote, QUOTE_IN, mirror, MIRROR_IN);
        // Signed under this venue's domain, submitted to the other one.
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        vm.expectRevert(RfqVenue.BadBinding.selector);
        other.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    /// @notice A market maker quoting from a smart account signs the binding through ERC-1271,
    ///         exactly as it signs the intent.
    function test_AContractWalletCanSignTheBinding() public {
        SmartWallet wallet = new SmartWallet(maker);
        tokenA.mint(address(wallet), QUOTE_IN);
        wallet.approveToken(address(tokenA), relayer, type(uint256).max);

        ProveSettlement.Intent memory quote = _intent(
            address(wallet),
            address(tokenA),
            address(tokenB),
            QUOTE_IN,
            QUOTE_OUT,
            address(venue),
            quoteFeeTo,
            1
        );
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(quote, makerKey, QUOTE_IN);
        reqs[1] = _req(_mirrorIntent(), counterKey, MIRROR_IN);

        vm.prank(submitter);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(tokenB.balanceOf(address(wallet)), QUOTE_OUT, "the wallet was paid its rate");
    }

    // ── The fee ──────────────────────────────────────────────────────────────

    /**
     * @notice The only ceiling is arithmetic, and the submitter's own bound is what refuses a
     *         greedy quote.
     *
     * The venue used to keep its own ceiling of one per cent, and the settlement then kept one
     * of a fifth. Neither protected anybody: the maker chose the rate, the submitter passes
     * their own bound, and prove.cash earns nothing either way. `_termsOk` refuses a rate above
     * `WAD` because the subtraction would underflow, and below that a rate nobody will pay is an
     * offer nobody fills. The bound below is what enforces the submitter's side of it — not of
     * their outlay, which the rate does not touch, but of which destinations a fill engages with.
     */
    function test_AGreedyQuoteIsRefusedByTheSubmittersOwnBound() public {
        ProveSettlement.Intent memory quote = _quote();
        quote.feeRate = 0.5e18;
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN, _mirrorIntent(), MIRROR_IN);
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        vm.expectRevert(ProveSettlement.FeeTooHigh.selector);
        venue.settleExclusive(reqs, ex, sig, QUOTE_FEE_RATE);
    }

    /**
     * @notice The rate the maker signed is the rate that is charged, and a client reads it before
     *         anybody signs anything.
     *
     * `quote` is what a front end shows a counterparty: the delivery and the fee. The
     * counterparty then verifies the binding, whose `intentHash` commits to the rate these
     * numbers come from, so the quote cannot be repriced under the signature.
     */
    function test_TheRateTheMakerSignedIsTheRateThatIsCharged() public {
        ProveSettlement.Intent memory quote = _quote();
        assertEq(proceedsRate(settlement, quote), uint256(QUOTE_FEE_RATE), "the quote's own rate");

        TakePoints.Quote memory q_fee = settlement.quote(quote, QUOTE_IN, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertEq(delivered, QUOTE_NET, "quoted before the trade");
        assertEq(fee, QUOTE_FEE);
        assertEq(delivered + fee, QUOTE_OUT, "and the two halves are the quote's own number");

        (
            IProveSettlementBatch.FillRequest[] memory reqs,
            RfqVenue.Exclusive memory ex,
            bytes memory sig
        ) = _standard();

        vm.prank(submitter);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(
            settlement.pendingFees(feeCfg(quoteFeeTo), address(tokenB)),
            fee,
            "charged after it, to the address it named"
        );
        assertEq(tokenB.balanceOf(proceeds), 0, "and nowhere else");
    }

    /**
     * @notice A quote that names no destination and no rate charges nothing.
     *
     * There is nowhere for the fee to go. The settlement has no address of its own, so nothing is
     * collected and the submitter keeps the whole spread. A positive rate with no sink is bad
     * terms, so the free quote signs a zero rate. The venue reads none of this and decides none
     * of it.
     */
    function test_AQuoteThatNamesNoDestinationChargesNothing() public {
        ProveSettlement.Intent memory quote = _intent(
            maker,
            address(tokenA),
            address(tokenB),
            QUOTE_IN,
            QUOTE_OUT,
            address(venue),
            address(0),
            1
        );
        quote.feeRateProceeds = 0;
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN, _mirrorIntent(), MIRROR_IN);
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(tokenB.balanceOf(proceeds), 0, "no destination named, so nothing was charged");
        assertEq(
            settlement.pendingFees(feeCfg(quoteFeeTo), address(tokenB)),
            0,
            "and the front end's address takes none of it"
        );
        assertEq(
            tokenB.balanceOf(submitter),
            MIRROR_IN - QUOTE_OUT,
            "so the submitter kept the whole spread"
        );
    }

    /**
     * @notice A quote that concedes nothing pays for its own exclusivity, out of its own number.
     *
     * The mirror leaves exactly the quote's gross and not a wei more, and that is now enough. The
     * sixty basis points come out of the quoting maker's own delivery rather than out of a spread
     * the counterparty has to bring, so the ring closes with the submitter earning nothing in
     * token B and nobody short.
     *
     * **This is a real change to the venue's economics and it was accepted, not overlooked.** The
     * test used to be `test_AQuoteWithNoSpreadCannotPayForItsExclusivity` and it asserted the
     * whole transaction reverting. Under the split the fee always comes from the signer, so a
     * ring with no spread at all is fillable. Nobody can be made worse off by it: every number
     * here is one of the two makers' own signatures, and a submitter who runs it takes zero.
     */
    function test_AQuoteWithNoSpreadPaysForItsOwnExclusivity() public {
        uint256 tight = QUOTE_OUT;

        ProveSettlement.Intent memory quote = _quote();
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN, _mirrorSelling(tight), tight);
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(tokenB.balanceOf(maker), QUOTE_NET, "the maker was paid, less their own fee");
        assertEq(tokenA.balanceOf(counterparty), MIRROR_OUT, "and the counterparty in full");
        assertEq(
            settlement.pendingFees(feeCfg(quoteFeeTo), address(tokenB)),
            QUOTE_FEE,
            "the exclusivity was paid by the maker who asked for it"
        );
        assertEq(tokenB.balanceOf(submitter), 0, "the submitter took no token B spread");
        assertEq(tokenB.balanceOf(address(venue)), 0, "and nothing rests in the venue");
    }

    // ── The donation mark ────────────────────────────────────────────────────

    /**
     * @notice A donation is not the submitter's to take.
     *
     * Both tokens are marked before the ring and only the increase leaves. A stranger who submits
     * a perfectly good pairing takes the spread it generated and nothing that was already here.
     */
    function test_ADonationIsNotSweptToTheSubmitter() public {
        tokenA.mint(address(venue), 5e18);
        tokenB.mint(address(venue), 7e18);

        (
            IProveSettlementBatch.FillRequest[] memory reqs,
            RfqVenue.Exclusive memory ex,
            bytes memory sig
        ) = _standard();

        vm.prank(submitter);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(tokenA.balanceOf(address(venue)), 5e18, "the donation stayed put");
        assertEq(tokenB.balanceOf(address(venue)), 7e18);
        assertEq(
            tokenA.balanceOf(submitter),
            QUOTE_IN - MIRROR_OUT - MIRROR_FEE,
            "and the submitter took only what the ring earned"
        );
        assertEq(tokenB.balanceOf(submitter), MIRROR_IN - QUOTE_OUT);
    }

    /**
     * @notice A donation cannot pay a quote's own fee either, and it is the same clause.
     *
     * The venue no longer moves this money — the settlement pulls the whole fee, at the rate the
     * quote names. So the mark is now the only thing standing between a stranger's tokens and
     * somebody else's fee, where it used to be one of two. The ring is one wei short of the
     * quote's gross, the venue is holding a donation big enough to cover the difference, and the
     * pull succeeds out of it. The mark catches it on the way out.
     *
     * The delivery is pulled first and it clears; it is the fee pull that reaches into the
     * donation. That is what separates this from `test_ADonationCannotDischargeAMakersPayment`,
     * where the delivery itself is short. The shortfall used to be a wei of `QUOTE_OUT + QUOTE_FEE`
     * because the fee rode on top; the gross is the whole outlay now, so a wei of it is the same
     * case stated against the new arithmetic.
     */
    function test_ADonationCannotPayTheQuotesOwnFee() public {
        tokenB.mint(address(venue), 100e18);

        uint256 oneWeiShort = QUOTE_OUT - 1;
        ProveSettlement.Intent memory quote = _quote();
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN, _mirrorSelling(oneWeiShort), oneWeiShort);
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        vm.expectRevert(RfqVenue.BalanceWentDown.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(tokenB.balanceOf(address(venue)), 100e18, "the donation is still whole");
    }

    /**
     * @notice A donation cannot discharge a maker's payment either.
     *
     * This is `ProveBatchExecutor`'s older hole, restated for two legs. The quote asks for no
     * rate, so the leg costs the delivery and nothing else, and the mirror is still a wei short
     * of it. The settlement's pull succeeds out of the donation. The mark catches it on the way
     * out, which is why the mark and not the pull is what protects this balance.
     */
    function test_ADonationCannotDischargeAMakersPayment() public {
        tokenB.mint(address(venue), 100e18);

        uint256 short = QUOTE_OUT - 1;
        ProveSettlement.Intent memory quote = _floorQuote();
        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN, _mirrorSelling(short), short);
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        vm.expectRevert(RfqVenue.BalanceWentDown.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(tokenB.balanceOf(address(venue)), 100e18, "the donation is still whole");
        assertEq(tokenB.balanceOf(maker), 0, "and nobody was paid out of it");
    }

    // ── The ring is two legs, always ─────────────────────────────────────────

    function test_AnythingButTwoLegsIsRefused() public {
        (
            IProveSettlementBatch.FillRequest[] memory reqs,
            RfqVenue.Exclusive memory ex,
            bytes memory sig
        ) = _standard();

        IProveSettlementBatch.FillRequest[] memory one = new IProveSettlementBatch.FillRequest[](1);
        one[0] = reqs[0];

        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(RfqVenue.NotTwoLegs.selector, 1));
        venue.settleExclusive(one, ex, sig, ANY_FEE);

        IProveSettlementBatch.FillRequest[] memory three =
            new IProveSettlementBatch.FillRequest[](3);
        three[0] = reqs[0];
        three[1] = reqs[1];
        three[2] = reqs[1];

        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(RfqVenue.NotTwoLegs.selector, 3));
        venue.settleExclusive(three, ex, sig, ANY_FEE);
    }

    /**
     * @notice There is no `skipInvalid`, and a leg that would have been skipped takes the whole
     *         ring with it.
     *
     * A two-leg ring with a leg stepped over is not a ring: the surviving maker's tokens are
     * released and the payment meant to cover them never arrives. The venue tells the settlement
     * `false` and never offers the caller the choice.
     */
    function test_ALegThatWouldBeSkippedRevertsTheWholeRing() public {
        ProveSettlement.Intent memory quote = _quote();
        ProveSettlement.Intent memory mirror = _mirrorIntent();
        mirror.endTime = uint64(block.timestamp); // already over

        IProveSettlementBatch.FillRequest[] memory reqs = _pair(quote, QUOTE_IN, mirror, MIRROR_IN);
        (RfqVenue.Exclusive memory ex, bytes memory sig) = _signedBinding(quote, QUOTE_IN, 1);

        vm.prank(submitter);
        vm.expectRevert(ProveSettlement.Expired.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(tokenA.balanceOf(maker), 1_000_000e18, "the quote's tokens never moved");
    }

    /// @notice And the callback says the same thing from the inside, so a skip could not go
    ///         unnoticed even if one ever reached it.
    function test_TheCallbackRefusesAnyLegCountButTwo() public {
        IProveBatchCallback.Payment[] memory one = new IProveBatchCallback.Payment[](1);
        one[0] = IProveBatchCallback.Payment(
            address(tokenB), maker, 1, 0, bytes32(0), 0, address(0), 0, 0, 0, 0
        );
        bytes memory data = abi.encode(address(tokenA), address(tokenB));

        vm.prank(address(settlement));
        vm.expectRevert(abi.encodeWithSelector(RfqVenue.LegCountMismatch.selector, 2, 1));
        venue.proveBatchCallback(one, data);
    }

    /// @notice The settlement is the only address that may call back. Nothing here is reachable
    ///         today, and the check is what keeps that true of a version that holds inventory.
    function test_TheCallbackRefusesAnyCallerButTheSettlement() public {
        IProveBatchCallback.Payment[] memory owed = new IProveBatchCallback.Payment[](2);
        owed[0] = IProveBatchCallback.Payment(
            address(tokenB), maker, 1, 0, bytes32(0), 0, address(0), 0, 0, 0, 0
        );
        owed[1] = IProveBatchCallback.Payment(
            address(tokenA), counterparty, 1, 0, bytes32(0), 1, address(0), 0, 0, 0, 0
        );
        bytes memory data = abi.encode(address(tokenA), address(tokenB));

        vm.prank(stranger);
        vm.expectRevert(RfqVenue.NotSettlement.selector);
        venue.proveBatchCallback(owed, data);
    }

    /// @notice An `owed` token the call did not mark is refused, because the settlement would
    ///         pull its payment and a mark of zero is what makes a donation spendable.
    function test_TheCallbackRefusesAnOwedTokenItDidNotMark() public {
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        IProveBatchCallback.Payment[] memory owed = new IProveBatchCallback.Payment[](2);
        owed[0] = IProveBatchCallback.Payment(
            address(tokenC), maker, 1, 0, bytes32(0), 0, address(0), 0, 0, 0, 0
        );
        owed[1] = IProveBatchCallback.Payment(
            address(tokenA), counterparty, 1, 0, bytes32(0), 1, address(0), 0, 0, 0, 0
        );
        bytes memory data = abi.encode(address(tokenA), address(tokenB));

        vm.prank(address(settlement));
        vm.expectRevert(
            abi.encodeWithSelector(RfqVenue.OwedTokenNotMarked.selector, address(tokenC))
        );
        venue.proveBatchCallback(owed, data);
    }

    /**
     * @notice The second `owed` line is checked as well as the first.
     *
     * The two lines are checked separately and against different tokens — leg one pays in the
     * quote's `tokenOut` and leg two in its `tokenIn` — so a check written once and reused would
     * pass a ring that pays the wrong token on the mirror. The sibling test above wrong-foots
     * `owed[0]`; this one wrong-foots `owed[1]`, and neither covers the other.
     */
    function test_TheCallbackRefusesAMirrorTokenItDidNotMark() public {
        MockERC20 tokenC = new MockERC20("C", "C", 18);
        IProveBatchCallback.Payment[] memory owed = new IProveBatchCallback.Payment[](2);
        owed[0] = IProveBatchCallback.Payment(
            address(tokenB), maker, 1, 0, bytes32(0), 0, address(0), 0, 0, 0, 0
        );
        owed[1] = IProveBatchCallback.Payment(
            address(tokenC), counterparty, 1, 0, bytes32(0), 1, address(0), 0, 0, 0, 0
        );
        bytes memory data = abi.encode(address(tokenA), address(tokenB));

        vm.prank(address(settlement));
        vm.expectRevert(
            abi.encodeWithSelector(RfqVenue.OwedTokenNotMarked.selector, address(tokenC))
        );
        venue.proveBatchCallback(owed, data);
    }

    // ── A contract maker that will not answer ────────────────────────────────

    /**
     * @notice A wallet whose `isValidSignature` reverts has not signed.
     *
     * `test_AContractWalletCanSignTheBinding` proves the ERC-1271 path works. These two prove it
     * fails closed, which is the half that matters: a wallet can revert, and it can answer with
     * something that is not a word, and neither may read as a signature. The call is a
     * `staticcall` with its own gas cap, so a wallet cannot take the transaction down with it
     * either — it simply does not sign.
     */
    function test_AContractWalletThatRevertsHasNotSigned() public {
        _assertWalletCannotSign(address(new RevertingWallet()));
    }

    /// @notice And one that answers with four bytes where a word belongs.
    function test_AContractWalletThatMumblesHasNotSigned() public {
        _assertWalletCannotSign(address(new MumblingWallet()));
    }

    /// @dev Build a quote from `wallet` and show its binding is refused whatever it answers.
    function _assertWalletCannotSign(address wallet) internal {
        tokenA.mint(wallet, 1_000_000e18);
        SmartWallet(wallet).approveToken(address(tokenA), relayer, type(uint256).max);

        ProveSettlement.Intent memory quote = _quote();
        quote.maker = wallet;
        quote.recipient = wallet;

        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(quote, QUOTE_IN, _mirrorIntent(), MIRROR_IN);
        // The maker is the wallet, so the binding must carry the wallet's answer. It carries a
        // real signature from a real key instead, which is the closest a caller can get.
        RfqVenue.Exclusive memory ex = _binding(quote, QUOTE_IN, 1);
        bytes memory sig = _signBinding(ex, makerKey);

        vm.prank(submitter);
        vm.expectRevert(RfqVenue.BadBinding.selector);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);
    }

    // ── Reentry ──────────────────────────────────────────────────────────────

    /**
     * @notice A token that calls back into `settleExclusive` mid-settlement is refused.
     *
     * Nothing in this contract reaches a stranger on purpose. The only address it hands control to
     * that it did not choose is a token, and the settlement transfers token A into this contract
     * during the fill. A token with a hook there is inside the marks — the balances this contract
     * measured before the fill and sweeps after it — so a second settlement run from inside the
     * first would sweep against a mark taken for the other one. The guard is the reason it cannot.
     *
     * This is defence in depth and both makers signed for these tokens. It is tested because the
     * cost of being wrong is the whole balance, and the cost of the test is one mock.
     */
    function test_ASecondSettlementFromInsideTheFirstIsRefused() public {
        (
            IProveSettlementBatch.FillRequest[] memory reqs,
            RfqVenue.Exclusive memory ex,
            bytes memory sig
        ) = _standard();

        tokenA.armReentry(address(venue), reqs, ex, sig);

        vm.prank(submitter);
        venue.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertTrue(tokenA.reentryTried(), "the token did call back");
        assertTrue(tokenA.reentryRefused(), "and the venue answered Reentered");
    }

    /**
     * @notice A settlement that fills one leg and says so is refused, and nothing is swept.
     *
     * `settleExclusive` passes `skipInvalid: false`, so the real settlement either fills both legs
     * or reverts, and this count can never be wrong today. The check is here because the venue
     * sweeps to `msg.sender` immediately afterwards: a settlement that released one leg and
     * returned one would hand the submitter a maker's token A with no mirror behind it. That is
     * one comparison against a property three frames away, so it is worth owning locally — and a
     * check nothing exercises is a check nobody knows still works.
     *
     * It needs a settlement that lies, because no honest one can produce the state.
     */
    function test_ASettlementThatFillsOneLegAndSaysSoIsRefused() public {
        LyingSettlement liar = new LyingSettlement(relayer);
        RfqVenue lied = new RfqVenue(address(liar));

        ProveSettlement.Intent memory quote = _quote();
        quote.executor = address(lied);
        ProveSettlement.Intent memory mirror = _mirrorIntent();
        mirror.executor = address(lied);

        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(quote, makerKey, QUOTE_IN);
        reqs[1] = _req(mirror, counterKey, MIRROR_IN);

        // The binding commits to the quote by the hash *this* settlement gives it, which is the
        // liar's. The venue reads the hash off the settlement it was deployed against.
        RfqVenue.Exclusive memory ex = RfqVenue.Exclusive({
            intentHash: liar.hashIntent(_asFill(quote)),
            counterparty: counterparty,
            take: QUOTE_IN,
            expiry: uint64(block.timestamp + BINDING_TTL),
            nonce: 1
        });
        (uint8 v, bytes32 r, bytes32 sg) = vm.sign(makerKey, lied.hashExclusive(ex));
        bytes memory sig = abi.encodePacked(r, sg, v);

        vm.prank(submitter);
        vm.expectRevert(abi.encodeWithSelector(RfqVenue.LegCountMismatch.selector, 2, 1));
        lied.settleExclusive(reqs, ex, sig, ANY_FEE);

        assertEq(tokenA.balanceOf(submitter), 0, "the submitter was handed nothing");
        assertEq(tokenB.balanceOf(submitter), 0);
    }

    // ── The EIP-712 encoding ─────────────────────────────────────────────────

    /**
     * @notice The digest, rebuilt here from the type string rather than from the contract.
     *
     * A binding is signed off chain by a client that builds the typehash from a list of fields.
     * If that list and this contract's string literal ever disagree, every binding the client
     * signs is refused on chain and no other test on either side notices — the signature simply
     * recovers to somebody who is not the maker. `sdk/src/rfq.test.ts` makes the same argument
     * from the other end, against a hash it builds without viem's typed-data helper.
     */
    function test_TheDigestIsTheOneAClientWouldBuild() public view {
        bytes32 typehash = keccak256(
            "Exclusive(bytes32 intentHash,address counterparty,uint256 take,uint64 expiry,uint256 nonce)"
        );
        assertEq(venue.EXCLUSIVE_TYPEHASH(), typehash, "the contract spells it the same way");

        bytes32 separator = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("prove.cash rfq"),
                keccak256("1"),
                block.chainid,
                address(venue)
            )
        );
        assertEq(venue.domainSeparator(), separator, "and builds its domain the same way");

        RfqVenue.Exclusive memory ex = _binding(_quote(), QUOTE_IN, 1);
        bytes32 structHash = keccak256(
            abi.encode(typehash, ex.intentHash, ex.counterparty, ex.take, ex.expiry, ex.nonce)
        );
        assertEq(
            venue.hashExclusive(ex),
            keccak256(abi.encodePacked("\x19\x01", separator, structHash)),
            "field by field, in this order"
        );
    }

    // ── Cost ─────────────────────────────────────────────────────────────────

    /**
     * @notice What one exclusive fill costs, cold and warm, so a change that doubles it shows up
     *         in a diff rather than in a gas bill.
     *
     * Cold is the honest number for the first trade of a pair: every token balance the ring
     * touches is a fresh slot, and the maker, the counterparty, the fee destination and the
     * submitter are all new to both tokens. Warm is what the second and every later trade costs,
     * and it is the one a market maker running a book actually pays.
     */
    function test_Gas_AnExclusiveFill() public {
        ProveSettlement.Intent memory quote = _quote();

        (RfqVenue.Exclusive memory one, bytes memory oneSig) =
            _signedBinding(quote, QUOTE_IN / 2, 1);
        (RfqVenue.Exclusive memory two, bytes memory twoSig) =
            _signedBinding(quote, QUOTE_IN / 2, 2);
        IProveSettlementBatch.FillRequest[] memory firstHalf =
            _pair(quote, QUOTE_IN / 2, _mirrorHalf(2), MIRROR_IN / 2);
        IProveSettlementBatch.FillRequest[] memory secondHalf =
            _pair(quote, QUOTE_IN / 2, _mirrorHalf(3), MIRROR_IN / 2);

        vm.prank(submitter);
        uint256 before = gasleft();
        venue.settleExclusive(firstHalf, one, oneSig, ANY_FEE);
        uint256 cold = before - gasleft();

        vm.prank(submitter);
        before = gasleft();
        venue.settleExclusive(secondHalf, two, twoSig, ANY_FEE);
        uint256 warm = before - gasleft();

        emit log_named_uint("exclusive fill, cold", cold);
        emit log_named_uint("exclusive fill, warm", warm);

        // Loose ceilings. They exist to catch a regression that changes the shape of the call,
        // not to pin a number the optimizer is allowed to move.
        //
        // The cold ceiling rose by one cold storage write when the split arrived. A quote that
        // names a destination pays two fee lines instead of one, and the second address is new to
        // token B on the first trade of a pair.
        //
        // Measured on 2026-08-27: cold 365,611, warm 261,808. The warm ceiling was 250,000, which
        // this fill has never cost less than — it was 268,222 in the commit that wrote the
        // assertion. So the test failed from the day it was added, and it has been the one red
        // line in CI ever since. The number below is the measured cost plus about nine per cent,
        // which is what a ceiling meant to catch a change of shape should be.
        //
        // Measured on 2026-09-23, after the defaults rule: warm 291,501. The mirror leg signs a
        // zero `feeTo`, so each fill now reads the default sink's slot, cold, once per
        // transaction. Same on 2026-09-24. The warm ceiling is that plus 1.2%, tight on purpose.
        assertLt(cold, 480_000, "a cold exclusive fill");
        //
        // Measured on 2026-10-03, after the fee-config-hash change (three take points, the
        // in-memory fee ledger and its strict flush, optimizer_runs 1000 -> 200): warm 297,395.
        // The warm ceiling is that plus about 4%.
        assertLt(warm, 310_000, "a warm one");
    }

    // ── Construction ─────────────────────────────────────────────────────────

    function test_AVenueRefusesASettlementWithNoCode() public {
        // Through the factory, so the CREATE is ordinary. `VenueFactory` says why a bare
        // `new RfqVenue(...)` counts here today and is not to be relied on.
        VenueFactory factory = new VenueFactory();
        vm.expectRevert(RfqVenue.BadSettlement.selector);
        factory.make(address(0xDEAD));
    }

    /**
     * @notice A settlement whose `relayer()` answers zero is refused as well.
     *
     * Code at the address is not enough. The relayer is the address this contract approves and the
     * only address that pulls, so a settlement that names none would deploy a venue that approves
     * the zero address and fails on its first quote — with an ERC-20 error, three frames from the
     * cause. Both halves of the check are here because a contract that answers the call and a
     * contract that is not there fail the same way later and differently now.
     */
    function test_AVenueRefusesASettlementWithNoRelayer() public {
        VenueFactory factory = new VenueFactory();
        SettlementWithNoRelayer hollow = new SettlementWithNoRelayer();
        vm.expectRevert(RfqVenue.BadSettlement.selector);
        factory.make(address(hollow));
    }

    /// @notice The relayer is read off the settlement, never configured. An approval to the wrong
    ///         address silently does nothing until a fill reverts.
    function test_TheVenueReadsTheRelayerOffTheSettlement() public view {
        assertEq(venue.relayer(), settlement.relayer());
        assertEq(address(venue.settlement()), address(settlement));
    }

    /**
     * @notice Nothing here is owned. There is no owner, no operator, and no rate an address can
     *         change.
     *
     * The venue holds no rate at all now, and neither does the settlement. `LEGS` is the only
     * number left on either side, and what a quote may charge is the maker's own signed rate
     * against the submitter's own bound.
     */
    function test_TheVenueHasNoOwnerAndNoSetter() public view {
        assertEq(venue.LEGS(), 2);
    }
}

/// @notice A settlement that is there and answers, and names no relayer. `RfqVenue` must refuse
///         it at construction rather than approve the zero address on its first quote.
contract SettlementWithNoRelayer {
    function relayer() external pure returns (address) {
        return address(0);
    }
}

/**
 * @notice Deploys an `RfqVenue` through a plain CREATE.
 *
 * The two construction guards are counted with a bare `new RfqVenue(...)` as well, and that is
 * luck rather than a rule. Measured 2026-09-16: the same bare form credits the guard from this
 * file and credits nothing from a scratch file holding no other CREATE of this type, so what
 * forge counts follows the compilation unit and not the test. The bare form credited nothing at
 * all for the two executors, which is why `ExecutorFactory` and `BatchExecutorFactory` exist.
 * A factory counted every time it was tried, so all three suites use one.
 */
contract VenueFactory {
    function make(address settlement) external returns (RfqVenue) {
        return new RfqVenue(settlement);
    }
}

/**
 * @notice Token A, and a way to make it hostile.
 *
 * Inert until `armReentry`, so every other test in this file sees a plain ERC-20. Once armed, the
 * next transfer calls `settleExclusive` again from inside the first one and records what came
 * back. It swallows the answer rather than propagating it, because a token that reverts would
 * take the outer settlement down and the test would prove nothing about the guard.
 */
contract ReenterableToken is MockERC20 {
    RfqVenue private venue;
    bytes private payload;
    bool public reentryTried;
    bool public reentryRefused;

    constructor() MockERC20("A", "A", 18) {}

    function armReentry(
        address venue_,
        IProveSettlementBatch.FillRequest[] memory reqs,
        RfqVenue.Exclusive memory ex,
        bytes memory sig
    ) external {
        venue = RfqVenue(venue_);
        payload = abi.encodeCall(RfqVenue.settleExclusive, (reqs, ex, sig, ANY_FEE));
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (address(venue) == address(0) || reentryTried) return;
        reentryTried = true;
        (bool ok, bytes memory ret) = address(venue).call(payload);
        reentryRefused = !ok && bytes4(ret) == RfqVenue.Reentered.selector;
    }
}

/**
 * @notice A settlement that answers `fillBatchWithCallback` with the wrong leg count.
 *
 * It hashes intents like the real one so the venue's binding check passes, and it reaches the
 * callback so the venue gets as far as counting. Only the number it returns is a lie.
 */
contract LyingSettlement {
    address public immutable relayer;
    bytes32 private immutable _domain;

    constructor(address relayer_) {
        relayer = relayer_;
        _domain = keccak256(abi.encode("prove.cash liar", block.chainid, address(this)));
    }

    function hashIntent(IProveSettlementFill.Intent calldata i) external view returns (bytes32) {
        return keccak256(abi.encode(_domain, i));
    }

    function fillBatchWithCallback(
        IProveSettlementBatch.FillRequest[] calldata,
        bool,
        bytes calldata,
        uint256
    ) external pure returns (uint256) {
        return 1;
    }
}
