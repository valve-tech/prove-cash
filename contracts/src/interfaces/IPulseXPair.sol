// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

/**
 * @notice The UniswapV2-shaped pair. A pair adds `price * seconds` to a counter every time
 *         somebody touches it, so the counter records where the price has been rather than where
 *         it is. Two readings and the time between them are an average nobody can rewrite with a
 *         trade in the present.
 *
 * The counters are UQ112x112 and they wrap on purpose, as does `blockTimestampLast`. A reader
 * subtracts and lets the wrap happen.
 */
interface IPulseXPair {
    function token0() external view returns (address);

    function token1() external view returns (address);

    /// @return reserve0 reserve1 blockTimestampLast, the second the pair last updated its price.
    function getReserves() external view returns (uint112, uint112, uint32);

    /// @notice token1 per token0, accumulated against time.
    function price0CumulativeLast() external view returns (uint256);

    /// @notice token0 per token1, accumulated against time.
    function price1CumulativeLast() external view returns (uint256);

    /**
     * @notice Take the pair's own balances as its reserves.
     * @dev The only write in this interface, and it is permissionless on every V2 pair. It moves
     *      no price of its own — it hands the pair the balances it already holds — but it does
     *      make the pair add the time since its last touch to the counters. That is the point:
     *      a pair nobody trades never writes its price down, and an average needs it written down.
     */
    function sync() external;
}
