// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {FeeConfig} from "../src/FeeConfig.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ProveReader} from "../src/ProveReader.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev The fee helpers every settlement test shares. It replaces `Sinks.sol`: there are no sinks
///      and no registry any more, a fee is booked under the hash of the config an intent signs,
///      and anyone pays it out with `claim(config, token)`.

/// @dev Where an unattributed token goes in the tests, the stray config's one destination.
address constant STRAY_DESTINATION = address(0xDEFA017);

/// @notice The stray config the test settlements are constructed with.
function strayConfig() pure returns (FeeConfig.Config memory c) {
    c = singleConfig(STRAY_DESTINATION);
}

/// @notice A config with one destination, which takes everything.
function singleConfig(address dest) pure returns (FeeConfig.Config memory c) {
    c.destinations = new address[](1);
    c.destinations[0] = dest;
    c.weights = new uint256[](1);
    c.weights[0] = 1e18;
}

/// @notice The hash an intent signs to send its whole fee to `dest`.
function feeCfg(address dest) pure returns (bytes32) {
    // "Names nobody": the zero config, which charges nothing and which a fill refuses a rate on.
    if (dest == address(0)) return bytes32(0);
    return FeeConfig.hash(singleConfig(dest));
}

/// @notice A test settlement on `permit2`, constructed with the shared stray config.
function newSettlement(address permit2) returns (ProveSettlement) {
    return new ProveSettlement(strayConfig(), permit2);
}

/// @notice Pays out what is booked for `dest`'s single-destination config in `token`.
function claimFor(ProveSettlement settlement, address dest, address token) returns (uint256) {
    return settlement.claim(singleConfig(dest), token);
}

/// @notice What is booked, unclaimed, for `dest`'s single-destination config in `token`.
function pendingFor(ProveSettlement settlement, address dest, address token)
    view
    returns (uint256)
{
    return settlement.pendingFees(feeCfg(dest), token);
}

/// @notice Claims, then reads `dest`'s balance. The old tests read a sink's balance directly,
///         because the fee used to be paid in the fill.
function claimedBalance(ProveSettlement settlement, address dest, address token) returns (uint256) {
    if (settlement.pendingFees(feeCfg(dest), token) != 0) claimFor(settlement, dest, token);
    return IERC20(token).balanceOf(dest);
}

/// @notice The P3 (proceeds) rate an intent charges. The old single `rateOf` was this one in every
///         test that predates the three take points: those tests sign their rate there, because
///         it comes out of the number the maker signed, as the old fee did.
function proceedsRate(ProveSettlement settlement, ProveSettlement.Intent memory i)
    view
    returns (uint256 r)
{
    (,, r) = ratesOf(i);
}

/// @notice The three rates an intent charges (P1, P2, P3): all zero when it names no config. The
///         settlement has no `ratesOf`; these are three fields of the intent.
function ratesOf(ProveSettlement.Intent memory i)
    pure
    returns (uint256 rateIn, uint256 rate, uint256 rateProceeds)
{
    if (i.feeConfig == bytes32(0)) return (0, 0, 0);
    return (i.feeRateIn, i.feeRate, i.feeRateProceeds);
}

/// @notice A `ProveReader` for this settlement, deployed once per (caller, settlement) at a
///         CREATE2 address and found again after that. It stands in for the settlement's old
///         `available(Intent)`, which moved to the reader to give the settlement bytes.
function readerOf(ProveSettlement settlement) returns (ProveReader) {
    bytes memory init = abi.encodePacked(
        type(ProveReader).creationCode, abi.encode(address(settlement), address(0), strayConfig())
    );
    bytes32 salt = bytes32(uint256(uint160(address(settlement))));
    address self;
    assembly ("memory-safe") {
        self := address()
    }
    address at = address(
        uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), self, salt, keccak256(init)))))
    );
    if (at.code.length == 0) {
        address made;
        assembly ("memory-safe") {
            made := create2(0, add(init, 0x20), mload(init), salt)
        }
        require(made == at, "reader deploy failed");
    }
    return ProveReader(at);
}

/// @notice `ProveReader.available`, which is what `ProveSettlement.available` was.
function availableOf(ProveSettlement settlement, ProveSettlement.Intent memory i)
    returns (uint256 remaining, bool live)
{
    return readerOf(settlement).available(i);
}
