// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {ProveSettlement} from "./ProveSettlement.sol";
import {FeeConfig} from "./FeeConfig.sol";
import {FeeConfigView} from "./FeeConfigView.sol";
import {TakePoints} from "./TakePoints.sol";
import {IntentTerms} from "./IntentTerms.sol";
import {IProveCallback} from "./interfaces/IProveCallback.sol";
import {IProveSettlementRead, IFeeDefaultsRead} from "./interfaces/IProveSettlementRead.sol";

/**
 * @title ProveReader
 * @notice One call that explains an intent to every audience: the user (what they pay and receive,
 *         net), the solver (the exact numbers at the three take points and the callback `Terms`)
 *         and anyone (the config hash and its destinations, the reserved and claimable book, the
 *         defaults). View only, meant for `eth_call`.
 *
 * **Nothing here is a rule.** The numbers are the settlement's: the reader calls the deployed
 * settlement's own `quote`, and derives everything else with the same `TakePoints` library the
 * settlement compiles in, so it cannot disagree with a fill (`test/ProveReader.t.sol` closes the
 * loop against real fills). The settlement never reads, calls or knows this contract.
 *
 * No owner, no setter, no funds. The one state-changing function, `remember`, is a permissionless,
 * append-only, idempotent cache of fee-config preimages keyed by their own hash: it cannot be
 * wrong for its key and changes no validity anywhere.
 *
 * None of the `explain*` functions reverts on a malformed intent: each external read is wrapped,
 * a failure sets a flag and zeroes its section.
 *
 * Spec: `docs/superpowers/specs/2026-10-03-fee-config-hash.md` section 2.11.
 */
contract ProveReader is FeeConfigView {
    // ── Types ────────────────────────────────────────────────────────────────

    enum Rung {
        Approval,
        Escrow,
        Permit2
    }

    /// @dev Where the destinations of `config` came from, in the order they are tried.
    enum ConfigSource {
        Unresolved,
        None,
        Supplied,
        DefaultCurrent,
        DefaultPast,
        Stray,
        Remembered
    }

    struct Identity {
        uint256 chainId;
        address settlement;
        address relayer;
        bytes32 intentHash;
        bytes32 domainSeparator;
        Rung rung;
        bool isPartial;
        uint256 filled;
        uint256 remaining;
        uint256 reservedForIntent;
        uint256 parkedByMaker;
        bool live;
        uint256 take;
        uint256 ts;
        uint256 minOutNow;
        ProveSettlement.Reason reason;
        bool signatureChecked;
    }

    struct MakerView {
        address spendToken;
        uint256 spend;
        address receiveToken;
        uint256 signedMinimum;
        uint256 cutByProceedsFee;
        uint256 receiveNet;
        uint256 priceSigned;
        uint256 priceNet;
        uint256 feeIn;
        uint256 feeOut;
        uint256 feeProceeds;
        uint256 gasCoverIn;
    }

    struct SolverView {
        Rung rung;
        uint256 handedOver;
        uint256 usable;
        uint256 feeInDue;
        IProveCallback.Terms terms;
        uint256 deliverNow;
        address recipient;
        TakePoints.Due[] due;
        TakePoints.Due[] allowance;
        uint256 maxFeeRateNeeded;
        uint256 owedOut;
    }

    struct Payout {
        address destination;
        uint256 weight;
        bool hasCode;
        uint256 ofFeeIn;
        uint256 ofFeeOut;
        uint256 ofFeeProceeds;
    }

    struct ConfigView {
        bytes32 hash;
        ConfigSource source;
        uint256 version;
        bool resolved;
        bool hashMatches;
        FeeConfig.Fault fault;
        Payout[] payouts;
    }

    struct DefaultsView {
        bool present;
        uint256 version;
        bytes32 defaultsHash;
        bytes32 feeConfig;
        uint64 rateIn;
        uint64 rate;
        uint64 rateProceeds;
        uint64 warnIn;
        uint64 warn;
        uint64 warnProceeds;
        bool isCurrent;
        bool isPast;
        bool aboveWarnIn;
        bool aboveWarn;
        bool aboveWarnProceeds;
    }

    struct BookView {
        uint256 pendingTokenIn;
        uint256 pendingTokenOut;
        uint256 totalTokenIn;
        uint256 totalTokenOut;
        uint256[] claimInByDestination;
        uint256[] claimOutByDestination;
        uint256 strayPendingIn;
        uint256 strayPendingOut;
    }

    struct TokenInfo {
        address token;
        uint8 decimals;
        string symbol;
    }

    struct Explanation {
        Identity identity;
        TakePoints.Quote quote;
        TakePoints.Step[3] steps;
        MakerView maker;
        SolverView solver;
        ConfigView config;
        DefaultsView defaults;
        BookView book;
        TokenInfo[2] tokens;
        uint256 flags;
    }

    // ── Flags (advisory) ─────────────────────────────────────────────────────

    uint256 public constant NOT_LIVE = 1 << 0;
    uint256 public constant QUOTE_FAILED = 1 << 1;
    uint256 public constant FEE_WITHOUT_CONFIG = 1 << 2;
    uint256 public constant RATE_OVER_WAD = 1 << 3;
    uint256 public constant CONFIG_UNRESOLVED = 1 << 4;
    uint256 public constant CONFIG_FAULT = 1 << 5;
    uint256 public constant CONFIG_PREIMAGE_MISMATCH = 1 << 6;
    uint256 public constant DESTINATION_NO_CODE = 1 << 7;
    uint256 public constant CUSTOM_CONFIG = 1 << 8;
    uint256 public constant WARN_IN = 1 << 9;
    uint256 public constant WARN_OUT = 1 << 10;
    uint256 public constant WARN_PROCEEDS = 1 << 11;
    uint256 public constant DEFAULTS_UNREACHABLE = 1 << 12;
    uint256 public constant TAKE_EXCEEDS_REMAINING = 1 << 13;
    uint256 public constant BELOW_MIN_FILL = 1 << 14;
    uint256 public constant PARTIAL_NOT_ALLOWED = 1 << 15;
    uint256 public constant NOT_STARTED = 1 << 16;
    uint256 public constant EXPIRED = 1 << 17;

    // ── State ────────────────────────────────────────────────────────────────

    IProveSettlementRead public immutable settlement;
    /// @dev `address(0)` is allowed: the defaults section is then empty.
    IFeeDefaultsRead public immutable feeDefaults;
    bytes32 private immutable _STRAY;

    FeeConfig.Config private _stray;
    mapping(bytes32 => FeeConfig.Config) private _remembered;

    uint256 private constant META_GAS = 30_000;

    event Remembered(bytes32 indexed feeConfig, address[] destinations, uint256[] weights);

    error InvalidConfig(FeeConfig.Fault fault);
    error StrayMismatch();

    constructor(address settlement_, address feeDefaults_, FeeConfig.Config memory stray) {
        settlement = IProveSettlementRead(settlement_);
        feeDefaults = IFeeDefaultsRead(feeDefaults_);
        bytes32 h = FeeConfig.hash(stray);
        if (h != IProveSettlementRead(settlement_).STRAY_CONFIG()) revert StrayMismatch();
        _STRAY = h;
        _stray = stray;
    }

    // ── Entry points ─────────────────────────────────────────────────────────

    /// @notice Explain an intent as it stands now: `take` is what is still available when the intent
    ///         is live, otherwise `amountIn` (flagged `NOT_LIVE`). The config is resolved by the
    ///         reader alone.
    function explain(ProveSettlement.Intent calldata i) external view returns (Explanation memory) {
        FeeConfig.Config memory none;
        uint256 take = i.amountIn;
        try this.available(i) returns (uint256 remaining, bool live) {
            if (live) take = remaining;
        } catch {}
        return _explain(i, take, block.timestamp, none);
    }

    /// @notice How much of this intent is still available right now, and whether anything can take
    ///         it. Everything a fill checks that does not depend on who is asking: it cannot
    ///         speak for the signature, the maker's allowance or an exclusive executor, so `live`
    ///         is a ceiling and never a promise; `ProveSettlement.fillability` answers for one
    ///         executor and one size. This used to be `ProveSettlement.available`; the same rules,
    ///         read from the settlement's public state, now cost the settlement no bytes.
    function available(ProveSettlement.Intent calldata i)
        external
        view
        returns (uint256 remaining, bool live)
    {
        bytes32 h = settlement.hashIntent(i);
        uint64 c = settlement.cancelledAt(h);
        remaining = i.amountIn - settlement.filled(h);
        live = IntentTerms.ok(i, address(settlement), settlement.relayer()) && remaining > 0
            && !(c != 0 && block.timestamp >= c)
            && uint64(i.nonce) >= settlement.laneFloor(i.maker, uint192(i.nonce >> 64))
            && block.timestamp >= i.startTime && block.timestamp < i.endTime;
    }

    /// @notice Explain a chosen size at a chosen time. `preimage` may be empty to let the reader
    ///         resolve the config; a supplied one that does not hash to `i.feeConfig` is flagged and
    ///         never trusted.
    function explainTake(
        ProveSettlement.Intent calldata i,
        uint256 take,
        uint256 ts,
        FeeConfig.Config calldata preimage
    ) external view returns (Explanation memory) {
        return _explain(i, take, ts, preimage);
    }

    /// @notice Explain the smallest size that owes the maker at least `requiredOut` of tokenOut.
    function explainOut(
        ProveSettlement.Intent calldata i,
        uint256 requiredOut,
        uint256 ts,
        FeeConfig.Config calldata preimage
    ) external view returns (Explanation memory) {
        return _explain(i, takeForOut(i, requiredOut, ts), ts, preimage);
    }

    /// @notice As `explainTake`, plus the one thing an intent alone cannot show: validity under a
    ///         signature and an executor, from the settlement's own `fillability`
    ///         (`maxFeeRate = feeRateIn + feeRate`).
    function explainSigned(
        ProveSettlement.Intent calldata i,
        bytes calldata signature,
        address executor,
        uint256 take,
        uint256 ts,
        FeeConfig.Config calldata preimage
    ) external view returns (Explanation memory e) {
        e = _explain(i, take, ts, preimage);
        try settlement.fillability(
            i, signature, take, executor, uint256(i.feeRateIn) + i.feeRate
        ) returns (
            ProveSettlement.Reason r
        ) {
            e.identity.reason = r;
            e.identity.signatureChecked = true;
        } catch {}
    }

    /// @notice The smallest `take` with `ceilDiv(take * minOutAt(ts), amountIn) >= requiredOut`;
    ///         0 when `requiredOut` or the price is 0 (or the price cannot be read).
    function takeForOut(ProveSettlement.Intent calldata i, uint256 requiredOut, uint256 ts)
        public
        view
        returns (uint256)
    {
        (bool ok, uint256 m) = _read(abi.encodeCall(settlement.minOutAt, (i, ts)));
        return ok ? TakePoints.takeForOut(requiredOut, i.amountIn, m) : 0;
    }

    /// @notice Cache a valid config's preimage under its hash, so `explain` can name its
    ///         destinations. Permissionless, append-only, idempotent. A cache, not a registry: the
    ///         settlement never reads it and an unremembered config is exactly as valid.
    function remember(FeeConfig.Config calldata cfg) external returns (bytes32 h) {
        FeeConfig.Fault f = FeeConfig.fault(cfg);
        if (f != FeeConfig.Fault.None) revert InvalidConfig(f);
        h = FeeConfig.hash(cfg);
        if (_remembered[h].destinations.length == 0) {
            _remembered[h] = cfg;
            emit Remembered(h, cfg.destinations, cfg.weights);
        }
    }

    function remembered(bytes32 h) external view returns (FeeConfig.Config memory) {
        return _remembered[h];
    }

    // ── Assembly of the answer ───────────────────────────────────────────────

    function _explain(
        ProveSettlement.Intent calldata i,
        uint256 take,
        uint256 ts,
        FeeConfig.Config memory preimage
    ) private view returns (Explanation memory e) {
        uint256 flags;
        _identity(e.identity, i, take, ts);
        if (!e.identity.live) flags |= NOT_LIVE;

        TakePoints.Ctx memory c = _ctx(i);
        if (i.feeConfig == bytes32(0) && (i.feeRate | i.feeRateIn | i.feeRateProceeds) != 0) {
            flags |= FEE_WITHOUT_CONFIG;
        }
        if (
            i.feeRate > FeeConfig.WAD || i.feeRateIn > FeeConfig.WAD
                || i.feeRateProceeds > FeeConfig.WAD
        ) {
            flags |= RATE_OVER_WAD;
        }

        try settlement.quote(i, take, ts) returns (TakePoints.Quote memory q) {
            e.quote = q;
            e.steps = TakePoints.steps(q, c);
            _maker(e.maker, q, c);
            _solver(e.solver, q, c, i);
        } catch {
            flags |= QUOTE_FAILED;
        }

        flags |= _config(e.config, e.quote, i, preimage);
        flags |= _defaults(e.defaults, e.config, i);
        _book(e.book, e.config, i);
        e.tokens[0] = _tokenInfo(i.tokenIn);
        e.tokens[1] = _tokenInfo(i.tokenOut);

        // Advisory arithmetic on the intent's own fields. The authority is `identity.reason`.
        if (take > e.identity.remaining) flags |= TAKE_EXCEEDS_REMAINING;
        if (take < i.minFill && take != e.identity.remaining) flags |= BELOW_MIN_FILL;
        if (i.flags & 1 == 0 && take != e.identity.remaining) flags |= PARTIAL_NOT_ALLOWED;
        if (ts < i.startTime) flags |= NOT_STARTED;
        if (ts >= i.endTime) flags |= EXPIRED;
        e.flags = flags;
    }

    function _ctx(ProveSettlement.Intent calldata i)
        private
        pure
        returns (TakePoints.Ctx memory c)
    {
        c.tokenIn = i.tokenIn;
        c.tokenOut = i.tokenOut;
        c.approvalRung = i.flags & 6 == 0; // FLAG_ESCROW | FLAG_PERMIT2
        c.feeConfig = i.feeConfig;
        if (i.feeConfig != bytes32(0)) {
            (c.rateIn, c.rate, c.rateProceeds) = (i.feeRateIn, i.feeRate, i.feeRateProceeds);
        }
    }

    function _identity(
        Identity memory d,
        ProveSettlement.Intent calldata i,
        uint256 take,
        uint256 ts
    ) private view {
        d.chainId = block.chainid;
        d.settlement = address(settlement);
        d.rung = i.flags & 4 != 0 ? Rung.Permit2 : (i.flags & 2 != 0 ? Rung.Escrow : Rung.Approval);
        d.isPartial = i.flags & 1 != 0;
        d.take = take;
        d.ts = ts;
        d.remaining = i.amountIn;
        d.relayer = address(uint160(_word(abi.encodeCall(settlement.relayer, ()))));
        d.domainSeparator = bytes32(_word(abi.encodeCall(settlement.domainSeparator, ())));
        bytes32 h = bytes32(_word(abi.encodeCall(settlement.hashIntent, (i))));
        d.intentHash = h;
        if (h != 0) {
            (bool ok, uint256 f) = _read(abi.encodeCall(settlement.filled, (h)));
            if (ok) {
                d.filled = f;
                d.remaining = i.amountIn > f ? i.amountIn - f : 0;
            }
            d.reservedForIntent = _word(abi.encodeCall(settlement.reserved, (h)));
        }
        d.parkedByMaker = _word(abi.encodeCall(settlement.parked, (i.maker, i.tokenIn)));
        try this.available(i) returns (uint256, bool live) {
            d.live = live;
        } catch {}
        d.minOutNow = _word(abi.encodeCall(settlement.minOutAt, (i, ts)));
    }

    function _maker(MakerView memory m, TakePoints.Quote memory q, TakePoints.Ctx memory c)
        private
        pure
    {
        m.spendToken = c.tokenIn;
        m.spend = q.take;
        m.receiveToken = c.tokenOut;
        m.signedMinimum = q.owedToMaker;
        m.cutByProceedsFee = q.feeProceeds;
        m.receiveNet = q.delivered;
        if (q.take != 0) {
            m.priceSigned = q.owedToMaker * FeeConfig.WAD / q.take;
            m.priceNet = q.delivered * FeeConfig.WAD / q.take;
        }
        m.feeIn = q.feeIn;
        m.feeOut = q.feeOut;
        // P2 and P3 stay separate: they are both in tokenOut, but a client that wants the sum
        // adds them. P1 is in tokenIn and is `gasCoverIn`; never fold it into either field.
        m.feeProceeds = q.feeProceeds;
        m.gasCoverIn = q.feeIn;
    }

    function _solver(
        SolverView memory s,
        TakePoints.Quote memory q,
        TakePoints.Ctx memory c,
        ProveSettlement.Intent calldata i
    ) private pure {
        s.rung = c.approvalRung ? Rung.Approval : (i.flags & 4 != 0 ? Rung.Permit2 : Rung.Escrow);
        s.handedOver = c.approvalRung ? q.take : q.usable;
        s.usable = q.usable;
        s.feeInDue = TakePoints.feeInDue(q, c.approvalRung);
        s.terms = TakePoints.terms(q, c);
        s.deliverNow = q.delivered;
        s.recipient = i.recipient;
        s.due = TakePoints.dues(q, c);
        s.allowance = TakePoints.allowance(q, c);
        s.maxFeeRateNeeded = c.rateIn + c.rate;
        s.owedOut = q.owed;
    }

    // ── Config, defaults, book ───────────────────────────────────────────────

    function _config(
        ConfigView memory v,
        TakePoints.Quote memory q,
        ProveSettlement.Intent calldata i,
        FeeConfig.Config memory preimage
    ) private view returns (uint256 flags) {
        v.hash = i.feeConfig;
        FeeConfig.Config memory cfg;

        if (preimage.destinations.length != 0) {
            if (FeeConfig.hash(preimage) == i.feeConfig) {
                cfg = preimage;
                v.source = ConfigSource.Supplied;
            } else {
                flags |= CONFIG_PREIMAGE_MISMATCH;
            }
        }
        if (v.source == ConfigSource.Unresolved) {
            if (i.feeConfig == bytes32(0)) {
                v.source = ConfigSource.None;
                v.resolved = true;
                v.hashMatches = true;
                return flags;
            }
            // `try` does not catch a call to an address with no code, so check first.
            if (address(feeDefaults).code.length != 0) {
                try feeDefaults.resolve(i.feeConfig) returns (
                    bool found,
                    uint256 ver,
                    bool isCurrent,
                    IFeeDefaultsRead.FeeConfigPreimage memory p
                ) {
                    if (found) {
                        cfg = FeeConfig.Config(p.destinations, p.weights);
                        v.source =
                            isCurrent ? ConfigSource.DefaultCurrent : ConfigSource.DefaultPast;
                        v.version = ver;
                    }
                } catch {}
            }
            if (v.source == ConfigSource.Unresolved && i.feeConfig == _STRAY) {
                cfg = _stray;
                v.source = ConfigSource.Stray;
            }
            if (
                v.source == ConfigSource.Unresolved
                    && _remembered[i.feeConfig].destinations.length != 0
            ) {
                cfg = _remembered[i.feeConfig];
                v.source = ConfigSource.Remembered;
            }
        }
        if (v.source == ConfigSource.Unresolved) {
            flags |= CONFIG_UNRESOLVED | CUSTOM_CONFIG;
            return flags;
        }
        v.resolved = true;
        v.hashMatches = FeeConfig.hash(cfg) == i.feeConfig;
        v.fault = FeeConfig.fault(cfg);
        if (v.fault != FeeConfig.Fault.None) flags |= CONFIG_FAULT;
        if (v.source == ConfigSource.Supplied || v.source == ConfigSource.Remembered) {
            flags |= CUSTOM_CONFIG;
        }
        v.payouts = _payouts(cfg, q);
        for (uint256 k = 0; k < v.payouts.length; k++) {
            if (!v.payouts[k].hasCode) {
                flags |= DESTINATION_NO_CODE;
                break;
            }
        }
    }

    function _payouts(FeeConfig.Config memory cfg, TakePoints.Quote memory q)
        private
        view
        returns (Payout[] memory p)
    {
        uint256 n = cfg.destinations.length;
        if (n > FeeConfig.MAX_DESTINATIONS || cfg.weights.length != n) return p;
        p = new Payout[](n);
        uint256[] memory sIn = FeeConfig.split(q.feeIn, cfg.weights);
        uint256[] memory sOut = FeeConfig.split(q.feeOut, cfg.weights);
        uint256[] memory sPro = FeeConfig.split(q.feeProceeds, cfg.weights);
        for (uint256 k = 0; k < n; k++) {
            p[k] = Payout({
                destination: cfg.destinations[k],
                weight: cfg.weights[k],
                hasCode: cfg.destinations[k].code.length != 0,
                ofFeeIn: sIn[k],
                ofFeeOut: sOut[k],
                ofFeeProceeds: sPro[k]
            });
        }
    }

    function _defaults(
        DefaultsView memory d,
        ConfigView memory v,
        ProveSettlement.Intent calldata i
    ) private view returns (uint256 flags) {
        if (address(feeDefaults).code.length == 0) {
            return DEFAULTS_UNREACHABLE;
        }
        try feeDefaults.current() returns (bytes32 dh, IFeeDefaultsRead.Record memory r) {
            d.present = true;
            d.isCurrent = uint8(v.source) == uint8(ConfigSource.DefaultCurrent);
            d.isPast = uint8(v.source) == uint8(ConfigSource.DefaultPast);
            d.defaultsHash = dh;
            d.feeConfig = r.feeConfig;
            d.rateIn = r.rates.handover;
            d.rate = r.rates.output;
            d.rateProceeds = r.rates.proceeds;
            d.warnIn = r.warn.handover;
            d.warn = r.warn.output;
            d.warnProceeds = r.warn.proceeds;
            try feeDefaults.versions() returns (uint256 n) {
                d.version = n == 0 ? 0 : n - 1;
            } catch {}
        } catch {
            return DEFAULTS_UNREACHABLE;
        }
        d.aboveWarnIn = i.feeRateIn > d.warnIn;
        d.aboveWarn = i.feeRate > d.warn;
        d.aboveWarnProceeds = i.feeRateProceeds > d.warnProceeds;
        if (d.aboveWarnIn) flags |= WARN_IN;
        if (d.aboveWarn) flags |= WARN_OUT;
        if (d.aboveWarnProceeds) flags |= WARN_PROCEEDS;
    }

    function _book(BookView memory b, ConfigView memory v, ProveSettlement.Intent calldata i)
        private
        view
    {
        b.claimInByDestination = new uint256[](0);
        b.claimOutByDestination = new uint256[](0);
        b.pendingTokenIn = _word(abi.encodeCall(settlement.pendingFees, (i.feeConfig, i.tokenIn)));
        b.pendingTokenOut = _word(abi.encodeCall(settlement.pendingFees, (i.feeConfig, i.tokenOut)));
        b.totalTokenIn = _word(abi.encodeCall(settlement.totalPendingFees, (i.tokenIn)));
        b.totalTokenOut = _word(abi.encodeCall(settlement.totalPendingFees, (i.tokenOut)));
        b.strayPendingIn = _word(abi.encodeCall(settlement.pendingFees, (_STRAY, i.tokenIn)));
        b.strayPendingOut = _word(abi.encodeCall(settlement.pendingFees, (_STRAY, i.tokenOut)));
        if (v.resolved && v.payouts.length != 0 && v.fault == FeeConfig.Fault.None) {
            uint256 n = v.payouts.length;
            uint256[] memory w = new uint256[](n);
            for (uint256 k = 0; k < n; k++) {
                w[k] = v.payouts[k].weight;
            }
            b.claimInByDestination = FeeConfig.split(b.pendingTokenIn, w);
            b.claimOutByDestination = FeeConfig.split(b.pendingTokenOut, w);
        }
    }

    // ── Reads of the settlement that cannot make the reader revert ──────────

    /// @dev One `staticcall` and one returned word, in place of a `try` block per getter: the
    ///      same "a failing settlement is a zero, not a revert", at a fraction of the bytes. A
    ///      malformed answer (under 32 bytes) reads as failure. A settlement address with no code
    ///      answers `(true, 0)` from a bare staticcall, which is why it is checked here.
    function _read(bytes memory data) private view returns (bool ok, uint256 word) {
        address to = address(settlement);
        if (to.code.length == 0) return (false, 0);
        assembly ("memory-safe") {
            ok := staticcall(gas(), to, add(data, 0x20), mload(data), 0x00, 0x20)
            // A malformed answer (under one word) is a failure; the word is read only from a
            // good one. No branch: the scratch word is multiplied away instead.
            ok := and(ok, gt(returndatasize(), 31))
            word := mul(mload(0x00), ok)
        }
    }

    function _word(bytes memory data) private view returns (uint256 word) {
        (, word) = _read(data);
    }

    // ── Token metadata (display only, capped) ────────────────────────────────

    function _tokenInfo(address token) private view returns (TokenInfo memory t) {
        t.token = token;
        t.decimals = _decimals(token);
        t.symbol = _symbol(token);
    }

    function _decimals(address token) private view returns (uint8 d) {
        if (token.code.length == 0) return 0;
        bytes4 sel = 0x313ce567; // decimals()
        uint256 word;
        bool ok;
        assembly ("memory-safe") {
            mstore(0x00, sel)
            ok := staticcall(META_GAS, token, 0x00, 0x04, 0x00, 0x20)
            word := mul(mload(0x00), and(ok, gt(returndatasize(), 31)))
        }
        return ok && word <= type(uint8).max ? uint8(word) : 0;
    }

    /// @dev `symbol()`: at most 96 bytes of the answer are copied, whatever the token returns. A
    ///      32-byte answer is read as the old `bytes32` form; a string longer than 64 bytes is cut.
    function _symbol(address token) private view returns (string memory out) {
        if (token.code.length == 0) return "";
        bytes4 sel = 0x95d89b41; // symbol()
        bytes memory buf = new bytes(96);
        uint256 size;
        bool ok;
        assembly ("memory-safe") {
            mstore(0x00, sel)
            ok := staticcall(META_GAS, token, 0x00, 0x04, 0x00, 0x00)
            size := returndatasize()
            // min(size, 96), then copy that much: the copy is bounded by the buffer, and a failed
            // call's revert data is copied too and then ignored below.
            size := xor(96, mul(xor(size, 96), lt(size, 96)))
            returndatacopy(add(buf, 0x20), 0, size)
        }
        if (!ok || size < 32) return "";
        uint256 first;
        assembly ("memory-safe") {
            first := mload(add(buf, 0x20))
        }
        if (size == 32) {
            // bytes32 symbol: trim trailing zeros.
            uint256 len = 32;
            while (len != 0 && buf[len - 1] == 0) len--;
            out = new string(len);
            for (uint256 k = 0; k < len; k++) {
                bytes(out)[k] = buf[k];
            }
            return out;
        }
        if (first != 0x20 || size < 64) return "";
        uint256 n;
        assembly ("memory-safe") {
            n := mload(add(buf, 0x40))
        }
        if (n > size - 64) n = size - 64;
        out = new string(n);
        for (uint256 k = 0; k < n; k++) {
            bytes(out)[k] = buf[64 + k];
        }
    }
}
