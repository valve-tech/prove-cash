// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";

interface ISettlementRelayer {
    function relayer() external view returns (address);
}

/**
 * @notice The two checks every broadcasting script in this directory runs before it signs.
 *
 * Both exist because a deploy is the one thing in this repository that cannot be re-run. A wrong
 * test is a red CI job. A wrong deploy is an address on chain that somebody has already approved.
 *
 * ## Who is signing
 *
 * `docs/ADDRESSES.md` claimed this check for a fortnight before it existed. Three keys sit in
 * a password manager under names a tired person confuses — "valve_deployer", "prove.cash testnet deployer",
 * "prove.cash mainnet deployer" — and nothing in a script noticed which one forge had been handed.
 * The owner and the signer are different addresses on both chains on purpose, so "it deployed and
 * I own it" was never evidence that the right key signed.
 *
 * The signer is `msg.sender`. In a `forge script` run that is the address forge derived from
 * `--private-key`, `--account` or `--ledger`, so this holds the key's own address against a value
 * somebody wrote down in advance. It never reads a key and never prints one.
 *
 * **Where the expectation lives: `config/<chainid>.json`, under `deployers`.** It is a committed
 * file, one per chain, that a deploy already reads, and a change to it arrives as a diff in a pull
 * request rather than as a line in somebody's shell history. The two rejected homes were an
 * environment variable, which is the thing this check exists to catch being wrong, and a constant
 * in the script, which would be an address compiled into a deployment — the habit `Deploy.s.sol`
 * refuses for Permit2 one file over.
 *
 * It is a list because chain 943 has two legitimate signers: the testnet deployer, and anvil's
 * first published account when `app/scripts/lab/up.sh` stands the protocol up on a chain you
 * brought up yourself. Chain 369 lists exactly one.
 *
 * `PROVE_DEPLOYER` overrides the list, as `PROVE_OWNER` overrides the owner. When it is set it is
 * the ONLY accepted signer: it narrows, it never widens. A stale export from a lab session then
 * fails closed on a real chain instead of waving one through.
 *
 * **It fails closed.** No config file, no `deployers` key, or an empty list stops the deploy.
 * There is no unset-means-skip: an expectation nobody wrote down is the state this refuses.
 *
 * ## Which settlement
 *
 * `DeployRfqVenue` and `DeployBatchExecutor` bind to a settlement already on chain, and both
 * constructors check only that the address has code and answers a non-zero `relayer()`.
 * Yesterday's settlement passes both. A venue bound to a dead settlement deploys cleanly, quotes
 * cleanly, signs cleanly, and reverts at settlement — the worst place to find out.
 *
 * `ProveRelayer` is created inside the settlement's constructor, and `RfqVenue` caches its EIP-712
 * domain over `address(this)`. So a settlement redeploy orphans every relayer allowance AND every
 * outstanding `Exclusive` signature, and neither announces itself.
 *
 * **The check: `deployments/<chainid>.json` must name the settlement.** The alternative — bind
 * only to a settlement deployed in the same run — is the cleaner signal and the wrong tool here,
 * because these two scripts exist to add one address to a deployment that went live weeks ago.
 * Reading the record instead makes two sources agree before anything is signed: the address the
 * operator typed, and a committed file. It also forces the record to be written before the
 * periphery is deployed, rather than from memory afterwards.
 *
 * The record must name the relayer too, and the settlement is the authority on it. A record whose
 * settlement line was updated and whose relayer line was not is a record nobody can trust, and it
 * fails here rather than being copied into a systemd unit.
 *
 * A fork dry run deploys a settlement no record can know about. `PROVE_SETTLEMENT_OFF_RECORD` is
 * for that, and it takes the address rather than a boolean: typing the same address into a second
 * variable is a deliberate act, and a flag left in a shell cannot wave through tomorrow's
 * different address.
 */
abstract contract GuardedScript is Script {
    /// @dev No `deployers` for this chain and no `PROVE_DEPLOYER`. Nobody wrote the expectation
    ///      down, so there is nothing to check against and the deploy stops.
    error DeployerUnset(uint256 chainId);

    /// @dev The key forge is holding is not one this chain expects. The address is public; the
    ///      key it came from is never read here and never printed.
    error WrongDeployer(address signer);

    /// @dev No `deployments/<chainid>.json`, or one that does not name both the settlement and
    ///      its relayer. A record that cannot answer both questions is not a record.
    error NoDeploymentRecord(uint256 chainId);

    error SettlementNotRecorded(address named, address recorded);
    error RecordedRelayerMismatch(address onChain, address recorded);

    /// @dev The override key, named once. `_requireExpectedDeployer` takes it as an argument so a
    ///      test can exercise the rule on a key nothing else touches — `vm.setEnv` writes the
    ///      process environment, which is not EVM state, and forge runs tests in parallel.
    string internal constant DEPLOYER_ENV = "PROVE_DEPLOYER";

    /// @dev The other override key, named once, for the same reason.
    string internal constant OFF_RECORD_ENV = "PROVE_SETTLEMENT_OFF_RECORD";

    // ── Who is signing ───────────────────────────────────────────────────────

    /**
     * @dev Stop unless `msg.sender` is a signer this chain named in advance. Call it before
     *      `startBroadcast`, so the wrong key costs a failed simulation and nothing else.
     *
     *      Every script passes `DEPLOYER_ENV` rather than calling a no-argument wrapper, and that
     *      is not a style choice. `forge coverage` cannot anchor a counter to a zero-argument
     *      internal call used as a statement: it reports the line as never run however many times
     *      it runs, and `tools/coverage-gate.py` then fails the build for six lines that are in
     *      fact covered eight times each. Measured — the same call with one argument counts fine.
     */
    function _requireExpectedDeployer(string memory envKey) internal view {
        address signer = msg.sender;
        console.log("signer          ", signer);

        address only = vm.envOr(envKey, address(0));
        if (only != address(0)) {
            if (signer != only) revert WrongDeployer(signer);
            return;
        }

        address[] memory allowed = _expectedDeployers();
        if (allowed.length == 0) revert DeployerUnset(block.chainid);
        for (uint256 k = 0; k < allowed.length; k++) {
            if (allowed[k] == signer) return;
        }
        revert WrongDeployer(signer);
    }

    /**
     * @dev The `deployers` list for this chain, or empty. Empty is a refusal, never a pass.
     *
     * **This asks whether the file and the key are there rather than reverting to find out**, and
     * the reason is that the obvious version cannot run. It was `try this.readConfiguredDeployers(…)`,
     * and forge refuses `address(this)` inside a script contract — a script is ephemeral and its
     * address means nothing — so every deploy died before it read a single value:
     *
     *     Error: script failed: Usage of `address(this)` detected in script contract.
     *
     * Twenty tests covered this guard and every one passed, because a `try this.…` in a *test*
     * contract is ordinary Solidity. The rule only binds a script. So the tests were a proxy for
     * the thing rather than the thing, and the first run that could have noticed was a real
     * deploy against a real chain. That is the same trap as counting `[FAIL` lines instead of
     * reading forge's summary, and it cost this deployment its first attempt.
     *
     * Asking is also the better shape on its own merits. A `catch` swallowed every revert, so a
     * `deployers` array with a typo in it read as "this chain expects nobody" — which fails
     * closed, but says the wrong thing about why. Now a missing file and a missing key answer
     * "no expectation", and a malformed list is loud.
     */
    function _expectedDeployers() internal view returns (address[] memory) {
        string memory path =
            string.concat(vm.projectRoot(), "/config/", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) return new address[](0);
        string memory json = vm.readFile(path);
        if (!vm.keyExistsJson(json, ".deployers")) return new address[](0);
        return vm.parseJsonAddressArray(json, ".deployers");
    }

    /**
     * @dev Ask what a chain expects, without deploying anything:
     *      `forge script … --sig 'readConfiguredDeployers(uint256)' 369`.
     *
     *      No longer load-bearing — `_expectedDeployers` reads the file itself — but kept, because
     *      it is the only way to interrogate the expectation from outside a deploy.
     */
    function readConfiguredDeployers(uint256 chainId) external view returns (address[] memory) {
        string memory json =
            vm.readFile(string.concat(vm.projectRoot(), "/config/", vm.toString(chainId), ".json"));
        return vm.parseJsonAddressArray(json, ".deployers");
    }

    // ── Which settlement ─────────────────────────────────────────────────────

    /// @dev Stop unless `deployments/<chainid>.json` names this settlement as the current one,
    ///      and the relayer it names is the one the settlement itself answers.
    function _requireRecordedSettlement(address settlement) internal view {
        _requireRecordedSettlement(settlement, OFF_RECORD_ENV);
    }

    function _requireRecordedSettlement(address settlement, string memory envKey) internal view {
        if (vm.envOr(envKey, address(0)) == settlement) {
            console.log("record          OFF RECORD, acknowledged by PROVE_SETTLEMENT_OFF_RECORD");
            console.log("                Right for a fork dry run. Wrong for a real chain.");
            return;
        }

        // Asked rather than caught, for the reason `_expectedDeployers` records: forge refuses
        // `address(this)` in a script contract, so `try this.…` cannot run in the thing this
        // guard exists to guard.
        string memory recordPath =
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        if (!vm.exists(recordPath)) revert NoDeploymentRecord(block.chainid);
        string memory record = vm.readFile(recordPath);
        if (
            !vm.keyExistsJson(record, ".contracts.ProveSettlement")
                || !vm.keyExistsJson(record, ".contracts.ProveRelayer")
        ) revert NoDeploymentRecord(block.chainid);
        address recorded = vm.parseJsonAddress(record, ".contracts.ProveSettlement");
        address recordedRelayer = vm.parseJsonAddress(record, ".contracts.ProveRelayer");

        if (recorded != settlement) revert SettlementNotRecorded(settlement, recorded);

        address onChain = ISettlementRelayer(settlement).relayer();
        if (recordedRelayer != onChain) revert RecordedRelayerMismatch(onChain, recordedRelayer);

        console.log("record          deployments/%s.json names it", vm.toString(block.chainid));
    }

    /// @dev No longer load-bearing — `_requireRecordedSettlement` reads the file itself — but kept
    ///      as the way to ask what a chain's record names without deploying anything.
    function readDeploymentRecord(uint256 chainId)
        external
        view
        returns (address settlement, address relayer)
    {
        string memory json = vm.readFile(
            string.concat(vm.projectRoot(), "/deployments/", vm.toString(chainId), ".json")
        );
        settlement = vm.parseJsonAddress(json, ".contracts.ProveSettlement");
        relayer = vm.parseJsonAddress(json, ".contracts.ProveRelayer");
    }
}
