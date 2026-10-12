// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {FeeConfigView} from "../src/FeeConfigView.sol";

/**
 * @notice `FeeConfig`: the hash, the validity rules, the split and the fee arithmetic
 *         (spec 2.2 and 2.3), and the cross-language fixture the SDK asserts against.
 *
 *   forge test --match-path test/FeeConfig.t.sol
 *
 * The hash is stated a second time here, field by field, because the library cannot defend its
 * own TYPEHASH: a typo in it keeps Solidity self-consistent and breaks every wallet. The fixture
 * (`app/src/lib/__fixtures__/fee-config.json`) is committed and CI fails if a run changes it.
 */
contract FeeConfigTest is Test {
    string constant OUT = "../app/src/lib/__fixtures__/fee-config.json";
    uint256 constant WAD = 1e18;

    FeeConfigView viewer = new FeeConfigView();

    function _cfg(address[] memory d, uint256[] memory w)
        internal
        pure
        returns (FeeConfig.Config memory c)
    {
        c.destinations = d;
        c.weights = w;
    }

    function _two() internal pure returns (FeeConfig.Config memory c) {
        c.destinations = new address[](2);
        c.weights = new uint256[](2);
        c.destinations[0] = address(0x1111111111111111111111111111111111111111);
        c.destinations[1] = address(0x2222222222222222222222222222222222222222);
        c.weights[0] = 0.25e18;
        c.weights[1] = 0.75e18;
    }

    function _n(uint256 n) internal pure returns (FeeConfig.Config memory c) {
        c.destinations = new address[](n);
        c.weights = new uint256[](n);
        uint256 each = WAD / n;
        uint256 sum;
        for (uint256 k = 0; k < n; k++) {
            c.destinations[k] = address(uint160(0x1000 + k));
            c.weights[k] = each;
            sum += each;
        }
        c.weights[n - 1] += WAD - sum;
    }

    // ── The hash ─────────────────────────────────────────────────────────────

    function test_TheTypehashStringIsTheOneEveryWalletWillHash() public pure {
        assertEq(
            FeeConfig.TYPEHASH,
            keccak256("FeeConfig(address[] destinations,uint256[] weights)"),
            "EIP-712 hashStruct of the nested type"
        );
    }

    function test_TheHashIsHashStructFieldByField() public pure {
        FeeConfig.Config memory c = _two();
        // EIP-712: dynamic arrays of static elements are keccak256 of the concatenated 32-byte
        // padded elements.
        bytes32 d = keccak256(
            abi.encodePacked(
                bytes32(uint256(uint160(c.destinations[0]))),
                bytes32(uint256(uint160(c.destinations[1])))
            )
        );
        bytes32 w = keccak256(abi.encodePacked(c.weights[0], c.weights[1]));
        assertEq(FeeConfig.hash(c), keccak256(abi.encode(FeeConfig.TYPEHASH, d, w)));
    }

    function test_SingleHashIsTheHashOfSingle() public pure {
        address a = address(0xBEEF);
        assertEq(FeeConfig.singleHash(a), FeeConfig.hash(FeeConfig.single(a)));
        assertEq(FeeConfig.fault(FeeConfig.single(a)) == FeeConfig.Fault.None, true);
    }

    function test_AnyArraysHashEvenWhenInvalid() public pure {
        // `hash` accepts anything: validity is `fault`'s business. A wrong preimage simply books zero.
        FeeConfig.Config memory c;
        c.destinations = new address[](0);
        c.weights = new uint256[](0);
        FeeConfig.hash(c);
    }

    function test_TheViewWrappersAgree() public view {
        FeeConfig.Config memory c = _two();
        assertEq(viewer.hash(c), FeeConfig.hash(c));
        assertEq(uint256(viewer.fault(c)), uint256(FeeConfig.fault(c)));
        assertEq(viewer.singleHash(address(7)), FeeConfig.singleHash(address(7)));
        assertEq(viewer.TYPEHASH(), FeeConfig.TYPEHASH);
        assertEq(viewer.MAX_DESTINATIONS(), 8);
        assertEq(viewer.feeOf(1e18, 1e16), FeeConfig.feeOf(1e18, 1e16));
        assertEq(viewer.grossForNet(99e16, 1e16), FeeConfig.grossForNet(99e16, 1e16));
    }

    // ── Every Fault ──────────────────────────────────────────────────────────

    function test_ACanonicalConfigHasNoFault() public pure {
        assertEq(uint256(FeeConfig.fault(_two())), uint256(FeeConfig.Fault.None));
        for (uint256 n = 1; n <= 8; n++) {
            assertEq(
                uint256(FeeConfig.fault(_n(n))), uint256(FeeConfig.Fault.None), "1..8 destinations"
            );
        }
    }

    function test_NoDestinations() public pure {
        FeeConfig.Config memory c = _cfg(new address[](0), new uint256[](0));
        assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.NoDestinations));
    }

    function test_TooMany() public pure {
        FeeConfig.Config memory c = _n(8);
        address[] memory d = new address[](9);
        uint256[] memory w = new uint256[](9);
        for (uint256 k = 0; k < 9; k++) {
            d[k] = address(uint160(0x1000 + k));
            w[k] = WAD / 9;
        }
        c = _cfg(d, w);
        assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.TooMany));
    }

    function test_LengthMismatch() public pure {
        FeeConfig.Config memory c = _two();
        c.weights = new uint256[](1);
        c.weights[0] = WAD;
        assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.LengthMismatch));
    }

    function test_ZeroDestination() public pure {
        FeeConfig.Config memory c = _two();
        c.destinations[0] = address(0);
        assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.ZeroDestination));
    }

    function test_NotAscendingCoversEqualAndDescending() public pure {
        FeeConfig.Config memory c = _two();
        c.destinations[1] = c.destinations[0];
        assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.NotAscending), "a duplicate");
        (c.destinations[0], c.destinations[1]) = (address(0x2222), address(0x1111));
        assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.NotAscending), "descending");
    }

    function test_ZeroWeight() public pure {
        FeeConfig.Config memory c = _two();
        c.weights[0] = 0;
        c.weights[1] = WAD;
        assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.ZeroWeight));
    }

    function test_TheSumMustBeExactlyWadAtTheBoundary() public pure {
        FeeConfig.Config memory c = _two();
        c.weights[1] = 0.75e18 - 1;
        assertEq(
            uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.WeightsDoNotSumToWad), "WAD - 1"
        );
        c.weights[1] = 0.75e18 + 1;
        assertEq(
            uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.WeightsDoNotSumToWad), "WAD + 1"
        );
        c.weights[1] = 0.75e18;
        assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.None), "WAD");
    }

    function test_AHugeWeightCannotOverflowTheSum() public pure {
        FeeConfig.Config memory c = _two();
        c.weights[0] = type(uint256).max;
        assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.WeightsDoNotSumToWad));
    }

    // ── split ────────────────────────────────────────────────────────────────

    function test_OneDestinationGetsTheWholeAmount() public pure {
        uint256[] memory w = new uint256[](1);
        w[0] = WAD;
        uint256[] memory s = FeeConfig.split(12345, w);
        assertEq(s[0], 12345);
    }

    function test_TheRemainderGoesToTheLastOnly() public pure {
        FeeConfig.Config memory c = _two();
        uint256[] memory s = FeeConfig.split(7, c.weights);
        assertEq(s[0], 1, "floor(7 * 0.25)");
        assertEq(s[1], 6, "the rest, including the dust");
    }

    function testFuzz_SharesAddUpAndNeverExceedTheAmount(uint256 amount, uint8 count, uint256 seed)
        public
        pure
    {
        uint256 n = bound(count, 1, 8);
        FeeConfig.Config memory c = _n(n);
        // Rough weights: a pseudo-random composition of WAD.
        uint256 left = WAD;
        for (uint256 k = 0; k + 1 < n; k++) {
            uint256 take = bound(uint256(keccak256(abi.encode(seed, k))), 1, left - (n - 1 - k));
            c.weights[k] = take;
            left -= take;
        }
        c.weights[n - 1] = left;
        assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.None));

        uint256[] memory s = FeeConfig.split(amount, c.weights);
        uint256 sum;
        for (uint256 k = 0; k < n; k++) {
            assertLe(s[k], amount, "no share exceeds the amount");
            sum += s[k];
        }
        assertEq(sum, amount, "the shares add to the amount exactly");
        if (n == 1) assertEq(s[0], amount, "n = 1 is the identity");
        for (uint256 k = 0; k + 1 < n; k++) {
            assertLe(s[k], (amount / WAD) * c.weights[k] + c.weights[k], "floored");
        }
    }

    function test_SplitAtTheTopOfTheRangeDoesNotOverflow() public pure {
        FeeConfig.Config memory c = _two();
        uint256[] memory s = FeeConfig.split(type(uint256).max, c.weights);
        assertEq(s[0] + s[1], type(uint256).max);
    }

    // ── The fee arithmetic ───────────────────────────────────────────────────

    function testFuzz_FeeOfFloorsAndNeverExceedsTheBase(uint128 base, uint64 rate) public pure {
        rate = uint64(bound(rate, 0, WAD));
        uint256 f = FeeConfig.feeOf(base, rate);
        assertLe(f, base);
        assertEq(f, (uint256(base) * rate) / WAD);
    }

    function testFuzz_GrossForNetAlwaysLeavesAtLeastNet(uint128 net, uint64 rate) public pure {
        rate = uint64(bound(rate, 0, WAD / 2));
        uint256 g = FeeConfig.grossForNet(net, rate);
        assertGe(g - FeeConfig.feeOf(g, rate), net, "the maker keeps at least the net");
        // Not necessarily minimal: the fee floors, so a wei or so less can also leave `net`. The
        // ceiling is the safe direction, and "at least net" is the property a client relies on.
    }

    // ── The cross-language fixture ───────────────────────────────────────────

    /// @dev Writes `{config, hash, fault, split(amount)}` for the SDK to reproduce. Every number
    ///      is a string: a JSON number loses digits above 2^53.
    function test_WriteFeeConfigFixture() public {
        FeeConfig.Config[5] memory cs;
        cs[0] = FeeConfig.single(address(0x4444444444444444444444444444444444444444));
        cs[1] = _two();
        cs[2] = _n(8);
        cs[3] = _n(3);
        cs[4] = _two();
        cs[4].weights[1] = 0.75e18 - 1; // invalid: the sum

        uint256[3] memory amounts = [uint256(1), 1000e18 + 7, type(uint128).max];
        string memory rows = "rows";
        string memory all;
        for (uint256 k = 0; k < cs.length; k++) {
            string memory row = string.concat("row", vm.toString(k));
            vm.serializeAddress(row, "destinations", cs[k].destinations);
            string[] memory ws = new string[](cs[k].weights.length);
            for (uint256 j = 0; j < ws.length; j++) {
                ws[j] = vm.toString(cs[k].weights[j]);
            }
            vm.serializeString(row, "weights", ws);
            vm.serializeBytes32(row, "hash", FeeConfig.hash(cs[k]));
            vm.serializeUint(row, "fault", uint256(FeeConfig.fault(cs[k])));
            if (FeeConfig.fault(cs[k]) == FeeConfig.Fault.None) {
                string memory splits;
                for (uint256 a = 0; a < amounts.length; a++) {
                    string memory sk = string.concat("split", vm.toString(a));
                    uint256[] memory sh = FeeConfig.split(amounts[a], cs[k].weights);
                    string[] memory shs = new string[](sh.length);
                    for (uint256 j = 0; j < sh.length; j++) {
                        shs[j] = vm.toString(sh[j]);
                    }
                    vm.serializeString(sk, "amount", vm.toString(amounts[a]));
                    splits = vm.serializeString(sk, "shares", shs);
                    vm.serializeString(row, sk, splits);
                }
            }
            string memory one =
                vm.serializeBytes32(row, "singleHash", FeeConfig.singleHash(cs[k].destinations[0]));
            all = vm.serializeString(rows, string.concat("c", vm.toString(k)), one);
        }
        string memory root = "root";
        vm.serializeString(
            root, "_comment", "Written by contracts/test/FeeConfig.t.sol. Do not edit by hand."
        );
        vm.serializeBytes32(root, "typehash", FeeConfig.TYPEHASH);
        string memory out = vm.serializeString(root, "configs", all);
        vm.writeJson(out, OUT);
    }

    function test_TheViewerBuildsAndSplitsLikeTheLibrary() public view {
        FeeConfig.Config memory one = viewer.single(address(0xABC));
        assertEq(FeeConfig.hash(one), FeeConfig.singleHash(address(0xABC)));
        assertEq(one.destinations.length, 1);
        assertEq(one.weights[0], WAD);
        uint256[] memory w = new uint256[](2);
        w[0] = 0.25e18;
        w[1] = 0.75e18;
        uint256[] memory s = viewer.split(101, w);
        assertEq(s[0], 25);
        assertEq(s[1], 76, "the remainder goes to the last");
    }
}
