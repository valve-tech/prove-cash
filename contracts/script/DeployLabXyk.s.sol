// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {console} from "forge-std/console.sol";
import {GuardedScript} from "./Guards.sol";
import {MockV2Factory, MockV2Pair, MockV2Router} from "../test/Mocks.sol";
import {FaucetToken} from "../test/tokens/FaucetToken.sol";

/**
 * @notice A constant-product market on the lab chain, so the solver can find and price a pool.
 *
 * `DeployLabVenue` is the other one, and the two are not rivals. That one deploys `MockRouter`,
 * which pays a fixed rate out of its own float: it lets a batch PAY, which is what the fault
 * tolerance and disposal work needs, and it has no reserves and no curve. The solver cannot see
 * it at all — `loadPools` asks a factory for a pair and reads reserves off it, and a fixed-rate
 * router has neither. So every plan that needed a priced pool leg was refused, and no ring with a
 * pool in it could exist on the lab.
 *
 * This deploys the other half: `MockV2Factory`, `MockV2Router` and three `MockV2Pair`s. Those are
 * the mocks the fee-sink tests already run against, reused rather than copied — a second pair
 * contract would be one more thing to drift from the first.
 *
 *   forge script script/DeployLabXyk.s.sol --rpc-url $LAB --broadcast --private-key $ANVIL_KEY
 *
 * **These pairs take no swap fee.** The real thing keeps 29 basis points, and the SDK reads that
 * number off the venue registry rather than off the chain — so the lab venue has to be REGISTERED
 * at the fee it actually charges, which is none. `app/scripts/lab/up.sh` exports
 * `PROVE_XYK_FEE_NUM` and `PROVE_XYK_FEE_DEN` from the two constants below for exactly that
 * reason. Register it at PulseX's fee instead and every quote the SDK computes disagrees with the
 * quote this router gives, in a direction nothing on chain would report.
 *
 * It mints the reserves from the tokens' own mint, which is owner-only, so it runs as their
 * owner. That is true on a chain you brought up yourself and nowhere else — `up.sh` sets
 * `PROVE_TOKEN_OWNER` to its own deployer before it runs the token script at all.
 *
 * The signer is checked against `deployers` in `config/<chainid>.json` first, so "a chain you
 * brought up yourself" stops being a claim in this comment and becomes a refusal. See
 * `Guards.sol`.
 */
contract DeployLabXyk is GuardedScript {
    /**
     * @dev What the SDK must register this venue at.
     *
     * `MockV2Router` quotes `out = in * reserveOut / (reserveIn + in)` — the constant-product
     * curve with nothing taken off the top. The SDK reproduces that curve locally from a reserve
     * snapshot, using `feeNum / feeDen` from the registry, so these two are the only pair of
     * numbers that make the two agree.
     */
    uint256 public constant FEE_NUM = 10_000;
    uint256 public constant FEE_DEN = 10_000;

    /**
     * @dev Where the factory says its cut goes.
     *
     * The registry's own `feeTo` for chain 943, so the lab answers what the live chain answers
     * and a probe that holds the two together does not report a mismatch it invented. Nothing is
     * ever sent there: these pairs take no fee, so there is no cut.
     */
    address public constant FEE_TO = 0x7cD43983A963c62Add34694E83E896c5AfC3333f;

    /// @dev One side of the triangle: two symbols, and the reserves in whole tokens.
    struct Leg {
        string a;
        string b;
        uint256 reserveA;
        uint256 reserveB;
    }

    function run() external returns (MockV2Factory factory, MockV2Router router) {
        _requireExpectedDeployer(DEPLOYER_ENV);

        string memory json = vm.readFile(
            string.concat(
                vm.projectRoot(), "/config/deployed.", vm.toString(block.chainid), ".json"
            )
        );
        Leg[3] memory legs = _triangle();

        vm.startBroadcast();
        factory = new MockV2Factory();
        factory.setFeeTo(FEE_TO);
        router = new MockV2Router(address(factory));

        for (uint256 k = 0; k < legs.length; k++) {
            FaucetToken a = FaucetToken(vm.parseJsonAddress(json, string.concat(".", legs[k].a)));
            FaucetToken b = FaucetToken(vm.parseJsonAddress(json, string.concat(".", legs[k].b)));
            address pair = factory.createPair(address(a), address(b));
            // Reserves are whole tokens in the table and raw units in the pair, and the three
            // tokens carry eighteen, six and eighteen decimals. Scaling per token is the only
            // reason a six-decimal leg is not funded a trillionth of what it should be.
            a.mint(pair, legs[k].reserveA * (10 ** a.decimals()));
            b.mint(pair, legs[k].reserveB * (10 ** b.decimals()));
            // V2 adds liquidity by sending tokens in and letting the pair take the balance as its
            // reserves. Nothing reads a reserve until this runs.
            MockV2Pair(pair).sync();
            console.log(legs[k].a, legs[k].b, pair);
        }
        vm.stopBroadcast();

        console.log("factory    ", address(factory));
        console.log("router     ", address(router));
        console.log("feeNum     ", FEE_NUM);
        console.log("feeDen     ", FEE_DEN);
    }

    /**
     * @dev The three pairs, and the reserves that price them.
     *
     * One price all the way round, on purpose. 1 tWETH buys 4,000 tUSDC, 1 tUSDC buys 10 tPLSX,
     * and 1 tWETH buys 40,000 tPLSX — so the product of the three rates is exactly one and there
     * is no arbitrage sitting in the lab's own setup. A triangle that paid for going round it
     * would make every ring the solver found look profitable and stop the lab telling anybody
     * anything, which is the same complaint `DeployLabVenue` makes about a venue that doubles
     * every trade.
     *
     * The depth is set so an ordinary lab trade — tens of tokens, not millions — moves the price
     * by a rounding error. A pool that a single test trade empties fails the trade for a reason
     * that has nothing to do with what was being tested.
     */
    function _triangle() private pure returns (Leg[3] memory legs) {
        legs[0] = Leg({a: "tPLSX", b: "tUSDC", reserveA: 10_000_000, reserveB: 1_000_000});
        legs[1] = Leg({a: "tUSDC", b: "tWETH", reserveA: 4_000_000, reserveB: 1_000});
        legs[2] = Leg({a: "tWETH", b: "tPLSX", reserveA: 1_000, reserveB: 40_000_000});
    }
}
