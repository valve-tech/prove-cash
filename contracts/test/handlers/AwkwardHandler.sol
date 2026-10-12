// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION,
    availableOf
} from "../Fees.sol";
import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../../src/ProveSettlement.sol";
import {ANY_FEE, PayingExecutor, SmartWallet} from "../Mocks.sol";
import {WeirdToken} from "../tokens/WeirdToken.sol";
import {FeeGhost} from "./FeeGhost.sol";

/**
 * @notice The same board, played with the tokens and the makers nobody wants to think about: an
 *         input token that taxes its own transfers and can answer without a boolean, an output
 *         token with six decimals, and a maker that signs through ERC-1271.
 *
 * **Why a second settlement and a second handler, rather than one handler over a token pair.**
 * A taxing token moves less than it is told to. Every fill through it therefore ends with less
 * money in the world than the plain-token books predict, and any invariant that spans both
 * pairs has to carry a term for the tax. Adding that term to
 * `invariant_TokensAreConserved` would weaken the statement that matters most about the plain
 * pair — that nothing at all goes missing — and a weakened invariant catches the bug it was
 * written for exactly once. So the awkward pair settles somewhere else, against its own
 * contract instance, and states its own truth: the tax is real, and this is who pays it.
 *
 * The output token never taxes. `_deliverTo` brackets the delivery with a balance read and
 * reverts with `Underpaid` when the recipient is short, so a taxing output token fails every
 * fill and a stateful run through it would explore nothing.
 * `test_ATaxedOutputTokenFailsTheFill` pins that behaviour where one call can prove it.
 */
contract AwkwardHandler is Test, FeeGhost {
    ProveSettlement public immutable settlement;

    /// @notice Eighteen decimals, and it taxes what it moves whenever the run says so.
    WeirdToken public immutable taxIn;
    /// @notice Six decimals, and honest. Six is where a small trade's fee rounds to one wei.
    WeirdToken public immutable outSix;

    /// @dev The taxing token counts its own cut in basis points, and always did. It is a
    ///      token's own arithmetic and has nothing to do with what an intent's fee is
    ///      counted in, so it did not move when the fee did.
    uint256 constant TAX_BPS = 10_000;

    uint256 constant MAKERS = 3;
    uint256 constant INTENTS = 6;
    uint256 constant MINT = 100_000_000e18;

    /// @dev Maker 2 is a contract wallet. It has no key, so it signs through ERC-1271 and it
    ///      keeps its funds in its own custody: `deposit` and `withdraw` are calls it cannot
    ///      make for itself.
    uint256 constant WALLET_MAKER = 2;

    address[MAKERS] public makers;
    uint256[MAKERS] private makerKeys;
    SmartWallet public wallet;

    /// @dev Private, not public. A public array of structs makes solc write a getter returning
    ///      every field of one, and `Intent` is now wide enough that the encoder for that getter
    ///      runs the legacy pipeline out of stack under `forge coverage --ir-minimum`. Nothing
    ///      reads it from outside.
    ProveSettlement.Intent[] private intents;
    bytes[] public signatures;

    address[2] public executors = [address(0xE3), address(0xE4)];
    address public constant FEE_TO = address(0xF3);

    PayingExecutor public bot;

    /// @notice What the input token taxes right now, as this handler last set it.
    uint256 public taxBps;
    /// @notice Whether the input token answers its transfers with no data at all.
    bool public silent;

    /// @notice Every unit of the input token that ever existed. The tax burns, so the supply
    ///         falls, and the fall is the ghost's business to predict.
    uint256 public immutable initialTaxSupply;

    // ── Ghost books ──────────────────────────────────────────────────────────

    /// @notice Every wei of the input token the fills booked as taken.
    uint256 public ghostTakes;
    /// @notice The part of that the token burned on the way to the executor.
    uint256 public ghostReleaseTax;
    /// @notice Every wei the token has burned, on any leg: deposits, releases, withdrawals.
    uint256 public ghostTaxBurned;
    /// @notice What the makers have parted with, tax included.
    uint256 public ghostMakerDebit;
    /// @notice Escrow the contract has been told to hold, less what it has paid out.
    uint256 public ghostEscrowNet;
    /// @notice The output the fills owed the makers, worked out from the signed curve less the
    ///         fee the intent carves out of it.
    uint256 public ghostOutOwed;
    /// @notice The curve's own number for those fills, before the split — what the executors
    ///         parted with, which no rate may move.
    uint256 public ghostOutGross;
    /// @notice The output the contract said it delivered.
    uint256 public ghostOutReceived;

    uint256 public callsFill;
    uint256 public callsDust;
    uint256 public callsCallback;
    uint256 public callsDeposit;
    uint256 public callsWithdraw;
    uint256 public callsCancel;
    uint256 public callsQuirks;
    uint256 public callsClaim;

    constructor(ProveSettlement _settlement) {
        settlement = _settlement;

        // This contract deploys them, because only the deployer may work the switches.
        taxIn = new WeirdToken("Taxed In", "TXI", 18);
        outSix = new WeirdToken("Six Out", "SIX", 6);

        address relayer = _settlement.relayer();

        bot = new PayingExecutor();
        outSix.mint(address(bot), 1_000_000e6);
        bot.approveMax(address(outSix), relayer);

        for (uint256 m = 0; m < MAKERS; m++) {
            (address who, uint256 key) = makeAddrAndKey(string.concat("weird", vm.toString(m)));
            makerKeys[m] = key;
            if (m == WALLET_MAKER) {
                // The key stays: the wallet recovers it out of the signature and answers for it.
                wallet = new SmartWallet(who);
                makers[m] = address(wallet);
                taxIn.mint(address(wallet), MINT);
                wallet.approveToken(address(taxIn), relayer, type(uint256).max);
            } else {
                makers[m] = who;
                taxIn.mint(who, MINT);
                vm.prank(who);
                taxIn.approve(relayer, type(uint256).max);
            }
        }
        initialTaxSupply = taxIn.totalSupply();

        for (uint256 e = 0; e < executors.length; e++) {
            outSix.mint(executors[e], 1_000_000e6);
            vm.prank(executors[e]);
            outSix.approve(relayer, type(uint256).max);
        }

        for (uint256 k = 0; k < INTENTS; k++) {
            uint256 m = k % MAKERS;
            bool escrow = m != WALLET_MAKER && k % 2 == 1;
            bool small = k == 5;
            uint256 amountIn = small ? 1e18 : (k + 1) * 1_000e18;
            // A hundred units of a six-decimal token is a hundred millionths of one token. The
            // fee on it is one wei, and one wei is the number the split has to divide.
            uint256 minOut = small ? 100 : (k + 1) * 20e6;

            ProveSettlement.Intent memory i = ProveSettlement.Intent({
                maker: makers[m],
                recipient: makers[m],
                tokenIn: address(taxIn),
                tokenOut: address(outSix),
                amountIn: amountIn,
                minOutStart: minOut,
                minOutEnd: k % 3 == 1 ? minOut / 2 : minOut,
                startTime: uint64(block.timestamp),
                endTime: uint64(block.timestamp + (escrow ? 30 days : 1 hours)),
                executor: address(0),
                feeConfig: feeCfg(k % 2 == 1 ? FEE_TO : address(0)),
                feeRate: 0,
                feeRateIn: 0,
                feeRateProceeds: k == 3 ? uint64(0.0025e18) : uint64(0),
                minFill: 0,
                authNonce: bytes32(0),
                flags: (k == 4 ? 0 : settlement.FLAG_PARTIAL())
                    | (escrow ? settlement.FLAG_ESCROW() : 0),
                nonce: 7_000 + k,
                curve: bytes32(0)
            });
            intents.push(i);

            (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKeys[m], settlement.hashIntent(i));
            signatures.push(abi.encodePacked(r, s, v));
        }
    }

    function intentCount() external view returns (uint256) {
        return intents.length;
    }

    function intentAt(uint256 k) external view returns (ProveSettlement.Intent memory) {
        return intents[k];
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    function fillSome(uint256 which, uint256 takeSeed, uint256 whoSeed) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];

        (uint256 remaining, bool live) = availableOf(settlement, i);
        if (!live) return;
        uint256 take =
            i.flags & settlement.FLAG_PARTIAL() != 0 ? bound(takeSeed, 1, remaining) : remaining;
        if (i.flags & settlement.FLAG_ESCROW() != 0) {
            if (settlement.reserved(settlement.hashIntent(i)) < take) return;
        }

        uint256 delivered = settlement.quote(i, take, block.timestamp).delivered;

        vm.prank(executors[whoSeed % executors.length]);
        try settlement.fill(i, signatures[k], take, ANY_FEE) {
            callsFill++;
            _bookFill(i, take, delivered);
        } catch {}
    }

    /// @notice A one-wei take, so the run reaches the fee that rounds to a single wei. A uniform
    ///         draw over the remainder never lands there.
    function fillDust(uint256 which, uint256 whoSeed) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];
        if (i.flags & settlement.FLAG_PARTIAL() == 0) return;

        (, bool live) = availableOf(settlement, i);
        if (!live) return;
        if (i.flags & settlement.FLAG_ESCROW() != 0) {
            if (settlement.reserved(settlement.hashIntent(i)) == 0) return;
        }

        uint256 delivered = settlement.quote(i, 1, block.timestamp).delivered;

        vm.prank(executors[whoSeed % executors.length]);
        try settlement.fill(i, signatures[k], 1, ANY_FEE) {
            callsDust++;
            _bookFill(i, 1, delivered);
        } catch {}
    }

    /// @notice The callback path, where the executor is a contract and holds no inventory of the
    ///         input token until the contract hands it over — short by the tax.
    function fillViaCallback(uint256 which, uint256 takeSeed) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];

        (uint256 remaining, bool live) = availableOf(settlement, i);
        if (!live) return;
        uint256 take =
            i.flags & settlement.FLAG_PARTIAL() != 0 ? bound(takeSeed, 1, remaining) : remaining;
        if (i.flags & settlement.FLAG_ESCROW() != 0) {
            if (settlement.reserved(settlement.hashIntent(i)) < take) return;
        }

        uint256 delivered = settlement.quote(i, take, block.timestamp).delivered;

        try bot.settle(settlement, i, signatures[k], take, "", ANY_FEE) {
            callsCallback++;
            _bookFill(i, take, delivered);
        } catch {}
    }

    function depositEscrow(uint256 which, uint256 amount) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];
        if (i.flags & settlement.FLAG_ESCROW() == 0) return;

        uint256 value = bound(amount, 1, 1_000_000e18);
        if (taxIn.balanceOf(i.maker) < value) return;

        vm.prank(i.maker);
        try settlement.deposit(i, value) {
            callsDeposit++;
            uint256 burned = _tax(value);
            // The maker sends `value` and the reservation holds what survives the transfer.
            // `deposit` credits the received amount, so a taxed deposit under-funds the intent
            // rather than over-crediting it.
            ghostEscrowNet += value - burned;
            ghostTaxBurned += burned;
            ghostMakerDebit += value;
        } catch {}
    }

    function withdrawEscrow(uint256 which) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];
        uint256 before = settlement.reserved(settlement.hashIntent(i));

        vm.prank(i.maker);
        try settlement.withdraw(i) {
            callsWithdraw++;
            uint256 burned = _tax(before);
            ghostEscrowNet -= before;
            ghostTaxBurned += burned;
            ghostMakerDebit -= before - burned;
        } catch {}
    }

    function cancelOne(uint256 which) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];
        vm.prank(i.maker);
        try settlement.cancel(i) {
            callsCancel++;
        } catch {}
    }

    /**
     * @notice Change how the input token misbehaves, mid-sequence.
     *
     * A token that starts taxing between one fill and the next is the case a fixture cannot
     * express. The rate stays under ten per cent, because a rate near the whole makes every
     * escrow release starve the reservation and the run stops exploring.
     */
    function setTokenQuirks(uint256 taxSeed, uint256 silentSeed) external {
        uint16 bps = uint16(bound(taxSeed, 0, 1_000));
        bool quiet = silentSeed % 2 == 1;
        taxIn.setFeeBps(bps);
        taxIn.setSilent(quiet);
        taxBps = bps;
        silent = quiet;
        callsQuirks++;
    }

    /// @notice The one destination this handler names empties its book, mid-run. Without it the
    ///         invariant only ever sees a book that grows; the fee never moves during a fill any
    ///         more, so this is the only thing that makes it fall.
    function claimFees(uint256) external {
        try settlement.claim(singleConfig(FEE_TO), address(outSix)) returns (uint256 paid) {
            if (paid > 0) callsClaim++;
            _claimed(FEE_TO, address(outSix), paid);
        } catch {}
    }

    function skipTime(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 2 days));
    }

    // ── Books ────────────────────────────────────────────────────────────────

    /// @dev What the token keeps out of a transfer of `value`. The token's own arithmetic,
    ///      written out here, so the ghost predicts the burn instead of reading it back.
    function _tax(uint256 value) private view returns (uint256) {
        return (value * taxBps) / TAX_BPS;
    }

    /// @dev The signed curve, from the terms. Never `quote`.
    function _owed(ProveSettlement.Intent memory i, uint256 take) private view returns (uint256) {
        uint256 rate;
        if (block.timestamp <= i.startTime || i.minOutEnd == i.minOutStart) {
            rate = i.minOutStart;
        } else if (block.timestamp >= i.endTime) {
            rate = i.minOutEnd;
        } else {
            uint256 span = uint256(i.endTime) - uint256(i.startTime);
            uint256 elapsed = block.timestamp - uint256(i.startTime);
            rate = i.minOutStart - ((i.minOutStart - i.minOutEnd) * elapsed) / span;
        }
        uint256 n = take * rate;
        return n == 0 ? 0 : (n - 1) / i.amountIn + 1;
    }

    function _bookFill(ProveSettlement.Intent memory i, uint256 take, uint256 delivered) private {
        uint256 gross = _owed(i, take);
        uint256 charged = _bookFee(i.feeConfig, address(outSix), i.feeRateProceeds, gross);
        ghostOutReceived += delivered;
        ghostOutGross += gross;
        ghostOutOwed += gross - charged;

        uint256 burned = _tax(take);
        ghostTakes += take;
        ghostReleaseTax += burned;
        ghostTaxBurned += burned;

        if (i.flags & settlement.FLAG_ESCROW() != 0) {
            // The escrow pays the tax out of the reservation, so the contract parts with the
            // whole `take` and the executor still receives less.
            ghostEscrowNet -= take;
        } else {
            ghostMakerDebit += take;
        }
    }
}
