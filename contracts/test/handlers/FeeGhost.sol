// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {feeCfg} from "../Fees.sol";

/**
 * @notice The fee arithmetic a handler keeps for itself, so an invariant has a second opinion.
 *
 * Every number here comes from the signed terms. It never calls `quote` or `rateOf`. A ghost that
 * asks the contract can only ever agree with it.
 *
 * Two handlers inherit this, because the arithmetic does not care which token pays it.
 */
abstract contract FeeGhost {
    /// @dev One, in the unit a rate is counted in. Written out rather than read back: a ghost
    ///      that fetched the contract's own constant would move whenever the contract moved and
    ///      would witness nothing.
    uint256 internal constant GHOST_WAD = 1e18;

    /**
     * @dev The widest rate a handler quotes.
     *
     * It is the handler's own bound and not the contract's. The settlement's own ceiling is
     * `WAD`, and it is arithmetic rather than policy: above 100% the fee exceeds the gross and
     * the subtraction underflows. Twenty per cent is far under it. This exists so the fuzzed
     * rates stay in a range a real market could produce.
     */
    uint256 internal constant GHOST_MAX_FEE_RATE = 0.2e18;

    // ── Ghost books ──────────────────────────────────────────────────────────

    /// @notice Every fee the fills charged, which is also every fee the executors paid.
    uint256 public ghostCharged;
    /// @notice What the destinations the intents named are owed, added up fill by fill.
    uint256 public ghostToFeeTo;

    /**
     * @notice What each destination is owed in each token and has not claimed — the ghost's own
     *         copy of `_pendingFees`.
     *
     * It has to be keyed the same way the contract keys it, because a fee no longer moves during
     * a fill. This used to be a single scalar compared against summed balances; the balances no
     * longer move, so that comparison would witness nothing. Keyed destination first, then token,
     * exactly as the settlement keys it, so an invariant can read the two side by side.
     *
     * `_bookFee` credits it and `_claimed` debits it. Neither ever asks the contract.
     */
    mapping(address => mapping(address => uint256)) public ghostPendingFees;

    /// @notice Every wei a destination has actually taken out through `claim`, per destination
    ///         and token. Booked plus claimed is what was charged, which is the conservation
    ///         statement the balance comparison used to make on its own.
    mapping(address => mapping(address => uint256)) public ghostClaimed;

    /// @notice Fills that signed a zero `feeTo`, and so paid no fee. A receipt, not a fault: a
    ///         run that never produced one proved nothing about the zero-`feeTo` rule.
    uint256 public ghostUnnamedFills;

    /// @notice The settlement's default sink and rate, copied once at construction. No fill
    ///         books to it (OW-2, 2026-10-01), so its ghost book stays at zero, and the book
    ///         comparison catches a fill that reads the default.
    ///         There is no default sink any more: this is an address no fill ever books to, kept
    ///         so the book comparison still has a row that must stay at zero.
    address public constant ghostDefaultSink = address(0xF0);
    uint64 public constant ghostDefaultRate = 0;

    /**
     * @dev Charge one fill the way `_quote` charges it, book the result, and say what it was.
     *
     * The rounding is the property, and it points the other way now: the charge floors, so a
     * fill small enough at a rate small enough owes nothing and the maker keeps the dust. It
     * rounded up until the fee moved inside the maker's number, when a whole wei of a sub-wei
     * charge stopped being the maker's to give.
     *
     * `gross` is the curve's own number and the executor's whole outlay. It arrives from the
     * caller's own curve arithmetic, never from a quote. The return value is what a caller must
     * subtract from it to get what the maker receives.
     *
     * Two lines used to sit under this — an owner-set floor that could raise the rate, and a
     * share of the result kept by the protocol. Both are gone from the contract, so both are
     * gone from the ghost: what a fill charges is what the address the intent named receives.
     */
    /// @dev The handlers' destinations are a fixed small set, so the config hash an intent signed
    ///      is mapped back to its one destination by trying each. Reverting on a miss is
    ///      deliberate: a handler that invented a fifth destination must teach the ghost about it.
    function _destOf(bytes32 cfg) internal pure returns (address) {
        for (uint160 a = 0xF0; a <= 0xF3; a++) {
            if (feeCfg(address(a)) == cfg) return address(a);
        }
        revert("FeeGhost: unknown fee config");
    }

    function _bookFee(bytes32 cfg, address token, uint64 feeRate, uint256 gross)
        internal
        returns (uint256 charged)
    {
        address feeTo = cfg == bytes32(0) ? address(0) : _destOf(cfg);
        // A zero `feeTo` signs a zero rate and pays no fee, whatever the default sink charges.
        // Nothing is booked, which is what makes the comparison catch a fee that found a home
        // anyway: the default sink's real book must stay at zero.
        if (feeTo == address(0)) {
            ghostUnnamedFills++;
            return 0;
        }

        charged = (gross * feeRate) / GHOST_WAD;
        ghostCharged += charged;
        ghostToFeeTo += charged;
        // The token comes in as an argument rather than being assumed, because the two handlers
        // that inherit this pay in different tokens and a destination can be owed several at
        // once. The settlement's key is (destination, token); so is this.
        ghostPendingFees[feeTo][token] += charged;
    }

    /// @dev A destination emptied its book. `claim` pays the whole of one row, so the ghost
    ///      moves the whole of one row: nothing partial, and the two totals stay complementary.
    function _claimed(address feeTo, address token, uint256 amount) internal {
        ghostPendingFees[feeTo][token] -= amount;
        ghostClaimed[feeTo][token] += amount;
    }
}
