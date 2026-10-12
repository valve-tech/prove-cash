// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION
} from "../Fees.sol";
import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../../src/ProveSettlement.sol";
import {RfqVenue} from "../../src/RfqVenue.sol";
import {IProveSettlementBatch} from "../../src/ProveBatchExecutor.sol";
import {IProveSettlementFill} from "../../src/ProveExecutor.sol";
import {ANY_FEE, MockERC20} from "../Mocks.sol";

/**
 * @notice Drives `RfqVenue` the way a live desk would: one maker quoting exclusively, one
 *         counterparty accepting, two submitters racing for the spread, a stranger reaching for
 *         quotes that are not theirs, strangers donating tokens, and time that moves.
 *
 * Every action bounds its own inputs and returns early rather than reverting, so a run spends
 * its depth on real state transitions instead of on calls that bounce at the door.
 *
 * **The ring is built fresh inside each action.** `ProveSettlement._termsOk` refuses a wallet
 * intent whose window is wider than an hour, so a fixed set of intents signed in the constructor
 * would go dead on the first time skip and the good path would never land again.
 *
 * **Every ghost number here comes from the signed terms, never from the contract.** `_deliver`
 * and `_fee` reimplement the settlement's arithmetic from the intent alone. A ghost that asks
 * `quote()` can only ever agree with the contract, and the invariants would prove nothing.
 */
contract RfqVenueHandler is Test {
    ProveSettlement public immutable settlement;
    RfqVenue public immutable venue;
    MockERC20 public immutable tokenA;
    MockERC20 public immutable tokenB;

    // ── The fee terms the ghost book assumes ─────────────────────────────────

    /// @dev One, in the unit a rate is counted in. Written out, not read back: a ghost
    ///      that fetched the contract's constant would move with it and witness nothing.
    uint256 constant WAD = 1e18;

    /// @dev The widest rate this handler quotes. The handler's own bound: the settlement caps
    ///      no rate, so there is nothing here to mirror.
    uint256 constant MAX_FEE_RATE = 0.01e18; // One per cent.

    /// @dev How long a binding stands here. The mirror is built to the same second, because
    ///      `_checkBinding` refuses an acceptance that outlives the binding it answers.
    uint64 constant BINDING_TTL = 30;

    // ── Cast ─────────────────────────────────────────────────────────────────

    address public maker;
    uint256 private makerKey;
    address public counterparty;
    uint256 private counterKey;
    /// @dev Holds token B and an allowance, and is never the address a binding names.
    address public stranger;
    uint256 private strangerKey;

    /// @notice Whoever submits the pair keeps the spread. Two of them, so the fuzzer can vary
    ///         who earns it, and the invariant checks the pair of them together.
    address[2] public submitters = [address(0x5AB1), address(0x5AB2)];

    /// @notice The destination some quotes name for their own share of the fee.
    address public constant QUOTE_FEE_TO = address(0xFEE1);

    // ── Ghost books ──────────────────────────────────────────────────────────

    /// @notice Every wei anybody has ever pushed at the venue for free. It must all still be
    ///         there: the venue may only spend what a ring earned it in the same transaction.
    uint256 public ghostDonatedA;
    uint256 public ghostDonatedB;

    /// @notice Token B the quotes owed their maker, at the rate the maker signed.
    uint256 public ghostMakerOwedB;
    /// @notice Token A the mirrors owed the counterparty, at the rate they signed.
    uint256 public ghostCounterOwedA;

    /// @notice The whole fee both legs paid, by token, however the settlement divided it.
    uint256 public ghostFeeA;
    uint256 public ghostFeeB;

    /// @notice What the rings left over, and so what the submitters must be holding.
    uint256 public ghostSweptA;
    uint256 public ghostSweptB;

    uint256 public ghostSettles;
    /// @notice Two legs a settled ring, counted one settlement at a time.
    uint256 public ghostLegs;

    /**
     * @notice Every binding this handler has settled. Bounded, so the invariant loops stay short.
     *
     * The array is capped; the duplicate check is not. `_seen` is a mapping, so a binding that
     * settles twice is caught however many rings ran before it.
     */
    uint256 constant MAX_TRACKED = 32;
    bytes32[] private _tracked;
    mapping(bytes32 => bool) private _seen;
    bool public ghostDoubleSettle;

    /// @notice A ring the venue had to refuse and did not. Any value but zero is a hole.
    uint256 public ghostBadAccepted;

    // ── Call counters ────────────────────────────────────────────────────────

    uint256 public callsSettle;
    uint256 public callsReplay;
    uint256 public callsWrongParty;
    uint256 public callsExpired;
    uint256 public callsOpenExecutor;
    uint256 public callsWrongTake;
    uint256 public callsDonate;
    uint256 public callsSkip;

    /// @dev The last ring that settled, encoded whole, so a later action can try it again from a
    ///      different sender and several fills further on. That distance is the point: a replay
    ///      one line after the original proves less than one that survived the run.
    bytes private _lastPayload;

    uint256 private _nonce;

    constructor(
        ProveSettlement _settlement,
        RfqVenue _venue,
        MockERC20 _tokenA,
        MockERC20 _tokenB
    ) {
        settlement = _settlement;
        venue = _venue;
        tokenA = _tokenA;
        tokenB = _tokenB;

        (maker, makerKey) = makeAddrAndKey("rfq maker");
        (counterparty, counterKey) = makeAddrAndKey("rfq counterparty");
        (stranger, strangerKey) = makeAddrAndKey("rfq stranger");

        // Read once. `vm.prank` is single-shot, so `settlement.relayer()` inside a pranked line
        // would eat the prank and the approval would come from this contract.
        address pull = _settlement.relayer();

        // The maker sells token A and the two takers sell token B. Nobody starts holding the
        // token they receive, which is what lets the invariants compare a balance to a ghost.
        _tokenA.mint(maker, 1_000_000_000e18);
        vm.prank(maker);
        _tokenA.approve(pull, type(uint256).max);

        _tokenB.mint(counterparty, 1_000_000_000e18);
        vm.prank(counterparty);
        _tokenB.approve(pull, type(uint256).max);

        _tokenB.mint(stranger, 1_000_000_000e18);
        vm.prank(stranger);
        _tokenB.approve(pull, type(uint256).max);
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    /**
     * @notice The whole product: a reserved price, taken by the address it was reserved for.
     *
     * The submitter keeps whatever the two legs leave over, and the ring is shaped so there is
     * always something to keep. A shape that would end below either mark is dropped here rather
     * than sent, so a bounced call does not eat a step of the run.
     */
    function settleAnExclusive(uint256 sizeSeed, uint256 takeSeed, uint256 feeSeed, uint256 whoSeed)
        external
    {
        Ring memory ring = _buildRing(sizeSeed, takeSeed, feeSeed, counterparty);
        if (!ring.viable) return;

        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(ring, counterKey, ring.take, ring.mirrorTake);
        RfqVenue.Exclusive memory ex = _binding(
            ring.quoteHash, counterparty, ring.take, uint64(block.timestamp + BINDING_TTL)
        );
        bytes memory sig = _signBinding(ex, makerKey);

        vm.prank(submitters[whoSeed % submitters.length]);
        try venue.settleExclusive(reqs, ex, sig, ANY_FEE) returns (bytes32 binding) {
            callsSettle++;
            _book(ring, binding);
            _lastPayload = abi.encodeCall(RfqVenue.settleExclusive, (reqs, ex, sig, ANY_FEE));
        } catch {}
    }

    /// @notice Send the last ring that worked, again. A binding is one-shot, so this must fail
    ///         however far along the run it lands and whoever sends it.
    function settleASpentBinding(uint256 whoSeed) external {
        if (_lastPayload.length == 0) return;

        vm.prank(submitters[whoSeed % submitters.length]);
        (bool ok,) = address(venue).call(_lastPayload);
        if (ok) {
            ghostBadAccepted++;
            return;
        }
        callsReplay++;
    }

    /// @notice A stranger puts up their own mirror against a quote reserved for somebody else.
    ///         The binding names the counterparty, so the venue must refuse the pairing.
    function settleForTheWrongCounterparty(uint256 sizeSeed, uint256 takeSeed, uint256 feeSeed)
        external
    {
        Ring memory ring = _buildRing(sizeSeed, takeSeed, feeSeed, stranger);
        if (!ring.viable) return;

        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(ring, strangerKey, ring.take, ring.mirrorTake);
        RfqVenue.Exclusive memory ex = _binding(
            ring.quoteHash, counterparty, ring.take, uint64(block.timestamp + BINDING_TTL)
        );
        bytes memory sig = _signBinding(ex, makerKey);

        _mustRefuse(reqs, ex, sig);
        callsWrongParty++;
    }

    /// @notice A binding whose moment has passed. An RFQ is quoted for seconds and the venue
    ///         holds the clock, not the intent's own hour-long window.
    function settleAnExpiredBinding(uint256 sizeSeed, uint256 takeSeed, uint256 feeSeed) external {
        Ring memory ring = _buildRing(sizeSeed, takeSeed, feeSeed, counterparty);
        if (!ring.viable) return;

        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(ring, counterKey, ring.take, ring.mirrorTake);
        // Expiry is exclusive, so this instant is already too late.
        RfqVenue.Exclusive memory ex =
            _binding(ring.quoteHash, counterparty, ring.take, uint64(block.timestamp));
        bytes memory sig = _signBinding(ex, makerKey);

        _mustRefuse(reqs, ex, sig);
        callsExpired++;
    }

    /// @notice A quote anybody could have filled on the settlement is not an exclusive quote.
    ///         The venue reads `executor` itself rather than trusting whoever built the intent.
    function settleAnOpenQuote(uint256 sizeSeed, uint256 takeSeed, uint256 feeSeed) external {
        Ring memory ring = _buildRing(sizeSeed, takeSeed, feeSeed, counterparty);
        if (!ring.viable) return;

        ring.quote.executor = address(0);
        ring.quoteHash = settlement.hashIntent(ring.quote);

        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(ring, counterKey, ring.take, ring.mirrorTake);
        RfqVenue.Exclusive memory ex = _binding(
            ring.quoteHash, counterparty, ring.take, uint64(block.timestamp + BINDING_TTL)
        );
        bytes memory sig = _signBinding(ex, makerKey);

        _mustRefuse(reqs, ex, sig);
        callsOpenExecutor++;
    }

    /// @notice The binding names the size, exactly. Burning a thousand-unit quote on one wei is
    ///         the shape this refusal exists to stop.
    function settleATakeTheMakerDidNotSign(
        uint256 sizeSeed,
        uint256 takeSeed,
        uint256 feeSeed,
        uint256 driftSeed
    ) external {
        Ring memory ring = _buildRing(sizeSeed, takeSeed, feeSeed, counterparty);
        if (!ring.viable) return;

        uint256 signedTake = ring.take + bound(driftSeed, 1, 1_000e18);

        IProveSettlementBatch.FillRequest[] memory reqs =
            _pair(ring, counterKey, ring.take, ring.mirrorTake);
        RfqVenue.Exclusive memory ex = _binding(
            ring.quoteHash, counterparty, signedTake, uint64(block.timestamp + BINDING_TTL)
        );
        bytes memory sig = _signBinding(ex, makerKey);

        _mustRefuse(reqs, ex, sig);
        callsWrongTake++;
    }

    /// @notice Push tokens at the venue for nothing, by accident or on purpose. Whatever runs
    ///         afterwards, this money is still here at the end.
    function donate(uint256 which, uint256 amount) external {
        uint256 gift = bound(amount, 1, 1_000e18);
        if (which % 2 == 0) {
            tokenA.mint(address(venue), gift);
            ghostDonatedA += gift;
        } else {
            tokenB.mint(address(venue), gift);
            ghostDonatedB += gift;
        }
        callsDonate++;
    }

    /// @notice Move the clock. Every ring is built at the current moment, so this ages bindings
    ///         and expires intents without ever killing the good path.
    function skipTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 hours));
        callsSkip++;
    }

    // ── Views the invariants read ────────────────────────────────────────────

    function trackedCount() external view returns (uint256) {
        return _tracked.length;
    }

    function trackedAt(uint256 k) external view returns (bytes32) {
        return _tracked[k];
    }

    // ── Building a ring ──────────────────────────────────────────────────────

    /**
     * @dev One quote and its mirror, plus every number the ghost book will need.
     *
     * The two sides concede about ten per cent of each leg to each other, which covers both
     * fees at the one per cent ceiling and still leaves the submitter a spread. A tighter ring
     * would spend the run's depth on `BalanceWentDown` reverts instead of on fills.
     */
    struct Ring {
        ProveSettlement.Intent quote;
        ProveSettlement.Intent mirror;
        bytes32 quoteHash;
        uint256 take;
        uint256 mirrorTake;
        uint256 owedToMaker;
        uint256 owedToCounter;
        uint256 feeOnQuote;
        uint256 feeOnMirror;
        uint256 sweepA;
        uint256 sweepB;
        bool viable;
    }

    function _buildRing(uint256 sizeSeed, uint256 takeSeed, uint256 feeSeed, address mirrorMaker)
        private
        returns (Ring memory ring)
    {
        uint256 amountIn = bound(sizeSeed, 10e18, 1_000e18);
        uint256 minOut = amountIn / 10;
        bool inSlices = feeSeed % 2 == 0;

        ring.take = inSlices ? bound(takeSeed, amountIn / 2, amountIn) : amountIn;

        ring.quote = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: amountIn,
            minOutStart: minOut,
            minOutEnd: minOut,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 30 minutes),
            executor: address(venue),
            // Half the quotes name a sink and half name none. A quote that names none signs a
            // zero rate and charges nothing, so the ghost book has to survive both shapes. A
            // positive rate with no sink is bad terms and would never fill.
            feeConfig: feeCfg(feeSeed % 4 < 2 ? QUOTE_FEE_TO : address(0)),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: feeSeed % 4 < 2 ? uint64(bound(feeSeed, 0, MAX_FEE_RATE)) : 0,
            minFill: 0,
            authNonce: bytes32(0),
            flags: inSlices ? settlement.FLAG_PARTIAL() : 0,
            nonce: ++_nonce,
            curve: bytes32(0)
        });

        // The mirror pays about a tenth more token B than the quote asks, and asks about a tenth
        // less token A than the quote releases. That concession is the spread.
        ring.mirrorTake = (ring.take * 11) / 100;
        uint256 mirrorMinOut = (ring.take * 9) / 10;
        if (ring.mirrorTake == 0 || mirrorMinOut == 0) return ring;

        ring.mirror = ProveSettlement.Intent({
            maker: mirrorMaker,
            recipient: mirrorMaker,
            tokenIn: address(tokenB),
            tokenOut: address(tokenA),
            amountIn: ring.mirrorTake,
            minOutStart: mirrorMinOut,
            minOutEnd: mirrorMinOut,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + BINDING_TTL),
            executor: address(venue),
            feeConfig: bytes32(0),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0,
            minFill: 0,
            authNonce: bytes32(0),
            flags: 0,
            nonce: ++_nonce,
            curve: bytes32(0)
        });

        // The curve's number for each leg, and the fee each leg's own maker pays out of it.
        uint256 grossToMaker = _deliver(ring.take, minOut, amountIn);
        uint256 grossToCounter = mirrorMinOut;
        ring.feeOnQuote = _fee(grossToMaker, ring.quote.feeConfig, ring.quote.feeRateProceeds);
        ring.feeOnMirror = _fee(grossToCounter, ring.mirror.feeConfig, ring.mirror.feeRateProceeds);
        ring.owedToMaker = grossToMaker - ring.feeOnQuote;
        ring.owedToCounter = grossToCounter - ring.feeOnMirror;

        // Token A arrives from the quote and leaves to pay the mirror; token B the other way.
        // Each leg costs its own gross, fee included, so the rates do not enter these two sums.
        uint256 outA = grossToCounter;
        uint256 outB = grossToMaker;
        if (outA > ring.take || outB > ring.mirrorTake) return ring;
        ring.sweepA = ring.take - outA;
        ring.sweepB = ring.mirrorTake - outB;

        if (tokenA.balanceOf(maker) < ring.take) return ring;
        if (tokenB.balanceOf(mirrorMaker) < ring.mirrorTake) return ring;

        ring.quoteHash = settlement.hashIntent(ring.quote);
        ring.viable = true;
    }

    /// @dev What one leg delivers, worked out from the signed terms. The curve is flat here, so
    ///      `minOutAt` is the signed minimum and the clock does not enter into it.
    function _deliver(uint256 take, uint256 minOut, uint256 amountIn)
        private
        pure
        returns (uint256)
    {
        return _ceilDiv(take * minOut, amountIn);
    }

    /// @dev What one leg's own maker pays out of the gross. The intent's own rate is the whole
    ///      of it, a leg that names no destination charges nothing whatever rate it signed, and
    ///      the division floors so the dust stays with the maker.
    function _fee(uint256 gross, bytes32 feeTo, uint64 feeRate) private pure returns (uint256) {
        if (feeTo == bytes32(0)) return 0;
        return (gross * uint256(feeRate)) / WAD;
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    // ── Plumbing ─────────────────────────────────────────────────────────────

    function _pair(Ring memory ring, uint256 mirrorKey, uint256 take, uint256 mirrorTake)
        private
        view
        returns (IProveSettlementBatch.FillRequest[] memory reqs)
    {
        reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = IProveSettlementBatch.FillRequest({
            intent: _asFill(ring.quote),
            signature: _sign(ring.quote, makerKey),
            take: take,
            arming: ""
        });
        reqs[1] = IProveSettlementBatch.FillRequest({
            intent: _asFill(ring.mirror),
            signature: _sign(ring.mirror, mirrorKey),
            take: mirrorTake,
            arming: ""
        });
    }

    function _binding(bytes32 intentHash, address who, uint256 take, uint64 expiry)
        private
        returns (RfqVenue.Exclusive memory)
    {
        return RfqVenue.Exclusive({
            intentHash: intentHash, counterparty: who, take: take, expiry: expiry, nonce: ++_nonce
        });
    }

    function _signBinding(RfqVenue.Exclusive memory ex, uint256 key)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, venue.hashExclusive(ex));
        return abi.encodePacked(r, s, v);
    }

    function _sign(ProveSettlement.Intent memory i, uint256 key)
        private
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /// @dev The settlement's `Intent` in the executor interface's mirror of it, field for field.
    function _asFill(ProveSettlement.Intent memory i)
        private
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

    /// @dev Send a ring the venue has to turn away. A ring that lands instead is recorded rather
    ///      than asserted here: the invariant is the place that fails a run.
    function _mustRefuse(
        IProveSettlementBatch.FillRequest[] memory reqs,
        RfqVenue.Exclusive memory ex,
        bytes memory sig
    ) private {
        try venue.settleExclusive(reqs, ex, sig, ANY_FEE) {
            ghostBadAccepted++;
        } catch {}
    }

    // ── Books ────────────────────────────────────────────────────────────────

    function _book(Ring memory ring, bytes32 binding) private {
        if (_seen[binding]) ghostDoubleSettle = true;
        _seen[binding] = true;
        if (_tracked.length < MAX_TRACKED) _tracked.push(binding);

        ghostSettles++;
        // Two, written here rather than read from `LEGS`, so the invariant that compares the two
        // is comparing this handler's belief against the contract's and not against itself.
        ghostLegs += 2;

        ghostMakerOwedB += ring.owedToMaker;
        ghostCounterOwedA += ring.owedToCounter;
        ghostFeeA += ring.feeOnMirror;
        ghostFeeB += ring.feeOnQuote;
        ghostSweptA += ring.sweepA;
        ghostSweptB += ring.sweepB;
    }
}
