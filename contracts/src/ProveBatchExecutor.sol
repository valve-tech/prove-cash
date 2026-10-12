// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IProveBatchCallback} from "./interfaces/IProveBatchCallback.sol";
import {IProveSettlementFill} from "./ProveExecutor.sol";
import {ProveCallSink} from "./ProveCallSink.sol";

/**
 * @dev The batch half of the settlement's surface, and the `Intent` mirror it needs.
 *
 * `Intent` comes from `ProveExecutor.sol` rather than being typed again here. That struct must
 * stay field-for-field with `ProveSettlement.Intent` or every call reverts on chain, and the
 * compiler checks none of it. One mirror in the repository can drift once. Two can drift apart
 * from each other as well, and the second drift compiles, deploys and passes `forge build`.
 */
interface IProveSettlementBatch {
    struct FillRequest {
        IProveSettlementFill.Intent intent;
        bytes signature;
        uint256 take;
        /// @notice Empty, or the signature that reaches this maker's funds. The settlement
        ///         decides which kind it is from the intent's own escrow flag.
        bytes arming;
    }

    function relayer() external view returns (address);
    function fillBatchWithCallback(
        FillRequest[] calldata reqs,
        bool skipInvalid,
        bytes calldata data,
        uint256 maxFeeRate
    ) external returns (uint256 count);
}

/**
 * @title ProveBatchExecutor
 * @notice Settle a whole ring of intents with no inventory, sourcing every side from anywhere.
 *
 * `ProveSettlement.fillBatchWithCallback` releases every leg's token A to its caller, calls that
 * caller once, and then pulls every payment. So the token one maker sells is already in this
 * contract's hands when the next maker's payment goes out, and a ring of intents that pay for
 * each other needs no working capital at all. An EOA cannot use that entry point, because there
 * is no code to call back. This contract is that code.
 *
 * Where `ProveExecutor` sells one maker's token at one venue, this one runs a list of venue
 * calls against the whole released bag. A pure ring names no venue and closes on the intents
 * alone. A ring with a pool leg names one, and the swap that used to be a second transaction
 * from the solver's own wallet now settles inside the same one — which is the point, because a
 * pool that moves between two transactions leaves the solver holding the position.
 *
 * It is unowned and deployed once for everyone. Every ring ends with this contract holding what
 * it held at the start, in each token the route names, and with no allowance left over. A
 * donation, or a token the route forgets to name, stays for good: there is no sweep and no rescue.
 *
 * **This contract never makes the caller's call.** `ProveCallSink` does, and that split is the
 * whole security design — read the argument in `ProveCallSink.sol`, because it is the reason
 * this file exists as a separate address rather than as three more functions on `ProveExecutor`.
 * A contract that both accepts arbitrary calldata and might be granted an ERC-20 allowance is
 * Transit Swap, which lost $23M. An allowance granted to this address is unreachable by any
 * caller, because no caller's calldata ever executes here. And the sink is not one address: each
 * solver drives their own clone of a template, at an address derived from theirs, so an approval
 * a caller writes from inside their own venue call is a claim on their own money and nobody
 * else's.
 *
 * **The mark is the second half of that argument, and it is one rule here.** Every token the
 * route names is measured before the ring, and the contract refuses to end below any of those
 * marks. So this address never spends a balance it did not earn in the same transaction: not by
 * sweeping it, not by selling it at a venue, and not by letting the settlement pull a maker's
 * payment out of it. Seeding it with inventory buys nothing and risks the lot.
 *
 * Three lists feed those marks, and all three have to. `Route.sweep` is what the caller wants
 * back. Every swap's `tokenIn` is what a venue can carry away, and marking only the sweep list
 * left a donation stealable by naming it in a swap and leaving it off. Every `owed` token is
 * what the settlement pulls, and marking only the other two left a donation able to pay for a
 * stranger's fill — so the callback refuses an `owed` token the sweep list does not name.
 *
 * `ProveExecutor` states the same rule over the two tokens its intent names, plus a
 * disjointness check on the third. A ring names no fixed set of tokens, so the rule is stated
 * once over one mark instead — which is why the two contracts do not share an address. One
 * clause survives contributors; one with a case split is how a load-bearing property goes
 * unwritten.
 *
 * **What is still true, and load-bearing.** No maker can lose tokens without being paid,
 * whatever the caller does with the venue calls. Every release and every payment is the same
 * transaction: if a venue underpays, or the caller walks off with the released tokens, the
 * settlement fails to pull and the whole ring reverts. That safety comes from `ProveSettlement`,
 * not from here.
 *
 * **Native currency is not supported.** There is no `receive`, so a venue that refunds gas
 * currency, or a route that unwraps to it, reverts the ring. Wrapped tokens only.
 */
contract ProveBatchExecutor is IProveBatchCallback {
    using SafeERC20 for IERC20;

    /// @notice One venue call: what to sell, where to sell it, and the calldata that does it.
    struct Swap {
        /// @dev The token to sell, and how much of it. A ring hands this contract a bag rather
        ///      than a named amount, so the caller says which part of the bag this call spends.
        address tokenIn;
        uint256 amountIn;
        /// @dev The token the venue pays. The sink hands it straight back here.
        address tokenOut;
        /// @dev The address to approve. Usually `target`; some aggregators hold allowances apart.
        address spender;
        /// @dev The contract to call.
        address target;
        /// @dev The calldata to call it with. Built off chain by whoever wants the spread.
        bytes data;
        /**
         * @dev Any token the venue hands over besides this call's own two — a keeper tip, a
         *      router reward, a rebate. Named by the caller because only they know what their
         *      route pays. Anything not named rests on this caller's own sink clone, which no
         *      other caller drives, so naming it in a later ring brings it home. Usually empty.
         */
        address[] extra;
        /**
         * @dev Which leg of the batch this call exists for, as an index into the `reqs` array —
         *      or `ANY_LEG` for a call that runs whatever settles.
         *
         *      A batch is not a ring. If six of eight legs arm, the caller owes those six and
         *      the route has to match those six, not the eight it was built for. So a call that
         *      only makes sense because of one particular leg names that leg, and it is skipped
         *      when the leg is. A call that closes the whole batch names `ANY_LEG` and always
         *      runs — which is right for a route sent with `skipInvalid` false, where nothing
         *      can go missing, and is why every route that existed before this field keeps
         *      working by setting it.
         *
         *      **Or the index with `WHEN_ABSENT` to invert it**: run this call precisely when
         *      that leg did NOT settle. That is what buys the token a missing maker was going to
         *      supply, and it is what lets a ring tolerate a lost leg instead of reverting.
         *
         *      The index must name a leg the batch actually carried, and a route that points
         *      outside its own batch is refused. Both lists read the field the same way:
         *      `route.swaps` and `route.disposal` alike.
         *
         *      An `ANY_LEG` call in a batch that DID skip something is safe rather than clever:
         *      `amountIn` is fixed, so if the missing leg was the one that funded it the
         *      transfer to the sink finds the balance short and the whole batch reverts. It
         *      fails closed, which is the only acceptable way for a plan to be wrong about the
         *      shape of its own bag.
         */
        uint256 leg;
        /**
         * @dev Where the input amount sits in `data`, so this contract can write the measured
         *      one there — or `NO_PATCH` to send the calldata exactly as the caller built it.
         *
         *      A venue's calldata is opaque: this contract cannot read a price out of it or
         *      rebuild it. What it CAN do is overwrite one word at an offset the caller names,
         *      and the caller always knows where its own amount is. For the
         *      `swapExactTokensForTokens` the SDK builds it is byte 4, straight after the
         *      selector.
         *
         *      That is the difference between asking for a definite number and asking for
         *      "whatever I turn out to have". A disposal could only ever name a guess before
         *      this: the surplus is not known until it exists, because the Dutch curve moves
         *      with the block and a leg may be stepped over. Guess low and the remainder sweeps
         *      home unsold; guess high and the whole call fails.
         *
         *      **Only a disposal may set this.** `proveBatchCallback` refuses a buy-side swap
         *      that does, because that phase runs before the settlement pulls its payments and
         *      the tokens it holds are owed to makers. A disposal runs after, on nothing but the
         *      caller's own take.
         */
        uint256 amountOffset;
        /**
         * @dev Where the minimum-output bound sits in `data`, patched alongside the amount.
         *
         *      Not optional when `amountOffset` is set, and the reason is the whole hazard here.
         *      The bound is a fixed number in the calldata; the amount is about to change. Patch
         *      the amount up and leave the bound alone and the caller has just agreed to sell
         *      more for the same floor — a worse price, quietly, in exactly the case the feature
         *      exists to handle. So the bound travels as a RATE and is recomputed from whatever
         *      amount is written.
         */
        uint256 minOutOffset;
        /// @dev The bound as output per input, scaled by 1e18. `amount * minOutPerIn / 1e18` is
        ///      written at `minOutOffset`.
        uint256 minOutPerIn;
    }

    /// @notice `Swap.amountOffset` for calldata to send exactly as the caller built it.
    uint256 public constant NO_PATCH = type(uint256).max;

    /// @dev One, in the unit `minOutPerIn` is counted in.
    uint256 private constant WAD = 1e18;

    /**
     * @notice `Swap.leg` for a call that is not tied to any one leg, and runs whenever the batch
     *         reaches the callback at all.
     *
     * `type(uint256).max` rather than a sentinel like zero, because zero is a real leg index and
     * a route that forgot to set this field would otherwise silently become "leg 0 only".
     */
    uint256 public constant ANY_LEG = type(uint256).max;

    /**
     * @notice Set on `Swap.leg` to invert it: run this call precisely WHEN that leg is absent.
     *
     * A ring short one leg is short the token that leg was going to supply. Without this, the
     * only swap that could have raised it is the one keyed to the missing leg — and that one is
     * skipped along with it, so the callback ends holding too little and the settlement's own
     * pull reverts. That is why a ring passed `skipInvalid` false: not because this contract
     * insists on atomicity, but because true failed obscurely.
     *
     * With it, a caller carries a fallback beside each leg and the cycle closes with a market leg
     * where the intent leg was — which is not a broken ring but an ordinary one, since a market
     * leg is a leg this system already has (`sdk/src/solver/rings.ts`, `MarketLeg`). Measured
     * reason (`contracts/test/Gas.t.sol`): losing a leg of a three-leg ring costs 222,044 gas and
     * returns nothing, against 283,087 to settle one.
     *
     * **The caller decides, and this contract decides nothing.** A ring IS unbroken — that is
     * what makes it a ring — and a solver that requires an unbroken one passes `skipInvalid`
     * false and gets exactly that, byte for byte as before. `skipInvalid` was always the caller's
     * flag. All this adds is that `true` now does something useful instead of failing obscurely,
     * so a solver has two things it can ask for rather than one.
     *
     * A bit rather than a struct field, and deliberately. Every route encoded before this constant
     * existed keeps working byte for byte, and a fallback costs no calldata over a normal call.
     * `ANY_LEG` is checked first, so its own top bit means nothing.
     *
     * The top bit is free because `leg` indexes `reqs`, and a calldata array cannot reach
     * `1 << 255` elements — each one costs calldata and gas, so an index that large is
     * unreachable at any price. A real index therefore never sets bit 255, and the mask separates
     * a fallback from an ordinary leg-keyed swap without ambiguity.
     *
     * This comment used to credit `MAX_BATCH_LEGS` for that, and it was wrong in a way worth
     * recording: `MAX_BATCH_LEGS` is `sdk/src/solver/plan.ts`, a policy in OUR solver, and nothing
     * on chain bounds `reqs.length` at all. A safety argument that rests on our own client is no
     * argument, because the caller who matters is the one who does not use it. The bound above
     * holds against anybody.
     */
    uint256 public constant WHEN_ABSENT = 1 << 255;

    /**
     * @notice The most disposals one route may carry.
     *
     * A disposal carries `Swap.leg` like any other call, and only the callback can answer "did
     * leg k settle" — it holds `owed`, and the disposal loop does not. So the answer crosses back
     * into `settleRing` as one bit per disposal in a single storage word, and the list has to fit
     * that word. A longer one is refused rather than filtered on a bit that wrapped.
     *
     * 256 venue calls in one transaction is far past what a block can hold, so a real route never
     * meets this.
     */
    uint256 public constant MAX_DISPOSALS = 256;

    /// @notice How the caller intends to close the ring, carried through the settlement as
    ///         `data` and handed back to `proveBatchCallback` untouched.
    struct Route {
        /**
         * @dev How many lines the caller built this route for.
         *
         * More lines than this cannot happen for a route that describes this batch, so it is
         * refused. FEWER is ordinary: it is what `skipInvalid` looks like from inside the
         * callback, and `Swap.leg` is how each call says whether it still has a reason to run.
         */
        uint256 legs;
        Swap[] swaps;
        /**
         * @dev Where to take the surplus, once every maker has been paid.
         *
         * `swaps` runs BEFORE the settlement pulls its payments, because its whole job is to
         * raise the tokens those payments are made in. It is spending money that is owed.
         *
         * This runs after. By then `_collect` has taken every line, so whatever this contract
         * still holds above its marks is nobody's but the caller's, and a call here cannot spend
         * a maker's payment however wrong it is. That is what makes it safe to offer at all.
         *
         * The caller gets flashloan-shaped access to a bag of tokens for the length of one
         * transaction, and until now it could only say how to BUY the far side of each trade.
         * The surplus fell out in whatever token it happened to land in — a dozen legs, a dozen
         * dusts, each one its own transaction to clear later. Naming a disposal turns that into
         * one token the caller actually wants, inside the transaction that earned it.
         *
         * **Best effort, and that is deliberate.** Each call runs in its own frame and a failure
         * is swallowed: the token then sweeps home unsold, exactly as it would have with no
         * disposal named. A batch that has already paid every maker must not be undone because a
         * pool moved under the caller's own tidying up, and the caller is the only one who loses
         * either way.
         *
         * Sizing is the caller's problem and it has no on-chain answer. `amountIn` is fixed in
         * the venue's own calldata, which this contract cannot read or rewrite, so a disposal
         * asks for a definite amount. Ask for less than the surplus and the remainder sweeps
         * home; ask for more and `sellSurplus` refuses it before the venue is called, the frame
         * catches that, and everything sweeps home. This used to rest on the transfer to the sink
         * finding the balance short, which held only while this address held nothing but what the
         * ring earned — read the argument at that check.
         *
         * **A disposal reads `Swap.leg` on the same terms as a buy-side swap.** It is skipped
         * when the leg it exists for did not settle, and a fallback disposal runs precisely when
         * that leg did not. `ANY_LEG` is what a disposal for the whole batch carries, and it is
         * what every route the SDK builds sets.
         */
        Swap[] disposal;
        /**
         * @dev Every token to hand back to the caller. Measured before the ring and swept above
         *      that mark after it, so a balance this ring did not earn cannot leave.
         *
         * It has to name every token the ring pays out in — the callback refuses the route
         * otherwise — because an unmarked output token is one the settlement could pull a
         * maker's payment out of a donation for.
         *
         * Beyond those it is a convenience and not the only way home. Every token the route
         * mentions anywhere is marked and swept, so a token named as a swap's `tokenOut`, or in
         * its `extra`, arrives without appearing here as well. This list used to be the only way
         * home, and this comment said a forgotten token "rests here until somebody names it".
         * Both halves were wrong. It rested here for ever, because a later ring marks the strand
         * before it runs and then sweeps only the increase.
         */
        address[] sweep;
    }

    IProveSettlementBatch public immutable settlement;
    address public immutable relayer;
    /**
     * @notice The call sink TEMPLATE. It is never called, it never holds anything, and a payout
     *         aimed at it is lost.
     *
     * @dev Every venue call runs from an EIP-1167 clone of this, one per caller, minted by that
     *      caller's first ring that needs it. One sink shared by every solver was a standing
     *      claim on whatever the next solver stranded in it; a per-caller clone is an address no
     *      other solver ever drives, so the claim reaches only the writer's own money.
     *      `ProveCallSink` states the argument in full.
     *
     *      It was called `sink` until the 369 fork rehearsal aimed a router payout at the plain
     *      executor's template and lost a run to `ERC20: transfer amount exceeds balance`.
     *      Nothing sweeps this address, so the name says what it is. `sinkFor` answers the
     *      address that does sweep, and a venue may pay this executor directly instead.
     *
     *      Published as an address because that is what a deploy script, a verification note and
     *      a fork test can check. Nothing else reads it.
     */
    ProveCallSink public immutable sinkTemplate;

    /// @notice A disposal that could not be made. The token sweeps home unsold.
    event SurplusUnsold(address indexed tokenIn, address indexed tokenOut);

    error NotSettlement();
    error ForbiddenTarget();
    error Reentered();
    error BalanceWentDown();
    error ProceedsNotHere(address token, uint256 held, uint256 owed);
    error BadSettlement();
    error LegCountMismatch(uint256 planned, uint256 owed);
    error LegsExceedBatch(uint256 planned, uint256 sent);
    error LegOutOfRange(uint256 leg, uint256 legs);
    error OwedTokenNotSwept(address token);
    error PatchOnTheBuySide();
    error PatchWithoutBound();
    error PatchOutOfRange(uint256 offset, uint256 length);
    error NothingToSell();
    error OversizedDisposal(uint256 want, uint256 have);
    error TooManyDisposals(uint256 count);

    uint256 private _entered = 1;

    /**
     * @dev Which disposals this batch does not want, one bit per index into `Route.disposal`.
     *
     * `Swap.leg` filters a disposal on the same terms as a buy-side swap, and only the callback
     * can decide it: `owed` names the legs that settled, and the disposal loop never sees it. The
     * two run in different frames, so the answer travels through storage. The callback writes it
     * and the `settleRing` that started the callback reads it and clears it, inside the one
     * transaction.
     *
     * Zero means every disposal runs, which is what a route of unconditional disposals asks for.
     * So the word is written only when the batch actually skips one, and a route that names no
     * leg on any disposal never touches the slot. `paris` has no transient storage, and charging
     * every ring 20,000 gas for a feature most routes do not use is not a trade worth making.
     */
    uint256 private _skipDisposal;

    constructor(address _settlement) {
        if (_settlement.code.length == 0) revert BadSettlement();
        settlement = IProveSettlementBatch(_settlement);
        relayer = IProveSettlementBatch(_settlement).relayer();
        if (relayer == address(0)) revert BadSettlement();
        // Its own template, deployed here, so `msg.sender` in its constructor is this contract
        // and every clone of it answers to this contract alone.
        sinkTemplate = new ProveCallSink();
    }

    modifier nonReentrant() {
        if (_entered == 2) revert Reentered();
        _entered = 2;
        _;
        _entered = 1;
    }

    /**
     * @notice Settle a ring on credit, closing it through `route`, and keep the spread.
     *
     * The caller needs no inventory in any of the ring's tokens. They pay gas, and they keep
     * whatever the ring and the venues returned above what the makers and the fee destinations were
     * owed. A ring that does not cover itself reverts whole rather than settling in part.
     *
     * @param skipInvalid passed to the settlement untouched, and TRUE is not usable yet — but
     *        not for the reason this comment used to give. It said `Route.legs` refuses the
     *        callback the moment a leg drops out. It does not: `proveBatchCallback` accepts fewer
     *        lines than the route planned for, on purpose, and `Swap.leg` skips the calls whose
     *        leg went missing. That was the whole point of adding `Payment.leg`.
     *
     *        What actually happens is worse than a refusal. A cycle short one leg is short the
     *        token that leg was going to supply, so every swap that could have raised it is
     *        skipped, the callback ends holding too little, and the settlement's own pull reverts
     *        — late, and with an error that names a token rather than a missing leg. So a ring
     *        passes false today because true fails obscurely, not because the contract insists on
     *        atomicity.
     *
     *        That gap is closed. `WHEN_ABSENT`, declared above, is the inverse `_wanted` used to
     *        lack: or it into `Swap.leg` and the call runs precisely when that leg did NOT settle,
     *        so a solver can carry a swap that buys what the missing maker would have supplied.
     *        A ring then degrades into a ring with a market leg in the hole, and still earns.
     *
     *        It is not free and it is not a default. One fallback costs 19,402 gas carried on
     *        every ring whether or not it fires, and each one after it costs 17,491. A solver's
     *        VERY FIRST ring that names a venue pays 52,116 instead, because it mints their sink
     *        — once in their life, not once per ring. Against 222,044 saved on a 3-leg ring that
     *        loses a leg and returns nothing, three fallbacks pay only above about a 22% loss
     *        rate, on gas alone (`test/Gas.t.sol`, `test/BatchExecutor.t.sol`). Measure the rate
     *        before arming it. True is still the caller's flag, and false is still what a solver
     *        that needs an unbroken ring should pass.
     * @param maxFeeRate the highest protocol fee this caller will pay. The settlement reads its
     *        fee at execution time, so an unbounded ring can be repriced under a pending
     *        transaction. Pass the fee the ring was priced with.
     */
    function settleRing(
        IProveSettlementBatch.FillRequest[] calldata reqs,
        bool skipInvalid,
        uint256 maxFeeRate,
        Route calldata route
    ) external nonReentrant returns (uint256 count) {
        /*
         * A leg index names a request, so the route's own count of them cannot outrun the batch.
         *
         * `_wanted` bounds every leg index against `route.legs`, and `route.legs` is the caller's
         * own number. On its own it bounds nothing: a route that claims eight legs and sends two
         * fires a fallback for six legs no request ever carried. This is the line that ties the
         * caller's number to the batch in front of it, and it is the only place both are in
         * scope. FEWER stays ordinary — that is what `skipInvalid` looks like, and the callback
         * refuses a batch that settles more lines than the route planned for.
         */
        if (route.legs > reqs.length) revert LegsExceedBatch(route.legs, reqs.length);

        /*
         * Mark first, and sweep only the increase.
         *
         * Sweeping whole balances would hand a stranger anything already sitting here, and
         * worse: the settlement pulls its payments out of this contract, so a balance that was
         * donated rather than earned can discharge a maker's debt. `ProveSettlement` is careful
         * to pull rather than measure, exactly so a donation cannot pay for a fill. Measuring
         * here would spend that guarantee on its behalf.
         */
        // Every token the route names, in one list.
        //
        // `route.sweep` used to be the only way home, and a token named anywhere else stopped
        // here. That is a trap, because the mark makes it permanent: a later ring naming the
        // token reads the balance BEFORE it runs, finds the strand already sitting there, and
        // sweeps only the increase. A strand is indistinguishable from a donation, which the
        // contract protects on purpose, so there is no rescue path and one forgotten entry costs
        // the tokens for good.
        //
        // A caller who writes a token into `tokenOut` has already said they want it. Making them
        // say it twice buys nothing and loses money when they do not, so the route's own names
        // are the list now.
        address[] memory named = _tokensNamedBy(route);
        uint256 t = named.length;
        uint256[] memory marks = new uint256[](t);
        // Marked BEFORE the ring, so a balance that was donated rather than earned stays put.
        // The settlement pulls its payments out of this contract, and `ProveSettlement` is
        // careful to pull rather than measure precisely so a donation cannot discharge a maker's
        // debt. Measuring after would spend that guarantee on its behalf.
        for (uint256 k = 0; k < t; k++) {
            marks[k] = IERC20(named[k]).balanceOf(address(this));
        }

        /*
         * One sink for this caller, and never another caller's.
         *
         * Every venue call this transaction makes runs from that clone — the buy side inside the
         * callback, and the disposals after it. The address only has to be private to the CALLER,
         * because that is the boundary an attacker's standing approval has to cross.
         *
         * It rides down inside the callback payload rather than a storage slot. `paris` has no
         * transient storage, so a slot would be written and cleared on every ring for a value
         * that lives for one frame. The settlement calls back the address that called it, so
         * this payload can only have been written here.
         */
        address callSink = _sinkFor(route);

        count = settlement.fillBatchWithCallback(
            reqs, skipInvalid, abi.encode(route, callSink), maxFeeRate
        );

        /*
         * The surplus, into a token the caller wants.
         *
         * Every payment has been pulled by now — `_collect` runs at the end of the callback the
         * line above waits on — so the only tokens still here above their marks are the caller's
         * own take. A disposal cannot reach a maker's payment because there is no longer one to
         * reach, and that ordering is the whole safety argument rather than a convenience.
         *
         * Each in its own frame, and a failure is swallowed. The batch has already settled: if a
         * pool moved under the caller's tidying up, the right answer is to hand them their tokens
         * unsold, not to undo eight fills that were fine.
         */
        // Which of them the batch did not want, decided in the callback because that is the only
        // frame that knows which legs settled. Every bit is zero for a route whose disposals all
        // carry `ANY_LEG`, and that route reads no storage at all.
        uint256 skip = _disposalSkips(route.disposal);
        for (uint256 k = 0; k < route.disposal.length; k++) {
            // A disposal keyed to a leg is skipped when that leg is, exactly as a buy-side swap
            // is. The shift is inside the word because `proveBatchCallback` has already refused a
            // list longer than `MAX_DISPOSALS`, and it runs before this loop.
            if (skip & (1 << k) != 0) continue;

            // The increase above the mark, and never the balance.
            //
            // A donation that was sitting here before the batch is protected on purpose —
            // `_sweepAbove` refuses to hand it out, precisely so a stranger's gift cannot
            // discharge a maker's debt or leave in somebody's sweep. Sizing a disposal to the
            // whole balance would sell it, which is the same leak through a different door.
            uint256 have = _increaseAbove(route.disposal[k].tokenIn, named, marks);
            try this.sellSurplus(route.disposal[k], have, callSink) {}
            catch {
                emit SurplusUnsold(route.disposal[k].tokenIn, route.disposal[k].tokenOut);
            }
        }

        // A token named twice is harmless: the first pass takes the increase to the mark, and the
        // second finds the balance already there and moves nothing.
        for (uint256 k = 0; k < t; k++) {
            _sweepAbove(named[k], marks[k], msg.sender);
        }
    }

    /**
     * @dev The callback's answer about which disposals to skip, read once and cleared.
     *
     * Storage is touched only when a disposal actually names a leg. Every route the SDK builds
     * today carries `ANY_LEG` on its disposals, so it reads nothing and pays nothing, and the
     * cost of the feature falls on the routes that ask for it.
     *
     * The condition carries the exit rather than a `break`, as `_requireSwept` does and for the
     * same reason.
     */
    function _disposalSkips(Swap[] calldata disposal) private returns (uint256 skip) {
        bool conditioned;
        for (uint256 k = 0; k < disposal.length && !conditioned; k++) {
            conditioned = disposal[k].leg != ANY_LEG;
        }
        if (conditioned) {
            skip = _skipDisposal;
            // Cleared inside the transaction that wrote it, so no ring can read another ring's
            // answer. A batch that skipped nothing wrote nothing, and has nothing to clear.
            if (skip != 0) _skipDisposal = 0;
        }
    }

    /**
     * @dev The one sink this caller drives, or nothing when the route calls no venue at all.
     *
     * A ring that closes on its own makes no venue call, and a sink it never uses is waste. Both
     * loops that could reach a sink read the same two arrays, so `address(0)` is returned only
     * when neither loop runs and it is never dereferenced.
     *
     * The salt is the caller's own address, so every caller gets a different sink and every ring
     * by one caller finds the same one. That is what lets a solver recover a token their route
     * forgot to name: it waits on their sink, and their next ring can sweep it. Predicting
     * another solver's address is easy and worthless, because only their own ring makes their
     * sink execute anything.
     *
     * `Clones.cloneDeterministic` reverts on an address that already holds code, so the check is
     * required rather than an optimisation. `predictDeterministicAddress` reads `address(this)`
     * as the deployer, and each executor deploys its own template, so no salt can collide with
     * another executor's. Only the first ring pays the clone.
     */
    function _sinkFor(Route calldata route) private returns (address predicted) {
        if (route.swaps.length == 0 && route.disposal.length == 0) return address(0);
        predicted = sinkFor(msg.sender);
        if (predicted.code.length == 0) {
            bytes32 salt = bytes32(uint256(uint160(msg.sender)));
            Clones.cloneDeterministic(address(sinkTemplate), salt);
        }
    }

    /**
     * @notice Where a venue should pay when it does not pay this executor: `caller`'s own sink
     *         clone, which sweeps everything it holds back here.
     *
     * A solver reads the address here rather than deriving it. `sinkTemplate` is NOT this
     * address and receives nothing; a payout aimed at the template strands there and the ring
     * reverts with `ProceedsNotHere`.
     *
     * @dev The answer holds before the clone exists, and it holds for a route that mints no
     *      clone at all. `_sinkFor` is the one that returns the zero address for a pure credit
     *      ring, because a ring naming no venue has nothing to pay and nothing to predict for.
     */
    function sinkFor(address caller) public view returns (address) {
        bytes32 salt = bytes32(uint256(uint160(caller)));
        return Clones.predictDeterministicAddress(address(sinkTemplate), salt);
    }

    /**
     * @dev Every token the route mentions, in any field.
     *
     * The sweep list, and then each swap's input, output and `extra`. The input matters even when
     * the caller does not ask for it back: a venue takes its payment out of this contract, so
     * without a mark a stranger could name a donation as a swap's `tokenIn`, sell it, and sweep
     * the proceeds under a mark of zero.
     *
     * Duplicates are left in. Removing them costs a nested scan over the same small array that
     * the sweep loop already tolerates, and a repeated token sweeps to zero on the first pass
     * and moves nothing on the second.
     */
    function _tokensNamedBy(Route memory route) private pure returns (address[] memory named) {
        uint256 inSwaps = _tokensIn(route.swaps);
        uint256 count = route.sweep.length + inSwaps;
        // The disposal's tokens are named on the same terms as any other swap's, and for a
        // sharper reason: what a disposal buys is the token the caller wants, and a token with
        // no mark never leaves. Selling the surplus into an unmarked token would strand exactly
        // the thing the caller asked for.
        count += _tokensIn(route.disposal);

        named = new address[](count);
        uint256 at;
        for (uint256 k = 0; k < route.sweep.length; k++) {
            named[at++] = route.sweep[k];
        }
        _nameAll(route.swaps, named, at);
        // The disposal's names start where the swaps' left off. Passing the offset rather than
        // taking one back means `_nameAll` returns nothing, and a `return` whose value one of two
        // call sites throws away is a line no test can be written to reach.
        _nameAll(route.disposal, named, at + inSwaps);
    }

    /// @dev How many addresses a swap list contributes: its two tokens each, plus every `extra`.
    function _tokensIn(Swap[] memory swaps) private pure returns (uint256 count) {
        count = 2 * swaps.length;
        for (uint256 k = 0; k < swaps.length; k++) {
            count += swaps[k].extra.length;
        }
    }

    /// @dev Write every swap's addresses into `named`, starting at `at`.
    function _nameAll(Swap[] memory swaps, address[] memory named, uint256 at) private pure {
        for (uint256 k = 0; k < swaps.length; k++) {
            Swap memory s = swaps[k];
            named[at++] = s.tokenIn;
            named[at++] = s.tokenOut;
            for (uint256 j = 0; j < s.extra.length; j++) {
                named[at++] = s.extra[j];
            }
        }
    }

    /**
     * @inheritdoc IProveBatchCallback
     *
     * @dev Every release has landed and no payment is due yet. Sell what the route says, then
     *      owe every line by the time this returns.
     *
     *      The caller check is not decoration. This contract holds nothing between transactions,
     *      so a stranger who reached here today would drive a sink of their own naming with an
     *      empty bag and approve the relayer for tokens nobody has. The relayer moves nothing
     *      unless the settlement tells it to, and the settlement only tells it to for a ring this
     *      contract itself started. The check is what keeps all of that true of a version that
     *      one day holds inventory.
     */
    function proveBatchCallback(Payment[] calldata owed, bytes calldata data) external {
        if (msg.sender != address(settlement)) revert NotSettlement();

        // The clone `settleRing` minted for this transaction, carried through the settlement
        // untouched. Every venue call below runs from it.
        (Route memory route, address callSink) = abi.decode(data, (Route, address));
        /*
         * Fewer lines than the route planned for is the ordinary outcome of `skipInvalid`, not a
         * fault. More is impossible and means the route describes a different batch.
         *
         * This was an equality, and the equality is what made a credit batch all or nothing. It
         * had to be: `owed` carried no leg index, so a callback holding eight planned actions and
         * six settled lines could not tell WHICH two to drop, and acting on the wrong pairing is
         * worse than refusing. `Payment.leg` is what makes the weaker check safe.
         */
        if (owed.length > route.legs) revert LegCountMismatch(route.legs, owed.length);

        // The settlement pulls each line out of this contract, so an output token the route did
        // not name is one that could be paid out of a donation. `settleRing` marks the sweep
        // list before the ring, and refusing here is what makes that mark cover every payment.
        _requireSwept(owed, route.sweep);

        /*
         * Which disposals this batch does not want, worked out here and carried back through
         * `_skipDisposal`.
         *
         * The disposal loop runs in `settleRing`, after every payment has been pulled, and that
         * frame cannot see which legs settled. This one can. A disposal was filtered by nothing
         * at all before this, so `Swap.leg` meant one thing in `route.swaps` and nothing in
         * `route.disposal` — a solver carrying a per-leg disposal beside a per-leg buy got one of
         * the two honoured, and the documentation for the field promised both.
         *
         * Decided before the first venue call, so a route that names a leg the batch never
         * carried is refused before it spends anything.
         */
        uint256 d = route.disposal.length;
        if (d > MAX_DISPOSALS) revert TooManyDisposals(d);
        uint256 skip;
        for (uint256 k = 0; k < d; k++) {
            if (!_wanted(owed, route.disposal[k].leg, route.legs)) skip |= 1 << k;
        }
        if (skip != 0) _skipDisposal = skip;

        uint256 n = route.swaps.length;
        for (uint256 k = 0; k < n; k++) {
            // This phase spends tokens that are owed. Sizing a call to "everything I hold" here
            // would reach a maker's payment, so the offsets are a disposal's to use and this
            // says so rather than ignoring them.
            if (route.swaps[k].amountOffset != NO_PATCH) revert PatchOnTheBuySide();
            // A call for a leg that did not settle is a call for tokens this contract was never
            // handed. Skipping it is the whole point of carrying the index.
            if (_wanted(owed, route.swaps[k].leg, route.legs)) _sell(route.swaps[k], callSink);
        }

        _oweEveryLine(owed);
    }

    /**
     * @dev Every token the ring pays out in is named on the sweep list.
     *
     * The mark is not the reason. `settleRing` marks every token the route names anywhere, a
     * swap's `tokenOut` included. So a token owed only through a swap already carries a mark,
     * and this rule is stricter than the marks need.
     *
     * It is stricter on purpose. The sweep list is where the route states what it expects to
     * pay in. A ring that owes a token it never listed is running a plan that no longer matches
     * the batch. It fails here rather than settling on a coincidence.
     */
    function _requireSwept(Payment[] calldata owed, address[] memory sweep) private pure {
        for (uint256 k = 0; k < owed.length; k++) {
            address token = owed[k].token;
            bool found;
            // The condition carries the exit. A `break` here reads the same and costs the same,
            // and `forge coverage --ir-minimum` cannot count one.
            for (uint256 j = 0; j < sweep.length && !found; j++) {
                found = sweep[j] == token;
            }
            if (!found) revert OwedTokenNotSwept(token);
        }
    }

    /**
     * @dev Does this call still have a reason to run: is it unconditional, or did its leg settle.
     *
     * Linear over `owed`, which is at most the batch size and is calldata, so the scan costs less
     * than the memory a mapping would need. The condition carries the exit rather than a `break`
     * for the reason `_requireSwept` gives.
     *
     * **The index has to name a leg the batch could have had, and that is checked.** `owed`
     * carries only the legs that SETTLED, so asking it "did leg 7 settle" and reading the answer
     * backwards cannot tell a leg that went missing from a leg that never existed. Both come back
     * absent, and a fallback keyed past the end of the batch fired on every ring — spending
     * tokens the settlement was about to pull, on a ring where nothing at all had gone missing.
     * `legs` is the bound that separates the two, and `settleRing` ties it to `reqs.length` so it
     * is the batch's own size and not a number the caller picked.
     *
     * A route that points outside its own batch is refused rather than quietly dropped, for the
     * reason `_requireSwept` gives: it is a plan that no longer matches the batch, and it fails
     * here rather than settling on a coincidence. `ANY_LEG` is answered first, so it never meets
     * the bound.
     */
    function _wanted(Payment[] calldata owed, uint256 leg, uint256 legs)
        private
        pure
        returns (bool)
    {
        if (leg == ANY_LEG) return true;
        uint256 want = leg & ~WHEN_ABSENT;
        if (want >= legs) revert LegOutOfRange(leg, legs);
        bool settled;
        for (uint256 k = 0; k < owed.length && !settled; k++) {
            settled = owed[k].leg == want;
        }
        // A fallback wants the opposite answer to the call it stands in for, so the two are
        // mutually exclusive by construction: exactly one of a pair runs, whatever the batch did.
        return leg & WHEN_ABSENT == 0 ? settled : !settled;
    }

    /**
     * @notice `_sell` in a frame of its own, so a disposal that fails cannot undo a settled batch.
     *
     * External only for the `try`, exactly as `ProveSettlement.armLeg` is. Nothing but this
     * contract may call it, and it is reachable only from `settleRing` after every maker has
     * been paid — so the worst a bad disposal does is spend the caller's own surplus badly.
     *
     * `nonReentrant` is held by the `settleRing` that called us, so a venue that calls back in
     * finds the guard shut.
     */
    function sellSurplus(Swap calldata s, uint256 have, address callSink) external {
        if (msg.sender != address(this)) revert ForbiddenTarget();

        Swap memory sized = s;
        if (s.amountOffset != NO_PATCH) {
            // Both or neither. See `minOutOffset`: writing the amount and leaving the bound is
            // how a caller sells more for the same floor without ever asking to.
            if (s.minOutOffset == NO_PATCH) revert PatchWithoutBound();
            if (have == 0) revert NothingToSell();
            sized.amountIn = have;
            _write(sized.data, s.amountOffset, have);
            _write(sized.data, s.minOutOffset, (have * s.minOutPerIn) / WAD);
        }

        /*
         * Never into the mark, whatever the caller asked for.
         *
         * `have` is what this batch earned in the token. Everything below it was here before the
         * batch, and `_sweepAbove` refuses to end below it — after this loop, and outside the
         * frame that swallows a failed disposal. So an oversized disposal that reached the venue
         * did not fail best-effort at all: it undid a batch that had already paid every maker,
         * and one donation to this address armed that against every solver afterwards.
         *
         * The sizing note says an oversized disposal is safe because "the transfer to the sink
         * finds the balance short". That is only true while this address holds nothing but what
         * the ring earned. This is the line that makes it true whatever else is here.
         *
         * A patched disposal sets `amountIn` to `have` above, so it can never meet this.
         */
        if (sized.amountIn > have) revert OversizedDisposal(sized.amountIn, have);
        _sell(sized, callSink);
    }

    /**
     * @dev Overwrite one 32-byte word of a venue's calldata, at an offset the caller named.
     *
     * Bounds-checked against the blob's own length, which is the only check available: this
     * contract cannot know what the word it is writing over means, only that it is inside the
     * caller's own calldata and about to be sent with the caller's own money.
     */
    function _write(bytes memory data, uint256 offset, uint256 value) private pure {
        if (offset + 32 > data.length) revert PatchOutOfRange(offset, data.length);
        assembly {
            mstore(add(add(data, 0x20), offset), value)
        }
    }

    /// @dev What this batch earned in `token`: its balance now, less the mark taken before.
    function _increaseAbove(address token, address[] memory named, uint256[] memory marks)
        private
        view
        returns (uint256 gained)
    {
        uint256 held = IERC20(token).balanceOf(address(this));
        // The condition carries the exit, as `_requireSwept` does and for the same reason: a
        // `break` reads the same, costs the same, and `forge coverage --ir-minimum` cannot count
        // one. The named return is zero until a mark is found and the balance is above it, which
        // covers the two ways there is nothing to sell — a token the batch did not earn, and one
        // the route never named — without a `return` no test could reach.
        bool found;
        for (uint256 k = 0; k < named.length && !found; k++) {
            found = named[k] == token;
            if (found && held > marks[k]) gained = held - marks[k];
        }
    }

    /// @dev Sell one bag at one venue, through this caller's sink clone, and take back what it
    ///      paid. `callSink` comes from `_sinkFor` and is never zero on a route that reaches here.
    function _sell(Swap memory s, address callSink) private {
        // The sink refuses this contract and itself; these two are the settlement's own rule 2,
        // and they belong wherever a caller picks an address.
        if (s.target == relayer || s.target == address(settlement)) revert ForbiddenTarget();
        if (s.spender == relayer || s.spender == address(settlement)) revert ForbiddenTarget();

        // Measured as a difference, not as the sink's balance. The clone sweeps itself empty at
        // the end of every `run`, so the two agree — until a token reaches it another way, and
        // then the balance would approve the venue for more than this swap meant to sell. An
        // earlier call in the same ring can leave one behind, an earlier RING of this caller's
        // can strand one, and anybody can send one to an address they predict. A token that taxes
        // its own transfers moves less than `amountIn`, and the venue is approved for only what
        // actually arrives.
        uint256 sinkBefore = IERC20(s.tokenIn).balanceOf(callSink);
        IERC20(s.tokenIn).safeTransfer(callSink, s.amountIn);
        uint256 sent = IERC20(s.tokenIn).balanceOf(callSink) - sinkBefore;

        ProveCallSink(callSink)
            .run(s.tokenIn, sent, s.tokenOut, s.spender, s.target, s.data, s.extra);
    }

    /**
     * @dev Grant the relayer what every line adds up to, one allowance per token.
     *
     * The settlement delivers each line with its own directed `transferFrom`, and pulls every
     * reserved fee once per token at the end of the call (`_settleLedger`), so a token carrying
     * two lines is pulled at least twice. An allowance per line would not survive that:
     * `forceApprove` writes an exact value, so the second line would replace the first line's
     * allowance instead of adding to it, and the ring would revert on the pull the first line
     * already spent.
     *
     * Per token the total is `sum(amount + fee)` over the lines that pay it out (`amount` is the
     * maker's required out and `fee` is P2 on top; P3 only splits `amount`) plus `sum(feeInDue)`
     * over the lines whose `tokenIn` it is: P1 on the approval rung is a loan of `tokenIn` that
     * the settlement pulls back. A token that is `tokenOut` of one leg and `tokenIn` of another
     * (a ring) adds both, so this visits `tokenIn` tokens as well as `token`s.
     *
     * Approved to the relayer, never to the settlement. `ProveSettlement` holds no allowance
     * from anyone and calls `transferFrom` nowhere; `ProveRelayer` is the address that pulls.
     *
     * The total is exactly what the settlement takes, so no allowance survives the transaction.
     */
    function _oweEveryLine(Payment[] calldata owed) private {
        uint256 n = owed.length;
        for (uint256 s = 0; s < 2 * n; s++) {
            // Slots 0..n-1 are the `token` of each line, n..2n-1 their `tokenIn`.
            address token = s < n ? owed[s].token : owed[s - n].tokenIn;
            if (_earlierSlotIn(owed, token, s)) continue;

            uint256 total;
            for (uint256 j = 0; j < n; j++) {
                if (owed[j].token == token) total += owed[j].amount + owed[j].fee;
                if (owed[j].tokenIn == token) total += owed[j].feeInDue;
            }
            // A `tokenIn` nobody owes anything on is not touched.
            if (total == 0 && s >= n) continue;

            /*
             * The proceeds have to be HERE, and this is where a venue that paid elsewhere says
             * so.
             *
             * The settlement pulls this token out of this contract the moment the callback
             * returns, and nothing moves in between. So a ring that works already holds the total
             * at this point, and the check refuses nothing that used to settle.
             *
             * What it catches is a payout aimed at an address that never sweeps — `sinkTemplate`
             * above all, which reads like a destination and is not one. Without this the ring
             * reverts inside the token on the pull, frames below the route that named the wrong
             * address, and the message says only that a balance was short.
             */
            uint256 held = IERC20(token).balanceOf(address(this));
            if (held < total) revert ProceedsNotHere(token, held, total);

            IERC20(token).forceApprove(relayer, total);
        }
    }

    /// @dev True when `token` already had its allowance written by a slot before `s` (see
    ///      `_oweEveryLine` for the slots). A ring is two or three lines, so the pairwise scan
    ///      costs less than a mapping's cold slots.
    function _earlierSlotIn(Payment[] calldata owed, address token, uint256 s)
        private
        pure
        returns (bool seen)
    {
        uint256 n = owed.length;
        for (uint256 j = 0; j < s && !seen; j++) {
            seen = (j < n ? owed[j].token : owed[j - n].tokenIn) == token;
        }
    }

    /// @dev Hand on everything above the mark, and refuse to end below it.
    function _sweepAbove(address token, uint256 mark, address to) private {
        uint256 held = IERC20(token).balanceOf(address(this));
        if (held < mark) revert BalanceWentDown();
        if (held > mark) IERC20(token).safeTransfer(to, held - mark);
    }
}
