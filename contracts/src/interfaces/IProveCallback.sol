// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

/**
 * @notice An executor with no inventory implements this.
 *
 * `ProveSettlement` calls the executor that called it, so the implementer is also the caller of
 * `fillWithCallback`. It is told every number of the fill in `Terms` (see there) and must end
 * this call holding `owed` of token B, and `feeInDue` of token A, with a relayer allowance
 * covering each: the contract pulls the payments out afterwards rather than watching for them
 * to arrive. `executor` is `msg.sender` of the fill, which is this contract.
 *
 * **Fees are reserved, not moved.** The settlement books each fee in its fee book when it is
 * due and pulls the tokens behind all of them once per token at the end of the call, from the
 * caller. A call that cannot cover them reverts (`ReservationUnbacked`).
 *
 * **Approve `settlement.relayer()`, not the settlement.** `ProveRelayer` is the contract that
 * calls `transferFrom`, and it holds every allowance precisely so the contract that calls
 * strangers holds none. This paragraph used to say "the settlement", which is the one mistake
 * that makes an otherwise correct implementation revert on every fill. `IProveBatchCallback`
 * said the same thing and was corrected with it. Read the address off the settlement rather than
 * storing it, the way `ProveExecutor` does in its constructor.
 */
interface IProveCallback {
    /// @notice Everything a solver is owed to know about one fill, at each of the three take
    ///         points (spec 2.10). All amounts are for this take.
    struct Terms {
        address tokenIn;
        /// @dev tokenIn that is yours to use: `take - feeIn`.
        uint256 amountIn;
        /// @dev P1, the handover fee, reserved in the fee book.
        uint256 feeIn;
        /// @dev The part of `feeIn` physically in your hands, owed back at the end: `feeIn` on the
        ///      approval rung, 0 on the custodied rungs (where it never left the settlement).
        uint256 feeInDue;
        address tokenOut;
        /// @dev The maker's required out for this take.
        uint256 owedToMaker;
        /// @dev P2, the output fee, reserved on top of `owedToMaker`.
        uint256 feeOut;
        /// @dev P3, the proceeds fee, reserved out of `owedToMaker`: the maker bears it.
        uint256 feeProceeds;
        /// @dev `owedToMaker - feeProceeds`: pulled straight to the recipient after this call.
        uint256 delivered;
        /// @dev `owedToMaker + feeOut`: your whole tokenOut debt over the call. The relayer
        ///      allowance on `tokenOut` has to cover it; on `tokenIn` it has to cover `feeInDue`.
        uint256 owed;
    }

    function proveCallback(address executor, Terms calldata t, bytes calldata data) external;
}
