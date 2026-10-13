// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {GuardedScript} from "../script/Guards.sol";
import {DeployBatchExecutor} from "../script/DeployBatchExecutor.s.sol";
import {DeployRfqVenue} from "../script/DeployRfqVenue.s.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {FeeDefaults} from "../src/FeeDefaults.sol";
import {ProveReader} from "../src/ProveReader.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ProveRelayer} from "../src/ProveRelayer.sol";
import {ProveBatchExecutor} from "../src/ProveBatchExecutor.sol";
import {ProveExecutor} from "../src/ProveExecutor.sol";
import {RfqVenue} from "../src/RfqVenue.sol";
import {MockERC20, NO_PERMIT2} from "./Mocks.sol";
import {newSettlement} from "./Fees.sol";

/**
 * @notice The deploy scripts, run for real.
 *
 *   forge test --match-path test/Deploy.t.sol -vv
 *
 * `Deploy.s.sol` is the code here that spends the most money: one run on PulseChain costs near
 * sixteen thousand PLS at today's gas price, and a mistake in it is not a failing test, it is a
 * live settlement wired to the wrong stray config or a defaults contract owned by the wrong
 * address.
 *
 * Four claims are under test.
 *
 * **The committed configuration deploys.** `config/369.json`, `config/943.json` and the matching
 * entries of `config/fee-configs.json` are read exactly as a real run reads them, so a hand edit
 * that drops a key or mistypes an address fails in CI instead of on chain.
 *
 * **The library is linked.** `ProveSettlement.claim` is a delegatecall into the external library
 * `FeeClaimLib`. A settlement deployed with the library unlinked, or linked to nothing, would
 * deploy perfectly well and then revert on every `claim`, with fees booked that nobody can pay
 * out. So the deployed settlement is made to hold a stray token and pay it out.
 *
 * **The fee configuration is exactly the file's.** The stray config the settlement was
 * constructed with, the FeeDefaults history, and the owner handover are asserted against the
 * file rather than against constants typed here.
 *
 * **A zero stops the script rather than being filled in.** Permit2, the stray config, the first
 * default and the signer are each required outright, and no value is invented for them.
 */
contract DeployTest is Test {
    /**
     * @dev A chain id per test, for the configuration each one writes itself.
     *
     * Forge runs the tests in a contract in parallel, and a file is not EVM state: two tests
     * sharing `config/<id>.json` race, and the loser reads the other's configuration. The
     * symptom is a revert with somebody else's message, which reads like a bug in the script.
     */
    uint256 constant CHAIN_NO_OWNER = 424_204;
    uint256 constant CHAIN_NO_PERMIT2 = 424_206;
    uint256 constant CHAIN_NO_DEPLOYER = 424_207;
    uint256 constant CHAIN_NO_RECORD = 424_208;
    /// @dev Its record file exists and is missing a key. `foundry.toml` names this one path
    ///      writable so the test can make that state; nothing else in `deployments/` is.
    uint256 constant CHAIN_HALF_RECORD = 424_209;
    uint256 constant CHAIN_NO_FEE_ENTRY = 424_210;
    uint256 constant CHAIN_BAD_STRAY = 424_211;
    uint256 constant CHAIN_BAD_DEFAULT = 424_212;
    uint256 constant CHAIN_DEST_IS_OURS = 424_299;
    uint256 constant CHAIN_DEST_IS_LIB = 424_298;
    /// @dev Copies of the committed files, under scratch chain ids.
    uint256 constant CHAIN_AS_369 = 424_213;
    uint256 constant CHAIN_AS_943 = 424_214;
    uint256 constant CHAIN_AS_943_SECOND = 424_215;
    uint256 constant CHAIN_NO_HISTORY = 424_216;

    address constant OWNER = address(0xB0B);
    address constant DEST = address(0x5152);
    /// @dev Stands in for Permit2 in the scratch configurations. The scripts only pass it on and
    ///      the settlement only refuses a zero, so any non-zero address deploys.
    address constant PERMIT2 = address(0x2612);

    Deploy deployer;

    function setUp() public fromACleanEnvironment {
        deployer = new Deploy();
    }

    /**
     * @dev Reset every key the script reads to the value it treats as absent.
     *
     * This belongs on each test and not in `setUp`. `setUp` runs once and the tests restore its
     * EVM state, but `vm.setEnv` writes the process environment, which is not EVM state and is
     * not restored. A key one test sets is still set for the next one.
     */
    modifier fromACleanEnvironment() {
        _clearEnv();
        _;
        _clearEnv();
    }

    function _clearEnv() internal {
        vm.setEnv("PROVE_OWNER", "0x0000000000000000000000000000000000000000");
        vm.setEnv("PROVE_PERMIT2", "0x0000000000000000000000000000000000000000");
        // Zeroed here and set non-zero by nothing, ever. Every `run()` in the suite reads this
        // key, so a test that wrote an address into it would race every other test. The rule it
        // guards — the environment narrows the list to one signer — is tested through
        // `DeployHarness` on `PROVE_T_DEPLOYER`, a key nothing else touches.
        vm.setEnv("PROVE_DEPLOYER", "0x0000000000000000000000000000000000000000");
        // `PROVE_SETTLEMENT` and `PROVE_SETTLEMENT_OFF_RECORD` are deliberately absent from this
        // list. One test owns both: it sets them and reads them back, and clearing them here
        // would race that test rather than protect it. Every key above is written to the same
        // value by every test, so those writes cannot race.
    }

    // ── The configuration that is committed ──────────────────────────────────

    function test_TheMainnetConfigDeploysWhatTheFilesSay() public fromACleanEnvironment {
        _assertConfigDeploys(369, CHAIN_AS_369);
    }

    function test_TheTestnetConfigDeploysWhatTheFilesSay() public fromACleanEnvironment {
        _assertConfigDeploys(943, CHAIN_AS_943);
    }

    /**
     * @dev Deploy the committed `committed` configuration under the scratch chain id `chainId`.
     *
     * Every field is asserted against the files rather than against a copy of them typed here.
     * A constant in this test would go on agreeing with itself after somebody edited a file.
     */
    function _assertConfigDeploys(uint256 committed, uint256 chainId) internal {
        string memory json = vm.readFile(_configPath(committed));
        vm.writeFile(_configPath(chainId), json);
        vm.chainId(chainId);
        DeployFor script = new DeployFor(vm.toString(committed), _feeConfigsFile());

        // Run it as the key the file says may sign, and not as this test contract. The signer
        // check is the first thing `run()` does, so a committed file that names nobody, or names
        // somebody the operator cannot be, fails here.
        address[] memory signers = vm.parseJsonAddressArray(json, ".deployers");
        assertGt(signers.length, 0, "the file names who may sign");
        address signer = signers[0];
        (ProveSettlement settlement, ProveExecutor executor) = _asSigner(signer).deploy(script);

        // The settlement has no owner at all. Nothing on it is gated, so there is nothing for
        // `owner` to be: the file's `owner` goes to FeeDefaults, the one owned contract.
        string memory fees = vm.readFile(_feeConfigsFile());
        string memory chain = string.concat(".", vm.toString(committed));

        // The stray config is the file's, hashed.
        FeeConfig.Config memory stray = _strayOf(fees, chain);
        assertEq(settlement.STRAY_CONFIG(), FeeConfig.hash(stray), "the file's stray config");

        // The defaults are the LAST history entry, published once, owned by the signer until the
        // owner accepts.
        _assertDefaults(
            script.feeDefaults(), fees, chain, signer, vm.parseJsonAddress(json, ".owner")
        );

        // The reader is wired to both.
        ProveReader reader = script.reader();
        assertEq(
            address(reader.settlement()), address(settlement), "the reader reads this settlement"
        );
        assertEq(address(reader.feeDefaults()), address(script.feeDefaults()), "and these defaults");

        // Permit2 is not on the settlement: it goes to the relayer, which is the only contract
        // that calls it, and this is where a wrong wiring would show as a rung nobody can use.
        assertEq(
            ProveRelayer(settlement.relayer()).permit2(),
            vm.parseJsonAddress(json, ".permit2"),
            "the relayer was wired to the Permit2 the file names"
        );

        // Four addresses out of two `new`s, and every one of them wired to the others.
        assertEq(address(executor.settlement()), address(settlement), "the executor fills here");
        assertEq(executor.relayer(), settlement.relayer(), "one relayer, read from the source");
        assertTrue(settlement.relayer() != address(0), "the settlement deployed its relayer");
        assertTrue(
            address(executor.sinkTemplate()) != address(0), "the executor deployed its call sink"
        );
        assertTrue(
            address(executor.sinkTemplate()) != address(executor), "and the sink is not itself"
        );

        // The library is linked: a token nobody owns is swept to the stray config and `claim`
        // pays it, through the delegatecall. An unlinked or mislinked settlement reverts here.
        _assertClaimThroughTheLibrary(settlement, stray);
        _clean(chainId);
    }

    function _assertDefaults(
        FeeDefaults defaults,
        string memory fees,
        string memory chain,
        address signer,
        address owner
    ) internal view {
        assertEq(defaults.versions(), 1, "one initial default");
        (, FeeDefaults.Record memory rec) = defaults.current();
        uint256 n = _historyLength(fees, chain);
        assertGt(n, 0, "the file names at least one default");
        string memory last = string.concat(chain, ".history[", vm.toString(n - 1), "]");
        assertEq(
            uint256(rec.rates.handover),
            vm.parseJsonUint(fees, string.concat(last, ".rates.handover"))
        );
        assertEq(
            uint256(rec.rates.output), vm.parseJsonUint(fees, string.concat(last, ".rates.output"))
        );
        assertEq(
            uint256(rec.rates.proceeds),
            vm.parseJsonUint(fees, string.concat(last, ".rates.proceeds"))
        );
        assertEq(
            uint256(rec.warn.output), vm.parseJsonUint(fees, string.concat(last, ".warn.output"))
        );
        FeeConfig.Config memory initial;
        initial.destinations = vm.parseJsonAddressArray(fees, string.concat(last, ".destinations"));
        initial.weights = vm.parseJsonUintArray(fees, string.concat(last, ".weights"));
        assertEq(rec.feeConfig, FeeConfig.hash(initial), "the last entry's config");
        assertEq(defaults.owner(), signer, "the signer owns FeeDefaults until the owner accepts");
        assertEq(defaults.pendingOwner(), owner, "and proposes the owner");
    }

    /// @dev Sweep a stray token and claim it, on a settlement the script deployed.
    function _assertClaimThroughTheLibrary(
        ProveSettlement settlement,
        FeeConfig.Config memory stray
    ) internal {
        MockERC20 token = new MockERC20("T", "T", 18);
        token.mint(address(settlement), 1_000e18);
        assertEq(settlement.sweepUnowned(address(token)), 1_000e18, "all of it is unowned");
        assertEq(settlement.pendingFees(settlement.STRAY_CONFIG(), address(token)), 1_000e18);
        uint256 paid = settlement.claim(stray, address(token));
        assertEq(paid, 1_000e18, "claim paid the stray config's destinations");
        uint256 got;
        for (uint256 k = 0; k < stray.destinations.length; k++) {
            got += token.balanceOf(stray.destinations[k]);
        }
        assertEq(got, 1_000e18, "and they hold it");
        assertEq(settlement.pendingFees(settlement.STRAY_CONFIG(), address(token)), 0, "book empty");
    }

    /// @notice Neither chain file carries a key from the retired designs, and neither carries a
    ///         fee rate. The settlement takes no fee of its own and has no owner to configure.
    function test_NeitherCommittedFileCarriesARetiredKeyOrAFeeRate() public view {
        uint256[2] memory chains = [uint256(369), 943];
        for (uint256 k = 0; k < chains.length; k++) {
            string memory json = vm.readFile(_configPath(chains[k]));
            assertTrue(!vm.keyExistsJson(json, ".feeSinks"), "the sink registry is gone");
            assertTrue(!vm.keyExistsJson(json, ".defaultProceeds"), "so is the sweep destination");
            assertTrue(!vm.keyExistsJson(json, ".feeFloorRate"), "a floor nothing reads");
            assertTrue(!vm.keyExistsJson(json, ".protocolShare"), "a share nothing divides");
            assertTrue(!vm.keyExistsJson(json, ".burnToken"), "a token nothing burns");
            assertTrue(!vm.keyExistsJson(json, ".router"), "a router nothing trades at");
        }
    }

    // ── What a zero means ────────────────────────────────────────────────────

    /// @notice The owner falls back to the signer, so a dry run on a throwaway fork needs no
    ///         owner in the file, and nothing is left to accept.
    function test_TheOwnerFallsBackToTheSigner() public fromACleanEnvironment {
        _scratch(CHAIN_NO_OWNER, address(0));
        DeployFor script = _scratchScript(CHAIN_NO_OWNER, _validFeeConfigs(CHAIN_NO_OWNER));
        script.run();
        FeeDefaults defaults = script.feeDefaults();
        assertEq(defaults.owner(), address(this), "the caller owns what it deployed");
        assertEq(defaults.pendingOwner(), address(0), "and proposes nobody");
        _clean(CHAIN_NO_OWNER);
    }

    /// @notice A file with no `permit2` stops the script, and that is not fussiness.
    ///
    /// Permit2 backs a whole custody rung. A zero would deploy perfectly well and then answer
    /// `EscrowShort` for every leg on that rung for ever — the same reason an unarmed leg gives,
    /// so nobody would read it as a misconfiguration.
    function test_AConfigWithNoPermit2Stops() public fromACleanEnvironment {
        vm.chainId(CHAIN_NO_PERMIT2);
        vm.writeFile(
            _configPath(CHAIN_NO_PERMIT2),
            string.concat(_signedByThisTest(), '"owner":"', vm.toString(OWNER), '"}')
        );
        vm.expectRevert(Deploy.Permit2Required.selector);
        deployer.run();
        _clean(CHAIN_NO_PERMIT2);
    }

    /// @notice A chain with no entry in `fee-configs.json` stops the script. The stray config is
    ///         the one place a token nobody owns can go, so none is invented.
    function test_AChainWithNoFeeConfigEntryStops() public fromACleanEnvironment {
        _scratch(CHAIN_NO_FEE_ENTRY, OWNER);
        // The committed file, whose keys are 369 and 943 only.
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.FeeConfigRequired.selector, CHAIN_NO_FEE_ENTRY)
        );
        deployer.run();
        _clean(CHAIN_NO_FEE_ENTRY);
    }

    /// @notice An entry with no history has no initial defaults to publish, and stops.
    function test_AnEntryWithNoHistoryStops() public fromACleanEnvironment {
        _scratch(CHAIN_NO_HISTORY, OWNER);
        string memory file = string.concat(
            '{"',
            vm.toString(CHAIN_NO_HISTORY),
            '":{"feeDefaults":null,"strayConfig":',
            _configJson(DEST),
            ',"history":[]}}'
        );
        DeployFor script = _scratchScript(CHAIN_NO_HISTORY, file);
        vm.expectRevert(abi.encodeWithSelector(Deploy.FeeConfigRequired.selector, CHAIN_NO_HISTORY));
        script.run();
        _clean(CHAIN_NO_HISTORY);
    }

    /// @notice A stray config that is not a valid fee config stops the script before the
    ///         constructor sees it: weights that do not sum to one.
    function test_AnInvalidStrayConfigStops() public fromACleanEnvironment {
        _scratch(CHAIN_BAD_STRAY, OWNER);
        string memory file = string.concat(
            '{"',
            vm.toString(CHAIN_BAD_STRAY),
            '":{"feeDefaults":null,"strayConfig":',
            '{"destinations":["',
            vm.toString(DEST),
            '"],"weights":["1"]}',
            ',"history":[',
            _historyJson(DEST),
            "]}}"
        );
        DeployFor script = _scratchScript(CHAIN_BAD_STRAY, file);
        vm.expectRevert(
            abi.encodeWithSelector(
                Deploy.BadFeeConfig.selector, FeeConfig.Fault.WeightsDoNotSumToWad
            )
        );
        script.run();
        _clean(CHAIN_BAD_STRAY);
    }

    /// @notice An invalid initial default (a zero destination) stops the script too.
    function test_AnInvalidInitialDefaultStops() public fromACleanEnvironment {
        _scratch(CHAIN_BAD_DEFAULT, OWNER);
        string memory file = string.concat(
            '{"',
            vm.toString(CHAIN_BAD_DEFAULT),
            '":{"feeDefaults":null,"strayConfig":',
            _configJson(DEST),
            ',"history":[',
            _historyJson(address(0)),
            "]}}"
        );
        DeployFor script = _scratchScript(CHAIN_BAD_DEFAULT, file);
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.BadFeeConfig.selector, FeeConfig.Fault.ZeroDestination)
        );
        script.run();
        _clean(CHAIN_BAD_DEFAULT);
    }

    /// @notice A published default that pays a contract of the set stops the deploy after it, and
    ///         before anything is recorded. `FeeDefaults` can only refuse itself; the relayer is
    ///         knowable only once the settlement exists. Under a broadcast the first `new` is created by
    ///         the broadcaster at its next nonce, so the settlement, and the relayer it deploys,
    ///         are predictable here.
    function test_ADefaultThatPaysAContractOfTheSetStopsTheDeploy() public fromACleanEnvironment {
        _scratch(CHAIN_DEST_IS_OURS, OWNER);
        // A dry run first, rolled back, to learn where the relayer will be: the same script
        // deploys it at the same address from the same state.
        DeployFor probe = _scratchScript(CHAIN_DEST_IS_OURS, _validFeeConfigs(CHAIN_DEST_IS_OURS));
        uint256 snap = vm.snapshotState();
        (ProveSettlement dry,) = probe.run();
        address relayerAt = dry.relayer();
        vm.revertToState(snap);
        string memory file = string.concat(
            '{"',
            vm.toString(CHAIN_DEST_IS_OURS),
            '":{"feeDefaults":null,"strayConfig":',
            _configJson(DEST),
            ',"history":[',
            _historyJson(relayerAt),
            "]}}"
        );
        vm.writeFile(_scratchFeesPath(CHAIN_DEST_IS_OURS), file);
        vm.expectRevert(abi.encodeWithSelector(Deploy.DestinationIsDeployed.selector, relayerAt));
        probe.run();
        _clean(CHAIN_DEST_IS_OURS);
    }

    /// @notice The library forge links into the settlement (`FeeClaimLib`) is of the set too,
    ///         though the script never names it: a stray config that pays it stops the deploy.
    ///         The library's address is read off the settlement's code, as the script reads it.
    function test_AConfigThatPaysTheLinkedLibraryStopsTheDeploy() public fromACleanEnvironment {
        _scratch(CHAIN_DEST_IS_LIB, OWNER);
        DeployFor probe = _scratchScript(CHAIN_DEST_IS_LIB, _validFeeConfigs(CHAIN_DEST_IS_LIB));
        uint256 snap = vm.snapshotState();
        (ProveSettlement dry,) = probe.run();
        address[] memory libs = new DeployHarness().linkedLibraries(address(dry).code);
        vm.revertToState(snap);
        assertEq(libs.length, 1, "exactly one linked library");
        address libAt = libs[0];
        assertGt(libAt.code.length, 0, "deployed");
        string memory file = string.concat(
            '{"',
            vm.toString(CHAIN_DEST_IS_LIB),
            '":{"feeDefaults":null,"strayConfig":',
            _configJson(libAt),
            ',"history":[',
            _historyJson(DEST),
            "]}}"
        );
        vm.writeFile(_scratchFeesPath(CHAIN_DEST_IS_LIB), file);
        vm.expectRevert(abi.encodeWithSelector(Deploy.DestinationIsDeployed.selector, libAt));
        probe.run();
        _clean(CHAIN_DEST_IS_LIB);
    }

    /// @notice The library walk reads opcodes, not bytes: a `PUSH20` hidden in push data, an
    ///         operand with no code, an operand whose code does not open with its own address,
    ///         and a `PUSH20` cut short by the end of the code are all not libraries.
    function test_TheLibraryWalkFindsOnlyLibraries() public {
        DeployHarness harness = new DeployHarness();
        address lib = address(0x000000000000000000000000000000000000AB1e);
        address other = address(0x000000000000000000000000000000000000c0DE);
        address empty = address(0x000000000000000000000000000000000000E0E0);
        // A library's head: PUSH20 <itself> ADDRESS EQ, then anything.
        vm.etch(lib, abi.encodePacked(bytes1(0x73), lib, hex"3014"));
        // Opens with PUSH20, but of a different address.
        vm.etch(other, abi.encodePacked(bytes1(0x73), lib, hex"3014"));
        // Too short to carry the guard.
        vm.etch(empty, hex"00");
        // The via_ir head: free-memory setup, then ADDRESS PUSH32 <itself>.
        address irLib = address(0x000000000000000000000000000000000000001B);
        vm.etch(
            irLib,
            abi.encodePacked(hex"608060405230", bytes1(0x7f), bytes32(uint256(uint160(irLib))))
        );
        // A PUSH32 of something else, and a PUSH20 / PUSH32 cut short by the end of the code.
        address notIr = address(0x000000000000000000000000000000000000002b);
        vm.etch(notIr, abi.encodePacked(bytes1(0x7f), bytes32(uint256(1)), bytes1(0x73), bytes1(0)));
        address cutIr = address(0x000000000000000000000000000000000000003b);
        vm.etch(
            cutIr,
            abi.encodePacked(
                hex"6080604052305b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b", bytes1(0x7f), bytes20(cutIr)
            )
        );

        // PUSH32 whose data carries 0x73 + lib: data, not code, so not read.
        bytes memory hidden = abi.encodePacked(bytes1(0x7f), bytes1(0x73), lib, bytes11(0));
        assertEq(harness.linkedLibraries(hidden).length, 0, "push data is not code");

        bytes memory code = abi.encodePacked(
            bytes1(0x73),
            empty,
            bytes1(0x73),
            other,
            bytes1(0x73),
            address(0xDEAD),
            bytes1(0x73),
            address(harness),
            bytes1(0x73),
            notIr,
            bytes1(0x73),
            cutIr,
            bytes1(0x80)
        );
        assertEq(harness.linkedLibraries(code).length, 0, "no operand is a library");

        code = abi.encodePacked(bytes1(0x60), bytes1(0x73), bytes1(0x73), lib, bytes1(0x73));
        address[] memory found = harness.linkedLibraries(code);
        assertEq(found.length, 1, "one library, after a PUSH1 of 0x73");
        assertEq(found[0], lib);

        found = harness.linkedLibraries(
            abi.encodePacked(bytes1(0x73), irLib, bytes1(0x73), lib, bytes1(0x73), irLib)
        );
        assertEq(found.length, 2, "the via_ir head and the legacy head, each once");
        assertEq(found[0], irLib);
        assertEq(found[1], lib);

        // The same PUSH20, one byte short of its operand.
        bytes memory cut = abi.encodePacked(bytes1(0x73), bytes19(bytes20(lib)));
        assertEq(harness.linkedLibraries(cut).length, 0, "a truncated PUSH20 is not read");
    }

    // ── The environment ──────────────────────────────────────────────────────

    /**
     * @notice Environment beats file.
     *
     * This goes through `_address` directly, on an environment key no other test reads, and not
     * through `run()`. `vm.setEnv` writes the process environment, which is not EVM state:
     * forge runs tests in parallel, so a test that sets `PROVE_OWNER` and a test that reads it are
     * a race, and the loser fails with the winner's configuration. Both helpers take the key as an
     * argument, so a test can name one nobody else touches and the race disappears.
     */
    function test_TheEnvironmentBeatsTheFileForAnAddress() public {
        DeployHarness harness = new DeployHarness();
        string memory json = '{"owner":"0x00000000000000000000000000000000000000B0"}';

        assertEq(harness.addressFrom(json, ".owner", "PROVE_T_ADDR"), address(0xB0), "the file");

        vm.setEnv("PROVE_T_ADDR", vm.toString(address(0xEEE1)));
        assertEq(harness.addressFrom(json, ".owner", "PROVE_T_ADDR"), address(0xEEE1), "the env");
    }

    /// @notice A key neither the file nor the environment carries reads as the zero address.
    function test_AnAddressNeitherSourceCarriesReadsAsZero() public {
        DeployHarness harness = new DeployHarness();
        assertEq(harness.addressFrom("{}", ".owner", "PROVE_T_MISSING_ADDR"), address(0));
    }

    // ── The two periphery scripts ────────────────────────────────────────────

    /**
     * @notice Two executors on one settlement cannot collide on a caller's sink address.
     *
     * The sink salt is the caller's own address, so one solver uses the SAME salt at both
     * executors. Nothing collides anyway, and for two reasons rather than one: a CREATE2 address
     * mixes in the deployer, and the two executors are different deployers; it also mixes in the
     * init code, which carries each executor's own template address.
     *
     * What a solver sees is two sinks, one per executor. A token stranded at one comes home
     * through that one.
     */
    function test_TwoExecutorsCannotCollideOnACallersSink() public {
        ProveSettlement settlement = newSettlement(NO_PERMIT2);
        ProveExecutor one = new ProveExecutor(address(settlement));
        ProveBatchExecutor many = new ProveBatchExecutor(address(settlement));

        address template = address(one.sinkTemplate());
        assertTrue(
            template != address(many.sinkTemplate()), "each executor deployed its own template"
        );

        bytes32 salt = bytes32(uint256(uint160(address(0xCA11))));
        assertTrue(
            Clones.predictDeterministicAddress(template, salt, address(one))
                != Clones.predictDeterministicAddress(
                    address(many.sinkTemplate()), salt, address(many)
                ),
            "one caller's salt named the same sink at both executors"
        );

        // The deployer alone separates them, even holding the template constant.
        assertTrue(
            Clones.predictDeterministicAddress(template, salt, address(one))
                != Clones.predictDeterministicAddress(template, salt, address(many)),
            "two deployers, one salt, one address"
        );
    }

    /**
     * @notice `DeployBatchExecutor` and `DeployRfqVenue` bind only to the settlement the record
     *         for this chain names, and refuse a live one it does not.
     *
     * Every claim in one test, because `PROVE_SETTLEMENT` and `PROVE_SETTLEMENT_OFF_RECORD` are
     * read by fixed keys inside the scripts. `vm.setEnv` writes the process environment, which is
     * not EVM state, and forge runs tests in parallel — so four tests writing those keys would
     * race. One test writes them in order, and no other test in the suite touches either.
     *
     * It runs on chain 943, against the committed record's own addresses, with a
     * settlement-shaped account etched where the record says the settlement is. Nothing is
     * deployed to a real chain and no address is retyped here: a record edit has to agree with
     * this test.
     *
     * The refusal is the point. `stale` below is a REAL settlement — code, and a non-zero
     * `relayer()` it deployed itself. It is exactly what yesterday's mainnet settlement looks
     * like from the constructor's side, and the constructor waves it through. Only the record
     * tells the two apart.
     */
    function test_ThePeripheryScriptsBindOnlyToTheSettlementTheRecordNames()
        public
        fromACleanEnvironment
    {
        vm.chainId(943);
        string memory record = vm.readFile(_recordPath(943));
        address recorded = vm.parseJsonAddress(record, ".contracts.ProveSettlement");
        address recordedRelayer = vm.parseJsonAddress(record, ".contracts.ProveRelayer");
        address signer = vm.parseJsonAddressArray(vm.readFile(_configPath(943)), ".deployers")[0];

        _settlementShapedAt(recorded, recordedRelayer);
        AsSigner testnetDeployer = _asSigner(signer);

        vm.setEnv("PROVE_SETTLEMENT", vm.toString(recorded));
        ProveBatchExecutor executor = testnetDeployer.batch(new DeployBatchExecutor());
        assertEq(address(executor.settlement()), recorded, "the executor fills at the record's");
        assertEq(executor.relayer(), recordedRelayer, "and pulls through the record's relayer");
        assertTrue(
            address(executor.sinkTemplate()) != address(0), "one `new` produced two addresses"
        );

        RfqVenue venue = testnetDeployer.venue(new DeployRfqVenue());
        assertEq(address(venue.settlement()), recorded, "the venue settles at the record's");
        assertEq(venue.relayer(), recordedRelayer, "and pulls through the same relayer");

        // Yesterday's settlement, in every way that a constructor can see.
        ProveSettlement stale = newSettlement(NO_PERMIT2);
        assertTrue(stale.relayer() != address(0), "it answers relayer() like any other");
        vm.setEnv("PROVE_SETTLEMENT", vm.toString(address(stale)));

        bytes memory refusal = abi.encodeWithSelector(
            GuardedScript.SettlementNotRecorded.selector, address(stale), recorded
        );
        DeployRfqVenue rfq = new DeployRfqVenue();
        vm.expectRevert(refusal);
        testnetDeployer.venue(rfq);

        DeployBatchExecutor batch = new DeployBatchExecutor();
        vm.expectRevert(refusal);
        testnetDeployer.batch(batch);

        /*
         * The constructor check is still there and still first past the record. A wrong chain and
         * a mistyped address read the same on this side, and `PROVE_SETTLEMENT_OFF_RECORD` is how
         * a fork dry run says it means a settlement no record can know about — so this is the
         * state a dry run is actually in, and the constructor is what catches it.
         *
         * `stopBroadcast` after each one, because that revert happens between `startBroadcast`
         * and `stopBroadcast` and leaves the broadcast open. The next script would fail on that
         * instead, and the assertion would be reading the wrong error.
         */
        vm.setEnv("PROVE_SETTLEMENT", vm.toString(address(0xDEAD)));
        vm.setEnv("PROVE_SETTLEMENT_OFF_RECORD", vm.toString(address(0xDEAD)));

        DeployBatchExecutor offRecordBatch = new DeployBatchExecutor();
        vm.expectRevert(ProveBatchExecutor.BadSettlement.selector);
        testnetDeployer.batch(offRecordBatch);
        vm.stopBroadcast();

        DeployRfqVenue offRecordRfq = new DeployRfqVenue();
        vm.expectRevert(RfqVenue.BadSettlement.selector);
        testnetDeployer.venue(offRecordRfq);
        vm.stopBroadcast();

        vm.setEnv("PROVE_SETTLEMENT_OFF_RECORD", "0x0000000000000000000000000000000000000000");
    }

    // ── Who is allowed to sign ───────────────────────────────────────────────

    /**
     * @notice The signer and the owner are different addresses on both chains.
     *
     * That separation is the whole reason a third key exists, and it is the reason the signer
     * check is worth having: "it deployed and I own it" cannot be evidence that the right key
     * signed when the two are the same address. A config edit that pointed `deployers` at the
     * owner would quietly undo it, and this is what notices.
     */
    function test_NeitherCommittedFileLetsTheOwnerSign() public view {
        uint256[2] memory chains = [uint256(369), 943];
        for (uint256 c = 0; c < chains.length; c++) {
            string memory json = vm.readFile(_configPath(chains[c]));
            address owner = vm.parseJsonAddress(json, ".owner");
            address[] memory signers = vm.parseJsonAddressArray(json, ".deployers");
            assertGt(signers.length, 0, "a chain that names no signer deploys nowhere");
            for (uint256 k = 0; k < signers.length; k++) {
                assertTrue(signers[k] != owner, "the owner key signs no deploy");
                assertTrue(signers[k] != address(0), "a zero signer is not an expectation");
            }
        }
    }

    /// @notice Mainnet names exactly one key, and nothing else may sign there.
    function test_TheMainnetConfigNamesOneSigner() public view {
        address[] memory signers =
            vm.parseJsonAddressArray(vm.readFile(_configPath(369)), ".deployers");
        assertEq(signers.length, 1, "one key signs mainnet");
    }

    /**
     * @notice The wrong key stops the mainnet deploy, and it stops it before anything is signed.
     *
     * This is the mistake the check exists for: two password-manager entries with names a tired person
     * confuses, and until now nothing in the script noticed which one forge was handed. The test
     * calls `run()` directly, so `msg.sender` is this contract — a key chain 369 does not name.
     */
    function test_AKeyTheMainnetConfigDoesNotNameStops() public fromACleanEnvironment {
        vm.chainId(369);
        vm.expectRevert(abi.encodeWithSelector(GuardedScript.WrongDeployer.selector, address(this)));
        deployer.run();
    }

    /**
     * @notice The lab's anvil account is the second name on 943's list, and it may sign there.
     *
     * `app/scripts/lab/up.sh` runs anvil with `--chain-id 943` so every config file in the
     * repository loads unchanged, and signs the whole protocol up with anvil's first published
     * account. The list carries it for that reason, and this is the test that says so — it also
     * walks past the first entry, which nothing else does.
     */
    function test_TheSecondNameOn943MaySignToo() public fromACleanEnvironment {
        string memory json = vm.readFile(_configPath(943));
        address[] memory signers = vm.parseJsonAddressArray(json, ".deployers");
        assertEq(signers.length, 2, "the testnet deployer and the lab's anvil account");
        vm.writeFile(_configPath(CHAIN_AS_943_SECOND), json);
        vm.chainId(CHAIN_AS_943_SECOND);
        DeployFor script = new DeployFor("943", _feeConfigsFile());
        (ProveSettlement settlement,) = _asSigner(signers[1]).deploy(script);
        assertTrue(settlement.relayer() != address(0), "it deployed");
        _clean(CHAIN_AS_943_SECOND);
    }

    /**
     * @notice A config that names no signer stops the deploy. It does not skip the check.
     *
     * An expectation nobody wrote down is exactly the state this refuses. A check that passed
     * when unset would have been worth nothing on the one chain that mattered.
     */
    function test_AConfigThatNamesNoSignerStops() public fromACleanEnvironment {
        vm.chainId(CHAIN_NO_DEPLOYER);
        vm.writeFile(
            _configPath(CHAIN_NO_DEPLOYER),
            string.concat(
                '{"owner":"', vm.toString(OWNER), '","permit2":"', vm.toString(PERMIT2), '"}'
            )
        );
        vm.expectRevert(
            abi.encodeWithSelector(GuardedScript.DeployerUnset.selector, CHAIN_NO_DEPLOYER)
        );
        deployer.run();
        _clean(CHAIN_NO_DEPLOYER);
    }

    /// @notice A chain with no config file at all stops for the same reason.
    function test_AChainWithNoConfigFileStops() public fromACleanEnvironment {
        vm.chainId(CHAIN_NO_RECORD);
        DeployHarness harness = new DeployHarness();
        assertEq(harness.readConfiguredDeployersOrNone().length, 0, "no file, no expectation");
        vm.expectRevert(
            abi.encodeWithSelector(GuardedScript.DeployerUnset.selector, CHAIN_NO_RECORD)
        );
        harness.requireDeployer("PROVE_T_NO_DEPLOYER");
    }

    /**
     * @notice The environment narrows the list to one signer. It never widens it.
     *
     * On its own key, for the reason `test_TheEnvironmentBeatsTheFileForAnAddress` gives: forge
     * runs tests in parallel and `vm.setEnv` writes the process environment, so a test that put
     * an address in `PROVE_DEPLOYER` would race every other test in the suite.
     *
     * Three claims. The list refuses this contract. The key lets it through, over a list that
     * does not name it. And the key set to somebody else refuses it again — so a stale export
     * from a lab session fails closed on a real chain rather than falling back to the file.
     */
    function test_TheEnvironmentNarrowsTheSignerToOne() public {
        DeployHarness harness = new DeployHarness();
        vm.chainId(943);

        vm.expectRevert(abi.encodeWithSelector(GuardedScript.WrongDeployer.selector, address(this)));
        harness.requireDeployer("PROVE_T_DEPLOYER");

        vm.setEnv("PROVE_T_DEPLOYER", vm.toString(address(this)));
        harness.requireDeployer("PROVE_T_DEPLOYER");

        address[] memory signers =
            vm.parseJsonAddressArray(vm.readFile(_configPath(943)), ".deployers");
        vm.setEnv("PROVE_T_DEPLOYER", vm.toString(signers[0]));
        vm.expectRevert(abi.encodeWithSelector(GuardedScript.WrongDeployer.selector, address(this)));
        harness.requireDeployer("PROVE_T_DEPLOYER");

        vm.setEnv("PROVE_T_DEPLOYER", "0x0000000000000000000000000000000000000000");
    }

    // ── Which settlement the record names ────────────────────────────────────

    /**
     * @notice A chain with no deployment record refuses every settlement.
     *
     * Fail closed here too. The record is the second opinion, and a periphery deploy with no
     * second opinion is the deploy this check exists to stop.
     */
    function test_AChainWithNoRecordRefusesEverySettlement() public {
        DeployHarness harness = new DeployHarness();
        vm.chainId(CHAIN_NO_RECORD);
        vm.expectRevert(
            abi.encodeWithSelector(GuardedScript.NoDeploymentRecord.selector, CHAIN_NO_RECORD)
        );
        harness.requireRecorded(address(0xBEEF), "PROVE_T_OFF_RECORD");
    }

    /**
     * @notice A record whose relayer line did not keep up with its settlement line is refused.
     *
     * The settlement is the authority: it made the relayer in its own constructor and holds it
     * as an immutable. A record that disagrees is a record somebody will copy into a unit file.
     */
    function test_ARecordThatDisagreesWithTheChainAboutTheRelayerIsRefused() public {
        DeployHarness harness = new DeployHarness();
        vm.chainId(943);
        string memory record = vm.readFile(_recordPath(943));
        address recorded = vm.parseJsonAddress(record, ".contracts.ProveSettlement");
        address recordedRelayer = vm.parseJsonAddress(record, ".contracts.ProveRelayer");

        _settlementShapedAt(recorded, address(0xA11CE));
        vm.expectRevert(
            abi.encodeWithSelector(
                GuardedScript.RecordedRelayerMismatch.selector, address(0xA11CE), recordedRelayer
            )
        );
        harness.requireRecorded(recorded, "PROVE_T_OFF_RECORD");

        // And it passes once the chain and the record agree.
        _settlementShapedAt(recorded, recordedRelayer);
        harness.requireRecorded(recorded, "PROVE_T_OFF_RECORD");
    }

    /**
     * @notice A fork dry run says so by naming the same address twice, and then it is allowed.
     *
     * An address rather than a boolean, on purpose. Typing the settlement into a second variable
     * is a deliberate act; a flag left in a shell would wave through tomorrow's different one.
     */
    function test_AnOffRecordSettlementNeedsItsOwnAddressTyped() public {
        DeployHarness harness = new DeployHarness();
        vm.chainId(CHAIN_NO_RECORD);

        vm.setEnv("PROVE_T_OFF_RECORD_ACK", vm.toString(address(0xF0)));
        vm.expectRevert(
            abi.encodeWithSelector(GuardedScript.NoDeploymentRecord.selector, CHAIN_NO_RECORD)
        );
        harness.requireRecorded(address(0xF1), "PROVE_T_OFF_RECORD_ACK");

        harness.requireRecorded(address(0xF0), "PROVE_T_OFF_RECORD_ACK");
        vm.setEnv("PROVE_T_OFF_RECORD_ACK", "0x0000000000000000000000000000000000000000");
    }

    /**
     * @notice A record that is there but names no settlement is refused like a record that is not.
     *
     * The half-written file is the dangerous one. A missing file is obvious and somebody goes
     * looking; a record with a `contracts` object and no `ProveSettlement` in it reads as a real
     * record to anything that only checks the file is there. `3a556e6` added this check when the
     * guards stopped catching a parse revert and started asking, and asking is what makes the
     * state reachable: `vm.parseJsonAddress` used to blow up on its own.
     *
     * Both keys, separately. The relayer line is the one that goes missing in practice, because
     * it is written second.
     */
    function test_ARecordMissingEitherKeyIsRefused() public {
        DeployHarness harness = new DeployHarness();
        vm.chainId(CHAIN_HALF_RECORD);

        vm.writeFile(_recordPath(CHAIN_HALF_RECORD), '{"contracts":{}}');
        vm.expectRevert(
            abi.encodeWithSelector(GuardedScript.NoDeploymentRecord.selector, CHAIN_HALF_RECORD)
        );
        harness.requireRecorded(address(0xBEEF), "PROVE_T_OFF_RECORD");

        // The settlement alone is not a record either. Nothing can check a relayer that is absent.
        vm.writeFile(
            _recordPath(CHAIN_HALF_RECORD),
            string.concat('{"contracts":{"ProveSettlement":"', vm.toString(address(0xBEEF)), '"}}')
        );
        vm.expectRevert(
            abi.encodeWithSelector(GuardedScript.NoDeploymentRecord.selector, CHAIN_HALF_RECORD)
        );
        harness.requireRecorded(address(0xBEEF), "PROVE_T_OFF_RECORD");

        vm.removeFile(_recordPath(CHAIN_HALF_RECORD));
    }

    // ── The two helpers that only answer questions ───────────────────────────

    /**
     * @notice Both `ask` helpers still read what a chain expects, and neither deploys anything.
     *
     * `3a556e6` took these off the guard path. The guards used to reach them through
     * `try this.readConfiguredDeployers(…)`, forge refuses `address(this)` in a script contract,
     * and every deploy died before it read a value. `_expectedDeployers` and
     * `_requireRecordedSettlement` ask `vm.exists` and `vm.keyExistsJson` for themselves now.
     *
     * That left both functions with no caller and no test, so the coverage gate went red on
     * `script/` while `src/` stayed at 100%. They are kept on purpose — they are the only way to
     * interrogate a chain's expectation without a deploy, and an operator runs one as
     * `forge script … --sig 'readDeploymentRecord(uint256)' 943`. A kept function owes the same
     * proof as any other, so this calls both against the two records that are in the repository.
     */
    function test_TheAskHelpersReadTheSameFilesTheGuardsRead() public {
        DeployHarness harness = new DeployHarness();

        address[] memory asked = harness.readConfiguredDeployers(943);
        address[] memory inFile =
            vm.parseJsonAddressArray(vm.readFile(_configPath(943)), ".deployers");
        assertEq(asked.length, inFile.length, "the list is the file's list");
        for (uint256 k = 0; k < inFile.length; k++) {
            assertEq(asked[k], inFile[k], "and in the file's order");
        }

        (address settlement, address relayer) = harness.readDeploymentRecord(943);
        string memory record = vm.readFile(_recordPath(943));
        assertEq(
            settlement,
            vm.parseJsonAddress(record, ".contracts.ProveSettlement"),
            "the settlement the record names"
        );
        assertEq(
            relayer,
            vm.parseJsonAddress(record, ".contracts.ProveRelayer"),
            "and the relayer beside it"
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _configPath(uint256 chainId) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/config/", vm.toString(chainId), ".json");
    }

    function _feeConfigsFile() internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/config/fee-configs.json");
    }

    function _scratchFeesPath(uint256 chainId) internal view returns (string memory) {
        return
            string.concat(vm.projectRoot(), "/config/fee-configs.", vm.toString(chainId), ".json");
    }

    function _strayOf(string memory fees, string memory chain)
        internal
        pure
        returns (FeeConfig.Config memory c)
    {
        c.destinations =
            vm.parseJsonAddressArray(fees, string.concat(chain, ".strayConfig.destinations"));
        c.weights = vm.parseJsonUintArray(fees, string.concat(chain, ".strayConfig.weights"));
    }

    function _historyLength(string memory fees, string memory chain)
        internal
        view
        returns (uint256 n)
    {
        while (vm.keyExistsJson(fees, string.concat(chain, ".history[", vm.toString(n), "]"))) {
            n++;
        }
    }

    /// @dev A one-destination config as JSON.
    function _configJson(address dest) internal pure returns (string memory) {
        return string.concat(
            '{"destinations":["', vm.toString(dest), '"],"weights":["1000000000000000000"]}'
        );
    }

    /// @dev One history entry: 0.5% at P2 and a 1% warning everywhere, the owner's defaults.
    function _historyJson(address dest) internal pure returns (string memory) {
        return string.concat(
            '{"id":"t","destinations":["',
            vm.toString(dest),
            '"],"weights":["1000000000000000000"],',
            '"rates":{"handover":"0","output":"5000000000000000","proceeds":"0"},',
            '"warn":{"handover":"10000000000000000","output":"10000000000000000",',
            '"proceeds":"10000000000000000"}}'
        );
    }

    function _validFeeConfigs(uint256 chainId) internal pure returns (string memory) {
        return string.concat(
            '{"',
            vm.toString(chainId),
            '":{"feeDefaults":null,"strayConfig":',
            _configJson(DEST),
            ',"history":[',
            _historyJson(DEST),
            "]}}"
        );
    }

    /// @dev A script that reads `fees` for the scratch chain, written to a scratch file.
    function _scratchScript(uint256 chainId, string memory fees) internal returns (DeployFor) {
        vm.writeFile(_scratchFeesPath(chainId), fees);
        return new DeployFor(vm.toString(chainId), _scratchFeesPath(chainId));
    }

    /**
     * @dev Write a whole chain configuration for `chainId` and point the chain at it.
     *
     * The `deployers` list names this test contract, because these tests call `run()` directly
     * and `msg.sender` inside it is then this contract. A scratch file without that list stops
     * the script, which is its own test — `test_AConfigThatNamesNoSignerStops`.
     */
    function _scratch(uint256 chainId, address owner) internal {
        vm.chainId(chainId);
        vm.writeFile(
            _configPath(chainId),
            string.concat(
                '{"deployers":["',
                vm.toString(address(this)),
                '"],"owner":"',
                vm.toString(owner),
                '","permit2":"',
                vm.toString(PERMIT2),
                '"}'
            )
        );
    }

    /**
     * @dev Put this test contract's own address in a scratch file's `deployers`, as a fragment.
     *
     * The tests that write partial configurations on purpose cannot use `_scratch`.
     */
    function _signedByThisTest() internal view returns (string memory) {
        return string.concat('{"deployers":["', vm.toString(address(this)), '"],');
    }

    /**
     * @dev Call a script from the address a config file names, the way forge does.
     *
     * `vm.prank` cannot do this. Forge refuses `startBroadcast` while a prank is active — it
     * says so outright — and every one of these scripts broadcasts. Etching a forwarder at the
     * configured address and calling through it makes `msg.sender` inside `run()` that address,
     * which is what a real run has and what the signer check reads.
     */
    function _asSigner(address who) internal returns (AsSigner) {
        vm.etch(who, address(new AsSigner()).code);
        return AsSigner(who);
    }

    /**
     * @dev Put a settlement-shaped account at `where`, answering `relayer()` with `answers`.
     *
     * Enough for both periphery constructors, which ask for code and a non-zero `relayer()` and
     * nothing else. It lets a test stand a deployment record's own addresses up on a chain that
     * has never seen them, without deploying anything to a real one.
     */
    function _settlementShapedAt(address where, address answers) internal {
        vm.etch(where, address(new RelayerStub()).code);
        vm.store(where, bytes32(0), bytes32(uint256(uint160(answers))));
    }

    function _recordPath(uint256 chainId) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/deployments/", vm.toString(chainId), ".json");
    }

    /// @dev Remove the scratch files. A test that leaves them behind leaves a config in the repository.
    function _clean(uint256 chainId) internal {
        vm.removeFile(_configPath(chainId));
        if (vm.exists(_scratchFeesPath(chainId))) vm.removeFile(_scratchFeesPath(chainId));
    }
}

/**
 * @notice `Deploy`, reading its fee configuration from an explicit file under an explicit key.
 *         Lets a committed chain's entry deploy onto a scratch chain id, and a scratch file stand
 *         in for the committed one, without editing `config/fee-configs.json`.
 */
contract DeployFor is Deploy {
    string private _key;
    string private _file;

    constructor(string memory key, string memory file) {
        _key = key;
        _file = file;
    }

    function _feeConfigsPath() internal view override returns (string memory) {
        return _file;
    }

    function _feeConfigsKey() internal view override returns (string memory) {
        return _key;
    }
}

/**
 * @notice Reaches `Deploy`'s address reader, so the environment-beats-file rule can be tested on
 *         a key nothing else in the suite touches.
 */
contract DeployHarness is Deploy {
    function addressFrom(string memory json, string memory key, string memory envKey)
        external
        view
        returns (address)
    {
        return _address(json, key, envKey);
    }

    /// @dev The signer check, on whichever environment key the caller names.
    function requireDeployer(string memory envKey) external view {
        _requireExpectedDeployer(envKey);
    }

    /// @dev The record check, likewise.
    function requireRecorded(address settlement, string memory envKey) external view {
        _requireRecordedSettlement(settlement, envKey);
    }

    /// @dev What this chain expects, or an empty list when nothing says.
    function readConfiguredDeployersOrNone() external view returns (address[] memory) {
        return _expectedDeployers();
    }

    /// @dev The libraries linked into `code`, as the deploy finds them.
    function linkedLibraries(bytes memory code) external view returns (address[] memory) {
        return _linkedLibraries(code);
    }
}

/**
 * @notice Calls a script from the address a config file names, the way forge does.
 *
 * `vm.prank` cannot stand in for this: forge refuses `startBroadcast` while a prank is active,
 * and every script here broadcasts. A test etches this contract's code at the configured signer
 * and calls through it, so `msg.sender` inside `run()` is that address.
 */
contract AsSigner {
    function deploy(Deploy script) external returns (ProveSettlement, ProveExecutor) {
        return script.run();
    }

    function batch(DeployBatchExecutor script) external returns (ProveBatchExecutor) {
        return script.run();
    }

    function venue(DeployRfqVenue script) external returns (RfqVenue) {
        return script.run();
    }
}

/**
 * @notice A settlement-shaped account: code, and a `relayer()` read from storage slot zero.
 *
 * Both periphery constructors ask for exactly those two things. Etching this where a deployment
 * record says the settlement is lets a test hold the record against a chain, without deploying
 * anything to a real one.
 */
contract RelayerStub {
    address public relayer;
}
