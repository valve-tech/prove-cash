// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {GuardedScript} from "./Guards.sol";
import {ProveBatchExecutor} from "../src/ProveBatchExecutor.sol";

/**
 * @notice Deploys `ProveBatchExecutor` against a settlement that is already on chain.
 *
 * `Deploy.s.sol` is the wrong tool for this. It deploys the whole set, so running it again on a
 * live chain would put a second settlement contract next to the one every maker has approved.
 * This script adds one address and touches nothing that exists.
 *
 * The settlement is named rather than looked up, and then held against the record. Typing the
 * address you mean and seeing it echoed back is the point of naming it, and
 * `deployments/<chainid>.json` is the second opinion. The constructor checks only that the
 * address has code and answers a non-zero `relayer()`, and YESTERDAY'S SETTLEMENT PASSES BOTH —
 * so without the record this deploys cleanly against a dead settlement and the failure waits
 * until a fill.
 *
 * `PROVE_SETTLEMENT_OFF_RECORD`, set to the same address, is how a fork dry run says it means a
 * settlement no record can know about. See `Guards.sol`.
 *
 *   PROVE_SETTLEMENT=0x… forge script script/DeployBatchExecutor.s.sol \
 *     --rpc-url $PULSECHAIN_RPC --broadcast --private-key $DEPLOYER_KEY
 *
 * The contract is unowned, holds nothing between transactions, and is one per settlement. It
 * deploys its own `ProveCallSink`, so one `new` produces two addresses.
 */
contract DeployBatchExecutor is GuardedScript {
    function run() external returns (ProveBatchExecutor executor) {
        address settlement = vm.envAddress("PROVE_SETTLEMENT");
        console.log("chain          ", block.chainid);
        console.log("settlement     ", settlement);
        _requireExpectedDeployer(DEPLOYER_ENV);
        // The constructor refuses an address with no code and one whose `relayer()` answers zero.
        // Both pass for a settlement that moved yesterday, and this executor reads `relayer()`
        // once in its constructor and holds it for ever. The record is what tells the two apart.
        _requireRecordedSettlement(settlement);

        vm.startBroadcast();
        executor = new ProveBatchExecutor(settlement);
        vm.stopBroadcast();

        console.log("");
        // The names the record uses, so nobody types one by hand. The call sink's record name is
        // `ProveBatchExecutorCallSink` on every chain, to keep it apart from `ProveExecutor`'s.
        console.log("ProveBatchExecutor        ", address(executor));
        console.log("ProveBatchExecutorCallSink", address(executor.sinkTemplate()));
        console.log("ProveRelayer              ", executor.relayer());
        console.log("");
        console.log("Add the first two to deployments/%s.json under those names.", block.chainid);
        console.log("");
        console.log("This address does NOT belong in sdk/src/config.ts. The registry carries the");
        console.log("settlement because everything else in a deployment is reachable from it, and");
        console.log("a batch executor is reachable from nothing. A solver names it with --credit.");
        console.log("");
        console.log("Nobody should ever approve this address. It needs no allowance from anyone:");
        console.log("the settlement releases every leg's token A into it during the transaction,");
        console.log("and it approves the relayer itself. An approval left here is a standing risk");
        console.log("with no upside, and the call sink is what keeps it out of a stranger's reach.");
    }
}
