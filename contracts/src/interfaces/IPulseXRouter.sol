// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

/// @notice The UniswapV2-shaped router PulseX exposes. Only the three calls the buyback needs.
interface IPulseXRouter {
    /// @notice The factory the router derives every pair address from. The buyback asks it which
    ///         pool a hop trades in, so the price it reads is the price it pays.
    function factory() external view returns (address);

    /**
     * @notice The plain swap. Every hop is computed from `amountIn` before any of it moves.
     * @dev Not what the buyback uses — see the variant below. It stays because the executor's own
     *      route calldata is this shape, and the lab's mock router answers to it.
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);

    /**
     * @notice The variant that reads what actually arrived at each pair.
     * @dev The plain `swapExactTokensForTokens` computes every hop from `amountIn` and then tells
     *      the pair to pay that out. A pair checks k after the transfer, so a token that arrives
     *      short of `amountIn` — any fee-on-transfer token — reverts with `UniswapV2: K`. This one
     *      transfers first and derives each hop from `balanceOf(pair) - reserve`, so a taxed token
     *      sells for what it is actually worth.
     *
     *      It returns nothing, which is why a caller has to measure its own balance before and
     *      after and check the delta against its own bound. The router's answer cannot be the
     *      number anything is decided on, because there is no answer.
     */
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts);
}
