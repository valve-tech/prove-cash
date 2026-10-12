// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {FeeDefaults} from "../src/FeeDefaults.sol";
import {ProveReader} from "../src/ProveReader.sol";
import {ProveRelayer} from "../src/ProveRelayer.sol";
import {ProveBatchExecutor} from "../src/ProveBatchExecutor.sol";
import {ProveCallSink} from "../src/ProveCallSink.sol";
import {ProveExecutor, IProveSettlementFill} from "../src/ProveExecutor.sol";
import {RfqVenue} from "../src/RfqVenue.sol";
import {ISignatureTransfer} from "../src/interfaces/IPermit2.sol";
import {IPulseXRouter} from "../src/interfaces/IPulseXRouter.sol";
import {ANY_FEE} from "./Mocks.sol";
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
 * @notice The mainnet deploy, rehearsed on a fork of chain 369 before it is done for real.
 *
 *   PULSECHAIN_RPC=https://one.valve.city/rpc/evm/369 \
 *     FOUNDRY_PROFILE=fork forge test --match-path test/Fork369Rehearsal.t.sol -vv
 *
 * Without PULSECHAIN_RPC every test skips, so plain `forge test` stays offline.
 *
 * ## What this file asks, and what the other three do not
 *
 * `Fork.t.sol` builds fresh contracts at a pinned block and asks whether the SOURCE works against
 * real liquidity. `Live369.t.sol` attaches to the deployed addresses and asks whether the 2026-08-22
 * DEPLOYMENT works. `ForkBuyAndBurn.t.sol` asks what a stray token costs at `defaultProceeds`.
 *
 * None of them runs the deploy script. This file does. It reads `config/369.json` exactly as a real
 * run reads it, signs as the key that file names, and puts the whole set on a chain that is mainnet
 * in every respect but its permanence. The question is the one a deploy cannot take back: does the
 * committed configuration, against the chain as it stands today, produce a deployment that is wired
 * correctly and fills?
 *
 * ## Why the fork profile is not optional
 *
 * `evm_version = "paris"` on the default profile gives up PUSH0, so forge reads `0x5f` in somebody
 * else's mainnet bytecode as an undefined opcode: the frame burns every remaining unit of gas and
 * reverts with no data. A billion-gas revert here is that pin, never this file. `foundry.toml`'s
 * `fork` profile sets shanghai for exactly this reason and states the measurement behind it.
 *
 * ## Three environment keys this file deliberately never sets
 *
 * `PROVE_DEPLOYER`, `PROVE_SETTLEMENT` and `PROVE_SETTLEMENT_OFF_RECORD` are read by fixed keys
 * inside the scripts. `vm.setEnv` writes the process environment, which is not EVM state, and forge
 * runs test contracts in parallel — so a second file writing those keys races `Deploy.t.sol`, which
 * already owns all three and says so. This file therefore signs as the address `config/369.json`
 * names, and builds the two periphery contracts with `new` rather than through their scripts. The
 * guards on those scripts have their own tests; what is untested without this file is the
 * configuration, the wiring and the fill.
 *
 * The other half — a deploy broadcast for real, from a throwaway key, through all three scripts and
 * their guards — is `tools/rehearse-369.sh`, which runs against its own anvil in its own process
 * where no parallel test can be raced.
 *
 * ## Two traps inherited from the fork suites
 *
 *   1. The fork is created inside each test, not in `setUp`. A fork taken in `setUp` and then
 *      snapshotted loses the lazy account fetch a delegatecall proxy needs, and `defaultProceeds`
 *      on this chain is a proxy.
 *   2. PLSX carries governance checkpoints, so `deal` writes a balance the checkpoints do not know
 *      about and the next transfer underflows. Buy PLSX from the pool instead. WPLS is a WETH9
 *      clone and `deal` is safe there.
 *
 * The fork is taken at the head of 369, never at a pin. A pin would answer "would this deploy have
 * worked in August". The question before a deploy is whether it works now, so every price comes
 * from the pool at the moment of the test and no assertion writes a rate down.
 */
contract Fork369RehearsalTest is Test {
    // ── Mainnet, as it is ────────────────────────────────────────────────────

    uint256 constant MAINNET = 369;

    /// @dev The buy-and-burn's default rate, 0.5%, named by the owner on 2026-09-24. The deploy
    ///      below reads it from `config/369.json`; this pins the number.
    uint256 constant OWNERS_DEFAULT_RATE = 0.005e18;

    /// @dev Permit2's canonical deterministic deployment. It is not ours, we deploy nothing there,
    ///      and it is the same address on every chain that has it. `config/369.json` is where the
    ///      deploy reads it from; this constant is what the file is checked against.
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    address constant WPLS = 0xA1077a294dDE1B09bB078844df40758a5D0f9a27;
    address constant PLSX = 0x95B303987A60C71504D99Aa1b13B4DA07b0790ab;
    address constant PULSEX_V2 = 0x165C3410fC91EF562C50559f7d2289fEbed552d9;

    // ── The deployment this file makes ───────────────────────────────────────

    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot, and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;
    ProveExecutor executor;
    /// @dev The script that ran, kept so a test can read the sinks it deployed.
    Deploy deployScript;

    /// @dev An EOA solver that holds inventory. Not to be confused with `executor`, which is the
    ///      `ProveExecutor` this rehearsal deploys.
    address solver = address(0xE0E);
    /// @dev Where these intents send their fee. A scratch address, so the assertion is exact and
    ///      says nothing about `defaultProceeds`, which is asserted against the file separately.
    address feeTo = address(0xFEE);

    address maker;
    uint256 makerKey;

    string rpc;

    function setUp() public {
        rpc = vm.envOr("PULSECHAIN_RPC", string(""));
    }

    /**
     * @dev Fork mainnet and run the committed deploy on it. False when there is no RPC — and the
     *      test is marked SKIPPED, not passed.
     *
     * A skip that returned false and nothing else is how fourteen fork tests reported green while
     * asserting nothing at all, for as long as they had existed. `vm.skip` is the difference
     * between a suite honest about its coverage and one that manufactures it.
     */
    function _boot() internal returns (bool) {
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return false;
        }

        // Fork 64 blocks behind the head, not at it. On 2026-09-23 block 27,619,329 was canonical for
        // 5.6 seconds, then a one-block reorg replaced it, and a suite forked at that hash failed
        // with "block not found". Every node answered correctly: the block was gone. 64 blocks is
        // about ten minutes, inside the ~68-block gap the gateway reported between head and final.
        vm.createSelectFork(rpc);
        vm.createSelectFork(rpc, block.number - 64);
        assertEq(block.chainid, MAINNET, "the fork is chain 369, so config/369.json is what loads");

        (maker, makerKey) = makeAddrAndKey("369 rehearsal maker");

        // The deploy, exactly as `config/369.json` specifies it, signed by the key that file names.
        (settlement, executor) = _deployFromTheCommittedConfig();
        relayer = settlement.relayer();
        return true;
    }

    /**
     * @dev Run `Deploy.s.sol` as the one address `config/369.json` allows to sign.
     *
     * `vm.prank` cannot do this: forge refuses `startBroadcast` while a prank is active, and the
     * script broadcasts. Etching a forwarder at the configured signer and calling through it makes
     * `msg.sender` inside `run()` that address, which is what a real run has and what the signer
     * check reads. `Deploy.t.sol` uses the same device for the same reason.
     *
     * Nothing about the signer's key is needed, read or held here. The check is over an address.
     */
    function _deployFromTheCommittedConfig() internal returns (ProveSettlement s, ProveExecutor e) {
        string memory json = _config();
        address[] memory signers = vm.parseJsonAddressArray(json, ".deployers");
        assertEq(signers.length, 1, "mainnet names exactly one signer");
        string memory fees =
            vm.readFile(string.concat(vm.projectRoot(), "/config/fee-configs.json"));
        assertEq(
            vm.parseJsonUint(fees, ".369.history[0].rates.output"), OWNERS_DEFAULT_RATE, "0.5%"
        );

        vm.etch(signers[0], address(new RehearsalSigner()).code);
        deployScript = new Deploy();
        (s, e) = RehearsalSigner(signers[0]).deploy(deployScript);
    }

    function _config() internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/config/369.json"));
    }

    // ── The chain, before anything of ours is on it ──────────────────────────

    /**
     * @notice What mainnet has to be true about before the deploy is worth running.
     *
     * Every address in `config/369.json` is held against the chain rather than against a constant
     * typed here, so an edit to that file has to agree with what is really at those addresses. A
     * deploy is the one thing in this repository that cannot be re-run, and these are the facts it
     * rests on.
     */
    function test_MainnetMeetsThePreconditionsTheConfigAssumes() public {
        if (!_boot()) return;
        string memory json = _config();

        // Permit2 backs a whole custody rung, and the settlement refuses a zero for it. A chain
        // that turned out not to have Permit2 at the configured address would deploy perfectly
        // well and then answer `EscrowShort` for every leg on that rung for ever.
        address configured = vm.parseJsonAddress(json, ".permit2");
        assertEq(configured, PERMIT2, "the file names Permit2's canonical deployment");
        assertGt(configured.code.length, 0, "and mainnet really has code there");
        // Not a magic number: the file's own `_permit2` note claims this size, verified on chain.
        // Holding the claim against the chain is what keeps the note from rotting quietly.
        assertEq(configured.code.length, 9152, "the canonical Permit2, at the size the file claims");

        // The stray config is the one place an unattributed token can go, and the settlement is
        // constructed with it. It must be a live, valid config: the file names its destinations.
        string memory fees =
            vm.readFile(string.concat(vm.projectRoot(), "/config/fee-configs.json"));
        address[] memory strayDests =
            vm.parseJsonAddressArray(fees, ".369.strayConfig.destinations");
        assertGt(strayDests.length, 0, "a zero-length stray config stops the deploy");

        // The owner and the signer are different addresses on purpose. "It deployed and I own it"
        // cannot be evidence that the right key signed while the two are one address.
        address owner = vm.parseJsonAddress(json, ".owner");
        address[] memory signers = vm.parseJsonAddressArray(json, ".deployers");
        assertTrue(owner != address(0), "the file names an owner");
        assertEq(signers.length, 1, "one key signs mainnet");
        assertTrue(signers[0] != owner, "and it is not the owner's key");

        // The deploy costs gas and the signer pays it. A signer with an empty account is a deploy
        // that stops halfway, which is the worst place for it to stop.
        assertGt(signers[0].balance, 0, "the mainnet signer holds PLS to pay for the deploy");
    }

    // ── The deploy itself ────────────────────────────────────────────────────

    /**
     * @notice The whole set lands, and every pointer is read back off the chain.
     *
     * Four addresses come out of two `new`s: the settlement builds its own relayer, and the
     * executor builds its own call sink. The two periphery contracts follow, and both read
     * `relayer()` off the settlement in their constructors.
     *
     * A deploy script that ran can still have wired the wrong address, and nothing downstream says
     * so until a fill fails or a fee goes somewhere else. This is the check that a real deploy gets
     * only after the money is spent.
     */
    function test_TheDeployLandsAndEveryPointerReadsBack() public {
        if (!_boot()) return;
        string memory json = _config();

        // Code first. Everything below reads through these addresses, so a getter answering from
        // an empty account would make every later assertion meaningless.
        assertGt(address(settlement).code.length, 0, "settlement has code");
        assertGt(relayer.code.length, 0, "relayer has code");
        assertGt(address(executor).code.length, 0, "executor has code");
        // The TEMPLATE, which is what `sinkTemplate()` answers. It is never called and never holds
        // anything: each caller drives their own EIP-1167 clone of it, minted on their first fill.
        assertGt(address(executor.sinkTemplate()).code.length, 0, "the call sink template has code");

        // The settlement has no owner. The FeeDefaults owner is the file's, after acceptance:
        // the deploy only PROPOSES it, so the signer still owns it until the owner accepts.
        FeeDefaults fd = deployScript.feeDefaults();
        ProveReader reader = deployScript.reader();
        assertGt(address(fd).code.length, 0, "FeeDefaults has code");
        assertGt(address(reader).code.length, 0, "the reader has code");
        assertEq(
            fd.pendingOwner(), vm.parseJsonAddress(json, ".owner"), "the file's owner is proposed"
        );
        assertEq(
            address(reader.settlement()), address(settlement), "the reader reads this settlement"
        );
        assertEq(address(reader.feeDefaults()), address(fd), "and these defaults");
        {
            string memory fees =
                vm.readFile(string.concat(vm.projectRoot(), "/config/fee-configs.json"));
            FeeConfig.Config memory stray;
            stray.destinations = vm.parseJsonAddressArray(fees, ".369.strayConfig.destinations");
            stray.weights = vm.parseJsonUintArray(fees, ".369.strayConfig.weights");
            assertEq(
                settlement.STRAY_CONFIG(), FeeConfig.hash(stray), "the stray config is the file's"
            );
        }
        // Permit2 is not kept on the settlement. It is handed to the relayer, which is the only
        // contract that calls it, and this is where a wrong wiring shows as a rung nobody can use.
        assertEq(
            ProveRelayer(relayer).permit2(),
            vm.parseJsonAddress(json, ".permit2"),
            "the relayer was wired to the Permit2 the file names"
        );

        // The settlement and its relayer bind to each other in one constructor, so neither can be
        // pointed elsewhere afterwards.
        assertEq(
            ProveRelayer(relayer).settlement(), address(settlement), "the relayer answers here"
        );
        assertTrue(relayer != address(settlement), "and it is not the settlement itself");

        assertEq(address(executor.settlement()), address(settlement), "the executor fills here");
        assertEq(executor.relayer(), relayer, "one relayer, read off the settlement");
        assertEq(
            ProveCallSink(address(executor.sinkTemplate())).executor(),
            address(executor),
            "the call sink template answers only to its executor"
        );

        // The periphery. Both bind to the settlement this run deployed, which is what the record
        // check on their scripts enforces against a settlement that moved yesterday.
        RfqVenue venue = new RfqVenue(address(settlement));
        ProveBatchExecutor batch = new ProveBatchExecutor(address(settlement));

        assertEq(address(venue.settlement()), address(settlement), "the venue settles here");
        assertEq(venue.relayer(), relayer, "and pulls through the same relayer");
        assertEq(address(batch.settlement()), address(settlement), "the batch executor fills here");
        assertEq(batch.relayer(), relayer, "and pulls through the same relayer");

        // Two executors, two sinks. A sink answers to exactly one caller, so a shared one would
        // refuse whichever of the two called second.
        assertTrue(
            address(batch.sinkTemplate()) != address(executor.sinkTemplate()),
            "the two call sinks are different addresses"
        );
        assertEq(
            ProveCallSink(address(batch.sinkTemplate())).executor(),
            address(batch),
            "the batch executor's sink answers to it"
        );
    }

    // ── The real Permit2, as a custody rung ──────────────────────────────────

    /**
     * @notice A maker who has approved the real Permit2 and nothing else sells through the freshly
     *         deployed settlement.
     *
     * **The real Permit2 is the test; the mock is not.** `Arming.t.sol` runs this rung against
     * `MockPermit2`, which reproduces the digest and the nonce bitmap from Uniswap's source. That
     * proves our side of the protocol. It cannot prove that the 9,152 bytes actually at
     * `0x000000000022D473…` on chain 369 accept what we build — a different domain separator, a
     * different type hash or a different nonce rule would pass every mock test in the repository
     * and refuse every real fill.
     *
     * So every field below is built against the live contract: the domain separator is read off it,
     * and the nonce is read back out of its own bitmap afterwards.
     *
     * This rung is the one a settlement redeploy cannot orphan, which is why it belongs in a deploy
     * rehearsal above all others. Every other wallet rung rests on an ERC-20 allowance to
     * `ProveRelayer`, and the settlement's constructor just made a new one — so this very
     * deployment orphaned every approval-rung maker on mainnet, and left this rung untouched.
     */
    function test_TheRealPermit2FundsAFillOnTheFreshDeployment() public {
        if (!_boot()) return;

        uint256 amountIn = 1_000_000e18;
        _buyFor(solver, PLSX, 5_000_000e18);
        vm.prank(solver);
        IERC20(PLSX).approve(relayer, type(uint256).max);

        // WPLS is a WETH9 clone: no checkpoints, so writing the balance slot is safe.
        deal(WPLS, maker, amountIn);

        /*
         * The maker's only standing grant, ever, and it names nothing of ours.
         *
         * Permit2 is at one address on every chain and moves for nobody, so this approval outlives
         * every settlement we will ever deploy. The assertions below check the other half of that
         * claim: the maker grants the relayer nothing at any point.
         */
        vm.prank(maker);
        IERC20(WPLS).approve(PERMIT2, type(uint256).max);

        /*
         * A floor under the live pool, read after the solver stocked up.
         *
         * `_intent` floors at one wei, which is enough for a rung test and wrong here: the fee is
         * a fraction of what is delivered, so a one-wei delivery makes a 0.1% fee round to zero
         * and the rung would look fee-free rather than cheap. Measured — the first run of this
         * test failed on exactly that. A real rate also makes the fill one a maker would sign.
         */
        ProveSettlement.Intent memory i = _intent(amountIn, settlement.FLAG_PERMIT2());
        {
            uint256 floor = (_market(WPLS, PLSX, amountIn) * 90) / 100;
            i.minOutStart = floor;
            i.minOutEnd = floor;
        }

        // The intent names no nonce of its own, so the settlement expects its hash — which welds
        // this Permit2 signature to this offer and to nothing else the maker ever signs.
        uint256 nonce = uint256(settlement.hashIntent(i));

        assertEq(
            ISignatureTransfer(PERMIT2).nonceBitmap(maker, nonce >> 8) & (1 << (nonce & 0xff)),
            0,
            "the nonce is unspent before the fill"
        );

        (uint256 delivered, uint256 fee) = _quote(i, amountIn);
        assertGt(fee, 0, "there is a fee to book");

        /*
         * Both are computed into locals here: after the quote above, and before the prank.
         *
         * **Before the prank**, because `vm.prank` is single-shot and an external call inside the
         * pranked line eats it. `_sign` calls `hashIntent`, and `_permit2Transfer` calls Permit2's
         * `DOMAIN_SEPARATOR`, so building either inside the `fillWithPermit2(...)` argument list
         * sends the fill from this test contract rather than from the solver. This contract holds
         * no PLSX, so the maker's payment fails as `ERC20: transfer amount exceeds balance`.
         * Measured — that is exactly what inlining them did.
         *
         * **After the quote**, because `forge coverage` compiles with `--ir-minimum` and the
         * unoptimised frame runs out of stack at that call. Scoping `floor` and folding the intent
         * hash into `nonce` freed three slots and the frame was still one over, so the quote now
         * happens in `_quoteDelivered`, where the stack is nearly empty. Measured both ways.
         */
        bytes memory sig = _sign(i);
        ProveSettlement.Permit2Transfer memory p =
            _permit2Transfer(WPLS, amountIn, nonce, block.timestamp + 1 days);

        vm.prank(solver);
        settlement.fillWithPermit2(i, sig, amountIn, p, ANY_FEE);

        assertEq(IERC20(PLSX).balanceOf(maker), delivered, "the maker got the rate they signed");
        assertEq(IERC20(WPLS).balanceOf(maker), 0, "and parted with what they sold");
        assertEq(IERC20(WPLS).balanceOf(solver), amountIn, "the solver got token A");
        assertEq(IERC20(WPLS).allowance(maker, relayer), 0, "the maker granted the relayer nothing");

        // Read out of the live contract's own bitmap. A single-use nonce that was not spent would
        // mean the transfer came from somewhere other than the signature we built.
        assertTrue(
            ISignatureTransfer(PERMIT2).nonceBitmap(maker, nonce >> 8) & (1 << (nonce & 0xff)) != 0,
            "the real Permit2 spent the maker's nonce"
        );

        // The fee is booked rather than pushed, and anybody may spend the gas to claim it out.
        // This is the new fee semantics, and the deployed mainnet settlement predates it.
        assertEq(
            settlement.pendingFees(feeCfg(feeTo), PLSX),
            fee,
            "the fee was booked to the intent's feeTo"
        );
        assertEq(claimFor(settlement, feeTo, PLSX), fee, "and it claims out");
        assertEq(IERC20(PLSX).balanceOf(feeTo), fee, "to the destination, in full");
    }

    // ── A fill, end to end, through the deployed executor ────────────────────

    /**
     * @notice The whole product in one transaction, on the set this rehearsal just deployed: a
     *         maker signs, a caller holding nothing fills out of a real PulseX swap, the maker gets
     *         at least the rate they signed, and the fee reaches the address the intent named.
     *
     * It is also the only check that the executor's private copy of the `Intent` struct still
     * matches the settlement's. The two are never compared by the compiler; a drifted field deploys
     * happily and reverts on every call, and only a fill through the deployed pair says so. That
     * drift is live on mainnet right now — `hashIntent` has moved twice since the 2026-08-22 set —
     * so this is the assertion that says the new pair agrees with itself.
     */
    function test_AFillSettlesEndToEndThroughTheDeployedExecutor() public {
        if (!_boot()) return;

        uint256 amountIn = 1_000_000e18;
        // Ask for 90% of the live market rate; the rest is the caller's spread.
        uint256 floor = (_market(WPLS, PLSX, amountIn) * 90) / 100;
        assertGt(floor, 0, "the pool prices this pair right now");

        deal(WPLS, maker, amountIn);
        vm.prank(maker);
        IERC20(WPLS).approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent(amountIn, 1);
        i.minOutStart = floor;
        i.minOutEnd = floor;
        bytes memory sig = _sign(i);
        TakePoints.Quote memory q_fee = settlement.quote(i, amountIn, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;

        /*
         * The router pays the executor, and the sink under test is this caller's own clone.
         *
         * `executor.sinkTemplate()` is the TEMPLATE. It is never called and never holds anything: every
         * venue call runs from an EIP-1167 clone of it, one per caller, minted on that caller's
         * first fill at an address salted with the caller's own. Aiming the swap at the template
         * pays an address that never sweeps, and the fill then reverts inside the token for the
         * shortfall. That is measured rather than reasoned: the first run of this test failed
         * exactly so, with `ERC20: transfer amount exceeds balance`.
         *
         * Paying the executor directly is a shape the source names, and it saves one ERC-20
         * transfer — the proceeds arrive under the same mark and the executor sweeps its own
         * increase. The clone is still minted, because every fill mints it, so the assertion
         * below that it kept nothing is a real claim about a real address.
         */
        address sink = Clones.predictDeterministicAddress(
            address(executor.sinkTemplate()),
            bytes32(uint256(uint160(address(this)))),
            address(executor)
        );
        assertEq(IERC20(PLSX).balanceOf(address(this)), 0, "the caller starts with no PLSX");

        executor.fill(_asExec(i), sig, amountIn, ANY_FEE, _pulseXSwap(amountIn, address(executor)));

        assertEq(IERC20(PLSX).balanceOf(maker), delivered, "the maker was paid from the pool");
        /*
         * The maker signs a GROSS number and receives it less the fee.
         *
         * `floor` is what they signed; `delivered` is what lands in their wallet. The first run of
         * this test asserted `delivered >= floor` and failed by exactly the fee — which is the
         * rule working, not a shortfall. The filler pays the gross whatever the rate is, so the
         * rate moves money from the maker to the fee destination and changes nothing else.
         */
        assertEq(delivered + fee, floor, "the maker signed a gross and got it less the fee");
        assertEq(
            settlement.pendingFees(feeCfg(feeTo), PLSX), fee, "the fee reached the intent's feeTo"
        );
        assertGt(IERC20(PLSX).balanceOf(address(this)), 0, "the spread went to the caller");

        // Neither address holds anything between transactions, and that is load-bearing: a balance
        // resting on either one is a standing claim for whoever calls next.
        assertEq(IERC20(PLSX).balanceOf(address(executor)), 0, "the executor kept nothing");
        assertEq(IERC20(WPLS).balanceOf(address(executor)), 0, "and nothing of token A either");
        assertEq(IERC20(PLSX).balanceOf(sink), 0, "the call sink kept nothing");
        assertEq(IERC20(WPLS).balanceOf(sink), 0, "and nothing of token A either");
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    /// @dev Buy a token with real liquidity, the way a solver stocks up. PLSX cannot be `deal`t:
    ///      it keeps governance checkpoints that a written balance slot leaves behind.
    function _buyFor(address to, address token, uint256 wplsIn) internal {
        deal(WPLS, address(this), wplsIn);
        IERC20(WPLS).approve(PULSEX_V2, wplsIn);
        address[] memory path = new address[](2);
        path[0] = WPLS;
        path[1] = token;
        IPulseXRouter(PULSEX_V2).swapExactTokensForTokens(wplsIn, 0, path, to, block.timestamp);
    }

    /// @dev What the pool pays for `amountIn` of `from` right now. Nothing here writes a rate down.
    function _market(address from, address to, uint256 amountIn) internal view returns (uint256) {
        address[] memory path = new address[](2);
        path[0] = from;
        path[1] = to;
        return IPulseXRouter(PULSEX_V2).getAmountsOut(amountIn, path)[1];
    }

    /**
     * @dev What the settlement says the maker receives, and what it books as the fee.
     *
     * The call lives in its own frame on purpose. `forge coverage` compiles with `--ir-minimum`,
     * and in the Permit2 test the unoptimised frame ran out of stack at this call — "too deep in
     * the stack by 1 slots". Scoping locals at the call site freed three slots and it was still one
     * over. Here almost nothing else is live, so the call fits. The caller still holds both values
     * afterwards, as it always did; it is the call that could not afford the company.
     */
    function _quote(ProveSettlement.Intent memory i, uint256 take)
        internal
        view
        returns (uint256 delivered, uint256 fee)
    {
        TakePoints.Quote memory q_3 = settlement.quote(i, take, block.timestamp);
        delivered = q_3.delivered;
        fee = q_3.feeProceeds;
    }

    function _intent(uint256 amountIn, uint8 flags)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: WPLS,
            tokenOut: PLSX,
            amountIn: amountIn,
            // Floored a long way under the pool, so the rung under test is the only thing that can
            // refuse the fill. The end-to-end test replaces this with the live rate.
            minOutStart: 1,
            minOutEnd: 1,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(feeTo),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0.001e18,
            minFill: 0,
            authNonce: bytes32(0),
            flags: flags,
            nonce: 1,
            curve: bytes32(0)
        });
    }

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /**
     * @dev One Permit2 SignatureTransfer of the maker's, signed for the relayer as spender and
     *      against the live contract's own domain.
     *
     * Two things here are unlike every other EIP-712 digest in this repository, and both are
     * load-bearing. Permit2's domain carries **no version string**. And the spender is **not a
     * field of the permit** — Permit2 hashes `msg.sender` in, so this signature names the relayer
     * because the relayer is the only address that will ever present it.
     *
     * The type hashes are computed here rather than read off the chain, because the deployed
     * Permit2 keeps both private. They are the strings from Uniswap's `SignatureTransfer.sol`. If
     * either were wrong, the live contract would refuse the signature and this test would fail —
     * which is the point of building the digest against a real deployment rather than a mock.
     */
    function _permit2Transfer(address token, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        view
        returns (ProveSettlement.Permit2Transfer memory p)
    {
        p.token = token;
        p.amount = amount;
        p.nonce = nonce;
        p.deadline = deadline;

        bytes32 tokenPermissions = keccak256(
            abi.encode(keccak256("TokenPermissions(address token,uint256 amount)"), token, amount)
        );
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                ISignatureTransfer(PERMIT2).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256(
                            "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
                        ),
                        tokenPermissions,
                        relayer,
                        nonce,
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, digest);
        p.signature = abi.encodePacked(r, s, v);
    }

    /// @dev Sell the released WPLS for PLSX at PulseX, paid to `to`. The caller writes this blob
    ///      off chain; `sdk/src/solver/abi.ts` builds the same bytes for the bot.
    function _pulseXSwap(uint256 amountIn, address to)
        internal
        view
        returns (ProveExecutor.Swap memory)
    {
        address[] memory path = new address[](2);
        path[0] = WPLS;
        path[1] = PLSX;
        return ProveExecutor.Swap({
            spender: PULSEX_V2,
            target: PULSEX_V2,
            data: abi.encodeCall(
                IPulseXRouter.swapExactTokensForTokens, (amountIn, 0, path, to, block.timestamp)
            ),
            extra: new address[](0)
        });
    }

    /// @dev The executor's copy of the struct. The two must stay field-for-field, and a fill
    ///      through the deployed pair is what proves they still are.
    function _asExec(ProveSettlement.Intent memory i)
        internal
        pure
        returns (IProveSettlementFill.Intent memory o)
    {
        o = IProveSettlementFill.Intent({
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
        });
    }
}

/**
 * @notice Calls the deploy script from the address `config/369.json` names, the way forge does.
 *
 * `vm.prank` cannot stand in for this: forge refuses `startBroadcast` while a prank is active, and
 * the script broadcasts. A test etches this contract's code at the configured signer and calls
 * through it, so `msg.sender` inside `run()` is that address — which is what the signer check
 * reads, and all it ever reads. No key is involved at any point.
 */
contract RehearsalSigner {
    function deploy(Deploy script) external returns (ProveSettlement, ProveExecutor) {
        return script.run();
    }
}
