// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

/// @notice The gasless transfer half of EIP-3009. A maker signs one of these and never sends a
/// transaction; the first executor redeems it into escrow as part of the fill.
interface IERC3009 {
    /**
     * @notice The same transfer, but only the recipient may submit it.
     *
     * EIP-3009 defines this alongside `transferWithAuthorization` precisely because that one is a
     * permissionless relay: the signature names the recipient, so anybody holding a copy can push
     * the tokens without the recipient's code running. For a contract that credits a ledger when
     * the money lands, that is fund loss — the tokens arrive, nothing is credited, and there is
     * no way back. `to == msg.sender` is the whole difference and it is why this exists.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    /**
     * @notice The same call, with an unstructured signature. This is ERC-7598.
     *
     * ERC-3009 fixed the signature at a 65-byte `v, r, s` triple, which is what an
     * `ecrecover` takes and what nothing else produces. A contract wallet has no key and
     * validates through ERC-1271, so under the original shape it could hold a balance and never
     * authorize a gasless transfer of it. ERC-7598 adds this overload and nothing else.
     *
     * A token may implement one overload, the other, or both, so `ProveSettlement._receive`
     * picks by the signature's length and falls back rather than assuming.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
