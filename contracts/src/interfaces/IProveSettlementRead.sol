// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {ProveSettlement} from "../ProveSettlement.sol";
import {TakePoints} from "../TakePoints.sol";

/// @notice The settlement's public views that `ProveReader` reads. Nothing here writes.
interface IProveSettlementRead {
    function quote(ProveSettlement.Intent calldata i, uint256 take, uint256 ts)
        external
        view
        returns (TakePoints.Quote memory);
    function minOutAt(ProveSettlement.Intent calldata i, uint256 ts) external pure returns (uint256);
    function hashIntent(ProveSettlement.Intent calldata i) external view returns (bytes32);
    function domainSeparator() external view returns (bytes32);
    function cancelledAt(bytes32 intentHash) external view returns (uint64);
    function laneFloor(address maker, uint192 lane) external view returns (uint64);
    function filled(bytes32 intentHash) external view returns (uint256);
    function reserved(bytes32 intentHash) external view returns (uint256);
    function parked(address maker, address token) external view returns (uint256);
    function relayer() external view returns (address);
    function STRAY_CONFIG() external view returns (bytes32);
    function pendingFees(bytes32 feeConfig, address token) external view returns (uint256);
    function totalPendingFees(address token) external view returns (uint256);
    function fillability(
        ProveSettlement.Intent calldata i,
        bytes calldata signature,
        uint256 take,
        address executor,
        uint256 maxFeeRate
    ) external view returns (ProveSettlement.Reason);
}

/// @notice What `ProveReader` reads of `FeeDefaults`.
interface IFeeDefaultsRead {
    struct PointRates {
        uint64 handover;
        uint64 output;
        uint64 proceeds;
    }

    struct Record {
        bytes32 feeConfig;
        PointRates rates;
        PointRates warn;
        uint64 setAt;
        FeeConfigPreimage config;
    }

    struct FeeConfigPreimage {
        address[] destinations;
        uint256[] weights;
    }

    function current() external view returns (bytes32 defaultsHash, Record memory);
    function versions() external view returns (uint256);
    function resolve(bytes32 feeConfig)
        external
        view
        returns (bool found, uint256 latestVersion, bool isCurrent, FeeConfigPreimage memory config);
}
