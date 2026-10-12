// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IProveCallback} from "./interfaces/IProveCallback.sol";
import {ProveCallSink} from "./ProveCallSink.sol";

interface IProveSettlementFill {
    /**
     * @dev A copy of `ProveSettlement.Intent`, and it must stay one field-for-field.
     *
     * The two are not checked against each other by the compiler: this contract only ever
     * encodes calldata for the other one. Drop a field here and `fillWithCallback` still builds,
     * still deploys, and reverts on every call because the ABI encoding no longer lines up.
     * `test/Executor.t.sol` fills through this interface against the real settlement, which is
     * what catches a drift — keep it that way.
     */
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

    function relayer() external view returns (address);
    function fillWithCallback(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        bytes calldata data,
        uint256 maxFeeRate
    ) external;
}

/**
 * @title ProveExecutor
 * @notice Fill an intent with no inventory, sourcing the other side from anywhere.
 *
 * `ProveSettlement.fillWithCallback` releases the maker's token A to its caller, calls that
 * caller, and then pulls what is owed. An EOA cannot use it — there is no code to call, and
 * nothing an EOA could do with the tokens in the middle of a transaction anyway. This contract is
 * that code, written once so nobody has to write it again: hand it a venue and a calldata blob
 * and it sells the maker's token A wherever you say, pays the maker, and gives you the
 * difference. PulseX, an aggregator, an RFQ desk — anything that settles inside one transaction.
 *
 * It is unowned and deployed once for everyone. Every fill ends with this contract holding what
 * it held at the start of the fill, and with no allowance left over. A donation, or a token the
 * caller's route leaves here, stays for good: there is no sweep and no rescue.
 *
 * **This contract never makes the caller's call.** `ProveCallSink` does, and the difference is
 * the whole security design. A contract that both accepts arbitrary calldata and might be granted
 * an ERC-20 allowance is Transit Swap, which lost $23M: point it at a token, say
 * `transferFrom(victim, me, everything)`, and the token obliges because the victim approved that
 * address. Filtering the selector does not fix it — an allowance can also be spent through
 * ERC-4626 `redeem`, ERC-721 `safeTransferFrom`, Permit2, ERC-777 `operatorSend`, Aave credit
 * delegation, or a `multicall` wrapping any of them, and the next token will invent another. The
 * set is open, so a denylist is a tripwire and never a boundary.
 *
 * Splitting the two roles closes it by construction. An allowance granted to this address is
 * unreachable by any caller, because no caller's calldata ever executes here.
 *
 * An allowance granted to the SINK would be reachable, so the sink is not one address. Each
 * caller drives their own clone of a template, at an address derived from theirs, and no other
 * caller ever drives it. Predicting somebody else's address costs nothing and buys nothing,
 * because only their own entry makes it run — which is what makes the caller's own `approve` a
 * claim on their own money and nobody else's. `ProveCallSink` has the argument in full.
 *
 * **What is still true, and load-bearing.** The maker cannot lose tokens without being paid,
 * whatever the caller does with the call. The release and the payment are the same transaction:
 * if the venue underpays, or the caller simply walks off with the released tokens, the settlement
 * fails to pull and the whole thing reverts. That safety comes from `ProveSettlement`, not from
 * here, and it depends on its refusal of `tokenIn == tokenOut` — without which a callback could
 * pay a maker with the maker's own money.
 *
 * **Native currency is not supported.** There is no `receive`, so a venue that refunds gas
 * currency, or a route that unwraps to it, reverts the fill. Wrapped tokens only.
 */
contract ProveExecutor is IProveCallback {
    using SafeERC20 for IERC20;

    /// @notice Where to sell the maker's token A, and the call that does it.
    struct Swap {
        /// @dev The address to approve. Usually `target`; some aggregators hold allowances apart.
        address spender;
        /// @dev The contract to call.
        address target;
        /// @dev The calldata to call it with. Built off chain by whoever wants the spread.
        bytes data;
        /**
         * @dev Any token the venue hands over besides the intent's own two — a keeper tip, a
         *      router reward, a rebate. Named by the caller because only they know what their
         *      route pays. Anything not named rests on this caller's own sink clone, which no
         *      other caller drives, so naming it in a later fill brings it home. Usually empty.
         */
        address[] extra;
    }

    IProveSettlementFill public immutable settlement;
    address public immutable relayer;
    /**
     * @notice The call sink TEMPLATE. It is never called, it never holds anything, and a payout
     *         aimed at it is lost.
     *
     * @dev Every venue call runs from an EIP-1167 clone of this, one per caller, minted by that
     *      caller's first fill. One sink shared by every caller was a standing claim on whatever
     *      the next caller stranded in it; a per-caller clone is an address no other caller ever
     *      drives, so the claim reaches only the writer's own money. `ProveCallSink` states the
     *      argument in full.
     *
     *      It was called `sink` until the 369 fork rehearsal aimed a router payout here and lost
     *      a run to `ERC20: transfer amount exceeds balance`. Nothing sweeps this address, so the
     *      name says what it is. `sinkFor` answers the address that does sweep, and a venue may
     *      pay this executor directly instead.
     *
     *      Published as an address because that is what a deploy script, a verification note and
     *      a fork test can check. Nothing else reads it.
     */
    ProveCallSink public immutable sinkTemplate;

    error NotSettlement();
    error ForbiddenTarget();
    error Reentered();
    error BalanceWentDown();
    error BadSettlement();
    error IntentTokenInExtra();
    error ProceedsNotHere(address token, uint256 held, uint256 owed);

    uint256 private _entered = 1;

    constructor(address _settlement) {
        if (_settlement.code.length == 0) revert BadSettlement();
        settlement = IProveSettlementFill(_settlement);
        relayer = IProveSettlementFill(_settlement).relayer();
        if (relayer == address(0)) revert BadSettlement();
        sinkTemplate = new ProveCallSink();
    }

    modifier nonReentrant() {
        if (_entered == 2) revert Reentered();
        _entered = 2;
        _;
        _entered = 1;
    }

    /**
     * @notice Fill `take` of an intent, paying for it out of the proceeds of `swap`.
     *
     * The caller keeps whatever the venue returned above what the maker and the fee destination were
     * owed, and pays only gas if the trade does not cover it — the settlement reverts the whole
     * fill rather than half-completing it.
     *
     * @param maxFeeRate the highest protocol fee this caller will pay. The settlement reads its
     *        fee at execution time, so an unbounded fill can be repriced under a pending
     *        transaction. Pass the fee the trade was priced with.
     */
    function fill(
        IProveSettlementFill.Intent calldata i,
        bytes calldata signature,
        uint256 take,
        uint256 maxFeeRate,
        Swap calldata swap
    ) external nonReentrant {
        /*
         * Snapshot first, and sweep only the increase.
         *
         * Sweeping the whole balance would hand a stranger anything already sitting here, and
         * worse: the settlement pulls its payment out of this contract, so a balance that was
         * donated rather than earned can discharge the maker's debt. `ProveSettlement` is careful
         * to pull rather than measure, exactly so a donation cannot pay for a fill — measuring
         * here would spend that guarantee on its behalf. A fill must end with at least what it
         * started with, in both tokens.
         */
        uint256 outBefore = IERC20(i.tokenOut).balanceOf(address(this));
        uint256 inBefore = IERC20(i.tokenIn).balanceOf(address(this));

        /*
         * The extras carry a mark too, and they used not to.
         *
         * `_sweepAbove(extra, 0, ...)` took the whole balance, so a token donated to this
         * contract left with whoever named it. The paragraph above says why that is wrong for
         * the intent's own two tokens; it is the same argument, and a third token is no less
         * somebody's. The contract holds nothing between transactions, so the exposure was
         * limited to tokens sent here by mistake — which is exactly the case a mark exists for.
         *
         * `ProveBatchExecutor` marks every token its route names, for this reason. The two
         * contracts should not disagree about whose money a stray balance is.
         */
        uint256[] memory extraBefore = new uint256[](swap.extra.length);
        for (uint256 k = 0; k < swap.extra.length; k++) {
            // `extra` means a token the intent does not name. Naming one of the intent's own
            // would sweep the same token twice against two different marks, and the second pass
            // would read a balance the first had already moved. The two lists have to stay
            // disjoint for either mark to mean anything.
            if (swap.extra[k] == i.tokenIn || swap.extra[k] == i.tokenOut) {
                revert IntentTokenInExtra();
            }
            extraBefore[k] = IERC20(swap.extra[k]).balanceOf(address(this));
        }

        /*
         * One sink for this caller, and never another caller's.
         *
         * Read here rather than in the callback so that the whole entry shares one — this path
         * makes a single venue call today, and `ProveBatchExecutor` makes several off one clone
         * for the same reason. The address rides down inside the callback payload because `paris`
         * has no transient storage, and a storage slot would have to be written and cleared on
         * every fill for a value that lives for one frame.
         *
         * The settlement calls back the address that called it, so this payload can only have
         * been written here. A stranger who calls `fillWithCallback` is called back themselves.
         */
        address callSink = _sinkFor(msg.sender);

        settlement.fillWithCallback(i, signature, take, abi.encode(swap, callSink), maxFeeRate);

        _sweepAbove(i.tokenOut, outBefore, msg.sender);
        _sweepAbove(i.tokenIn, inBefore, msg.sender);
        // The sink hands extras back here, so this is the second half of the same journey. Both
        // halves are needed: naming a token only in one of them strands it in the other.
        for (uint256 k = 0; k < swap.extra.length; k++) {
            _sweepAbove(swap.extra[k], extraBefore[k], msg.sender);
        }
    }

    /// @inheritdoc IProveCallback
    function proveCallback(address, Terms calldata t, bytes calldata data) external {
        address tokenIn = t.tokenIn;
        address tokenOut = t.tokenOut;
        if (msg.sender != address(settlement)) revert NotSettlement();
        // This caller's own sink, named by `fill` and carried through the settlement untouched.
        (Swap memory swap, address callSink) = abi.decode(data, (Swap, address));

        // The sink refuses the executor and itself; these two are the settlement's own rule 2,
        // and they belong wherever a caller picks an address.
        if (swap.target == relayer || swap.target == address(settlement)) revert ForbiddenTarget();
        if (swap.spender == relayer || swap.spender == address(settlement)) {
            revert ForbiddenTarget();
        }

        // The maker's tokens go to the sink, which makes the call and hands back the proceeds.
        // `amountIn` is what the settlement said it released; a token that taxes its own
        // transfers moves less, and the venue is approved for only what actually arrives.
        //
        // Measured as a difference, not as the sink's balance. The sink outlives the fill now, so
        // it can already hold this caller's earlier strand or a stranger's gift. Approving on the
        // balance would let the venue spend more than the settlement released.
        //
        // `t.amountIn` is `take - feeIn`: the part that is the solver's to use. On the approval
        // rung this contract holds `feeIn` more than that, a loan the settlement pulls back at the
        // flush, so it stays here and is approved below. Spending the whole `take` would revert.
        uint256 sinkBefore = IERC20(tokenIn).balanceOf(callSink);
        IERC20(tokenIn).safeTransfer(callSink, t.amountIn);
        uint256 sent = IERC20(tokenIn).balanceOf(callSink) - sinkBefore;
        ProveCallSink(callSink)
            .run(tokenIn, sent, tokenOut, swap.spender, swap.target, swap.data, swap.extra);

        /*
         * The proceeds have to be HERE, and this is where a venue that paid elsewhere says so.
         *
         * The settlement pulls `amountOwed` out of this contract the moment this returns, and
         * nothing moves in between. So a fill that works already holds this much at this point,
         * and the check refuses nothing that used to settle.
         *
         * What it catches is a payout aimed at an address that never sweeps — `sinkTemplate`
         * above all, which reads like a destination and is not one. That cost the 369 fork
         * rehearsal a run: the token reverted with `ERC20: transfer amount exceeds balance`,
         * frames below this one, naming neither the executor nor the address the money went to.
         */
        uint256 held = IERC20(tokenOut).balanceOf(address(this));
        if (held < t.owed) revert ProceedsNotHere(tokenOut, held, t.owed);

        // The settlement pulls through the relayer once this returns: `owed` of tokenOut (the
        // delivery now, P2 and P3 at the flush) and `feeInDue` of tokenIn (P1 on the approval rung).
        IERC20(tokenOut).forceApprove(relayer, t.owed);
        if (t.feeInDue != 0) {
            if (IERC20(tokenIn).balanceOf(address(this)) < t.feeInDue) {
                revert ProceedsNotHere(
                    tokenIn, IERC20(tokenIn).balanceOf(address(this)), t.feeInDue
                );
            }
            IERC20(tokenIn).forceApprove(relayer, t.feeInDue);
        }
    }

    /**
     * @notice Where a venue should pay when it does not pay this executor: `caller`'s own sink
     *         clone, which sweeps everything it holds back here.
     *
     * A solver reads the address here rather than deriving it. `sinkTemplate` is NOT this
     * address and receives nothing; a payout aimed at the template strands there and the fill
     * reverts with `ProceedsNotHere`.
     *
     * @dev The answer holds before the clone exists. The address is a hash of the template, the
     *      salt and this contract, so it names the same address on a caller's first fill and on
     *      their thousandth.
     */
    function sinkFor(address caller) public view returns (address) {
        bytes32 salt = bytes32(uint256(uint160(caller)));
        return Clones.predictDeterministicAddress(address(sinkTemplate), salt);
    }

    /**
     * @dev The one sink this caller ever drives, minted on their first fill. Every fill names a
     *      venue, so this path has no empty case the way `ProveBatchExecutor._sinkFor` does.
     *
     * The salt is the caller's own address, so every caller gets a different sink and every fill
     * by one caller finds the same one. That is what lets a caller recover a token their route
     * forgot to name: it waits on their sink, and their next fill can sweep it.
     *
     * Predicting another caller's address is easy and worthless. An approval only exists if the
     * sink executes `approve`, and only that caller's own fill makes their sink execute anything.
     *
     * `Clones.cloneDeterministic` reverts on an address that already holds code, so the check is
     * required rather than an optimisation. `sinkFor` reads `address(this)` as the deployer, and
     * each executor deploys its own template, so no salt can collide with another executor's.
     */
    function _sinkFor(address caller) private returns (address predicted) {
        predicted = sinkFor(caller);
        if (predicted.code.length == 0) {
            Clones.cloneDeterministic(address(sinkTemplate), bytes32(uint256(uint160(caller))));
        }
        return predicted;
    }

    /// @dev Hand on everything above the mark, and refuse to end below it.
    function _sweepAbove(address token, uint256 mark, address to) private {
        uint256 held = IERC20(token).balanceOf(address(this));
        if (held < mark) revert BalanceWentDown();
        if (held > mark) IERC20(token).safeTransfer(to, held - mark);
    }
}
