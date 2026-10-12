// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {TakePoints} from "../src/TakePoints.sol";
import {
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION
} from "./Fees.sol";
import {NO_PERMIT2} from "./Mocks.sol";

/**
 * @notice Writes the fee fixture the SDK's fee test asserts against.
 *
 *   forge test --match-path test/FeeFixture.t.sol
 *
 * The SDK splits a fill into `delivered` and `fee` in TypeScript, and the settlement does it in
 * Solidity. A one-wei disagreement is a quote the chain will not honour. `sdk/src/fee.test.ts`
 * used to check the TypeScript against itself. This file makes the settlement the authority:
 * every row is the settlement's own `quote`, and the SDK must reproduce each one exactly.
 *
 * The file is committed, and CI fails if a run changes it (`git diff --exit-code
 * app/src/lib/__fixtures__/`), the same as `eip712.json`. Every number is a string, because a
 * JSON number loses digits above 2^53.
 */
contract FeeFixtureTest is Test {
    string constant OUT = "../app/src/lib/__fixtures__/fee.json";
    uint256 constant WAD = 1e18;

    struct Case {
        uint256 amountIn;
        uint256 gross;
        uint256 take;
        uint256 rateIn;
        uint256 rate;
        uint256 rateProceeds;
    }

    function test_WriteFeeFixture() public {
        ProveSettlement settlement = newSettlement(NO_PERMIT2);

        Case[] memory cases = _cases();
        string memory rows = "rows";
        string memory json;
        for (uint256 k = 0; k < cases.length; k++) {
            Case memory c = cases[k];
            ProveSettlement.Intent memory i = _intent(c);
            TakePoints.Quote memory q = settlement.quote(i, c.take, i.startTime);
            string memory row = string.concat("row", vm.toString(k));
            vm.serializeString(row, "amountIn", vm.toString(c.amountIn));
            vm.serializeString(row, "minOut", vm.toString(c.gross));
            vm.serializeString(row, "take", vm.toString(c.take));
            vm.serializeString(row, "rateIn", vm.toString(c.rateIn));
            vm.serializeString(row, "rate", vm.toString(c.rate));
            vm.serializeString(row, "rateProceeds", vm.toString(c.rateProceeds));
            vm.serializeString(row, "feeIn", vm.toString(q.feeIn));
            vm.serializeString(row, "usable", vm.toString(q.usable));
            vm.serializeString(row, "owedToMaker", vm.toString(q.owedToMaker));
            vm.serializeString(row, "feeOut", vm.toString(q.feeOut));
            vm.serializeString(row, "feeProceeds", vm.toString(q.feeProceeds));
            vm.serializeString(row, "delivered", vm.toString(q.delivered));
            string memory one = vm.serializeString(row, "owed", vm.toString(q.owed));
            json = vm.serializeString(rows, _pad(k), one);
        }

        string memory root = "root";
        vm.serializeString(
            root, "_comment", "Written by contracts/test/FeeFixture.t.sol. Do not edit by hand."
        );
        string memory out = vm.serializeString(root, "cases", json);
        vm.writeJson(out, OUT);
        emit log(string.concat("wrote ", OUT));
    }

    /// @dev Zero-padded keys, so the JSON object keeps the order the cases were made in.
    function _pad(uint256 k) private pure returns (string memory) {
        return k < 10 ? string.concat("0", vm.toString(k)) : vm.toString(k);
    }

    /**
     * @dev The edges first: no fee, the smallest fee, the dust line where the floor division
     *      pays nothing, the whole gross, and the `uint128` ceiling `_termsOk` admits. Each at
     *      every take point on its own, then all three together, then a deterministic walk of
     *      partial fills with random rates at each point, so every ceiling and floor division in
     *      the take-point math is exercised.
     */
    function _cases() private pure returns (Case[] memory cs) {
        uint256[8] memory rates = [uint256(0), 1, 5e14, 1e15, 25e14, 1e16, WAD / 2, WAD];
        uint256 big = type(uint128).max;
        cs = new Case[](8 * 3 + 8 * 3 + 8 + 48);
        uint256 n;
        for (uint256 r = 0; r < 8; r++) {
            cs[n++] = Case(999, 999, 999, rates[r], 0, 0);
            cs[n++] = Case(999, 999, 999, 0, rates[r], 0);
            cs[n++] = Case(999, 999, 999, 0, 0, rates[r]);
        }
        for (uint256 r = 0; r < 8; r++) {
            cs[n++] = Case(big, big, big, rates[r], 0, 0);
            cs[n++] = Case(big, big, big, 0, rates[r], 0);
            cs[n++] = Case(big, big, big, 0, 0, rates[r]);
        }
        for (uint256 r = 0; r < 8; r++) {
            cs[n++] = Case(1e24, 1e24, 1e24, rates[r], rates[(r + 3) % 8], rates[(r + 5) % 8]);
        }
        bytes32 x = keccak256("prove.cash fee fixture");
        for (uint256 k = 0; k < 48; k++) {
            x = keccak256(abi.encode(x));
            uint256 amountIn = (uint256(x) % 1e24) + 1;
            x = keccak256(abi.encode(x));
            uint256 gross = (uint256(x) % 1e24) + 1;
            x = keccak256(abi.encode(x));
            uint256 take = (uint256(x) % amountIn) + 1;
            x = keccak256(abi.encode(x));
            uint256 rateIn = k % 2 == 0 ? rates[uint256(x) % 8] : uint256(x) % (WAD / 4);
            x = keccak256(abi.encode(x));
            uint256 rate = k % 3 == 0 ? rates[uint256(x) % 8] : uint256(x) % (WAD / 4);
            x = keccak256(abi.encode(x));
            uint256 rateP = k % 5 == 0 ? rates[uint256(x) % 8] : uint256(x) % (WAD / 4);
            cs[n++] = Case(amountIn, gross, take, rateIn, rate, rateP);
        }
    }

    /// @dev A flat curve, so `minOutAt` is `gross` at every moment. The quote is pure arithmetic
    ///      on the signed rates, so the config hash only has to be non-zero.
    function _intent(Case memory c) private pure returns (ProveSettlement.Intent memory i) {
        i.maker = address(0x1111);
        i.recipient = address(0x1111);
        i.tokenIn = address(0xA1);
        i.tokenOut = address(0xB2);
        i.amountIn = c.amountIn;
        i.minOutStart = c.gross;
        i.minOutEnd = c.gross;
        i.startTime = 0;
        i.endTime = 9_999_999_999;
        i.feeConfig = feeCfg(address(0x4444));
        i.feeRateIn = uint64(c.rateIn);
        i.feeRate = uint64(c.rate);
        i.feeRateProceeds = uint64(c.rateProceeds);
    }
}
