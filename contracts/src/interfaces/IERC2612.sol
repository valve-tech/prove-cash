// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

/**
 * @notice EIP-2612: set an ERC-20 allowance from a signature, so the owner spends no gas.
 *
 * The maker signs; anybody submits. That is what makes it useful here — an executor can carry a
 * maker's approval to the chain inside the fill that uses it, and the maker sends nothing.
 *
 * **This grants an allowance, so it is the approval rung and not escrow.** Nothing is committed:
 * the allowance is reusable up to `value`, the maker can revoke it or spend the tokens elsewhere,
 * and re-granting one later revives every signature the maker ever wrote against that token. The
 * settlement does not bound that window — the loss falls on the maker who signed, so the choice is
 * theirs and the app is where the warning lives. EIP-3009 is the
 * stronger signature — single use, exact amount, and its nonce names the intent it funds — but
 * almost no token implements it, and most implement this.
 *
 * **The nonce is a griefing surface, and the caller must expect it.** `nonces` increments on every
 * permit, so anybody watching the mempool can submit the same signed permit first, take the nonce,
 * and make the later call revert on a bad signature — while leaving the allowance perfectly well
 * set. Reverting the fill for that would hand a stranger a free denial of service. Treat a failed
 * permit as unremarkable and let the transfer decide, which is what `ProveSettlement` does.
 */
interface IERC2612 {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /// @notice The owner's next permit nonce. Increments on every successful `permit`.
    function nonces(address owner) external view returns (uint256);
}
