// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, MockERC20, NO_PERMIT2} from "./Mocks.sol";
import {
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION
} from "./Fees.sol";

/**
 * @notice What a token that answers with megabytes costs the address that batched it.
 *
 *   forge test --match-path test/ReturnBomb.t.sol -vv
 *
 * `_evaluate` reads a maker's allowance and balance before it checks their signature, and the
 * token address comes out of an intent nobody has signed. So a griefer needs no key: they post an
 * intent naming a token they wrote, with sixty-five zero bytes where the signature goes, and wait
 * for somebody to batch it.
 *
 * A high-level `staticcall` in Solidity copies the whole return buffer into memory before it reads
 * a word of it, and memory is priced quadratically. `_probe` uses assembly to copy exactly one
 * word instead. This measures what that is worth, because an argument is not a number.
 *
 * The bomb is bounded on the far side: the callee expands its own memory to produce the bytes and
 * it does that inside `_probe`'s thirty thousand gas cap, so it cannot return an unlimited buffer.
 * The question is what it can afford, and what copying that costs the caller.
 *
 * **Token B is the second half of this file and the sharper one.** Token A's probes were capped
 * from the start; token B was read three times without a cap — twice in `_deliverTo`, whose
 * bracket is the fee-on-transfer guard, and never at all by `_evaluate`. So `dryRun` returned `Ok`
 * for a poisoned leg, `fillability` agreed, and the batch found out inside `_settleLeg`, after
 * `_fillOne` had decided not to skip: `skipInvalid` could not help and the whole batch went. The
 * tests below drive the three shapes that reach it — a token that lies to the simulation, a token
 * that bombs a single fill, and a token that waits until after the transfer.
 */
contract ReturnBombTest is Test {
    ProveSettlement settlement;
    address relayer;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address executor = address(0xE0E);
    address maker;
    uint256 makerKey;
    address griefer;
    uint256 grieferKey;

    /**
     * @dev The bomb the token B tests are built on: thirty thousand words, or 960KB.
     *
     * Big enough that nobody can mistake the result for noise. Returning it costs the callee
     * about 1.85M gas of quadratic memory expansion, and copying it costs the caller the same
     * again — so an unbounded read of this token spends millions of a solver's gas on one leg,
     * and inside `_probe`'s thirty thousand the callee cannot afford a byte of it.
     */
    uint256 constant BOMB_WORDS = 30_000;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        (griefer, grieferKey) = makeAddrAndKey("griefer");

        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenA.mint(maker, 1_000_000e18);
        tokenB.mint(executor, 1_000_000e18);
        // The griefer is funded and approved in token A on purpose. The token B tests need their
        // leg to reach the probe that reads token B, and that probe is the last question
        // `_evaluate` asks: a maker who is not funded lands on `EscrowShort` long before it.
        tokenA.mint(griefer, 1_000_000e18);

        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(griefer);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    /**
     * @notice A batch that steps over a bomb costs the caller almost nothing extra.
     *
     * Two legs: one honest, one naming a token that answers every read with as much data as it can
     * afford. `skipInvalid` is true, so the bomb leg is stepped over and the honest one settles.
     * The measurement is the whole call, against the same batch with an ordinary bad token.
     */
    function test_TheWorstBombASolverCanBeMadeToStepOver() public {
        uint256 plain = _batchGasNaming(address(new SilentToken()));
        emit log_named_uint("a token that answers nothing", plain);
        emit log_string("  words      bytes      batch gas    premium");

        uint256 worst;
        uint256[8] memory sizes = [uint256(64), 256, 1_024, 2_048, 3_000, 3_400, 4_000, 8_000];
        for (uint256 k = 0; k < sizes.length; k++) {
            uint256 used = _batchGasNaming(address(new ReturnBomb(sizes[k])));
            if (used > worst) worst = used;
            emit log_string(string.concat(
                    "  ",
                    vm.toString(sizes[k]),
                    "\t",
                    vm.toString(sizes[k] * 32),
                    "\t",
                    vm.toString(used),
                    "\t+",
                    vm.toString(used - plain)
                ));
        }
        emit log_named_uint("worst premium", worst - plain);

        /*
         * The number this file exists to hold still. `_probe` reads a token an unsigned intent
         * named, so the griefer pays a transaction and the solver pays this.
         *
         * 30,177 as written, which is the gas cap and nothing on top: `_probe` copies one word
         * however much arrived. A high-level call copies the whole buffer first and reaches
         * 63,608, so the ceiling here is what keeps that rewrite out.
         */
        assertLt(worst - plain, 35_000, "a bomb must cost the cap and not a byte more");
    }

    /**
     * @notice A token that answers with nothing is stepped over, never a reason to revert.
     *
     * This is the test that refuses a rewrite of `_probe` that looks cheaper and is not. A typed
     * call — `try IERC20(token).allowance{gas: PROBE_GAS}(...) returns (uint256) { } catch { }` —
     * measures 2,785 gas a leg against the assembly's 2,764 and reads far better. It also reverts
     * here, because `catch` catches a failed call and not a failed decode of a successful one: a
     * token that returns zero bytes is a decode failure, and it comes back as a bare revert that
     * nothing in the batch can step over.
     *
     * A griefer needs no key and no funds to post an intent naming such a token. Every batch that
     * picks it up would die. That is the denial of service these probes exist to prevent, so the
     * shape that reintroduces it has to fail a test rather than a review.
     */
    function test_ATokenThatAnswersNothingIsSkippedAndTheBatchSettles() public {
        address silent = address(new SilentToken());

        ProveSettlement.Intent memory good = _intent(maker, address(tokenA), 1);
        ProveSettlement.Intent memory bad = _intent(griefer, silent, 2);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: good, signature: _sign(good, makerKey), take: good.amountIn, arming: ""
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: bad, signature: new bytes(65), take: bad.amountIn, arming: ""
        });

        vm.prank(executor);
        uint256 count = settlement.fillBatch(reqs, true, ANY_FEE);

        assertEq(count, 1, "the honest leg settled and the silent one was stepped over");
        // Ten basis points out of the maker's own hundred, so the gross is 100e18 still.
        assertEq(tokenB.balanceOf(maker), 99.9e18, "and the honest maker was paid");
    }

    /**
     * @notice What the skip probes cost when every leg is honest.
     *
     * `test/Gas.t.sol` batches with `skipInvalid: false` everywhere, so it has never priced this.
     * A solver working a public board passes true — stepping over a maker who revoked is the
     * whole reason it batches at all — so this is the number that side actually pays.
     */
    function test_WhatTheSkipProbesCostWhenEveryLegIsHonest() public {
        uint256 strict = _honestBatchGas(20, false);
        uint256 skipping = _honestBatchGas(20, true);

        emit log_named_uint("20 honest legs, skipInvalid false", strict);
        emit log_named_uint("20 honest legs, skipInvalid true ", skipping);
        emit log_named_uint("  the probes, per leg            ", (skipping - strict) / 20);

        // Split the cold slots from the warm ones. Every leg here is the same maker and the same
        // token, so leg one pays for the account and both storage slots and the rest pay nothing
        // like it. The marginal figure is the one a long batch actually runs at.
        uint256 oneStrict = _honestBatchGas(1, false);
        uint256 oneSkipping = _honestBatchGas(1, true);
        emit log_named_uint("  first leg, cold                ", oneSkipping - oneStrict);
        emit log_named_uint(
            "  every leg after it, warm       ",
            ((skipping - strict) - (oneSkipping - oneStrict)) / 19
        );
    }

    // ── Token B ──────────────────────────────────────────────────────────────

    /**
     * @notice The chameleon: honest to the simulation, a bomb to the transaction.
     *
     * `eth_call` with no `from` leaves `tx.origin` at zero, so a token can tell a solver's
     * simulation from the transaction that follows it and answer each differently. That defeats
     * every mitigation a solver can build for itself — simulate, read the reason, submit — and it
     * is the reason the bound has to live in the contract.
     *
     * The batch is what this defends. `_deliverTo` runs inside `_settleLeg`, after `_fillOne` has
     * decided not to skip, so a leg that reached it would take the whole batch down whatever
     * `skipInvalid` said. `_evaluate` now asks token B the same question one step earlier, where
     * stepping over the leg is still free.
     */
    function test_ATokenBThatLiesToTheSimulationIsSteppedOverByTheBatch() public {
        SimulationChameleon bait = new SimulationChameleon(BOMB_WORDS);

        ProveSettlement.Intent memory bad = _intent(griefer, address(tokenA), 2);
        bad.tokenOut = address(bait);
        bytes memory badSig = _sign(bad, grieferKey);

        // 1. The solver simulates the leg. Zero origin, so the token answers honestly and the
        //    whole simulate-then-submit loop is told the leg is good.
        vm.prank(executor, address(0));
        assertEq(
            uint256(settlement.fillability(bad, badSig, bad.amountIn, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "the chameleon passes the simulation, which is the whole attack"
        );

        // 2. The same question inside a transaction, where the token is a bomb.
        vm.prank(executor, executor);
        assertEq(
            uint256(settlement.fillability(bad, badSig, bad.amountIn, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.TokenOutUnreadable),
            "and the chain names it in the transaction"
        );

        // 3. And the batch that carries it settles the leg beside it. Measured against the same
        //    batch whose bad leg names a token that answers nothing, so the figure is what the
        //    megabytes cost and not what the skip costs.
        uint256 plain = _batchGasNamingTokenOut(address(new SilentToken()));
        uint256 bombed = _batchGasNamingTokenOut(address(bait));
        emit log_named_uint("a batch stepping over a token B that answers nothing", plain);
        emit log_named_uint("the same batch, 960KB of token B                    ", bombed);
        emit log_named_uint("  the premium                                       ", bombed - plain);

        assertLt(bombed - plain, 35_000, "a bomb on token B must cost the cap and not a byte more");
    }

    /// @dev A two-leg batch whose second leg delivers `tokenOut`, with that leg skipped. The
    ///      honest leg beside it is what proves the batch survived rather than died quietly.
    function _batchGasNamingTokenOut(address tokenOut) internal returns (uint256) {
        ProveSettlement.Intent memory good = _intent(maker, address(tokenA), 1);
        ProveSettlement.Intent memory bad = _intent(griefer, address(tokenA), 2);
        bad.tokenOut = tokenOut;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: good, signature: _sign(good, makerKey), take: good.amountIn, arming: ""
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: bad, signature: _sign(bad, grieferKey), take: bad.amountIn, arming: ""
        });

        uint256 snap = vm.snapshotState();
        vm.prank(executor, executor);
        uint256 before = gasleft();
        uint256 count = settlement.fillBatch(reqs, true, ANY_FEE);
        uint256 used = before - gasleft();

        assertEq(count, 1, "the honest leg settled and the poisoned one was stepped over");
        // Ten basis points out of the maker's own hundred, so the gross is 100e18 still.
        assertEq(tokenB.balanceOf(maker), 99.9e18, "and the honest maker was paid");
        vm.revertToState(snap);
        return used;
    }

    /**
     * @notice A single fill on the same token refuses for the price of one capped read.
     *
     * `fill` passes `deep = false`, so it never asks the question above — it has nothing to step
     * over and learns the same fact from `_deliverTo` a moment later. What matters is the price
     * of learning it: the fee-on-transfer guard reads token B twice, and unbounded, the first of
     * those reads is where the whole gas limit goes.
     *
     * `Underpaid` and not a new error. That bracket is a guard: the contract promises the maker
     * an amount received, and a delivery it cannot measure is one it cannot promise.
     */
    function test_ASingleFillOnAPoisonedTokenBRefusesForThePriceOfTheCap() public {
        SimulationChameleon bait = new SimulationChameleon(BOMB_WORDS);

        ProveSettlement.Intent memory bad = _intent(griefer, address(tokenA), 3);
        bad.tokenOut = address(bait);
        bytes memory badSig = _sign(bad, grieferKey);

        vm.prank(executor, executor);
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = address(settlement)
            .call(abi.encodeCall(ProveSettlement.fill, (bad, badSig, bad.amountIn, ANY_FEE)));
        uint256 used = before - gasleft();
        emit log_named_uint("a single fill that refuses a poisoned token B", used);

        assertFalse(ok, "the fill refused");
        assertEq(
            bytes4(ret),
            ProveSettlement.Underpaid.selector,
            "and said the delivery is not measurable"
        );
        assertLt(used, 250_000, "for the cap, not for the gas limit");
    }

    /**
     * @notice A token that waits until after the transfer is bounded on the second read too.
     *
     * This is the shape the probe in `_evaluate` cannot catch and must not be trusted to: the
     * token answers every read honestly until `transferFrom` runs, then bombs. So the leg reads
     * `Ok` on the way in — in a simulation and in the transaction alike — and the grief lands on
     * `_deliverTo`'s closing read. Both reads of that bracket go through the cap for this reason.
     */
    function test_ATokenBThatWaitsUntilAfterTheTransferIsBoundedToo() public {
        LateBomb bait = new LateBomb(BOMB_WORDS);
        bait.mint(executor, 1_000_000e18);

        ProveSettlement.Intent memory bad = _intent(griefer, address(tokenA), 4);
        bad.tokenOut = address(bait);
        bytes memory badSig = _sign(bad, grieferKey);

        // Honest on the way in, so nothing upstream can see this one coming.
        vm.prank(executor, executor);
        assertEq(
            uint256(settlement.fillability(bad, badSig, bad.amountIn, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "the leg reads Ok right up to the delivery"
        );

        vm.prank(executor, executor);
        uint256 before = gasleft();
        (bool ok, bytes memory ret) = address(settlement)
            .call(abi.encodeCall(ProveSettlement.fill, (bad, badSig, bad.amountIn, ANY_FEE)));
        uint256 used = before - gasleft();
        emit log_named_uint("a fill whose token B bombs after the transfer", used);

        assertFalse(ok, "the fill refused");
        assertEq(
            bytes4(ret), ProveSettlement.Underpaid.selector, "on the closing read of the guard"
        );
        assertLt(used, 250_000, "for the cap, not for the gas limit");
    }

    /// @dev A batch of `n` honest legs from one maker, filled one way or the other.
    function _honestBatchGas(uint256 n, bool skipInvalid) internal returns (uint256) {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](n);
        for (uint256 k = 0; k < n; k++) {
            ProveSettlement.Intent memory i = _intent(maker, address(tokenA), 100 + k);
            i.amountIn = 1_000e18;
            reqs[k] = ProveSettlement.FillRequest({
                intent: i, signature: _sign(i, makerKey), take: i.amountIn, arming: ""
            });
        }
        uint256 snap = vm.snapshotState();
        vm.prank(executor);
        uint256 before = gasleft();
        settlement.fillBatch(reqs, skipInvalid, ANY_FEE);
        uint256 used = before - gasleft();
        vm.revertToState(snap);
        return used;
    }

    /// @dev Gas for a two-leg batch whose second leg names `token`, with the bad leg skipped.
    function _batchGasNaming(address token) internal returns (uint256) {
        ProveSettlement.Intent memory good = _intent(maker, address(tokenA), 1);
        ProveSettlement.Intent memory bad = _intent(griefer, token, 2);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: good, signature: _sign(good, makerKey), take: good.amountIn, arming: ""
        });
        // Sixty-five zero bytes. The griefer never signs anything, because the probes run first.
        reqs[1] = ProveSettlement.FillRequest({
            intent: bad, signature: new bytes(65), take: bad.amountIn, arming: ""
        });

        uint256 snap = vm.snapshotState();
        vm.prank(executor);
        uint256 before = gasleft();
        settlement.fillBatch(reqs, true, ANY_FEE);
        uint256 used = before - gasleft();
        vm.revertToState(snap);
        return used;
    }

    /**
     * @notice An armed hostile leg costs the batch one capped frame, not the batch.
     *
     * `_arm` calls `armLeg` in a frame of its own so a leg that cannot be armed reverts alone.
     * Before `ARM_GAS`, that frame took 63/64 of the batch's gas. A griefer posted an unsigned
     * intent on a token that loops, attached a Permit arming blob, and every `skipInvalid` batch
     * that carried it ran out of gas. The two tokens below reach the loop by the two doors
     * `_grantAllowance` has: the allowance read, and the permit call.
     */
    function test_AnArmedLegOnALoopingAllowanceIsSteppedOver() public {
        (bool ok, uint256 used) = _armedHostileBatch(address(new GasBurner()));
        emit log_named_uint("batch gas, looping allowance", used);
        assertTrue(ok, "the batch settles");
        assertEq(tokenB.balanceOf(maker), 99.9e18, "the honest leg fills");
        assertLt(used, 1_000_000, "the hostile leg costs one probe cap");
    }

    function test_AnArmedLegOnALoopingPermitIsSteppedOverForTheArmCap() public {
        (bool ok, uint256 used) = _armedHostileBatch(address(new PermitBurner()));
        emit log_named_uint("batch gas, looping permit", used);
        assertTrue(ok, "the batch settles");
        assertEq(tokenB.balanceOf(maker), 99.9e18, "the honest leg fills");
        // `ARM_GAS` is 500,000. The honest leg and the batch's own work cost the rest.
        assertLt(used, 1_000_000, "the hostile leg costs at most ARM_GAS");
    }

    /// @dev Leg 0 is unsigned on `hostile` with a Permit blob; leg 1 is an honest maker.
    function _armedHostileBatch(address hostile) internal returns (bool ok, uint256 used) {
        ProveSettlement.Intent memory good = _intent(maker, address(tokenA), 1);
        ProveSettlement.Intent memory bad = _intent(griefer, hostile, 2);
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: bad,
            signature: new bytes(65),
            take: bad.amountIn,
            arming: abi.encode(ProveSettlement.Permit({value: 1, deadline: 1, v: 27, r: 0, s: 0}))
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: good, signature: _sign(good, makerKey), take: good.amountIn, arming: ""
        });
        vm.prank(executor);
        (ok,) = address(settlement).call{gas: 3_000_000}(
            abi.encodeCall(settlement.fillBatch, (reqs, true, ANY_FEE))
        );
        used = vm.lastFrameGas().gasTotalUsed;
    }

    function _intent(address who, address tokenIn, uint256 nonce)
        internal
        view
        returns (ProveSettlement.Intent memory)
    {
        return ProveSettlement.Intent({
            maker: who,
            recipient: who,
            tokenIn: tokenIn,
            tokenOut: address(tokenB),
            amountIn: 1_000e18,
            minOutStart: 100e18,
            minOutEnd: 100e18,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(address(0x5152)),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0.001e18,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL(),
            nonce: nonce,
            curve: bytes32(0)
        });
    }

    function _sign(ProveSettlement.Intent memory i, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }
}

/// @notice Answers every call with as many zero bytes as it can pay to expand memory for. Under
///         `_probe`'s gas cap that is a bounded amount, which is half of what this file measures.
contract ReturnBomb {
    uint256 private immutable size;

    constructor(uint256 words) {
        size = words * 32;
    }

    fallback() external {
        uint256 n = size;
        assembly {
            return(0x00, n)
        }
    }
}

/// @notice Answers every call with nothing at all, which `_probe` reads as "cannot say".
contract SilentToken {
    fallback() external {}
}

/**
 * @notice A token B that is honest to an `eth_call` and a bomb to a transaction.
 *
 * Not `EconAudit.t.sol`'s `ChameleonToken`, which its owner switches by hand. This one needs no
 * owner and no switch, which is what makes it the shape a solver cannot outrun.
 *
 * `eth_call` with no `from` field runs at `tx.origin == address(0)`, and a transaction never
 * does. One comparison is the whole disguise, it costs the attacker nothing, and it is what makes
 * a solver's own simulate-then-submit loop useless against this: the leg they priced is not the
 * leg they send.
 *
 * It answers a balance with zero, which is all `_evaluate` needs to hear. The fill never gets far
 * enough for a transfer, so there is nothing else to implement.
 */
contract SimulationChameleon {
    uint256 private immutable size;

    constructor(uint256 words) {
        size = words * 32;
    }

    fallback() external {
        if (tx.origin == address(0)) {
            assembly {
                mstore(0x00, 0)
                return(0x00, 0x20)
            }
        }
        uint256 n = size;
        assembly {
            return(0x00, n)
        }
    }
}

/**
 * @notice A token B that answers honestly until it has been transferred, and bombs after.
 *
 * The shape no view can catch. `_evaluate` reads this token before the delivery and is told the
 * truth, so the leg passes every check a batch and a simulation can run — and the grief lands on
 * the closing read of `_deliverTo`'s fee-on-transfer bracket, which is why that read is capped
 * as well as the opening one.
 *
 * `balanceOf` stays `view`, because `_probe` uses `staticcall` and a mock that wrote a counter
 * would fail every read for the wrong reason.
 */
contract LateBomb {
    mapping(address => uint256) private bal;
    bool private armed;
    uint256 private immutable size;

    constructor(uint256 words) {
        size = words * 32;
    }

    function mint(address to, uint256 amount) external {
        bal[to] += amount;
    }

    function allowance(address, address) external pure returns (uint256) {
        return type(uint256).max;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        bal[from] -= amount;
        bal[to] += amount;
        armed = true;
        return true;
    }

    function balanceOf(address who) external view returns (uint256) {
        if (!armed) return bal[who];
        uint256 n = size;
        assembly {
            return(0x00, n)
        }
    }
}

/// @notice Loops on every call, until the frame's gas runs out.
contract GasBurner {
    fallback() external {
        while (true) {}
    }
}

/// @notice Answers the allowance read with zero, so the arming asks for a permit, and loops there.
contract PermitBurner {
    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }

    fallback() external {
        while (true) {}
    }
}
