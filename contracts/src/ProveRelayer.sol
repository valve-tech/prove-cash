// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISignatureTransfer} from "./interfaces/IPermit2.sol";

/**
 * @title ProveRelayer
 * @notice The address makers approve. It holds nothing and it can do one thing.
 *
 * `ProveSettlement` used to be both the contract that held every maker's ERC-20 approval and the
 * contract that called out to addresses a caller chose. Those two roles at one address make the
 * settlement contract worth impersonating: any free-form call it can be made to perform reaches
 * every allowance ever granted to it, and the blast radius is the sum of all approvals rather than
 * the size of any one trade. One implicit property kept them apart — every call the settlement
 * makes carries a selector the settlement chose itself — and a property nobody wrote down is one a
 * future call site can drop without noticing.
 *
 * So the allowance lives here instead. This contract has no owner, no storage it can be told to
 * write, no upgrade path and no way to call an address a caller names. Two functions are the
 * entire surface, and only the settlement contract may reach either. A bug in `ProveSettlement`,
 * or a call site added years from now, cannot spend a maker's tokens unless it goes through one
 * of them — and `ProveSettlement` forbids its own callback context from ever targeting this
 * address.
 *
 * **The second function reaches a maker who granted this contract nothing.** `pullWithPermit2`
 * spends one Permit2 SignatureTransfer signature, and every address it touches is fixed at
 * construction: it calls Permit2 and nothing else, and it sends the tokens to the settlement and
 * nowhere else. A caller names the token, the amount and the signature — all three of which the
 * maker signed — and names no address at all. That makes it strictly narrower than `pull`, which
 * does take a destination.
 *
 * That rung exists because this contract's address is the cost of the binding below. The
 * settlement makes the relayer, so a settlement redeploy moves the relayer, and every maker's
 * standing ERC-20 approval then points at a dead contract. A maker who approves Permit2 instead
 * approves an address that never moves, and signs one short-lived permit per intent.
 *
 * The settlement contract deploys this in its own constructor and takes the address as an
 * immutable, so the two point at each other with no initializer, no prediction and no window in
 * which either is set to the wrong thing.
 *
 * CoW Protocol reached the same shape: users approve `GPv2VaultRelayer`, never `GPv2Settlement`,
 * and `executeInteractions` carries a literal prohibition on targeting the relayer.
 */
contract ProveRelayer {
    using SafeERC20 for IERC20;

    /// @notice The one contract that may ask this one to move anything.
    address public immutable settlement;

    /**
     * @notice Permit2, the one address `pullWithPermit2` calls.
     *
     * Configuration, handed down by the settlement's own constructor, never compiled in — the
     * rule `config/<chainid>.json` states for every address in `src/`. It is canonically the
     * same address on every chain, and "canonically" is not "provably", so a deployment says
     * which one it means.
     *
     * An immutable, so it lives in this contract's code rather than in storage: nothing can
     * repoint it, there is no owner who could, and this contract still writes no slot.
     */
    address public immutable permit2;

    error NotSettlement();

    /**
     * @dev Deployed by `ProveSettlement`'s constructor, so `msg.sender` is the settlement.
     * @param _permit2 the Permit2 deployment this chain uses. The settlement refuses a zero, so
     *        it cannot arrive here unset.
     */
    constructor(address _permit2) {
        settlement = msg.sender;
        permit2 = _permit2;
    }

    /**
     * @notice Move an approved token from a maker to a payee.
     *
     * @dev The whole contract. `SafeERC20` is here for the same reason it is in the settlement:
     *      a token that returns nothing on success must not read as a failure, and one that
     *      returns false must not read as a success.
     */
    function pull(address token, address from, address to, uint256 amount) external {
        if (msg.sender != settlement) revert NotSettlement();
        IERC20(token).safeTransferFrom(from, to, amount);
    }

    /**
     * @notice Spend one Permit2 signature, and move what it permits to the settlement.
     *
     * @dev The rung that survives a redeploy. A maker on it has approved Permit2 once, for good,
     *      and has granted this contract nothing at all — so `pull` cannot reach them and this
     *      is the only thing that can.
     *
     *      **`msg.sender` is the spender the maker signed.** Permit2 hashes the caller into the
     *      digest instead of reading a field off the permit, so the signature the settlement
     *      hands over names *this* address and is worthless to anybody else. A new relayer at a
     *      new address cannot present an old one, which is the same short life every other thing
     *      in a fill has and the opposite of a standing allowance.
     *
     *      **The destination is not a parameter.** Every one of these transfers ends at the
     *      settlement, which is the only place a reservation can be credited, so taking a `to`
     *      would widen this function past anything the settlement needs and would let a future
     *      call site aim a maker's Permit2 balance somewhere the maker never named. `pull` takes
     *      one because escrow deposits, maker payments and fees all have different payees; this
     *      has one payee for ever.
     *
     *      `amount` is what the settlement is taking now and `permit.permitted.amount` is what
     *      the maker signed for. Permit2 refuses the first if it exceeds the second, which is
     *      how a partial fill draws only what it fills rather than the whole lot.
     *
     *      No `try`, no swallowed error. Every refusal Permit2 can give — a spent nonce, a past
     *      deadline, a signature that is not the owner's — means this leg cannot fill, and the
     *      settlement calls this from inside `armLeg`'s revertable frame, where a revert costs a
     *      batch one skipped leg and leaves the maker's signature untouched.
     */
    /*
     * @dev It does NOT ask Permit2 whether the nonce is spent first. That was tried, measured and
     *      reverted on 2026-09-02, and the number is here so nobody proposes it a third time.
     *
     *      The idea: Permit2 spends the nonce before it checks the signature, so an arming call
     *      that cannot succeed pays for the write and the `ecrecover` before reverting. Read
     *      `nonceBitmap` first, the reasoning went, and skip the doomed call.
     *
     *      Measured, as a marginal leg on a batch of eight (`test/Gas.t.sol`):
     *
     *        a leg whose nonce a front-run burnt    44,669 -> 41,245   saves 3,424
     *        a permit2 leg that fills              152,046 -> 153,110  costs 1,064
     *
     *      It pays only if more than 31% of every armed permit2 leg meets a burnt nonce, which no
     *      book looks like. The saving is small because the expensive part of that failure was
     *      never the bitmap read: the staticcall warms the account and the slot that
     *      `permitTransferFrom` would have warmed anyway, so the only avoidable work is one call
     *      frame and one warm write.
     *
     *      The general lesson is worth more than the number. About 28,000 of a failed leg's
     *      48,569 is the ordinary cost of carrying it at all — calldata, the intent hash, the
     *      `ecrecover` over the maker's signature, the storage reads — and no check can avoid
     *      that, because looking at the leg closely enough to reject it IS most of the cost. The
     *      cheap place to reject a leg is off chain, where `dryRun` does it over `eth_call` for
     *      nothing. What is left on chain is the irreducible price of the gap between the
     *      simulation and the block, and a solver bounds that with a budget rather than a check
     *      — see `sdk/src/solver/trust.ts`.
     */
    function pullWithPermit2(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address from,
        uint256 amount,
        bytes calldata signature
    ) external {
        if (msg.sender != settlement) revert NotSettlement();
        ISignatureTransfer(permit2)
            .permitTransferFrom(
                permit,
                ISignatureTransfer.SignatureTransferDetails({
                    to: settlement, requestedAmount: amount
                }),
                from,
                signature
            );
    }
}
