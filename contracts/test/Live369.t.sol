// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {FeeDefaults} from "../src/FeeDefaults.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ProveRelayer} from "../src/ProveRelayer.sol";
import {ProveExecutor} from "../src/ProveExecutor.sol";
import {ProveReader} from "../src/ProveReader.sol";
import {ProveBatchExecutor} from "../src/ProveBatchExecutor.sol";
import {RfqVenue} from "../src/RfqVenue.sol";

/**
 * @notice The live 369 deployment, as recorded in `deployments/369.json`, held to this source.
 *
 *   PULSECHAIN_RPC=https://one.valve.city/rpc/evm/369 \
 *     FOUNDRY_PROFILE=fork forge test --match-path test/Live369.t.sol -vv
 *
 * Without PULSECHAIN_RPC every test skips (`vm.skip`, reported SKIPPED, never passed).
 *
 * Three questions, none of which sends a transaction:
 *   1. Code: is every recorded address running the bytecode this tree compiles to? Each contract is
 *      built fresh on the fork with the live constructor inputs and compared byte for byte, with
 *      only the compiler's own immutable slots, library link slots and the CBOR metadata tail
 *      masked (offsets read from `out/`, never guessed). `tools/verify-bytecode.mjs` is the
 *      off-chain twin of this check.
 *   2. Wiring: settlement -> FeeClaimLib link, settlement <-> relayer, executor / batch executor /
 *      venue / reader -> settlement, and the call-sink templates.
 *   3. Fee defaults: FeeDefaults is owned by the recorded owner with no handover pending, and its
 *      current defaults (config, P1 handover, P2 output, P3 proceeds, and the three warn rates)
 *      are the last entry of `config/fee-configs.json`.
 */
contract Live369Test is Test {
    string internal rpc;
    string internal dep;
    string internal fees;

    function setUp() public {
        rpc = vm.envOr("PULSECHAIN_RPC", string(""));
    }

    function _boot() internal returns (bool) {
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }
        // 64 blocks behind the head, for the reorg reason `Fork369Rehearsal.t.sol` records.
        vm.createSelectFork(rpc);
        vm.createSelectFork(rpc, block.number - 64);
        assertEq(block.chainid, 369, "not chain 369");
        dep = vm.readFile(string.concat(vm.projectRoot(), "/deployments/369.json"));
        fees = vm.readFile(string.concat(vm.projectRoot(), "/config/fee-configs.json"));
        return true;
    }

    function _a(string memory name) internal view returns (address) {
        return vm.parseJsonAddress(dep, string.concat(".contracts.", name));
    }

    function _stray() internal view returns (FeeConfig.Config memory c) {
        c.destinations = vm.parseJsonAddressArray(dep, ".strayConfig.destinations");
        c.weights = vm.parseJsonUintArray(dep, ".strayConfig.weights");
    }

    // ------------------------------------------------------------------ code

    function _artifact(string memory file, string memory name)
        internal
        view
        returns (string memory)
    {
        return vm.readFile(string.concat(vm.projectRoot(), "/out/", file, ".sol/", name, ".json"));
    }

    function _zero(bytes memory code, uint256 start, uint256 len) internal pure {
        for (uint256 k; k < len; k++) {
            code[start + k] = 0;
        }
    }

    /// @dev Zero every immutable slot, library link slot and the metadata tail.
    function _mask(bytes memory code, string memory art) internal view returns (bytes32) {
        string memory imm = ".deployedBytecode.immutableReferences";
        if (vm.keyExistsJson(art, imm)) {
            string[] memory ids = vm.parseJsonKeys(art, imm);
            for (uint256 i; i < ids.length; i++) {
                string memory base = string.concat(imm, ".", ids[i]);
                for (
                    uint256 j;
                    vm.keyExistsJson(art, string.concat(base, "[", vm.toString(j), "]"));
                    j++
                ) {
                    string memory at = string.concat(base, "[", vm.toString(j), "]");
                    _zero(
                        code,
                        vm.parseJsonUint(art, string.concat(at, ".start")),
                        vm.parseJsonUint(art, string.concat(at, ".length"))
                    );
                }
            }
        }
        string memory lnk = ".deployedBytecode.linkReferences['src/FeeClaimLib.sol'].FeeClaimLib";
        if (vm.keyExistsJson(art, lnk)) {
            for (
                uint256 j;
                vm.keyExistsJson(art, string.concat(lnk, "[", vm.toString(j), "]"));
                j++
            ) {
                _zero(
                    code,
                    vm.parseJsonUint(art, string.concat(lnk, "[", vm.toString(j), "].start")),
                    20
                );
            }
        }
        uint256 n = code.length;
        uint256 meta = (uint256(uint8(code[n - 2])) << 8) | uint8(code[n - 1]);
        _zero(code, n - meta - 2, meta + 2);
        return keccak256(code);
    }

    function _same(address live, address fresh, string memory file, string memory name)
        internal
        view
    {
        bytes memory a = live.code;
        bytes memory b = fresh.code;
        assertGt(a.length, 0, string.concat(name, ": no code at the recorded address"));
        assertEq(a.length, b.length, string.concat(name, ": code length differs"));
        string memory art = _artifact(file, name);
        assertEq(_mask(a, art), _mask(b, art), string.concat(name, ": code differs from this tree"));
    }

    function test_EveryRecordedContractRunsThisSource() public {
        if (!_boot()) return;
        address permit2 = vm.parseJsonAddress(dep, ".permit2");
        address settlement = _a("ProveSettlement");

        ProveSettlement s = new ProveSettlement(_stray(), permit2);
        _same(settlement, address(s), "ProveSettlement", "ProveSettlement");
        _same(_a("ProveRelayer"), s.relayer(), "ProveRelayer", "ProveRelayer");

        // The library: link slot 0 of the live settlement names the address it delegatecalls.
        _sameLibrary(_a("FeeClaimLib"), s);

        ProveExecutor e = new ProveExecutor(settlement);
        _same(_a("ProveExecutor"), address(e), "ProveExecutor", "ProveExecutor");
        _same(_a("ProveCallSink"), address(e.sinkTemplate()), "ProveCallSink", "ProveCallSink");

        FeeDefaults d = new FeeDefaults(address(this));
        _same(_a("FeeDefaults"), address(d), "FeeDefaults", "FeeDefaults");

        ProveReader r = new ProveReader(settlement, _a("FeeDefaults"), _stray());
        _same(_a("ProveReader"), address(r), "ProveReader", "ProveReader");

        ProveBatchExecutor b = new ProveBatchExecutor(settlement);
        _same(_a("ProveBatchExecutor"), address(b), "ProveBatchExecutor", "ProveBatchExecutor");
        _same(
            _a("ProveBatchExecutorCallSink"),
            address(b.sinkTemplate()),
            "ProveCallSink",
            "ProveCallSink"
        );

        RfqVenue v = new RfqVenue(settlement);
        _same(_a("RfqVenue"), address(v), "RfqVenue", "RfqVenue");
    }

    function _linked(address who) internal view returns (address lib) {
        string memory art = _artifact("ProveSettlement", "ProveSettlement");
        uint256 at = vm.parseJsonUint(
            art, ".deployedBytecode.linkReferences['src/FeeClaimLib.sol'].FeeClaimLib[0].start"
        );
        bytes memory code = who.code;
        assembly {
            lib := shr(96, mload(add(add(code, 0x20), at)))
        }
    }

    function _sameLibrary(address live, ProveSettlement fresh) internal view {
        address freshLib = _linked(address(fresh));
        _same(live, freshLib, "FeeClaimLib", "FeeClaimLib");
    }

    // ---------------------------------------------------------------- wiring

    function test_TheWiringIsTheRecord() public {
        if (!_boot()) return;
        address settlement = _a("ProveSettlement");
        address relayer = _a("ProveRelayer");

        assertEq(_linked(settlement), _a("FeeClaimLib"), "settlement links another FeeClaimLib");
        assertEq(ProveSettlement(settlement).relayer(), relayer, "settlement.relayer");
        assertEq(ProveRelayer(relayer).settlement(), settlement, "relayer.settlement");
        assertEq(ProveRelayer(relayer).permit2(), vm.parseJsonAddress(dep, ".permit2"), "permit2");
        assertEq(
            ProveSettlement(settlement).STRAY_CONFIG(), FeeConfig.hash(_stray()), "stray config"
        );

        ProveExecutor e = ProveExecutor(_a("ProveExecutor"));
        assertEq(address(e.settlement()), settlement, "executor.settlement");
        assertEq(e.relayer(), relayer, "executor.relayer");
        assertEq(address(e.sinkTemplate()), _a("ProveCallSink"), "executor.sinkTemplate");

        ProveBatchExecutor b = ProveBatchExecutor(_a("ProveBatchExecutor"));
        assertEq(address(b.settlement()), settlement, "batch.settlement");
        assertEq(b.relayer(), relayer, "batch.relayer");
        assertEq(address(b.sinkTemplate()), _a("ProveBatchExecutorCallSink"), "batch.sinkTemplate");

        RfqVenue v = RfqVenue(_a("RfqVenue"));
        assertEq(address(v.settlement()), settlement, "venue.settlement");
        assertEq(v.relayer(), relayer, "venue.relayer");

        ProveReader r = ProveReader(_a("ProveReader"));
        assertEq(address(r.settlement()), settlement, "reader.settlement");
        assertEq(address(r.feeDefaults()), _a("FeeDefaults"), "reader.feeDefaults");
    }

    // ------------------------------------------------------------- defaults

    function test_FeeDefaultsOwnerAndDefaultsAreTheRecord() public {
        if (!_boot()) return;
        FeeDefaults d = FeeDefaults(_a("FeeDefaults"));
        assertEq(
            vm.parseJsonAddress(fees, ".369.feeDefaults"), address(d), "fee-configs.json address"
        );

        // A single EOA for now (AUDIT-SCOPE, accepted risk), and no handover in flight.
        assertEq(d.owner(), 0x5182574eE268ABD0A48f97DcfcdE65234E8422E2, "owner");
        assertEq(d.owner(), vm.parseJsonAddress(dep, ".owner"), "owner vs record");
        assertEq(d.pendingOwner(), address(0), "pendingOwner");

        uint256 n;
        while (vm.keyExistsJson(fees, string.concat(".369.history[", vm.toString(n), "]"))) n++;
        assertEq(d.versions(), n, "versions vs history length");

        string memory at = string.concat(".369.history[", vm.toString(n - 1), "]");
        FeeConfig.Config memory c;
        c.destinations = vm.parseJsonAddressArray(fees, string.concat(at, ".destinations"));
        c.weights = vm.parseJsonUintArray(fees, string.concat(at, ".weights"));

        (, FeeDefaults.Record memory rec) = d.current();
        assertEq(rec.feeConfig, FeeConfig.hash(c), "feeConfig hash");
        assertEq(rec.config.destinations, c.destinations, "destinations");
        assertEq(rec.config.weights, c.weights, "weights");
        assertEq(
            rec.rates.handover, vm.parseJsonUint(fees, string.concat(at, ".rates.handover")), "P1"
        );
        assertEq(rec.rates.output, vm.parseJsonUint(fees, string.concat(at, ".rates.output")), "P2");
        assertEq(
            rec.rates.proceeds, vm.parseJsonUint(fees, string.concat(at, ".rates.proceeds")), "P3"
        );
        assertEq(
            rec.warn.handover,
            vm.parseJsonUint(fees, string.concat(at, ".warn.handover")),
            "P1 warn"
        );
        assertEq(
            rec.warn.output, vm.parseJsonUint(fees, string.concat(at, ".warn.output")), "P2 warn"
        );
        assertEq(
            rec.warn.proceeds,
            vm.parseJsonUint(fees, string.concat(at, ".warn.proceeds")),
            "P3 warn"
        );
    }
}
