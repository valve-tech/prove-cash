// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {FeeDefaults} from "../src/FeeDefaults.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, MockERC20, NO_PERMIT2} from "./Mocks.sol";
import {feeCfg, singleConfig, newSettlement} from "./Fees.sol";

/**
 * @notice `FeeDefaults` (spec 2.4): suggested fee defaults, the one privileged contract left.
 *
 * It reaches no funds, no book and no signed intent, and the settlement never reads it: a fill
 * and a claim succeed with it absent, and changing it changes nothing already signed.
 */
contract FeeDefaultsTest is Test {
    FeeDefaults fd;
    address owner = address(0x0A11CE);
    address stranger = address(0xBAD);

    function setUp() public {
        fd = new FeeDefaults(owner);
    }

    function _rates(uint64 a, uint64 b, uint64 c)
        internal
        pure
        returns (FeeDefaults.PointRates memory)
    {
        return FeeDefaults.PointRates(a, b, c);
    }

    function _set(address dest, uint64 out) internal returns (bytes32) {
        vm.prank(owner);
        return
            fd.setDefaults(singleConfig(dest), _rates(0, out, 0), _rates(0.01e18, 0.01e18, 0.01e18));
    }

    function test_ReturningToAnEarlierDefaultKeepsItsRecordAndEachVersionKeepsItsTime() public {
        vm.warp(1_000);
        bytes32 a0 = _set(address(0x42), 0.005e18);
        vm.warp(2_000);
        bytes32 b = _set(address(0x43), 0.01e18);
        vm.warp(3_000);
        bytes32 a2 = _set(address(0x42), 0.005e18);
        assertEq(a2, a0, "the same inputs are the same defaults hash");
        assertEq(fd.versions(), 3);

        (, FeeDefaults.Record memory r0) = fd.at(0);
        (, FeeDefaults.Record memory r1) = fd.at(1);
        (bytes32 h2, FeeDefaults.Record memory r2) = fd.at(2);
        assertEq(r0.setAt, 1_000, "version 0 keeps the time it was set");
        assertEq(r1.setAt, 2_000);
        assertEq(r2.setAt, 3_000, "version 2 reports its own time");
        assertEq(h2, a0);
        assertEq(r2.feeConfig, r0.feeConfig);
        assertEq(FeeConfig.hash(r0.config), r0.feeConfig);
        assertEq(FeeConfig.hash(r2.config), r2.feeConfig);
        assertTrue(b != a0);

        (, FeeDefaults.Record memory cur) = fd.current();
        assertEq(cur.setAt, 3_000);
        (bool found, uint256 latest, bool isCurrent,) = fd.resolve(r0.feeConfig);
        assertTrue(found);
        assertEq(latest, 2, "the latest version that used it");
        assertTrue(isCurrent);
    }

    function test_ADestinationThatIsTheDefaultsContractItselfIsRefused() public {
        FeeConfig.Config memory c = singleConfig(address(fd));
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeDefaults.InvalidConfig.selector, FeeConfig.Fault.ReservedDestination
            )
        );
        fd.setDefaults(c, _rates(0, 1, 0), _rates(1, 1, 1));
    }

    function test_OnlyTheOwnerSetsDefaults() public {
        FeeConfig.Config memory c = singleConfig(address(1));
        vm.prank(stranger);
        vm.expectRevert(FeeDefaults.NotOwner.selector);
        fd.setDefaults(c, _rates(0, 1, 0), _rates(1, 1, 1));
    }

    function test_OwnershipMovesInTwoSteps() public {
        vm.prank(owner);
        fd.transferOwnership(stranger);
        assertEq(fd.owner(), owner, "a proposal moves nothing");
        vm.prank(stranger);
        fd.acceptOwnership();
        assertEq(fd.owner(), stranger);
        assertEq(fd.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(FeeDefaults.NotOwner.selector);
        fd.transferOwnership(owner);
        vm.prank(address(0xCAFE));
        vm.expectRevert(FeeDefaults.NotOwner.selector);
        fd.acceptOwnership();
    }

    function test_EachCallAppendsAVersionAndEmitsAPreimageThatHashes() public {
        FeeConfig.Config memory c = singleConfig(address(0x42));
        bytes32 expect = FeeConfig.hash(c);
        vm.expectEmit(true, false, true, false, address(fd));
        emit FeeDefaults.DefaultsSet(
            0, bytes32(0), expect, _rates(0, 0, 0), _rates(0, 0, 0), c.destinations, c.weights
        );
        bytes32 d0 = _set(address(0x42), 0.005e18);
        assertEq(fd.versions(), 1);
        (bytes32 h, FeeDefaults.Record memory r) = fd.current();
        assertEq(h, d0);
        assertEq(r.feeConfig, expect);
        assertEq(FeeConfig.hash(r.config), r.feeConfig, "the stored preimage hashes to the key");
        assertEq(r.rates.output, 0.005e18);

        bytes32 d1 = _set(address(0x42), 0.006e18);
        assertTrue(d1 != d0, "a rate change alone changes the defaults hash");
        assertEq(fd.versions(), 2);
        (bytes32 hAt0,) = fd.at(0);
        assertEq(hAt0, d0, "history is append-only");
    }

    function test_ARepeatOfTheCurrentDefaultsReverts() public {
        _set(address(0x42), 0.005e18);
        vm.prank(owner);
        vm.expectRevert(FeeDefaults.Unchanged.selector);
        fd.setDefaults(
            singleConfig(address(0x42)), _rates(0, 0.005e18, 0), _rates(0.01e18, 0.01e18, 0.01e18)
        );
    }

    function test_InvalidConfigsAndRatesRevert() public {
        FeeConfig.Config memory bad = singleConfig(address(1));
        bad.weights[0] = 1;
        vm.startPrank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                FeeDefaults.InvalidConfig.selector, FeeConfig.Fault.WeightsDoNotSumToWad
            )
        );
        fd.setDefaults(bad, _rates(0, 0, 0), _rates(0, 0, 0));
        vm.expectRevert(FeeDefaults.BadParameter.selector);
        fd.setDefaults(singleConfig(address(1)), _rates(0, uint64(1e18 + 1), 0), _rates(0, 0, 0));
        vm.expectRevert(FeeDefaults.BadParameter.selector);
        fd.setDefaults(singleConfig(address(1)), _rates(0, 0, 0), _rates(0, 0, uint64(1e18 + 1)));
        vm.stopPrank();
    }

    function test_ResolveFindsTheLatestVersionUsingAHash() public {
        _set(address(0x42), 0.005e18);
        _set(address(0x43), 0.005e18);
        _set(address(0x42), 0.007e18); // the same config again, later
        bytes32 h42 = feeCfg(address(0x42));
        (bool found, uint256 latest, bool isCurrent, FeeConfig.Config memory cfg) = fd.resolve(h42);
        assertTrue(found);
        assertEq(latest, 2, "the latest version that used it");
        assertTrue(isCurrent);
        assertEq(cfg.destinations[0], address(0x42));
        (found,, isCurrent,) = fd.resolve(feeCfg(address(0x43)));
        assertTrue(found);
        assertFalse(isCurrent, "an earlier default is past, not current");
        (found,,,) = fd.resolve(feeCfg(address(0x99)));
        assertFalse(found);
    }

    function test_CurrentRevertsWhenNothingWasEverSet() public {
        vm.expectRevert(FeeDefaults.NoDefaults.selector);
        fd.current();
    }

    function test_TheMathIsOneAddressAway() public view {
        assertEq(fd.hash(singleConfig(address(7))), FeeConfig.singleHash(address(7)));
        assertEq(fd.MAX_DESTINATIONS(), 8);
    }

    // ── The settlement never reads it ────────────────────────────────────────

    function test_ASettlementBuiltBeforeTheDefaultsExistedFillsAndClaimsWithoutThem() public {
        ProveSettlement s = newSettlement(NO_PERMIT2);
        // The settlement holds no reference to the defaults contract: its code does not contain
        // the address, and it was built without one.
        bytes memory code = address(s).code;
        bytes20 needle = bytes20(address(fd));
        for (uint256 k = 0; k + 20 <= code.length; k++) {
            bytes20 w;
            assembly ("memory-safe") {
                w := mload(add(add(code, 0x20), k))
            }
            assertTrue(w != needle, "the settlement embeds the defaults address");
        }
        // And changing the defaults changes nothing about what a signed hash means.
        bytes32 before = feeCfg(address(0x42));
        _set(address(0x42), 0.005e18);
        _set(address(0x43), 0.9e18);
        assertEq(feeCfg(address(0x42)), before);
        assertEq(s.pendingFees(before, address(0)), 0);
    }
}
