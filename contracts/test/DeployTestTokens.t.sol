// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployTestTokens} from "../script/DeployTestTokens.s.sol";
import {FaucetToken} from "./tokens/FaucetToken.sol";

/**
 * @notice `DeployTestTokens`, run for real.
 *
 *   forge test --match-path test/DeployTestTokens.t.sol -vv
 *
 * The script reads a portfolio out of `config/tokens.<chainid>.json`, deploys one faucet token per
 * row, seeds each one, hands every token to the configured owner, and writes the addresses back to
 * `config/deployed.<chainid>.json`. Two of those steps are easy to get wrong in a way no balance
 * would show: the scaling, which turns whole tokens in the file into units on chain, and the
 * handover, which is the only thing standing between a testnet portfolio and a mint function the
 * throwaway deploy key still controls.
 *
 * Every test writes its own configuration under a chain id nothing else claims, and removes both
 * files afterwards. **`config/deployed.943.json` is committed and holds live testnet addresses**,
 * so no test here may run on chain 943: the script would overwrite that file with addresses from
 * a chain that does not exist, and the app reads it.
 *
 * `PROVE_TOKEN_OWNER` is not exercised. It is a `vm.envOr` over a fixed key, forge runs tests in
 * parallel, and the process environment is not EVM state — one test setting the key and another
 * reading it is a race. `test/Deploy.t.sol` tests the same environment-beats-file rule on keys it
 * can choose, which is the only way to test it without the race.
 */
contract DeployTestTokensTest is Test {
    uint256 constant CHAIN_PORTFOLIO = 424_301;
    uint256 constant CHAIN_NO_OWNER = 424_302;
    uint256 constant CHAIN_BAD_DECIMALS = 424_303;
    uint256 constant CHAIN_EMPTY = 424_304;
    uint256 constant CHAIN_GAP = 424_305;
    uint256 constant CHAIN_SIGNER_OWNS = 424_306;

    address constant OWNER = address(0xB0B);

    DeployTestTokens deployer;

    function setUp() public {
        deployer = new DeployTestTokens();
        // Every test writes the same value, so these writes cannot race each other.
        vm.setEnv("PROVE_TOKEN_OWNER", "0x0000000000000000000000000000000000000000");
        // Zeroed so a value in the developer's own shell cannot narrow the signer check and fail
        // every test here with somebody else's configuration.
        vm.setEnv("PROVE_DEPLOYER", "0x0000000000000000000000000000000000000000");
    }

    /**
     * @notice The committed testnet portfolio, deployed on a chain id that cannot clobber it.
     *
     * The file is copied rather than retyped, so this reads the six rows an operator would deploy.
     * A row added to the portfolio is covered the day it is added, and a row that stops parsing
     * fails here instead of halfway through a real run with three tokens already on chain.
     */
    function test_TheCommittedPortfolioDeploys() public {
        string memory json = vm.readFile(_path("tokens.", 943));
        _write(CHAIN_PORTFOLIO, json);

        FaucetToken[] memory tokens = _run();

        assertEq(tokens.length, 6, "six tokens in the committed portfolio");
        address fileOwner = vm.parseJsonAddress(json, ".owner");

        for (uint256 k = 0; k < tokens.length; k++) {
            string memory at = string.concat(".tokens[", vm.toString(k), "]");
            uint256 decimals = vm.parseJsonUint(json, string.concat(at, ".decimals"));
            uint256 unit = 10 ** decimals;

            assertEq(tokens[k].symbol(), vm.parseJsonString(json, string.concat(at, ".symbol")));
            assertEq(tokens[k].name(), vm.parseJsonString(json, string.concat(at, ".name")));
            assertEq(tokens[k].decimals(), uint8(decimals), "decimals");
            // The file is in whole tokens and the chain is in units. This is the scaling.
            assertEq(
                tokens[k].claimAmount(),
                vm.parseJsonUint(json, string.concat(at, ".drip")) * unit,
                "drip"
            );
            assertEq(
                tokens[k].claimCooldown(),
                vm.parseJsonUint(json, string.concat(at, ".cooldownHours")) * 1 hours,
                "cooldown"
            );
            assertEq(
                tokens[k].balanceOf(fileOwner),
                vm.parseJsonUint(json, string.concat(at, ".seed")) * unit,
                "seed"
            );
            // The handover. Only the owner may mint, and the key that signs the deploy is
            // disposable, so a token left in the deployer's hands is a live mint behind a
            // throwaway key.
            assertEq(tokens[k].owner(), fileOwner, "handed over");
            assertTrue(tokens[k].owner() != DEFAULT_SENDER, "and not left with the deployer");
        }

        _clean(CHAIN_PORTFOLIO);
    }

    /// @notice A file that names no owner leaves the tokens with the address that signed.
    function test_TheOwnerFallsBackToTheSigner() public {
        _write(CHAIN_NO_OWNER, _portfolio(""));
        FaucetToken[] memory tokens = _run();
        assertEq(tokens[0].owner(), DEFAULT_SENDER, "the signer keeps what it deployed");
        _clean(CHAIN_NO_OWNER);
    }

    /**
     * @notice When the configured owner is the signer, the script skips the handover.
     *
     * `transferOwnership` to the address that already holds it is a wasted transaction on a chain
     * that charges for them, and the guard that skips it is one comparison.
     */
    function test_TheSignerKeepsTheTokenWhenItIsAlreadyTheOwner() public {
        _write(CHAIN_SIGNER_OWNS, _portfolio(vm.toString(DEFAULT_SENDER)));
        FaucetToken[] memory tokens = _run();
        assertEq(tokens[0].owner(), DEFAULT_SENDER);
        _clean(CHAIN_SIGNER_OWNS);
    }

    /// @notice A row asking for more than eighteen decimals stops the run.
    function test_ADecimalsFieldAboveEighteenStops() public {
        vm.chainId(CHAIN_BAD_DECIMALS);
        _allowSigners(CHAIN_BAD_DECIMALS);
        vm.writeFile(
            _path("tokens.", CHAIN_BAD_DECIMALS),
            '{"tokens":[{"name":"Too Fine","symbol":"tFINE","decimals":19,"drip":1,"cooldownHours":6,"seed":1}]}'
        );
        vm.expectRevert(abi.encodeWithSelector(DeployTestTokens.DecimalsTooHigh.selector, 19));
        deployer.run();
        vm.removeFile(_path("tokens.", CHAIN_BAD_DECIMALS));
        _forgetSigners(CHAIN_BAD_DECIMALS);
    }

    /// @notice An empty portfolio stops the run rather than writing an empty address map.
    function test_AnEmptyTokenListStops() public {
        vm.chainId(CHAIN_EMPTY);
        _allowSigners(CHAIN_EMPTY);
        vm.writeFile(_path("tokens.", CHAIN_EMPTY), '{"tokens":[]}');
        vm.expectRevert(DeployTestTokens.NoTokens.selector);
        deployer.run();
        vm.removeFile(_path("tokens.", CHAIN_EMPTY));
        _forgetSigners(CHAIN_EMPTY);
    }

    /**
     * @notice The row probe stops at the first index that is not there.
     *
     * The file carries no length, so `_count` walks the indices until one fails to parse. A row
     * after a gap is invisible, which is the behaviour to know about: a config with a hole deploys
     * a short portfolio and says how many it deployed rather than failing.
     */
    function test_TheProbeStopsAtTheFirstGap() public {
        vm.chainId(CHAIN_GAP);
        _allowSigners(CHAIN_GAP);
        // Two rows, and the first carries no `symbol`, so the probe finds nothing at index zero.
        vm.writeFile(
            _path("tokens.", CHAIN_GAP),
            '{"tokens":[{"name":"No Symbol","decimals":18,"drip":1,"cooldownHours":6,"seed":1}]}'
        );
        vm.expectRevert(DeployTestTokens.NoTokens.selector);
        deployer.run();
        vm.removeFile(_path("tokens.", CHAIN_GAP));
        _forgetSigners(CHAIN_GAP);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /**
     * @dev Run the script from the address that will sign it.
     *
     * The script reads `msg.sender` for its owner fallback and gives each new token to it, and
     * `vm.startBroadcast()` then makes every call *from* the broadcaster. In a real run those are
     * one address. Called plainly from a test they are two — the test contract and forge's default
     * sender — and the first `mint` reverts `NotOwner`, which says nothing about the script.
     *
     * `vm.prank` cannot bridge them: broadcasting refuses to start while a prank is live. So the
     * default sender is given the code to make the call itself, and the two addresses agree the
     * way they do on chain.
     */
    function _run() internal returns (FaucetToken[] memory) {
        vm.etch(DEFAULT_SENDER, type(ScriptRunner).runtimeCode);
        return ScriptRunner(DEFAULT_SENDER).go(deployer);
    }

    function _path(string memory prefix, uint256 chainId) internal view returns (string memory) {
        return string.concat(vm.projectRoot(), "/config/", prefix, vm.toString(chainId), ".json");
    }

    /// @dev One row, and an owner line only when `owner` is given.
    function _portfolio(string memory owner) internal pure returns (string memory) {
        string memory head =
            bytes(owner).length == 0 ? "{" : string.concat('{"owner":"', owner, '",');
        return string.concat(
            head,
            '"tokens":[{"name":"Test One","symbol":"tONE","decimals":6,"drip":100,"cooldownHours":6,"seed":5000}]}'
        );
    }

    function _write(uint256 chainId, string memory json) internal {
        vm.chainId(chainId);
        vm.writeFile(_path("tokens.", chainId), json);
        _allowSigners(chainId);
    }

    /// @dev Remove both files. The script writes the second one itself, and a test that leaves it
    ///      behind leaves an address map for a chain that does not exist.
    function _clean(uint256 chainId) internal {
        vm.removeFile(_path("tokens.", chainId));
        vm.removeFile(_path("deployed.", chainId));
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
}

/// @notice Code lent to forge's default sender, so the script's `msg.sender` and its broadcaster
///         are one address, as they are under `forge script`.
contract ScriptRunner {
    function go(DeployTestTokens deployer) external returns (FaucetToken[] memory) {
        return deployer.run();
    }
}
