// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC2612} from "./interfaces/IERC2612.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {IProveCallback} from "./interfaces/IProveCallback.sol";
import {IProveBatchCallback} from "./interfaces/IProveBatchCallback.sol";
import {ISignatureTransfer} from "./interfaces/IPermit2.sol";
import {ProveRelayer} from "./ProveRelayer.sol";
import {FeeConfig} from "./FeeConfig.sol";
import {TakePoints} from "./TakePoints.sol";
import {FeeClaimLib} from "./FeeClaimLib.sol";

/**
 * @title ProveSettlement
 * @notice Executes signed swap intents. A maker signs terms off-chain — take up to `amountIn` of
 *         token A, deliver at least the signed minimum of token B — and anyone may execute them.
 *
 * Five ways to back an intent share one contract. Only the second commits anything:
 *   - approval      tokens stay in the maker's wallet under an allowance they sent
 *   - escrow        tokens sit here, against this one intent, until the maker withdraws them
 *   - authorization an EIP-3009 signature funds the escrow at fill time, no maker gas
 *   - permit        an EIP-2612 signature grants the relayer's allowance, no maker gas
 *   - permit2       a Permit2 signature moves the tokens at fill time, no maker gas
 *
 * The last three are gasless for the maker and none of them commits a token. All three are
 * permissions the maker can defeat by spending the balance first, so the transfer at fill time is
 * what decides. They differ in how tightly the permission is drawn: an authorization and a
 * Permit2 signature are both single use, exact in amount, and carry their own expiry, while an
 * EIP-2612 permit sets a reusable allowance and inherits every weakness of the approval rung —
 * including the worst one, that revoking the allowance never cancels the signature.
 *
 * **The permit2 rung is the one that survives a redeploy, and that is the whole reason for it.**
 * Every other rung that reaches a wallet needs an ERC-20 approval to `ProveRelayer`, which this
 * contract's constructor created — so a new settlement means a new relayer and every maker has to
 * approve again. A maker on this rung approves Permit2 once, at an address that never moves, and
 * signs one short-lived permit per intent. Nothing durable points at us at all.
 *
 * The maker signs a gross number and receives that number less the fee. The filler pays the
 * gross whatever the rate is, so the rate moves money from the maker to the destination and
 * changes nothing else — it does not move the fill. Rounding favours the maker on both halves of
 * the split, and the app is what turns a maker's desired net into the gross they sign.
 *
 * **The rules that hold this address together.** This contract calls out to addresses it did not
 * choose: the executor's callback, and the maker's ERC-1271 wallet. It is also the custodian of
 * every escrowed balance. It is no longer the approval target — see `ProveRelayer` — and these
 * three rules are what keep the roles apart:
 *
 *     1. ProveSettlement may call an address it did not choose only through a selector it did
 *        choose. No call site takes a selector, or a whole calldata blob, from a caller.
 *     2. No call site may target the relayer, or this contract. The `callableTarget` modifier.
 *     3. **No allowance lives here.** Not a maker's, not an executor's. Every `transferFrom` in
 *        this contract goes through `ProveRelayer.pull`, and there are none left to find.
 *
 * Break rule 1 at any call site and every allowance reachable from here is spendable by anyone:
 * the attacker asks this contract to say `transferFrom(victim, attacker, all)` on their behalf,
 * and the token obliges, because this contract is exactly who the victim approved. Transit Swap
 * lost $23M to that shape in 2022 and CoW Protocol lost $166k to it in 2023.
 * `test_TheFixedSelectorIsTheOnlyThingProtectingTheCallbackPath` is the tripwire.
 *
 * Rule 3 has no exception, and that is the point of it. It shipped first covering makers only,
 * which left "no *maker* allowance lives here" — a rule a contributor has to hold two cases in
 * mind to apply. One clause survives contributors; one with an exception is how the selector rule
 * came to be load-bearing and unwritten in the first place. Everyone now approves one address.
 *
 * Rule 2 is what stops an attacker reaching the relayer in one more hop, and without it the split
 * is decorative, because the relayer does what this contract tells it. Escrowed principal is
 * still held here, so rule 1 still guards real money and a vault is still the unbuilt end state.
 * `test/Relayer.t.sol` holds all three.
 *
 * **What this contract holds, which is no longer only escrow.** It used to be true that
 * everything here was a reservation owned by a named intent, and `sweepUnowned` was the proof:
 * whatever no reservation claimed belonged to nobody, so it went to the stray config. That is
 * now wrong in one specific way, and the next person to reason about that subtraction has to
 * know it before they read it.
 *
 * A fee is **booked, not paid**, at fill time. `_reserve` books it, the solver's one pull funds it, and
 * `_pendingFees[feeConfig][token]` holds it; the destinations — or anybody willing to spend the gas for them —
 * takes it out later with `claim`. So the settlement holds fee balances continuously, from the
 * first fill that charges anything, belonging to no intent and to no reservation. They are
 * unreachable by the maker and by every solver, indefinitely, including for a
 * destination that never claims and for one that cannot. **This contract is now a place money
 * rests as well as a place it passes through.**
 *
 * That buys one thing, and it is worth the change: the address a fee transfer targets during a
 * fill is `address(this)`, a constant, instead of an address the maker signed and nobody vetted.
 * A destination that refuses the token used to revert inside the fill and leave the maker with
 * nothing. Now the fill settles, the maker is paid, and the fee waits.
 */
contract ProveSettlement {
    using SafeERC20 for IERC20;

    // ── Types ────────────────────────────────────────────────────────────────

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
        /**
         * @notice The fee config this intent's fees are booked under: the EIP-712 `hashStruct`
         *         of `FeeConfig{destinations, weights}`, or zero for no fee at all.
         *
         * Signed, so the party that builds the intent names the destinations and the maker
         * agrees to them. There is no registry and nobody to ask: any valid config is a legal
         * choice, and the settlement never looks inside the hash on a fill. `claim` takes the
         * preimage, checks it against this hash and pays the destinations by their weights.
         *
         * Zero means no fee at any take point, and then all three rates must be zero. A signed
         * rate is never silently dropped.
         *
         * **A fill never calls a destination.** Fees are reserved in the fee book under this
         * key and `claim` pays them out later, to whoever is willing to spend the gas.
         */
        bytes32 feeConfig;
        /**
         * @notice P2, the output fee: a fraction of one ether of `owedToMaker`, charged ON TOP of
         *         it, in `tokenOut`, and borne by the solver.
         *
         * The intent names the rate and the fill charges it. Nothing raises it and nothing lowers
         * it. Two more rates sit at the end of the struct (`feeRateIn`, `feeRateProceeds`): one
         * config and one weight vector serve all three take points.
         *
         * **The ceiling is `WAD`, and arithmetic sets it rather than policy.** `_termsOk` refuses
         * an intent whose rate is above it, and `fillability` says `BadTerms_`. Below that nobody
         * rules on the number: a rate nobody will pay is an offer nobody fills. The filler's own
         * `maxFeeRate` bounds `feeRateIn + feeRate`, the two costs the solver bears.
         *
         * **It sits next to `feeConfig` because the two are one term.** The struct grows only at
         * its end.
         */
        uint64 feeRate;
        /**
         * @notice The smallest partial fill this intent accepts. Zero means no floor at all.
         *
         * A partial fill has to satisfy `take >= minFill || take == remaining`. The second
         * clause is not a courtesy. Without it a floor of 30 on an amount of 100 leaves a final
         * 10 that no fill can ever close, so every intent with a floor ends in dust nobody can
         * reach and the maker's escrow sits behind it until they withdraw.
         *
         * **What it buys.** `_redeem` redeems `amountIn`, not `take`, so a solver could take one
         * wei of a partial gasless intent and move the maker's whole balance into escrow, where
         * it stays until the maker withdraws it or the intent expires. A floor raises the price
         * of doing that from one wei to a real commitment.
         *
         * **What it does not buy.** It does not remove the property. An EIP-3009 authorization
         * is a fixed value under a single-use nonce and cannot be redeemed in pieces, so the
         * first fill of any size still moves the whole `amountIn`. That is the token standard's
         * constraint and no field here can lift it. This field prices the move; it does not
         * prevent it.
         *
         * `FLAG_PARTIAL` is the switch that makes it mean anything: an all-or-nothing intent
         * already satisfies `take == remaining` on its only legal fill, so a floor never bites
         * there whatever it says. It goes here rather than earlier because `flags` and `nonce`
         * do not move: the struct grows only at its end, and `curve` is the member that proves
         * it.
         */
        uint256 minFill;
        /**
         * @notice The EIP-3009 nonce this intent's authorization must carry. Zero means the
         *         intent's own hash, which is what every intent used to be given.
         *
         * A 3009 nonce is a 32-byte value the signer picks and the token spends once. Two intents
         * that name the same one are therefore **mutually exclusive**: whichever is armed first
         * spends the nonce, and the other can never be funded. A maker can post the same
         * inventory at two prices and know that only one of them can ever arm.
         *
         * The contract used to derive this from the intent hash and refuse anything else, which
         * welded one authorization to one intent and took that away. Naming it in the signed
         * intent gives it back and gives nothing up: a solver still cannot repoint an
         * authorization, because the intent says which nonce it expects and the maker signed
         * that. The property the old check defended is the same; the maker states it now instead
         * of the contract assuming it.
         *
         * **Three things about it that are not obvious.**
         *
         * Exclusion only holds between intents of the same `amountIn`. `_redeem` presents
         * `i.amountIn` as the value and the maker's 3009 signature commits to that value, so an
         * authorization signed for 100 simply fails against a sibling asking 50. The token
         * enforces that; this contract does not have to.
         *
         * It is one-shot. Arming either sibling spends the nonce for good, even if that intent
         * never fills — the maker takes the money back with `withdraw` and has to sign again to
         * try a second time.
         *
         * It composes with the other three counters rather than competing with them, and each
         * buys a different thing. An EIP-2612 nonce is sequential, so a permit gives ordering. A
         * 3009 nonce is arbitrary and single-use, so this gives exclusion. `_laneFloor` is a
         * high-water mark over `Intent.nonce`, one per lane, so `invalidateBefore` gives
         * selective bulk revocation.
         * `minFill` is none of those: it bounds the size of a fill, not which offers survive.
         */
        bytes32 authNonce;
        uint8 flags;
        uint256 nonce;
        /**
         * @notice The shape the maker's price traces between `minOutStart` and `minOutEnd`.
         *
         * `minOutStart` is the ceiling, `minOutEnd` is the floor, and this word says where
         * between them the price sits at each moment. Two bits of `flags` — `FLAGS_CURVE_KIND` —
         * say how to read it, and each kind reads only the bytes it names. Kind 0 reads none of
         * this word and walks the straight line every intent walked before the field existed.
         * Kind 1 reads four bytes and draws a stretch. Kinds 2 and 3 are reserved and read
         * nothing yet, so an intent that names one prices as the line.
         *
         * **A byte a kind does not read changes no price.** It is signed, so nothing can rewrite
         * it, and it is hashed, so it is part of the offer. It buys the maker nothing and costs
         * them the calldata it occupies, and nothing more. There is no rule against it and
         * there should not be one: a rule would spend gas on every fill to refuse a waste that
         * falls on the signer alone.
         *
         * **A whole word, and a `uint16` would have cost the same.** Every member of `Intent` is
         * a static type, so the ABI gives each one its own 32-byte word wherever it goes: a
         * four-byte field and a thirty-two-byte field are both 128 gas of zero calldata on every
         * fill. The SDK's codec writes only the bytes a kind uses, so an unused byte costs
         * nothing on the wire either. The width is free, and a later kind that wants more of it
         * needs no second field and no second typehash.
         *
         * **What it costs a maker who never touches it.** 128 gas of zero calldata, plus one
         * word through `_structHash`'s keccak — about 15. Around 143 gas against the 124,975 a
         * warm allowance fill measures in `Gas.t.sol`, on chains 369 and 943, both of which
         * price calldata at plain EIP-2028 with no floor under it: neither has reached Prague,
         * so EIP-7623 does not apply. Re-check the day either one forks.
         *
         * **A maker who uses it pays about 424 more**, measured in one binary against the same
         * fill on the same instant — see `Curve.t.sol`'s `test_WhatTheStretchCostsOnAWarmFill`.
         * Do not read that number off a before-and-after of the whole gas table: a struct that
         * changes shape moves via-IR stack scheduling by several hundred gas in either
         * direction, and `claim`, which carries no `Intent` at all, moved 22 gas on this
         * change.
         */
        bytes32 curve;
        /**
         * @notice P1, the handover fee: a fraction of one ether of `take`, in `tokenIn`, borne by
         *         the solver. It is the gas cover. Appended at the end: the struct grows only there.
         */
        uint64 feeRateIn;
        /**
         * @notice P3, the proceeds fee: a fraction of one ether of `owedToMaker`, kept out of it,
         *         in `tokenOut`, and borne by the maker: the recipient is paid the rest.
         */
        uint64 feeRateProceeds;
    }

    struct FillRequest {
        Intent intent;
        bytes signature;
        uint256 take;
        /**
         * @notice Empty, or the bytes that reach this maker's funds: a `Permit2Transfer` when
         *         the intent carries `FLAG_PERMIT2`, an `Authorization` or the one word
         *         `ARM_FROM_PARKED` when it carries `FLAG_ESCROW`, a `Permit` when it carries
         *         neither.
         *
         * The intent says which rung these bytes belong to, so the batch needs no tag of its
         * own. That is the same rule `fillWithPermit`, `fillWithAuthorization` and
         * `fillWithPermit2` run at their own doors: each refuses every flag but its own, and all
         * four read `_armLeg`. `_termsOk` refuses an intent wearing two custody flags at once,
         * so the rungs cannot overlap.
         *
         * **The escrow rung takes two shapes and the length tells them apart.** An
         * `Authorization` is at least 192 bytes because it holds a signature; the parked source
         * needs no parameter at all and is exactly one word. `_redeemInto` carries the argument.
         * The parked source has no single-fill door of its own — a solver who wants one leg
         * writes a one-leg batch, and pays for an array it does not use.
         *
         * The caller supplies this, not the maker, so the caller decides which legs are worth
         * an arming call. A leg that leaves it empty must already be reachable, through a
         * standing allowance or tokens sitting in escrow.
         *
         * Arming runs in a frame of its own. A leg that is requested but cannot be armed leaves
         * nothing behind: the maker's nonce is unspent and their tokens have not moved, so the
         * same signature works next time. Without that frame a token that takes a cut on
         * transfer would burn a maker's authorization for nothing, and cost a solver a whole
         * batch for the price of one signature anybody can post.
         *
         * **`EscrowShort` on a leg that asked to be armed means "not armable now", not "not
         * armable ever".** The reason a leg comes back with is the one it had before the arming
         * was tried, so it says nothing about why the arming failed — an authorization whose
         * window has not opened yet reads exactly like a taxed token or a spent nonce. A solver
         * holding these bytes can decode the window and tell the difference without asking the
         * chain, and one that does not will drop a leg that would have armed a minute later.
         */
        bytes arming;
    }

    /**
     * @notice EIP-3009 authorization that funds the escrow just in time.
     *
     * `signature` is an unstructured blob, which is ERC-7598. It was a fixed 65-byte `v`, `r`,
     * `s` triple, and that made one rung of custody refuse contract wallets: `_validSignature`
     * already falls back to ERC-1271, so a smart account could sign the *intent* but not the
     * authorization that funds it. A maker who cannot hold a key was welcome to make an offer
     * and unable to back it. `_redeem` picks the token's overload by this field's length.
     *
     * **`validAfter` and `validBefore` are a second window, and nothing reconciles it with the
     * intent's.** The token enforces this one; `_evaluate` enforces `startTime` and `endTime`.
     * So a gasless leg's real life is the intersection of the two, and `validBefore` is the de
     * facto expiry of the rung that funds it. Nothing bounds the intent's own window, so a maker
     * who signs a long one against a short authorization has signed an offer that stops working
     * long before it expires, and nothing on chain will say so. A maker who wants the two to
     * agree has to make them agree.
     *
     * The mismatch is invisible from outside. A window that has not opened, or has closed,
     * reverts inside the token, `armLeg`'s frame catches it, and the leg comes back
     * `EscrowShort` — the same answer a taxed token or a missing authorization gives.
     */
    struct Authorization {
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes signature;
    }

    /// @notice EIP-2612 permit, so a maker can grant the relayer's allowance without sending a
    ///         transaction. `value` is what the maker signed for, which may exceed this fill.
    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    /**
     * @notice A Permit2 SignatureTransfer, which moves the maker's tokens once and grants
     *         nothing that outlives the call.
     *
     * The maker approved Permit2 — once, for good — and signed this. Permit2 spends the nonce,
     * checks the deadline, refuses a request above `amount`, and hashes `msg.sender` in as the
     * spender, so this signature is worth nothing to any address but `ProveRelayer`.
     *
     * Flat, and not Permit2's own nested `PermitTransferFrom`, for the reason `Authorization` is
     * flat: these bytes come off a wire the SDK packs, and one level of nesting inside an
     * `abi.decode` is one more thing a client can get subtly right and cost a maker a fill.
     * `_pullPermit2` builds Permit2's shape at the call.
     *
     * **`token` is checked against `tokenIn` and `nonce` against the intent, before Permit2 hears
     * about either.** The caller supplies these bytes, so without both checks a solver holding
     * one of a maker's signatures could point it at a different offer of theirs. `_pullPermit2In`
     * carries the argument for each.
     *
     * `amount` is what the maker signed for and may exceed this fill: a partial take draws only
     * what it fills. The nonce is single-use whatever the size, so the remainder of a partially
     * filled intent needs a fresh signature — nothing is stranded, which is the one thing this
     * rung does better than EIP-3009.
     */
    struct Permit2Transfer {
        address token;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        bytes signature;
    }

    // ── Constants ────────────────────────────────────────────────────────────

    uint8 public constant FLAG_PARTIAL = 1;
    /**
     * @notice This intent's token A is held here, reserved to this intent alone.
     *
     * **"I just will not deposit" stopped being an off switch, and a maker has to be told.**
     * An escrow intent the maker never funded used to be inert for ever: `_evaluate` answered
     * `EscrowShort` and only a transaction from the maker could change that. It was the one
     * property this rung had that no other rung had. Since `_drawFromParked`, any solver may
     * fund it from capital `park` freed out of another offer of theirs — no action by the maker,
     * at a moment the solver picks.
     *
     * That is the same shape as a decision already taken. Revoking an allowance leaves a wallet
     * signature alive, and re-approving revives every signature the maker ever wrote;
     * `test_ARevivedAllowanceRevivesEverySignatureStillInsideItsWindow` pins it. This is that
     * hazard arriving at the rung that used to be exempt.
     *
     * `cancel` and `invalidateBefore` are the off switches, they always were, and they are now
     * the only ones. A maker who calls off one offer to move its capital must call off every
     * other signature they do not want funded with it.
     */
    uint8 public constant FLAG_ESCROW = 2;
    /**
     * @notice This intent's token A is reached by a Permit2 signature.
     *
     * A free bit of a field that was already in the signed struct, which is the whole reason this
     * rung cost no type-hash change, no codec version and no re-signing of anything: `flags` is
     * inside `INTENT_TYPEHASH` and always has been, so a maker who sets this bit signs the same
     * seventeen fields every other maker signs.
     */
    uint8 public constant FLAG_PERMIT2 = 4;

    /**
     * @dev The rungs whose token A is in this contract's hands by the time it is released.
     *
     * Escrow gets there by a deposit or a redeemed authorization; permit2 gets there inside the
     * arming call. Three places read this and they have to agree: `_evaluate` asks the
     * reservation rather than an allowance, `_release` pays out of it rather than pulling, and
     * `fillWithPermit` refuses an intent wearing either flag, because a permit reaches the tokens
     * by allowance and never by custody. Written out three times as `FLAG_ESCROW | FLAG_PERMIT2`,
     * a fourth rung would go in two of the three and the third would be a bug nobody could see.
     *
     * Private, not public: no caller needs it, and a public constant adds a selector every call
     * into this contract pays to walk past.
     */
    uint8 private constant FLAGS_CUSTODIED = FLAG_ESCROW | FLAG_PERMIT2;

    /**
     * @notice The arming bytes that say "fund this leg out of the maker's parked capital".
     *
     * One word, and the word is the whole message. Every other arming shape carries a signature
     * that reaches somewhere this contract otherwise cannot go; this one reaches money already
     * here, whose owner and token the intent's own preimage decides. So the bytes carry no
     * parameter a caller could get wrong and none a caller could point at somebody else. They
     * only ask.
     *
     * `_redeemInto` tells this from an authorization by length, and the margin is wide:
     * `Authorization` is a struct with a dynamic member, so `abi.encode` of one is at least 192
     * bytes and can never be 32. A word that is the wrong word is `BadTerms`, rather than a
     * decode that fails somewhere a caller cannot read.
     *
     * Public, unlike `FLAGS_CUSTODIED`, and the difference is who needs it. Nothing off chain
     * reads that constant. Every solver has to write this one into calldata, and a client
     * carrying its own copy is a client that can carry a stale one.
     */
    bytes32 public constant ARM_FROM_PARKED = keccak256("prove.settlement.armFromParked");

    /**
     * @dev Which shape `minOutAt` walks, in bits 8 and 16 of `flags`.
     *
     * The field is the expensive half and the kind is the cheap one. `curve` is a typehash, a
     * codec version and a calldata word on every fill forever; a kind is two bits of a byte the
     * maker has always signed and one branch in `minOutAt`. Separating them means a later shape
     * costs a branch and nothing else.
     *
     * Private, for the reason `PROBE_GAS` is: a public constant adds a selector that every call
     * into this contract pays to walk past, and no caller needs to read this number. What binds
     * a client's copy is not the number but the answer — `Fixture.t.sol` signs an intent that
     * names kind 1 and pins `minOutAt` at ten instants across it, so a mirror that reads the
     * wrong bit reproduces none of the eight in the middle.
     */
    uint8 private constant FLAGS_CURVE_KIND = 24;

    /**
     * @dev The straight line, and what every intent signed before `curve` existed.
     *
     * Read by nothing: it is the value the branch in `minOutAt` falls through to. It is written
     * down because a numbering that lives only in the gaps of an `if` is a numbering the next
     * kind collides with.
     */
    uint8 private constant KIND_LINEAR = 0;

    /**
     * @dev Flat at the ceiling, one fall, then flat at the floor. Four bytes of `curve`.
     *
     * `_stretchAt` is the whole of it. It draws dutch-then-flat, flat-then-dutch and
     * flat-dutch-flat exactly, which is every shape anybody has asked for, and its zero word is
     * the straight line character for character.
     */
    uint8 private constant KIND_STRETCH = 8;

    /**
     * @dev Reserved: eight knots and nine linear segments, over the whole word.
     *
     * Not implemented. An intent that names it prices as the line, and that is the honest
     * outcome rather than a hazard: adding the kind is a change to `minOutAt`, a change to
     * `minOutAt` needs a redeploy, and a redeploy moves the domain separator, so no signature
     * written against this contract can ever be read by the one that implements it.
     *
     * The number is reserved here so that contract cannot pick it for something else. Kind 1
     * measured 2.6x cheaper than one knot and 7.8x cheaper than eight on the same fill, and
     * nobody has yet named a shape it cannot draw.
     */
    uint8 private constant KIND_KNOTS = 16;

    /// @dev Reserved: a cubic Bernstein blend over two `uint16` control points. Not implemented,
    ///      on the same terms as `KIND_KNOTS`. It is the only candidate shape that is not exact,
    ///      and it cannot make a corner: with both controls on the floor it still sits 29.6% of
    ///      the range above it a third of the way through, which is the shape asked for first.
    uint8 private constant KIND_CUBIC = 24;

    /**
     * @dev The unit a curve writes a fraction of the window in. Full scale, so 65,535 is the
     *      whole window and one step is about 15 parts per million of it.
     *
     * It is `uint16` full scale rather than a round power of ten because the fractions live in
     * `curve` two bytes at a time, and a denominator a field cannot reach wastes the top of its
     * range. `_stretchAt` multiplies a `uint64` span by it, so the products stay under 2^80.
     */
    uint256 private constant CURVE_ONE = 65_535;

    uint256 public constant WAD = 1e18;

    /**
     * @notice The gas one `_probe` read may spend.
     *
     * Unused gas is not charged, so an honest token that answers from a storage slot pays what it
     * uses and never sees this number. It binds two things only: a token that loops, and a token
     * that answers with a large buffer the caller then has to copy. `test/ReturnBomb.t.sol`
     * measures what it is worth against both.
     *
     * Private, not public. A public constant adds a selector to the dispatch table and every call
     * into this contract pays to walk past it — 22 gas on `cancel` as much as on `fillBatch`. No
     * caller needs to read this number, and the two tests that care about it hard-code it.
     */
    uint256 private constant PROBE_GAS = 30_000;

    /**
     * @notice The gas one armed batch leg may spend in `armLeg`'s frame.
     *
     * Without a cap, a leg on a token that loops takes 63/64 of the batch's gas, and the batch
     * dies with it. The costliest honest arming the suite runs, an EIP-3009 redemption with its
     * deep re-evaluation, spends 147,912 gas. This is more than three times that, to leave room
     * for a proxied token and an ERC-1271 maker. `test/ReturnBomb.t.sol` holds the hostile case.
     */
    uint256 private constant ARM_GAS = 500_000;

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address maker,address recipient,address tokenIn,address tokenOut,uint256 amountIn,uint256 minOutStart,uint256 minOutEnd,uint64 startTime,uint64 endTime,address executor,FeeConfig feeConfig,uint64 feeRate,uint256 minFill,bytes32 authNonce,uint8 flags,uint256 nonce,bytes32 curve,uint64 feeRateIn,uint64 feeRateProceeds)FeeConfig(address[] destinations,uint256[] weights)"
    );

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 private constant NAME_HASH = keccak256("prove.cash");
    bytes32 private constant VERSION_HASH = keccak256("1");

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    // ── State ────────────────────────────────────────────────────────────────

    /**
     * @notice Where a token that reaches this contract attributed to nobody goes: a fee config,
     *         fixed at construction. `sweepUnowned` books the stray under it and `claim` pays it.
     *
     * Not a fee destination chosen by anyone at fill time, and not an owner's setting. There is
     * no owner. Immutable, so nothing can repoint it; strays are small by nature.
     */
    bytes32 public immutable STRAY_CONFIG;

    mapping(bytes32 => uint256) public filled;

    /// @notice When a maker's cancellation of this intent takes effect. Zero means never.
    mapping(bytes32 => uint64) public cancelledAt;

    /**
     * @dev The lowest nonce a maker still honours, per lane. It bites the moment it is written.
     *
     * **A nonce is read as two numbers, and the maker signed both without knowing it.** The high
     * 192 bits are a lane and the low 64 are a position inside it, which is how OpenZeppelin's
     * `NoncesKeyed` packs a key and a sequence into one word. A floor is written against one
     * lane and compares against positions in that lane alone, so a maker who groups their
     * signatures — one lane per pair, per strategy, per session, whatever they choose — retires
     * a whole group with one `SSTORE` and leaves every other group alone.
     *
     * **`NoncesKeyed` itself is the wrong base class here and is deliberately not inherited.**
     * It follows ERC-4337: `_useCheckedNonce` demands the exact next value and increments by
     * one. Makers here post many live signatures at once and solvers fill them in whatever order
     * they find them, so a counter would force filling in signing order and delete the resting
     * book. This is a high-water mark, not a counter. Only the packing is borrowed.
     *
     * **Lane 0 is exactly the floor this contract has always had, and that is the compatibility
     * claim.** Three things sign intents here: two surfaces at a millisecond epoch, about 1.8e12,
     * and the heartbeat bot at a thousand times that. A `uint64` holds 1.8e19, so all three have
     * 192 zero high bits. Measured, not assumed: every archived intent on chains 369 and 943, on
     * every wire version posted, sits in lane 0 — `app/scripts/check-nonce-lanes.ts` re-asks it.
     * `invalidateBefore(8)` still means "retire everything below 8".
     * `test_LaneZeroIsExactlyTheFloorTheContractAlwaysHad` and `nonce-lane.test.ts` pin both ends.
     *
     * **What a strict floor can never retire is the top value of its range**, because the
     * comparison is `<`. That was `type(uint256).max` before this change and it is each lane's
     * position `type(uint64).max` after it. `cancel` reaches those, and nothing in this
     * repository signs one. `test_TheTopPositionInALaneIsTheOneAFloorCannotReach` breaks it on
     * purpose so the hole is a measured property rather than an unstated one.
     */
    mapping(address => mapping(uint192 => uint64)) private _laneFloor;

    /**
     * @dev Escrow is committed to one intent, not pooled per maker.
     *
     * Pooled escrow could not keep the promise the "proven" badge makes. A maker who saw an
     * executor's fill in the mempool could sign a second escrow intent paying themselves a
     * worthless token, front-run with it, and walk the same funds out. Keyed by intent hash, the
     * funds behind an intent can only ever leave through that intent or back to the maker.
     *
     * **`_parked` is a pool and it is not this.** Parked capital is the same maker's money in a
     * map keyed by maker and token, and it exists so a dead offer's escrow can fund the next one
     * without a round trip through their wallet. It does not weaken the paragraph above, because
     * no fill can reach it: `_evaluate` asks this map and only this map, so parked capital backs
     * no offer until an arming call moves it here, inside the transaction that spends it.
     *
     * An amount, and nothing else. It used to carry an `unlockAt` as well, for a cooldown that
     * has since been removed — see `withdraw`.
     *
     * **A rebasing token breaks this accounting, and the contract cannot tell.** The reservation
     * is a number per intent; the tokens behind every reservation of the same asset sit in one
     * balance here. A token whose balance falls on its own — a negative rebase, an elastic supply
     * contracting — leaves the numbers adding up to more than the contract holds. Two makers each
     * escrow 1,000, the token halves, and the first to withdraw takes their whole 1,000 while the
     * second finds nothing. It is first-come, and the loss lands on whoever is slower.
     *
     * There is no fix in this contract. Measuring a share of the balance instead of a fixed
     * amount would spread the loss fairly, and it would also spend the guarantee that a donation
     * cannot pay for a fill, which is worth more. So the answer is a token allowlist off chain:
     * do not escrow an asset whose balance can fall.
     *
     * A fee-on-transfer token is the near miss that shows where the line is. `deposit` credits
     * the balance it actually received rather than the amount asked for, so the shortfall is
     * priced in at the moment it happens and the books stay true. A rebase happens later, with
     * nothing watching, and there is no moment to measure.
     *
     * This is measured now, not predicted. `test/TokenMatrix.t.sol` halves the index under a
     * funded escrow and walks the consequence out: the fill at the booked size reverts inside the
     * token, a fill at the surviving half empties the balance, and the maker's own `withdraw`
     * then reverts on a reservation the contract cannot pay. A rebase upward is the other half
     * of the same gap. The escrow pays the booked number, so the gain rests here reserved to
     * nobody, and `sweepUnowned` books it to the stray config rather than to the maker whose
     * tokens grew — read that function before allowlisting an elastic asset.
     *
     * This used to say the sweep pays "the fee sink", and later `defaultProceeds`. It does not: it
     * books the gain under the immutable stray config (`STRAY_CONFIG`) and `claim` pays it out.
     * The gain is no longer stranded, but it still does not reach the maker who earned it.
     */
    mapping(bytes32 => uint256) private _reserved;

    /**
     * @dev The same book, added up per token. `sweepUnowned` is the only reason it exists.
     *
     * `_reserved` is keyed by intent hash, so nothing — this contract least of all — could ask
     * how much of a balance the reservations claim. This is that number. It moves wherever
     * `_reserved` moves, by the same amount, in the same statement, so the two books cannot
     * disagree. Miss one site and the sweep either pays a maker's escrow to the sink or reports
     * less than is really unowned.
     *
     * One hash belongs to exactly one token, because `hashIntent` commits to `tokenIn`. That is
     * what makes this an exact sum rather than an estimate: no reservation can count against two
     * tokens, and no token's total can hold a reservation of another's.
     *
     * The credits mirror the measured delta, never the amount a caller asked for. A token that
     * taxes its own transfers delivers less than `deposit` was told to pull, `_reserved` is
     * credited what arrived, and this has to be credited the same or the two drift apart by the
     * tax on every deposit — with the sweep paying out the difference.
     */
    mapping(address => uint256) private _totalReserved;

    /**
     * @dev Fees reserved under a fee config and not yet claimed, per token: `[config][token]`.
     *
     * Three take points write it (P1 in `tokenIn`, P2 and P3 in `tokenOut`), each in the same
     * statement as `_totalPendingFees`. A fee is booked when it is reserved, before the tokens
     * behind it reach this contract: the flush at the end of the entry point pulls them from the
     * solver and the call reverts unless every reservation is backed. So between calls, every
     * booked wei is held. Only `claim` takes a cell out, and it pays by the config's weights.
     *
     * **A booked fee is not a reservation and `withdraw` cannot reach it.**
     */
    mapping(bytes32 => mapping(address => uint256)) private _pendingFees;

    /**
     * @dev The same book, added up per token. `sweepUnowned` is the only reason it exists.
     *
     * The exact twin of `_totalReserved`, for the exact same reason. `_pendingFees` is keyed by
     * fee config, so nothing could ask how much of a balance the destinations claim; this is
     * that number, and the sweep subtracts it. Miss one site and the sweep pays a fee config's
     * money to the stray config — not eventually, and not only under a hostile token, but on
     * the first fill of the first intent that names anywhere.
     *
     * It moves wherever `_pendingFees` moves, by the same amount, in the same statement, so the
     * two books cannot disagree. `test_TheSweepCannotTakeABookedFee` is the tripwire, and
     * `invariant_TheReservationsStillAddUpToTheBookTheSweepReads` holds the sum against the map
     * over any sequence the fuzzer invents.
     */
    mapping(address => uint256) private _totalPendingFees;

    /**
     * @dev A maker's own capital, resting here between one offer and the next.
     *
     * `park` moves a dead intent's reservation in and the escrow arm of `_armLeg` moves it back
     * out into a live one. So a maker who re-prices pays for no token transfer and, after the
     * one call that killed the old offer, sends no transaction at all — the solver arms the new
     * leg in the same transaction it fills.
     *
     * Keyed maker first, then token, for the reason `_pendingFees` is keyed destination first:
     * an owner reads their own row and the token is the second question.
     *
     * **This is not pooled escrow, and the difference is the whole of why it is safe.**
     * `_reserved` says why a pool cannot back an offer — a maker who saw an executor's fill in
     * the mempool could sign a second escrow intent, front-run with it, and walk the same funds
     * out. Nothing in this map is reachable by a fill. `_evaluate` reads `_reserved[h]` and only
     * that, so a leg with a hundred parked behind it and nothing reserved answers `EscrowShort`
     * exactly as an unfunded one does, and the badge a solver reads keeps meaning what it meant.
     * Crossing the line costs an arming call, in the same transaction as the fill it funds, for
     * an amount that fill bounds.
     *
     * **Both keys come from the intent's own preimage, which the maker's signature covers.**
     * `_drawFromParked` reads `_parked[i.maker][i.tokenIn]` and can read nothing else, so there
     * is no hash whose owner has to be established and no caller whose word has to be taken.
     * That is the `ProveCallSink` defect the roadmap records as #112 — a shared resource with no
     * owner check, armed by a stranger — answered by construction rather than by a check
     * somebody has to remember to write.
     *
     * The maker's way out is `withdrawParked`, which pays `msg.sender` and can pay nobody else.
     */
    mapping(address => mapping(address => uint256)) private _parked;

    /**
     * @dev The same book, added up per token. `sweepUnowned` is the only reason it exists.
     *
     * The third twin of `_totalReserved`, for the third time and the same reason. Parked capital
     * belongs to a maker rather than to an intent hash, so it looks unowned to anything that
     * reads only the reservations — and the sweep would hand every maker's parked money to
     * the stray config. That is not an edge a fuzzer has to find. It is the first sweep after
     * the first `park`.
     *
     * It moves wherever `_parked` moves, by the same amount, in the same statement, so the two
     * books cannot disagree. `test_TheSweepCannotTakeParkedCapital` is the tripwire, and
     * `invariant_TheReservationsStillAddUpToTheBookTheSweepReads` holds the sum against the map
     * over any sequence the fuzzer invents.
     */
    mapping(address => uint256) private _totalParked;

    /// @dev 1 = idle, 2 = inside a fill. Never zero after construction: a slot that returns to
    ///      zero pays the 20k SSTORE again on the next fill.
    uint256 private _entered = 1;

    /**
     * @notice The address everyone approves. Not this one.
     *
     * `ProveRelayer` holds nothing and can only `pull`, so a free-form call site added to this
     * contract later reaches no allowance at all. Makers approve it for `tokenIn`, in either
     * custody mode — the escrow deposit pulls through it too. Executors approve it for `tokenOut`,
     * which pays the maker and the fee. One address, one approval, whichever side you are on.
     *
     * Clients must read it from here rather than carry it in configuration: an approval to the
     * wrong address silently does nothing until a fill reverts.
     */
    address public immutable relayer;

    /// @dev The domain separator only changes if the chain forks, so it is built once.
    uint256 private immutable _CACHED_CHAIN_ID;
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;

    // ── Events ───────────────────────────────────────────────────────────────

    /**
     * @notice One leg settled.
     *
     * **Not a volume oracle.** Anyone can mint two tokens, hold both sides, and trade with
     * themselves at any price they like, so the notional here is whatever the pair of them chose
     * to say. Nothing downstream may key on it: not a reward, not a fee tier, not a leaderboard,
     * not a TWAP. The fee is the only number in this event that cost the executor anything, and
     * even that is 1 wei if the two of them settle the real consideration somewhere else.
     *
     * **`fee` means charged and booked, not delivered.** The executor parts with it here; the
     * destination receives it when somebody calls `claim`, which is `FeeClaimed`. A consumer that
     * read this as "the destination was paid" is now reading "the destination was credited", and
     * the two can be months apart — or never, for a destination that cannot receive its token.
     */
    event Filled(
        bytes32 indexed intentHash,
        address indexed maker,
        address indexed executor,
        address tokenIn,
        address tokenOut,
        uint256 take,
        uint256 delivered,
        uint256 fee
    );
    event Cancelled(bytes32 indexed intentHash, address indexed maker);
    /// @notice A maker raised a floor. `floor` is the argument they passed, in nonce space: its
    ///         high 192 bits are the lane and its low 64 are the position. Lane 0 reads exactly
    ///         as this event always did, which is why its signature did not move.
    event NoncesInvalidated(address indexed maker, uint256 floor);
    /**
     * @notice A reservation was credited. Four things credit one, and this says the same thing
     *         for all four: `amount` more of `token` now stands behind `intentHash`.
     *
     * `deposit` pulls it from a wallet, `_redeem` spends an EIP-3009 authorization, `_pullPermit2`
     * spends a Permit2 signature, and `_drawFromParked` moves the maker's own parked capital
     * across. Only the last of the four moves no tokens at all — it is a credit, not a transfer,
     * and a consumer reconciling this event against ERC-20 `Transfer` logs has to know that.
     */
    event Deposited(
        bytes32 indexed intentHash, address indexed maker, address indexed token, uint256 amount
    );
    event Withdrawn(bytes32 indexed intentHash, address indexed maker, uint256 amount);
    /// @notice A dead intent's reservation became the maker's parked capital. Nothing moved: the
    ///         tokens were here before and they are here after, under a different key.
    event Parked(
        bytes32 indexed intentHash, address indexed maker, address indexed token, uint256 amount
    );
    /// @notice A maker took their parked capital home. `Withdrawn` for money that belongs to no
    ///         intent, which is why it carries no hash.
    event Unparked(address indexed maker, address indexed token, uint256 amount);
    /// @notice Tokens that belonged to no reservation were booked under the stray config.
    ///         Nothing moved: `claim` pays them. No intent hash, because no intent put them here.
    event Swept(address indexed token, bytes32 indexed feeConfig, uint256 amount);
    /**
     * @notice A fee config's booked fees in one token left for its destinations.
     * @param paid what reached destinations; @param deferred what a failing destination's share
     *        was re-booked as, under that destination's one-destination config.
     * `paid + deferred` is what the cell held.
     */
    event FeeClaimed(
        bytes32 indexed feeConfig, address indexed token, uint256 paid, uint256 deferred
    );
    /// @notice One destination's share could not be paid inside the gas cap and was re-booked
    ///         under `singleHash(destination)`, to be claimed on its own.
    event ShareDeferred(
        bytes32 indexed feeConfig,
        address indexed token,
        address indexed destination,
        uint256 amount
    );
    /// @notice A config's preimage, for indexers and claim keepers. Logs only; not a gate.
    event FeeConfigAnnounced(bytes32 indexed feeConfig, address[] destinations, uint256[] weights);
    /// @notice The stray config, once, at construction: its preimage is on chain forever.
    event StrayConfigSet(bytes32 indexed feeConfig, address[] destinations, uint256[] weights);
    /// @notice The fees one fill reserved, at the three take points. Emitted after `Filled`
    ///         when any is non-zero. Indexers and the claim keeper read it for the cells to claim.
    event FeesTaken(
        bytes32 indexed intentHash,
        bytes32 indexed feeConfig,
        uint256 feeIn,
        uint256 feeOut,
        uint256 feeProceeds
    );

    // ── Errors ───────────────────────────────────────────────────────────────

    error NotMaker();
    error Reentrant();
    error BadSignature();
    error NotStarted();
    error Expired();
    error IsCancelled();
    error NonceTooLow();
    error WrongExecutor();
    error NothingToFill();
    error TooMuch();
    error PartialNotAllowed();
    error EscrowShort();
    error Underpaid();
    /// @dev A zero `permit2` in the constructor and a non-contract `token` in `claim`: one error
    ///      for the parameters that have no better name.
    error BadParameter();
    error BadTerms();
    error FeeTooHigh();
    error BelowMinFill();
    error ForbiddenTarget();
    /// @notice A fee config that is not canonical, or names this contract or its relayer.
    error InvalidConfig(FeeConfig.Fault fault);
    /// @notice A multi-destination claim was given too little gas to honour the per-transfer cap.
    error InsufficientGas();
    /// @notice The flush found `token` short by `due`: the solver did not cover its reservations.
    error ReservationUnbacked(address token, uint256 due);
    /// @notice The whole of `dryRun`'s answer: one reason per leg, in request order. An error
    ///         rather than a return value, because `dryRun` throws away everything it did.
    error DryRun(Reason[] reasons);

    // ── Setup ────────────────────────────────────────────────────────────────

    /**
     * @param stray where an unattributed token goes, as a fee config (validated; destinations may
     *        not be this contract or its relayer). Fixed for the life of the deployment.
     * @param _permit2 the Permit2 deployment this chain uses, which backs `FLAG_PERMIT2`. Passed
     *        straight to the relayer and kept nowhere here. A zero is refused rather than left to
     *        mean "no permit2 on this chain".
     *
     * There is no owner and there are no setters. What the deployer decides is these inputs.
     */
    constructor(FeeConfig.Config memory stray, address _permit2) {
        if (_permit2 == address(0)) revert BadParameter();
        // Deployed here, so the relayer's `settlement` is this contract and both sides are
        // immutable. No initializer, no address prediction, and no window where either is wrong.
        address _relayer = address(new ProveRelayer(_permit2));
        relayer = _relayer;
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();

        FeeConfig.Fault f = FeeConfig.fault(stray);
        if (f == FeeConfig.Fault.None) f = _reservedFault(stray, _relayer);
        if (f != FeeConfig.Fault.None) revert InvalidConfig(f);
        bytes32 h = FeeConfig.hash(stray);
        STRAY_CONFIG = h;
        emit StrayConfigSet(h, stray.destinations, stray.weights);
    }

    modifier nonReentrant() {
        if (_entered == 2) revert Reentrant();
        _entered = 2;
        _;
        _entered = 1;
    }

    /// @dev `ReservedDestination` when a destination is this contract or the relayer: money sent
    ///      there is unreachable, for the same reason `_termsOk` refuses them as a recipient.
    function _reservedFault(FeeConfig.Config memory c, address _relayer)
        private
        view
        returns (FeeConfig.Fault f)
    {
        for (uint256 k = 0; k < c.destinations.length; k++) {
            address d = c.destinations[k];
            if (d == address(this) || d == _relayer) return FeeConfig.Fault.ReservedDestination;
        }
        // Falls out as `None`, the named return's zero.
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

    function hashIntent(Intent calldata i) public view returns (bytes32) {
        return _hash(i, domainSeparator());
    }

    function _hash(Intent calldata i, bytes32 ds) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", ds, _structHash(i)));
    }

    /**
     * @dev The EIP-712 struct hash.
     *
     * The whole struct goes to the encoder, not its seventeen fields one by one. Every member
     * of `Intent` is a static type, so ABI encoding the struct lays the members down as
     * seventeen 32-byte words in declaration order — byte for byte what EIP-712 asks for, and
     * what the field-by-field version produced. `test_TheStructHashIsTheFieldByFieldEncoding` holds the
     * two forms to each other, and `Fixture.t.sol` pins the digest to the TypeScript codec.
     *
     * The reason to write it this way is the stack. Eighteen values in one encoder call is far
     * more than the legacy pipeline can reach, so `forge coverage` could not compile this
     * contract without `--ir-minimum`, and under `--ir-minimum` the branch counters lie. Two
     * values fit with room to spare, and they still do now the struct has grown three fields. Do
     * not expand it back out.
     */
    function _structHash(Intent calldata i) private pure returns (bytes32) {
        return keccak256(abi.encode(INTENT_TYPEHASH, i));
    }

    // ── Pricing ──────────────────────────────────────────────────────────────

    /**
     * @notice The minimum token B owed for the whole `amountIn`, at time `ts`.
     *
     * The answer is a function of the clock and the signature, and of nothing else. No caller,
     * no balance, no venue and no oracle reaches this number, which is the property every curve
     * design in `docs/superpowers/specs/2026-09-03-the-signed-intent-before-mainnet.md` was
     * measured against and the reason none of them reads an address.
     *
     * The two lines above the branch are the envelope, and they hold whatever the kind: the
     * price is `minOutStart` at or before the open, `minOutEnd` at or after the close, and
     * `minOutStart` throughout for an intent whose two ends agree. A flat intent is flat under
     * every kind, which is what `RfqVenue`'s mirror check rests on.
     *
     * **The bounds argument belongs to `_termsOk`, exactly as `_quote`'s does.** This prices the
     * terms it is handed and validates none of them: a rising minimum underflows here and an
     * unbounded `minOutStart` overflows here, and `fillability` answers `BadTerms_` for both
     * before any money moves.
     */
    function minOutAt(Intent calldata i, uint256 ts) public pure returns (uint256) {
        if (ts <= i.startTime || i.minOutEnd == i.minOutStart) return i.minOutStart;
        if (ts >= i.endTime) return i.minOutEnd;
        uint256 span = uint256(i.endTime) - uint256(i.startTime);
        uint256 elapsed = ts - uint256(i.startTime);
        if (i.flags & FLAGS_CURVE_KIND == KIND_STRETCH) {
            return _stretchAt(i.minOutStart, i.minOutEnd, i.curve, elapsed, span);
        }
        // `KIND_LINEAR`, and every kind this deployment has reserved and not built.
        return i.minOutStart - ((i.minOutStart - i.minOutEnd) * elapsed) / span;
    }

    /**
     * @dev Kind 1: flat at `hi`, one fall, then flat at `lo`.
     *
     *   price(u) = lerp(hi, lo, clamp01((u - start) / length))
     *
     * `start` says where the fall begins and `length` says how long it takes, both as a fraction
     * of the window in units of 1/65,535. A `length` of zero means "to the end of the window",
     * so the four zero bytes every other kind leaves behind are the straight line rather than an
     * instant collapse.
     *
     * **The zero word is today's line, character for character.** With `startF = 0` and a folded
     * `lenF` of 65,535 the return is `hi - (range * elapsed * 65535) / (65535 * span)`, and
     * `floor(a*k / b*k) = floor(a / b)`, so it is `hi - (range * elapsed) / span` — the
     * expression the line above walks. `testFuzz_AZeroWordIsTheShippedLine` holds the two to each
     * other over fuzzed prices, windows and instants.
     *
     * **Rounding is unchanged.** The subtrahend floors, so the maker's price rounds up, exactly
     * as it did before the field existed.
     *
     * **No word can panic, so there is no new `_termsOk` rule**, under that function's existing
     * caps alone:
     *
     *   pos      < 2^80    `elapsed < span <= 2^64`, times 65,535
     *   begin    < 2^80    `startF <= 65,535` — it is sixteen bits — times the same span
     *   den      > 0       see below, and it is under 2^80 for the same reason
     *   num      < den     strict, from the guard above the division
     *   range*num < 2^208  `_termsOk` caps `minOutStart` at `uint128`, and `lo <= hi`
     *
     * `den` is zero only when the encoded `lenF` is zero and `startF` is 65,535, and then
     * `begin = 65535 * span` while `pos <= (span - 1) * 65535`, so `pos <= begin` fires first
     * and the division is never reached. `testFuzz_TheEnvelopeHolds` fuzzes the whole word
     * against that argument rather than trusting it.
     *
     * The fall is the only part of the window this word can move. The result never leaves
     * `[lo, hi]`, because the two early returns are the ends and `num < den` keeps the
     * subtrahend under the range — which is what lets a client draw the axes before it has read
     * the shape.
     */
    function _stretchAt(uint256 hi, uint256 lo, bytes32 curve, uint256 elapsed, uint256 span)
        private
        pure
        returns (uint256)
    {
        uint256 startF = uint256(curve) >> 240; // bytes 0-1
        uint256 lenF = (uint256(curve) >> 224) & 0xffff; // bytes 2-3
        if (lenF == 0) lenF = CURVE_ONE - startF; // zero runs to the end of the window
        uint256 pos = elapsed * CURVE_ONE;
        uint256 begin = startF * span;
        if (pos <= begin) return hi;
        uint256 den = lenF * span;
        uint256 num = pos - begin;
        if (num >= den) return lo;
        return hi - ((hi - lo) * num) / den;
    }

    /// @notice Price one take at time `ts`: what the maker's curve requires and what each of the
    ///         three take points reserves, with the amounts each party handles (spec 2.10.3).
    ///
    ///         This prices the terms it is handed and validates none of them. A rate above `WAD`
    ///         underflows and reverts: ask `fillability` instead, it answers `BadTerms_`. The
    ///         reader (`ProveReader`) calls this very function, so its numbers are the fill's.
    function quote(Intent calldata i, uint256 take, uint256 ts)
        public
        view
        returns (TakePoints.Quote memory)
    {
        return _quote(i, take, ts);
    }

    /// @dev What the fill charges, in one place, so `_evaluate` and `_quote` cannot disagree. All
    ///      zero when `feeConfig` is zero (`_termsOk` refuses it if a rate is also signed). There
    ///      is no external `ratesOf`: the three rates are three fields of the intent.
    function _ratesOf(Intent calldata i) private pure returns (uint256, uint256, uint256) {
        if (i.feeConfig == bytes32(0)) return (0, 0, 0);
        return (i.feeRateIn, i.feeRate, i.feeRateProceeds);
    }

    /// @dev What a leg's fee terms are, for `TakePoints`' callback builders.
    function _ctx(Intent calldata i) private pure returns (TakePoints.Ctx memory c) {
        c.tokenIn = i.tokenIn;
        c.tokenOut = i.tokenOut;
        c.approvalRung = i.flags & FLAGS_CUSTODIED == 0;
        c.feeConfig = i.feeConfig;
        (c.rateIn, c.rate, c.rateProceeds) = _ratesOf(i);
    }

    /**
     * @dev Price one leg (spec 2.10.3), all of it in `TakePoints`:
     *
     *   owedToMaker = ceilDiv(take x minOutAt, amountIn)   the maker's curve; rounds up
     *   feeIn       = floor(take        x feeRateIn       / WAD)   P1, tokenIn, the solver bears it
     *   feeOut      = floor(owedToMaker x feeRate         / WAD)   P2, tokenOut, on top, the solver bears it
     *   feeProceeds = floor(owedToMaker x feeRateProceeds / WAD)   P3, out of owedToMaker, the maker bears it
     *
     * Every fee floors, so the dust stays with whoever bears it, and `owedToMaker` rounds up so a
     * partial fill never shorts the curve. `_termsOk` caps `amountIn` and `minOutStart` at
     * `uint128` and each rate at `WAD`, so the products fit a word and no subtraction underflows.
     */
    function _quote(Intent calldata i, uint256 take, uint256 ts)
        private
        view
        returns (TakePoints.Quote memory)
    {
        (uint256 rIn, uint256 r, uint256 rP) = _ratesOf(i);
        return
            TakePoints.price(
                take, TakePoints.owedFor(take, minOutAt(i, ts), i.amountIn), rIn, r, rP
            );
    }

    // `available(Intent)` is not here. It was a view over state this contract already exposes
    // (`filled`, `cancelledAt`, `laneFloor`) and `_termsOk`, and its bytes were what kept the
    // fee-config change under EIP-170. `ProveReader.available` answers the same question from the
    // same rules (`IntentTerms.ok`, which `ProveReader.t.sol` pins to `_termsOk` by fuzzing
    // `fillability`).

    /// @notice The lowest nonce this maker still honours in lane 0, which is the lane every
    ///         nonce this repository builds sits in. `laneFloor` answers for any other lane.
    function nonceFloor(address maker) external view returns (uint256) {
        return _laneFloor[maker][0];
    }

    /// @notice The lowest position this maker still honours in `lane`. A nonce's lane is its
    ///         high 192 bits and its position is its low 64.
    function laneFloor(address maker, uint192 lane) external view returns (uint64) {
        return _laneFloor[maker][lane];
    }

    /// @dev Has this maker's floor killed this nonce? The one reading of a nonce as a lane and a
    ///      position, so `ProveReader.available`, `_evaluate` and `park` cannot disagree about what
    ///      it says.
    function _retired(address maker, uint256 nonce) private view returns (bool) {
        return uint64(nonce) < _laneFloor[maker][uint192(nonce >> 64)];
    }

    // ── Escrow ───────────────────────────────────────────────────────────────

    /// @notice How much is committed to this intent right now. Reading by hash is safe; it is
    ///         only writing by hash that lets a stranger claim a slot they do not own.
    function reserved(bytes32 intentHash) external view returns (uint256) {
        return _reserved[intentHash];
    }

    /// @notice Every reservation of this token, added up. Parked capital is not in here — it is
    ///         `totalParked` — because this is the sum of `_reserved` and nothing else. The
    ///         contract's balance less all three books is what `sweepUnowned` may take, and a
    ///         maker can check them before they deposit.
    function totalReserved(address token) external view returns (uint256) {
        return _totalReserved[token];
    }

    /**
     * @notice Commit tokens to one intent, so an executor can see they cannot be moved.
     * @param i the intent these funds back, in full rather than as its hash.
     *
     * The hash commits to `maker` and `tokenIn`, so the preimage decides both. Take the digest
     * instead and the first caller decides them: one wei of any token, sent ahead of the maker's
     * own deposit, would name the sender as the owner of the reservation and the maker's money
     * would land inside it.
     *
     * Anyone may top up an intent. Only the maker named in it can withdraw.
     */
    function deposit(Intent calldata i, uint256 amount) external nonReentrant {
        if (amount == 0) revert BadParameter();
        bytes32 h = hashIntent(i);
        // An offer the maker called off cannot be funded, by them or by anybody else. Otherwise
        // "I took my money out" would be undone by a stranger's deposit.
        if (cancelledAt[h] != 0) revert IsCancelled();

        uint256 before = IERC20(i.tokenIn).balanceOf(address(this));
        // Through the relayer, so a maker who deposits and a maker who stays in their wallet
        // grant the same single approval, to the same address.
        ProveRelayer(relayer).pull(i.tokenIn, msg.sender, address(this), amount);
        uint256 received = IERC20(i.tokenIn).balanceOf(address(this)) - before;
        _reserved[h] += received;
        _totalReserved[i.tokenIn] += received;

        emit Deposited(h, i.maker, i.tokenIn, received);
    }

    /**
     * @notice Take your escrow back. One transaction, whenever you like.
     *
     * There used to be a cooldown here, and a `requestUnlock` to start it, and a window that shut
     * again if you missed it. All of that protected one kind of executor: the one who buys the
     * other side of your trade in a separate transaction and is therefore exposed between paying
     * for it and filling. Every path this contract ships settles in a single transaction —
     * `fill` for an executor holding inventory, `fillWithCallback` for one holding none — and a
     * single transaction cannot be front-run by you. It either fills at your signed rate or it
     * reverts and the release never happened.
     *
     * So the wait was charging every maker for a risk an executor can decline by not choosing the
     * worse execution path.
     *
     * **Taking the money out ends the offer.** An intent is armed by one action — the deposit —
     * and undoing that action undoes its ability to resolve. Without this the withdrawal only
     * emptied the reservation: `deposit` is permissionless, so anybody could fund the same intent
     * hash and the maker's abandoned signature would fill and pay them, unasked, months later. A
     * signature that can come back from the dead is not something a maker can reason about.
     *
     * It costs one storage write on the way out, which is the whole price of "withdrawn means
     * withdrawn". `deposit` refuses a cancelled intent for the same reason, so the funds cannot
     * be put back either.
     *
     * **This is the way out of the contract. `park` is the way into the next offer**, and it is
     * the one to reach for when the money is going straight back to work: it moves the same
     * reservation to `_parked` instead of a wallet, ends the offer the same way, and pays for no
     * token transfer. Reach for this one to hold the tokens yourself.
     */
    function withdraw(Intent calldata i) external nonReentrant {
        if (msg.sender != i.maker) revert BadParameter();
        bytes32 h = hashIntent(i);

        uint256 amount = _reserved[h];
        if (amount == 0) revert BadParameter();
        _reserved[h] = 0;
        _totalReserved[i.tokenIn] -= amount;

        // Undoing the deposit undoes the offer. Skip the write if a cancel already landed.
        if (cancelledAt[h] == 0) {
            cancelledAt[h] = uint64(block.timestamp);
            emit Cancelled(h, msg.sender);
        }

        IERC20(i.tokenIn).safeTransfer(msg.sender, amount);
        emit Withdrawn(h, msg.sender, amount);
    }

    /// @notice What this maker has resting here in this token, committed to no intent. No fill
    ///         can reach it. An arming call can, for the leg it is arming and for no more.
    function parked(address maker, address token) external view returns (uint256) {
        return _parked[maker][token];
    }

    /// @notice Every maker's parked capital in this token, added up. The contract's balance less
    ///         this, less `totalReserved` and less `totalPendingFees` is what `sweepUnowned` may
    ///         take.
    function totalParked(address token) external view returns (uint256) {
        return _totalParked[token];
    }

    /**
     * @notice Move a dead intent's escrow to the maker's parked capital, where the next offer
     *         they signed can be armed out of it.
     * @param i the dead intent, in full rather than as its hash, for `deposit`'s reason: the
     *        preimage decides `maker` and `tokenIn`, and a digest would let the caller decide
     *        both.
     *
     * The whole of #120, and the reason it needed no `rollover(old, new)`. That function would
     * have asked the maker for a transaction, which barely beats the withdraw-and-deposit it
     * replaces. This one asks nobody for anything: a solver calls it beside the fill it wants to
     * arm, or the maker calls it themselves, and either way the capital is where the next leg
     * can reach it.
     *
     * **It needs no caller check, because it has no destination to be pointed at.** The only
     * thing it can do is move the maker's money from the maker's own reservation into the
     * maker's own row, and both of those keys come out of the preimage the signature covers.
     * That is a far smaller surface than `withdraw`, which pays out and is therefore maker-only.
     *
     * **Dead means the window closed, the maker called the offer off, or the maker's floor
     * retired the nonce — never "the maker sent a cancel just for this".** Demanding an explicit
     * cancel would put the maker's transaction back in the loop, which is the whole thing this
     * avoids. `endTime` is signed by the maker and read from calldata, and an expired intent can
     * never fill again, so nothing they still want is being taken. A cancelled intent is dead by
     * their own act.
     *
     * **The floor is the third door, and #131 is why it exists.** Without it a maker who retires
     * fifty signatures in one transaction still pays `withdraw` and `deposit` per offer to move
     * the capital, which is the two-step this whole feature exists to remove. A floor is as much
     * the maker's own act as a cancel is, it can only ever rise, and `_evaluate` reads it the
     * same way — so an intent below it can no more fill again than an expired one can.
     *
     * No clock comparison on `cancelledAt`, unlike `_evaluate`: every writer of that slot writes
     * `block.timestamp`, so a value that is not zero is already in effect.
     *
     * **Taking the money out ends the offer, exactly as in `withdraw`, and for that function's
     * reason.** `deposit` is permissionless, so without the write anybody could fund the emptied
     * hash and the maker's abandoned signature would fill months later, unasked. The write is
     * skipped when a cancel already landed, so a cancelled intent keeps the moment the maker
     * chose rather than the moment a stranger called this.
     *
     * **No `nonReentrant`, like `cancel` and for `cancel`'s reason.** It calls nothing and
     * transfers nothing, so there is no frame for a token to re-enter through. Reached from
     * inside somebody else's fill it can do one of two things: refuse, because a leg that is
     * mid-fill is by definition not dead, or move a *different* dead intent's reservation — and
     * that moves the two per-token sums by the same amount in opposite directions, so the number
     * `sweepUnowned` computes does not change. `withdrawParked` pays out and carries the guard.
     *
     * **What it costs the maker, said plainly.** After this their route back is
     * `withdrawParked(tokenIn)` rather than `withdraw(intent)`, because the reservation is
     * empty. Anybody may force that swap on them at any point after their offer dies. The money
     * is the same money and it is still only theirs, but a client that knows one function and
     * not the other will show them a balance that has gone somewhere.
     */
    function park(Intent calldata i) external {
        bytes32 h = hashIntent(i);
        uint64 c = cancelledAt[h];
        // Still live, and still theirs alone. A reservation may only leave an intent that can
        // fill through that intent. Three ways to be dead, and the fill path refuses all three.
        if (block.timestamp < i.endTime && c == 0 && !_retired(i.maker, i.nonce)) {
            revert BadParameter();
        }

        uint256 amount = _reserved[h];
        if (amount == 0) revert BadParameter();
        _reserved[h] = 0;
        _totalReserved[i.tokenIn] -= amount;
        _parked[i.maker][i.tokenIn] += amount;
        _totalParked[i.tokenIn] += amount;

        if (c == 0) {
            cancelledAt[h] = uint64(block.timestamp);
            emit Cancelled(h, i.maker);
        }

        emit Parked(h, i.maker, i.tokenIn, amount);
    }

    /**
     * @notice Take your parked capital home. `withdraw` for the money that belongs to no intent.
     * @param token the asset to take back. One row at a time, because a maker who parked three
     *        assets is owed three transfers whatever the shape of the call.
     * @return amount what left.
     *
     * **`msg.sender` is the key, so this function has no owner check and needs none.** It reads
     * one row, empties it, and pays the address that names it. There is no argument naming a
     * maker, so there is nothing for a caller to point at somebody else — the same property
     * `park` has, arrived at from the other side.
     *
     * It reverts on an empty row rather than returning zero, unlike `claim`. `claim` may be
     * called by anybody on behalf of a destination that will never send a transaction, so a
     * quiet zero is the right answer there. This is a maker asking about their own money, and a
     * silent success would tell them their balance was fine when their token argument was wrong.
     */
    function withdrawParked(address token) external nonReentrant returns (uint256 amount) {
        amount = _parked[msg.sender][token];
        if (amount == 0) revert BadParameter();

        _parked[msg.sender][token] = 0;
        // Both books, in the same breath as always. The per-token sum holds this maker's row and
        // every other maker's row of the same token, so it cannot wrap.
        _totalParked[token] -= amount;

        IERC20(token).safeTransfer(msg.sender, amount);
        emit Unparked(msg.sender, token, amount);
    }

    /**
     * @notice Book the part of a token's balance that nothing claims under the stray config.
     * @param token the asset to sweep. Any token; nothing has to be escrowed for this to work.
     * @return swept what was booked. Zero, and no event, when there is nothing unowned.
     *
     * Tokens arrive here that no intent put here: a plain `transfer` where the sender meant
     * `deposit`, an airdrop, a token that rebases up under a funded escrow. This reclassifies
     * them: no token moves. They become a booked fee under `STRAY_CONFIG`, and `claim` pays them.
     *
     * **Anyone may call it, and it can only ever book into the stray config.** The caller
     * chooses the timing and nothing else; the books decide the amount, so no caller can reach a
     * wei that a reservation, a booked fee or a maker's parked capital claims.
     *
     * **Three books are subtracted:** `_totalReserved` (escrow), `_totalPendingFees` (fees,
     * including reservations not yet pulled) and `_totalParked`. Read `_reserve`, `claim`,
     * `park` and `withdrawParked` before you change this subtraction.
     *
     * **A rebasing token's gain is booked to the stray config rather than to the maker whose
     * tokens grew. That is deliberate and it is not a fee.** See `_reserved`.
     *
     * **A rebase down is why this returns zero instead of reverting.** The balance falls under
     * the book, there is nothing unowned, and a keeper walking a list of tokens must not lose
     * the whole list to one of them.
     */
    function sweepUnowned(address token) external nonReentrant returns (uint256 swept) {
        uint256 held = IERC20(token).balanceOf(address(this));
        uint256 booked = _totalReserved[token] + _totalPendingFees[token] + _totalParked[token];
        if (held <= booked) return 0;

        swept = held - booked;
        bytes32 stray = STRAY_CONFIG;
        _pendingFees[stray][token] += swept;
        _totalPendingFees[token] += swept;
        emit Swept(token, stray, swept);
    }

    // ── Fees ─────────────────────────────────────────────────────────────────

    /// @notice What is booked under this fee config in this token and has not been claimed. After
    ///         any transaction it is all backed by tokens held here; inside a fill it can be ahead
    ///         of them (spec 2.10.4), so do not read it from a token hook in the middle of one.
    function pendingFees(bytes32 feeConfig, address token) external view returns (uint256) {
        return _pendingFees[feeConfig][token];
    }

    /// @notice Every config's book in this token, added up. The contract's balance less this,
    ///         less `totalReserved` and less `totalParked` is what `sweepUnowned` may book.
    function totalPendingFees(address token) external view returns (uint256) {
        return _totalPendingFees[token];
    }

    /**
     * @notice Pay a fee config's booked fees in one token to its destinations, by weight.
     * @param cfg the preimage of the config whose book to empty; its hash is the book's key.
     * @param token the asset to pay in.
     * @return paid what reached destinations. Zero, and no event, when the book is empty.
     *
     * **Anybody may call it, and it always pays the config's destinations.** `msg.sender`
     * decides nothing: the hash names the book and the weights split it.
     *
     * One destination: a plain transfer with all the gas; a failure reverts the call and the
     * book is untouched. Several: each non-zero share is a transfer capped at `TRANSFER_GAS`,
     * and a share that fails is re-booked under that destination's one-destination config
     * (`FeeConfig.singleHash`) and emitted as `ShareDeferred`: a destination can never block the
     * others, and a caller cannot fake a failure by under-supplying gas (`InsufficientGas`).
     * `paid + deferred` is the cell's amount, always: no dust stays in the book.
     *
     * The cell is zeroed before any transfer and `nonReentrant` is held throughout.
     */
    function claim(FeeConfig.Config calldata cfg, address token)
        external
        nonReentrant
        returns (uint256 paid)
    {
        if (token.code.length == 0) revert BadParameter();
        return FeeClaimLib.pay(_pendingFees, _totalPendingFees, cfg, token, relayer);
    }

    /**
     * @notice Say what a config contains, in the log. A courtesy for indexers and claim keepers,
     *         not a gate: a fill and a claim never check that a config was announced, and an
     *         unannounced config is just as valid. Reverts on a config that is not canonical.
     */
    function announceFeeConfig(FeeConfig.Config calldata cfg) external {
        FeeClaimLib.announce(cfg);
    }

    // ── Cancelling ───────────────────────────────────────────────────────────

    /**
     * @notice Stop this intent being filled.
     *
     * It bites on the block it lands, on every custody mode. A funded escrow intent used to defer
     * for one cooldown, to protect an executor who had already committed capital; `withdraw`
     * explains why that protection is gone.
     *
     * A maker in escrow custody does not need this: `withdraw` ends the offer as it returns the
     * money, because an intent is armed by its deposit and undoing that undoes the offer.
     */
    function cancel(Intent calldata i) external {
        if (msg.sender != i.maker) revert NotMaker();
        bytes32 h = hashIntent(i);
        cancelledAt[h] = uint64(block.timestamp);
        emit Cancelled(h, i.maker);
    }

    /**
     * @notice Kill every intent of this maker below `floor`, in `floor`'s own lane, in one
     *         transaction.
     * @param floor a nonce, read the way every nonce here is read: its high 192 bits name the
     *        lane and its low 64 name the position this maker stops honouring at. Pass
     *        `deadNonce + 1` and the right lane is chosen for you.
     *
     * **One word retires one lane and spares every other**, which is the whole of #131. A maker
     * who groups their signatures by lane when they sign gets selective bulk revocation with no
     * preimage at all — the thing neither `cancel`, which needs the full intent, nor a multicall
     * over `cancel`, which needs one preimage per signature, can give them.
     *
     * **The argument is in nonce space, not a lane and a position side by side.** One word
     * keeps the selector this contract has always had, so nothing that already calls it has to
     * change, and it means a maker never has to split their own nonce to retire it. The price
     * is that `invalidateBefore(type(uint256).max)` no longer retires everything: it retires the
     * top lane, because that is the lane that nonce is in. Every nonce in the wild is in lane 0.
     *
     * Immediate, like `cancel`. Escrowed funds are not released by this — they are still the
     * maker's to `withdraw`, and `park` now takes a floor-killed intent too — it only stops the
     * signatures being spendable.
     *
     * Monotonic per lane, not across lanes. A lane's floor may only rise, so a signature this
     * kills can never come back; a lane nobody has touched still starts at zero, whatever the
     * maker did to its neighbours.
     */
    function invalidateBefore(uint256 floor) external {
        uint192 lane = uint192(floor >> 64);
        uint64 position = uint64(floor);
        if (position <= _laneFloor[msg.sender][lane]) revert BadParameter();
        _laneFloor[msg.sender][lane] = position;
        emit NoncesInvalidated(msg.sender, floor);
    }

    // ── Filling ──────────────────────────────────────────────────────────────

    /**
     * @notice Fill one intent.
     * @param maxFeeRate the highest rate whose destination this caller will engage with. The
     *        fee comes out of the maker's number, so the rate costs the caller nothing and this
     *        is not a bound on their outlay. It is a bound on what a fill touches: a fee is
     *        pulled in `tokenOut` and booked against an address the maker chose, and a caller
     *        who wants no part of that passes zero and skips every leg that names anywhere.
     */
    function fill(Intent calldata i, bytes calldata signature, uint256 take, uint256 maxFeeRate)
        external
        nonReentrant
    {
        _settle(i, signature, take, _hash(i, domainSeparator()), maxFeeRate);
    }

    /**
     * @notice Fill several intents in one transaction.
     * @param skipInvalid when true, an intent that is expired, cancelled, already filled or
     *        otherwise unfillable is stepped over instead of reverting the batch. Losing a race
     *        for one intent should not cost an executor the rest of them.
     * @param maxFeeRate the highest `feeRate` this caller will pay, as in `fill`.
     *
     * `skipInvalid` steps over the reasons in `Reason` and nothing else. A token still decides
     * what its own `transferFrom` does, and a token that reverts there takes the batch with it,
     * because a revert is not a reason. The probes below are metered so a token cannot burn the
     * budget, but an executor still needs a token allowlist.
     *
     * @dev The batch is where the gas goes. Two things are amortised across it: the intent hash
     *      is computed once and carried through validation and settlement, and fees accumulate in
     *      memory and are paid in as few transfers as the leg order allows. Twenty legs that pay
     *      the same destination in the same token cost one transfer, not twenty. Legs that charge
     *      no fee cost none at all.
     */
    function fillBatch(FillRequest[] calldata reqs, bool skipInvalid, uint256 maxFeeRate)
        external
        nonReentrant
        returns (uint256 count)
    {
        bytes32 ds = domainSeparator();
        Ledger memory l = _ledger(2 * reqs.length);

        for (uint256 k = 0; k < reqs.length; k++) {
            if (_fillOne(reqs[k], ds, maxFeeRate, skipInvalid, l)) {
                unchecked {
                    count++;
                }
            }
        }

        _settleLedger(l);
    }

    /**
     * @notice Fill several intents on credit: every release first, one callback, then every
     *         payment. A ring of intents that pay for each other needs no inventory this way.
     * @param skipInvalid as in `fillBatch`.
     * @param data handed back to the caller untouched.
     * @param maxFeeRate the highest `feeRate` this caller will pay, as in `fill`.
     *
     * The capital efficiency is in the ordering, not the callback. Every leg's token A reaches
     * the caller before any maker is paid, so the token one maker sells funds the next maker's
     * payment. The callback is only the caller's chance to swap or route in the middle.
     *
     * @dev The contract pulls; it does not measure. Every payment here is a directed
     *      `safeTransferFrom` from `msg.sender` after the callback returns, so a donation cannot
     *      discharge a debt, two legs paying one recipient are two transfers, and the release
     *      cannot be mistaken for a payment. A balance-delta check would fail all three, and
     *      UniswapX's audit rejected exactly that for exactly this architecture.
     *
     *      The callback target is `msg.sender`, never a named address. Releasing a maker's tokens
     *      to an address the caller merely names is wider than the trade needs, and the fixed
     *      `proveBatchCallback` selector is what keeps this call site inside the rule in the
     *      header: the caller's `data` rides inside that frame as an argument, never as a call.
     */
    function fillBatchWithCallback(
        FillRequest[] calldata reqs,
        bool skipInvalid,
        bytes calldata data,
        uint256 maxFeeRate
    ) external nonReentrant callableTarget returns (uint256 count) {
        // One line per leg. Sized for the whole request and shrunk below, because a skipped leg
        // must not leave a zeroed hole the caller would have to read past.
        IProveBatchCallback.Payment[] memory owed = new IProveBatchCallback.Payment[](reqs.length);

        bytes32 ds = domainSeparator();
        Ledger memory l = _ledger(2 * reqs.length);
        for (uint256 k = 0; k < reqs.length; k++) {
            if (_creditLeg(reqs[k], ds, maxFeeRate, skipInvalid, owed, count, l)) {
                // Which request this line came from, written here because this is the one place
                // where both indices are in scope and the difference between them is visible.
                // `count` is where the line sits after compaction; `k` is where the caller put
                // the request. They part company the moment `skipInvalid` steps a leg over, and
                // a callback that plans per leg needs the second one to align its plan to what
                // actually settled. Passing it down through `_creditLeg` would cost a parameter
                // on a frame that already overflows the legacy pipeline's stack under coverage.
                owed[count].leg = k;
                unchecked {
                    count++;
                }
            }
        }

        // Narrow to the legs that survived. A skipped leg must not leave a zeroed hole the
        // callback has to read past, and the array was sized for the whole request. Nothing is
        // copied unless a leg was actually skipped, so the ordinary batch pays for none of this.
        IProveBatchCallback.Payment[] memory lines = owed;
        if (count != reqs.length) {
            lines = new IProveBatchCallback.Payment[](count);
            for (uint256 k = 0; k < count; k++) {
                lines[k] = owed[k];
            }
        }

        IProveBatchCallback(msg.sender).proveBatchCallback(lines, data);

        _collect(lines, count, l);
    }

    /**
     * @dev One leg of a credit batch: validate it, book it, release token A, and write down what
     *      the caller will owe for it. Nothing is paid here — that is the whole point of the
     *      ordering — so the leg is recorded rather than settled.
     *
     * `Filled` is emitted here, before the payment it describes. Within one transaction that
     * ordering carries no meaning: the pull in `_collect` reverts the whole call if it fails, so
     * an observer never sees the event without the transfer. Its own frame, for the reason
     * `_fillOne` gives.
     */
    function _creditLeg(
        FillRequest calldata req,
        bytes32 ds,
        uint256 maxFeeRate,
        bool skipInvalid,
        IProveBatchCallback.Payment[] memory owed,
        uint256 slot,
        Ledger memory l
    ) private returns (bool) {
        Intent calldata i = req.intent;
        bytes32 h = _hash(i, ds);

        (Reason r, uint256 booked) =
            _evaluate(i, req.signature, req.take, msg.sender, h, skipInvalid, maxFeeRate);

        // A leg nobody asked to arm costs one calldata read. `Ok` is armable too, and has to
        // be: `deep` is false when `skipInvalid` is, so a permit leg with no allowance reads
        // `Ok` here and would fail in the transfer instead.
        if (req.arming.length != 0 && (r == Reason.Ok || r == Reason.EscrowShort)) {
            (r, booked) = _arm(req, h, maxFeeRate, r, booked);
        }

        if (r != Reason.Ok) {
            if (skipInvalid) return false;
            _revert(r);
        }

        filled[h] = booked + req.take;
        _recordLeg(i, h, req.take, owed, slot, l);
        return true;
    }

    /// @dev Price one leg, release its token A, and write down what the caller will owe for it.
    ///      Its own frame, for the reason `_fillOne` gives: inline, the `Filled` arguments and
    ///      this function's locals together overflow the legacy pipeline's stack the moment
    ///      `forge coverage` adds its branch counters.
    function _recordLeg(
        Intent calldata i,
        bytes32 h,
        uint256 take,
        IProveBatchCallback.Payment[] memory owed,
        uint256 slot,
        Ledger memory l
    ) private {
        TakePoints.Quote memory q = _quote(i, take, block.timestamp);

        _release(i, h, take, q.feeIn, msg.sender, l);
        _sayFilled(i, h, q);

        // `leg` is written by the loop in `fillBatchWithCallback`, where the request index and
        // the compacted index are both in scope: those are different numbers the moment a leg is
        // skipped.
        owed[slot] = TakePoints.payment(q, _ctx(i), i.recipient, 0);
    }

    /// @dev Reserve P2 and P3 for every line, pay each recipient, then settle the ledger: one
    ///      pull per token for the whole call, `fillBatch`'s own flush. Its own frame, for the stack.
    function _collect(IProveBatchCallback.Payment[] memory owed, uint256 count, Ledger memory l)
        private
    {
        for (uint256 k = 0; k < count; k++) {
            IProveBatchCallback.Payment memory p = owed[k];
            _reserve(p.feeConfig, p.token, p.fee + p.feeProceeds, l, true);
            _deliverTo(p.token, p.to, p.amount - p.feeProceeds);
        }

        _settleLedger(l);
    }

    /**
     * @dev One leg of a batch: validate it, book it, release token A, pay the maker, and add the
     *      fee to the run the loop is carrying. Nothing is transferred to a fee destination
     *      here, so legs that share an output token can settle their fees in one transfer.
     *
     * False means the leg was stepped over, which only `skipInvalid` allows.
     *
     * The separate frame is the point as much as the tidiness. Inline, this loop holds enough
     * live locals that the legacy pipeline runs out of stack the moment `forge coverage` adds its
     * branch counters. Coverage then has to be read through `--ir-minimum`, where the counters
     * anchor to instructions the optimizer moves off the executed path and report zero for lines
     * that plainly run.
     */
    function _fillOne(
        FillRequest calldata req,
        bytes32 ds,
        uint256 maxFeeRate,
        bool skipInvalid,
        Ledger memory l
    ) private returns (bool) {
        Intent calldata i = req.intent;
        bytes32 h = _hash(i, ds);

        (Reason r, uint256 booked) =
            _evaluate(i, req.signature, req.take, msg.sender, h, skipInvalid, maxFeeRate);

        // A leg nobody asked to arm costs one calldata read. `Ok` is armable too, and has to
        // be: `deep` is false when `skipInvalid` is, so a permit leg with no allowance reads
        // `Ok` here and would fail in the transfer instead.
        if (req.arming.length != 0 && (r == Reason.Ok || r == Reason.EscrowShort)) {
            (r, booked) = _arm(req, h, maxFeeRate, r, booked);
        }

        if (r != Reason.Ok) {
            if (skipInvalid) return false;
            _revert(r);
        }

        filled[h] = booked + req.take;
        _settleLeg(i, h, req.take, l);
        return true;
    }

    /// @dev Price one leg, release its token A (P1), reserve P2 and P3, pay its maker, and say
    ///      so. Nothing for fees moves here: the ledger settles them at the end of the call.
    ///      Its own frame, for the reason `_fillOne` gives.
    function _settleLeg(Intent calldata i, bytes32 h, uint256 take, Ledger memory l) private {
        TakePoints.Quote memory q = _quote(i, take, block.timestamp);

        _release(i, h, take, q.feeIn, msg.sender, l);
        _reserveOut(i, q, l);
        _deliverTo(i.tokenOut, i.recipient, q.delivered);
        _sayFilled(i, h, q);
    }

    /// @dev P2 and P3: both reserved in the one `[feeConfig][tokenOut]` cell, before the
    ///      intent's delivery. The solver owes them at the flush.
    function _reserveOut(Intent calldata i, TakePoints.Quote memory q, Ledger memory l) private {
        _reserve(i.feeConfig, i.tokenOut, q.feeOut + q.feeProceeds, l, true);
    }

    /// @dev The one place `Filled` is announced, and `FeesTaken` after it when anything was
    ///      reserved. `delivered` is what the recipient was paid (`owedToMaker - feeProceeds`)
    ///      and `fee` is P2 only; the executor's whole outlay is `delivered + feeProceeds + fee`.
    ///
    ///      Its own frame for the stack.
    function _sayFilled(Intent calldata i, bytes32 h, TakePoints.Quote memory q) private {
        emit Filled(h, i.maker, msg.sender, i.tokenIn, i.tokenOut, q.take, q.delivered, q.feeOut);
        if (q.feeIn | q.feeOut | q.feeProceeds != 0) {
            emit FeesTaken(h, i.feeConfig, q.feeIn, q.feeOut, q.feeProceeds);
        }
    }

    /**
     * @notice Fill without holding token B first. The contract hands token A to the caller, calls
     *         the caller back, and then pulls token B out of it.
     *
     * @dev **The contract pulls; it does not measure.** An earlier version proved payment by
     *      snapshotting the recipient and the sink and checking the deltas after the callback.
     *      A delta proves the balance rose, not that the executor caused it. It reads a donation
     *      as a payment, it lets one payee's two debts share one measurement, and it counts every
     *      transfer inside the window whoever sent it — the maker's own release included.
     *      OpenZeppelin rejected the same instrument for this architecture in their UniswapX
     *      audit, and UniswapX and 1inch both make a directed transfer instead. So do
     *      `_deliverTo` and `_reserve`: payment is a thing this contract does, never a thing it
     *      infers.
     *
     *      The balance read inside `_deliverTo` is a **fee-on-transfer guard**, not a payment
     *      check. It brackets one forced transfer and catches a token that taxes it. Do not
     *      delete it as a leftover of the delta design.
     *
     *      `SinkIsRecipient` used to guard this path. It is gone. It existed because a delta
     *      cannot tell the delivery from the fee when the fee destination and the recipient share
     *      an address, so one measurement discharged two debts. Two directed pulls cannot make
     *      that mistake, and `fill` never needed the guard for the same reason.
     *
     *      **The caller is the callback target.** Uniswap V3 `flash`, V4 `unlock` and UniswapX
     *      `reactorCallback` all call `msg.sender`, which is why none of them needs an
     *      ERC-3156-style acceptance value. Releasing a maker's token A to an address the caller
     *      merely names is a wider surface than the trade needs.
     *
     *      **The rule this call site keeps:** the contract may call an address it did not choose
     *      only through a selector it did choose. The executor's `data` rides inside the
     *      `proveCallback` frame as an argument and never becomes the selector, so no allowance
     *      granted to this contract is reachable through here.
     *      `test_TheFixedSelectorIsTheOnlyThingProtectingTheCallbackPath` asserts it.
     *
     *      One shape this path cannot settle: a recipient that is the caller. The pull becomes a
     *      self-transfer, which moves no balance, and the fee-on-transfer guard reads that as a
     *      short delivery. `fill` and `fillBatch` behave the same way.
     */
    function fillWithCallback(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        bytes calldata data,
        uint256 maxFeeRate
    ) external nonReentrant callableTarget {
        bytes32 h = _hash(i, domainSeparator());
        filled[h] = _mustBeFillable(i, signature, take, msg.sender, h, maxFeeRate) + take;
        _settleViaCallback(i, h, take, data);
    }

    /// @dev The callback path's settlement, in its own frame: release, call, pull. See
    ///      `fillWithCallback` for why each step is where it is.
    function _settleViaCallback(Intent calldata i, bytes32 h, uint256 take, bytes calldata data)
        private
    {
        TakePoints.Quote memory q = _quote(i, take, block.timestamp);
        Ledger memory l = _ledger(2);

        _release(i, h, take, q.feeIn, msg.sender, l);
        // The solver is told every number of the fill (`Terms`), and its whole tokenOut debt is
        // `owed = owedToMaker + feeOut`: a sum, not `delivered`. Nothing for fees moves in this
        // window; the ledger settles them after the delivery.
        IProveCallback(msg.sender).proveCallback(msg.sender, TakePoints.terms(q, _ctx(i)), data);
        _reserveOut(i, q, l);
        _deliverTo(i.tokenOut, i.recipient, q.delivered);
        _sayFilled(i, h, q);
        _settleLedger(l);
    }

    /**
     * @notice Grant the relayer's allowance from the maker's signature, then fill. The maker
     *         signed twice and sent nothing.
     *
     * The gasless path for the tokens that cannot do the other one. EIP-3009 is the stronger
     * signature and almost nothing implements it; EIP-2612 is weaker and nearly everything does.
     * This is the approval rung with the transaction taken out, not a new kind of custody: it sets
     * an allowance, so the tokens stay in the maker's wallet and the maker may still spend or
     * revoke them — and revoking leaves the signature alive, ready for the next time they approve
     * that token. Nothing about it earns the escrow rung's guarantees.
     *
     * @dev **A door, not a second implementation.** `fillBatch` can arm a leg of its own since
     *      `FillRequest.arming`, so this could have been deleted as a one-leg batch. It is here
     *      because a batch of one pays for an array, a loop and a fee run it cannot use, and
     *      because the rules it runs are `_armLeg`'s, not its own — the same code the batch runs,
     *      reached through a cheaper door. The pre-flight that used to live here is gone.
     *
     *      The spender is the relayer. Rule 3 has no exception, and permitting this contract
     *      instead would grant an allowance to the address that calls strangers.
     */
    function fillWithPermit(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        Permit calldata p,
        uint256 maxFeeRate
    ) external nonReentrant {
        // Escrow is funded by a deposit or an authorization and permit2 by a Permit2 signature,
        // never by an allowance. Accepting either flag here would let an intent wear a stronger
        // rung on a permit's strength. They are the same flags `_armLeg` reads to pick its arm,
        // so the two cannot disagree about which signature these bytes hold.
        if (i.flags & FLAGS_CUSTODIED != 0) revert BadParameter();

        bytes32 h = _hash(i, domainSeparator());
        _book(i, h, take, _armLeg(i, signature, take, msg.sender, h, maxFeeRate, abi.encode(p)));
    }

    /**
     * @notice Redeem an EIP-3009 authorization into the maker's escrow, then fill from it. This
     *         is the gasless path: the maker signed twice and sent nothing.
     *
     * @dev A door onto `_armLeg`, like `fillWithPermit`, and here for the same two reasons: a
     *      batch of one pays for machinery one leg cannot use, and the rules are the batch's own.
     */
    function fillWithAuthorization(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        Authorization calldata auth,
        uint256 maxFeeRate
    ) external nonReentrant {
        if (i.flags & FLAG_ESCROW == 0) revert BadParameter();

        bytes32 h = _hash(i, domainSeparator());

        /*
         * Look before pulling. Redeeming an authorization for an intent that is expired, called
         * off, or below the maker's nonce floor costs an `ecrecover` and a token transfer, and
         * `_armLeg` then throws all of it away. Worse, the token often fails first — a stale
         * `validBefore`, a spent nonce — so the caller reads the token's error and never learns
         * that the intent itself is dead.
         *
         * `EscrowShort` is the one reason to carry on: it is what an unfunded reservation looks
         * like, and funding it is this function's whole job. `_evaluate` returns it before it
         * spends an `ecrecover` on the maker's signature, so the happy path pays for no
         * duplicated work — every slot the second pass reads is warm by then.
         *
         * A batch needs no such look: it holds the reason it already had and steps over the leg.
         */
        (Reason r,) = _evaluate(i, signature, take, msg.sender, h, false, maxFeeRate);
        if (r != Reason.Ok && r != Reason.EscrowShort) _revert(r);

        _book(i, h, take, _armLeg(i, signature, take, msg.sender, h, maxFeeRate, abi.encode(auth)));
    }

    /**
     * @notice Spend one Permit2 signature into this intent's reservation, then fill from it. The
     *         maker signed twice, sent nothing, and holds no allowance to anything of ours.
     *
     * The rung that outlives us. The maker's only standing grant is `approve(Permit2, max)` on
     * the token, and Permit2's address is the same on every chain and moves for nobody — so a
     * settlement redeploy costs a maker on this rung nothing at all, where every other wallet
     * rung costs them a fresh approval to a fresh relayer.
     *
     * @dev A door onto `_armLeg`, like `fillWithPermit` and `fillWithAuthorization`, and here for
     *      the same two reasons: a batch of one pays for an array, a loop and a fee run it cannot
     *      use, and the rules it runs are the batch's own.
     *
     *      The pre-flight is `fillWithAuthorization`'s, and it is here for that function's
     *      reason. Spending a Permit2 nonce for an intent that is expired, called off or below
     *      the maker's nonce floor burns a signature the maker cannot get back, and Permit2 often
     *      fails first — a past deadline, a nonce already spent — so the caller reads Permit2's
     *      error and never learns that the intent itself was dead. `EscrowShort` is the one
     *      reason to carry on: it is what an unfunded reservation looks like, and funding it is
     *      this function's whole job.
     */
    function fillWithPermit2(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        Permit2Transfer calldata p,
        uint256 maxFeeRate
    ) external nonReentrant {
        if (i.flags & FLAG_PERMIT2 == 0) revert BadParameter();

        bytes32 h = _hash(i, domainSeparator());

        (Reason r,) = _evaluate(i, signature, take, msg.sender, h, false, maxFeeRate);
        if (r != Reason.Ok && r != Reason.EscrowShort) _revert(r);

        _book(i, h, take, _armLeg(i, signature, take, msg.sender, h, maxFeeRate, abi.encode(p)));
    }

    /// @dev Pull the maker's whole `amountIn` into the reservation this authorization names.
    ///      Its own frame, so `_redeemInto` keeps a shallow stack.
    function _redeem(Intent calldata i, bytes32 h, Authorization memory auth) private {
        uint256 before = _held(i.tokenIn);
        _receive(i, auth);
        uint256 received = _held(i.tokenIn) - before;
        _reserved[h] += received;
        _totalReserved[i.tokenIn] += received;
        emit Deposited(h, i.maker, i.tokenIn, received);
    }

    /**
     * @dev Ask the token for the maker's `amountIn`, through whichever overload the signature
     *      fits. This is the only place a maker's authorization is spent.
     *
     * `receiveWithAuthorization`, never `transferWithAuthorization`. The latter is a
     * permissionless relay: the maker's signature names this contract as the recipient, so
     * anybody holding a copy of the signed intent — and the board hands those out — could push
     * the tokens straight to the token contract, bypassing this function entirely. The money
     * would land with nothing credited to `_reserved[h]`, `withdraw` would refuse it as an empty
     * reservation, and the authorization nonce would be spent. The maker would lose the lot, for
     * the price of the attacker's gas. EIP-3009 added this variant to close exactly that, by
     * requiring `to == msg.sender`.
     *
     * **Which overload, and why in this order.** ERC-7598 adds a `bytes` signature to ERC-3009 so
     * an ERC-1271 wallet can authorize a transfer it has no key to sign. The length picks the
     * call, mirroring the rule `_validSignature` already runs on the intent's own signature:
     *
     *   - 65 bytes is what an ordinary key produces, so try the `v, r, s` overload first. Almost
     *     every deployed 3009 token has only that one, and a token that has both charges nothing
     *     extra for being asked the old way.
     *   - A 65-byte signature can also be a contract wallet's answer, and that wallet's token
     *     will reject it under `ecrecover`. So a revert there falls through to the 7598 overload
     *     rather than ending the redemption.
     *   - Any other length cannot be `v, r, s` at all, so it goes straight to 7598.
     *
     * The fall-through costs a failed call on a token that has both overloads and a maker who
     * signs through a contract. It buys the case being wrong never costing a fill, which the
     * length alone cannot decide.
     */
    function _receive(Intent calldata i, Authorization memory auth) private {
        if (auth.signature.length == 65) {
            (uint8 v, bytes32 r, bytes32 s) = _split(auth.signature);
            try IERC3009(i.tokenIn)
                .receiveWithAuthorization(
                    i.maker,
                    address(this),
                    i.amountIn,
                    auth.validAfter,
                    auth.validBefore,
                    auth.nonce,
                    v,
                    r,
                    s
                ) {
                return;
            } catch {}
        }
        IERC3009(i.tokenIn)
            .receiveWithAuthorization(
                i.maker,
                address(this),
                i.amountIn,
                auth.validAfter,
                auth.validBefore,
                auth.nonce,
                auth.signature
            );
    }

    /**
     * @dev A 65-byte signature as the three arguments the legacy overload wants.
     *
     * Three words where sixty-five bytes were. `abi.decode` reads a `bytes32` as the raw word
     * with nothing to validate and nothing to fail on, so padding the signature out to
     * ninety-six bytes lays `r`, `s` and `v` down one per word. The caller has already checked
     * the length.
     *
     * No assembly. `_probe` is the only Yul in this file and it earns its place on gas measured
     * against a return bomb; this runs once per redemption, beside a token transfer, and would
     * be saving tens of gas out of tens of thousands.
     */
    function _split(bytes memory signature) private pure returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 word;
        (r, s, word) = abi.decode(bytes.concat(signature, bytes31(0)), (bytes32, bytes32, bytes32));
        v = uint8(word[0]);
    }

    /**
     * @notice `_armLeg` in a frame of its own. Only this contract calls it, and only a batch
     *         needs it.
     *
     * The frame is the whole reason this is external. `try this.armLeg(...)` puts the permit or
     * the redemption in a sub-call, so a leg that cannot be armed reverts its own journal and
     * nothing survives it — not the maker's spent nonce, not the tokens a redemption moved. The
     * batch then steps over the leg, or reverts on the reason it already had, exactly as it
     * would for a leg nobody asked to arm.
     *
     * That is what stops a griefing loop. Sign an intent and an authorization on a token that
     * takes a cut on transfer, post it, and every solver who rings it up loses a batch. Because
     * the failure reverts, the nonce survives, so the same bait works for ever. Inside this
     * frame it costs the solver one failed sub-call instead.
     *
     * `fillWithPermit` and `fillWithAuthorization` reach the same work through `_armLeg` and
     * take no frame: a single fill has nothing to step over, so a revert is the right answer and
     * the frame would only cost the caller the reason.
     *
     * @dev The re-evaluation is the whole intent, not just its funding, and that is not
     *      belt-and-braces. `_evaluate` reads a maker's funds *before* their signature, so a leg
     *      can come back `EscrowShort` while its signature is worthless — and arming that leg
     *      would spend a real authorization on an intent which can never fill. Deep, because the
     *      allowance probe is what proves a permit actually landed.
     *
     *      `nonReentrant` is held by the fill that called us, so `_entered` is 2 for the whole
     *      of this and nothing can re-enter through it. `dryRun` calls this without that guard
     *      and needs none: it reverts on the way out, so a token that calls back in has every
     *      bit of what it did unwound with the rest.
     */
    function armLeg(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        address executor,
        bytes32 h,
        uint256 maxFeeRate,
        bytes calldata arming
    ) external returns (uint256 booked) {
        if (msg.sender != address(this)) revert ForbiddenTarget();
        return _armLeg(i, signature, take, executor, h, maxFeeRate, arming);
    }

    /**
     * @dev Reach one maker's funds, then prove the leg fills. The one implementation of the
     *      arming rules; three entry points reach it and none of them repeats it.
     *
     * The custody flags pick the arm, and they are the same flags `fillWithPermit`,
     * `fillWithAuthorization` and `fillWithPermit2` guard at their own doors — so a permit can
     * never fund an escrow, an authorization can never arm a wallet intent, and neither can be
     * mistaken for a Permit2 signature, whichever way the caller came in. `_termsOk` refuses an
     * intent that sets two of the flags, so the order of these branches decides nothing.
     *
     * **The re-evaluation is the whole intent, not just its funding, and that is not
     * belt-and-braces.** `_evaluate` reads a maker's funds *before* their signature, so a leg can
     * come back `EscrowShort` while its signature is worthless — and arming that leg would spend
     * a real authorization on an intent which can never fill. Deep, because the allowance probe
     * is what proves a permit actually landed.
     *
     * **It reverts with the reason rather than a flat "arming failed".** `_arm` discards it — the
     * leg keeps the reason it already had, which is the point of that catch — so the specific
     * revert costs a batch nothing. It is worth everything to a single fill, where an intent that
     * expired says `Expired` instead of leaving the caller to guess.
     *
     * `nonReentrant` is held by whichever fill called us, so `_entered` is 2 for the whole of
     * this and nothing can re-enter through it.
     */
    function _armLeg(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        address executor,
        bytes32 h,
        uint256 maxFeeRate,
        bytes memory arming
    ) private returns (uint256 booked) {
        if (i.flags & FLAG_PERMIT2 != 0) {
            _pullPermit2In(i, h, take, arming);
        } else if (i.flags & FLAG_ESCROW != 0) {
            _redeemInto(i, h, take, arming);
        } else {
            _grantAllowance(i, take, arming);
        }

        Reason r;
        (r, booked) = _evaluate(i, signature, take, executor, h, true, maxFeeRate);
        if (r != Reason.Ok) _revert(r);
    }

    /**
     * @dev The escrow arm of `_armLeg`, and it has two sources: an EIP-3009 authorization, or
     *      the maker's own parked capital.
     *
     * Its own frame, so each arm is a call the coverage build can see rather than a fall-through
     * the optimizer is free to move.
     *
     * **One word asks for the parked source, and an authorization can never be one word.**
     * `Authorization` is a struct with a dynamic member, so `abi.encode` of one is at least 192
     * bytes. The length settles which of the two these bytes are before anything is decoded, and
     * a word that is not `ARM_FROM_PARKED` is refused here — a caller who guessed reads
     * `BadTerms` rather than a decode failing somewhere they cannot act on.
     *
     * **Only this rung, and the omission is deliberate.** A permit2 leg reaches `_pullPermit2In`
     * and gains nothing here. That maker signed once and sent nothing, so a fresh Permit2
     * signature already arms them at no cost, while escrow is the rung whose only refill route
     * was a maker transaction. Adding the source to permit2 would spend `FLAG_ESCROW`'s hazard a
     * second time for no new capability.
     */
    function _redeemInto(Intent calldata i, bytes32 h, uint256 take, bytes memory arming) private {
        if (arming.length == 32) {
            if (abi.decode(arming, (bytes32)) != ARM_FROM_PARKED) revert BadTerms();
            _drawFromParked(i, h, take);
            return;
        }

        Authorization memory auth = abi.decode(arming, (Authorization));
        /*
         * The intent says which 3009 nonce funds it, and nothing else will do. Without this one
         * check a single authorization would arm every same-size intent the maker ever signed,
         * and calling off the intent it was meant for would not revoke it.
         *
         * A maker who names none gets the intent's own hash, which welds one authorization to
         * one intent and is what every intent used to be given. A maker who names one is asking
         * for the opposite: siblings sharing a nonce are mutually exclusive, because the token
         * spends that nonce once. `Intent.authNonce` carries the argument for both.
         */
        bytes32 expected = i.authNonce == bytes32(0) ? h : i.authNonce;
        if (auth.nonce != expected) revert BadTerms();
        // Redeeming is idempotent from our side: a second attempt reverts inside the token, so
        // we only redeem when the reservation cannot already cover the fill.
        if (_reserved[h] < take) _redeem(i, h, auth);
    }

    /**
     * @dev The parked source of the escrow arm: fund this leg from the maker's own capital.
     *
     * The maker signed the intent being filled, so moving their dead capital into it is doing
     * what they asked. Every key this reads comes out of that signature: `i.maker` says whose
     * money, `i.tokenIn` says which asset, and neither is a hash whose owner somebody has to
     * establish or an address a caller supplied. There is nothing here to authorise, which is
     * why there is no check to forget.
     *
     * **The shortfall, never the pot.** A solver must not be able to sweep a maker's whole
     * parked capital into one hash on a one-wei fill — the money would still be the maker's and
     * still recoverable, but it would be locked behind an offer the solver chose while every
     * other offer of theirs starved. `take` is what the leg spends and `take` is the ceiling, so
     * a fill moves exactly what it consumes and the release takes it straight back out.
     *
     * Four writes, two pairs. `_parked` moves with `_totalParked` and `_reserved` with
     * `_totalReserved`, each pair by the same amount in the next statement, for the reason every
     * other site in this contract does it: `sweepUnowned` reads the totals, and a total that
     * drifts from its map pays somebody's money to the stray config. Here the two per-token
     * sums move in opposite directions by the same amount, so the number the sweep computes
     * does not change at all.
     *
     * It emits `Deposited`, as `_redeem` and `_pullPermit2` do, because what happened is that a
     * reservation was credited. No token moved, and that event's own doc says so.
     */
    function _drawFromParked(Intent calldata i, bytes32 h, uint256 take) private {
        /*
         * An offer welded to its siblings cannot be funded this way, and the invariant campaign
         * is what found it.
         *
         * `authNonce` has one purpose when a maker sets it, and `_redeemInto` states it: two
         * offers naming one nonce are mutually exclusive, because the token spends that nonce
         * once. It is how a maker posts one lot at two prices. This source spends no nonce, so
         * without this line it funds both of them — and it is the maker's own capital doing it,
         * so nothing else in the contract would notice.
         * `invariant_TwoOffersSharingAnAuthorizationNeverBothFill` found that inside one
         * campaign, and it is the only place the exclusion argument was false.
         *
         * A maker who leaves the field zero is welded to their own intent hash and has no
         * sibling to protect, which is every intent that does not opt in.
         */
        if (i.authNonce != bytes32(0)) revert BadTerms();

        uint256 have = _reserved[h];
        // Already covered, so there is nothing to fund. `_armLeg` runs on a leg that read `Ok`
        // as readily as on one that read `EscrowShort`, and a solver may ask to arm either.
        if (have >= take) return;

        uint256 want = take - have;
        uint256 pot = _parked[i.maker][i.tokenIn];
        // Nothing parked, or not enough of it, and all of it or none. A part that cannot cover
        // the leg buys nothing — the re-evaluation refuses the leg either way and the frame
        // unwinds the move — so this spends no gas writing four slots to reach the same answer.
        // `EscrowShort` on an armable leg has always meant "not now" rather than "not ever".
        if (pot < want) return;

        _parked[i.maker][i.tokenIn] = pot - want;
        _totalParked[i.tokenIn] -= want;
        _reserved[h] += want;
        _totalReserved[i.tokenIn] += want;

        emit Deposited(h, i.maker, i.tokenIn, want);
    }

    /**
     * @dev The wallet arm of `_armLeg`: turn an EIP-2612 permit into the relayer's allowance.
     *
     * **No `try` here, and the front-running defence is the `if` rather than a swallowed error.**
     * `nonces` moves on every permit, so anybody watching the mempool can submit the maker's
     * signed permit first and leave ours reverting on a nonce that has already gone — with the
     * allowance set perfectly well by their copy. This asks for a permit only when the allowance
     * falls short, so the front-runner's copy satisfies the fill and the token is never called.
     * `test/Permit.t.sol` runs exactly that race.
     *
     * What is left is a permit we needed and did not get, and that leg cannot fill. A batch is
     * already inside a revertable frame and steps over it; a single fill reverts with the token's
     * own error, which is what the caller needs to see.
     */
    function _grantAllowance(Intent calldata i, uint256 take, bytes memory arming) private {
        Permit memory p = abi.decode(arming, (Permit));
        // Only when it is needed. A maker with a standing allowance costs nobody a permit, and
        // skipping it leaves their nonce alone for whatever else they signed.
        (bool ok, uint256 allowed) =
            _probe(i.tokenIn, abi.encodeCall(IERC20.allowance, (i.maker, address(relayer))));
        if (!ok) revert EscrowShort();
        if (allowed < take) {
            IERC2612(i.tokenIn)
                .permit(i.maker, address(relayer), p.value, p.deadline, p.v, p.r, p.s);
        }
    }

    /**
     * @dev The permit2 arm of `_armLeg`: spend one Permit2 signature into a reservation.
     *
     * Its own frame, like the other two arms, so each is a call the coverage build can see
     * rather than a fall-through the optimizer is free to move.
     *
     * **Two checks before Permit2 hears about any of it, and the caller supplies the bytes both
     * read.** `_receive` needs neither — it names `i.tokenIn` in the call it makes, and the
     * intent hash is the only nonce it will accept — and this rung has to say out loud what that
     * one gets from its shape.
     *
     * The token, because a Permit2 permit carries its own. Without the check a solver holding a
     * maker's signature over asset X could present it against the maker's intent selling asset
     * Y: the asset would land here, the delta on `tokenIn` would be zero, and the tokens would
     * belong to no reservation. The re-evaluation would unwind it in the ordinary case, and
     * "ordinary" is doing more work in that sentence than it should have to — `deposit` is
     * permissionless, so a reservation this leg did not fund can exist.
     *
     * The nonce, because the intent names which one funds it, exactly as it does for an EIP-3009
     * authorization and for the same two reasons: one signature funds one offer, and two offers
     * naming one nonce are mutually exclusive, since Permit2 spends it once. A maker who names
     * none gets the intent's own hash, which welds the signature to the intent.
     */
    function _pullPermit2In(Intent calldata i, bytes32 h, uint256 take, bytes memory arming)
        private
    {
        Permit2Transfer memory p = abi.decode(arming, (Permit2Transfer));
        if (p.token != i.tokenIn) revert BadTerms();
        bytes32 expected = i.authNonce == bytes32(0) ? h : i.authNonce;
        if (p.nonce != uint256(expected)) revert BadTerms();
        // Idempotent from our side: Permit2 refuses a nonce it has already spent, so only ask
        // when the reservation cannot already cover the fill. `_redeemInto` says the same.
        if (_reserved[h] < take) _pullPermit2(i, h, p);
    }

    /**
     * @dev Ask the relayer to spend the signature, and credit what actually arrived.
     *
     * The delta, never `take`, for the reason `_redeem` measures one: a token that keeps a cut of
     * its own transfers delivers less than Permit2 was told to move, and a reservation credited
     * with the number we asked for would let the fill pay out money the contract does not hold.
     * The leg then comes up short, `_armLeg`'s re-evaluation refuses it, and the frame unwinds
     * the lot — which is the same answer the taxed-token case gets on the gasless rung.
     *
     * `take`, not `p.amount`. Permit2 allows a request below the permitted amount, so a partial
     * fill draws only what it fills and the rest stays in the maker's wallet. EIP-3009 cannot do
     * that — an authorization is one fixed value — which is why `_redeem` moves the whole
     * `amountIn` and strands the remainder in escrow until the maker withdraws it.
     *
     * Its own frame, so `_pullPermit2In` keeps a shallow stack.
     */
    /**
     * @dev Draw the whole intent into the reservation, not just the fill that triggered it.
     *
     * A Permit2 signature is spent once. Its nonce is a bitmap slot and Permit2 marks it used on
     * the first `permitTransferFrom`, however little that call requested — so a signature is not
     * a standing permission, it is a single door that closes behind you.
     *
     * This used to request `take`, and the comment beside it in the SDK called that the one thing
     * permit2 did better than EIP-3009: it drew what it filled and stranded nothing. The saving
     * was never real. A non-partial intent must take exactly what is left, and on its only fill
     * that is `amountIn`, so `take` and the whole amount were already the same number. The
     * difference appeared for a PARTIAL intent alone — and there it was not a saving, it was the
     * bug: the first partial drew its own small amount, the door shut, and the rest of a live
     * intent became unreachable. `remaining` said the offer was still open and nothing on chain
     * could ever fill it.
     *
     * So the first fill promotes the signature into a reservation, exactly as `_redeem` does for
     * EIP-3009. Later fills read `_reserved[h]` and never ask Permit2 again. That is the property
     * a one-shot signature has to buy on its way through: not a smaller draw, but a custody
     * position that outlives it.
     *
     * Capped at `amountIn`, which is all the intent could ever consume. A maker who signed a
     * larger permission — several siblings sharing one `authNonce`, say — keeps the difference in
     * their own wallet. Whatever the intent does not fill is returned by `withdraw`, which only
     * the maker can call, exactly as with escrow and 3009.
     */
    function _pullPermit2(Intent calldata i, bytes32 h, Permit2Transfer memory p) private {
        uint256 want = p.amount < i.amountIn ? p.amount : i.amountIn;
        uint256 before = _held(i.tokenIn);
        ProveRelayer(relayer)
            .pullWithPermit2(
                ISignatureTransfer.PermitTransferFrom({
                    permitted: ISignatureTransfer.TokenPermissions({
                        token: p.token, amount: p.amount
                    }),
                    nonce: p.nonce,
                    deadline: p.deadline
                }),
                i.maker,
                want,
                p.signature
            );
        uint256 received = _held(i.tokenIn) - before;
        _reserved[h] += received;
        _totalReserved[i.tokenIn] += received;
        emit Deposited(h, i.maker, i.tokenIn, received);
    }

    /**
     * @dev Arm one requested leg. A leg that cannot be armed comes back exactly as it went in,
     *      so the caller skips or reverts on the reason it already had and never learns a new
     *      one — `EscrowShort` still means what it says, that the maker's funds are out of
     *      reach. No new `Reason`, so no client mirroring that enum has to move.
     *
     *      The reason `_armLeg` reverted with is discarded here on purpose. A batch has a
     *      reason already and a better one: this leg was never fillable to begin with.
     *
     * Its own frame for the stack, like every other leg helper here.
     */
    function _arm(FillRequest calldata req, bytes32 h, uint256 maxFeeRate, Reason r, uint256 booked)
        private
        returns (Reason, uint256)
    {
        try this.armLeg{gas: ARM_GAS}(
            req.intent, req.signature, req.take, msg.sender, h, maxFeeRate, req.arming
        ) returns (
            uint256 b
        ) {
            return (Reason.Ok, b);
        } catch {
            // `EscrowShort`, not the reason the leg walked in with. The caller asked for this leg
            // to be armed and the arming did not take, so the maker's funds are out of reach —
            // which is exactly what that reason says.
            //
            // It used to keep `r`, and `r` is `Ok` more often than it looks: `deep` is false when
            // `skipInvalid` is, so a permit leg with no allowance reads `Ok` here. Keeping it sent
            // the leg on to die inside the token's own `transferFrom`, and a ring — which must
            // pass `skipInvalid = false`, because a ring missing a leg is broken rather than
            // smaller — reverted with an ERC-20 error naming nothing the caller could act on.
            //
            // No leg is lost to this. `_grantAllowance` calls a token only when the standing
            // allowance falls short, so a leg that needed no arming never fails here, and every
            // other failure is either the arming call reverting or the deep re-evaluation
            // refusing the leg. Both mean it cannot fill.
            return (Reason.EscrowShort, booked);
        }
    }

    /**
     * @dev Validate the fill, then book and settle it.
     *
     * `fill` is this function and nothing else. `fillWithPermit` and `fillWithAuthorization` are
     * `_armLeg` and then `_book`, because arming has already validated the leg and a third pass
     * would only charge for the same answer. Three doors, one set of rules behind them.
     */
    function _settle(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        bytes32 h,
        uint256 maxFeeRate
    ) private {
        _book(i, h, take, _mustBeFillable(i, signature, take, msg.sender, h, maxFeeRate));
    }

    /// @dev Book a leg the caller has already proved fillable, settle it, and pay its fee. The
    ///      one place a single fill's money moves, whichever door it came through.
    function _book(Intent calldata i, bytes32 h, uint256 take, uint256 booked) private {
        filled[h] = booked + take;
        // One transfer, and none at all when the fee is zero: `_book1` skips a zero.
        Ledger memory l = _ledger(2);
        _settleLeg(i, h, take, l);
        _settleLedger(l);
    }

    // ── Simulating ───────────────────────────────────────────────────────────

    /**
     * @notice What a batch of these legs comes to, one `Reason` per leg in request order. It
     *         never returns: the answer arrives as a `DryRun` revert.
     * @param maxFeeRate the highest `feeRate` this caller will pay, as in `fillBatch`. It is part
     *        of the question rather than a detail of the answer — a leg that asks for more is a
     *        leg the batch steps over, and a walk without the bound would call it fillable.
     *
     * `fillability` answers for one leg out of storage, and arming has made that answer
     * incomplete. **Whether a permit lands, and whether a redemption comes up short, are facts
     * about a transfer that has already happened.** A token that keeps a cut of everything it
     * moves credits the escrow with less than `amountIn`, so the reservation is still short after
     * a redemption that worked perfectly, and no view function can learn that without making the
     * call. A solver who cannot price an arming attempt cannot use arming.
     *
     * So this makes the calls. It walks the legs the way a batch walks them and arms the ones the
     * caller asked to arm — for real, with the maker's nonce spent and the tokens moved — writes
     * down what each leg came to, and then throws the lot away.
     *
     * **Always reverting is the feature.** Nothing survives the call, so there is no access
     * control to get right, no half-applied state for `nonReentrant` to reason about, and nothing
     * to clean up. Somebody who broadcasts it as a transaction pays gas to learn what an
     * `eth_call` tells them for nothing, and their money stays where it was. There is no variant
     * of this that returns, and adding one would spend every property in this paragraph.
     *
     * A leg is always stepped over here, whatever `skipInvalid` the real batch will pass. A walk
     * that stopped at the first bad leg would report one reason and hide the rest, and the rest is
     * what a solver is asking about.
     *
     * @dev The reasons agree with the fill by construction rather than by resemblance:
     *      `_evaluate` and `_arm` are the two functions `_fillOne` calls, in that order, against
     *      the same storage. A leg that cannot be armed keeps the reason it already had, so there
     *      is no new `Reason` here and no client mirroring that enum has to move.
     *
     *      Nothing here is metered beyond what `_evaluate` already meters. A hostile token can
     *      burn the caller's gas, and the caller is spending an `eth_call` on legs they chose.
     */
    function dryRun(FillRequest[] calldata reqs, uint256 maxFeeRate) external {
        Reason[] memory reasons = new Reason[](reqs.length);
        bytes32 ds = domainSeparator();

        for (uint256 k = 0; k < reqs.length; k++) {
            reasons[k] = _walkLeg(reqs[k], ds, maxFeeRate);
        }

        revert DryRun(reasons);
    }

    /**
     * @dev One leg of the walk: evaluate it, arm it if asked, book it, and release its token A so
     *      that the leg after it sees the funds this one spent.
     *
     * **The walk mirrors `fillBatchWithCallback`, so it pays nobody.** The two batches release in
     * the same order, because `_fillOne` and `_creditLeg` both release before the next leg is
     * evaluated. The only thing left to separate them is when token B moves, and token B moves
     * out of the caller. Paying the makers here would ask a caller to hold the whole batch's
     * inventory before they may price it, and the caller who most needs this tool is the one
     * holding none: a ring's inventory is the releases themselves.
     *
     * That costs one shape, in one direction. In a ring where an earlier leg's delivery is what
     * funds a later leg's maker, that maker reads `EscrowShort` here and would fill under
     * `fillBatch`, which pays as it goes. So the walk is pessimistic there and never optimistic,
     * for every leg whose maker is somebody other than the caller — which is the right way round
     * for a number a solver prices against, and exact for the credit batch a ring settles through
     * anyway. No flag: an answer a caller can switch off is an answer a caller switches off.
     *
     * `deep`, always. The allowance probe is what proves a permit actually landed, and it is what
     * separates a wallet leg nobody armed from one that is ready. `fillability` reads deep for
     * the same reason.
     *
     * Its own frame, for the reason `_fillOne` gives. The reason is a named return, so the tail
     * of this function carries no `return` statement — written out, that line is one more thing
     * `--ir-minimum` cannot count. The optimizer folds it into the epilogue and `forge coverage`
     * then reports zero for a line every one of these tests runs.
     */
    function _walkLeg(FillRequest calldata req, bytes32 ds, uint256 maxFeeRate)
        private
        returns (Reason r)
    {
        Intent calldata i = req.intent;
        bytes32 h = _hash(i, ds);

        uint256 booked;
        (r, booked) = _evaluate(i, req.signature, req.take, msg.sender, h, true, maxFeeRate);

        // The same condition `_fillOne` runs, on the same two reasons, so a leg that arms here
        // arms there.
        if (req.arming.length != 0 && (r == Reason.Ok || r == Reason.EscrowShort)) {
            (r, booked) = _arm(req, h, maxFeeRate, r, booked);
        }
        if (r != Reason.Ok) return r;

        // Booked and released, exactly as a batch would. Two legs of one intent, or two legs of
        // one maker's allowance, have to see what the leg before them took.
        filled[h] = booked + req.take;
        // A throwaway ledger: this walk reverts, so no reservation survives it. The release runs
        // as in a real batch so allowances and reserved totals move the way a later leg sees them.
        _release(i, h, req.take, _quote(i, req.take, block.timestamp).feeIn, msg.sender, _ledger(1));
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /**
     * @dev The tokens the solver owes this contract at the end of the call, for fees reserved
     *      but not yet held. Memory only: a reservation cannot outlive its transaction.
     *
     * Keyed by token alone, not by direction or by config: a token that is `tokenIn` of one leg
     * and `tokenOut` of another, and fees under many configs, collapse into one entry, so a call
     * makes one pull per token however many legs it settles. Two parallel arrays and a count
     * rather than an array of structs, to keep the stack small.
     */
    struct Ledger {
        address[] tokens;
        uint256[] amounts;
        uint256 n;
    }

    /**
     * @dev Terms no executor and no clock can rescue, in one place.
     *
     * A same-token intent lets a callback pay the maker with the maker's own money. An unbounded
     * price panics `_quote` rather than failing, and a panic is not a reason: `skipInvalid` steps
     * on it and the batch dies with it. `_quote` multiplies the price by the take, so bounding
     * both keeps the product inside a word. `uint128` is 3.4e38, or 3.4e20 tokens at eighteen
     * decimals.
     *
     * **`minOutEnd > minOutStart` is refused, and `curve` changed what the refusal means.** It
     * used to say "no rising prices", and that was an implementation artefact — `minOutAt`
     * underflowed on a rising minimum and nothing else objected. It now says something the
     * format needs:
     *
     *   `minOutStart` is the ceiling and `minOutEnd` is the floor. The curve says where between
     *   them the price sits at each moment.
     *
     * A curve may rise inside the window and this does not stop it; what it stops is a maker
     * writing the two ends the wrong way round and leaving no reader able to say which is which.
     * That reading keeps `hi - lo` from underflowing with no branch, keeps the `uint128` cap on
     * one field instead of two, and makes the envelope true by construction — so a client can
     * draw the axes before it knows the shape, and every kind this contract ever grows is
     * bounded by the two numbers already here.
     *
     * **A rate above `WAD` is refused for the same reason.** `_quote` carves the fee out of the
     * gross and subtracts, so a rate above 100% makes `fee` larger than `gross` and the
     * subtraction panics. Measured before it was written: `quote` on an intent with
     * `feeRate = 1.5e18` reverted with an arithmetic panic, which `skipInvalid` cannot step over.
     * The guard reads the signed `i.feeRate`, the only rate a fill charges. Nothing else bounds.
     *
     * A clamp of `fee` to `gross` would be cheaper, because `_quote` runs once per settling leg
     * and this runs on every leg including the skipped ones. It is refused: a clamp silently
     * pays the maker zero, and refusing the terms is the honest failure.
     *
     * `_evaluate` reads this, and `IntentTerms.ok` repeats it for `ProveReader.available`; a fuzz
     * test pins the two, so a view can never call an intent live that a fill would refuse.
     */
    function _termsOk(Intent calldata i) private view returns (bool) {
        if (i.minOutEnd > i.minOutStart || i.tokenIn == i.tokenOut) return false;
        if (i.minOutStart > type(uint128).max || i.amountIn > type(uint128).max) return false;
        if (i.feeRate > WAD || i.feeRateIn > WAD || i.feeRateProceeds > WAD) return false;
        /*
         * One custody rung per intent. Escrow is funded by a deposit or an EIP-3009
         * authorization; permit2 is funded by a Permit2 signature. An intent wearing both says
         * which arm `_armLeg` takes only by the order two `if`s happen to be written in, and a
         * maker should not have to read this file to know which of their two signatures a solver
         * will spend. So the pair is not an intent at all.
         */
        if (i.flags & FLAG_ESCROW != 0 && i.flags & FLAG_PERMIT2 != 0) return false;
        /*
         * Rule 2 in the header applies to money as well as to calls.
         *
         * A delivery or a fee addressed to this contract, or to the relayer, never reaches the
         * party the intent named. `withdraw` pays `_reserved[h]` and nothing else, so a delivery
         * here belongs to no reservation and `sweepUnowned` books it to the stray config — the
         * payee is paid nothing either way, and the executor's money is gone. The relayer is worse:
         * its whole surface is `pull`, a `transferFrom` from somebody else, and nothing moves a
         * balance out of it at all. Neither gets a rescue path, and neither should have one,
         * because a rescue is an owner switch over a maker's money.
         *
         * So refuse the intent instead. It reads nothing but the intent, which is what everything
         * else in this function does, so the offer is dead against every caller and every clock
         * and `fillability` says why for free. A signature that never settles is a better outcome
         * than a delivery nobody can retrieve.
         *
         * `sweepUnowned` covers the accidents from outside an intent — a plain transfer here, an
         * airdrop, a token that rebases up. It does not make this guard redundant, because the
         * sweep books the stray config rather than the payee the intent named. A fill on these
         * terms would still take an executor's money and hand it to somebody they did not choose.
         *
         * A zero recipient is refused too. Its delivery reverts inside the token, and in a
         * strict batch that revert kills every other maker's leg with it.
         */
        if (i.recipient == address(0) || i.recipient == address(this) || i.recipient == relayer) {
            return false;
        }
        // The fee terms. A zero `feeConfig` charges nothing, and then no rate may be signed: a
        // signed rate is never silently dropped. Any other `feeConfig` is accepted whatever it
        // hashes (the contract cannot know), with each rate at most `WAD`. Pure: no storage
        // read, no call, so a destination cannot revert, grief or reenter a fill.
        if (i.feeConfig == bytes32(0) && (i.feeRate | i.feeRateIn | i.feeRateProceeds) != 0) {
            return false;
        }
        // There is deliberately no ceiling on how long a window may run, or how far ahead it may
        // open. A wallet-rung signature nobody can cheaply kill IS a hazard — revoking an approval
        // makes an intent unfillable without cancelling it, so re-approving that token later
        // revives every signature the maker ever wrote against it. But the loss falls on the
        // maker who signed and on nobody else: a wallet rung holds no reservation between
        // transactions, so no other maker's escrow can pay for it. Refusing a window the maker
        // signed would make this contract the one thing it claims not to be — a rule that
        // overrides a term you chose. The app carries the ceiling instead, where a maker can see
        // it and step past it on purpose.
        return true;
    }

    /**
     * @dev Why an intent cannot be filled. One list, so the batch and the single fill can never
     *      disagree about what "fillable" means.
     */
    enum Reason {
        Ok,
        BadTerms_,
        NotStarted,
        Expired,
        Cancelled,
        NonceTooLow,
        WrongExecutor,
        NothingToFill,
        TooMuch,
        PartialNotAllowed,
        /// @dev The maker's funds are out of reach. On a leg that asked to be armed this means
        ///      "not now" rather than "not ever" — see `FillRequest.arming`.
        EscrowShort,
        BadSignature,
        /// @dev Appended, never inserted. The numbers are a wire format: clients mirror this
        ///      enum and a shifted value renames every reason at once.
        FeeTooHigh_,
        /// @dev The take is under the intent's `minFill` and does not close it out.
        BelowMinFill_,
        /**
         * @dev `tokenOut` would not answer a balance read inside `_probe`'s cap.
         *
         * The last thing `_evaluate` asks, and only when `deep`. `_deliverTo` brackets its
         * transfer with the same read, so without this the leg reaches that bracket and dies
         * there with an `Underpaid` no `continue` can reach — the fee-on-transfer guard is a
         * guard and refuses to be swallowed. This is that same leg made visible to `dryRun`,
         * `fillability` and `skipInvalid` one step earlier, where stepping over it is still free.
         *
         * **`_revert` maps it to `Underpaid`.** `fill` and a strict batch pass `deep = false` and
         * meet the token in `_deliverTo`, which reverts `Underpaid`. The three arming doors re-ask
         * with `deep = true` in `_armLeg`, so they can produce this reason, and they must refuse
         * the same way. Unmapped, it fell through to `BadSignature` and blamed a good signature.
         */
        TokenOutUnreadable
    }

    /**
     * @dev The only validator. `fill` turns a reason into a revert; `fillBatch` with
     *      `skipInvalid` turns it into a `continue`. The intent hash arrives already computed,
     *      because hashing twice for one fill wastes twelve words of keccak, and the amount
     *      already filled comes back out so the caller writes the new total without reading the
     *      slot again.
     *
     *      Every branch here reads calldata or one storage slot, cheapest first: the signature
     *      check is last because `ecrecover` costs more than every check above it combined.
     */
    function _evaluate(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        address executor,
        bytes32 h,
        bool deep,
        uint256 maxFeeRate
    ) private view returns (Reason, uint256 booked) {
        if (!_termsOk(i)) return (Reason.BadTerms_, 0);
        if (take == 0) return (Reason.NothingToFill, 0);
        if (block.timestamp < i.startTime) return (Reason.NotStarted, 0);
        if (block.timestamp >= i.endTime) return (Reason.Expired, 0);
        // A calldata flag, not a storage read: the maker's choice travels with the intent.
        if (i.executor != address(0) && i.executor != executor) return (Reason.WrongExecutor, 0);
        // The caller's bound on the two costs the solver bears, P1 + P2 (`feeRateIn + feeRate`).
        // P3 comes out of the maker's number and is not bounded here. A caller who wants no part
        // of any fee config passes zero and every leg that charges P1 or P2 is refused; the fee
        // is reserved in `tokenIn` and `tokenOut` against a config the maker signed.
        //
        // It has to be decided here, while `skipInvalid` can still step over the leg: a revert
        // inside `_quote` lands after the skip decision and would take a whole batch down for the
        // price of one greedy signature. `_ratesOf` is the same function `_quote` charges at, so
        // the number checked here and the number charged there agree by construction.
        if (uint256(i.feeRateIn) + i.feeRate > maxFeeRate) return (Reason.FeeTooHigh_, 0);
        if (_retired(i.maker, i.nonce)) return (Reason.NonceTooLow, 0);
        uint64 c = cancelledAt[h];
        if (c != 0 && block.timestamp >= c) return (Reason.Cancelled, 0);

        booked = filled[h];
        uint256 remaining = i.amountIn - booked;
        if (take > remaining) return (Reason.TooMuch, booked);
        if (i.flags & FLAG_PARTIAL == 0 && take != remaining) {
            return (Reason.PartialNotAllowed, booked);
        }
        // The floor, and the one fill that is always allowed under it. Closing the intent out
        // has to stay legal or a floor of 30 on an amount of 100 strands the last 10 for good:
        // no fill may take less than the floor, and no fill may take more than what is left, so
        // the remainder would be unreachable from both sides. A floor of zero never bites.
        if (take < i.minFill && take != remaining) return (Reason.BelowMinFill_, booked);
        /*
         * Which question "is this maker funded?" is, and it is not the same question on every
         * rung. Escrow and permit2 both end with the tokens here, so the reservation is the
         * whole answer for both.
         *
         * **A permit2 maker has granted the relayer nothing.** Their standing approval is to
         * Permit2 and to nothing else, so the allowance probe below would read zero for them for
         * ever — before arming, which is right, and equally after an arming that worked
         * perfectly, which would leave every leg of the rung answering `EscrowShort` and no
         * fill ever settling. The rung has to be in this branch, not that one.
         */
        if (i.flags & FLAGS_CUSTODIED != 0) {
            if (_reserved[h] < take) return (Reason.EscrowShort, booked);
        } else if (deep) {
            // Only a batch pays for these two reads. A single fill would learn the same thing
            // from the transfer one moment later, but a batch has to know before it commits:
            // stepping over a maker who revoked their allowance is the whole point of skipping.
            // Probed one at a time, so a token that will not answer buys the griefer one gas cap
            // rather than two.
            (bool ok, uint256 got) =
                _probe(i.tokenIn, abi.encodeCall(IERC20.allowance, (i.maker, relayer)));
            if (!ok || got < take) return (Reason.EscrowShort, booked);
            (ok, got) = _probe(i.tokenIn, abi.encodeCall(IERC20.balanceOf, (i.maker)));
            if (!ok || got < take) return (Reason.EscrowShort, booked);
        }
        if (!_validSignature(i.maker, h, signature)) return (Reason.BadSignature, booked);
        /*
         * Token B, under the same cap as token A and for a sharper reason.
         *
         * `_deliverTo` reads this exact balance twice around the delivery, and that bracket is
         * the fee-on-transfer guard: it must revert rather than shrug. So a `tokenOut` that will
         * not answer takes down every fill that touches it, and until this probe existed nothing
         * upstream could say so — `dryRun` returned `Ok` for the leg, `fillability` agreed, and
         * the batch found out inside `_settleLeg`, after `_fillOne` had decided not to skip.
         * A maker signs one intent naming a contract they wrote, and every solver who batches it
         * loses a transaction. One signature, reusable for ever.
         *
         * **After the signature, not before it.** The token A probes sit ahead of `ecrecover` on
         * purpose, and pay for it with `_probe`'s cap, because a batch has to price a maker's
         * funding before it commits. Nothing needs token B that early, so this one is put where
         * sixty-five zero bytes cannot reach it: a griefer has to hold the maker's key.
         *
         * **`deep` only**, exactly like the two above. A single fill has nothing to step over and
         * learns the same fact from `_deliverTo` one moment later, at one capped read.
         */
        if (deep) {
            (bool answered,) = _probe(i.tokenOut, abi.encodeCall(IERC20.balanceOf, (i.recipient)));
            if (!answered) return (Reason.TokenOutUnreadable, booked);
        }

        return (Reason.Ok, booked);
    }

    /**
     * @dev Read one word from a token, under a gas cap and a bounded copy.
     *
     * **Every balance and allowance this contract reads off an intent's token comes through
     * here.** The intent author chose the token, so each of those reads is a call into code a
     * griefer wrote. The two in `_evaluate` on token A run before the signature check, so
     * sixty-five zero bytes reach them; the third, on token B, runs after it. `_held` measures a
     * redemption or a permit2 draw, and `_deliverTo` brackets the delivery. A revert, a short
     * answer or exhausted gas all read as false, and each caller says what that means — a leg
     * stepped over, an arming refused, or a delivery that cannot be promised.
     *
     * The reads left outside this function are the ones no intent picks: `deposit` and
     * `sweepUnowned` are called by somebody spending their own gas on a token they named
     * themselves.
     *
     * This is one of two places in `src/` that still use assembly — `ProveBatchExecutor._write`
     * is the other — and it stays because both
     * alternatives were written and measured. `test/ReturnBomb.t.sol` holds the numbers.
     *
     *   this, copying one word           2,764 gas a leg    30,177 against a return bomb
     *   `token.staticcall(...)`          3,412 gas a leg    63,608 against a return bomb
     *   `try IERC20(token).allowance`    2,785 gas a leg    reverts the whole batch
     *
     * The high-level call copies the whole return buffer into memory before it reads a word of
     * it, and memory is priced quadratically — so it costs 648 gas on every honest leg and lets
     * a hostile token double what it can waste.
     *
     * The typed call is worse than either and it does not look it. `try` cannot catch a failure
     * to decode a *successful* return, so a token that answers with nothing at all reverts the
     * batch instead of being skipped — which is the denial of service these probes exist to
     * prevent, handed to anyone who can post an intent. `test_ATokenThatAnswersNothingIsSkipped`
     * is the test that refuses it.
     */
    function _probe(address token, bytes memory data) private view returns (bool ok, uint256 word) {
        assembly ("memory-safe") {
            ok := staticcall(PROBE_GAS, token, add(data, 0x20), mload(data), 0x00, 0x00)
            switch and(ok, gt(returndatasize(), 31))
            case 1 {
                returndatacopy(0x00, 0x00, 0x20)
                word := mload(0x00)
            }
            default { ok := 0 }
        }
    }

    /**
     * @dev What this contract holds of `token`, under `_probe`'s cap, or the arming refuses.
     *
     * `_redeem` and `_pullPermit2` bracket a transfer with two of these and credit the difference
     * to `_reserved`, because a token that keeps a cut of what it moves delivers less than it was
     * asked for. That makes the read a measurement the escrow depends on, not a hint — and the
     * token is `tokenIn`, an address out of an intent, so the maker chose it and a hostile one is
     * the ordinary case rather than the strange one.
     *
     * `EscrowShort`, because that is already what the caller means by "the maker's funds are out
     * of reach", and because both callers run inside `armLeg`'s `try` frame: the leg keeps the
     * reason it arrived with and a batch steps over it. A new `Reason` here would move a wire
     * format for a case the enum already words correctly. A single fill through
     * `fillWithAuthorization` or `fillWithPermit2` gets the revert, which is the right answer
     * when there is nothing to step over.
     *
     * Crediting a reservation on a number this contract could not read is the outcome this
     * refuses: `withdraw` pays `_reserved[h]` out of a pool every maker shares.
     */
    function _held(address token) private view returns (uint256 held) {
        bool ok;
        (ok, held) = _probe(token, abi.encodeCall(IERC20.balanceOf, (address(this))));
        if (!ok) revert EscrowShort();
    }

    /// @dev The single place a reason becomes a revert.
    function _revert(Reason r) private pure {
        if (r == Reason.BadTerms_) revert BadTerms();
        if (r == Reason.NotStarted) revert NotStarted();
        if (r == Reason.Expired) revert Expired();
        if (r == Reason.Cancelled) revert IsCancelled();
        if (r == Reason.NonceTooLow) revert NonceTooLow();
        if (r == Reason.WrongExecutor) revert WrongExecutor();
        if (r == Reason.NothingToFill) revert NothingToFill();
        if (r == Reason.TooMuch) revert TooMuch();
        if (r == Reason.PartialNotAllowed) revert PartialNotAllowed();
        if (r == Reason.EscrowShort) revert EscrowShort();
        if (r == Reason.FeeTooHigh_) revert FeeTooHigh();
        if (r == Reason.BelowMinFill_) revert BelowMinFill();
        if (r == Reason.TokenOutUnreadable) revert Underpaid();
        revert BadSignature();
    }

    /// @dev Validate or revert, and hand back the amount already filled.
    function _mustBeFillable(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        address executor,
        bytes32 h,
        uint256 maxFeeRate
    ) private view returns (uint256 booked) {
        Reason r;
        (r, booked) = _evaluate(i, signature, take, executor, h, false, maxFeeRate);
        if (r != Reason.Ok) _revert(r);
    }

    /**
     * @notice Why this intent cannot be filled by `executor` for `take`, as a reason code. Zero
     *         means it goes through. The UI reads this to grey out a row and say why.
     */
    function fillability(
        Intent calldata i,
        bytes calldata signature,
        uint256 take,
        address executor,
        uint256 maxFeeRate
    ) external view returns (Reason) {
        // The bound is an argument because the answer depends on it. An intent that asks for
        // more than this caller will pay is one a batch steps over, and a view that could not
        // say so would report `Ok` for a leg the fill is going to skip. Pass the same number the
        // fill will pass; `type(uint256).max` asks the question without a bound.
        (Reason r,) =
            _evaluate(i, signature, take, executor, _hash(i, domainSeparator()), true, maxFeeRate);
        return r;
    }

    /**
     * @dev The callback target, which is always `msg.sender`, checked before anything is released.
     *
     * Splitting the allowance out is decorative on its own. The relayer obeys this contract, so a
     * call site here that could be aimed at the relayer would hand back exactly the capability the
     * split removes. CoW carries the same line — `require(interaction.target != vaultRelayer)`,
     * commented "To prevent possible attack on user funds" — and they carry it because a solver
     * found the hazard on top of a structure that was already right.
     *
     * Neither address can call in today: the relayer has one function, and the one self-call
     * this contract makes is `armLeg`, which refuses any caller but itself and cannot reach
     * here. The check is here so that stays true of code nobody has written yet, which is the
     * only kind of protection worth having against a future call site.
     */
    modifier callableTarget() {
        if (msg.sender == relayer || msg.sender == address(this)) revert ForbiddenTarget();
        _;
    }

    /// @dev A ledger for at most `cap` distinct tokens.
    function _ledger(uint256 cap) private pure returns (Ledger memory l) {
        l.tokens = new address[](cap);
        l.amounts = new uint256[](cap);
    }

    /// @dev Add `amount` of `token` to what the solver owes at the end of the call.
    function _owe(Ledger memory l, address token, uint256 amount) private pure {
        uint256 n = l.n;
        for (uint256 k = 0; k < n; k++) {
            if (l.tokens[k] == token) {
                l.amounts[k] += amount;
                return;
            }
        }
        l.tokens[n] = token;
        l.amounts[n] = amount;
        l.n = n + 1;
    }

    /**
     * @dev Reserve a fee: the one place a fee is booked. Two paired writes in one block, before
     *      any token moves for it, and (unless the tokens are already held here) an entry in the
     *      ledger so the flush makes them arrive. Nobody is paid here; `claim` pays.
     *
     * The books move together, in the same statement, for the same reason `_reserved` and
     * `_totalReserved` do: `sweepUnowned` reads the total.
     */
    function _reserve(bytes32 cfg, address token, uint256 fee, Ledger memory l, bool unbacked)
        private
    {
        _book1(cfg, token, fee);
        if (unbacked) _owe(l, token, fee);
    }

    /// @dev The paired writes only. Zero touches nothing.
    function _book1(bytes32 cfg, address token, uint256 fee) private {
        if (fee == 0) return;
        _pendingFees[cfg][token] += fee;
        _totalPendingFees[token] += fee;
    }

    /**
     * @dev Make every reservation of the call real: once per token, pull what the ledger holds
     *      from `msg.sender` (the solver, or the executor contract that called a callback entry)
     *      and revert unless all of it arrived. Strict: there is no "book what arrived", because
     *      the reservation was booked already.
     *
     * **The contract pulls; it measures only here.** The measured delta is the one check that the
     * books are backed (R2): a token that taxes its own transfers cannot be fee-charged, as it
     * already could not be delivered. A failing flush reverts the whole call, `skipInvalid`
     * notwithstanding.
     */
    function _settleLedger(Ledger memory l) private {
        for (uint256 k = 0; k < l.n; k++) {
            address token = l.tokens[k];
            uint256 amount = l.amounts[k];
            if (amount == 0) continue;
            uint256 before = _held(token);
            ProveRelayer(relayer).pull(token, msg.sender, address(this), amount);
            if (_held(token) < before + amount) revert ReservationUnbacked(token, amount);
        }
    }

    /**
     * @dev The one place the executor's money moves to a payee.
     *
     * The balance read is the fee-on-transfer guard. The contract promises the maker an amount
     * received, not an amount sent, so a token that taxes its own transfers must fail the fill
     * rather than quietly short the maker. It brackets this transfer and nothing else, which is
     * what keeps it a measure of the token's honesty rather than of the executor's.
     *
     * Plain arguments, not a calldata `Intent` pointer: the token and the payee are each read
     * once here instead of on all three touches. That is worth 401 gas on a warm `fill` and
     * 4,114 on a twenty-leg `fillBatch`.
     *
     * **Both reads go through `_probe`, and a read that fails reverts rather than being
     * swallowed.** `token` is `tokenOut`, an address out of an intent, so it is the maker's
     * choice and not the executor's — the same standing the token A probes have and the same
     * hazard. A high-level read here copies the whole return buffer into memory before it looks
     * at a word of it, and memory is priced quadratically, so a token that answers with megabytes
     * spends the caller's entire gas limit on one leg. `test/ReturnBomb.t.sol` prices it.
     *
     * The first read is checked before the transfer, which is the only place the cap buys
     * anything. `pull` forwards all the gas a `transferFrom` needs and there is no delivering a
     * token without calling it, so a bail after the transfer would arrive behind the grief rather
     * than in front of it.
     *
     * `Underpaid`, never a flag the caller may ignore. This bracket is the fee-on-transfer guard:
     * the contract promises the maker an amount received, and a delivery it could not measure is
     * one it cannot promise. `_evaluate` probes the same token under `deep` so a batch steps over
     * the leg before it reaches here — see `Reason.TokenOutUnreadable`.
     *
     * **What the cap now costs, said out loud.** `PROBE_GAS` used to bound one batch's skip
     * decision; here it bounds every fill. A token whose `balanceOf` needs more than thirty
     * thousand gas cannot be delivered at all, by any path. That is a wide margin — an ordinary
     * balance is one warm storage read — but an elastic token that computes its answer through
     * another contract could reach it, and such a token needs the off-chain allowlist anyway.
     */
    function _deliverTo(address token, address to, uint256 amount) private {
        // One encoding for both reads, so the guard asks the same question twice by construction
        // rather than by two lines that have to agree.
        bytes memory read = abi.encodeCall(IERC20.balanceOf, (to));

        (bool ok, uint256 before) = _probe(token, read);
        if (!ok) revert Underpaid();

        ProveRelayer(relayer).pull(token, msg.sender, to, amount);

        uint256 held;
        (ok, held) = _probe(token, read);
        if (!ok || held - before < amount) revert Underpaid();
    }

    /// @dev Move token A out of the maker's custody (whichever rung) and reserve P1.
    ///
    ///      The maker is debited `take` on every rung, so allowance accounting and the
    ///      reservation checks in `_evaluate` and `dryRun` are unchanged.
    ///
    ///      Custodied rungs (escrow, EIP-3009, permit2): the fee is deducted before the solver
    ///      owns anything. The tokens are already here, so `feeIn` is a reclassification (backed):
    ///      `take - feeIn` goes to the solver and `feeIn` stays and changes book.
    ///
    ///      Approval rung: the tokens are in the maker's wallet, so the solver is handed the full
    ///      `take` and `feeIn` is a loan it owes back at the flush (unbacked).
    function _release(
        Intent calldata i,
        bytes32 h,
        uint256 take,
        uint256 feeIn,
        address to,
        Ledger memory l
    ) private {
        if (i.flags & FLAGS_CUSTODIED == 0) {
            // Through the relayer, never from here. This contract holds no maker allowance.
            ProveRelayer(relayer).pull(i.tokenIn, i.maker, to, take);
            _reserve(i.feeConfig, i.tokenIn, feeIn, l, true);
            return;
        }
        // `_evaluate` has already proved the reservation covers `take`, so neither subtraction can
        // wrap: the per-token sum holds this reservation and every other one of the same token.
        _reserved[h] -= take;
        _totalReserved[i.tokenIn] -= take;
        _reserve(i.feeConfig, i.tokenIn, feeIn, l, false);
        if (take != feeIn) IERC20(i.tokenIn).safeTransfer(to, take - feeIn);
    }

    /**
     * @dev The signature tells us how to check it. A 65-byte blob is an ECDSA signature, so try
     *      `ecrecover` first: for an ordinary wallet that settles it without an EXTCODESIZE probe
     *      on the maker. Anything else, or a recovery that does not match, falls through to
     *      ERC-1271 — which is the only path a contract wallet ever needed.
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

        // The gas cap stops a hostile maker burning the caller's budget.
        (bool ok, bytes memory ret) = maker.staticcall{gas: 60_000}(
            abi.encodeCall(IERC1271.isValidSignature, (digest, signature))
        );
        if (!ok || ret.length < 32) return false;
        // A whole word, and never `abi.decode(ret, (bytes4))`. A `bytes4` decode insists the low
        // twenty-eight bytes are zero and reverts when they are not, and a maker that answers
        // with dirty low bytes must read as "did not sign" rather than take a whole batch down.
        // A `bytes32` has no such constraint, and the length is already checked above.
        return bytes4(abi.decode(ret, (bytes32))) == ERC1271_MAGIC;
    }
}
