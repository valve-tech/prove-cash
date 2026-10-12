// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title RebasingToken
 * @notice A token whose balances move without a transfer. An admin scales every holder at once,
 *         up or down, the way stETH moves when validators earn or are slashed.
 *
 * The fixture set had no such token, and a balance that changes underneath the contract is the one
 * hazard escrow accounting cannot see. `ProveSettlement` books a reservation as a number per
 * intent, and it holds every reservation of one asset in a single balance. Nothing reads that
 * balance again between the deposit and the fill. So a rebase down leaves the book claiming more
 * than the contract holds, and a rebase up strands the gain where no withdrawal reaches it.
 * `test/TokenMatrix.t.sol` measures both and prints the numbers.
 *
 * **Shares, not balances.** Each holder owns a share. `balanceOf` multiplies that share by one
 * index, and a rebase moves the index and writes no holder's slot. That is what makes a balance
 * move with nobody's transaction, and it is how stETH and every elastic token worth testing
 * against are built.
 *
 * The index is exact at the two factors the matrix uses, doubling and halving, and it truncates
 * elsewhere — a share model always does. An allowance is denominated in tokens and a rebase does
 * not touch it, which is also what stETH does.
 *
 * EIP-2612 is here because stETH has it, so the permit rung has a rebasing token to run against.
 * EIP-3009 is not, because no elastic token implements it. The matrix records that cell as one
 * the token cannot take rather than one that fails.
 *
 * @dev The EIP-712 plumbing is written out rather than inherited from OpenZeppelin's `EIP712`.
 *      That base reaches `Strings`, which reaches `Bytes`, which emits `mcopy` — an opcode the
 *      project's `evm_version = "paris"` forbids. `test/tokens/FaucetToken.sol` says the same.
 */
contract RebasingToken is ERC20 {
    // ── Constants ────────────────────────────────────────────────────────────

    uint256 public constant BPS = 10_000;

    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant NAME_HASH = keccak256("Rebasing");
    bytes32 private constant VERSION_HASH = keccak256("1");

    // ── State ────────────────────────────────────────────────────────────────

    /// @notice The deployer. Only they may move the index.
    address public immutable admin;

    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

    /// @notice Tokens per share, in basis points. Ten thousand is one for one.
    uint256 public indexBps = BPS;

    /// @notice The EIP-2612 counter, one per owner, as that standard requires.
    mapping(address => uint256) public nonces;

    // ── Events ───────────────────────────────────────────────────────────────

    event Rebased(uint256 indexBps);

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotAdmin();
    error BadParameter();
    error PermitExpired(uint256 deadline);
    error BadSignature();

    // ── Setup ────────────────────────────────────────────────────────────────

    constructor() ERC20("Rebasing", "RBS") {
        admin = msg.sender;
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    /// @notice Open, because every test needs a balance and nothing here is worth anything.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // ── The rebase ───────────────────────────────────────────────────────────

    /**
     * @notice Scale every balance at once. Twenty thousand doubles them, five thousand halves
     *         them, and nobody's slot is written.
     *
     * @param bps the factor, in basis points of the balances as they stand.
     */
    function rebase(uint256 bps) external {
        if (msg.sender != admin) revert NotAdmin();
        if (bps == 0) revert BadParameter();
        indexBps = (indexBps * bps) / BPS;
        emit Rebased(indexBps);
    }

    // ── The share model ──────────────────────────────────────────────────────

    function balanceOf(address account) public view override returns (uint256) {
        return _toTokens(super.balanceOf(account));
    }

    function totalSupply() public view override returns (uint256) {
        return _toTokens(super.totalSupply());
    }

    /**
     * @dev Every mint, burn and transfer arrives here in tokens and is stored in shares.
     *
     * The balance check is repeated in token terms so the error a caller reads names the units
     * they asked in. The base class would answer in shares, which is a number the caller never
     * chose and cannot recognise.
     */
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0)) {
            uint256 have = balanceOf(from);
            if (have < value) revert ERC20InsufficientBalance(from, have, value);
        }
        super._update(from, to, _toShares(value));
    }

    function _toShares(uint256 tokens) private view returns (uint256) {
        return (tokens * BPS) / indexBps;
    }

    function _toTokens(uint256 shares) private view returns (uint256) {
        return (shares * indexBps) / BPS;
    }

    // ── EIP-2612 ─────────────────────────────────────────────────────────────

    // solhint-disable-next-line func-name-mixedcase
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return
            block.chainid == _CACHED_CHAIN_ID ? _CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

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

        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner_, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, v, r, s);
        if (err != ECDSA.RecoverError.NoError || recovered != owner_) revert BadSignature();

        _approve(owner_, spender, value);
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }
}
