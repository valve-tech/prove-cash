// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {FeeConfig} from "./FeeConfig.sol";
import {IProveCallback} from "./interfaces/IProveCallback.sol";
import {IProveBatchCallback} from "./interfaces/IProveBatchCallback.sol";

/**
 * @title TakePoints
 * @notice The arithmetic of the three fee take points, and everything derived from it, in one
 *         place. Internal and pure: compiled into `ProveSettlement` (which uses it to price a
 *         take and to build what a callback is told) and into `ProveReader` (which uses it to
 *         explain the same numbers). Neither keeps a copy, so a reader cannot disagree with a fill.
 *
 *   P1 handover  feeIn  = floor(take        * feeRateIn       / WAD)   tokenIn, the solver bears it
 *   P2 output    feeOut = floor(owedToMaker * feeRate         / WAD)   tokenOut, on top, the solver bears it
 *   P3 proceeds  feeP   = floor(owedToMaker * feeRateProceeds / WAD)   tokenOut, out of owedToMaker, the maker bears it
 *
 * Spec: `docs/superpowers/specs/2026-10-03-fee-config-hash.md` sections 2.10 and 2.11.
 */
library TakePoints {
    /// @notice One take priced. `usable = take - feeIn`; `delivered = owedToMaker - feeProceeds`;
    ///         `owed = owedToMaker + feeOut`, the solver's whole tokenOut debt over the call.
    struct Quote {
        uint256 take;
        uint256 feeIn;
        uint256 usable;
        uint256 owedToMaker;
        uint256 feeOut;
        uint256 feeProceeds;
        uint256 delivered;
        uint256 owed;
    }

    enum Bearer {
        Solver,
        Maker
    }

    /// @notice One take point, for display. 0 = P1 handover, 1 = P2 output, 2 = P3 proceeds.
    struct Step {
        uint8 point;
        address token;
        uint256 base;
        uint256 rate;
        uint256 fee;
        uint256 amountBefore;
        uint256 amountAfter;
        Bearer bearer;
        bool backed;
        bytes32 cell;
    }

    /// @notice A token amount the solver owes the settlement at the end of the call.
    struct Due {
        address token;
        uint256 amount;
    }

    /// @notice What a leg's fee terms are made of, so the helpers take one argument.
    struct Ctx {
        address tokenIn;
        address tokenOut;
        bool approvalRung;
        bytes32 feeConfig;
        uint256 rateIn;
        uint256 rate;
        uint256 rateProceeds;
    }

    /// @notice Price a take. Checked arithmetic: a rate above `WAD` underflows and reverts, which
    ///         `_termsOk` keeps out of every fill.
    function price(
        uint256 take,
        uint256 owedToMaker,
        uint256 rateIn,
        uint256 rate,
        uint256 rateProceeds
    ) internal pure returns (Quote memory q) {
        q.take = take;
        q.owedToMaker = owedToMaker;
        q.feeIn = FeeConfig.feeOf(take, rateIn);
        q.feeOut = FeeConfig.feeOf(owedToMaker, rate);
        q.feeProceeds = FeeConfig.feeOf(owedToMaker, rateProceeds);
        q.usable = take - q.feeIn;
        q.delivered = owedToMaker - q.feeProceeds;
        q.owed = owedToMaker + q.feeOut;
    }

    /// @notice `ceilDiv(take * minOutNow, amountIn)`: what the curve requires for this take.
    function owedFor(uint256 take, uint256 minOutNow, uint256 amountIn)
        internal
        pure
        returns (uint256)
    {
        uint256 a = take * minOutNow;
        return a == 0 ? 0 : (a - 1) / amountIn + 1;
    }

    /// @notice The `tokenIn` the solver owes back at the flush: `feeIn` on the approval rung.
    function feeInDue(Quote memory q, bool approvalRung) internal pure returns (uint256) {
        return approvalRung ? q.feeIn : 0;
    }

    /// @notice What `proveCallback` receives.
    function terms(Quote memory q, Ctx memory c)
        internal
        pure
        returns (IProveCallback.Terms memory t)
    {
        t.tokenIn = c.tokenIn;
        t.amountIn = q.usable;
        t.feeIn = q.feeIn;
        t.feeInDue = feeInDue(q, c.approvalRung);
        t.tokenOut = c.tokenOut;
        t.owedToMaker = q.owedToMaker;
        t.feeOut = q.feeOut;
        t.feeProceeds = q.feeProceeds;
        t.delivered = q.delivered;
        t.owed = q.owed;
    }

    /// @notice One line of what `proveBatchCallback` receives. `to` and `leg` are the caller's.
    function payment(Quote memory q, Ctx memory c, address to, uint256 leg)
        internal
        pure
        returns (IProveBatchCallback.Payment memory p)
    {
        p.token = c.tokenOut;
        p.to = to;
        p.amount = q.owedToMaker;
        p.fee = q.feeOut;
        p.feeConfig = c.feeConfig;
        p.leg = leg;
        p.tokenIn = c.tokenIn;
        p.amountIn = q.usable;
        p.feeIn = q.feeIn;
        p.feeInDue = feeInDue(q, c.approvalRung);
        p.feeProceeds = q.feeProceeds;
    }

    /// @notice The three steps, in order.
    function steps(Quote memory q, Ctx memory c) internal pure returns (Step[3] memory s) {
        s[0] = Step({
            point: 0,
            token: c.tokenIn,
            base: q.take,
            rate: c.rateIn,
            fee: q.feeIn,
            amountBefore: q.take,
            amountAfter: q.usable,
            bearer: Bearer.Solver,
            backed: !c.approvalRung,
            cell: _cell(c.feeConfig, c.tokenIn)
        });
        s[1] = Step({
            point: 1,
            token: c.tokenOut,
            base: q.owedToMaker,
            rate: c.rate,
            fee: q.feeOut,
            amountBefore: q.owedToMaker,
            amountAfter: q.owed,
            bearer: Bearer.Solver,
            backed: false,
            cell: _cell(c.feeConfig, c.tokenOut)
        });
        s[2] = Step({
            point: 2,
            token: c.tokenOut,
            base: q.owedToMaker,
            rate: c.rateProceeds,
            fee: q.feeProceeds,
            amountBefore: q.owedToMaker,
            amountAfter: q.delivered,
            bearer: Bearer.Maker,
            backed: false,
            cell: _cell(c.feeConfig, c.tokenOut)
        });
    }

    /// @notice What the flush pulls from the solver for this take, one line per token, zero lines
    ///         omitted: `feeInDue` of tokenIn (approval rung) and `feeOut + feeProceeds` of tokenOut.
    function dues(Quote memory q, Ctx memory c) internal pure returns (Due[] memory d) {
        uint256 fIn = feeInDue(q, c.approvalRung);
        uint256 fOut = q.feeOut + q.feeProceeds;
        Due[] memory all = new Due[](2);
        all[0] = Due(c.tokenIn, fIn);
        all[1] = Due(c.tokenOut, fOut);
        // A window over the two: from the first non-zero due to just past the last.
        uint256 lo = fIn != 0 ? 0 : 1;
        uint256 hi = fOut != 0 ? 2 : 1;
        d = new Due[](hi - lo);
        for (uint256 k = 0; k < d.length; k++) {
            d[k] = all[lo + k];
        }
    }

    /// @notice What the relayer must be approved for to complete this take: the delivery plus the
    ///         dues, per token. tokenOut: `owed`. tokenIn: `feeInDue`.
    function allowance(Quote memory q, Ctx memory c) internal pure returns (Due[] memory d) {
        uint256 fIn = feeInDue(q, c.approvalRung);
        Due[] memory all = new Due[](2);
        all[0] = Due(c.tokenOut, q.owed);
        all[1] = Due(c.tokenIn, fIn);
        d = new Due[](fIn != 0 ? 2 : 1);
        for (uint256 k = 0; k < d.length; k++) {
            d[k] = all[k];
        }
    }

    /// @notice The smallest `take` with `owedFor(take) >= requiredOut`; 0 when `requiredOut` or the
    ///         price is 0.
    function takeForOut(uint256 requiredOut, uint256 amountIn, uint256 minOutNow)
        internal
        pure
        returns (uint256)
    {
        if (requiredOut == 0 || minOutNow == 0) return 0;
        return ((requiredOut - 1) * amountIn) / minOutNow + 1;
    }

    /// @dev The key of a fee-book cell, for indexers: `keccak256(abi.encode(feeConfig, token))`.
    function _cell(bytes32 feeConfig, address token) private pure returns (bytes32) {
        return keccak256(abi.encode(feeConfig, token));
    }
}
