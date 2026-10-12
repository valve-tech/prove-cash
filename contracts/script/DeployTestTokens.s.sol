// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {GuardedScript} from "./Guards.sol";
import {FaucetToken} from "../test/tokens/FaucetToken.sol";

/**
 * @notice Deploys the test portfolio from configuration. No symbol, amount or address is compiled
 *         in, so every chain is `config/tokens.<chainid>.json` plus a key.
 *
 * The script writes `config/deployed.<chainid>.json` and prints the same addresses, so the app and
 * the bots can be pointed at the run without anyone reading a transaction receipt.
 *
 * Dry run against a throwaway chain. Anvil takes `--chain-id 943` so it reads the real config —
 * which also means the run overwrites `config/deployed.943.json` with anvil addresses. Throw that
 * file away afterwards, or the app will point at a chain that no longer exists:
 *   anvil --port 8546 --silent --chain-id 943 &
 *   forge script script/DeployTestTokens.s.sol --rpc-url http://127.0.0.1:8546 --broadcast \
 *     --private-key $ANVIL_KEY
 *
 * For real:
 *   forge script script/DeployTestTokens.s.sol --rpc-url $PULSECHAIN_TESTNET_RPC --broadcast \
 *     --private-key $DEPLOYER_KEY
 *
 * Env override, optional — it beats the file:
 *   PROVE_TOKEN_OWNER
 *
 * The signer is checked against `deployers` in `config/<chainid>.json` before anything is
 * deployed. This script mints the whole portfolio's seed while it still owns every token, so the
 * key that signs it holds the supply for the length of one loop. See `Guards.sol`.
 */
contract DeployTestTokens is GuardedScript {
    error NoTokens();
    error DecimalsTooHigh(uint256 decimals);

    /// @dev A ceiling on the row probe, so a malformed file cannot loop forever.
    uint256 private constant MAX_TOKENS = 64;

    /// @dev One row of the config, already scaled into token units.
    struct Spec {
        string name;
        string symbol;
        uint8 decimals;
        uint256 drip;
        uint64 cooldown;
        uint256 seed;
    }

    function run() external returns (FaucetToken[] memory tokens) {
        _requireExpectedDeployer(DEPLOYER_ENV);

        string memory path =
            string.concat(vm.projectRoot(), "/config/tokens.", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);

        // The deployer is the fallback owner, so a dry run on a throwaway chain needs no config.
        address owner = vm.envOr("PROVE_TOKEN_OWNER", address(0));
        if (owner == address(0)) owner = _configOwner(json);
        if (owner == address(0)) owner = msg.sender;

        Spec[] memory specs = _read(json);

        console.log("chain      ", block.chainid);
        console.log("owner      ", owner);
        console.log("tokens     ", specs.length);
        console.log("");

        tokens = new FaucetToken[](specs.length);

        vm.startBroadcast();
        for (uint256 k = 0; k < specs.length; k++) {
            Spec memory sp = specs[k];

            // The deployer owns the token for the length of this loop, then hands it over. Only
            // the owner may mint, and the configured owner is a valve address whose key does not
            // sign the deploy — so seeding the portfolio has to happen before the handover.
            tokens[k] =
                new FaucetToken(sp.name, sp.symbol, sp.decimals, sp.drip, sp.cooldown, msg.sender);
            if (sp.seed > 0) tokens[k].mint(owner, sp.seed);
            if (owner != msg.sender) tokens[k].transferOwnership(owner);
        }
        vm.stopBroadcast();

        _report(specs, tokens);
    }

    // ── Config ───────────────────────────────────────────────────────────────

    function _configOwner(string memory json) private pure returns (address) {
        try vm.parseJsonAddress(json, ".owner") returns (address fromFile) {
            return fromFile;
        } catch {
            return address(0);
        }
    }

    /**
     * @dev Read the rows one at a time, by index and by key.
     *
     *      `abi.decode(vm.parseJson(json, ".tokens"), (Row[]))` is shorter, but it matches JSON
     *      keys to struct fields in alphabetical order. Adding a field to the file would then
     *      shift every value after it into the wrong slot, and nothing would complain. Naming
     *      each key means a config the script cannot read fails the run.
     *
     *      Every amount in the file is in whole tokens. Scaling happens once, here, because a
     *      config full of `25000000000000000000000` is a config nobody proof-reads.
     */
    function _read(string memory json) private pure returns (Spec[] memory specs) {
        uint256 n = _count(json);
        if (n == 0) revert NoTokens();

        specs = new Spec[](n);
        for (uint256 k = 0; k < n; k++) {
            string memory at = string.concat(".tokens[", vm.toString(k), "]");
            uint256 decimals = vm.parseJsonUint(json, string.concat(at, ".decimals"));
            if (decimals > 18) revert DecimalsTooHigh(decimals);

            uint256 unit = 10 ** decimals;
            specs[k] = Spec({
                name: vm.parseJsonString(json, string.concat(at, ".name")),
                symbol: vm.parseJsonString(json, string.concat(at, ".symbol")),
                decimals: uint8(decimals),
                drip: vm.parseJsonUint(json, string.concat(at, ".drip")) * unit,
                cooldown: uint64(
                    vm.parseJsonUint(json, string.concat(at, ".cooldownHours")) * 1 hours
                ),
                seed: vm.parseJsonUint(json, string.concat(at, ".seed")) * unit
            });
        }
    }

    /// @dev The file has no length field, so probe for the first row that is not there.
    function _count(string memory json) private pure returns (uint256 n) {
        while (n < MAX_TOKENS) {
            string memory key = string.concat(".tokens[", vm.toString(n), "].symbol");
            try vm.parseJsonString(json, key) returns (string memory) {
                n++;
            } catch {
                return n;
            }
        }
    }

    // ── Output ───────────────────────────────────────────────────────────────

    /// @dev Print one address per line, then write the same map to disk under the chain id.
    function _report(Spec[] memory specs, FaucetToken[] memory tokens) private {
        string memory out;
        for (uint256 k = 0; k < specs.length; k++) {
            console.log(specs[k].symbol, address(tokens[k]));
            out = vm.serializeAddress("tokens", specs[k].symbol, address(tokens[k]));
        }

        string memory file = string.concat(
            vm.projectRoot(), "/config/deployed.", vm.toString(block.chainid), ".json"
        );
        vm.writeJson(out, file);

        console.log("");
        console.log("written to config/deployed.%s.json", vm.toString(block.chainid));
        console.log("Anyone can call claim() on each of these, once per cooldown per address.");
    }
}
