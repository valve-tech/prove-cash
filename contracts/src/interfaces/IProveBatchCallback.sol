// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

/**
 * @notice An executor that settles a whole ring on credit implements this.
 *
 * `fillBatchWithCallback` releases every leg's token A to the caller, calls the caller once, and
 * then *pulls* every payment out of it. So the callback's only job is to end holding the tokens
 * named in `owed`, with a relayer allowance covering `amount + fee` in each tokenOut, plus `feeInDue` in each tokenIn. It does not have to pay
 * anybody, and paying somebody early discharges nothing — the pull happens either way, and an
 * early payment is simply a gift.
 *
 * **Approve `settlement.relayer()`, not the settlement.** `ProveRelayer` is the contract that
 * calls `transferFrom`, and it holds every allowance precisely so the contract that calls
 * strangers holds none. This paragraph used to say "the settlement", which is the one mistake
 * that makes an otherwise correct implementation revert on every ring. Read the address off the
 * settlement rather than storing it: `ProveExecutor` and `ProveBatchExecutor` both do that in
 * their constructors.
 *
 * That ordering is where the capital efficiency comes from, not from the callback itself. Every
 * release lands before any payment is due, so the token one maker sells is already in the
 * executor's hands when the next maker's payment goes out. A ring of intents that pay for each
 * other therefore needs no inventory at all.
 *
 * `owed` carries one line per surviving leg, in leg order. Read it rather than recomputing it:
 * the Dutch curve moves with the block timestamp, so a number computed off chain is a guess
 * about inclusion. Legs that `skipInvalid` stepped over are absent, so do not index `owed` by
 * the caller's request index — read `Payment.leg`, which says which request each line came from.
 */
interface IProveBatchCallback {
    /// @param token the token to have on hand (tokenOut)
    /// @param to who the contract will send `amount - feeProceeds` to
    /// @param amount `owedToMaker`: the maker's required out for this leg, before P3. P2 is on top.
    /// @param fee P2, the output fee, reserved on top of `amount`. `amount + fee` is what the leg
    ///        costs in `token` and it is the figure an allowance has to cover (plus, per token,
    ///        the `feeInDue` of lines whose `tokenIn` it is).
    struct Payment {
        address token;
        address to;
        uint256 amount;
        uint256 fee;
        /// @notice The fee config the fees of this leg are booked under: the intent's own
        ///         `feeConfig`. Zero when the intent signed zero there, and then every fee is zero.
        bytes32 feeConfig;
        /**
         * @notice Which request this line came from: the index into the `reqs` array the caller
         *         passed to `fillBatchWithCallback`.
         *
         * `owed` is compacted, so line `k` is not request `k` whenever `skipInvalid` stepped a
         * leg over. Without this field a callback that plans per leg cannot tell WHICH leg went
         * missing — only how many did — and a plan it cannot align to the outcome is a plan it
         * has to refuse. That is why `ProveBatchExecutor` rejected any batch that skipped
         * anything, and it rejected far more than it needed to.
         *
         * **A ring and a batch are not the same thing, and only one of them is all or nothing.**
         * A ring is a cycle, so a cycle minus a leg is not a cycle and there is nothing to
         * settle: it stays atomic and this field changes nothing for it. A batch is just a set
         * of intents. If six of eight arm, the caller owes those six and nothing else — the
         * other two are filled, cancelled, or expired, which is somebody else's business. The
         * settlement has always known that, which is why `owed` is compacted rather than padded.
         * The callback could not act on it because it could not tell which six.
         *
         * With this field it can: carry one action per leg, run the actions whose leg survived.
         */
        uint256 leg;
        /// @notice The leg's tokenIn, and what of it is yours to use: `take - feeIn`.
        address tokenIn;
        uint256 amountIn;
        /// @notice P1, the handover fee, reserved in the fee book.
        uint256 feeIn;
        /// @notice The part of `feeIn` you physically hold and owe back in `tokenIn` at the end
        ///         (the approval rung); zero on the custodied rungs.
        uint256 feeInDue;
        /// @notice P3, the proceeds fee, reserved out of `amount`. The recipient is paid
        ///         `amount - feeProceeds`; your total debt is unchanged.
        uint256 feeProceeds;
    }

    function proveBatchCallback(Payment[] calldata owed, bytes calldata data) external;
}
