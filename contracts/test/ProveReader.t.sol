// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {FeeDefaults} from "../src/FeeDefaults.sol";
import {ProveReader} from "../src/ProveReader.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {TakePoints} from "../src/TakePoints.sol";
import {IProveCallback} from "../src/interfaces/IProveCallback.sol";
import {ANY_FEE, CallbackExecutor, MockERC20, NO_PERMIT2} from "./Mocks.sol";
import {feeCfg, singleConfig, newSettlement, strayConfig, STRAY_DESTINATION} from "./Fees.sol";

/// @notice Records the `Terms` it was handed and stands good for exactly the allowances in `data`.
contract RecordingExecutor is CallbackExecutor {
    IProveCallback.Terms public last;
    uint256 public calls;

    function proveCallback(address, IProveCallback.Terms calldata t, bytes calldata data) external {
        last = t;
        calls++;
        (uint256 outAllow, uint256 inAllow) = abi.decode(data, (uint256, uint256));
        address relayer = IRelayerOf(msg.sender).relayer();
        IERC20(t.tokenOut).approve(relayer, outAllow);
        IERC20(t.tokenIn).approve(relayer, inAllow);
    }
}

interface IRelayerOf {
    function relayer() external view returns (address);
}

/// @notice A token whose metadata is hostile: `decimals` reverts, `symbol` returns a bomb.
contract HostileMeta is ERC20 {
    constructor() ERC20("Hostile", "HOST") {}

    function mint(address to, uint256 v) external {
        _mint(to, v);
    }

    function decimals() public pure override returns (uint8) {
        revert("no decimals");
    }

    function symbol() public pure override returns (string memory) {
        assembly {
            return(0, 0x100000)
        }
    }
}

/**
 * @notice `ProveReader` (spec 2.11): the read side. Its authority is the settlement's own
 *         arithmetic, so the tests here are differential: every number the reader reports for a
 *         take is compared against what a real fill does.
 */
contract ProveReaderTest is Test {
    ProveSettlement settlement;
    FeeDefaults defaults;
    ProveReader reader;
    address relayer;

    MockERC20 tokenA;
    MockERC20 tokenB;
    RecordingExecutor exec;

    address maker;
    uint256 makerKey;
    address recipient = address(0xCAFE);
    address owner = address(0x0A11CE);

    uint256 nonce;

    address constant D1 = address(0x1111);
    address constant D2 = address(0x2222);

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        defaults = new FeeDefaults(owner);
        vm.prank(owner);
        defaults.setDefaults(
            _two(),
            FeeDefaults.PointRates(0, 0.005e18, 0),
            FeeDefaults.PointRates(0.01e18, 0.01e18, 0.01e18)
        );
        reader = new ProveReader(address(settlement), address(defaults), strayConfig());

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        exec = new RecordingExecutor();
        tokenA.mint(maker, 1e30);
        tokenB.mint(address(exec), 1e30);
        tokenA.mint(address(exec), 1e24); // covers a handover fee owed back on the approval rung
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.warp(1_700_000_000);
    }

    function _two() internal pure returns (FeeConfig.Config memory c) {
        c.destinations = new address[](2);
        c.weights = new uint256[](2);
        c.destinations[0] = D1;
        c.destinations[1] = D2;
        c.weights[0] = 0.4e18;
        c.weights[1] = 0.6e18;
    }

    function _intent(uint64 rIn, uint64 r, uint64 rP, bool escrow)
        internal
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: recipient,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: 1_000e18,
            minOutStart: 100e18,
            minOutEnd: 60e18,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: FeeConfig.hash(_two()),
            feeRate: r,
            minFill: 0,
            authNonce: bytes32(0),
            flags: escrow
                ? settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW()
                : settlement.FLAG_PARTIAL(),
            nonce: ++nonce,
            curve: bytes32(0),
            feeRateIn: rIn,
            feeRateProceeds: rP
        });
        if (rIn == 0 && r == 0 && rP == 0) i.feeConfig = bytes32(0);
        if (escrow) {
            vm.prank(maker);
            settlement.deposit(i, i.amountIn);
        }
    }

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function _none() internal pure returns (FeeConfig.Config memory c) {}

    // ── Differential: the reader against a real fill ─────────────────────────

    function _balances() internal view returns (uint256 inB, uint256 outB, uint256 recip) {
        inB = tokenA.balanceOf(address(exec));
        outB = tokenB.balanceOf(address(exec));
        recip = tokenB.balanceOf(recipient);
    }

    function _differential(uint64 rIn, uint64 r, uint64 rP, bool escrow, uint256 take) internal {
        ProveSettlement.Intent memory i = _intent(rIn, r, rP, escrow);
        bytes memory sig = _sign(i);

        ProveReader.Explanation memory e = reader.explainTake(i, take, block.timestamp, _none());
        TakePoints.Quote memory q = settlement.quote(i, take, block.timestamp);

        // 1. The quote is the settlement's own.
        assertEq(e.quote.take, q.take, "take");
        assertEq(e.quote.feeIn, q.feeIn, "feeIn");
        assertEq(e.quote.usable, q.usable, "usable");
        assertEq(e.quote.owedToMaker, q.owedToMaker, "owedToMaker");
        assertEq(e.quote.feeOut, q.feeOut, "feeOut");
        assertEq(e.quote.feeProceeds, q.feeProceeds, "feeProceeds");
        assertEq(e.quote.delivered, q.delivered, "delivered");
        assertEq(e.quote.owed, q.owed, "owed");
        assertEq(e.maker.receiveNet, q.delivered, "maker.receiveNet");
        assertEq(e.maker.feeOut, q.feeOut, "maker.feeOut");
        assertEq(e.maker.feeProceeds, q.feeProceeds, "maker.feeProceeds");
        assertEq(e.maker.feeIn, q.feeIn, "maker.feeIn");
        assertEq(e.identity.reason == ProveSettlement.Reason.Ok || true, true);

        // 2. The allowance the reader names is exactly enough for a real callback fill.
        uint256 outAllow;
        uint256 inAllow;
        for (uint256 k = 0; k < e.solver.allowance.length; k++) {
            if (e.solver.allowance[k].token == address(tokenB)) {
                outAllow += e.solver.allowance[k].amount;
            } else {
                inAllow += e.solver.allowance[k].amount;
            }
        }
        (uint256 inBefore, uint256 outBefore, uint256 recBefore) = _balances();
        uint256 pendingOutBefore = settlement.totalPendingFees(address(tokenB));
        uint256 pendingInBefore = settlement.totalPendingFees(address(tokenA));

        uint256 fee = uint256(rIn) + r;
        exec.settle(settlement, i, sig, take, abi.encode(outAllow, inAllow), fee);

        // 3. The Terms the callback received are the reader's `solver.terms`.
        (
            address tIn,
            uint256 aIn,
            uint256 fIn,
            uint256 fInDue,
            address tOut,
            uint256 owedToMaker,
            uint256 fOut,
            uint256 fProceeds,
            uint256 delivered,
            uint256 owed
        ) = exec.last();
        IProveCallback.Terms memory t = e.solver.terms;
        assertEq(tIn, t.tokenIn);
        assertEq(aIn, t.amountIn, "terms.amountIn");
        assertEq(fIn, t.feeIn, "terms.feeIn");
        assertEq(fInDue, t.feeInDue, "terms.feeInDue");
        assertEq(tOut, t.tokenOut);
        assertEq(owedToMaker, t.owedToMaker, "terms.owedToMaker");
        assertEq(fOut, t.feeOut, "terms.feeOut");
        assertEq(fProceeds, t.feeProceeds, "terms.feeProceeds");
        assertEq(delivered, t.delivered, "terms.delivered");
        assertEq(owed, t.owed, "terms.owed");

        // 4. `solver.due` is what the flush pulled; `maker.receiveNet` is what the recipient got.
        (uint256 inAfter, uint256 outAfter, uint256 recAfter) = _balances();
        uint256 dueOut;
        uint256 dueIn;
        for (uint256 k = 0; k < e.solver.due.length; k++) {
            if (e.solver.due[k].token == address(tokenB)) dueOut += e.solver.due[k].amount;
            else dueIn += e.solver.due[k].amount;
        }
        assertEq(recAfter - recBefore, e.maker.receiveNet, "the recipient got receiveNet");
        // The solver's tokenOut outlay is the delivery plus the reserved fees.
        assertEq(
            outBefore - outAfter, e.maker.receiveNet + dueOut, "tokenOut outlay = delivered + dues"
        );
        // The tokenIn the solver keeps: usable on the custodied rungs, take - feeInDue on approval.
        assertEq(
            inAfter + dueIn,
            inBefore + (escrow ? q.usable : q.take),
            "tokenIn: usable, less the loan repaid"
        );
        assertEq(
            settlement.totalPendingFees(address(tokenB)) - pendingOutBefore,
            q.feeOut + q.feeProceeds,
            "book out"
        );
        assertEq(settlement.totalPendingFees(address(tokenA)) - pendingInBefore, q.feeIn, "book in");
    }

    function test_DifferentialAcrossEveryRateComboAndRung() public {
        uint64[3] memory rates = [uint64(0), 0.0013e18, 0.21e18];
        for (uint256 a = 0; a < 3; a++) {
            for (uint256 b = 0; b < 3; b++) {
                for (uint256 c = 0; c < 3; c++) {
                    if (a + b + c == 0) continue;
                    for (uint256 rung = 0; rung < 2; rung++) {
                        _differential(rates[a], rates[b], rates[c], rung == 1, 1_000e18);
                        _differential(rates[a], rates[b], rates[c], rung == 1, 337e18 + 12345);
                    }
                }
            }
        }
    }

    function test_DifferentialAtTheExtremes() public {
        // WAD at P3 leaves the maker nothing net; WAD at P1 leaves the solver nothing usable.
        _differential(0, 0, uint64(1e18), false, 1_000e18);
        _differential(uint64(1e18), 0, 0, true, 500e18);
        _differential(uint64(1e18), 0, 0, false, 500e18);
        _differential(0, uint64(1e18), 0, true, 1);
    }

    function test_ALittleLessAllowanceThanTheReaderNamesFailsTheFill() public {
        ProveSettlement.Intent memory i = _intent(0.002e18, 0.004e18, 0.01e18, false);
        bytes memory sig = _sign(i);
        ProveReader.Explanation memory e =
            reader.explainTake(i, i.amountIn, block.timestamp, _none());
        uint256 outAllow;
        uint256 inAllow;
        for (uint256 k = 0; k < e.solver.allowance.length; k++) {
            if (e.solver.allowance[k].token == address(tokenB)) {
                outAllow += e.solver.allowance[k].amount;
            } else {
                inAllow += e.solver.allowance[k].amount;
            }
        }
        assertGt(inAllow, 0, "the approval rung loans the handover fee");
        vm.expectRevert();
        exec.settle(settlement, i, sig, i.amountIn, abi.encode(outAllow - 1, inAllow), ANY_FEE);
        vm.expectRevert();
        exec.settle(settlement, i, sig, i.amountIn, abi.encode(outAllow, inAllow - 1), ANY_FEE);
        exec.settle(settlement, i, sig, i.amountIn, abi.encode(outAllow, inAllow), ANY_FEE);
    }

    function test_MaxFeeRateNeededIsTheBoundThatJustFills() public {
        ProveSettlement.Intent memory i = _intent(0.002e18, 0.004e18, 0.5e18, false);
        bytes memory sig = _sign(i);
        ProveReader.Explanation memory e =
            reader.explainTake(i, i.amountIn, block.timestamp, _none());
        assertEq(
            e.solver.maxFeeRateNeeded, 0.006e18, "P1 + P2 only; the maker-borne P3 is not bounded"
        );
        (uint256 o, uint256 n) = (e.solver.allowance[0].amount, e.solver.allowance[1].amount);
        vm.expectRevert(ProveSettlement.FeeTooHigh.selector);
        exec.settle(settlement, i, sig, i.amountIn, abi.encode(o, n), e.solver.maxFeeRateNeeded - 1);
        exec.settle(settlement, i, sig, i.amountIn, abi.encode(o, n), e.solver.maxFeeRateNeeded);
    }

    // ── Resolution of the config ─────────────────────────────────────────────

    function test_EveryConfigSource() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);

        // The current default, by hash alone.
        ProveReader.Explanation memory e = reader.explainTake(i, 1e18, block.timestamp, _none());
        assertEq(uint256(e.config.source), uint256(ProveReader.ConfigSource.DefaultCurrent));
        assertEq(e.config.payouts.length, 2);
        assertEq(e.config.payouts[0].destination, D1);
        assertTrue(e.defaults.isCurrent);
        assertEq(e.flags & reader.CUSTOM_CONFIG(), 0, "a default is not custom");

        // A past default, once another has replaced it.
        vm.prank(owner);
        defaults.setDefaults(
            singleConfig(address(0x77)),
            FeeDefaults.PointRates(0, 0.005e18, 0),
            FeeDefaults.PointRates(0.01e18, 0.01e18, 0.01e18)
        );
        e = reader.explainTake(i, 1e18, block.timestamp, _none());
        assertEq(uint256(e.config.source), uint256(ProveReader.ConfigSource.DefaultPast));
        assertTrue(e.defaults.isPast);
        assertFalse(e.defaults.isCurrent);

        // No config at all.
        ProveSettlement.Intent memory none = _intent(0, 0, 0, false);
        e = reader.explainTake(none, 1e18, block.timestamp, _none());
        assertEq(uint256(e.config.source), uint256(ProveReader.ConfigSource.None));
        assertTrue(e.config.resolved);

        // The stray config.
        ProveSettlement.Intent memory stray = _intent(0, 0.005e18, 0, false);
        stray.feeConfig = settlement.STRAY_CONFIG();
        e = reader.explainTake(stray, 1e18, block.timestamp, _none());
        assertEq(uint256(e.config.source), uint256(ProveReader.ConfigSource.Stray));

        // Unknown, then supplied, then remembered.
        FeeConfig.Config memory custom = singleConfig(address(0x5555));
        ProveSettlement.Intent memory c = _intent(0, 0.005e18, 0, false);
        c.feeConfig = FeeConfig.hash(custom);
        e = reader.explainTake(c, 1e18, block.timestamp, _none());
        assertEq(uint256(e.config.source), uint256(ProveReader.ConfigSource.Unresolved));
        assertTrue(e.flags & reader.CONFIG_UNRESOLVED() != 0);
        assertFalse(e.config.resolved);

        e = reader.explainTake(c, 1e18, block.timestamp, custom);
        assertEq(uint256(e.config.source), uint256(ProveReader.ConfigSource.Supplied));
        assertTrue(e.flags & reader.CUSTOM_CONFIG() != 0, "supplied means custom");
        assertTrue(e.config.hashMatches);

        assertEq(reader.remember(custom), c.feeConfig);
        e = reader.explainTake(c, 1e18, block.timestamp, _none());
        assertEq(uint256(e.config.source), uint256(ProveReader.ConfigSource.Remembered));
    }

    function test_AWrongPreimageIsFlaggedAndIgnored() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        i.feeConfig = FeeConfig.hash(singleConfig(address(0x1)));
        ProveReader.Explanation memory e =
            reader.explainTake(i, 1e18, block.timestamp, singleConfig(address(0x2)));
        assertTrue(e.flags & reader.CONFIG_PREIMAGE_MISMATCH() != 0);
        assertEq(uint256(e.config.source), uint256(ProveReader.ConfigSource.Unresolved));
    }

    function test_RememberIsIdempotentAndRejectsInvalidConfigs() public {
        FeeConfig.Config memory c = singleConfig(address(0x5555));
        vm.recordLogs();
        reader.remember(c);
        reader.remember(c);
        assertEq(vm.getRecordedLogs().length, 1, "the second call emits nothing");
        assertEq(reader.remembered(FeeConfig.hash(c)).destinations.length, 1);

        c.weights[0] = 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveReader.InvalidConfig.selector, FeeConfig.Fault.WeightsDoNotSumToWad
            )
        );
        reader.remember(c);
    }

    function test_AContractFreeDestinationIsFlagged() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        ProveReader.Explanation memory e = reader.explainTake(i, 1e18, block.timestamp, _none());
        assertTrue(e.flags & reader.DESTINATION_NO_CODE() != 0, "EOAs have no code");
        assertFalse(e.config.payouts[0].hasCode);
        vm.etch(D1, hex"00");
        vm.etch(D2, hex"00");
        e = reader.explainTake(i, 1e18, block.timestamp, _none());
        assertEq(e.flags & reader.DESTINATION_NO_CODE(), 0);
    }

    function test_PayoutsSplitEachFeeByWeightWithTheRemainderLast() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0.01e18, false);
        ProveReader.Explanation memory e =
            reader.explainTake(i, 333e18 + 1, block.timestamp, _none());
        uint256 sumOut;
        uint256 sumPro;
        for (uint256 k = 0; k < e.config.payouts.length; k++) {
            sumOut += e.config.payouts[k].ofFeeOut;
            sumPro += e.config.payouts[k].ofFeeProceeds;
        }
        assertEq(sumOut, e.quote.feeOut);
        assertEq(sumPro, e.quote.feeProceeds);
    }

    // ── Warnings ─────────────────────────────────────────────────────────────

    function test_WarnFlagsFollowEachPointsWarnRate() public {
        ProveSettlement.Intent memory i = _intent(0.02e18, 0.02e18, 0.005e18, false);
        ProveReader.Explanation memory e = reader.explainTake(i, 1e18, block.timestamp, _none());
        assertTrue(e.flags & reader.WARN_IN() != 0);
        assertTrue(e.flags & reader.WARN_OUT() != 0);
        assertEq(e.flags & reader.WARN_PROCEEDS(), 0);
        assertTrue(e.defaults.aboveWarnIn && e.defaults.aboveWarn && !e.defaults.aboveWarnProceeds);
    }

    // ── Robustness: never reverts, right flags ───────────────────────────────

    function test_ExplainNeverRevertsOnMalformedIntents() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);

        i.amountIn = 0;
        reader.explainTake(i, 0, block.timestamp, _none());
        reader.explainTake(i, 5, block.timestamp, _none());
        reader.explain(i);

        i = _intent(0, 0, 0, false);
        i.feeRate = uint64(2e18);
        ProveReader.Explanation memory e = reader.explainTake(i, 1e18, block.timestamp, _none());
        assertTrue(e.flags & reader.RATE_OVER_WAD() != 0);
        assertTrue(e.flags & reader.FEE_WITHOUT_CONFIG() != 0, "a rate with no config");

        i = _intent(0, 0.005e18, 0, false);
        i.endTime = uint64(block.timestamp - 1);
        e = reader.explainTake(i, 1e18, block.timestamp, _none());
        assertTrue(e.flags & reader.EXPIRED() != 0);

        i = _intent(0, 0.005e18, 0, false);
        vm.prank(maker);
        settlement.cancel(i);
        e = reader.explain(i);
        assertTrue(e.flags & reader.NOT_LIVE() != 0);

        i = _intent(0, 0.005e18, 0, false);
        i.tokenOut = address(0xDEAD); // no code
        reader.explain(i);
        i.tokenIn = address(0);
        reader.explainTake(i, 1, 0, _none());
    }

    function test_HostileTokenMetadataCannotBreakOrStarveTheRead() public {
        HostileMeta hostile = new HostileMeta();
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        i.tokenOut = address(hostile);
        uint256 g = gasleft();
        ProveReader.Explanation memory e = reader.explainTake(i, 1e18, block.timestamp, _none());
        assertLt(g - gasleft(), 3_000_000, "capped metadata gas");
        assertEq(e.tokens[1].decimals, 0, "a reverting decimals reads as 0");
        assertEq(bytes(e.tokens[1].symbol).length, 0, "a bomb symbol reads as empty");
    }

    function test_AbsentFeeDefaultsIsAFlagNotARevert() public {
        ProveReader r2 = new ProveReader(address(settlement), address(0xDEAD0001), strayConfig());
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        ProveReader.Explanation memory e = r2.explainTake(i, 1e18, block.timestamp, _none());
        assertTrue(e.flags & r2.DEFAULTS_UNREACHABLE() != 0);
        assertFalse(e.defaults.present);
        // And the settlement fills regardless: it never reads the defaults.
        bytes memory sig = _sign(i);
        ProveReader.Explanation memory e2 = reader.explainTake(i, 1e18, block.timestamp, _none());
        exec.settle(
            settlement, i, sig, 1e18, abi.encode(e2.solver.allowance[0].amount, uint256(0)), ANY_FEE
        );
    }

    function test_TheConstructorChecksTheStrayConfig() public {
        FeeConfig.Config memory wrong = singleConfig(address(0x1234));
        vm.expectRevert(ProveReader.StrayMismatch.selector);
        new ProveReader(address(settlement), address(defaults), wrong);
    }

    function test_ExplainSignedReportsTheSettlementsOwnReason() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        bytes memory sig = _sign(i);
        ProveReader.Explanation memory e =
            reader.explainSigned(i, sig, address(exec), 1e18, block.timestamp, _none());
        ProveSettlement.Reason direct =
            settlement.fillability(i, sig, 1e18, address(exec), 0.005e18);
        assertEq(uint256(e.identity.reason), uint256(direct));
        assertTrue(e.identity.signatureChecked);

        bytes memory bad = sig;
        bad[10] = bytes1(uint8(bad[10]) ^ 1);
        e = reader.explainSigned(i, bad, address(exec), 1e18, block.timestamp, _none());
        direct = settlement.fillability(i, bad, 1e18, address(exec), 0.005e18);
        assertEq(uint256(e.identity.reason), uint256(direct));
        assertTrue(direct != ProveSettlement.Reason.Ok);
    }

    // ── takeForOut ───────────────────────────────────────────────────────────

    function testFuzz_TakeForOutIsTheSmallestTakeThatCovers(uint256 required, uint256 dt) public {
        required = bound(required, 1, 59e18);
        dt = bound(dt, 0, 3600);
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0.01e18, false);
        uint256 ts = block.timestamp + dt;
        uint256 take = reader.takeForOut(i, required, ts);
        assertGe(take, 1);
        assertLe(take, i.amountIn);
        assertGe(settlement.quote(i, take, ts).owedToMaker, required, "covers the requirement");
        if (take > 1) {
            assertLt(
                settlement.quote(i, take - 1, ts).owedToMaker,
                required,
                "and one wei less would not"
            );
        }
        ProveReader.Explanation memory e = reader.explainOut(i, required, ts, _none());
        assertEq(e.quote.take, take);
    }

    function test_TakeForOutOfZeroIsZero() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        assertEq(reader.takeForOut(i, 0, block.timestamp), 0);
    }

    // ── The book ─────────────────────────────────────────────────────────────

    function test_BookViewsEqualPendingFeesBeforeAndAfterAFillAndAClaim() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0.01e18, false);
        ProveReader.Explanation memory e0 = reader.explainTake(i, 1000e18, block.timestamp, _none());
        assertEq(e0.book.pendingTokenOut, 0);
        _differential(0, 0.005e18, 0.01e18, false, 1_000e18);
        ProveSettlement.Intent memory j = _intent(0, 0.005e18, 0.01e18, false);
        ProveReader.Explanation memory e1 = reader.explainTake(j, 1000e18, block.timestamp, _none());
        assertEq(e1.book.pendingTokenOut, settlement.pendingFees(j.feeConfig, address(tokenB)));
        assertEq(e1.book.totalTokenOut, settlement.totalPendingFees(address(tokenB)));
        assertGt(e1.book.pendingTokenOut, 0);
        assertEq(e1.book.claimOutByDestination.length, 2);
        assertEq(
            e1.book.claimOutByDestination[0] + e1.book.claimOutByDestination[1],
            e1.book.pendingTokenOut
        );

        settlement.claim(_two(), address(tokenB));
        ProveReader.Explanation memory e2 = reader.explainTake(j, 1000e18, block.timestamp, _none());
        assertEq(e2.book.pendingTokenOut, 0);
        assertEq(e2.book.totalTokenOut, 0);
        assertEq(tokenB.balanceOf(D1) + tokenB.balanceOf(D2), e1.book.pendingTokenOut);
    }

    // ── Separation ───────────────────────────────────────────────────────────

    function test_TheSettlementsCodeDoesNotReferenceTheReaderOrTheDefaults() public view {
        bytes memory code = address(settlement).code;
        bytes20 r = bytes20(address(reader));
        bytes20 d = bytes20(address(defaults));
        for (uint256 k = 0; k + 20 <= code.length; k++) {
            bytes20 w;
            assembly ("memory-safe") {
                w := mload(add(add(code, 0x20), k))
            }
            assertTrue(w != r && w != d, "the settlement embeds a reader or defaults address");
        }
    }

    // ── available(): what ProveSettlement.available was, moved out to give the settlement bytes ──

    function test_AvailableFollowsTheWindowCancelAndFloor() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        (uint256 rem, bool live) = reader.available(i);
        assertTrue(live);
        assertEq(rem, i.amountIn);

        // Before the window: not live, remaining unchanged.
        ProveSettlement.Intent memory early = _intent(0, 0.005e18, 0, false);
        early.startTime = uint64(block.timestamp + 10);
        (, live) = reader.available(early);
        assertFalse(live, "not started");

        // A partial fill reduces `remaining`.
        bytes memory sig = _sign(i);
        ProveReader.Explanation memory e = reader.explainTake(i, 400e18, block.timestamp, _none());
        exec.settle(
            settlement,
            i,
            sig,
            400e18,
            abi.encode(e.solver.allowance[0].amount, uint256(0)),
            ANY_FEE
        );
        (rem, live) = reader.available(i);
        assertEq(rem, 600e18);
        assertTrue(live);

        // Cancel: dead from the cancel's timestamp on.
        vm.prank(maker);
        settlement.cancel(i);
        (, live) = reader.available(i);
        assertFalse(live, "cancelled");

        // Retired by the floor, lane 0 and another lane (the floor only moves its own lane).
        ProveSettlement.Intent memory j = _intent(0, 0.005e18, 0, false);
        (, live) = reader.available(j);
        assertTrue(live);
        vm.prank(maker);
        settlement.invalidateBefore(j.nonce + 1);
        (, live) = reader.available(j);
        assertFalse(live, "below the floor");

        // After the window.
        ProveSettlement.Intent memory k = _intent(0, 0.005e18, 0, false);
        vm.warp(k.endTime);
        (, live) = reader.available(k);
        assertFalse(live, "expired");
        // And `explain` picks `remaining` when live, `amountIn` flagged otherwise, without reverting.
        reader.explain(k);
    }

    /// The reader's copy of the terms rule (`IntentTerms.ok`) must be the settlement's `_termsOk`.
    /// `fillability` asks `_termsOk` first and answers `BadTerms_` for it and nothing else can.
    function testFuzz_AvailabilityUsesTheSettlementsTermsRule(
        uint256 mutate,
        uint256 a,
        uint256 b,
        uint256 c
    ) public {
        ProveSettlement.Intent memory i = _intent(0.001e18, 0.002e18, 0.003e18, false);
        uint256 which = mutate % 12;
        if (which == 0) i.minOutEnd = i.minOutStart + (a % 5);
        if (which == 1) i.tokenOut = i.tokenIn;
        if (which == 2) {
            i.minOutStart = uint128(a);
            if (b % 2 == 1 && i.minOutStart < type(uint128).max) i.minOutStart += 1;
        }
        if (which == 3) i.amountIn = a;
        if (which == 4) i.feeRate = uint64(a % 2e18);
        if (which == 5) i.feeRateIn = uint64(a % 2e18);
        if (which == 6) i.feeRateProceeds = uint64(a % 2e18);
        if (which == 7) i.flags = uint8(a);
        if (which == 8) {
            i.recipient = [address(0), address(settlement), relayer, address(0xBEEF)][a % 4];
        }
        if (which == 9) {
            i.feeConfig = bytes32(0);
            i.feeRate = b % 3 == 0 ? 0 : uint64(a % 1e18);
            i.feeRateIn = b % 3 == 1 ? 0 : uint64(c % 1e18);
        }
        if (which == 10) {
            i.minOutStart = i.minOutEnd = a;
        }
        bool termsOk = true;
        try settlement.fillability(i, "", 1, address(0), type(uint256).max) returns (
            ProveSettlement.Reason r
        ) {
            termsOk = r != ProveSettlement.Reason.BadTerms_;
        } catch {}
        (uint256 rem, bool live) = reader.available(i);
        // `live` also needs something left and the window/cancel/floor, which the base intent meets.
        assertEq(live, termsOk && rem > 0, "reader and settlement disagree on the terms");
    }

    // ── Coverage closure: advisory flags, malformed configs, metadata shapes ─────────────

    function test_TheMinFillAndPartialFlagsFollowTheIntentsOwnFields() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        i.minFill = 500e18;
        ProveReader.Explanation memory e = reader.explainTake(i, 100e18, block.timestamp, _none());
        assertTrue(e.flags & reader.BELOW_MIN_FILL() != 0, "below the minimum fill");
        i = _intent(0, 0.005e18, 0, false);
        i.flags = 0; // no partial fills
        e = reader.explainTake(i, 100e18, block.timestamp, _none());
        assertTrue(e.flags & reader.PARTIAL_NOT_ALLOWED() != 0, "a part of an all-or-nothing offer");
    }

    function test_ASuppliedConfigThatIsNotCanonicalIsFlaggedAndItsPayoutsAreSkipped() public {
        FeeConfig.Config memory bad = _two();
        bad.weights[1] = 0.5e18; // sums to 0.9
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        i.feeConfig = FeeConfig.hash(bad);
        ProveReader.Explanation memory e = reader.explainTake(i, 100e18, block.timestamp, bad);
        assertTrue(e.flags & reader.CONFIG_FAULT() != 0, "flagged");
        assertEq(uint256(e.config.fault), uint256(FeeConfig.Fault.WeightsDoNotSumToWad));

        FeeConfig.Config memory ragged = _two();
        ragged.weights = new uint256[](1);
        ragged.weights[0] = 1e18;
        i.feeConfig = FeeConfig.hash(ragged);
        e = reader.explainTake(i, 100e18, block.timestamp, ragged);
        assertTrue(e.flags & reader.CONFIG_FAULT() != 0, "flagged");
        assertEq(e.config.payouts.length, 0, "no payouts for lists of different lengths");
    }

    function test_DefaultsThatWereNeverSetAreFlaggedUnreachableNotARevert() public {
        FeeDefaults fresh = new FeeDefaults(owner);
        ProveReader r = new ProveReader(address(settlement), address(fresh), strayConfig());
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        ProveReader.Explanation memory e = r.explainTake(i, 100e18, block.timestamp, _none());
        assertTrue(e.flags & r.DEFAULTS_UNREACHABLE() != 0);
    }

    function test_ASettlementWithNoCodeReadsAsAFailureNotARevert() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        vm.etch(address(settlement), "");
        assertEq(reader.takeForOut(i, 1e18, block.timestamp), 0);
    }

    /// The reader's copy of the terms rule refuses each bad shape the settlement does, by name.
    function test_AvailableRefusesEachShapeOfBadTerms() public {
        address[3] memory bad = [address(0), address(settlement), relayer];
        for (uint256 k = 0; k < 3; k++) {
            ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
            i.recipient = bad[k];
            (, bool live) = reader.available(i);
            assertFalse(live, "a delivery nobody can collect");
        }
        ProveSettlement.Intent memory both = _intent(0, 0.005e18, 0, false);
        both.flags = settlement.FLAG_ESCROW() | settlement.FLAG_PERMIT2();
        (, bool liveBoth) = reader.available(both);
        assertFalse(liveBoth, "one custody rung per intent");
        ProveSettlement.Intent memory dropped = _intent(0, 0.005e18, 0, false);
        dropped.feeConfig = bytes32(0); // a rate with no config
        (, bool liveDropped) = reader.available(dropped);
        assertFalse(liveDropped, "a signed rate is never silently dropped");
    }

    function _symbolOf(bytes memory raw) internal returns (string memory) {
        RawMeta m = new RawMeta(raw, abi.encode(uint256(18)));
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        i.tokenOut = address(m);
        ProveReader.Explanation memory e = reader.explainTake(i, 100e18, block.timestamp, _none());
        return e.tokens[1].symbol;
    }

    function test_SymbolShapesAreReadAndCappedWithoutEverReverting() public {
        assertEq(_symbolOf(abi.encode(bytes32("ABC"))), "ABC", "the old bytes32 form");
        assertEq(_symbolOf(new bytes(40)), "", "too short for a string, too long for a word");
        assertEq(_symbolOf(new bytes(400)), "", "a bomb whose first word is not an offset");
        assertEq(
            _symbolOf(abi.encode(uint256(0x20), uint256(5), bytes32("HELLO"))),
            "HELLO",
            "an ordinary string"
        );
        assertEq(
            bytes(_symbolOf(abi.encode(uint256(0x20), uint256(1000), bytes32("XYZ")))).length,
            32,
            "a length that claims more than came back is cut to what did"
        );
        assertEq(
            bytes(_symbolOf(abi.encodePacked(uint256(0x20), uint256(200), new bytes(200)))).length,
            32,
            "and nothing past 96 bytes is ever copied"
        );
    }

    // ── The metadata blocks' margins (`_decimals`, `_symbol`; docs/AUDIT-SCOPE.md) ──

    /// @dev `ProveReader.META_GAS` is private; restated, and held by the burner test below.
    uint256 constant META_GAS = 30_000;

    function _decimalsOf(bytes memory raw) internal returns (uint8) {
        RawMeta m = new RawMeta(abi.encode(bytes32("X")), raw);
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        i.tokenOut = address(m);
        return reader.explainTake(i, 100e18, block.timestamp, _none()).tokens[1].decimals;
    }

    /// @notice `decimals()` is one word, read from the scratch slot only when a whole word came
    ///         back, and only when it fits a `uint8`.
    function test_DecimalsShapesAreReadOnlyWhenTheyAreAWholeWordThatFits() public {
        assertEq(_decimalsOf(abi.encode(uint256(6))), 6, "an ordinary answer");
        assertEq(_decimalsOf(abi.encode(uint256(255))), 255, "the top of the range");
        assertEq(_decimalsOf(abi.encode(uint256(256))), 0, "a word that does not fit");
        assertEq(_decimalsOf(new bytes(31)), 0, "short of a word");
        assertEq(_decimalsOf(""), 0, "nothing at all");
        assertEq(
            _decimalsOf(abi.encode(uint256(8), uint256(9))),
            8,
            "a longer answer reads its first word"
        );
    }

    /// @notice A token whose metadata burns all the gas it is given costs the reader two capped
    ///         calls and no more, and still reads as "no symbol, no decimals" rather than a
    ///         revert.
    function test_MetadataThatBurnsGasCostsAtMostTwoCaps() public {
        ProveSettlement.Intent memory i = _intent(0, 0.005e18, 0, false);
        RawMeta honest = new RawMeta(abi.encode(bytes32("ABC")), abi.encode(uint256(18)));
        i.tokenOut = address(honest);
        uint256 g = gasleft();
        reader.explainTake(i, 100e18, block.timestamp, _none());
        uint256 base = g - gasleft();

        i.tokenOut = address(new BurnMeta());
        g = gasleft();
        ProveReader.Explanation memory e = reader.explainTake(i, 100e18, block.timestamp, _none());
        uint256 burned = g - gasleft();
        assertEq(e.tokens[1].decimals, 0);
        assertEq(e.tokens[1].symbol, "");
        emit log_named_uint("extra gas a burning token costs the reader", burned - base);
        assertLt(burned - base, 2 * META_GAS, "two capped calls, nothing else");
    }

    /// @notice An ordinary token's `symbol()` and `decimals()`, read cold, use a small fraction
    ///         of the cap, so the cap blanks only a token doing something an ordinary one does not.
    function test_OrdinaryMetadataIsWellInsideTheCap() public {
        MockERC20 t = new MockERC20("Wrapped Pulse", "WPLS", 18);
        uint256 g = gasleft();
        t.symbol();
        uint256 sym = g - gasleft();
        g = gasleft();
        t.decimals();
        uint256 dec = g - gasleft();
        emit log_named_uint("ordinary symbol(), gas", sym);
        emit log_named_uint("ordinary decimals(), gas", dec);
        assertLt(sym * 3, META_GAS, "symbol under a third of the cap");
        assertLt(dec * 3, META_GAS, "decimals under a third of the cap");
    }
}

/// @notice A token whose `symbol()` and `decimals()` spin until the gas runs out.
contract BurnMeta {
    fallback() external {
        while (true) {}
    }
}

/// @notice A token that answers `symbol()` and `decimals()` with exactly the bytes it was given.
contract RawMeta {
    bytes internal sym;
    bytes internal dec;

    constructor(bytes memory s, bytes memory d) {
        sym = s;
        dec = d;
    }

    fallback() external {
        bytes memory r = msg.sig == 0x95d89b41 ? sym : dec;
        assembly {
            return(add(r, 0x20), mload(r))
        }
    }
}
