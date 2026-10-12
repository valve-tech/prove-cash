// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
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
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ProveBatchExecutor, IProveSettlementBatch} from "../src/ProveBatchExecutor.sol";
import {IProveSettlementFill} from "../src/ProveExecutor.sol";
import {
    ANY_FEE,
    LeanBatchExecutor,
    MockERC20,
    MockPermit2,
    MockRouter,
    NO_PERMIT2,
    PayingExecutor
} from "./Mocks.sol";

/**
 * @notice What each path actually costs. Run with -vv to read the table.
 *
 *   forge test --match-path test/Gas.t.sol -vv
 *
 * The numbers that matter are the marginal ones: what the twentieth intent in a batch costs
 * compared to the first. An XYK market gives an executor a thin edge, and gas is what decides
 * whether taking it is worth doing at all.
 */
contract GasTest is Test {
    /// @dev The bound a real executor passes: the fee they priced, not `type(uint256).max`.
    ///      The difference is 372 gas of calldata on every fill, which would flatter nothing.
    /// @dev Ten basis points, as a caller's own bound now reads.
    uint256 constant PRICED_FEE_RATE = 0.001e18;

    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;
    MockERC20 tokenA;
    MockERC20 tokenB;
    MockERC20 tokenC;

    /// @dev The fixture's fee destination, and the settlement's `defaultProceeds`. The rows
    ///      here price transfers, and one address is enough for that.
    address sink = address(0x5152);
    /// @dev Two more, so a row can price a broken run against a coalesced one.
    address burner = address(0xB4B4);
    address rival = address(0x21FA);
    address executor = address(0xE0E);
    address maker;
    uint256 makerKey;
    /// @dev Real enough to charge what Permit2 charges. See `MockPermit2`'s five fidelity notes;
    ///      the fifth one is why the rows below read as they do.
    address permit2;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        /*
         * A real Permit2, not the codeless placeholder most of these tests pass.
         *
         * One row prices a leg that passes evaluation and then cannot be armed, which is the
         * failure a griefer manufactures and the dearest a batch can meet. Against a codeless
         * address the arming call returns at once and the row reads 30,425 — a third of the
         * truth. Against this it does the EIP-712 recover a real Permit2 does and then refuses
         * the signature, which is what the leg actually costs.
         */
        permit2 = address(new MockPermit2());
        settlement = newSettlement(permit2);
        relayer = settlement.relayer();
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenC = new MockERC20("C", "C", 18);

        tokenA.mint(maker, type(uint128).max);
        tokenB.mint(executor, type(uint128).max);
        tokenC.mint(executor, type(uint128).max);

        vm.startPrank(maker);
        tokenA.approve(relayer, type(uint256).max);
        // The one durable grant a permit2 maker makes, and the only one Permit2 needs.
        tokenA.approve(permit2, type(uint256).max);
        vm.stopPrank();
        vm.startPrank(executor);
        tokenB.approve(relayer, type(uint256).max);
        tokenC.approve(relayer, type(uint256).max);
        vm.stopPrank();
        // The rival is a second filler, for the one row that prices losing a race to them.
        tokenB.mint(rival, type(uint128).max);
        vm.startPrank(rival);
        tokenB.approve(relayer, type(uint256).max);
        vm.stopPrank();

        vm.warp(1_700_000_000);

        // Warm the fee destination and the maker's proceeds slot: a real board is not the first
        // trade ever, and a cold-slot measurement would flatter the batch.
        tokenB.mint(sink, 1);
        tokenB.mint(maker, 1);
        // Both of the other destinations too, for the same reason: a cold recipient would price
        // the storage slot and not the run.
        tokenB.mint(burner, 1);
        tokenB.mint(rival, 1);
    }

    function _intent(uint256 nonce, address tokenOut)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: tokenOut,
            amountIn: 1_000e18,
            minOutStart: 30e18,
            minOutEnd: 30e18,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(sink),
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

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /**
     * @dev Permit2's own digest, built the way Permit2 builds it. Two things are unlike every
     *      other EIP-712 digest here and both are load-bearing: the domain carries no version
     *      string, and the spender is not a field — Permit2 hashes `msg.sender` in, so this names
     *      the relayer because the relayer is the only address that will ever present it.
     */
    function _permit2Signature(address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (bytes memory)
    {
        MockPermit2 p2 = MockPermit2(permit2);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                p2.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        p2.PERMIT_TRANSFER_FROM_TYPEHASH(),
                        keccak256(abi.encode(p2.TOKEN_PERMISSIONS_TYPEHASH(), token, amount)),
                        relayer,
                        nonce,
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(makerKey, digest);
        return abi.encodePacked(r, sv, v);
    }

    function _batch(uint256 n, bool mixedTokens)
        internal
        view
        returns (ProveSettlement.FillRequest[] memory)
    {
        return _batchFrom(5_000, n, mixedTokens);
    }

    /**
     * @dev A batch whose legs name a fee destination, so the run has a line to pay.
     *
     * `destinations` of zero names none, which charges nothing at all — the cheapest a batch can
     * be, and the baseline the two rows below are measured against. One keeps the whole batch on
     * a single run and one transfer. Two alternates them, which breaks the run on every leg.
     */
    function _batchNaming(uint256 base, uint256 n, uint256 destinations)
        internal
        view
        returns (ProveSettlement.FillRequest[] memory reqs)
    {
        reqs = new ProveSettlement.FillRequest[](n);
        for (uint256 k = 0; k < n; k++) {
            ProveSettlement.Intent memory i = _intent(base + k, address(tokenB));
            if (destinations == 0) {
                i.feeConfig = bytes32(0);
                i.feeRateProceeds = 0;
            } else {
                i.feeConfig = feeCfg(destinations > 1 && k % 2 == 1 ? rival : burner);
            }
            reqs[k] = ProveSettlement.FillRequest({
                intent: i, signature: _sign(i), take: 100e18, arming: ""
            });
        }
    }

    /// @dev Each series of batches needs its own nonce range. Reuse one and the later batches
    ///      fill the same intents past `amountIn`, which reverts rather than measuring anything.
    function _batchFrom(uint256 base, uint256 n, bool mixedTokens)
        internal
        view
        returns (ProveSettlement.FillRequest[] memory reqs)
    {
        reqs = new ProveSettlement.FillRequest[](n);
        for (uint256 k = 0; k < n; k++) {
            address out = mixedTokens && k % 2 == 1 ? address(tokenC) : address(tokenB);
            ProveSettlement.Intent memory i = _intent(base + k, out);
            reqs[k] = ProveSettlement.FillRequest({
                intent: i, signature: _sign(i), take: 100e18, arming: ""
            });
        }
    }

    /// @dev What happens to the ninth leg of `_marginalLeg`'s batch.
    enum Fate {
        Fills,
        Expired,
        Taken,
        NonceBurnt,
        BadSignature,
        Permit2Fills,
        ApprovalPulled
    }

    /**
     * @dev What one more leg of this kind adds to a batch of eight that already fills.
     *
     * Nine fresh intents, the first eight of which fill exactly as the baseline's eight did, so
     * the difference is the ninth leg and nothing else. `skipInvalid` is true throughout: a batch
     * that reverts on a bad leg measures nothing, and no solver sends one.
     */
    function _marginalLeg(uint256 base, uint256 eight, Fate fate) internal returns (uint256) {
        ProveSettlement.FillRequest[] memory reqs = _batchFrom(base, 9, false);
        ProveSettlement.Intent memory ninth = _intent(base + 8, address(tokenB));

        if (fate == Fate.Expired) {
            // Behind us by an hour. `_evaluate` answers Expired before a token is touched.
            ninth.startTime = uint64(block.timestamp - 2 hours);
            ninth.endTime = uint64(block.timestamp - 1 hours);
        } else if (
            fate == Fate.NonceBurnt || fate == Fate.BadSignature || fate == Fate.Permit2Fills
                || fate == Fate.ApprovalPulled
        ) {
            // Funded, Permit2 approved, and an arming call that cannot succeed. `_evaluate` reads
            // `EscrowShort` — the reservation is empty, which is what an unarmed permit2 leg
            // looks like — so the batch tries to arm it, and the attempt is what costs.
            ninth.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_PERMIT2();
        }

        bytes memory ninthSig = _sign(ninth);
        // The nonce Permit2 must be handed, which `_pullPermit2In` checks against the intent's
        // own hash before it calls out. Get it wrong and the leg is refused locally for a third
        // of the price — which is not the failure this row is for.
        uint256 permit2Nonce = uint256(settlement.hashIntent(ninth));
        reqs[8] = ProveSettlement.FillRequest({
            intent: ninth,
            signature: ninthSig,
            take: 100e18,
            arming: (fate == Fate.NonceBurnt || fate == Fate.BadSignature
                    || fate == Fate.Permit2Fills || fate == Fate.ApprovalPulled)
                ? abi.encode(
                    ProveSettlement.Permit2Transfer({
                        token: address(tokenA),
                        amount: 1_000e18,
                        nonce: permit2Nonce,
                        deadline: block.timestamp + 1 hours,
                        signature: (fate == Fate.Permit2Fills || fate == Fate.ApprovalPulled)
                            ? _permit2Signature(
                                address(tokenA), 1_000e18, permit2Nonce, block.timestamp + 1 hours
                            )
                            : new bytes(65)
                    })
                )
                : bytes("")
        });

        if (fate == Fate.NonceBurnt) {
            // The front-run. The maker burns the very nonce their own signature names, in a
            // transaction of their own, after the solver simulated and before the block lands.
            // `invalidateUnorderedNonces` is Permit2's own function and needs no signature.
            vm.prank(maker);
            MockPermit2(permit2)
                .invalidateUnorderedNonces(permit2Nonce >> 8, 1 << (permit2Nonce & 0xff));
        }

        if (fate == Fate.ApprovalPulled) {
            /*
             * The dearest thing a maker can arrange, and nothing about the signature is wrong.
             *
             * They revoke the ERC-20 approval Permit2 spends, after the solver simulated. So the
             * whole arming runs: the nonce is written, the recover succeeds, and only then does
             * the TOKEN refuse. Every check the cheaper failures stop at, this one passes.
             *
             * Spending the tokens instead lands in the same place — `transferFrom` reverts on the
             * balance rather than the allowance — and is not measured separately because every
             * leg in this batch shares one maker, so emptying them would fail all nine.
             */
            vm.prank(maker);
            tokenA.approve(permit2, 0);
        }

        if (fate == Fate.Taken) {
            // A rival gets there first, in their own transaction. Its gas is theirs, not ours;
            // what this row prices is what the loser pays for having carried the leg anyway.
            //
            // The signature is taken above, never here: `_sign` calls `hashIntent` on the
            // settlement, and an external call inside a pranked line eats the prank. This file's
            // `relayer` field exists for the same reason.
            vm.prank(rival);
            settlement.fill(ninth, ninthSig, ninth.amountIn, PRICED_FEE_RATE);
        }

        vm.prank(executor);
        uint256 g = gasleft();
        settlement.fillBatch(reqs, true, PRICED_FEE_RATE);
        return (g - gasleft()) - eight;
    }

    /**
     * @dev An atomic batch of `n` that a rival already took the leg at `lost` from, and what its
     *      revert costs.
     *
     * Not a cycle — `_batchFrom` builds one maker's offers, not a ring — and it does not need to
     * be. What a ring contributes is `skipInvalid` false, and that is the whole of what is being
     * priced: a batch that may not step over a leg reverts, and a reverting call still pays for
     * everything it ran. `gasleft` around a low-level call is the only way to see that number.
     */
    function _lostRing(uint256 base, uint256 n, uint256 lost) internal returns (uint256) {
        ProveSettlement.FillRequest[] memory reqs = _batchFrom(base, n, false);

        // The rival settles the leg at `lost`, in their own transaction, before this one lands.
        ProveSettlement.Intent memory gone = reqs[lost].intent;
        bytes memory goneSig = reqs[lost].signature;
        vm.prank(rival);
        settlement.fill(gone, goneSig, gone.amountIn, PRICED_FEE_RATE);

        vm.prank(executor);
        uint256 g = gasleft();
        (bool ok,) = address(settlement)
            .call(abi.encodeCall(ProveSettlement.fillBatch, (reqs, false, PRICED_FEE_RATE)));
        uint256 used = g - gasleft();
        if (ok) revert("the ring was supposed to revert");
        return used;
    }

    /**
     * @notice One table, one transaction's worth of warmth.
     *
     * The rows share a frame on purpose: by the time the batches run, the token balances and the
     * contract's own account are warm, which is the state a real board is in. Each measurement
     * is scoped so the locals give their stack slots back — without that, `forge coverage` runs
     * this file out of stack and the whole run needs `--ir-minimum`.
     */
    /**
     * @notice What batching is worth: eight legs in one call against the same eight one at a time.
     *
     * Its own test, and that is the whole design of it. The first cut measured the singles inside
     * `test_GasReport`, and every row below that point moved — the marginal fill from 62,480 to
     * 63,168, the three-leg ring from 196,507 to 196,692. A state snapshot did not fix it, which
     * is the clue: the cost was never state. Eight `FillRequest` arrays expand the TEST FRAME's
     * memory, memory is priced quadratically, and every later call in the same frame pays for the
     * high-water mark left by this one. So the two shapes are measured together in a frame of
     * their own, where they are comparable to each other and to nothing they disturb.
     *
     * Three SDK files quote this pair — `plan.ts`, `pack.ts` and `abi.ts` — and until #136 they
     * quoted a figure the suite had stopped producing, because a number that is not a row is a
     * number no gate can retire.
     */
    function test_GasEightLegsTogetherAndApart() public {
        uint256 g;
        uint256 together;
        {
            ProveSettlement.FillRequest[] memory batch = _batchFrom(36_000, 8, false);
            vm.prank(executor);
            g = gasleft();
            settlement.fillBatch(batch, true, PRICED_FEE_RATE);
            together = g - gasleft();
        }
        _row("eight legs, one batch", together, together / 8);

        uint256 apart;
        {
            // 37_000 because every nonce base in this file shares one maker, and a base that
            // overlaps another block's leaves that block's intent part-filled. The symptom is a
            // `TooMuch()` revert somewhere else entirely, which is a slow thing to read.
            ProveSettlement.FillRequest[] memory ones = _batchFrom(37_000, 8, false);
            for (uint256 k = 0; k < 8; k++) {
                ProveSettlement.FillRequest[] memory one = new ProveSettlement.FillRequest[](1);
                one[0] = ones[k];
                vm.prank(executor);
                g = gasleft();
                settlement.fillBatch(one, true, PRICED_FEE_RATE);
                apart += g - gasleft();
            }
        }
        _row("eight legs, one at a time", apart, apart / 8);

        assertGt(apart, together, "batching has to be cheaper, or the flag it feeds is a lie");
    }

    function test_GasReport() public {
        emit log("");
        emit log("path                                   gas      per intent");
        emit log("-----------------------------------------------------------");

        uint256 g;

        // The first fill of an intent pays for a cold `filled` slot and cold token balances.
        // Both numbers matter: the first is what an executor pays on a fresh intent, the second
        // is what every fill after it costs.
        {
            ProveSettlement.Intent memory one = _intent(1, address(tokenB));
            bytes memory sig = _sign(one);
            vm.prank(executor);
            g = gasleft();
            settlement.fill(one, sig, 100e18, PRICED_FEE_RATE);
            uint256 cold = g - gasleft();
            _row("fill, allowance, first touch", cold, cold);

            vm.prank(executor);
            g = gasleft();
            settlement.fill(one, sig, 100e18, PRICED_FEE_RATE);
            uint256 warm = g - gasleft();
            _row("fill, allowance, warm", warm, warm);
        }

        // Single fill, escrow custody. The reservation is funded up front, as a maker would.
        // The deposit is measured too: the maker pays it, so it is part of the cost of "proven".
        {
            ProveSettlement.Intent memory esc = _intent(2, address(tokenB));
            esc.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
            bytes memory escSig = _sign(esc);
            vm.prank(maker);
            g = gasleft();
            settlement.deposit(esc, 10_000e18);
            uint256 dep = g - gasleft();
            _row("deposit, first touch", dep, dep);

            // Cold, because an executor's fill is its own transaction: the deposit above warmed
            // the reservation slots, and a warm measurement hides what that slot layout costs.
            vm.cool(address(settlement));
            vm.prank(executor);
            g = gasleft();
            settlement.fill(esc, escSig, 100e18, PRICED_FEE_RATE);
            uint256 escrowCold = g - gasleft();
            _row("fill, escrow, cold slots", escrowCold, escrowCold);

            vm.prank(executor);
            g = gasleft();
            settlement.fill(esc, escSig, 100e18, PRICED_FEE_RATE);
            uint256 escrowWarm = g - gasleft();
            _row("fill, escrow, warm", escrowWarm, escrowWarm);
        }

        // A callback fill: the contract hands token A to the caller, calls it back, and pulls
        // token B out of it. The bot holds inventory and approves once, so the callback itself
        // does nothing and this row measures the contract rather than the mock. Its first touch
        // of its own balance slot is in the number, as it was before the pull redesign, so the
        // row compares with the one this table used to print.
        {
            PayingExecutor bot = new PayingExecutor();
            tokenB.mint(address(bot), type(uint96).max);
            bot.approveMax(address(tokenB), relayer);

            ProveSettlement.Intent memory cb = _intent(3, address(tokenB));
            bot.settle(settlement, cb, _sign(cb), 100e18, "", PRICED_FEE_RATE);

            // Read from inside the bot's own frame, so its dispatch is not in the number and the
            // row compares with the rows above it.
            uint256 callbackFill = bot.lastGas();
            _row("fillWithCallback", callbackFill, callbackFill);
        }

        // Batches, one output token: the fee transfer is shared.
        uint256[3] memory sizes = [uint256(1), 5, 20];
        uint256[3] memory used;
        for (uint256 s = 0; s < sizes.length; s++) {
            ProveSettlement.FillRequest[] memory reqs = _batch(sizes[s], false);
            vm.prank(executor);
            g = gasleft();
            settlement.fillBatch(reqs, false, PRICED_FEE_RATE);
            used[s] = g - gasleft();
            _row(
                string.concat("fillBatch x", vm.toString(sizes[s]), ", one token"),
                used[s],
                used[s] / sizes[s]
            );
        }

        // The number an executor actually decides on: what the twentieth intent adds, not what
        // the average one costs. The fixed cost of the call is in the first, never in the rest.
        _row("fillBatch marginal intent", used[2] - used[0], (used[2] - used[0]) / 19);

        // A batch whose output tokens alternate: the fee transfer cannot be shared.
        {
            ProveSettlement.FillRequest[] memory mixed = _batch(20, true);
            vm.prank(executor);
            g = gasleft();
            settlement.fillBatch(mixed, false, PRICED_FEE_RATE);
            uint256 mixedGas = g - gasleft();
            _row("fillBatch x20, alternating", mixedGas, mixedGas / 20);
        }

        /*
         * What a fee costs, measured against a batch that charges none.
         *
         * The run keys on the token *and* the destination, so a batch whose legs all name one
         * place pays one transfer and a batch that alternates pays one per leg. The first is
         * nearly free; the second is the price of naming them.
         */
        {
            // Its own baseline, on its own fresh nonces. `used[2]` above shares five intents with
            // the x1 and x5 rows, so five of its `filled` slots are already warm and it is 100k
            // cheaper than a batch of twenty new ones. Comparing against it would price the
            // difference in the fixture and call it the fee.
            ProveSettlement.FillRequest[] memory bare = _batchNaming(7_000, 20, 0);
            vm.prank(executor);
            g = gasleft();
            settlement.fillBatch(bare, false, PRICED_FEE_RATE);
            uint256 unnamed = g - gasleft();
            _row("fillBatch x20, no fee at all", unnamed, unnamed / 20);

            ProveSettlement.FillRequest[] memory named = _batchNaming(7_100, 20, 1);
            vm.prank(executor);
            g = gasleft();
            settlement.fillBatch(named, false, PRICED_FEE_RATE);
            uint256 oneDest = g - gasleft();
            _row("fillBatch x20, one destination", oneDest, oneDest / 20);
            _row("  the fee, per leg", oneDest - unnamed, (oneDest - unnamed) / 20);

            ProveSettlement.FillRequest[] memory split = _batchNaming(7_200, 20, 2);
            vm.prank(executor);
            g = gasleft();
            settlement.fillBatch(split, false, PRICED_FEE_RATE);
            uint256 twoDest = g - gasleft();
            _row("fillBatch x20, two destinations", twoDest, twoDest / 20);
            _row("  a broken run, per leg", twoDest - unnamed, (twoDest - unnamed) / 20);
        }

        // The credit path, against the same intents. The executor here holds inventory and its
        // callback does nothing, so the difference measures the contract and not the mock — the
        // same comparison an executor with inventory faces when it chooses between the two.
        {
            LeanBatchExecutor bot = new LeanBatchExecutor();
            tokenB.mint(address(bot), type(uint96).max);
            tokenC.mint(address(bot), type(uint96).max);
            bot.approveMax(address(tokenB), relayer);
            bot.approveMax(address(tokenC), relayer);

            // Warm the executor's slots first, so no row below pays for a cold account.
            bot.settle(settlement, _batchFrom(9_000, 1, false), false, "", PRICED_FEE_RATE);

            uint256[3] memory cb;
            for (uint256 s = 0; s < sizes.length; s++) {
                ProveSettlement.FillRequest[] memory reqs =
                    _batchFrom(6_000 + s * 100, sizes[s], false);
                bot.settle(settlement, reqs, false, "", PRICED_FEE_RATE);
                cb[s] = bot.lastGas();
                _row(
                    string.concat("fillBatchWithCallback x", vm.toString(sizes[s])),
                    cb[s],
                    cb[s] / sizes[s]
                );
            }

            _row("  its marginal intent", cb[2] - cb[0], (cb[2] - cb[0]) / 19);

            // What the credit ordering costs at the margin, which is the number that decides it.
            // Below this an executor with inventory should still use `fillBatch`; without
            // inventory `fillBatch` cannot walk a ring at all, at any price.
            uint256 plain = (used[2] - used[0]) / 19;
            uint256 credit = (cb[2] - cb[0]) / 19;
            _row("  the credit premium, per leg", credit - plain, credit - plain);
        }

        /*
         * What a leg that does NOT fill costs, which is the whole of a solver's risk.
         *
         * `fillBatch` with `skipInvalid` steps over a leg it cannot settle and fills the rest.
         * That tolerance is not free: the settlement validated the leg, possibly tried to arm it,
         * and charges for the attempt. Only the legs that fill earn anything, so a solver is
         * betting the surplus on the survivors against the gas on all of them.
         *
         * Each row is marginal — a batch of nine against the same batch of eight — because "what
         * does one more leg of this kind cost me" is the question a solver actually asks. The
         * failures do not cost the same, and the dear one is not the one that happens:
         *
         *   expired      `_evaluate` refuses it before a token is touched
         *   taken        a rival settled it first. The ordinary weather of a contested book: two
         *                solvers reading one order book WILL overlap, and the loser pays
         *   nonce burnt  the maker spent their own Permit2 nonce after the solver simulated and
         *                before the block landed
         *   unfunded     the maker revoked the ERC-20 approval Permit2 spends, in the same gap.
         *                The DEAREST of the lot, because nothing about the signature is wrong:
         *                the nonce is written, the recover succeeds, and only then does the token
         *                refuse. Spending the tokens instead lands in the same place
         *   bad sig      the arming signature was never going to recover. A solver pays this
         *                NEVER — `dryRun` walks the same path over `eth_call` and reads the same
         *                refusal for nothing, and the signature bytes cannot change between the
         *                simulation and the block. It is here as the upper bound on a mistake,
         *                not as a risk
         *
         * **Only the two middle rows are risks.** A dry run answers every question about the
         * calldata for free; what it cannot answer is what the STATE will be one block later. So
         * the failures a solver actually pays for are exactly the ones a maker can arrange after
         * the solver has looked and before the block lands, and each one costs that maker a
         * transaction of their own.
         *
         * **Why an arming failure can cost MORE than a fill**, which is the surprising one. The
         * trace, on the bad-signature row:
         *
         *   armLeg, the whole self-call                 41,522
         *     the reservation's balanceOf                2,541
         *     ProveRelayer.pullWithPermit2              34,145
         *       MockPermit2.permitTransferFrom          30,398
         *         the cold nonce bitmap write          ~16,500   measured by pre-warming it
         *         ecrecover                              3,000
         *
         * Permit2 spends the nonce BEFORE it checks the signature — `_useUnorderedNonce(owner,
         * permit.nonce)` and then `signature.verify(...)`, verified against Uniswap's source. So
         * a signature that will never recover still pays for a cold, zero-to-non-zero storage
         * write first, and the revert refunds none of it. Settling the same leg costs about
         * 33,600. That is the whole of the difference.
         *
         * **The armed leg that fills is here to price a check that is not worth making.** Reading
         * `nonceBitmap` before the arming call saves 3,424 on a burnt nonce and costs 1,064 on
         * every permit2 leg that fills, so it pays only above a 31% failure rate. Measured and
         * reverted on 2026-09-02; `ProveRelayer.pullWithPermit2` carries the note. The row stays
         * because the trade-off is only visible with both sides of it on the table.
         *
         * `app/scripts/lab/batch-gas.ts` measures the same shapes against a live chain. These
         * rows exist so the numbers reach the landing page generated rather than transcribed.
         */
        {
            uint256 eight;
            {
                ProveSettlement.FillRequest[] memory base = _batchFrom(20_000, 8, false);
                vm.prank(executor);
                g = gasleft();
                settlement.fillBatch(base, true, PRICED_FEE_RATE);
                eight = g - gasleft();
            }
            _row("fillBatch x8, all fill", eight, eight / 8);

            /*
             * The same eight legs, one transaction each, which is what a solver pays without
             * `fillBatch`. The pair is the whole argument for batching, and the SDK quotes it in
             * three places — `plan.ts`, `pack.ts` and `abi.ts`. Both rows reach
             * `app/src/landing/gas.ts`, so `check-gas-figures.py` covers every quotation of them.
             * They did not before, and all three files carried a figure this test stopped
             * producing.
             *
             * **It understates the singles, deliberately.** Eight calls in one test share warm
             * storage after the first; eight real transactions do not, and each pays its own
             * 21,000 of intrinsic gas on top. So the true gap is wider than this row, and a
             * conservative row is the one to argue from.
             */
            uint256 fills = _marginalLeg(21_000, eight, Fate.Fills);
            _row("  one more leg that fills", fills, fills);
            uint256 expired = _marginalLeg(22_000, eight, Fate.Expired);
            _row("  one more leg, expired", expired, expired);
            uint256 taken = _marginalLeg(23_000, eight, Fate.Taken);
            _row("  one more leg a rival took", taken, taken);
            uint256 burnt = _marginalLeg(24_000, eight, Fate.NonceBurnt);
            _row("  one more leg whose nonce was burnt", burnt, burnt);
            uint256 bad = _marginalLeg(26_000, eight, Fate.BadSignature);
            _row("  one more leg with a bad signature", bad, bad);
            uint256 armed = _marginalLeg(27_000, eight, Fate.Permit2Fills);
            _row("  one more permit2 leg that fills", armed, armed);
            uint256 pulled = _marginalLeg(28_000, eight, Fate.ApprovalPulled);
            _row("  one more leg the maker unfunded", pulled, pulled);
        }

        /*
         * What losing a race costs a RING, which is a different number and a much larger one.
         *
         * `fillBatch` with `skipInvalid` steps over the leg a rival took and fills the rest for
         * 15,982. A ring cannot do that: it sends `skipInvalid` false on purpose, because
         * settling half a cycle leaves the solver holding an unhedged position. One missing leg
         * reverts the whole transaction.
         *
         * A reverted transaction is not free. It pays for everything it did before it stopped
         * and it fills nothing, so the cost depends on WHERE the missing leg sits. First position
         * and the settlement gives up at once. Last position and it has already released seven
         * makers' tokens, paid seven recipients and written seven slots — all undone, none
         * refunded.
         *
         * **Most of an early failure is not the failure.** The two `FIRST leg gone` rows fail at
         * the same place for the same reason and differ only in how many legs were sent behind
         * the broken one: 59,727 for two and 121,329 for eight, which is about 8,850 a leg for
         * calldata and decoding that never ran. The settlement really does give up at once. What
         * the extra 53,101 buys is the right to have submitted six more legs.
         *
         * So ring size costs a solver even when the failure is early, and it costs them before
         * any of it executes. That is not a thing a contract change can fix — it is the price of
         * putting the bytes on chain.
         *
         * **This is the accident, not the attack.** Two solvers reading one public board will
         * overlap; neither did anything wrong, and the slower one pays. The spread between the
         * FIRST and LAST rows is what a rule for dividing the book between solvers would be
         * worth, and it is also the argument for preferring the tolerant path wherever both work.
         */
        {
            // What the same shape costs when nothing goes wrong, so the losses above can be read
            // against a win rather than against each other.
            ProveSettlement.FillRequest[] memory whole = _batchFrom(29_000, 3, false);
            vm.prank(executor);
            g = gasleft();
            settlement.fillBatch(whole, false, PRICED_FEE_RATE);
            uint256 won = g - gasleft();
            _row("atomic 3, all fill", won, won / 3);

            uint256 twoFirst = _lostRing(34_000, 2, 0);
            _row("atomic 2, the FIRST leg gone", twoFirst, twoFirst);
            uint256 two = _lostRing(30_000, 2, 1);
            _row("atomic 2, one leg gone", two, two);
            uint256 three = _lostRing(31_000, 3, 2);
            _row("atomic 3, one leg gone", three, three);
            uint256 firstOfEight = _lostRing(32_000, 8, 0);
            _row("atomic 8, the FIRST leg gone", firstOfEight, firstOfEight);
            uint256 lastOfEight = _lostRing(33_000, 8, 7);
            _row("atomic 8, the LAST leg gone", lastOfEight, lastOfEight);
        }

        // The maker's side of escrow, which this table never costed.
        //
        // Every row above is what an executor pays. A maker choosing between custody modes pays
        // these instead, and the exit is the half that decides it: escrow is only worth using if
        // changing your mind is cheap. A maker who cannot afford to get out does not get in.
        {
            ProveSettlement.Intent memory own = _intent(100, address(tokenB));
            own.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();

            vm.prank(maker);
            g = gasleft();
            settlement.deposit(own, 1_000e18);
            uint256 opening = g - gasleft();
            _row("deposit, new reservation", opening, opening);

            vm.prank(maker);
            g = gasleft();
            settlement.deposit(own, 1_000e18);
            uint256 topUp = g - gasleft();
            _row("deposit, top-up", topUp, topUp);

            // Cold, because a maker withdraws in a transaction of their own, hours later.
            vm.cool(address(settlement));
            vm.prank(maker);
            g = gasleft();
            settlement.withdraw(own);
            uint256 exit = g - gasleft();
            _row("withdraw, and the offer ends", exit, exit);
            _row("  escrow round trip", opening + exit, opening + exit);
        }

        // The off switch. A wallet-custody maker has no other one, so what it costs is what
        // decides whether a forgotten signature ever gets retired.
        {
            ProveSettlement.Intent memory dead = _intent(101, address(tokenB));
            vm.prank(maker);
            g = gasleft();
            settlement.cancel(dead);
            uint256 one = g - gasleft();
            _row("cancel, one intent", one, one);

            // One slot, whatever the book holds. The comparison is against `cancel` times the
            // number of orders resting, which is why the row exists.
            vm.prank(maker);
            g = gasleft();
            settlement.invalidateBefore(102);
            uint256 all = g - gasleft();
            _row("invalidateBefore, the whole book", all, all);
        }

        // What a destination pays to take its money out. A fee is booked at fill time now, so
        // this is the second half of the cost of charging one — paid once per (destination,
        // token) whenever the destination chooses, not once per fill.
        {
            vm.cool(address(settlement));
            g = gasleft();
            claimFor(settlement, sink, address(tokenB));
            uint256 out = g - gasleft();
            _row("claim, a destination empties its book", out, out);
        }

        emit log("");
    }

    function _row(string memory label, uint256 total, uint256 each) private {
        emit log_named_string(
            "", string.concat(_pad(label, 38), _pad(vm.toString(total), 9), vm.toString(each))
        );
    }

    function _pad(string memory s, uint256 width) private pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length >= width) return string.concat(s, " ");
        bytes memory out = new bytes(width);
        for (uint256 k = 0; k < width; k++) {
            out[k] = k < b.length ? b[k] : bytes1(" ");
        }
        return string(out);
    }
}

/**
 * @notice What the call sink costs a ring, measured on the real `ProveBatchExecutor`.
 *
 *   forge test --match-path test/Gas.t.sol -vv
 *
 * The rows above price the settlement. These price the executor's venue path, because the sink
 * changed shape: it used to be one shared contract deployed once, and it is now a template that
 * each CALLER clones once, at an address derived from their own. A clone is an EIP-1167 proxy of
 * 45 bytes, so the caller who mints one pays a `create2` and 45 bytes of code deposit.
 *
 * **The first entry and the ones after it are different prices, and that is the whole point.**
 * A caller's first ring that calls a venue mints their sink. Every ring after it predicts the
 * address and reads its code size, which is a few thousand gas. So the first three rows are
 * first entries — a fresh fixture, a caller who has never traded — and the pair below them
 * measures a first and a later entry side by side from the same warmed state.
 *
 * Read the three ring rows together. The sink is charged ONCE per `settleRing`, so the step from
 * one venue call to three is the price of two more venue calls and nothing else. That is what
 * the extra parameter down the callback buys, and it is why the sink address is not read back
 * out of storage inside `_sell`.
 *
 * **Read the three standalone rows as first entries in every sense.** The fee is booked rather
 * than transferred now, so a ring's first fill in a token also writes that token's fee book from
 * zero — two slots at 20,000 apiece plus the settlement's own zero balance. The fixture cannot
 * warm those without warming the makers too, so the three rows carry it and the `_pair` rows do
 * not. See `setUp`.
 *
 * `gen-gas.mjs` publishes only the labels its `WANTED` list names, so these rows print and are
 * not drawn on the landing page.
 */
contract RingSinkGasTest is Test {
    ProveSettlement settlement;
    ProveBatchExecutor exec;
    MockRouter venue;

    MockERC20 tokenA;
    MockERC20 tokenB;

    address relayer;
    address feeDest = address(0x5152);
    address proceeds = address(0xD0D);
    address caller = address(0xCA11);
    /// @dev A second solver, so a row can warm the makers' balances without minting `caller`'s
    ///      sink. See `_pair`.
    address other = address(0xB0B0);

    address makerA;
    uint256 keyA;
    address makerB;
    uint256 keyB;

    function setUp() public {
        (makerA, keyA) = makeAddrAndKey("makerA");
        (makerB, keyB) = makeAddrAndKey("makerB");

        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        exec = new ProveBatchExecutor(address(settlement));

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        venue = new MockRouter();

        tokenA.mint(makerA, 1_000_000e18);
        tokenB.mint(makerB, 1_000_000e18);
        tokenA.mint(address(venue), 1_000_000e18);
        tokenB.mint(address(venue), 1_000_000e18);

        vm.prank(makerA);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(makerB);
        tokenB.approve(relayer, type(uint256).max);

        // Warm both destinations and the executor's own balances. A cold slot costs about 20,000
        // gas the first time it goes non-zero, and that belongs to the address's history rather
        // than to the path this row names.
        //
        // **These two mints stopped warming the fee path when the fee became a booking.** A fill
        // no longer transfers to `feeDest`; it pulls to the settlement and writes
        // `_pendingFees[feeDest][token]` and `_totalPendingFees[token]`. Warming those needs a
        // real fill, and a real fill here would also warm the makers' payout slots — which the
        // three standalone rows deliberately leave cold. So the mints stay, and the three
        // standalone rows carry a one-off fee-book first touch in each of the two tokens: about
        // 123,000 between them, measured. The `_pair` rows below warm with a whole ring first and
        // show the steady-state figure, which is about 17,000.
        tokenA.mint(feeDest, 1);
        tokenB.mint(feeDest, 1);
        tokenA.mint(address(exec), 1);
        tokenB.mint(address(exec), 1);

        vm.warp(1_700_000_000);
    }

    /// @notice A two-leg ring that closes itself, so no venue is called and no sink is minted.
    function test_GasRingNoVenueCall() public {
        _row("ring, no venue call", _settle(0));
    }

    /// @notice The same ring with one venue call, by a caller who has never traded before.
    function test_GasRingOneVenueCall() public {
        _row("ring, one venue call", _settle(1));
    }

    /// @notice And with three. One sink still, so the step is two venue calls.
    function test_GasRingThreeVenueCalls() public {
        _row("ring, three venue calls", _settle(3));
    }

    /// @notice What a caller's first ring pays for the sink, and what their next one pays.
    function test_GasRingFirstAndLaterEntryOneVenueCall() public {
        _pair(1, "one venue call");
    }

    /// @notice The same pair with three venue calls. One sink covers all three, either way.
    function test_GasRingFirstAndLaterEntryThreeVenueCalls() public {
        _pair(3, "three venue calls");
    }

    /**
     * @notice The clone on its own: one `create` and 45 bytes of code deposit.
     *
     * Measured from a contract, never from the test contract. A `create` run by the test itself
     * reads about 95,000 through `gasleft()`, which is Foundry's own accounting and not what a
     * ring pays. `CloneCost` is an ordinary contract, so its number is the real one.
     *
     * The two rows below it price the executor's actual lookup, which is what a ring pays: a
     * prediction, a cold `extcodesize`, and a `create2` only when the address is empty. `vm.cool`
     * puts the address back to cold between them, because a ring reads it cold once per
     * transaction and never twice.
     */
    function test_GasTheCloneItself() public {
        CloneCost meter = new CloneCost(address(exec.sinkTemplate()));
        _row("an EIP-1167 clone of the sink", meter.measure());

        CloneCost look = new CloneCost(address(exec.sinkTemplate()));
        _row("a sink minted, first entry", look.lookUp());
        vm.cool(look.predicted());
        _row("a sink found, later entry", look.lookUp());
    }

    /**
     * @dev The first entry and a later one, side by side, differing only in the sink.
     *
     * A gas row is only a comparison if both sides start from the same state. A ring writes
     * several slots from zero the first time it runs — the caller's two balances, and the two
     * makers' payment balances — and a zero-to-non-zero `sstore` costs about 17,000 more than an
     * ordinary one. Left alone, that swamps the sink and makes the later ring look far cheaper
     * than it is.
     *
     * So this warms all of them first, with a mint for the caller and a whole ring by somebody
     * else that pays both makers. After that the two measured rings write nothing from zero, and
     * the only thing left between them is whether this caller's sink already exists.
     */
    function _pair(uint256 n, string memory tag) private {
        tokenA.mint(caller, 1);
        tokenB.mint(caller, 1);
        tokenA.mint(other, 1);
        tokenB.mint(other, 1);
        _settleAs(other, n, 10);

        uint256 first = _settleAs(caller, n, 20);
        uint256 later = _settleAs(caller, n, 30);

        _row(string.concat("ring, ", tag, ", first entry"), first);
        _row(string.concat("ring, ", tag, ", later entry"), later);

        assertGt(first, later, "a later entry should not pay for the sink again");
        // The clone is about 41,000 on its own. A wider gap means the mint got dearer, or the
        // warming above stopped covering a slot the ring writes from zero.
        assertLt(first - later, 45_000, "the sink got dearer to mint; re-price the gas table");
    }

    /// @dev Settle the fixture's ring with `n` venue calls, as `caller`, on nonces 1 and 2.
    function _settle(uint256 n) private returns (uint256) {
        return _settleAs(caller, n, 1);
    }

    /// @dev The same ring, by `who`, on nonces `nonce` and `nonce + 1`.
    function _settleAs(address who, uint256 n, uint256 nonce) private returns (uint256) {
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, nonce),
            keyA,
            1_000e18
        );
        reqs[1] = _req(
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, nonce + 1),
            keyB,
            110e18
        );

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](n);
        for (uint256 k = 0; k < n; k++) {
            swaps[k] = _sellAForB(10e18);
        }

        address[] memory sweep = new address[](2);
        sweep[0] = address(tokenA);
        sweep[1] = address(tokenB);
        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: swaps, disposal: new ProveBatchExecutor.Swap[](0), sweep: sweep
        });

        vm.prank(who);
        uint256 g = gasleft();
        exec.settleRing(reqs, false, ANY_FEE, route);
        return g - gasleft();
    }

    function _sellAForB(uint256 amountIn) private view returns (ProveBatchExecutor.Swap memory) {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        return ProveBatchExecutor.Swap({
            tokenIn: address(tokenA),
            amountIn: amountIn,
            tokenOut: address(tokenB),
            spender: address(venue),
            target: address(venue),
            data: abi.encodeCall(
                MockRouter.swapExactTokensForTokens,
                (amountIn, 0, path, address(exec), block.timestamp)
            ),
            extra: new address[](0),
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });
    }

    function _intent(
        address maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 nonce
    ) private view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minOutStart: minOut,
            minOutEnd: minOut,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(feeDest),
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

    function _req(ProveSettlement.Intent memory i, uint256 key, uint256 take)
        private
        view
        returns (IProveSettlementBatch.FillRequest memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return IProveSettlementBatch.FillRequest({
            intent: IProveSettlementFill.Intent({
                maker: i.maker,
                recipient: i.recipient,
                tokenIn: i.tokenIn,
                tokenOut: i.tokenOut,
                amountIn: i.amountIn,
                minOutStart: i.minOutStart,
                minOutEnd: i.minOutEnd,
                startTime: i.startTime,
                endTime: i.endTime,
                executor: i.executor,
                feeConfig: i.feeConfig,
                feeRate: i.feeRate,
                feeRateIn: i.feeRateIn,
                feeRateProceeds: i.feeRateProceeds,
                minFill: i.minFill,
                authNonce: i.authNonce,
                flags: i.flags,
                nonce: i.nonce,
                curve: i.curve
            }),
            signature: abi.encodePacked(r, s, v),
            take: take,
            arming: ""
        });
    }

    /// @dev The same shape `GasTest._row` prints, so `gen-gas.mjs` reads these lines too.
    function _row(string memory label, uint256 used) private {
        emit log_named_string(
            "", string.concat(_pad(label, 38), _pad(vm.toString(used), 9), vm.toString(used))
        );
    }

    function _pad(string memory s, uint256 width) private pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length >= width) return string.concat(s, " ");
        bytes memory out = new bytes(width);
        for (uint256 k = 0; k < width; k++) {
            out[k] = k < b.length ? b[k] : bytes1(" ");
        }
        return string(out);
    }
}

/// @dev Charges one clone and reports what it cost. See `test_GasTheCloneItself`.
contract CloneCost {
    address public immutable template;

    /// @dev Any salt will do. The executor's is the caller's address; the cost is the same.
    bytes32 private constant SALT = bytes32(uint256(1));

    constructor(address t) {
        template = t;
    }

    function measure() external returns (uint256 used) {
        uint256 g = gasleft();
        Clones.clone(template);
        used = g - gasleft();
    }

    /// @dev The address this meter mints, so the test can cool it between the two readings.
    function predicted() external view returns (address) {
        return Clones.predictDeterministicAddress(template, SALT);
    }

    /// @dev The executor's own lookup, line for line. Call it once for the mint and again for
    ///      the reuse; the second call finds the code already there and mints nothing.
    function lookUp() external returns (uint256 used) {
        uint256 g = gasleft();
        address at = Clones.predictDeterministicAddress(template, SALT);
        if (at.code.length == 0) Clones.cloneDeterministic(template, SALT);
        used = g - gasleft();
    }
}

/**
 * @notice What a tolerant ring pays to carry fallbacks it does not need. #130.
 *
 *   forge test --match-path test/Gas.t.sol -vv
 *
 * These two rows are the inputs to `breakEvenLossRate` in `sdk/src/solver/tolerant.ts`, and until
 * now they were the only inputs to it with no generated gate behind them. They were measured once
 * in `BatchExecutor.t.sol::test_WhatAFallbackCostsARingThatDoesNotNeedIt`, which asserts ceilings
 * rather than the figures, and then quoted into the solver as two constants. That is the shape of
 * mistake this repository has already made twice — the landing page advertised a gas figure in
 * thirty-five languages that no commit ever measured. Here they are rows, so `gen-gas.mjs`
 * publishes them into `app/src/landing/gas.ts` and CI's `--check` compares them against a fresh
 * `forge test` on every push.
 *
 * **A fallback is carried on EVERY ring and paid for on every ring**, to save the loss on the few
 * that lose a leg. So carrying only pays when
 *
 *     cost carried x (1 - p)  <  loss avoided x p
 *
 * with `p` the share of rings that lose a leg. The loss avoided is the `atomic 3, one leg gone`
 * row above. These two rows are the left-hand side of it.
 *
 * **The fixture is `BatchExecutor.t.sol`'s, deliberately copied rather than borrowed from
 * `RingSinkGasTest` above.** The first attempt measured this ring in that fixture and read 23,827
 * and 21,435 against the 19,401 and 17,492 the ceiling test reads — the same operation, 4,400
 * gas apart, because the two fixtures warm different slots. A row that moves with its fixture is
 * a row that has to name one. This one names the fixture the ceiling assertions already guard,
 * so the published figure and the guarded figure are the same measurement.
 *
 * The ceilings stay where they are. They fire on a drift of any size in either fixture and this
 * gate fires on a drift of one gas, which is the division of labour the repository already uses
 * between `Gas.t.sol` and every test that asserts `assertLt` on a cost.
 */
contract FallbackGasTest is Test {
    ProveSettlement settlement;
    ProveBatchExecutor exec;
    MockRouter venue;

    MockERC20 tokenA;
    MockERC20 tokenB;

    address relayer;
    address feeDest = address(0x5152);
    address proceeds = address(0xD0D);
    address caller = address(0xCA11);

    address makerA;
    uint256 keyA;
    address makerB;
    uint256 keyB;

    /// @dev `BatchExecutorTest.setUp`, field for field. A copy, because the number this contract
    ///      publishes is only the number that test guards if the state under it is the same.
    function setUp() public {
        (makerA, keyA) = makeAddrAndKey("makerA");
        (makerB, keyB) = makeAddrAndKey("makerB");

        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        exec = new ProveBatchExecutor(address(settlement));

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        venue = new MockRouter();

        tokenA.mint(makerA, 1_000_000e18);
        tokenB.mint(makerB, 1_000_000e18);
        tokenA.mint(address(venue), 1_000_000e18);
        tokenB.mint(address(venue), 1_000_000e18);

        vm.prank(makerA);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(makerB);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    /**
     * @notice The two carry costs, and the one-off entry fee that must not be confused with them.
     *
     * **Warm first, and measure second.** Without the warming run the rows differ by about 52,000
     * in the wrong direction: the first ring pays for every cold slot the later ones reuse, so the
     * run carrying fallbacks reads cheaper than the run without them.
     *
     * **A solver pays for the sink once in their life, not once per ring.** A ring that names no
     * venue call mints no sink; name one — even a fallback that cannot fire — and a solver who has
     * never called a venue buys their sink then and there. So the sink-minting run comes before
     * the three measured ones, and its cost is published as its own row rather than folded into
     * a break-even it does not belong in.
     */
    function test_GasFallbacksCarriedByARingThatDoesNotNeedThem() public {
        // Every leg of every ring below settles, so no fallback here ever fires. What the rows
        // measure is the carry alone: the calldata, the decoding, and one skip decision per swap.
        _settle(1, 0);

        uint256 everFirst = _settle(3, 1);
        uint256 bare = _settle(5, 0);
        uint256 one = _settle(7, 1);
        uint256 two = _settle(9, 2);

        // What says the fallbacks stayed idle, and it is measured rather than assumed. A swap
        // that fired would still leave both legs settled, so `_settle`'s own count cannot see it;
        // it would only show up as a row four times too big, and a row is not a guard. The
        // venue's balance can see it, because an idle fallback never reaches the venue at all.
        //
        // Read against `setUp`'s mint rather than against a reading taken first: a `balanceOf`
        // before the measured rings warms the venue's account and moves the first row by 22 gas.
        assertEq(tokenA.balanceOf(address(venue)), 1_000_000e18, "no fallback reached the venue");
        assertEq(tokenB.balanceOf(address(venue)), 1_000_000e18, "and none was paid out by it");

        _row("a fallback carried, the first", one - bare);
        _row("a fallback carried, each after", two - one);
        _row("a solver's first sink, once ever", everFirst - bare);

        assertGt(one, bare, "a carried fallback is not free");
        assertGt(two, one, "and a second one costs again");
        assertGt(everFirst, one, "the ring that mints the sink pays more than the ring after it");
    }

    /**
     * @dev The fixture's ring on nonces `base` and `base + 1`, carrying `n` fallbacks that cannot
     *      fire, and what settling it cost.
     *
     * `skipInvalid` is true because a tolerant ring is the only ring that carries a fallback.
     */
    function _settle(uint256 base, uint256 n) private returns (uint256) {
        IProveSettlementBatch.FillRequest[] memory reqs = new IProveSettlementBatch.FillRequest[](2);
        reqs[0] = _req(
            _intent(makerA, address(tokenA), address(tokenB), 1_000e18, 100e18, base),
            keyA,
            1_000e18
        );
        reqs[1] = _req(
            _intent(makerB, address(tokenB), address(tokenA), 110e18, 900e18, base + 1),
            keyB,
            110e18
        );

        ProveBatchExecutor.Swap[] memory swaps = new ProveBatchExecutor.Swap[](n);
        for (uint256 k = 0; k < n; k++) {
            swaps[k] = _sellAForB(1e18);
            // Keyed to a leg that settles, inverted: this runs only if that leg goes missing.
            swaps[k].leg = k | exec.WHEN_ABSENT();
        }

        address[] memory sweep = new address[](2);
        sweep[0] = address(tokenA);
        sweep[1] = address(tokenB);
        ProveBatchExecutor.Route memory route = ProveBatchExecutor.Route({
            legs: 2, swaps: swaps, disposal: new ProveBatchExecutor.Swap[](0), sweep: sweep
        });

        vm.prank(caller);
        uint256 g = gasleft();
        uint256 count = exec.settleRing(reqs, true, ANY_FEE, route);
        uint256 used = g - gasleft();

        // A row measuring a ring that quietly stopped settling would be a row about nothing. Two
        // legs in, two legs out, every time. Checked after the reading, not inside it.
        assertEq(count, 2, "both legs settled, so no fallback fired");
        return used;
    }

    function _sellAForB(uint256 amountIn) private view returns (ProveBatchExecutor.Swap memory) {
        address[] memory path = new address[](2);
        path[0] = address(tokenA);
        path[1] = address(tokenB);
        return ProveBatchExecutor.Swap({
            tokenIn: address(tokenA),
            amountIn: amountIn,
            tokenOut: address(tokenB),
            spender: address(venue),
            target: address(venue),
            data: abi.encodeCall(
                MockRouter.swapExactTokensForTokens,
                (amountIn, 0, path, address(exec), block.timestamp)
            ),
            extra: new address[](0),
            leg: type(uint256).max,
            amountOffset: type(uint256).max,
            minOutOffset: type(uint256).max,
            minOutPerIn: 0
        });
    }

    function _intent(
        address maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        uint256 nonce
    ) private view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minOutStart: minOut,
            minOutEnd: minOut,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(feeDest),
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

    function _req(ProveSettlement.Intent memory i, uint256 key, uint256 take)
        private
        view
        returns (IProveSettlementBatch.FillRequest memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return IProveSettlementBatch.FillRequest({
            intent: IProveSettlementFill.Intent({
                maker: i.maker,
                recipient: i.recipient,
                tokenIn: i.tokenIn,
                tokenOut: i.tokenOut,
                amountIn: i.amountIn,
                minOutStart: i.minOutStart,
                minOutEnd: i.minOutEnd,
                startTime: i.startTime,
                endTime: i.endTime,
                executor: i.executor,
                feeConfig: i.feeConfig,
                feeRate: i.feeRate,
                feeRateIn: i.feeRateIn,
                feeRateProceeds: i.feeRateProceeds,
                minFill: i.minFill,
                authNonce: i.authNonce,
                flags: i.flags,
                nonce: i.nonce,
                curve: i.curve
            }),
            signature: abi.encodePacked(r, s, v),
            take: take,
            arming: ""
        });
    }

    /// @dev The same shape `GasTest._row` prints, so `gen-gas.mjs` reads these lines too.
    function _row(string memory label, uint256 used) private {
        emit log_named_string(
            "", string.concat(_pad(label, 38), _pad(vm.toString(used), 9), vm.toString(used))
        );
    }

    function _pad(string memory s, uint256 width) private pure returns (string memory) {
        bytes memory b = bytes(s);
        if (b.length >= width) return string.concat(s, " ");
        bytes memory out = new bytes(width);
        for (uint256 k = 0; k < width; k++) {
            out[k] = k < b.length ? b[k] : bytes1(" ");
        }
        return string(out);
    }
}
