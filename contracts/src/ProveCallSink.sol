// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ProveCallSink
 * @notice The address that makes the arbitrary call, so that `ProveExecutor` does not.
 *
 * `ProveExecutor` sells a maker's tokens at a venue the caller names, with calldata the caller
 * writes. Somebody has to make that call. Whoever does can be pointed at a token and told to move
 * money — not just through `transferFrom`, but through ERC-4626 `redeem`, ERC-721
 * `safeTransferFrom`, Permit2, ERC-777 `operatorSend`, Aave credit delegation, or a `multicall`
 * that wraps any of them. A denylist of selectors cannot cover that, because the set is open: a
 * token invented tomorrow can add a new way to spend an allowance.
 *
 * So the fix is not to filter the call. It is to make the call from an address nobody has any
 * reason to approve. This contract is that address. It is not advertised, and no interface asks
 * for an allowance to it. A run leaves it none of the tokens it names and no allowance of its own
 * making. What a caller's own calldata leaves behind stays in that caller's clone. An approval
 * granted to `ProveExecutor` — by habit, by a phishing page, by a user who approved the settlement
 * once and assumed — is unreachable from here, because the executor is not the caller of the
 * venue.
 *
 * This is the relayer split again, one level down. `ProveRelayer` exists so that the contract
 * holding every allowance is not the contract that calls strangers. `ProveCallSink` exists so
 * that the contract strangers call from is not the contract anyone might approve.
 *
 * **One sink per caller, and no two callers ever share one.** A deployed sink is a template. Its
 * executor clones it (EIP-1167) at an address derived from `msg.sender` and drives that clone.
 * The caller's first entry mints it, and every entry after that reuses the same address. The
 * template itself is never driven and never holds anything.
 *
 * That is not tidiness. It is the whole answer to the hazard the next paragraph names. A caller's
 * own calldata can write an `approve` that outlives the call, and one shared sink made that
 * approval a standing claim on whatever a LATER caller left behind — arm it for nothing, wait for
 * somebody else's venue to pay a token their route did not name, and take it. Only the sink can
 * grant an allowance over the sink's own balance, so an approval a caller writes reaches their
 * own sink and no other.
 *
 * Arming somebody else's sink is not possible. Predicting the address is easy and worthless: to
 * make it execute an `approve` you have to make it run, and only its own caller's entry runs it.
 *
 * What a caller strands is theirs, and they can take it back. A token this sink is not told to
 * sweep rests here, on the caller's own sink, which their next entry drives again. Name it in a
 * later call and it comes home. No other caller can reach it. Name every token the route can pay
 * in anyway, because the recovery costs a second transaction.
 *
 * **A recovered token is spendable inside the transaction that recovers it.** The executor sweeps
 * this sink before the settlement pulls, so a strand can pay the recovering caller's own makers
 * rather than only reaching their wallet. That is their own capital, off a sink only they drive,
 * in a transaction they sent — which is why it is allowed, and why it takes nothing away from the
 * executor's refusal to spend a donation. `test_ARecoveredStrandPaysTheCallersOwnRing` pins both
 * halves side by side.
 *
 * **The caveat is a caller that is itself a public contract.** Its own users share its sink, so
 * one of them can arm a claim on what another strands there. That is a choice the contract's
 * author makes rather than one this contract can make for them, and it is still far better than
 * one sink for everybody.
 *
 * Only the executor can drive it, and it hands everything back before it returns.
 */
contract ProveCallSink {
    using SafeERC20 for IERC20;

    /// @notice The one contract that may make this one call out.
    ///
    /// @dev An immutable, so it lives in the template's runtime code rather than in any clone's
    ///      storage. A clone delegatecalls that code, so every clone reads the address that
    ///      deployed the template — which is the executor, and which no clone can be tricked
    ///      into disagreeing about. `test/Executor.t.sol` proves it rather than assuming it.
    address public immutable executor;

    /// @notice The template every clone runs the code of. It is never driven.
    ///
    /// @dev `address(this)` in a constructor is the contract being deployed, and only the
    ///      template has a constructor — a clone is created from 45 bytes of proxy code and runs
    ///      none. So this is the template's address in the template and in every clone alike,
    ///      which is what lets `run` refuse to be aimed at it.
    address public immutable template;

    error NotExecutor();
    error ForbiddenTarget();
    error SwapFailed(bytes reason);

    /// @dev Deployed by the executor's constructor, so `msg.sender` is the executor.
    constructor() {
        executor = msg.sender;
        template = address(this);
    }

    /**
     * @notice Approve a venue, call it, and hand back everything that results.
     *
     * @dev The approval is for an exact amount and is set back to zero before this returns, so
     *      nothing this contract grants outlives the transaction that granted it.
     *
     *      An `approve` the *caller's* own calldata writes does outlive it. That is unavoidable
     *      with an arbitrary call. It grants a standing claim on whatever is in here — and here
     *      is the caller's own sink, which no other caller drives, so the claim is over their own
     *      money.
     *
     *      The caller still names every token to sweep: `tokenIn` and `tokenOut` go back
     *      automatically, and `extra` covers anything else the venue hands over — a keeper tip, a
     *      router reward, a rebate. An earlier version swept only the two and called the rest
     *      impossible, which was wrong: a third token stranded here for ever. Whatever the caller
     *      forgets to name waits on their own sink until they name it in a later call.
     */
    function run(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        address spender,
        address target,
        bytes calldata data,
        address[] calldata extra
    ) external {
        if (msg.sender != executor) revert NotExecutor();
        // Aiming the call back at the executor would let a caller drive it with its own
        // authority. Nothing there is reachable today — `fill` is guarded and `proveCallback`
        // checks its caller — but this is the rule the settlement states about itself.
        //
        // `address(this)` is this clone and `template` is what `sinkTemplate()` publishes. Both
        // are the sink as far as a caller is concerned, so rule 2 answers the same for both.
        if (
            target == executor || spender == executor || target == address(this)
                || target == template
        ) {
            revert ForbiddenTarget();
        }

        IERC20(tokenIn).forceApprove(spender, amountIn);
        (bool ok, bytes memory reason) = target.call(data);
        if (!ok) revert SwapFailed(_clip(reason));
        IERC20(tokenIn).forceApprove(spender, 0);

        _sweep(tokenOut, executor);
        _sweep(tokenIn, executor);
        for (uint256 k = 0; k < extra.length; k++) {
            _sweep(extra[k], executor);
        }
    }

    /// @dev Nothing rests here. Whatever the venue paid, and whatever it declined to take.
    function _sweep(address token, address to) private {
        uint256 held = IERC20(token).balanceOf(address(this));
        if (held > 0) IERC20(token).safeTransfer(to, held);
    }

    /**
     * @dev A revert reason, bounded.
     *
     * The caller picks the target, and a target that answers with megabytes charges the caller
     * quadratically for the memory. `ProveSettlement._probe` caps its copy for the same reason.
     * The caller is the one who pays here, so this is manners rather than a defence — but a
     * bounded copy costs nothing and an unbounded one has no upside.
     */
    function _clip(bytes memory reason) private pure returns (bytes memory out) {
        if (reason.length <= 256) return reason;
        out = new bytes(256);
        for (uint256 k = 0; k < 256; k++) {
            out[k] = reason[k];
        }
    }
}
