// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC3009} from "../../src/interfaces/IERC3009.sol";

/**
 * @title FaucetToken
 * @notice A test-net ERC-20 anyone can draw from. It exists because PulseChain testnet has almost
 *         no liquid tokens, so there is nothing to build a realistic portfolio out of and nothing
 *         to exercise the gasless fill path against.
 *
 * The token signs four ways. `ProveSettlement` calls exactly one of them,
 * `receiveWithAuthorization`, on the gasless fill path. The other three are here so the token is
 * a fair stand-in for a real EIP-3009 token rather than a fixture shaped to one caller:
 *   - EIP-2612 `permit`                    an allowance without a maker transaction
 *   - EIP-3009 `transferWithAuthorization` a transfer anybody may submit
 *   - EIP-3009 `receiveWithAuthorization`  the same transfer, payee only
 *   - ERC-7598 `receiveWithAuthorization`  the same again, with an unstructured signature, so a
 *                                          contract wallet can authorize through ERC-1271
 *   - EIP-3009 `cancelAuthorization`       a maker revoking one of those before it is redeemed
 *
 * The file lives under `test/` on purpose. CI runs `forge coverage --no-match-coverage
 * "(test|script)"`, so a fixture never dilutes the coverage of the contracts that hold funds.
 *
 * @dev The EIP-712 plumbing is written out rather than inherited from OpenZeppelin's `EIP712`.
 *      That base reaches `Strings`, which reaches `Bytes`, which emits `mcopy` — an opcode the
 *      project's `evm_version = "paris"` forbids. The domain is cached exactly as
 *      `ProveSettlement` caches its own, and rebuilt if the chain forks underneath it.
 */
contract FaucetToken is ERC20, IERC3009 {
    // ── Constants ────────────────────────────────────────────────────────────

    /// @dev The type hashes, verbatim from EIP-2612 and EIP-3009. A single wrong character here
    ///      produces a token that looks correct and rejects every real signature.
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant CANCEL_AUTHORIZATION_TYPEHASH =
        keccak256("CancelAuthorization(address authorizer,bytes32 nonce)");

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant VERSION_HASH = keccak256("1");

    // ── State ────────────────────────────────────────────────────────────────

    address public owner;

    /// @notice How much `claim` pays, and how long the caller waits before the next one.
    uint256 public immutable claimAmount;
    uint64 public immutable claimCooldown;

    uint8 private immutable _decimals;

    /// @dev The name is hashed once at construction. It is the only part of the domain that is
    ///      not already a constant or a chain value.
    bytes32 private immutable _NAME_HASH;
    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

    /// @notice The earliest timestamp at which each address may claim again.
    mapping(address => uint64) public nextClaimAt;

    /// @notice The EIP-2612 counter. Sequential, one per owner, as that standard requires.
    mapping(address => uint256) public nonces;

    /**
     * @dev The EIP-3009 nonce map. That nonce is a 32-byte value the signer picks, not a counter,
     *      so authorizations do not have to be redeemed in order. prove.cash sets it to the intent
     *      hash, which is what binds one authorization to one intent.
     */
    mapping(address => mapping(bytes32 => bool)) private _authorized;

    // ── Events ───────────────────────────────────────────────────────────────

    event Claimed(address indexed to, uint256 amount, uint64 nextClaimAt);
    event OwnerSet(address owner);

    /// @dev Both signatures come from EIP-3009. Indexers already watch for them.
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotOwner();
    error BadParameter();
    error CooldownActive(uint64 readyAt);
    error PermitExpired(uint256 deadline);
    error NotYetValid(uint256 validAfter);
    error AuthorizationExpired(uint256 validBefore);
    error AuthorizationUsedUp(address authorizer, bytes32 nonce);
    error BadSignature();
    error WrongCaller(address to);

    // ── Setup ────────────────────────────────────────────────────────────────

    /**
     * @param decimals_ varies across the fixture set on purpose. An 18-decimal token and a
     *        6-decimal token round differently in the settlement quote, and only a fixture with
     *        both proves the maker is never shorted.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 claimAmount_,
        uint64 claimCooldown_,
        address owner_
    ) ERC20(name_, symbol_) {
        if (owner_ == address(0) || claimAmount_ == 0) revert BadParameter();
        _decimals = decimals_;
        claimAmount = claimAmount_;
        claimCooldown = claimCooldown_;
        owner = owner_;
        _NAME_HASH = keccak256(bytes(name_));
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator(keccak256(bytes(name_)));
        emit OwnerSet(owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert BadParameter();
        owner = next;
        emit OwnerSet(next);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    // ── Faucet ───────────────────────────────────────────────────────────────

    /**
     * @notice Draw the drip. Anyone may call it, once per cooldown per address.
     *
     * @dev The cooldown is per address, so a fresh key defeats it. That is the right trade for a
     *      test net: it stops one account minting an absurd supply in a loop, and it costs an
     *      abuser a funded wallet per drip. Nothing here is worth more than the gas to take it.
     */
    function claim() external returns (uint256 amount) {
        uint64 readyAt = nextClaimAt[msg.sender];
        if (block.timestamp < readyAt) revert CooldownActive(readyAt);

        uint64 next = uint64(block.timestamp) + claimCooldown;
        nextClaimAt[msg.sender] = next;
        amount = claimAmount;
        _mint(msg.sender, amount);

        emit Claimed(msg.sender, amount, next);
    }

    /// @notice Seed a portfolio. The deploy script uses this to stock the owner's wallet.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // ── EIP-712 ──────────────────────────────────────────────────────────────

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _CACHED_CHAIN_ID
            ? _CACHED_DOMAIN_SEPARATOR
            : _buildDomainSeparator(_NAME_HASH);
    }

    function _buildDomainSeparator(bytes32 nameHash) private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, nameHash, VERSION_HASH, block.chainid, address(this))
        );
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    /// @dev One signature check for permit and all three `v, r, s` authorizations.
    function _check(address signer, bytes32 structHash, uint8 v, bytes32 r, bytes32 s)
        private
        view
    {
        (address recovered, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(_digest(structHash), v, r, s);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert BadSignature();
    }

    // ── EIP-2612 ─────────────────────────────────────────────────────────────

    /// @notice Approve by signature. The counter advances whether or not the allowance is spent.
    function permit(
        address owner_,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (block.timestamp > deadline) revert PermitExpired(deadline);

        uint256 nonce = nonces[owner_];
        nonces[owner_] = nonce + 1;

        _check(
            owner_,
            keccak256(abi.encode(PERMIT_TYPEHASH, owner_, spender, value, nonce, deadline)),
            v,
            r,
            s
        );
        _approve(owner_, spender, value);
    }

    // ── EIP-3009 ─────────────────────────────────────────────────────────────

    /// @inheritdoc IERC3009
    function authorizationState(address authorizer, bytes32 nonce) public view returns (bool) {
        return _authorized[authorizer][nonce];
    }

    /// @inheritdoc IERC3009
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
    ) external {
        _check(
            from,
            keccak256(
                abi.encode(
                    TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                    from,
                    to,
                    value,
                    validAfter,
                    validBefore,
                    nonce
                )
            ),
            v,
            r,
            s
        );
        _redeem(from, to, value, validAfter, validBefore, nonce);
    }

    /**
     * @notice The same transfer, but only the payee may submit it.
     * @dev EIP-3009 defines this alongside `transferWithAuthorization` to close a front-running
     *      hole: a contract that credits an incoming transfer can be paid by a third party who
     *      then keeps the credit. `ProveSettlement._redeem` calls this variant and never the
     *      other one. The transfer variant is a permissionless relay: anybody holding a copy of
     *      the signed intent could push the maker's tokens to the settlement, where they would
     *      credit no reservation and spend the authorization nonce. The maker would lose the lot.
     *      `to == msg.sender` is what closes it.
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
    ) external {
        if (to != msg.sender) revert WrongCaller(to);
        _check(
            from,
            keccak256(
                abi.encode(
                    RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                    from,
                    to,
                    value,
                    validAfter,
                    validBefore,
                    nonce
                )
            ),
            v,
            r,
            s
        );
        _redeem(from, to, value, validAfter, validBefore, nonce);
    }

    /**
     * @notice The same redemption, with an unstructured signature. ERC-7598.
     *
     * A contract wallet holds no key, so `ecrecover` can say nothing about what it signed. This
     * overload takes the signature as bytes and asks the signer itself, through ERC-1271, when
     * the signer has code. An ordinary key still works here — a 65-byte blob recovers exactly as
     * it does through the other overload — so a caller that only has this one loses nothing.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (to != msg.sender) revert WrongCaller(to);
        _checkSignature(
            from,
            keccak256(
                abi.encode(
                    RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                    from,
                    to,
                    value,
                    validAfter,
                    validBefore,
                    nonce
                )
            ),
            signature
        );
        _redeem(from, to, value, validAfter, validBefore, nonce);
    }

    /**
     * @notice Burn an authorization before anyone redeems it.
     * @dev This is the maker's only way out. A signature already in flight cannot be recalled, so
     *      spending the nonce is what revokes it.
     */
    function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)
        external
    {
        bytes32 structHash = keccak256(abi.encode(CANCEL_AUTHORIZATION_TYPEHASH, authorizer, nonce));
        _check(authorizer, structHash, v, r, s);
        _spend(authorizer, nonce);
        emit AuthorizationCanceled(authorizer, nonce);
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /**
     * @dev The ERC-7598 signature check: recover a key, or ask a contract.
     *
     * The order mirrors `ProveSettlement._validSignature`. An ordinary 65-byte signature settles
     * under `ecrecover` with no `EXTCODESIZE` on the signer; anything else, or a recovery that
     * does not match, falls through to ERC-1271, which is the only path a contract wallet ever
     * needed.
     */
    function _checkSignature(address signer, bytes32 structHash, bytes calldata signature)
        private
        view
    {
        bytes32 digest = _digest(structHash);
        if (signature.length == 65) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
            if (err == ECDSA.RecoverError.NoError && recovered == signer) return;
        }
        if (signer.code.length == 0) revert BadSignature();
        if (IERC1271(signer).isValidSignature(digest, signature) != ERC1271_MAGIC) {
            revert BadSignature();
        }
    }

    /// @dev The window is exclusive at both ends, as the specification writes it.
    function _redeem(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) private {
        if (block.timestamp <= validAfter) revert NotYetValid(validAfter);
        if (block.timestamp >= validBefore) revert AuthorizationExpired(validBefore);
        _spend(from, nonce);
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /// @dev The replay refusal. Every nonce is single-use, whether it is redeemed or cancelled.
    function _spend(address authorizer, bytes32 nonce) private {
        if (_authorized[authorizer][nonce]) revert AuthorizationUsedUp(authorizer, nonce);
        _authorized[authorizer][nonce] = true;
    }
}
