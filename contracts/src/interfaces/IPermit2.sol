// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

/**
 * @notice The SignatureTransfer half of Permit2, and nothing else.
 *
 * Permit2 has two halves and only one of them belongs here. **AllowanceTransfer** has the maker
 * sign a permit that grants an allowance *inside* Permit2 to a named spender, and that spender
 * would be `ProveRelayer` — which is created by `ProveSettlement`'s constructor and therefore
 * changes on every redeploy. It would orphan every maker's grant exactly the way the ERC-20
 * allowance to the relayer does today, which is the whole problem this rung exists to solve.
 *
 * **SignatureTransfer authorizes one transfer per signature.** Nothing outlives an intent: the
 * nonce is single-use, the deadline is the maker's own, and the only durable thing anywhere is
 * the maker's one-time `approve(Permit2, max)` on the token. That approval is to Permit2's
 * address, which is the same on every chain and survives every redeploy we will ever do.
 *
 * `msg.sender` is the spender the signature commits to. Permit2 hashes the caller into the
 * digest rather than reading a field, so a signature made for our relayer is unusable by anybody
 * else — and our relayer is the only address that can present it.
 *
 * The address is not written down here. It is configuration, handed to `ProveRelayer`'s
 * constructor and held as an immutable, for the reason `config/<chainid>.json` gives: nothing in
 * `src/` compiles in an address.
 */
interface ISignatureTransfer {
    /// @notice The token and the most of it one signature may ever move.
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    /// @notice What the maker signed. `spender` is not a field: Permit2 uses `msg.sender`.
    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    /// @notice Where this call sends the tokens, and how much of the permitted amount it takes.
    ///         `requestedAmount` may be less than `permitted.amount` and never more.
    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    /**
     * @notice Move `transferDetails.requestedAmount` of the permitted token from `owner`.
     *
     * Permit2 checks the deadline, refuses a request above the permitted amount, spends the
     * nonce in an unordered bitmap, verifies the signature against `msg.sender` as the spender —
     * through ERC-1271 when the owner is a contract — and then calls the token's
     * `transferFrom`. Every one of those is a revert, which is why the settlement only ever
     * reaches this from inside `armLeg`'s revertable frame.
     */
    function permitTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;

    /// @notice The bitmap of spent nonces. Bit `nonce & 0xff` of word `nonce >> 8`.
    function nonceBitmap(address owner, uint256 word) external view returns (uint256);

    /// @notice Burn nonces without spending them, which is how a maker calls off a signature
    ///         they have already handed out.
    function invalidateUnorderedNonces(uint256 wordPos, uint256 mask) external;

    /// @notice Permit2's own EIP-712 domain. It carries no version string.
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
