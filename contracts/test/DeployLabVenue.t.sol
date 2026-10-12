// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DeployLabVenue} from "../script/DeployLabVenue.s.sol";
import {MockRouter} from "./Mocks.sol";
import {FaucetToken} from "./tokens/FaucetToken.sol";

/**
 * @notice `DeployLabVenue`, run for real.
 *
 *   forge test --match-path test/DeployLabVenue.t.sol -vv
 *
 * The script stands a venue up on the lab chain so a plan there can close through something. It
 * reads `config/deployed.<chainid>.json` — a flat map of symbol to address that `DeployTestTokens`
 * wrote — deploys a `MockRouter`, and mints it a float of every token in the portfolio.
 *
 * Two of those steps fail in ways nothing downstream would name. The float is minted per token at
 * that token's own decimals, so a portfolio mixing eighteen and six would leave the venue unable
 * to pay for half of it while looking fully funded. And the mint is owner-only: on a chain
 * somebody else runs, the script's key owns nothing and every mint reverts — which is right, and
 * is why `app/scripts/lab/up.sh` sets `PROVE_TOKEN_OWNER` to its own deployer before it runs the
 * token script at all.
 *
 * Every test writes its own configuration under a chain id nothing else claims, and removes the
 * file afterwards. **`config/deployed.943.json` is committed and holds live testnet addresses**,
 * so no test here may run on chain 943.
 */
contract DeployLabVenueTest is Test {
    // One chain id per test, and the file each writes is named after it. Two tests sharing an id
    // share a path on a real filesystem that no EVM snapshot rolls back, so one removes the
    // configuration the other is still reading. `DeployTestTokens.t.sol` numbers its tests for
    // the same reason.
    uint256 constant CHAIN_MIXED = 424_401;
    uint256 constant CHAIN_EMPTY = 424_402;
    uint256 constant CHAIN_NOT_OWNER = 424_403;
    uint256 constant CHAIN_RATE = 424_404;

    DeployLabVenue script;

    function setUp() public {
        script = new DeployLabVenue();
        // Zeroed so a value in the developer's own shell cannot narrow the signer check and fail
        // every test here with somebody else's configuration.
        vm.setEnv("PROVE_DEPLOYER", "0x0000000000000000000000000000000000000000");
    }

    /**
     * @dev A token the script itself may mint.
     *
     * `vm.startBroadcast()` with no argument runs the calls after it as `DEFAULT_SENDER`, not as
     * this test contract, so a token owned by `address(this)` refuses the script's mint with
     * `NotOwner` — which is the behaviour `test_AVenueCannotBeFundedFromTokensTheScriptDoesNotOwn`
     * is about, and a poor way to set up the tests that are about something else.
     */
    function _ownedToken(string memory name, string memory symbol, uint8 decimals)
        internal
        returns (FaucetToken)
    {
        return new FaucetToken(name, symbol, decimals, 1, 0, DEFAULT_SENDER);
    }

    /// @dev The file the script reads, written where it will look for this chain id.
    function _write(uint256 chainId, string memory json) internal returns (string memory path) {
        path = string.concat(vm.projectRoot(), "/config/deployed.", vm.toString(chainId), ".json");
        vm.writeFile(path, json);
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

    /**
     * @notice A portfolio of mixed decimals leaves the venue able to pay for all of it.
     *
     * The float is a count of whole tokens, so it has to be scaled per token. Minting the same
     * raw number to an eighteen-decimal token and a six-decimal one funds the first a million
     * times over and the second not at all — and the run would only find out later, as a swap
     * that reverts for a reason that has nothing to do with what it was testing.
     */
    function test_TheVenueIsFundedInEveryTokensOwnDecimals() public {
        FaucetToken big = _ownedToken("Big", "BIG", 18);
        FaucetToken small = _ownedToken("Small", "SML", 6);

        _write(
            CHAIN_MIXED,
            string.concat(
                '{"BIG":"',
                vm.toString(address(big)),
                '","SML":"',
                vm.toString(address(small)),
                '"}'
            )
        );
        vm.chainId(CHAIN_MIXED);

        MockRouter venue = script.run();
        _remove(CHAIN_MIXED);

        assertEq(big.balanceOf(address(venue)), 1_000_000 * 10 ** 18, "eighteen decimals scaled");
        assertEq(small.balanceOf(address(venue)), 1_000_000 * 10 ** 6, "and six as well");
    }

    /// @notice The venue pays one for one, so a lab run measures legs and not a windfall.
    function test_TheVenuePaysOneForOne() public {
        FaucetToken t = _ownedToken("One", "ONE", 18);
        _write(CHAIN_RATE, string.concat('{"ONE":"', vm.toString(address(t)), '"}'));
        vm.chainId(CHAIN_RATE);

        MockRouter venue = script.run();
        _remove(CHAIN_RATE);

        // A rate that doubled every trade would make every plan look profitable and stop the lab
        // telling anybody anything.
        assertEq(venue.rateNum(), 1, "numerator");
        assertEq(venue.rateDen(), 1, "denominator");
    }

    /// @notice An empty portfolio is refused rather than deploying a venue that can pay nobody.
    function test_AnEmptyPortfolioIsRefused() public {
        _write(CHAIN_EMPTY, "{}");
        vm.chainId(CHAIN_EMPTY);

        vm.expectRevert(DeployLabVenue.NoTokens.selector);
        script.run();
        _remove(CHAIN_EMPTY);
    }

    /**
     * @notice On a chain the script does not own the tokens of, the mint reverts.
     *
     * Which is right, and is the whole reason `up.sh` hands the lab's tokens to its own deployer
     * before running this. A script that could mint somebody else's testnet portfolio would be a
     * worse thing to have than one that fails loudly here.
     */
    function test_AVenueCannotBeFundedFromTokensTheScriptDoesNotOwn() public {
        FaucetToken theirs = new FaucetToken("Theirs", "THR", 18, 1, 0, address(0xB0B));
        _write(CHAIN_NOT_OWNER, string.concat('{"THR":"', vm.toString(address(theirs)), '"}'));
        vm.chainId(CHAIN_NOT_OWNER);

        vm.expectRevert(FaucetToken.NotOwner.selector);
        script.run();
        _remove(CHAIN_NOT_OWNER);
    }
}
