// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

/**
 * @title InventoryExecutor
 * @notice The smallest thing that can fill through `ProveSettlement.fillWithCallback`: it takes
 *         token A, swaps nothing at all, and pays for it out of token B it already holds.
 *
 * The no-inventory path is called that because the *settlement contract* holds no inventory and
 * the executor needs none at the moment the fill starts — token A arrives first, and the payment
 * is pulled afterwards. What sits between those two moments is the executor's business. A real
 * one routes token A through a market and repays from the proceeds. There is no market on
 * PulseChain testnet, so this one skips the middle and repays from a stock it was given, which
 * exercises exactly the same contract path: release, call back, pull.
 *
 * @dev Two shapes here are deliberate and neither is a shortcut.
 *
 *      `SETTLEMENT` is a compile-time constant rather than a constructor immutable. The
 *      TypeScript driver checks it against `settlement(943)` in the SDK registry before it will
 *      compile this file, so the address is still read from the registry — and a constant leaves
 *      the artifact's `deployedBytecode` byte-identical to the runtime code, which is what lets
 *      the driver prove the whole path with an `eth_call` state override before anything is
 *      deployed. An immutable would leave a zeroed slot in the artifact and make that impossible.
 *
 *      `proveCallback` refuses any caller but the settlement contract. Without that check anyone
 *      could call it directly and walk away with an allowance over this contract's token B.
 */

interface IERC20 {
    function approve(address spender, uint256 value) external returns (bool);
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IProveSettlement {
    /// @dev Field for field with `ProveSettlement.Intent`, in the same order.
    ///      `assertIntentStructMatches` in `common.ts` compares these names with the settlement's
    ///      own ABI before this file is compiled, so a drift stops there instead of encoding
    ///      the wrong number of fields. The fee is the hash of a fee config plus three rates, one
    ///      per take point; there is no fee destination in the intent.
    struct Intent {
        address maker;
        address recipient;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minOutStart;
        uint256 minOutEnd;
        uint64 startTime;
        uint64 endTime;
        address executor;
        bytes32 feeConfig;
        uint64 feeRate;
        uint256 minFill;
        bytes32 authNonce;
        uint8 flags;
        uint256 nonce;
        bytes32 curve;
        uint64 feeRateIn;
        uint64 feeRateProceeds;
    }

    struct FillRequest {
        Intent intent;
        bytes signature;
        uint256 take;
        bytes arming;
    }

    function fillWithCallback(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        bytes calldata data,
        uint256 maxFeeRate
    ) external;

    function fillBatchWithCallback(
        FillRequest[] calldata reqs,
        bool skipInvalid,
        bytes calldata data,
        uint256 maxFeeRate
    ) external returns (uint256);
}

/// @dev Field for field with `IProveCallback.Terms`.
interface IProveCallback {
    struct Terms {
        address tokenIn;
        uint256 amountIn;
        uint256 feeIn;
        uint256 feeInDue;
        address tokenOut;
        uint256 owedToMaker;
        uint256 feeOut;
        uint256 feeProceeds;
        uint256 delivered;
        uint256 owed;
    }
}

/// @dev Field for field with `IProveBatchCallback.Payment`. `Payment` is static, so the decoder
///      strides by the struct's own width: a copy that is a field short reads the wrong word for
///      every line after the first, and a single-leg fill still works. Keep it exact.
interface IProveBatchCallback {
    struct Payment {
        address token;
        address to;
        uint256 amount;
        uint256 fee;
        bytes32 feeConfig;
        uint256 leg;
        address tokenIn;
        uint256 amountIn;
        uint256 feeIn;
        uint256 feeInDue;
        uint256 feeProceeds;
    }
}

contract InventoryExecutor {
    /// @notice ProveSettlement on PulseChain testnet 943, checked against the SDK registry before
    ///         this file is compiled.
    address public constant SETTLEMENT = 0x9Df7d6796012213a573a7b2C1Eb87048E2407C46;

    /**
     * @dev The address that pulls, which is not the address that calls.
     *
     * `ProveSettlement` holds no allowance from anyone. It calls this contract back, and then
     * `ProveRelayer` pulls what is owed. So the caller check below stays on `SETTLEMENT` and every
     * `approve` names `RELAYER`.
     *
     * A constant for the same reason `SETTLEMENT` is one, and I learned it the hard way: as an
     * immutable it read as the zero address under the driver's state override, because a state
     * override installs runtime code and never runs a constructor. Every `approve` then failed
     * with `ERC20InvalidSpender`. The driver checks this against `settlement.relayer()` on chain
     * before it will compile the file.
     */
    address public constant RELAYER = 0xB335167D69cE7e70180Ae4c6DF93dC541104b5a7;

    /// @dev Storage slot 0. The driver's dry run overrides this slot, so do not move it.
    address public owner;

    event Repaid(address indexed tokenOut, uint256 amount);
    event Received(address indexed tokenIn, uint256 amount);

    error NotOwner();
    error NotSettlement();
    error NotMe();
    error ApprovalRejected();

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Start a fill. The settlement contract calls this contract straight back.
    function fill(
        IProveSettlement.Intent calldata i,
        bytes calldata signature,
        uint256 take,
        uint256 maxFeeRate
    ) external onlyOwner {
        IProveSettlement(SETTLEMENT).fillWithCallback(i, signature, take, "", maxFeeRate);
    }

    /**
     * @notice Token A has arrived; owe token B by the time this returns.
     *
     * An allowance, not a transfer. The relayer pulls what is owed, after this returns, with
     * directed `transferFrom` calls and never infers a payment from a balance that happened to
     * rise. `t.owed` is the whole tokenOut debt (the maker's amount plus the output fee, which
     * the settlement reserves in its fee book); `t.feeInDue` is the handover fee this contract
     * physically holds on the approval rung and owes back in tokenIn.
     */
    function proveCallback(address executor, IProveCallback.Terms calldata t, bytes calldata)
        external
    {
        if (msg.sender != SETTLEMENT) revert NotSettlement();
        if (executor != address(this)) revert NotMe();

        emit Received(t.tokenIn, t.amountIn);
        if (!IERC20(t.tokenOut).approve(RELAYER, t.owed)) revert ApprovalRejected();
        emit Repaid(t.tokenOut, t.owed);
        if (t.feeInDue != 0) {
            if (!IERC20(t.tokenIn).approve(RELAYER, t.feeInDue)) revert ApprovalRejected();
            emit Repaid(t.tokenIn, t.feeInDue);
        }
    }

    /**
     * @notice Settle a whole ring on credit. Every leg's token A arrives before any payment is
     *         due, so this contract needs no inventory beyond the fees.
     */
    function fillRing(
        IProveSettlement.FillRequest[] calldata reqs,
        bool skipInvalid,
        uint256 maxFeeRate
    ) external onlyOwner returns (uint256) {
        return IProveSettlement(SETTLEMENT).fillBatchWithCallback(reqs, skipInvalid, "", maxFeeRate);
    }

    /**
     * @notice Every release has landed; owe every payment by the time this returns.
     *
     * One allowance per token, sized to the whole list, because the relayer pulls each line with
     * its own directed `transferFrom`. A token's debt is every line's `amount + fee` in it, plus
     * the `feeInDue` of every line whose tokenIn it is. Approving per line would overwrite the
     * first line's allowance with the second's.
     */
    function proveBatchCallback(IProveBatchCallback.Payment[] calldata owed, bytes calldata)
        external
    {
        if (msg.sender != SETTLEMENT) revert NotSettlement();

        for (uint256 k = 0; k < owed.length; k++) {
            _approveOnce(owed, k, owed[k].token);
            _approveOnce(owed, k, owed[k].tokenIn);
        }
    }

    /// @dev Approve `token` for its whole debt over `owed`, at the first line that names it.
    function _approveOnce(IProveBatchCallback.Payment[] calldata owed, uint256 k, address token)
        private
    {
        uint256 total;
        for (uint256 j = 0; j < owed.length; j++) {
            bool named = owed[j].token == token || owed[j].tokenIn == token;
            if (named && j < k) return; // an earlier line already approved it
            if (owed[j].token == token) total += owed[j].amount + owed[j].fee;
            if (owed[j].tokenIn == token) total += owed[j].feeInDue;
        }
        if (total == 0) return;
        if (!IERC20(token).approve(RELAYER, total)) revert ApprovalRejected();
        emit Repaid(token, total);
    }

    /// @notice Take everything of one token back out. Nothing here is meant to be left behind.
    function sweep(address token, address to) external onlyOwner returns (uint256 amount) {
        amount = IERC20(token).balanceOf(address(this));
        if (amount > 0) IERC20(token).transfer(to, amount);
    }
}
