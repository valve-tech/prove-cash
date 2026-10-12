// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

/// @notice The x402 wrapper shape: a 1:1 claim on `underlying()` with the same decimals.
///         Selling one of these on an AMM would pay slippage for something redeemable at par.
interface IWrappedToken {
    function underlying() external view returns (address);
    function unwrap(uint256 amount) external;
    function wrap(uint256 amount) external;
}
