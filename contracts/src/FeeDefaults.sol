// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {FeeConfig} from "./FeeConfig.sol";
import {FeeConfigView} from "./FeeConfigView.sol";

/**
 * @title FeeDefaults
 * @notice What the project SUGGESTS a new intent should sign: a fee config, a default rate per take
 *         point and a warning threshold per take point. Advisory only.
 *
 * **The settlement never reads this contract and does not know its address.** A fill accepts any
 * `bytes32` as `feeConfig`; nothing depends on this for correctness. A maker, an app or a bot may
 * ignore it. Every change appends a history entry carrying the full preimage; nothing is ever
 * overwritten or removed, so `at(0..versions()-1)` is the complete audit trail and every
 * historical preimage stays readable on chain.
 *
 * The owner (two-step handover, recommended: a multisig behind a timelock) has one power,
 * `setDefaults`. It reaches no funds, no book and no signed intent.
 *
 * Inherits `FeeConfigView`, so a client that talks to this contract has one address for the
 * defaults and for the math.
 *
 * Spec: `docs/superpowers/specs/2026-10-03-fee-config-hash.md` section 2.4.
 */
contract FeeDefaults is FeeConfigView {
    /// @dev Fractions of WAD for the three take points: P1 handover, P2 output, P3 proceeds.
    struct PointRates {
        uint64 handover;
        uint64 output;
        uint64 proceeds;
    }

    struct Record {
        bytes32 feeConfig;
        PointRates rates; // default feeRateIn, feeRate, feeRateProceeds
        PointRates warn; // per point: the rate above which clients warn (advisory)
        uint64 setAt;
        FeeConfig.Config config;
    }

    bytes32 public constant DEFAULTS_TYPEHASH = keccak256(
        "FeeDefaults(bytes32 feeConfig,uint64 rateIn,uint64 rate,uint64 rateProceeds,uint64 warnRateIn,uint64 warnRate,uint64 warnRateProceeds)"
    );

    address public owner;
    address public pendingOwner;

    bytes32[] private _history;
    /// @dev Keyed by `defaultsHash`, written ONCE, the first time a hash is used. A later version
    ///      that returns to an earlier hash (A, B, A) leaves the record alone.
    mapping(bytes32 => Record) private _records;
    /// @dev When each VERSION was set, by version number. `setAt` in a returned record is read
    ///      from here, so a hash that came back reports the time of the version asked about.
    uint64[] private _setAt;
    /// @dev feeConfig -> (latest version that used it) + 1; 0 = never.
    mapping(bytes32 => uint256) private _latestOf;

    event DefaultsSet(
        uint256 indexed version,
        bytes32 indexed defaultsHash,
        bytes32 indexed feeConfig,
        PointRates rates,
        PointRates warn,
        address[] destinations,
        uint256[] weights
    );
    event OwnerProposed(address pending);
    event OwnerSet(address owner);

    error NotOwner();
    error BadParameter();
    error InvalidConfig(FeeConfig.Fault fault);
    error Unchanged();
    error NoDefaults();

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert BadParameter();
        owner = initialOwner;
        emit OwnerSet(initialOwner);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Publish new suggested defaults. Appends a version; a repeat of the current
    ///         `defaultsHash` reverts. Rates and warn rates may not exceed `WAD`.
    function setDefaults(
        FeeConfig.Config calldata cfg,
        PointRates calldata rates,
        PointRates calldata warn
    ) external onlyOwner returns (bytes32 defaultsHash) {
        FeeConfig.Fault f = FeeConfig.fault(cfg);
        if (f != FeeConfig.Fault.None) revert InvalidConfig(f);
        // Money sent here could never leave. The settlement, relayer and reader are not known to
        // this contract; `Deploy.s.sol` asserts those after deployment.
        for (uint256 k = 0; k < cfg.destinations.length; k++) {
            if (cfg.destinations[k] == address(this)) {
                revert InvalidConfig(FeeConfig.Fault.ReservedDestination);
            }
        }
        uint256 w = FeeConfig.WAD;
        if (
            rates.handover > w || rates.output > w || rates.proceeds > w || warn.handover > w
                || warn.output > w || warn.proceeds > w
        ) revert BadParameter();

        bytes32 feeConfig = FeeConfig.hash(cfg);
        defaultsHash = _defaultsHash(feeConfig, rates, warn);
        uint256 n = _history.length;
        if (n != 0 && _history[n - 1] == defaultsHash) revert Unchanged();

        _history.push(defaultsHash);
        _setAt.push(uint64(block.timestamp));
        Record storage r = _records[defaultsHash];
        // First use only. The record is a pure function of the hash, so rewriting it would change
        // nothing but `setAt`, and that lives per version in `_setAt`.
        if (r.setAt == 0) {
            r.feeConfig = feeConfig;
            r.rates = rates;
            r.warn = warn;
            r.setAt = uint64(block.timestamp);
            r.config = cfg;
        }
        _latestOf[feeConfig] = n + 1;

        emit DefaultsSet(n, defaultsHash, feeConfig, rates, warn, cfg.destinations, cfg.weights);
    }

    function _defaultsHash(bytes32 feeConfig, PointRates calldata rates, PointRates calldata warn)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                DEFAULTS_TYPEHASH,
                feeConfig,
                rates.handover,
                rates.output,
                rates.proceeds,
                warn.handover,
                warn.output,
                warn.proceeds
            )
        );
    }

    /// @notice Propose the next owner. Nothing changes until that address calls `acceptOwnership`.
    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnerProposed(next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnerSet(msg.sender);
    }

    function versions() external view returns (uint256) {
        return _history.length;
    }

    /// @notice The latest defaults. Reverts `NoDefaults` before the first `setDefaults`.
    function current() external view returns (bytes32 defaultsHash, Record memory) {
        uint256 n = _history.length;
        if (n == 0) revert NoDefaults();
        return at(n - 1);
    }

    function at(uint256 version) public view returns (bytes32 defaultsHash, Record memory r) {
        defaultsHash = _history[version];
        r = _records[defaultsHash];
        r.setAt = _setAt[version];
    }

    /// @notice O(1): was this fee config ever a default, in which version last, is it the current
    ///         default's config, and what does it contain. For `ProveReader`.
    function resolve(bytes32 feeConfig)
        external
        view
        returns (bool found, uint256 latestVersion, bool isCurrent, FeeConfig.Config memory config)
    {
        uint256 l = _latestOf[feeConfig];
        if (l == 0) return (false, 0, false, config);
        latestVersion = l - 1;
        found = true;
        config = _records[_history[latestVersion]].config;
        isCurrent = _records[_history[_history.length - 1]].feeConfig == feeConfig;
    }
}
