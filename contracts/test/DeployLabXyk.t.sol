// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployLabXyk} from "../script/DeployLabXyk.s.sol";
import {MockV2Factory, MockV2Pair, MockV2Router} from "./Mocks.sol";
import {FaucetToken} from "./tokens/FaucetToken.sol";

/**
 * @notice `DeployLabXyk`, run for real.
 *
 *   forge test --match-path test/DeployLabXyk.t.sol -vv
 *
 * The script gives the lab chain a constant-product market: a factory, a router, and a triangle
 * of tPLSX/tUSDC, tUSDC/tWETH and tWETH/tPLSX. The solver reads a pool by asking a factory for a
 * pair and reading reserves off it, so all three parts have to be there and have to agree — a
 * router whose `factory()` names some other factory reports "no pool" for every pair that exists.
 *
 * Three things here fail in ways nothing downstream would name:
 *
 *   the decimals   Reserves are whole tokens in the script and raw units in the pair. tUSDC has
 *                  six and tWETH has eighteen, so one scale for both funds one leg a trillion
 *                  times over and the other not at all.
 *   the sync       A V2 pair takes its reserves from its own balances, and only when told to.
 *                  Tokens sent and never synced read as an empty pool, which the solver cannot
 *                  tell from a pair that was never created.
 *   the price      The triangle is arbitrage-free by construction. Reserves that disagree round
 *                  the loop pay for going round it, and then every ring the lab finds is the
 *                  lab's own mistake rather than a maker's concession.
 *
 * Every test writes its own configuration under a chain id nothing else claims, and removes the
 * file afterwards. **`config/deployed.943.json` is committed and holds live testnet addresses**,
 * so no test here may run on chain 943.
 */
contract DeployLabXykTest is Test {
    // One chain id per test. Two tests sharing an id share a path on a real filesystem that no
    // EVM snapshot rolls back, so one removes the configuration the other is still reading.
    // `DeployLabVenue.t.sol` numbers its tests for the same reason.
    uint256 constant CHAIN_TRIANGLE = 424_501;
    uint256 constant CHAIN_PRICE = 424_502;
    uint256 constant CHAIN_ROUTER = 424_503;
    uint256 constant CHAIN_FEE_TO = 424_504;
    uint256 constant CHAIN_NOT_OWNER = 424_505;

    DeployLabXyk script;

    function setUp() public {
        script = new DeployLabXyk();
        // Zeroed so a value in the developer's own shell cannot narrow the signer check and fail
        // every test here with somebody else's configuration.
        vm.setEnv("PROVE_DEPLOYER", "0x0000000000000000000000000000000000000000");
    }

    /**
     * @dev A token the script itself may mint.
     *
     * `vm.startBroadcast()` with no argument runs the calls after it as `DEFAULT_SENDER`, not as
     * this test contract, so a token owned by `address(this)` refuses the script's mint.
     */
    function _ownedToken(string memory symbol, uint8 decimals) internal returns (FaucetToken) {
        return new FaucetToken(symbol, symbol, decimals, 1, 0, DEFAULT_SENDER);
    }

    /// @dev The portfolio the script expects, written where it will look for this chain id.
    function _write(uint256 chainId)
        internal
        returns (FaucetToken plsx, FaucetToken usdc, FaucetToken weth)
    {
        plsx = _ownedToken("tPLSX", 18);
        usdc = _ownedToken("tUSDC", 6);
        weth = _ownedToken("tWETH", 18);
        vm.writeFile(
            string.concat(vm.projectRoot(), "/config/deployed.", vm.toString(chainId), ".json"),
            string.concat(
                '{"tPLSX":"',
                vm.toString(address(plsx)),
                '","tUSDC":"',
                vm.toString(address(usdc)),
                '","tWETH":"',
                vm.toString(address(weth)),
                '"}'
            )
        );
        vm.chainId(chainId);
        _allowSigners(chainId);
    }

    function _remove(uint256 chainId) internal {
        vm.removeFile(
            string.concat(vm.projectRoot(), "/config/deployed.", vm.toString(chainId), ".json")
        );
        _forgetSigners(chainId);
    }

    /**
     * @dev Name who may sign on a scratch chain, and forget it again.
     *
     * Every broadcasting script here refuses a chain whose `config/<chainid>.json` names no
     * signer, and it fails closed — an expectation nobody wrote down is not a pass. These tests
     * invent a chain id per test, so each one has to say who may sign on it. Two addresses,
     * because the tests reach the script two ways: straight through `run()`, which arrives as
     * this contract, and through forge's default sender, which is what a real broadcast uses.
     */
    function _allowSigners(uint256 chainId) internal {
        vm.writeFile(
            _chainConfig(chainId),
            string.concat(
                '{"deployers":["',
                vm.toString(address(this)),
                '","',
                vm.toString(DEFAULT_SENDER),
                '"]}'
            )
        );
    }

    function _forgetSigners(uint256 chainId) internal {
        vm.removeFile(_chainConfig(chainId));
    }

    function _chainConfig(uint256 chainId) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/config/", vm.toString(chainId), ".json");
    }

    /// @dev The reserves of `pair`, oriented so the first is `token`'s.
    function _reserves(MockV2Pair pair, address token) internal view returns (uint256, uint256) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return token == pair.token0() ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }

    /**
     * @notice All three pairs exist, are synced, and hold their reserves in their own decimals.
     *
     * The solver finds a pool by asking the factory for it and reading `getReserves`, so a pair
     * that was created and never synced is indistinguishable from a pair that was never created.
     */
    function test_TheTriangleIsThreeSyncedPairs() public {
        (FaucetToken plsx, FaucetToken usdc, FaucetToken weth) = _write(CHAIN_TRIANGLE);

        (MockV2Factory factory,) = script.run();
        _remove(CHAIN_TRIANGLE);

        MockV2Pair one = MockV2Pair(factory.getPair(address(plsx), address(usdc)));
        MockV2Pair two = MockV2Pair(factory.getPair(address(usdc), address(weth)));
        MockV2Pair three = MockV2Pair(factory.getPair(address(weth), address(plsx)));
        assertTrue(address(one) != address(0), "tPLSX/tUSDC");
        assertTrue(address(two) != address(0), "tUSDC/tWETH");
        assertTrue(address(three) != address(0), "tWETH/tPLSX");

        (uint256 a, uint256 b) = _reserves(one, address(plsx));
        assertEq(a, 10_000_000 * 10 ** 18, "tPLSX at eighteen decimals");
        assertEq(b, 1_000_000 * 10 ** 6, "and tUSDC at six, not at eighteen");

        (a, b) = _reserves(two, address(usdc));
        assertEq(a, 4_000_000 * 10 ** 6, "tUSDC");
        assertEq(b, 1_000 * 10 ** 18, "tWETH");

        (a, b) = _reserves(three, address(weth));
        assertEq(a, 1_000 * 10 ** 18, "tWETH");
        assertEq(b, 40_000_000 * 10 ** 18, "tPLSX");
    }

    /**
     * @notice Going round the triangle pays nothing, exactly.
     *
     * The marginal rate of each leg is `reserveOut / reserveIn`, and the three multiply to one.
     * A lab whose own pools paid for a lap would make every ring the solver found look
     * profitable, and the ring would be the lab's mistake rather than a maker's concession.
     */
    function test_TheTriangleOffersNoArbitrageOfItsOwn() public {
        (FaucetToken plsx, FaucetToken usdc, FaucetToken weth) = _write(CHAIN_PRICE);

        (MockV2Factory factory,) = script.run();
        _remove(CHAIN_PRICE);

        (uint256 inA, uint256 outA) =
            _reserves(MockV2Pair(factory.getPair(address(plsx), address(usdc))), address(plsx));
        (uint256 inB, uint256 outB) =
            _reserves(MockV2Pair(factory.getPair(address(usdc), address(weth))), address(usdc));
        (uint256 inC, uint256 outC) =
            _reserves(MockV2Pair(factory.getPair(address(weth), address(plsx))), address(weth));

        // Cross-multiplied, so the comparison is exact integers rather than three divisions that
        // each throw a remainder away.
        assertEq(outA * outB * outC, inA * inB * inC, "one price all the way round");
    }

    /**
     * @notice The router quotes these reserves, through this factory.
     *
     * Both halves matter. `confirmVenues` asks the router which factory it deploys from and drops
     * the venue when the answer is not the one the registry recorded, so a router wired to some
     * other factory reads as no market at all. And the quote has to be the plain constant-product
     * one, with nothing taken off the top, because that is what the SDK reproduces locally from
     * `FEE_NUM / FEE_DEN`.
     */
    function test_TheRouterQuotesThroughItsOwnFactoryAndTakesNoFee() public {
        (FaucetToken plsx, FaucetToken usdc,) = _write(CHAIN_ROUTER);

        (MockV2Factory factory, MockV2Router router) = script.run();
        _remove(CHAIN_ROUTER);

        assertEq(router.factory(), address(factory), "the router names the factory it was given");

        address[] memory path = new address[](2);
        (path[0], path[1]) = (address(plsx), address(usdc));
        uint256 amountIn = 1_000 * 10 ** 18;
        uint256[] memory amounts = router.getAmountsOut(amountIn, path);

        uint256 reserveIn = 10_000_000 * 10 ** 18;
        uint256 reserveOut = 1_000_000 * 10 ** 6;
        uint256 withFee = amountIn * script.FEE_NUM();
        assertEq(
            amounts[1],
            (withFee * reserveOut) / (reserveIn * script.FEE_DEN() + withFee),
            "the SDK's own curve, at the fee the venue is registered with"
        );
    }

    /// @notice The factory names where the venue's cut goes, as the live factories do.
    function test_TheFactoryNamesWhereTheVenuesCutGoes() public {
        _write(CHAIN_FEE_TO);

        (MockV2Factory factory,) = script.run();
        _remove(CHAIN_FEE_TO);

        assertEq(factory.feeTo(), script.FEE_TO(), "feeTo");
    }

    /**
     * @notice On a chain the script does not own the tokens of, seeding a pair reverts.
     *
     * Which is right, and is the whole reason `up.sh` hands the lab's tokens to its own deployer
     * before running this. A script that could mint somebody else's testnet portfolio into a pool
     * would be a worse thing to have than one that fails loudly here.
     */
    function test_APairCannotBeSeededFromTokensTheScriptDoesNotOwn() public {
        FaucetToken plsx = new FaucetToken("tPLSX", "tPLSX", 18, 1, 0, address(0xB0B));
        FaucetToken usdc = _ownedToken("tUSDC", 6);
        FaucetToken weth = _ownedToken("tWETH", 18);
        vm.writeFile(
            string.concat(
                vm.projectRoot(), "/config/deployed.", vm.toString(CHAIN_NOT_OWNER), ".json"
            ),
            string.concat(
                '{"tPLSX":"',
                vm.toString(address(plsx)),
                '","tUSDC":"',
                vm.toString(address(usdc)),
                '","tWETH":"',
                vm.toString(address(weth)),
                '"}'
            )
        );
        vm.chainId(CHAIN_NOT_OWNER);
        _allowSigners(CHAIN_NOT_OWNER);

        vm.expectRevert(FaucetToken.NotOwner.selector);
        script.run();
        _remove(CHAIN_NOT_OWNER);
    }
}
