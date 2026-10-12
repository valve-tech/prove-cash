// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IProveBatchCallback} from "./interfaces/IProveBatchCallback.sol";
import {IProveSettlementFill} from "./ProveExecutor.sol";
import {IProveSettlementBatch} from "./ProveBatchExecutor.sol";

/**
 * @dev The one settlement call this contract needs that the batch interface does not carry.
 *
 * The binding names the quote by its intent hash, and the settlement is the authority on what
 * that hash is. Recomputing it here would put a fourth copy of the EIP-712 encoding in the
 * repository, and a copy that drifts still compiles. So ask the contract that decides.
 */
interface IProveSettlementHash {
    function hashIntent(IProveSettlementFill.Intent calldata i) external view returns (bytes32);
}

/**
 * @title RfqVenue
 * @notice A price named for one address, taken by that address alone, settled by anybody.
 *
 * A maker quotes better than they will quote in public, and reserves the price for one named
 * counterparty. The counterparty accepts by signing an ordinary intent — the mirror side of the
 * trade — and sends no transaction. Whoever submits the pair pays the gas and keeps the spread.
 *
 * **Exclusivity rides on a field the settlement already has.** `ProveSettlement._evaluate`
 * refuses a fill whose `Intent.executor` is not `msg.sender`. Name a *contract* there and only
 * that contract can fill the intent, so the policy about who may take the quote can live in
 * periphery rather than in the settlement. This contract is that policy. Nothing about `Intent`
 * or its EIP-712 struct changes, and a chain already carrying `ProveSettlement` needs no upgrade.
 *
 * **The binding is what makes it cryptographic rather than a promise.** The maker signs a second
 * message, `Exclusive`, under this contract's own domain: this intent hash, this counterparty,
 * this size, until this moment. The counterparty reads it before they sign anything and can
 * prove for themselves that the price is reserved for them and that the quote can only settle
 * here. No third party can take it, and the maker cannot quietly widen the audience later,
 * because widening it means a different signature.
 *
 * **The exclusivity fee is an ordinary `Intent.feeRate`, and this contract no longer charges
 * one.** It used to: the binding carried its own rate, this contract collected it out of the
 * spread, and a second ceiling bounded it. Then the settlement grew a signed per-intent rate,
 * and an exclusive quote became a quote that charges more — the same object, priced higher. So
 * the maker sets `feeRate` on the quote itself, the settlement reserves it with every other fee (P2,
 * on top of the maker's required out, so the venue's spread pays it), and one rule replaces two.
 * **The fee goes only where the signed `feeConfig` says.** A zero `feeConfig` with all rates zero
 * pays no fee; the default is written into the quote at signing. No exception for this venue.
 * `MAX_EXCLUSIVE_FEE_RATE` has no successor: the settlement caps no rate either, because a rate
 * nobody will pay is an offer nobody fills. The counterparty's guarantee got stronger rather than weaker anyway:
 * `ex.intentHash` commits to every term of the quote, the rate included, so a rate they did not
 * read is a binding that does not verify, and the filler still passes its own `maxFeeRate`.
 *
 * One shape is gone with it. A maker who wants to offer the *same* quote to two counterparties
 * at two different exclusivity rates must now sign two quotes, and two quotes carry two
 * `amountIn` commitments rather than sharing one. That maker's exposure is what changes, and
 * `cancel` and `endTime` are still how they close it. Two counterparties at the same rate — the
 * ordinary case — still take one quote and one binding each.
 *
 * **It settles a ring of exactly two intents and holds no inventory.**
 * `ProveSettlement.fillBatchWithCallback` releases both legs' token A before it pulls either
 * payment, so the counterparty's tokens pay the maker and the maker's tokens pay the
 * counterparty. This address needs no capital in either token. Every ring ends with it holding
 * what it held at the start, in both tokens, and with no allowance left over. A donation stays
 * where it lands, and the mark below keeps it out of every ring.
 *
 * **It makes no call a caller chose.** `ProveBatchExecutor` takes a target and a calldata blob,
 * which is why it needs `ProveCallSink` to hold that hazard at a different address. A two-leg
 * ring names no venue, so there is no blob here, no sink, and no target to forbid. That is the
 * largest security difference between the two contracts and it is worth keeping: an allowance
 * granted to this address is unreachable, because this address calls nothing but the settlement,
 * the two tokens the two intents name, and — for a contract wallet — the maker's own `isValidSignature`.
 *
 * **The donation mark is one rule and it does every job here.** Both tokens are measured before
 * the ring, and the contract refuses to end below either mark. So this address never spends a
 * balance it did not earn in the same transaction: a donation cannot be swept by a stranger, a
 * donation cannot discharge a maker's payment, and a donation cannot pay a fee. The last one
 * still holds now the settlement pulls the whole fee itself — the pull comes out of what the
 * ring released to this address, and the mark is what says so.
 *
 * **Nobody owns this contract.** There is no owner, no operator, no pause, and nothing to
 * configure. The rate a quote charges is a term of the quote, so the maker signs it and the
 * counterparty verifies it through the binding's `intentHash`. An owner-set rate would have been
 * worse in the one way that matters: the owner could move it between the moment the counterparty
 * signed and the moment the transaction landed, which is exactly the repricing the settlement's
 * own `maxFeeRate` bound exists to stop — and that bound now covers the whole rate, so a
 * submitter who passes the rate they priced with cannot be surprised by either half of it.
 *
 * **Native currency is not supported.** There is no `receive`. Wrapped tokens only.
 */
contract RfqVenue is IProveBatchCallback {
    using SafeERC20 for IERC20;

    // ── Types ────────────────────────────────────────────────────────────────

    /**
     * @notice The maker's promise that one price belongs to one address.
     *
     * Signed apart from the intent, under this contract's domain, so `ProveSettlement.Intent`
     * and its typehash are untouched. Every field is load-bearing:
     *
     *  - `intentHash` names the quote, and it commits to every one of its seventeen terms — the
     *    rate it charges included. A re-signed intent — one wei different, a later nonce, a
     *    wider window, a higher fee — is a different hash, so a binding never follows a quote
     *    the maker has changed.
     *  - `counterparty` is the only maker whose intent may take the other side.
     *  - `take` is how much of the quote this binding releases, exactly. A binding is spent once
     *    (see `spent`), so naming the size here is what stops a counterparty burning a
     *    thousand-unit quote on one wei.
     *  - `expiry` is when the quote stops being good. Nothing on chain bounds the quote's own
     *    `endTime` since `38a18ea`, so this is the only deadline a firm RFQ price can rely on.
     *  - `nonce` makes two otherwise identical bindings distinct, so a maker who means to allow
     *    two takes of the same size signs two of them and means it both times.
     *
     * The chain id and this contract's address sit in the domain separator, so a binding signed
     * for testnet, or for a second venue, verifies nowhere else.
     */
    struct Exclusive {
        bytes32 intentHash;
        address counterparty;
        uint256 take;
        uint64 expiry;
        uint256 nonce;
    }

    // ── Constants ────────────────────────────────────────────────────────────

    /// @notice One leg for the quote, one for the mirror. A ring of two, and never anything else.
    uint256 public constant LEGS = 2;

    bytes32 public constant EXCLUSIVE_TYPEHASH = keccak256(
        "Exclusive(bytes32 intentHash,address counterparty,uint256 take,uint64 expiry,uint256 nonce)"
    );

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Its own name, not the settlement's. A signature for one is meaningless to the other.
    bytes32 private constant NAME_HASH = keccak256("prove.cash rfq");
    bytes32 private constant VERSION_HASH = keccak256("1");

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    // ── State ────────────────────────────────────────────────────────────────

    IProveSettlementBatch public immutable settlement;

    /// @notice The address that pulls every payment. The callback approves this, never the
    ///         settlement — read `IProveBatchCallback`, which said the wrong one until today.
    address public immutable relayer;

    /**
     * @notice True once a binding has settled. A binding is one-shot.
     *
     * Keyed by the binding's own EIP-712 digest, so the chain id, this contract's address and
     * every field of `Exclusive` are already inside the key. There is nothing left for a replay
     * to vary: not the chain, not the venue, not the quote, not the counterparty, not the size.
     *
     * **One-shot, deliberately, even though the settlement supports partial fills.** A repeatable
     * binding would need its own ledger of how much of the quote it had consumed, running beside
     * `ProveSettlement.filled` and able to disagree with it — two books for one order, which is
     * where the money goes missing. And a repeatable binding over a Dutch quote hands the
     * counterparty a free option: take a slice now, watch the curve, take the rest at the end,
     * while the maker believes the quote is done. A maker who wants the price takeable in slices
     * signs one binding per slice. Each one then names its own size and is its own act of
     * consent, which is what an RFQ desk means by a firm quote anyway.
     *
     * A quote whose binding is spent while `amountIn` remains is simply not takeable here again
     * until the maker signs another binding. The maker's off switches are unchanged and both
     * belong to the settlement: `cancel` kills the intent, and `endTime` runs out on its own.
     */
    mapping(bytes32 => bool) public spent;

    /// @dev The domain separator only changes if the chain forks, so it is built once.
    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

    /// @dev 1 = idle, 2 = inside a settle. Never zero after construction: a slot that returns to
    ///      zero pays the 20k SSTORE again on the next call.
    uint256 private _entered = 1;

    // ── Events ───────────────────────────────────────────────────────────────

    /**
     * @notice One exclusive quote taken, by the address it was reserved for.
     *
     * No fee here. The quote's rate is a term of the quote, and the settlement's own `Filled`
     * carries what the leg actually paid.
     */
    event ExclusiveFilled(
        bytes32 indexed binding,
        bytes32 indexed intentHash,
        address indexed counterparty,
        uint256 take
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error BadSettlement();
    error NotSettlement();
    error Reentered();
    error NotTwoLegs(uint256 given);
    error LegCountMismatch(uint256 planned, uint256 owed);
    error QuoteNotExclusiveToThisVenue();
    error MirrorNotExclusiveToThisVenue();
    error MirrorOutlivesTheBinding();
    error MirrorIsNotFlat();
    error MirrorNotTakenWhole();
    error BindingIsForAnotherIntent();
    error BindingExpired();
    error BindingSpent();
    error BadBinding();
    error NotTheCounterparty();
    error NotAMirror();
    error TakeNotBound(uint256 signed, uint256 given);
    error OwedTokenNotMarked(address token);
    error BalanceWentDown();

    // ── Construction ─────────────────────────────────────────────────────────

    constructor(address _settlement) {
        if (_settlement.code.length == 0) revert BadSettlement();
        settlement = IProveSettlementBatch(_settlement);
        relayer = IProveSettlementBatch(_settlement).relayer();
        if (relayer == address(0)) revert BadSettlement();
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    modifier nonReentrant() {
        if (_entered == 2) revert Reentered();
        _entered = 2;
        _;
        _entered = 1;
    }

    // ── Hashing ──────────────────────────────────────────────────────────────

    function domainSeparator() public view returns (bytes32) {
        return
            block.chainid == _CACHED_CHAIN_ID ? _CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    /// @notice The digest the maker signs, and the key this contract spends. A client builds the
    ///         same value from the EIP-712 types; ask the chain when you want to be sure.
    function hashExclusive(Exclusive calldata ex) public view returns (bytes32) {
        // Every member of `Exclusive` is a static type, so encoding the struct lays the five
        // members down as five 32-byte words — the same bytes as naming them one at a time.
        return keccak256(
            abi.encodePacked(
                "\x19\x01", domainSeparator(), keccak256(abi.encode(EXCLUSIVE_TYPEHASH, ex))
            )
        );
    }

    // ── Settling ─────────────────────────────────────────────────────────────

    /**
     * @notice Take an exclusive quote on behalf of the counterparty it was reserved for.
     *
     * Anyone may call this. The contract does not care who pays the gas — it cares that both
     * signatures are valid, that the binding names this counterparty and this size, and that the
     * ring closes. Whatever the two legs leave over goes to `msg.sender`, and that surplus is
     * what pays for the gas: the maker's concession has to cover the protocol fee, the
     * exclusivity fee and the submitter's costs, or nobody will submit. The contract enforces the
     * first two and prices none of them.
     *
     * @param reqs exactly two legs, in this order: the quote, then the counterparty's mirror.
     *        Order is not a convenience. `owed` comes back in leg order, and the exclusivity fee
     *        is charged on the quote's delivery and paid to the quote's own fee destination.
     * @param ex the maker's binding, signed under this contract's domain.
     * @param bindingSignature the maker's signature over `ex`. ECDSA or ERC-1271.
     * @param maxFeeRate the highest rate this caller will pay on either leg, the quote's own fee
     *        included. The settlement reads its floor at execution time, so an unbounded call can
     *        be repriced under a pending transaction. Pass the rate the ring was priced with —
     *        for an exclusive quote that is the quote's `feeRate`, which the binding commits to.
     * @return binding the digest that was spent, so a caller can watch for it.
     *
     * There is no `skipInvalid` here, and its absence is the answer to it. A two-leg ring with a
     * leg stepped over is not a ring: the surviving maker's tokens are released and the payment
     * that was meant to cover them never arrives, so the fill either reverts deep inside a
     * transfer or eats the submitter's own inventory. The settlement is told `false`, and the
     * callback refuses any `owed` that is not two lines long, so a skip cannot happen and could
     * not go unnoticed if it did.
     */
    function settleExclusive(
        IProveSettlementBatch.FillRequest[] calldata reqs,
        Exclusive calldata ex,
        bytes calldata bindingSignature,
        uint256 maxFeeRate
    ) external nonReentrant returns (bytes32 binding) {
        if (reqs.length != LEGS) revert NotTwoLegs(reqs.length);

        IProveSettlementFill.Intent calldata quote = reqs[0].intent;
        IProveSettlementFill.Intent calldata mirror = reqs[1].intent;

        binding = _checkBinding(quote, mirror, reqs[0].take, reqs[1].take, ex, bindingSignature);

        // The one-shot mark, written before the settlement call rather than after it. Nothing
        // reentrant can reach here — `nonReentrant` holds and this contract calls no address a
        // caller chose — but a spend that lands before the effect it authorises is one less thing
        // for a future call site to get wrong.
        spent[binding] = true;
        emit ExclusiveFilled(binding, ex.intentHash, ex.counterparty, ex.take);

        /*
         * Mark first, and hand on only the increase.
         *
         * The two tokens are the ones the two intents name, read from the intents rather than
         * from a list the caller supplies — so there is no way to leave one out, and no way to
         * sweep a token from a mark of zero. `ProveBatchExecutor` takes that list from its caller
         * and had to grow two separate defences around it; a ring of exactly two mirrored legs
         * names its own tokens and needs neither.
         *
         * Marked BEFORE the ring, because the settlement pulls its payments out of this contract
         * and `ProveSettlement` is careful to pull rather than measure precisely so a donation
         * cannot discharge a maker's debt. Measuring afterwards would spend that guarantee on its
         * behalf. The same mark is what keeps the exclusivity fee inside the spread.
         */
        address tokenA = quote.tokenIn;
        address tokenB = quote.tokenOut;
        uint256 markA = IERC20(tokenA).balanceOf(address(this));
        uint256 markB = IERC20(tokenB).balanceOf(address(this));

        uint256 count =
            settlement.fillBatchWithCallback(reqs, false, abi.encode(tokenA, tokenB), maxFeeRate);
        if (count != LEGS) revert LegCountMismatch(LEGS, count);

        _sweepAbove(tokenA, markA, msg.sender);
        _sweepAbove(tokenB, markB, msg.sender);
    }

    /**
     * @dev Everything that has to be true before a wei moves, in one place.
     *
     * Cheapest first, and the maker's signature last: `ecrecover` costs more than every check
     * above it put together, and `ProveSettlement._evaluate` orders itself the same way.
     */
    function _checkBinding(
        IProveSettlementFill.Intent calldata quote,
        IProveSettlementFill.Intent calldata mirror,
        uint256 take,
        uint256 mirrorTake,
        Exclusive calldata ex,
        bytes calldata bindingSignature
    ) private view returns (bytes32 binding) {
        if (block.timestamp >= ex.expiry) revert BindingExpired();
        if (take != ex.take) revert TakeNotBound(ex.take, take);

        /*
         * The quote must be addressed to this contract, and this is the check the whole design
         * rests on.
         *
         * The settlement would accept `executor == address(0)` from us perfectly happily — it
         * only refuses an executor that names somebody else. But a quote with an open executor is
         * a public order that anyone can fill directly on the settlement, and then the binding
         * guards nothing at all. Exclusivity is a property of that one field, so read it here
         * rather than assume whoever built the intent set it.
         */
        if (quote.executor != address(this)) revert QuoteNotExclusiveToThisVenue();

        /*
         * And so must the mirror, for the counterparty's sake rather than the maker's.
         *
         * A counterparty signs their mirror at a rate that only makes sense against this quote.
         * Left open, that signature is an ordinary public order at that rate, and anybody may
         * fill it on the settlement without ever showing the maker's side. The acceptance would
         * leak as a standing offer. Requiring this contract as the executor means the mirror can
         * only ever settle inside a ring, against a quote, under a valid binding.
         */
        if (mirror.executor != address(this)) revert MirrorNotExclusiveToThisVenue();

        // The two legs must cross, or they cannot pay for each other and this contract would need
        // capital it does not have. `ProveSettlement._termsOk` already refuses `tokenIn ==
        // tokenOut`, so crossing legs are two distinct tokens and the callback can skip the
        // coalescing a general batch needs.
        if (mirror.tokenIn != quote.tokenOut || mirror.tokenOut != quote.tokenIn) {
            revert NotAMirror();
        }

        if (mirror.maker != ex.counterparty) revert NotTheCounterparty();

        /*
         * Three properties of the mirror that the binding cannot commit to, and must therefore be
         * enforced here.
         *
         * `Exclusive` names the quote by hash. It names nothing about the mirror, because the
         * maker signs first and cannot know a hash the counterparty has not produced yet. So
         * without these three, a counterparty's acceptance is a signature that survives the
         * binding it answered: any rogue may mint their own quote for the same pair, sign their
         * own `Exclusive` naming that counterparty, and settle the acceptance against it. The
         * counterparty never sees them, and the maker whose binding it was may be long expired.
         *
         * The exploit needs one of the three to be loose, and takes the difference:
         *
         *   endTime    an acceptance that outlives its binding is a standing order at that rate.
         *              Bounded here, the signature dies with the deal it answered.
         *   flatness   a decaying mirror pays less the later it settles, so a rogue quote filled
         *              at the bottom of the counterparty's curve keeps the whole concession. A
         *              flat mirror is paid its exact rate however it is paired, which is what
         *              makes the rest of this safe. `Intent.curve` cannot loosen it: `minOutAt`
         *              returns `minOutStart` whenever the two ends agree, before it reads a kind
         *              or a word, so a flat mirror is flat under every kind there will ever be.
         *   whole take the submitter chooses `reqs[1].take`, and `_termsOk` only forces
         *              `take == remaining` when the counterparty did NOT set `FLAG_PARTIAL`.
         *              Taking it whole removes the choice.
         *
         * `sdk/src/rfq.ts`'s `mirrorFor` already builds all three, so no client changes. That is
         * the point: the venue accepted a shape our own client never writes, and a safety
         * argument that rests on our own client is no argument -- `ProveBatchExecutor` says so in
         * its own header, about its own caller-supplied list.
         */
        if (mirror.endTime > ex.expiry) revert MirrorOutlivesTheBinding();
        if (mirror.minOutStart != mirror.minOutEnd) revert MirrorIsNotFlat();
        if (mirrorTake != mirror.amountIn) revert MirrorNotTakenWhole();

        // The settlement decides what an intent hashes to. Ask it, rather than keeping a fourth
        // copy of the EIP-712 encoding in this repository for a future contributor to drift.
        if (IProveSettlementHash(address(settlement)).hashIntent(quote) != ex.intentHash) {
            revert BindingIsForAnotherIntent();
        }

        binding = hashExclusive(ex);
        if (spent[binding]) revert BindingSpent();
        if (!_validSignature(quote.maker, binding, bindingSignature)) revert BadBinding();
    }

    /**
     * @inheritdoc IProveBatchCallback
     *
     * @dev Both releases have landed and no payment is due yet. Owe both lines by the time this
     *      returns, and nothing else — the quote's own fee is part of what the settlement pulls.
     *
     *      The caller check matters even though this contract holds nothing between transactions.
     *      The settlement calls back its own `msg.sender` and never a named address, so the only
     *      way here is through this contract's own `settleExclusive`. The check is what keeps
     *      that true of a version somebody writes later.
     */
    function proveBatchCallback(Payment[] calldata owed, bytes calldata data) external {
        if (msg.sender != address(settlement)) revert NotSettlement();
        if (owed.length != LEGS) revert LegCountMismatch(LEGS, owed.length);

        (address tokenA, address tokenB) = abi.decode(data, (address, address));

        /*
         * Every token the settlement will pull is one this call marked.
         *
         * `settleExclusive` marked exactly the two tokens the two intents name, so this cannot
         * fail today — the mirror check makes the pairing structural. It is here because
         * `ProveBatchExecutor` learned this the expensive way: an `owed` token with no mark is
         * one whose payment the settlement can pull out of a donation, which turns a stranger's
         * gift into somebody else's fill. Two comparisons keep the property written down at the
         * point where the money moves, instead of resting on a check three frames away.
         */
        if (owed[0].token != tokenB) revert OwedTokenNotMarked(owed[0].token);
        if (owed[1].token != tokenA) revert OwedTokenNotMarked(owed[1].token);

        /*
         * Grant the relayer what each line adds up to. Approved to the relayer, never to the
         * settlement: `ProveSettlement` holds no allowance from anyone and calls `transferFrom`
         * nowhere, and `ProveRelayer` is the address that pulls.
         *
         * One allowance per line, with no coalescing, because a mirrored ring cannot put two
         * lines on one token: leg one pays in the quote's `tokenOut` and leg two in its `tokenIn`,
         * and the settlement refuses an intent where those are the same address. A general batch
         * has to add the lines up before it writes `forceApprove`, which sets an exact value and
         * would otherwise replace the first line's allowance with the second's.
         *
         * `amount` and `fee` are the two halves of one gross: the settlement carves the fee out
         * of the maker's number and pulls both, so the allowance owes their sum. This contract
         * reads nothing else about either. The split is the settlement's to make, and a second
         * opinion here could only be a way to disagree with it.
         *
         * The total is exactly what the settlement takes, so no allowance survives this call.
         */
        //
        // Plus the `tokenIn` each leg lends this contract on the approval rung (P1, `feeInDue`),
        // which the settlement pulls back at the end. Leg 0 is the quote, whose `tokenIn` is the
        // mirror leg's `token` (`tokenA`), and leg 1 the mirror, whose `tokenIn` is `tokenB`.
        IERC20(owed[0].token).forceApprove(relayer, owed[0].amount + owed[0].fee + owed[1].feeInDue);
        IERC20(owed[1].token).forceApprove(relayer, owed[1].amount + owed[1].fee + owed[0].feeInDue);
    }

    /// @dev Hand on everything above the mark, and refuse to end below it. The refusal is what
    ///      protects a donation, and it is also what keeps the exclusivity fee inside the spread.
    function _sweepAbove(address token, uint256 mark, address to) private {
        uint256 held = IERC20(token).balanceOf(address(this));
        if (held < mark) revert BalanceWentDown();
        if (held > mark) IERC20(token).safeTransfer(to, held - mark);
    }

    /**
     * @dev The signature tells us how to check it, exactly as `ProveSettlement` does.
     *
     * A 65-byte blob is an ECDSA signature, so try `ecrecover` first: an ordinary wallet settles
     * without an EXTCODESIZE probe on the maker. Anything else falls through to ERC-1271, because
     * a market maker quoting from a Safe is a real shape and their intent already verifies that
     * way. The gas cap stops a hostile maker burning the submitter's budget, and the hand-decode
     * stops a maker that answers with dirty low bytes reverting the call instead of failing it.
     */
    function _validSignature(address maker, bytes32 digest, bytes calldata signature)
        private
        view
        returns (bool)
    {
        if (signature.length == 65) {
            (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
            if (err == ECDSA.RecoverError.NoError && signer == maker) return true;
        }
        if (maker.code.length == 0) return false;

        (bool ok, bytes memory ret) = maker.staticcall{gas: 60_000}(
            abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
        );
        if (!ok || ret.length < 32) return false;
        // A whole word, never a `bytes4` decode. `ProveSettlement._validSignature` says why.
        return bytes4(abi.decode(ret, (bytes32))) == ERC1271_MAGIC;
    }
}
