// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {GuardedScript} from "./Guards.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ProveExecutor} from "../src/ProveExecutor.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {FeeDefaults} from "../src/FeeDefaults.sol";
import {ProveReader} from "../src/ProveReader.sol";

/**
 * @notice Deploys the whole set from configuration. No address is compiled into the contracts, so
 *         every chain is `config/<chainid>.json` plus `config/fee-configs.json` plus a key.
 *
 * Dry run against a fork, from `contracts/`. `pulsechain` is the foundry.toml alias for 369:
 *   anvil --fork-url pulsechain --port 8545 --compute-units-per-second 165 &
 *   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
 *     --private-key $ANVIL_KEY
 *
 * For real on 369, from `contracts/`, as the operator runbook says. No key in argv:
 *   forge script script/Deploy.s.sol --rpc-url pulsechain --broadcast --slow \
 *     --account prove-mainnet-deployer
 *
 * Env overrides, all optional — they beat the file, so a deploy never needs an edit-and-commit:
 *   PROVE_OWNER, PROVE_PERMIT2, PROVE_DEPLOYER
 *
 * `config/<chainid>.json` names the keys allowed to sign, under `deployers`, and this script
 * refuses every other signer. A chain that names none stops here. See `Guards.sol`.
 *
 * ## What is deployed, in this order
 *
 *   1. `FeeClaimLib`, the linked external library `ProveSettlement.claim` delegatecalls (spec 2.3,
 *      option C). Forge links and deploys it automatically ahead of the settlement; its address is
 *      in the broadcast file and goes in `deployments/<chainid>.json` as `FeeClaimLib`.
 *   2. `ProveSettlement(strayConfig, permit2)`. Ownerless, no setters. The stray config is the
 *      immutable `strayConfig` of `config/fee-configs.json`.
 *   3. `ProveExecutor(settlement)`.
 *   4. `FeeDefaults(signer)`, the initial defaults set from the LAST `history` entry of
 *      `config/fee-configs.json`, then ownership PROPOSED to `owner` (two steps: `owner` must call
 *      `acceptOwnership` from its own key). The settlement never reads it.
 *   5. `ProveReader(settlement, feeDefaults, strayConfig)`, last. No owner.
 *
 * The settlement takes no protocol share. An intent signs a fee config hash and one rate per take
 * point; prove.cash earns nothing from a fill.
 */
contract Deploy is GuardedScript {
    /// @dev Permit2 backs a whole custody rung and the settlement refuses a zero for it. There is
    ///      no defensible default: `config/<chainid>.json` is where an address lives.
    error Permit2Required();

    /// @dev A fee destination in `config/fee-configs.json` is a contract this script just
    ///      deployed. Money sent there can never be claimed out.
    error DestinationIsDeployed(address destination);

    /// @dev `config/fee-configs.json` has no entry (stray config, or a history) for this chain.
    error FeeConfigRequired(uint256 chainId);

    /// @dev The fee-configs file holds an invalid stray config or an invalid initial default.
    error BadFeeConfig(FeeConfig.Fault fault);

    FeeDefaults internal _feeDefaults;
    ProveReader internal _reader;

    /// @notice The `FeeDefaults` the last `run` deployed.
    function feeDefaults() external view returns (FeeDefaults) {
        return _feeDefaults;
    }

    /// @notice The `ProveReader` the last `run` deployed.
    function reader() external view returns (ProveReader) {
        return _reader;
    }

    function run() external returns (ProveSettlement settlement, ProveExecutor executor) {
        // Before anything is read and long before anything is signed.
        _requireExpectedDeployer(DEPLOYER_ENV);

        string memory path =
            string.concat(vm.projectRoot(), "/config/", vm.toString(block.chainid), ".json");
        string memory json = vm.readFile(path);

        address owner = _address(json, ".owner", "PROVE_OWNER");
        address permit2 = _address(json, ".permit2", "PROVE_PERMIT2");
        // The deployer is the fallback owner, so a dry run on a throwaway fork needs no config.
        if (owner == address(0)) owner = msg.sender;
        if (permit2 == address(0)) revert Permit2Required();

        (
            FeeConfig.Config memory stray,
            FeeConfig.Config memory initial,
            FeeDefaults.PointRates memory rates,
            FeeDefaults.PointRates memory warn
        ) = _feeConfigs();

        console.log("chain           ", block.chainid);
        console.log("defaults owner  ", owner);
        console.log("permit2         ", permit2);
        console.log("stray config    ");
        console.logBytes32(FeeConfig.hash(stray));

        // Named, not implied: the calls below must come from the address that deployed.
        vm.startBroadcast(msg.sender);
        settlement = new ProveSettlement(stray, permit2);
        // Unowned, permissionless, one per settlement. It deploys its own call sink, and the
        // settlement deploys its own relayer.
        executor = new ProveExecutor(address(settlement));
        _feeDefaults = new FeeDefaults(msg.sender);
        _feeDefaults.setDefaults(initial, rates, warn);
        // Two steps: this only proposes. The owner accepts from its own key.
        if (owner != msg.sender) _feeDefaults.transferOwnership(owner);
        _reader = new ProveReader(address(settlement), address(_feeDefaults), stray);
        vm.stopBroadcast();

        // After the fact, and before anything is recorded: none of the configs the deploy
        // published may pay a contract of the set. `FeeDefaults` can only refuse itself. The set
        // includes every library forge linked into the settlement (`FeeClaimLib`), which this
        // script never names: forge deploys it, and only the settlement's code says where.
        address[] memory libs = _linkedLibraries(address(settlement).code);
        address[] memory ours = new address[](6 + libs.length);
        ours[0] = address(settlement);
        ours[1] = settlement.relayer();
        ours[2] = address(executor);
        ours[3] = address(executor.sinkTemplate());
        ours[4] = address(_feeDefaults);
        ours[5] = address(_reader);
        for (uint256 k = 0; k < libs.length; k++) {
            ours[6 + k] = libs[k];
        }
        _assertNoneIsDeployed(stray, ours);
        _assertNoneIsDeployed(initial, ours);

        console.log("");
        console.log("ProveSettlement", address(settlement));
        console.log("ProveRelayer   ", settlement.relayer());
        console.log("ProveExecutor  ", address(executor));
        console.log("ProveCallSink  ", address(executor.sinkTemplate()));
        console.log("FeeDefaults    ", address(_feeDefaults));
        console.log("ProveReader    ", address(_reader));
        console.log("FeeClaimLib     see the broadcast file: the library forge linked and deployed");
        console.log("initial default config");
        console.logBytes32(FeeConfig.hash(initial));
        if (_feeDefaults.pendingOwner() != address(0)) {
            console.log("");
            console.log("FEEDEFAULTS OWNERSHIP IS NOT DONE. The signer still owns it. The owner");
            console.log("must call acceptOwnership() on it from its own key:");
            console.log(_feeDefaults.pendingOwner());
        }
        console.log("");
        console.log("Record in contracts/deployments/<chainid>.json under `contracts`:");
        console.log("ProveSettlement, ProveRelayer, ProveExecutor, ProveCallSink, FeeDefaults,");
        console.log("ProveReader and FeeClaimLib (the last from the broadcast file), then put the");
        console.log("FeeDefaults address in config/fee-configs.json (`feeDefaults`) and the");
        console.log("settlement and reader in sdk/src/config.ts, in the NETWORKS entry for chain");
        console.log(block.chainid);
        console.log("");
        console.log("The relayer needs no configuration anywhere. The settlement deployed it and");
        console.log("holds it as an immutable, and every client reads it back off the settlement.");
        console.log("It is the address makers approve. Approving the settlement does nothing.");
        console.log("");
        console.log("A maker on the permit2 rung approves Permit2 instead, and that approval");
        console.log("survives this redeploy and every one after it.");
    }

    function _assertNoneIsDeployed(FeeConfig.Config memory c, address[] memory ours) internal pure {
        for (uint256 d = 0; d < c.destinations.length; d++) {
            for (uint256 o = 0; o < ours.length; o++) {
                if (c.destinations[d] == ours[o]) {
                    revert DestinationIsDeployed(c.destinations[d]);
                }
            }
        }
    }

    /**
     * @dev Every library linked into `code`: each `PUSH20` operand, on an opcode-aligned walk,
     *      whose own runtime pushes its own address in its first bytes. solc puts that call guard
     *      at the head of every library and fills the address in at deploy time: `PUSH20 <self>`
     *      in the legacy pipeline, `ADDRESS PUSH32 <self>` (an immutable) under `via_ir`. So it
     *      names code deployed at exactly that address. Read off the code rather than the
     *      artifact's `linkReferences`, so it holds under any build profile, coverage included.
     *      A non-library that pushes its own address early would be caught too, which only
     *      widens the set a fee destination must not name.
     */
    function _linkedLibraries(bytes memory code) internal view returns (address[] memory libs) {
        address[] memory found = new address[](code.length / 21 + 1);
        uint256 n = 0;
        uint256 i = 0;
        while (i < code.length) {
            uint8 op = uint8(code[i]);
            if (op == 0x73 && i + 21 <= code.length) {
                address a = address(uint160(_uintAt(code, i + 1, 20)));
                if (!_listed(found, n, a) && _isLibraryAt(a)) {
                    found[n] = a;
                    n++;
                }
            }
            i += _opLength(op);
        }
        libs = new address[](n);
        for (uint256 k = 0; k < n; k++) {
            libs[k] = found[k];
        }
    }

    /// @dev Whether `a`'s first 64 bytes of runtime push `a` itself, a library's call guard.
    ///      Written without an early return: `forge coverage --ir-minimum` credits no hit to a
    ///      `return false` after a loop, and the gate would read it as never run.
    function _isLibraryAt(address a) internal view returns (bool yes) {
        bytes memory c = a.code;
        uint256 end = c.length < 64 ? c.length : 64;
        uint256 i = 0;
        while (i < end && !yes) {
            uint8 op = uint8(c[i]);
            yes = (op == 0x73 && i + 21 <= c.length && _uintAt(c, i + 1, 20) == uint160(a))
                || (op == 0x7f && i + 33 <= c.length && _uintAt(c, i + 1, 32) == uint160(a));
            i += _opLength(op);
        }
    }

    /// @dev Whether `a` is among the first `n` of `list`. A library called from two places is
    ///      linked at both, and listed once.
    function _listed(address[] memory list, uint256 n, address a) private pure returns (bool seen) {
        for (uint256 k = 0; k < n && !seen; k++) {
            seen = list[k] == a;
        }
    }

    /// @dev One opcode and its data: PUSH1..PUSH32 carry 1..32 bytes, which are not code.
    function _opLength(uint8 op) private pure returns (uint256) {
        return op >= 0x60 && op <= 0x7f ? op - 0x5e : 1;
    }

    /// @dev `len` bytes of `b` from `at`, big-endian. The caller bounds `at + len` by the length.
    ///      Plain Solidity rather than an inline `mload`: Yul in `script/` is code the coverage
    ///      gate forgives and `prove-yul-runs.py` must then claim, for a loop this short.
    function _uintAt(bytes memory b, uint256 at, uint256 len) private pure returns (uint256 x) {
        for (uint256 k = 0; k < len; k++) {
            x = (x << 8) | uint8(b[at + k]);
        }
    }

    /// @dev Where the fee configs live and under which key. Overridable so a test can deploy a
    ///      committed chain's configuration onto a scratch chain id without editing the committed
    ///      file; a real run uses neither override.
    function _feeConfigsPath() internal view virtual returns (string memory) {
        return string.concat(vm.projectRoot(), "/config/fee-configs.json");
    }

    function _feeConfigsKey() internal view virtual returns (string memory) {
        return vm.toString(block.chainid);
    }

    /// @dev The stray config and the initial defaults for this chain, from
    ///      `config/fee-configs.json`: the stray config, and the LAST entry of `history`.
    function _feeConfigs()
        internal
        view
        returns (
            FeeConfig.Config memory stray,
            FeeConfig.Config memory initial,
            FeeDefaults.PointRates memory rates,
            FeeDefaults.PointRates memory warn
        )
    {
        string memory json = vm.readFile(_feeConfigsPath());
        string memory chain = string.concat(".", _feeConfigsKey());
        if (!vm.keyExistsJson(json, string.concat(chain, ".strayConfig.destinations"))) {
            revert FeeConfigRequired(block.chainid);
        }
        stray.destinations =
            vm.parseJsonAddressArray(json, string.concat(chain, ".strayConfig.destinations"));
        stray.weights = vm.parseJsonUintArray(json, string.concat(chain, ".strayConfig.weights"));

        uint256 n;
        while (vm.keyExistsJson(json, string.concat(chain, ".history[", vm.toString(n), "]"))) n++;
        if (n == 0) revert FeeConfigRequired(block.chainid);
        string memory last = string.concat(chain, ".history[", vm.toString(n - 1), "]");

        initial.destinations = vm.parseJsonAddressArray(json, string.concat(last, ".destinations"));
        initial.weights = vm.parseJsonUintArray(json, string.concat(last, ".weights"));
        rates = FeeDefaults.PointRates({
            handover: uint64(vm.parseJsonUint(json, string.concat(last, ".rates.handover"))),
            output: uint64(vm.parseJsonUint(json, string.concat(last, ".rates.output"))),
            proceeds: uint64(vm.parseJsonUint(json, string.concat(last, ".rates.proceeds")))
        });
        warn = FeeDefaults.PointRates({
            handover: uint64(vm.parseJsonUint(json, string.concat(last, ".warn.handover"))),
            output: uint64(vm.parseJsonUint(json, string.concat(last, ".warn.output"))),
            proceeds: uint64(vm.parseJsonUint(json, string.concat(last, ".warn.proceeds")))
        });

        FeeConfig.Fault f = FeeConfig.fault(stray);
        if (f != FeeConfig.Fault.None) revert BadFeeConfig(f);
        f = FeeConfig.fault(initial);
        if (f != FeeConfig.Fault.None) revert BadFeeConfig(f);
    }

    /// @dev Environment beats file. Both are optional; the caller decides what a zero means.
    function _address(string memory json, string memory key, string memory envKey)
        internal
        view
        returns (address)
    {
        address fromEnv = vm.envOr(envKey, address(0));
        if (fromEnv != address(0)) return fromEnv;
        try vm.parseJsonAddress(json, key) returns (address fromFile) {
            return fromFile;
        } catch {
            return address(0);
        }
    }
}
