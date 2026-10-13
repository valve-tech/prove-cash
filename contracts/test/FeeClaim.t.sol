// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {FeeClaimLib} from "../src/FeeClaimLib.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, MockERC20, NO_PERMIT2} from "./Mocks.sol";
import {feeCfg, singleConfig, newSettlement, strayConfig, STRAY_DESTINATION} from "./Fees.sol";

/// @dev `FeeClaimLib.TRANSFER_GAS` is `internal`; the figure is restated here and pinned by the
///      sweep below, which fails if the guard and the cap stop agreeing.
library FeeClaimLibCap {
    uint256 internal constant TRANSFER_GAS = 200_000;
}

/// @notice A token whose `transfer` misbehaves for chosen recipients, one failure mode each.
contract PickyToken is MockERC20 {
    enum Mode {
        Fine,
        Revert,
        ReturnFalse,
        BurnGas,
        ReturnBomb,
        ReenterClaim,
        NeedsTheCap,
        ReturnTwoWords,
        ReturnShortTrue,
        ReturnTwo
    }

    /// @dev What `NeedsTheCap` insists on finding at entry: 95% of `TRANSFER_GAS`.
    uint256 public constant NEED = 190_000;

    mapping(address => Mode) public modeOf;
    ProveSettlement public settlement;
    /// @dev `gasleft()` at the top of the last `NeedsTheCap` transfer.
    uint256 public entryGas;

    constructor() MockERC20("Picky", "PICK", 18) {}

    function setMode(address who, Mode m) external {
        modeOf[who] = m;
    }

    function arm(ProveSettlement s) external {
        settlement = s;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        uint256 atEntry = gasleft();
        Mode m = modeOf[to];
        if (m == Mode.NeedsTheCap) {
            // A token that needs nearly the whole cap: short of it, the share would be deferred.
            if (atEntry < NEED) revert("starved");
            entryGas = atEntry;
        }
        // Three answers that move nothing, to hold `_tryTransfer`'s reading of the return word.
        if (m == Mode.ReturnTwoWords) {
            // True, followed by a word nobody asked for: still a success.
            super.transfer(to, value);
            assembly {
                mstore(0x00, 1)
                mstore(0x20, 0)
                return(0x00, 0x40)
            }
        }
        if (m == Mode.ReturnShortTrue) {
            // Thirty-one bytes: not a word, so not a `true`, whatever the bytes are.
            assembly {
                mstore(0x00, not(0))
                return(0x00, 31)
            }
        }
        if (m == Mode.ReturnTwo) {
            // One word that is neither 0 nor 1.
            assembly {
                mstore(0x00, 2)
                return(0x00, 0x20)
            }
        }
        if (m == Mode.Revert) revert("blacklisted");
        if (m == Mode.ReturnFalse) return false;
        if (m == Mode.BurnGas) {
            while (true) {}
        }
        if (m == Mode.ReturnBomb) {
            assembly {
                revert(0, 0x400000)
            }
        }
        if (m == Mode.ReenterClaim) {
            // Tries to claim again from inside its own payout. `claim` is non-reentrant.
            (bool ok,) = address(settlement)
                .call(abi.encodeCall(ProveSettlement.claim, (singleConfig(to), address(this))));
            ok;
        }
        return super.transfer(to, value);
    }
}

/**
 * @notice `claim`, `announceFeeConfig` and `sweepUnowned` against a real fill (spec 2.6-2.9).
 *
 * A fill books a fee under the hash its intent signed. `claim` takes the preimage and pays the
 * destinations. A destination that fails does not stop the others: its share is re-booked under
 * `single(destination)` and `claim(single)` pays it later.
 */
contract FeeClaimTest is Test {
    ProveSettlement settlement;
    address relayer;
    MockERC20 tokenA;
    PickyToken tokenB;

    address executor = address(0xE0E);
    address maker;
    uint256 makerKey;

    address constant D1 = address(0x1111);
    address constant D2 = address(0x2222);
    address constant D3 = address(0x3333);

    uint256 nonce;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new PickyToken();
        tokenB.arm(settlement);
        tokenA.mint(maker, 1_000_000e18);
        tokenB.mint(executor, 1_000_000e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);
        vm.warp(1_700_000_000);
    }

    function _cfg3() internal pure returns (FeeConfig.Config memory c) {
        c.destinations = new address[](3);
        c.weights = new uint256[](3);
        c.destinations[0] = D1;
        c.destinations[1] = D2;
        c.destinations[2] = D3;
        c.weights[0] = 0.5e18;
        c.weights[1] = 0.3e18;
        c.weights[2] = 0.2e18;
    }

    /// @dev Fill one intent at 1% proceeds fee under `cfg`; returns the fee booked.
    function _book(FeeConfig.Config memory cfg) internal returns (uint256 fee) {
        ProveSettlement.Intent memory i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: 1_000e18,
            minOutStart: 100e18,
            minOutEnd: 100e18,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: FeeConfig.hash(cfg),
            feeRate: 0,
            minFill: 0,
            authNonce: bytes32(0),
            flags: 0,
            nonce: ++nonce,
            curve: bytes32(0),
            feeRateIn: 0,
            feeRateProceeds: 0.01e18
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        fee = settlement.quote(i, i.amountIn, block.timestamp).feeProceeds;
        vm.prank(executor);
        settlement.fill(i, abi.encodePacked(r, s, v), i.amountIn, ANY_FEE);
    }

    // ── The happy path ───────────────────────────────────────────────────────

    function test_AMultiDestinationClaimPaysEveryShareExactly() public {
        FeeConfig.Config memory cfg = _cfg3();
        uint256 fee = _book(cfg);
        assertEq(fee, 1e18, "1% of 100");
        assertEq(settlement.pendingFees(FeeConfig.hash(cfg), address(tokenB)), fee);

        vm.recordLogs();
        uint256 paid = settlement.claim(cfg, address(tokenB));
        assertEq(paid, fee);
        assertEq(tokenB.balanceOf(D1), 0.5e18);
        assertEq(tokenB.balanceOf(D2), 0.3e18);
        assertEq(tokenB.balanceOf(D3), 0.2e18, "the remainder goes to the last");
        assertEq(settlement.pendingFees(FeeConfig.hash(cfg), address(tokenB)), 0);
        assertEq(settlement.totalPendingFees(address(tokenB)), 0);
        assertEq(settlement.claim(cfg, address(tokenB)), 0, "a second claim pays nothing");
    }

    function test_ClaimIsPermissionlessAndPaysOnlyTheDestinations() public {
        FeeConfig.Config memory cfg = _cfg3();
        uint256 fee = _book(cfg);
        address stranger = address(0xBAD);
        vm.prank(stranger);
        assertEq(settlement.claim(cfg, address(tokenB)), fee);
        assertEq(tokenB.balanceOf(stranger), 0, "the caller earns nothing");
    }

    function test_AWrongPreimageBooksAndPaysNothing() public {
        FeeConfig.Config memory cfg = _cfg3();
        _book(cfg);
        FeeConfig.Config memory other = _cfg3();
        other.weights[0] = 0.6e18;
        other.weights[2] = 0.1e18;
        assertEq(settlement.claim(other, address(tokenB)), 0, "another config's book is empty");
        assertEq(settlement.pendingFees(FeeConfig.hash(cfg), address(tokenB)), 1e18, "untouched");
    }

    function test_EveryFaultRevertsInvalidConfig() public {
        FeeConfig.Config memory c = _cfg3();
        c.weights[2] = 0.19e18;
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveSettlement.InvalidConfig.selector, FeeConfig.Fault.WeightsDoNotSumToWad
            )
        );
        settlement.claim(c, address(tokenB));

        c = _cfg3();
        c.destinations[1] = c.destinations[0];
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveSettlement.InvalidConfig.selector, FeeConfig.Fault.NotAscending
            )
        );
        settlement.claim(c, address(tokenB));
    }

    function test_ATokenWithoutCodeIsRefused() public {
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.claim(_cfg3(), address(0xDEAD));
    }

    function test_TheSettlementAndRelayerCannotBeDestinations() public {
        for (uint256 k = 0; k < 2; k++) {
            FeeConfig.Config memory c = singleConfig(k == 0 ? address(settlement) : relayer);
            vm.expectRevert(
                abi.encodeWithSelector(
                    ProveSettlement.InvalidConfig.selector, FeeConfig.Fault.ReservedDestination
                )
            );
            settlement.claim(c, address(tokenB));
        }
    }

    /// A share that rounds to nothing is skipped, not transferred: a 1-wei fee over three
    /// destinations gives the whole of it to the last, by the remainder rule.
    function test_AShareThatRoundsToZeroIsSkipped() public {
        FeeConfig.Config memory cfg = _cfg3();
        ProveSettlement.Intent memory i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: 1_000e18,
            minOutStart: 100e18,
            minOutEnd: 100e18,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: FeeConfig.hash(cfg),
            feeRate: 0,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL(),
            nonce: ++nonce,
            curve: bytes32(0),
            feeRateIn: 0,
            feeRateProceeds: 0.01e18
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        uint256 take = 1000; // owed 100 wei, fee 1 wei
        assertEq(settlement.quote(i, take, block.timestamp).feeProceeds, 1);
        vm.prank(executor);
        settlement.fill(i, abi.encodePacked(r, s, v), take, ANY_FEE);

        assertEq(settlement.claim(cfg, address(tokenB)), 1);
        assertEq(tokenB.balanceOf(D1), 0);
        assertEq(tokenB.balanceOf(D2), 0);
        assertEq(tokenB.balanceOf(D3), 1, "the remainder goes to the last");
    }

    // ── A single destination that fails reverts and leaves the book intact ───

    function test_ASingleFailingDestinationRevertsAndLeavesTheBook() public {
        FeeConfig.Config memory cfg = singleConfig(D1);
        uint256 fee = _book(cfg);
        tokenB.setMode(D1, PickyToken.Mode.Revert);
        vm.expectRevert();
        settlement.claim(cfg, address(tokenB));
        assertEq(settlement.pendingFees(FeeConfig.hash(cfg), address(tokenB)), fee, "intact");
        tokenB.setMode(D1, PickyToken.Mode.Fine);
        assertEq(settlement.claim(cfg, address(tokenB)), fee, "and claimable once it recovers");
    }

    // ── One failing destination among several: the rest are paid, its share is deferred

    function _deferralCase(PickyToken.Mode mode) internal {
        FeeConfig.Config memory cfg = _cfg3();
        uint256 fee = _book(cfg);
        tokenB.setMode(D2, mode);

        uint256 paid = settlement.claim(cfg, address(tokenB));
        assertEq(paid, fee - 0.3e18, "paid + deferred == amount");
        assertEq(tokenB.balanceOf(D1), 0.5e18, "the others are paid");
        assertEq(tokenB.balanceOf(D3), 0.2e18);
        assertEq(tokenB.balanceOf(D2), 0, "the failing one is not");
        assertEq(
            settlement.pendingFees(FeeConfig.singleHash(D2), address(tokenB)),
            0.3e18,
            "its share is re-booked under single(D2)"
        );
        assertEq(settlement.totalPendingFees(address(tokenB)), 0.3e18, "and the total follows");
        assertEq(
            settlement.pendingFees(FeeConfig.hash(cfg), address(tokenB)), 0, "the cell is empty"
        );

        // Recovery: claim(single) pays it.
        tokenB.setMode(D2, PickyToken.Mode.Fine);
        assertEq(settlement.claim(singleConfig(D2), address(tokenB)), 0.3e18);
        assertEq(tokenB.balanceOf(D2), 0.3e18);
        assertEq(settlement.totalPendingFees(address(tokenB)), 0);
    }

    function test_ARevertingDestinationIsDeferred() public {
        _deferralCase(PickyToken.Mode.Revert);
    }

    function test_AFalseReturningDestinationIsDeferred() public {
        _deferralCase(PickyToken.Mode.ReturnFalse);
    }

    function test_AGasBurnerIsDeferredAndCostsAtMostTheCap() public {
        uint256 g = gasleft();
        _deferralCase(PickyToken.Mode.BurnGas);
        // The whole case, two claims and a fill included, stays far below an unbounded burn.
        assertLt(g - gasleft(), 5_000_000, "the 200k cap holds");
    }

    function test_AReturnBombIsDeferred() public {
        _deferralCase(PickyToken.Mode.ReturnBomb);
    }

    function test_AReenteringDestinationFindsTheDoorLocked() public {
        FeeConfig.Config memory cfg = _cfg3();
        uint256 fee = _book(cfg);
        tokenB.setMode(D2, PickyToken.Mode.ReenterClaim);
        assertEq(settlement.claim(cfg, address(tokenB)), fee, "the transfer still lands");
        assertEq(tokenB.balanceOf(D2), 0.3e18);
        assertEq(settlement.totalPendingFees(address(tokenB)), 0);
    }

    function test_AnUnderSuppliedClaimRevertsInsteadOfRecordingASpuriousDeferral() public {
        FeeConfig.Config memory cfg = _cfg3();
        uint256 fee = _book(cfg);
        // Enough for the outer frames, not for a 200k-capped call to each destination.
        vm.expectRevert();
        settlement.claim{gas: 150_000}(cfg, address(tokenB));
        assertEq(settlement.pendingFees(FeeConfig.hash(cfg), address(tokenB)), fee, "still booked");
        assertEq(
            settlement.pendingFees(FeeConfig.singleHash(D1), address(tokenB)),
            0,
            "no spurious deferral"
        );
        assertEq(settlement.pendingFees(FeeConfig.singleHash(D2), address(tokenB)), 0);
    }

    // ── The capped transfer's margins (`FeeClaimLib._tryTransfer`, docs/AUDIT-SCOPE.md) ──

    /**
     * @notice At every gas budget, a share whose token needs 95% of the cap is paid or the whole
     *         claim reverts. It is never deferred for want of gas.
     *
     * The guard before each share asks for `TRANSFER_GAS + TRANSFER_GAS / 63 + 30_000`, so the
     * capped `CALL` can forward the full 200,000 under EIP-150's 63/64 rule. This sweeps the
     * budget across the edge in 250-gas steps. Wherever the claim completes, the destination
     * must have seen exactly the gas it sees with no limit at all, which is the guard's margin
     * stated as a test rather than as arithmetic.
     */
    function test_AShareThatNeedsNearlyTheWholeCapIsNeverDeferredForWantOfGas() public {
        FeeConfig.Config memory cfg = _cfg3();
        uint256 fee = _book(cfg);
        tokenB.setMode(D2, PickyToken.Mode.NeedsTheCap);
        uint256 snap = vm.snapshotState();

        // Warm-up and reference: with no limit, the destination sees the full cap less its own
        // prologue.
        assertEq(settlement.claim(cfg, address(tokenB)), fee);
        assertEq(settlement.claim(cfg, address(tokenB)), 0);
        vm.revertToState(snap);
        settlement.claim(cfg, address(tokenB));
        uint256 full = tokenB.entryGas();
        assertGe(full, tokenB.NEED(), "unlimited gas meets the need");
        vm.revertToState(snap);

        uint256 paidRuns;
        uint256 revertedRuns;
        uint256 lowest = type(uint256).max;
        for (uint256 b = 200_000; b <= 500_000; b += 250) {
            try settlement.claim{gas: b}(cfg, address(tokenB)) returns (uint256 paid) {
                paidRuns++;
                if (b < lowest) lowest = b;
                assertEq(paid, fee, "every share paid");
                assertEq(
                    settlement.pendingFees(FeeConfig.singleHash(D2), address(tokenB)),
                    0,
                    "never deferred"
                );
                assertEq(tokenB.entryGas(), full, "the destination saw the full cap");
            } catch {
                revertedRuns++;
                assertEq(
                    settlement.pendingFees(FeeConfig.hash(cfg), address(tokenB)), fee, "untouched"
                );
            }
            vm.revertToState(snap);
        }
        assertGt(paidRuns, 0, "the sweep reached budgets that pay");
        assertGt(revertedRuns, 0, "and budgets that refuse");
        emit log_named_uint("lowest budget that pays a three-way claim", lowest);
        emit log_named_uint("gas the needy destination sees at entry", full);
    }

    /// @notice An ordinary transfer to a first-time holder uses a small fraction of the cap, so
    ///         the cap defers only a token that does something an ordinary one does not.
    function test_AnOrdinaryTransferUsesASmallFractionOfTheCap() public {
        MockERC20 plain = new MockERC20("P", "P", 18);
        plain.mint(address(this), 1e18);
        uint256 g = gasleft();
        plain.transfer(address(0xF00D), 1); // cold token, cold sender slot, fresh recipient slot
        uint256 used = g - gasleft();
        emit log_named_uint("ordinary first-time transfer, gas", used);
        assertLt(used * 3, FeeClaimLibCap.TRANSFER_GAS, "under a third of the cap");
    }

    /// @notice The return word: `true` with trailing bytes is a success; 31 bytes, or a word of
    ///         2, is not, and the share is deferred rather than counted as paid.
    function test_TheReturnWordIsReadExactly() public {
        FeeConfig.Config memory cfg = _cfg3();
        uint256 fee = _book(cfg);
        tokenB.setMode(D2, PickyToken.Mode.ReturnTwoWords);
        assertEq(settlement.claim(cfg, address(tokenB)), fee, "true plus a spare word is paid");
        assertEq(tokenB.balanceOf(D2), 0.3e18);

        PickyToken.Mode[2] memory refused =
            [PickyToken.Mode.ReturnShortTrue, PickyToken.Mode.ReturnTwo];
        for (uint256 k = 0; k < 2; k++) {
            uint256 again = _book(cfg);
            tokenB.setMode(D2, refused[k]);
            uint256 before = settlement.pendingFees(FeeConfig.singleHash(D2), address(tokenB));
            assertEq(settlement.claim(cfg, address(tokenB)), again - 0.3e18 * again / fee);
            assertEq(
                settlement.pendingFees(FeeConfig.singleHash(D2), address(tokenB)) - before,
                0.3e18 * again / fee,
                "deferred, not counted as paid"
            );
        }
    }

    // ── announce ─────────────────────────────────────────────────────────────

    function test_AnnounceIsEventOnlyAndRejectsInvalidConfigs() public {
        FeeConfig.Config memory cfg = _cfg3();
        vm.expectEmit(true, false, false, true, address(settlement));
        emit FeeClaimLib.FeeConfigAnnounced(FeeConfig.hash(cfg), cfg.destinations, cfg.weights);
        settlement.announceFeeConfig(cfg);

        cfg.weights[0] = 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveSettlement.InvalidConfig.selector, FeeConfig.Fault.WeightsDoNotSumToWad
            )
        );
        settlement.announceFeeConfig(cfg);
    }

    // ── sweepUnowned ─────────────────────────────────────────────────────────

    function test_ASweepCreditsTheStrayConfigAndMovesNoToken() public {
        tokenB.mint(address(settlement), 5e18);
        uint256 held = tokenB.balanceOf(address(settlement));
        assertEq(settlement.sweepUnowned(address(tokenB)), 5e18);
        assertEq(tokenB.balanceOf(address(settlement)), held, "nothing moved");
        assertEq(settlement.pendingFees(settlement.STRAY_CONFIG(), address(tokenB)), 5e18);
        assertEq(settlement.sweepUnowned(address(tokenB)), 0, "idempotent");
        assertEq(settlement.claim(strayConfig(), address(tokenB)), 5e18);
        assertEq(tokenB.balanceOf(STRAY_DESTINATION), 5e18);
    }

    function test_ASweepNeverTouchesABookedFee() public {
        uint256 fee = _book(_cfg3());
        assertEq(settlement.sweepUnowned(address(tokenB)), 0, "all of it is owed");
        assertEq(settlement.totalPendingFees(address(tokenB)), fee);
    }

    function test_TheStrayConfigIsImmutableAndValid() public view {
        assertEq(settlement.STRAY_CONFIG(), FeeConfig.hash(strayConfig()));
    }

    // ── The library ──────────────────────────────────────────────────────────

    /// @dev `FeeClaimLib` runs by delegatecall from the settlement and must not be able to
    ///      destroy itself or delegate onward. Scanned over the code with PUSH data skipped, and
    ///      stopped before solc's CBOR metadata trailer, whose length is the last two bytes. The
    ///      trailer holds a hash of the build's metadata, which moves with the checkout's path, so
    ///      scanning it failed this test in one worktree and passed it in another (an `0xf4` in the
    ///      IPFS hash, 12 bytes past the last instruction, on 2026-10-05). It is not code.
    function test_TheLibraryHasNoSelfdestructAndNoDelegatecall() public view {
        address lib = _libraryAddress();
        bytes memory code = lib.code;
        assertGt(code.length, 2);
        uint256 trailer =
            (uint256(uint8(code[code.length - 2])) << 8) | uint8(code[code.length - 1]);
        assertLt(trailer + 2, code.length, "no CBOR trailer");
        uint256 end = code.length - trailer - 2;
        for (uint256 at = 0; at < end;) {
            uint8 op = uint8(code[at]);
            assertTrue(op != 0xff, "SELFDESTRUCT");
            assertTrue(op != 0xf4, "DELEGATECALL");
            at += (op >= 0x60 && op <= 0x7f) ? uint256(op) - 0x5f + 1 : 1;
        }
    }

    /// @dev The library's address is a literal in the settlement's runtime code (forge links it
    ///      into the creation code). Find it by deploying a settlement and asking the code for the
    ///      PUSH20 that precedes the delegatecall to `pay`.
    function _libraryAddress() internal view returns (address lib) {
        bytes memory code = address(settlement).code;
        for (uint256 at = 0; at + 21 < code.length;) {
            uint8 op = uint8(code[at]);
            if (op == 0x73) {
                address a;
                assembly ("memory-safe") {
                    a := shr(96, mload(add(add(code, 0x20), add(at, 1))))
                }
                if (a.code.length > 0 && a != address(settlement) && a != relayer) {
                    if (_looksLikeLib(a)) return a;
                }
            }
            at += (op >= 0x60 && op <= 0x7f) ? uint256(op) - 0x5f + 1 : 1;
        }
        revert("library address not found");
    }

    function _looksLikeLib(address a) internal view returns (bool) {
        // The library's `announce(Config)` selector appears in its dispatcher.
        bytes memory c = a.code;
        bytes4 sel = FeeClaimLib.announce.selector;
        for (uint256 i = 0; i + 4 <= c.length; i++) {
            if (c[i] == sel[0] && c[i + 1] == sel[1] && c[i + 2] == sel[2] && c[i + 3] == sel[3]) {
                return true;
            }
        }
        return false;
    }

    // ── The size ─────────────────────────────────────────────────────────────

    function test_TheSettlementFitsEip170WithMargin() public {
        uint256 size = address(settlement).code.length;
        emit log_named_uint("ProveSettlement runtime bytes", size);
        assertLe(size, 24_576, "EIP-170");
        assertLe(size, 24_576 - 1_000, "and at least 1,000 bytes of margin");
    }
}
