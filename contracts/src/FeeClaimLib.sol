// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FeeConfig} from "./FeeConfig.sol";

/**
 * @title FeeClaimLib
 * @notice `ProveSettlement.claim` and `announceFeeConfig`, moved out of the settlement's bytecode
 *         so it fits the 24,576-byte limit (spec 2.3, option C). A linked EXTERNAL library: the
 *         settlement `DELEGATECALL`s it, so it runs in the settlement's own context and storage
 *         and `address(this)` is the settlement.
 *
 * **Trust.** The library's address is fixed in the settlement's bytecode at link time, and the
 * library has no `SELFDESTRUCT` and no `DELEGATECALL` of its own (`test/FeeClaim.t.sol`
 * checks the deployed bytecode for both), so what runs is fixed for the life of the deployment.
 * It has no owner and no storage. Called directly, it can only touch its own empty storage.
 *
 * The settlement keeps the lock: `claim` is `nonReentrant` there, before the delegatecall.
 * `announce` only logs.
 *
 * The events and errors are declared here because the library emits and raises them; the
 * settlement redeclares the same signatures so its ABI lists them.
 */
library FeeClaimLib {
    using SafeERC20 for IERC20;

    /// @dev What one transfer in a multi-destination claim may spend.
    uint256 internal constant TRANSFER_GAS = 200_000;

    event FeeClaimed(
        bytes32 indexed feeConfig, address indexed token, uint256 paid, uint256 deferred
    );
    event ShareDeferred(
        bytes32 indexed feeConfig,
        address indexed token,
        address indexed destination,
        uint256 amount
    );
    event FeeConfigAnnounced(bytes32 indexed feeConfig, address[] destinations, uint256[] weights);
    error InvalidConfig(FeeConfig.Fault fault);
    error InsufficientGas();

    /// @dev Pay `pending[hash(cfg)][token]` to the destinations by weight. See
    ///      `ProveSettlement.claim` for the rules. `relayer` and `address(this)` may not be
    ///      destinations.
    function pay(
        mapping(bytes32 => mapping(address => uint256)) storage pending,
        mapping(address => uint256) storage total,
        FeeConfig.Config calldata cfg,
        address token,
        address relayer
    ) external returns (uint256 paid) {
        FeeConfig.Fault f = FeeConfig.fault(cfg);
        if (f == FeeConfig.Fault.None) {
            for (uint256 k = 0; k < cfg.destinations.length; k++) {
                address d = cfg.destinations[k];
                if (d == address(this) || d == relayer) f = FeeConfig.Fault.ReservedDestination;
            }
        }
        if (f != FeeConfig.Fault.None) revert InvalidConfig(f);

        bytes32 h = FeeConfig.hash(cfg);
        uint256 amount = pending[h][token];
        if (amount == 0) return 0;
        pending[h][token] = 0;

        uint256 n = cfg.destinations.length;
        if (n == 1) {
            total[token] -= amount;
            IERC20(token).safeTransfer(cfg.destinations[0], amount);
            emit FeeClaimed(h, token, amount, 0);
            return amount;
        }

        uint256[] memory shares = FeeConfig.split(amount, cfg.weights);
        uint256 deferred;
        for (uint256 k = 0; k < n; k++) {
            uint256 share = shares[k];
            if (share == 0) continue;
            if (gasleft() < TRANSFER_GAS + TRANSFER_GAS / 63 + 30_000) revert InsufficientGas();
            address to = cfg.destinations[k];
            if (_tryTransfer(token, to, share)) {
                total[token] -= share;
                paid += share;
            } else {
                pending[FeeConfig.singleHash(to)][token] += share;
                deferred += share;
                emit ShareDeferred(h, token, to, share);
            }
        }
        emit FeeClaimed(h, token, paid, deferred);
    }

    /// @dev Log a config's preimage. Reverts when it is not canonical.
    function announce(FeeConfig.Config calldata cfg) external {
        FeeConfig.Fault f = FeeConfig.fault(cfg);
        if (f != FeeConfig.Fault.None) revert InvalidConfig(f);
        emit FeeConfigAnnounced(FeeConfig.hash(cfg), cfg.destinations, cfg.weights);
    }

    /// @dev `token.transfer(to, amount)` with `TRANSFER_GAS`, returndata read up to one word
    ///      (return-bomb safe). Success is a call that succeeded and returned nothing or `true`.
    function _tryTransfer(address token, address to, uint256 amount) private returns (bool ok) {
        uint256 cap = TRANSFER_GAS;
        bytes memory data = abi.encodeCall(IERC20.transfer, (to, amount));
        assembly ("memory-safe") {
            ok := call(cap, token, 0, add(data, 0x20), mload(data), 0x00, 0x20)
            // Success is a call that succeeded and returned nothing, or one word that is 1. No
            // branch: a failed call leaves `ok` zero whatever the scratch word holds.
            let rds := returndatasize()
            ok := and(ok, or(iszero(rds), and(gt(rds, 31), eq(mload(0x00), 1))))
        }
    }
}
