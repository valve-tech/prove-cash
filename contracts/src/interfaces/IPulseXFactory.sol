// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

/// @notice The UniswapV2-shaped factory behind the router. One call: the pool a hop trades in.
interface IPulseXFactory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}
