// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeConfig} from "../src/FeeConfig.sol";

/**
 * @notice `config/fee-configs.json` held to the rules the contracts enforce.
 *
 *   forge test --match-path test/FeeConfigsJson.t.sol
 *
 * The file is a CI mirror of `FeeDefaults`, not its authority: the chain is. Three things read
 * it, and each one fails differently if the file is wrong. `Deploy.s.sol` reads the stray config
 * and the last history entry and would revert at deploy time. The SDK registry copies it and
 * `sdk/src/fee-configs.registry.test.ts` holds the copy to it. `app/scripts/check-fee-configs.ts`
 * holds it to the chain's `DefaultsSet` logs once an address is recorded. This test is the first
 * line: every config in the file is valid by the contract's own `FeeConfig.fault`, hashes with
 * the contract's own `FeeConfig.hash`, and every rate is one `FeeDefaults.setDefaults` would
 * accept. A hand edit that breaks any of that fails here, in seconds, rather than on chain.
 */
contract FeeConfigsJsonTest is Test {
    function _file() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/config/fee-configs.json"));
    }

    function _config(string memory json, string memory at)
        internal
        pure
        returns (FeeConfig.Config memory c)
    {
        c.destinations = vm.parseJsonAddressArray(json, string.concat(at, ".destinations"));
        c.weights = vm.parseJsonUintArray(json, string.concat(at, ".weights"));
    }

    function _chains() internal pure returns (string[2] memory) {
        return ["369", "943"];
    }

    function _length(string memory json, string memory chain) internal view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(chain, ".history[", vm.toString(n), "]"))) n++;
    }

    /// @notice Every chain the deploy covers has an entry, a valid stray config and a history.
    function test_EveryChainHasAValidStrayConfigAndAHistory() public view {
        string memory json = _file();
        string[2] memory chains = _chains();
        for (uint256 k = 0; k < chains.length; k++) {
            string memory chain = string.concat(".", chains[k]);
            assertTrue(vm.keyExistsJson(json, chain), "the chain has an entry");

            FeeConfig.Config memory stray = _config(json, string.concat(chain, ".strayConfig"));
            assertEq(uint256(FeeConfig.fault(stray)), uint256(FeeConfig.Fault.None), "stray valid");
            // The settlement refuses its own address and the relayer's; the file can only be
            // checked for the zero address, which `fault` already refuses. The rest is the
            // constructor's, exercised in `Deploy.t.sol`.
            assertGt(_length(json, chain), 0, "at least one history entry: the initial default");
        }
    }

    /// @notice Every history entry is a valid config, with rates `setDefaults` would accept.
    function test_EveryHistoryEntryIsAValidConfigWithRatesInRange() public view {
        string memory json = _file();
        string[2] memory chains = _chains();
        for (uint256 k = 0; k < chains.length; k++) {
            string memory chain = string.concat(".", chains[k]);
            uint256 n = _length(json, chain);
            for (uint256 i = 0; i < n; i++) {
                string memory at = string.concat(chain, ".history[", vm.toString(i), "]");
                FeeConfig.Config memory c = _config(json, at);
                assertEq(uint256(FeeConfig.fault(c)), uint256(FeeConfig.Fault.None), at);
                // Hashes with the contract's own function: the preimage `claim` takes and the
                // key an intent signs are this value.
                assertTrue(FeeConfig.hash(c) != bytes32(0), "a real hash");
                string[2][3] memory rate = [
                    [".rates.handover", ".warn.handover"],
                    [".rates.output", ".warn.output"],
                    [".rates.proceeds", ".warn.proceeds"]
                ];
                for (uint256 r = 0; r < 3; r++) {
                    assertLe(
                        vm.parseJsonUint(json, string.concat(at, rate[r][0])), FeeConfig.WAD, at
                    );
                    assertLe(
                        vm.parseJsonUint(json, string.concat(at, rate[r][1])), FeeConfig.WAD, at
                    );
                }
                assertGt(bytes(vm.parseJsonString(json, string.concat(at, ".id"))).length, 0, "id");
            }
        }
    }

    /// @notice Ids are unique within a chain, and no two consecutive entries are identical: the
    ///         contract would revert `Unchanged` on the second, so the file cannot carry it.
    function test_IdsAreUniqueAndNoEntryRepeatsItsPredecessor() public view {
        string memory json = _file();
        string[2] memory chains = _chains();
        for (uint256 k = 0; k < chains.length; k++) {
            string memory chain = string.concat(".", chains[k]);
            uint256 n = _length(json, chain);
            for (uint256 i = 0; i < n; i++) {
                string memory a = string.concat(chain, ".history[", vm.toString(i), "]");
                for (uint256 j = i + 1; j < n; j++) {
                    string memory b = string.concat(chain, ".history[", vm.toString(j), "]");
                    assertTrue(
                        keccak256(bytes(vm.parseJsonString(json, string.concat(a, ".id"))))
                            != keccak256(bytes(vm.parseJsonString(json, string.concat(b, ".id")))),
                        "ids are unique"
                    );
                }
                if (i > 0) {
                    string memory p = string.concat(chain, ".history[", vm.toString(i - 1), "]");
                    assertTrue(_entryHash(json, a) != _entryHash(json, p), "a repeat reverts");
                }
            }
        }
    }

    /// @dev What `FeeDefaults` hashes as the defaults: config, rates and warn together.
    function _entryHash(string memory json, string memory at) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                FeeConfig.hash(_config(json, at)),
                vm.parseJsonUint(json, string.concat(at, ".rates.handover")),
                vm.parseJsonUint(json, string.concat(at, ".rates.output")),
                vm.parseJsonUint(json, string.concat(at, ".rates.proceeds")),
                vm.parseJsonUint(json, string.concat(at, ".warn.handover")),
                vm.parseJsonUint(json, string.concat(at, ".warn.output")),
                vm.parseJsonUint(json, string.concat(at, ".warn.proceeds"))
            )
        );
    }

    /// @notice The owner's initial defaults, pinned: P2 0.5% to the buy-and-burn, P1 and P3 zero,
    ///         and a 1% warning at every point. The LAST entry is what the deploy publishes.
    function test_TheInitialDefaultsAreTheOwners() public view {
        string memory json = _file();
        string[2] memory chains = _chains();
        for (uint256 k = 0; k < chains.length; k++) {
            string memory chain = string.concat(".", chains[k]);
            string memory first = string.concat(chain, ".history[0]");
            assertEq(vm.parseJsonUint(json, string.concat(first, ".rates.handover")), 0, "P1");
            assertEq(vm.parseJsonUint(json, string.concat(first, ".rates.output")), 0.005e18, "P2");
            assertEq(vm.parseJsonUint(json, string.concat(first, ".rates.proceeds")), 0, "P3");
            assertEq(vm.parseJsonUint(json, string.concat(first, ".warn.handover")), 0.01e18);
            assertEq(vm.parseJsonUint(json, string.concat(first, ".warn.output")), 0.01e18);
            assertEq(vm.parseJsonUint(json, string.concat(first, ".warn.proceeds")), 0.01e18);
        }
    }

    /// @notice No fee destination in the file is a contract of this system recorded in
    ///         `deployments/<chainid>.json`: the settlement, relayer, executor, sink, reader,
    ///         FeeDefaults or FeeClaimLib. Money sent to one of them is stuck, and the settlement
    ///         refuses two of them (its own address and the relayer's) only for the STRAY config.
    ///         `Deploy.s.sol` asserts the same against the addresses it has just deployed.
    function test_NoDestinationIsAContractOfThisSystem() public view {
        string memory json = _file();
        string[2] memory chains = _chains();
        for (uint256 k = 0; k < chains.length; k++) {
            string memory path =
                string.concat(vm.projectRoot(), "/deployments/", chains[k], ".json");
            if (!vm.exists(path)) continue;
            string memory dep = vm.readFile(path);
            string[] memory names = vm.parseJsonKeys(dep, ".contracts");
            string memory chain = string.concat(".", chains[k]);

            address[] memory dests =
                vm.parseJsonAddressArray(json, string.concat(chain, ".strayConfig.destinations"));
            _noneIsDeployed(dep, names, dests);
            uint256 n = _length(json, chain);
            for (uint256 i = 0; i < n; i++) {
                string memory at =
                    string.concat(chain, ".history[", vm.toString(i), "].destinations");
                _noneIsDeployed(dep, names, vm.parseJsonAddressArray(json, at));
            }
        }
    }

    function _noneIsDeployed(string memory dep, string[] memory names, address[] memory dests)
        internal
        pure
    {
        for (uint256 a = 0; a < names.length; a++) {
            address deployed = vm.parseJsonAddress(dep, string.concat(".contracts.", names[a]));
            for (uint256 d = 0; d < dests.length; d++) {
                assertTrue(dests[d] != deployed, names[a]);
            }
        }
    }
}
