// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title FeeConfig
 * @notice The one definition of a fee config: what it is, what its hash is, when it is valid and
 *         how a booked amount is divided among its destinations.
 *
 * A fee config is a list of destinations and a list of weights. The maker signs its hash
 * (`Intent.feeConfig`), so a destination exists because a maker named it and for no other
 * reason: there is no registry and nobody to ask. `ProveSettlement`, `FeeDefaults`,
 * `FeeConfigView`, `ProveReader`, the SDK and the app all use these rules, byte for byte.
 *
 * Internal and pure. The fill path needs none of it (it handles an opaque `bytes32`); `claim`, the
 * constructor and every client do.
 *
 * Spec: `docs/superpowers/specs/2026-10-03-fee-config-hash.md`.
 */
library FeeConfig {
    uint256 internal constant WAD = 1e18;

    /// @dev A claim makes at most this many token transfers. A constant, not a setting.
    uint256 internal constant MAX_DESTINATIONS = 8;

    /// @dev The EIP-712 type of a config. A future format uses a new type name, never an edit.
    bytes32 internal constant TYPEHASH =
        keccak256("FeeConfig(address[] destinations,uint256[] weights)");

    struct Config {
        address[] destinations; // strictly ascending, none zero, 1..MAX_DESTINATIONS
        uint256[] weights; // each > 0, same length, summing to WAD
    }

    /// @dev `ReservedDestination` is never returned by `fault`: it is the settlement's own
    ///      context-dependent rule (a destination that is the settlement or its relayer).
    enum Fault {
        None,
        NoDestinations,
        TooMany,
        LengthMismatch,
        ZeroDestination,
        NotAscending,
        ZeroWeight,
        WeightsDoNotSumToWad,
        ReservedDestination
    }

    /// @notice `hashStruct(config)` in EIP-712. Accepts any arrays, valid or not.
    function hash(Config memory c) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPEHASH,
                keccak256(abi.encodePacked(c.destinations)),
                keccak256(abi.encodePacked(c.weights))
            )
        );
    }

    /// @notice Context-free validity. `None` when the config is canonical.
    function fault(Config memory c) internal pure returns (Fault f) {
        uint256 n = c.destinations.length;
        if (n == 0) return Fault.NoDestinations;
        if (n > MAX_DESTINATIONS) return Fault.TooMany;
        if (c.weights.length != n) return Fault.LengthMismatch;
        if (c.destinations[0] == address(0)) return Fault.ZeroDestination;
        uint256 sum;
        for (uint256 k = 0; k < n; k++) {
            if (k != 0 && uint160(c.destinations[k]) <= uint160(c.destinations[k - 1])) {
                return Fault.NotAscending;
            }
            uint256 w = c.weights[k];
            if (w == 0) return Fault.ZeroWeight;
            if (w > WAD) return Fault.WeightsDoNotSumToWad;
            sum += w;
        }
        if (sum != WAD) return Fault.WeightsDoNotSumToWad;
        // Falls out as `None`, the named return's zero.
    }

    /// @notice The config that pays one destination everything.
    function single(address destination) internal pure returns (Config memory c) {
        c.destinations = new address[](1);
        c.weights = new uint256[](1);
        c.destinations[0] = destination;
        c.weights[0] = WAD;
    }

    /// @notice `hash(single(destination))`, the key a failed share is re-booked under.
    function singleHash(address destination) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TYPEHASH,
                keccak256(abi.encodePacked(bytes32(uint256(uint160(destination))))),
                keccak256(abi.encodePacked(WAD))
            )
        );
    }

    /// @notice Divide `amount` by `weights`: floor for every share but the last, which takes the
    ///         remainder, so the shares add to `amount` exactly and nothing is left behind.
    function split(uint256 amount, uint256[] memory weights)
        internal
        pure
        returns (uint256[] memory shares)
    {
        uint256 n = weights.length;
        shares = new uint256[](n);
        uint256 given;
        for (uint256 k = 0; k + 1 < n; k++) {
            shares[k] = Math.mulDiv(amount, weights[k], WAD);
            given += shares[k];
        }
        if (n != 0) shares[n - 1] = amount - given;
    }

    /// @notice `floor(base * rate / WAD)`: every fee at every take point.
    function feeOf(uint256 base, uint256 rate) internal pure returns (uint256) {
        return (base * rate) / WAD;
    }

    /// @notice The gross that leaves `net` after a cut of `rate`: `ceilDiv(net * WAD, WAD - rate)`.
    function grossForNet(uint256 net, uint256 rate) internal pure returns (uint256) {
        if (net == 0) return 0;
        return (net * WAD - 1) / (WAD - rate) + 1;
    }
}
