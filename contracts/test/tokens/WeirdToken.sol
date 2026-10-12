// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title WeirdToken
 * @notice One ERC-20 that misbehaves five ways on demand: it taxes transfers, it answers without
 *         the boolean the interface promises on a transfer, it answers without one on an
 *         `approve`, it answers `false` instead of moving anything, and it refuses named
 *         addresses.
 *
 * The five modes live in one contract with switches rather than five contracts, because the
 * interesting cases are combinations. A taxing token that also returns nothing is what breaks a
 * settlement that trusts return values, and no single-behaviour mock reaches that state.
 *
 * `silent` and `returnsFalse` are the two halves of the same trap and they are opposites. A
 * silent token succeeds and says nothing; a `false` token fails and says so. A caller that
 * decodes the answer breaks on the first, and a caller that ignores it breaks on the second.
 * Only `SafeERC20` reads both correctly, which is why `ProveRelayer` and `ProveSettlement` use
 * it. `returnsFalse` wins when both are set, because a token cannot both refuse and stay quiet.
 *
 * `test/Mocks.sol` has no overlap with this: it carries a plain `MockERC20`, a wrapper, a router
 * and several executors. `TaxToken` in `test/Security.t.sol` is a fixed 10% burn with no switches,
 * kept where it is so the audit regressions it pins keep testing exactly what they pinned.
 */
contract WeirdToken is ERC20 {
    uint256 public constant BPS = 10_000;

    /// @notice The deployer. Only they may change how the token misbehaves.
    address public immutable admin;

    uint8 private immutable _decimals;

    /// @notice Basis points burned out of every transfer. The recipient receives the rest.
    uint16 public feeBps;

    /// @notice When set, `transfer` and `transferFrom` return no data at all.
    bool public silent;

    /// @notice When set, `approve` returns no data either.
    ///
    /// @dev A separate switch from `silent`, because USDT is silent on both and a token can be
    ///      silent on one alone. It is the half that `SafeERC20.forceApprove` exists for: a
    ///      plain `IERC20.approve` on this token reverts decoding an empty buffer, so a contract
    ///      that writes one cannot grant an allowance over it at all.
    bool public silentApprove;

    /// @notice When set, `transfer` and `transferFrom` move nothing and return `false`.
    ///
    /// @dev The failure mode the ERC-20 text actually describes and almost nothing implements:
    ///      the call succeeds, no state changes, and the boolean carries the refusal. A caller
    ///      that ignores the return value reads this as a payment that was made.
    bool public returnsFalse;

    /// @notice Addresses that may neither send nor receive.
    mapping(address => bool) public blocked;

    event FeeSet(uint16 feeBps);
    event SilentSet(bool silent);
    event ReturnsFalseSet(bool returnsFalse);
    event SilentApproveSet(bool silentApprove);
    event BlockedSet(address indexed account, bool blocked);

    error NotAdmin();
    error BadParameter();
    error Blocked(address account);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        admin = msg.sender;
        _decimals = decimals_;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Open, because every test needs a balance and nothing here is worth anything.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // ── Switches ─────────────────────────────────────────────────────────────

    function setFeeBps(uint16 bps) external onlyAdmin {
        if (bps > BPS) revert BadParameter();
        feeBps = bps;
        emit FeeSet(bps);
    }

    function setSilent(bool on) external onlyAdmin {
        silent = on;
        emit SilentSet(on);
    }

    function setReturnsFalse(bool on) external onlyAdmin {
        returnsFalse = on;
        emit ReturnsFalseSet(on);
    }

    function setSilentApprove(bool on) external onlyAdmin {
        silentApprove = on;
        emit SilentApproveSet(on);
    }

    function setBlocked(address account, bool on) external onlyAdmin {
        blocked[account] = on;
        emit BlockedSet(account, on);
    }

    // ── Misbehaviour ─────────────────────────────────────────────────────────

    /// @dev The allowance is granted; only the answer is missing. That is USDT exactly, and it
    ///      is why every approval in `src/` goes through `SafeERC20.forceApprove`.
    function approve(address spender, uint256 value) public override returns (bool) {
        _approve(_msgSender(), spender, value);
        if (silentApprove) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        return true;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (returnsFalse) return false;
        _taxed(_msgSender(), to, value);
        _answer();
        return true;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        // Before the allowance is spent, because a token that moves nothing charges nothing.
        if (returnsFalse) return false;
        _spendAllowance(from, _msgSender(), value);
        _taxed(from, to, value);
        _answer();
        return true;
    }

    /// @dev The tax burns rather than paying a treasury. Either way the recipient is short, which
    ///      is the only part a settlement contract can detect, and burning needs no extra address.
    function _taxed(address from, address to, uint256 value) private {
        if (blocked[from]) revert Blocked(from);
        if (blocked[to]) revert Blocked(to);

        uint256 fee = (value * feeBps) / BPS;
        if (fee > 0) _burn(from, fee);
        _transfer(from, to, value - fee);
    }

    /**
     * @dev Return zero bytes, the way USDT and its imitators do. The declared return type still
     *      says `bool`, so only assembly can end the call with an empty return buffer. A caller
     *      that decodes the answer reverts; a caller using SafeERC20 accepts it.
     */
    function _answer() private view {
        if (!silent) return;
        assembly ("memory-safe") {
            return(0, 0)
        }
    }
}
