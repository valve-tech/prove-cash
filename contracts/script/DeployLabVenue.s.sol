// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {GuardedScript} from "./Guards.sol";
import {MockRouter} from "../test/Mocks.sol";
import {FaucetToken} from "../test/tokens/FaucetToken.sol";

/**
 * @notice A venue for the lab chain, so a plan there can close through something.
 *
 * The lab could stand up every contract in the protocol and still not settle an ordinary trade,
 * because `ProveBatchExecutor` holds nothing between transactions. A leg hands it token A and
 * leaves it owing token B, so unless another leg happens to supply that token B — which is a
 * cycle — the only way anybody gets paid is a venue call. Without one, the only thing the lab can
 * exercise is the coincidence of wants, which is the rarest case rather than the common one.
 *
 * `app/scripts/lab/packed-batch.ts` found this the hard way: four perfectly good independent
 * offers reverted for 81,900 gas having filled nothing, correctly, because nothing in the batch
 * could pay a maker.
 *
 * **It is `MockRouter`, deliberately, and not a second mock written for scripts.** It already
 * answers the exact `swapExactTokensForTokens` the SDK builds, so a lab run exercises the real
 * calldata path rather than a shape invented here. A copy would be one more thing to drift.
 *
 * What it is not: a price. `MockRouter` pays a fixed rate out of its own balance rather than
 * walking a curve, so nothing that depends on reserves — depth, slippage, the pool leg of a ring
 * the solver found on its own — is honest against it. It is here so that a batch can PAY, which
 * is what the fault tolerance and disposal work needs. `MockV2Pair` is the constant-product one,
 * for whenever the lab needs a curve as well.
 *
 *   forge script script/DeployLabVenue.s.sol --rpc-url $LAB --broadcast --private-key $ANVIL_KEY
 *
 * It funds itself from the faucet tokens' own mint, so it can pay for what it buys. That mint is
 * owner-only and this runs as the owner, which is true on the lab chain and nowhere else — the
 * script is for a chain you control and would fail on any chain you do not.
 *
 * The signer is checked against `deployers` in `config/<chainid>.json` first, so "a chain you
 * control" stops being a claim in this comment and becomes a refusal. See `Guards.sol`.
 */
contract DeployLabVenue is GuardedScript {
    error NoTokens();

    /// @dev The rate the venue pays, as a fraction. One for one: a lab that doubles every trade
    ///      makes every plan look profitable and stops telling you anything.
    uint256 private constant RATE_NUM = 1;
    uint256 private constant RATE_DEN = 1;

    /// @dev How much of each token the venue holds, in whole units. Enough that a run of batches
    ///      never empties it, because a venue that runs dry fails the trade for the wrong reason
    ///      and the failure looks exactly like the one under test.
    uint256 private constant FLOAT = 1_000_000;

    function run() external returns (MockRouter venue) {
        _requireExpectedDeployer(DEPLOYER_ENV);

        string memory path = string.concat(
            vm.projectRoot(), "/config/deployed.", vm.toString(block.chainid), ".json"
        );
        string memory json = vm.readFile(path);
        // The file is a flat symbol-to-address map, so the symbols are the keys and there is no
        // list to read. Reading it by key means a token added to the portfolio is funded here
        // without anybody remembering to add it.
        string[] memory symbols = vm.parseJsonKeys(json, "$");
        if (symbols.length == 0) revert NoTokens();

        vm.startBroadcast();
        venue = new MockRouter();
        venue.setRate(RATE_NUM, RATE_DEN);

        for (uint256 k = 0; k < symbols.length; k++) {
            FaucetToken t = FaucetToken(vm.parseJsonAddress(json, string.concat(".", symbols[k])));
            t.mint(address(venue), FLOAT * (10 ** t.decimals()));
        }
        vm.stopBroadcast();

        console.log("venue      ", address(venue));
        console.log("tokens     ", symbols.length);
    }
}
