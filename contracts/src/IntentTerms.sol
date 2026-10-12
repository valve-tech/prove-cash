// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {ProveSettlement} from "./ProveSettlement.sol";
import {FeeConfig} from "./FeeConfig.sol";

/**
 * @title IntentTerms
 * @notice `ProveSettlement._termsOk`, for the reader: "terms no executor and no clock can
 *         rescue". Internal and pure, compiled into `ProveReader` (its `available` asks it).
 *
 *         This is a copy, not a shared definition. Sharing it made the settlement 324 bytes larger
 *         (the optimizer stopped inlining the private original), and the settlement had none to
 *         spare. So the two are pinned instead: `ProveReader.t.sol` fuzzes intents and asserts
 *         `ok(i)` equals `fillability(i, ...) != BadTerms_` on the real settlement. Change one,
 *         change the other, and that test fails if you forget.
 */
library IntentTerms {
    uint256 private constant WAD = FeeConfig.WAD;
    // Mirrors `FLAG_ESCROW` / `FLAG_PERMIT2`; `ProveReader.t.sol` asserts they agree.
    uint8 private constant FLAG_ESCROW = 2;
    uint8 private constant FLAG_PERMIT2 = 4;

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
     * **A rate above `ProveSettlement.WAD` is refused for the same reason.** `_quote` carves the fee out of the
     * gross and subtracts, so a rate above 100% makes `fee` larger than `gross` and the
     * subtraction panics. Measured before it was written: `quote` on an intent with
     * `feeRate = 1.5e18` reverted with an arithmetic panic, which `skipInvalid` cannot step over.
     * The guard reads the signed `i.feeRate`, the only rate a fill charges. Nothing else bounds.
     *
     * A clamp of `fee` to `gross` would be cheaper, because `_quote` runs once per settling leg
     * and this runs on every leg including the skipped ones. It is refused: a clamp silently
     * pays the maker zero, and refusing the terms is the honest failure.
     *
     * `_evaluate` and `available` both read this, so a view can never call an intent live that a
     * fill would refuse.
     */
    function ok(ProveSettlement.Intent calldata i, address self, address relayer)
        internal
        pure
        returns (bool)
    {
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
        if (i.recipient == address(0) || i.recipient == self || i.recipient == relayer) {
            return false;
        }
        // The fee terms. A zero `feeConfig` charges nothing, and then no rate may be signed: a
        // signed rate is never silently dropped. Any other `feeConfig` is accepted whatever it
        // hashes (the contract cannot know), with each rate at most `ProveSettlement.WAD`. Pure: no storage
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
}
