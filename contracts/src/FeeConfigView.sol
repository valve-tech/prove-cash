// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {FeeConfig} from "./FeeConfig.sol";

/**
 * @title FeeConfigView
 * @notice The canonical `FeeConfig` functions as `external pure` calls, for integrators, indexers,
 *         explorers and CI that want to ask the deployed implementation rather than port it.
 *
 * No owner, no storage. The settlement never references it. `FeeDefaults` and `ProveReader`
 * inherit it, so a client that talks to either has one address for its data and for the math.
 */
contract FeeConfigView {
    function TYPEHASH() external pure returns (bytes32) {
        return FeeConfig.TYPEHASH;
    }

    function MAX_DESTINATIONS() external pure returns (uint256) {
        return FeeConfig.MAX_DESTINATIONS;
    }

    function hash(FeeConfig.Config calldata c) external pure returns (bytes32) {
        return FeeConfig.hash(c);
    }

    function fault(FeeConfig.Config calldata c) external pure returns (FeeConfig.Fault) {
        return FeeConfig.fault(c);
    }

    function single(address destination) external pure returns (FeeConfig.Config memory) {
        return FeeConfig.single(destination);
    }

    function singleHash(address destination) external pure returns (bytes32) {
        return FeeConfig.singleHash(destination);
    }

    function split(uint256 amount, uint256[] calldata weights)
        external
        pure
        returns (uint256[] memory)
    {
        return FeeConfig.split(amount, weights);
    }

    function feeOf(uint256 base, uint256 rate) external pure returns (uint256) {
        return FeeConfig.feeOf(base, rate);
    }

    function grossForNet(uint256 net, uint256 rate) external pure returns (uint256) {
        return FeeConfig.grossForNet(net, rate);
    }
}
