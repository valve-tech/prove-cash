// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {GuardedScript} from "./Guards.sol";
import {RfqVenue} from "../src/RfqVenue.sol";

/**
 * @notice Deploys `RfqVenue` against a settlement that is already on chain.
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
 *   PROVE_SETTLEMENT=0x… forge script script/DeployRfqVenue.s.sol \
 *     --rpc-url $PULSECHAIN_RPC --broadcast --private-key $DEPLOYER_KEY
 *
 * The contract is unowned, holds nothing between transactions, and is one per settlement. It
 * deploys no helper of its own, because it makes no call a caller chose — read the header of
 * `RfqVenue.sol` for why that is the whole difference between this address and
 * `ProveBatchExecutor`.
 */
contract DeployRfqVenue is GuardedScript {
    function run() external returns (RfqVenue venue) {
        address settlement = vm.envAddress("PROVE_SETTLEMENT");
        console.log("chain          ", block.chainid);
        console.log("settlement     ", settlement);
        _requireExpectedDeployer(DEPLOYER_ENV);
        // The constructor refuses an address with no code and one whose `relayer()` answers zero.
        // Both pass for a settlement that moved yesterday, and a venue caches its EIP-712 domain
        // over its own address, so every `Exclusive` signature against the old pair is already
        // dead. The record is what tells the two apart.
        _requireRecordedSettlement(settlement);

        vm.startBroadcast();
        venue = new RfqVenue(settlement);
        vm.stopBroadcast();

        console.log("");
        console.log("RfqVenue       ", address(venue));
        console.log("ProveRelayer   ", venue.relayer());
        console.log("");
        console.log("Add it to deployments/%s.json.", block.chainid);
        console.log("");
        console.log("**A maker's quote must name this exact address as `Intent.executor`, and so");
        console.log("must the counterparty's mirror.** That field is the whole of the exclusivity:");
        console.log("the settlement refuses every other filler, and this contract refuses every");
        console.log("counterparty but the one the maker signed for. A quote pointed at an old");
        console.log("venue address settles nowhere, and a quote pointed at nothing is public.");
        console.log("");
        console.log("This address does NOT belong in sdk/src/config.ts. The registry carries the");
        console.log("settlement because everything else in a deployment is reachable from it, and");
        console.log("a venue is reachable from nothing. A quote names it, and the SDK's rfq module");
        console.log("takes it as an argument.");
        console.log("");
        console.log("Nobody should ever approve this address. It needs no allowance from anyone:");
        console.log("the settlement releases both legs into it during the transaction, and it");
        console.log("approves the relayer itself. An approval left here is a standing risk with no");
        console.log("upside.");
    }
}
