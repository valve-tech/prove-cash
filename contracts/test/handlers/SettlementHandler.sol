// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION,
    availableOf
} from "../Fees.sol";
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../../src/ProveSettlement.sol";
import {ProveRelayer} from "../../src/ProveRelayer.sol";
import {
    ANY_FEE,
    MockERC20,
    MockERC3009,
    MockERC7598Wallet,
    MockPermit2,
    PayingExecutor,
    SmartWallet
} from "../Mocks.sol";
import {MockERC2612} from "../Permit.t.sol";
import {TaxedERC3009} from "../Arming.t.sol";
import {FeeGhost} from "./FeeGhost.sol";

/**
 * @notice The three things an EIP-3009 token is asked, in one shape.
 *
 * A legacy-only token and an ERC-7598 one answer all three identically — the domain, the
 * typehash and the nonce ledger. They differ only in which `receiveWithAuthorization` overload
 * they carry, and that difference belongs to the settlement rather than to a caller building a
 * digest. So the handler reaches both through this and neither through its own type.
 */
interface IAuthToken {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function RECEIVE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function authorizationState(address maker, bytes32 nonce) external view returns (bool);
}

/// @notice Every token here mints on demand, and no two of them share a type.
interface IMintable {
    function mint(address to, uint256 amount) external;
}

/**
 * @notice Drives ProveSettlement the way a live board would: several makers, several executors,
 *         a mix of custody modes and price shapes, legs a batch has to arm from a signature it
 *         carries, and time that moves. The fuzzer picks the order and the amounts; this
 *         contract only keeps the books that the invariants check.
 *
 * Every action bounds its own inputs, so a run spends its depth on real state transitions
 * instead of on calls that revert before touching anything.
 *
 * **The arming half of this file is as much about the bytes that fail as the ones that work.**
 * A leg that cannot be armed has to leave nothing behind — no spent nonce, no moved tokens, no
 * reservation — and a campaign that only ever walked the happy path would say nothing about the
 * frame that guarantees it. So the shapes below include a permit against a nonce the token has
 * passed, a window that has not opened, a window that has closed, an authorization naming
 * somebody else's nonce, a token that keeps a cut of what it moves, and signatures either side
 * of sixty-five bytes.
 */
contract SettlementHandler is Test, FeeGhost {
    ProveSettlement public immutable settlement;
    MockERC20 public immutable tokenA;
    MockERC20 public immutable tokenB;

    uint256 constant MAKERS = 3;
    uint256 constant INTENTS = 6;

    address[MAKERS] public makers;
    uint256[MAKERS] private makerKeys;

    /// @dev Private, not public. A public array of structs makes solc write a getter returning
    ///      every field of one, and `Intent` is now wide enough that the encoder for that getter
    ///      runs the legacy pipeline out of stack under `forge coverage --ir-minimum`. Nothing
    ///      reads it from outside.
    ProveSettlement.Intent[] private intents;
    bytes[] public signatures;

    address[2] public executors = [address(0xE1), address(0xE2)];

    /// @notice The destinations the intents name for their own share of the fee. Two of them,
    ///         because a batch coalesces a run of legs that name one and breaks on a leg that
    ///         names another.
    address[2] public feeTos = [address(0xF1), address(0xF2)];

    /// @notice Every sink a fill can book to: the two named ones, then the default sink.
    function sinkAt(uint256 f) external view returns (address) {
        return f < 2 ? feeTos[f] : ghostDefaultSink;
    }

    /// @dev Where the settlement sends a token no reservation claims. No fill pays it, and the
    ///      invariants assert its balance stays where the sweeps left it.
    address public immutable defaultProceeds;
    PayingExecutor public bot;

    /// @dev The owner, read once. `vm.prank` is single-shot and a call would eat it.

    /// @dev The address everyone approves, read once, for the same reason.
    address private immutable relayerAddr;

    // ── The arming cast ──────────────────────────────────────────────────────

    /**
     * @notice The four input tokens a leg can be armed against, and why there are four.
     *
     * `tokenA` cannot be armed at all: it is a plain ERC-20 with neither `permit` nor
     * `receiveWithAuthorization`, and the makers who sell it granted the relayer an allowance
     * themselves. These four are the ones a signature has to reach.
     *
     * **`wideIn` is not a fifth rung.** ERC-7598 is the gasless rung with a different signature
     * encoding, so it is a second token on the same rung rather than a case bolted to the side.
     * `legacyIn` carries only the `v, r, s` overload and `wideIn` carries both, the handler picks
     * between them, and every gasless property below runs against each. If one holds for one
     * token and not the other, that is a finding rather than a shape to paper over.
     *
     * `taxedIn` is the griefing bait: the redemption succeeds and credits the escrow with less
     * than `amountIn`, so whether the leg arms turns on how much the fill asked for. It costs a
     * maker one signature and no gas to post, which is the whole reason `_arm` runs inside a
     * frame it can revert.
     */
    MockERC2612 public immutable permitIn;
    MockERC3009 public immutable legacyIn;
    MockERC7598Wallet public immutable wideIn;
    TaxedERC3009 public immutable taxedIn;
    /**
     * @notice The fifth rung's token, and it is a plain ERC-20 on purpose.
     *
     * Permit2 asks nothing of the token — no `permit`, no `receiveWithAuthorization`, no domain
     * of its own — which is the reason the rung exists at all: it reaches makers holding assets
     * that can do neither of the gasless standards. A token with a `permit` here would hide that.
     *
     * The maker approves `permit2` for it, once, in the constructor, and never approves the
     * relayer for anything. That single grant is what a settlement redeploy cannot orphan.
     */
    MockERC20 public immutable permit2In;

    /// @notice The Permit2 the settlement was deployed against, read back off the relayer rather
    ///         than handed in — so this campaign runs against whatever the deployment really
    ///         wired up, and a mis-wiring shows as a rung that never arms.
    MockPermit2 public immutable permit2;

    /// @dev Where a fee-on-transfer token puts the cut it keeps. `TaxedERC3009` sends it here
    ///      rather than burning it, so the conservation invariant has somewhere to count it.
    address public constant TAX_COLLECTOR = address(0xdead);
    /// @dev Where a burned permit nonce sends its allowance. Nothing here ever spends it.
    address private constant NOWHERE = address(0xDEAD00);

    /**
     * @notice One maker per way of holding a key, so a failure names the shape that produced it.
     *
     * `permitMaker` and `keyMaker` are ordinary accounts. `walletMaker` is a contract with no key
     * at all: it signs the intent through ERC-1271 and the authorization that funds it through
     * ERC-7598, and its 65-byte answer is what makes `_receive` try the legacy overload, fail,
     * and fall through. That fall-through is the easiest branch in the change to leave uncovered.
     *
     * None of the three grants a standing allowance. Reaching their funds is what arming is for.
     */
    address public permitMaker;
    uint256 private permitKey;
    address public keyMaker;
    uint256 private keyMakerKey;
    address public permit2Maker;
    uint256 private permit2Key;
    SmartWallet public walletMaker;
    /// @dev The key the wallet answers for. It is not the wallet's address and never signs as it.
    uint256 private walletKey;

    /// @dev Which rung an armed leg sits on. `RUNG_7598_KEY` and `RUNG_7598_WALLET` are one
    ///      token reached two ways, which is the difference ERC-7598 actually makes.
    uint8 internal constant RUNG_PERMIT = 0;
    uint8 internal constant RUNG_LEGACY = 1;
    uint8 internal constant RUNG_7598_KEY = 2;
    uint8 internal constant RUNG_7598_WALLET = 3;
    uint8 internal constant RUNG_TAXED = 4;
    /// @dev The rung that outlives a redeploy. Its maker approved Permit2 and nothing else, so
    ///      `_evaluate`'s allowance probe would refuse them for ever — see `FLAGS_CUSTODIED`.
    uint8 internal constant RUNG_PERMIT2 = 5;
    uint8 internal constant RUNGS = 6;

    /**
     * @dev What the arming bytes are made to look like.
     *
     * Five of the seven cannot arm the leg they are attached to, and those are the ones that
     * matter: without bytes that fail, the campaign only ever walks the happy path and proves
     * nothing about the `try`/`catch` frame the whole design rests on. The last two are widths
     * rather than faults — a compact signature arms a contract wallet perfectly well and no
     * other rung at all, which is the sort of thing only running both tokens can say.
     *
     * A shape that means nothing on the rung it lands on produces a sound leg. `SHAPE_GOOD` is
     * therefore commoner than one in seven, which costs nothing: the refusal counters say how
     * often each shape really was tried.
     */
    uint8 internal constant SHAPE_GOOD = 0;
    uint8 internal constant SHAPE_STALE_PERMIT_NONCE = 1;
    uint8 internal constant SHAPE_WINDOW_NOT_OPEN = 2;
    uint8 internal constant SHAPE_WINDOW_CLOSED = 3;
    uint8 internal constant SHAPE_WRONG_AUTH_NONCE = 4;
    uint8 internal constant SHAPE_COMPACT_SIGNATURE = 5;
    uint8 internal constant SHAPE_LONG_SIGNATURE = 6;
    uint8 internal constant SHAPES = 7;

    /// @dev What every armed intent sells. One size, so a sibling can share an authorization —
    ///      exclusion only holds between offers of the same `amountIn`, because the maker's 3009
    ///      signature commits to the value.
    uint256 internal constant ARM_SIZE = 1_000e18;

    /**
     * @dev How many armed intents one run may create.
     *
     * Every invariant that walks these walks all of them, so the cap is a runtime bound and not
     * a modelling choice. It is a stored hash and two storage reads a leg, never a re-hashed
     * intent, which is what makes sixty-four affordable — at thirty-two a chain of 256 spent its
     * second half bouncing off the cap, and `armTwins` takes two slots at a time.
     */
    uint256 internal constant ARMED_CAP = 64;

    /// @dev Private, for the reason `intents` is private: a public array of structs makes solc
    ///      write a getter returning every field of one, and the encoder for that getter runs the
    ///      legacy pipeline out of stack under `forge coverage --ir-minimum`.
    ProveSettlement.Intent[] private armedIntents;
    bytes[] private armedSigs;
    /// @dev The flat mirrors the invariants read. Stored rather than recomputed: `hashIntent` is
    ///      twelve words of keccak and these are walked after every call of every chain.
    bytes32[] private armedHashes;
    address[] private armedTokens;
    address[] private armedMakers;
    /**
     * @dev The one 3009 nonce this intent can ever spend, or zero on a permit leg.
     *
     * Written once, when the intent is signed, and never from the bytes a caller actually
     * presented. `_redeemInto` demands `i.authNonce == 0 ? h : i.authNonce` and refuses anything
     * else before the token hears about it, so this is the only nonce the leg could burn however
     * the arming was spoiled.
     */
    bytes32[] private armedNonces;
    uint8[] private armedRungs;

    /// @dev The pairs of offers that share one authorization. Only one of each may ever fill.
    uint256[2][] private twins;

    // ── Ghost books ──────────────────────────────────────────────────────────

    /// @notice Every token A the makers have parted with, by whatever custody route.
    uint256 public ghostTokenAReleased;
    /// @notice Every token B the makers have received.
    uint256 public ghostTokenBReceived;
    /// @notice The minimum token B those fills owed the makers, at the moment each one settled —
    ///         the curve less the fee the intent carves out of it.
    uint256 public ghostTokenBOwed;
    /// @notice The curve's own number for those fills, before the split. This is what the
    ///         executors parted with, and no rate may move it.
    uint256 public ghostTokenBGross;
    /// @notice Escrow the contract has been told to hold, less what it has paid out.
    uint256 public ghostEscrowNet;

    /// @notice Every wei of token A that has left a maker through a fill.
    uint256 public ghostTakes;

    uint256 public callsFill;
    uint256 public callsBatch;
    uint256 public callsDeposit;
    uint256 public callsWithdraw;
    uint256 public callsCancel;
    uint256 public callsCallback;
    uint256 public callsSign;
    uint256 public callsDust;
    uint256 public callsClaim;

    // ── The arming books ─────────────────────────────────────────────────────

    /// @notice The minimum token B the armed fills owed their makers, at the moment each one
    ///         settled. Worked out from the signed terms, never from a quote.
    uint256 public ghostArmedOwed;

    /**
     * @notice Fills that landed under the intent's floor with the intent still open. It has to
     *         stay zero: that is the rule `BelowMinFill` defends.
     */
    uint256 public ghostFillsUnderTheFloor;
    /// @notice Fills that landed under the floor and closed the intent out. A receipt, not a
    ///         fault — it is the escape hatch that stops a floor stranding dust, and a run where
    ///         it stays zero has not tested the hatch at all.
    uint256 public ghostClosingFillsUnderTheFloor;

    /// @notice Dry runs that left the chain somewhere other than where they found it. Zero.
    uint256 public ghostDryRunsThatMovedSomething;
    /// @notice Dry runs that returned instead of reverting. Zero: always reverting is the
    ///         feature, and a variant that returned would need access control this one does not.
    uint256 public ghostDryRunsThatReturned;

    /// @notice Dead reservations moved to their maker's parked row, fills armed out of one of
    ///         those rows, and rows a maker took home. All three are receipts: an invariant over
    ///         a book nothing ever credits is a green statement about nothing.
    uint256 public callsPark;
    uint256 public callsParkedFill;
    uint256 public callsUnpark;

    uint256 public callsArm;
    uint256 public callsArmRefused;
    uint256 public callsArmAgain;
    uint256 public callsTwins;
    uint256 public callsDryRun;
    /// @notice Dry runs where the armed leg came back `Ok`, which is the only kind that proves
    ///         anything: the walk really did spend a nonce and move tokens before it unwound.
    uint256 public callsDryRunThatArmed;

    /**
     * @notice Armed legs a draw from their maker's parked capital paid for.
     *
     * `invariant_AnAuthorizationNonceIsSpentOnlyByALegThatFilled` reads it. A leg funded this way
     * filled without redeeming anything, so its token nonce is honestly unspent — that is the
     * fourth source working, not a signature gone missing. Written only when the maker's row
     * actually fell across the call, so a leg that settled out of a leftover reservation is
     * still held to the redemption that put it there.
     */
    mapping(uint256 => bool) public armedFundedFromParked;

    /// @notice Armed legs that settled, by rung, and legs that could not be armed, by shape.
    ///         Both are receipts: an invariant over a rung nothing reached is a green statement
    ///         about nothing.
    mapping(uint8 => uint256) public armFillsByRung;
    mapping(uint8 => uint256) public armRefusalsByShape;

    constructor(ProveSettlement _settlement, MockERC20 _tokenA, MockERC20 _tokenB) {
        settlement = _settlement;
        tokenA = _tokenA;
        tokenB = _tokenB;
        defaultProceeds = STRAY_DESTINATION;
        bot = new PayingExecutor();
        _tokenB.mint(address(bot), 1_000_000_000e18);
        // The relayer pulls what a callback fill owes, so the bot stands good for it up front.
        bot.approveMax(address(_tokenB), _settlement.relayer());

        // Read once. `vm.prank` is single-shot, so a `settlement.relayer()` call inside the
        // pranked line would eat the prank and the approval would come from this contract.
        address relayer = settlement.relayer();
        relayerAddr = relayer;

        // Deployed here rather than handed in. Nothing outside this file has an opinion about
        // them, and an immutable has to be written in the constructor's own frame.
        permitIn = new MockERC2612();
        legacyIn = new MockERC3009();
        wideIn = new MockERC7598Wallet();
        taxedIn = new TaxedERC3009();
        permit2In = new MockERC20("Permit2 In", "P2IN", 18);
        permit2 = MockPermit2(ProveRelayer(relayer).permit2());
        _castTheArmingMakers();

        // The permit2 maker's one and only grant, and it names an address this repository does
        // not control and cannot move. Every other armed maker below grants nothing at all and
        // is reached by a signature; this one grants exactly this and is reached by a signature
        // too. Nothing here ever approves the relayer for `permit2In`, and the invariants say so.
        vm.prank(permit2Maker);
        permit2In.approve(address(permit2), type(uint256).max);

        for (uint256 m = 0; m < MAKERS; m++) {
            (address who, uint256 key) = makeAddrAndKey(string.concat("maker", vm.toString(m)));
            makers[m] = who;
            makerKeys[m] = key;
            tokenA.mint(who, 100_000_000e18);
            vm.prank(who);
            tokenA.approve(relayer, type(uint256).max);
        }

        for (uint256 e = 0; e < executors.length; e++) {
            tokenB.mint(executors[e], 1_000_000_000e18);
            vm.prank(executors[e]);
            tokenB.approve(relayer, type(uint256).max);
        }

        // A spread of shapes: partial and all-or-nothing, flat and decaying, wallet and escrow,
        // and — because the split is what the fee invariants watch — some that name a
        // destination of their own and some that name nowhere.
        for (uint256 k = 0; k < INTENTS; k++) {
            ProveSettlement.Intent memory i = _startingIntent(k);
            intents.push(i);

            (uint8 v, bytes32 r, bytes32 s) =
                vm.sign(makerKeys[k % MAKERS], settlement.hashIntent(i));
            signatures.push(abi.encodePacked(r, s, v));
        }
    }

    /**
     * @dev One of the intents the run starts with.
     *
     * The terms live here, and not in the constructor's loop, so that the coverage build
     * compiles. Hold the whole literal and the signing in one frame and the unoptimised IR runs
     * a slot past the deepest word the stack can reach.
     */
    function _startingIntent(uint256 k) private view returns (ProveSettlement.Intent memory) {
        address maker = makers[k % MAKERS];
        bool escrow = k % 3 == 2;
        uint256 amountIn = (k + 1) * 1_000e18;
        uint256 minOut = (k + 1) * 30e18;

        return ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: amountIn,
            minOutStart: minOut,
            minOutEnd: k % 4 == 1 ? minOut / 2 : minOut,
            startTime: uint64(block.timestamp),
            // Two lengths, so the campaign carries both a short offer and a resting one. The
            // settlement bounds neither; this is variety, not compliance.
            endTime: uint64(block.timestamp + (escrow ? 30 days : 1 hours)),
            executor: address(0),
            feeConfig: feeCfg(k % 3 == 0 ? address(0) : feeTos[k % 2]),
            // A zero `feeTo` signs a zero rate and pays no fee (OW-2, 2026-10-01).
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: k % 3 == 0 ? 0 : _rateFor(k),
            minFill: 0,
            authNonce: bytes32(0),
            flags: (k % 2 == 0 ? settlement.FLAG_PARTIAL() : 0)
                | (escrow ? settlement.FLAG_ESCROW() : 0),
            nonce: 1_000 + k,
            curve: bytes32(0)
        });
    }

    /**
     * @dev The rate one starting intent asks for.
     *
     * A ladder spanning zero, small, large, and the widest rate this handler quotes. Intent 4
     * takes the top rung, and it is a wallet-custody partial intent so one call can reach it.
     * Nothing on chain caps any of them; the fills that carry the top rung are the ones that
     * prove a caller's own `maxFeeRate` is the whole of what bounds a fee.
     */
    function _rateFor(uint256 k) private pure returns (uint64) {
        if (k == 4) return uint64(GHOST_MAX_FEE_RATE);
        if (k % 4 == 3) return 0.0025e18;
        if (k % 4 == 2) return 0.0005e18;
        return 0;
    }

    function intentCount() external view returns (uint256) {
        return intents.length;
    }

    function intentAt(uint256 k) external view returns (ProveSettlement.Intent memory) {
        return intents[k];
    }

    // ── Actions ──────────────────────────────────────────────────────────────

    function fillSome(uint256 which, uint256 takeSeed, uint256 whoSeed) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];
        address executor = executors[whoSeed % executors.length];

        (uint256 remaining, bool live) = availableOf(settlement, i);
        if (!live) return;

        uint256 take =
            i.flags & settlement.FLAG_PARTIAL() != 0 ? bound(takeSeed, 1, remaining) : remaining;
        if (i.flags & settlement.FLAG_ESCROW() != 0) {
            if (settlement.reserved(settlement.hashIntent(i)) < take) return;
        }

        uint256 delivered = settlement.quote(i, take, block.timestamp).delivered;

        vm.prank(executor);
        try settlement.fill(i, signatures[k], take, ANY_FEE) {
            callsFill++;
            _bookFill(i, take, delivered);
        } catch {}
    }

    /**
     * @notice Fill exactly one wei of an intent.
     *
     * The one-wei fill is the corner the split rounds in: the fee is a single wei, and the share
     * has to round the protocol's line up rather than away. A uniform draw over the remainder
     * reaches a take of one about never, so this action asks for it by name.
     */
    function fillDust(uint256 which, uint256 whoSeed) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];
        if (i.flags & settlement.FLAG_PARTIAL() == 0) return;

        (, bool live) = availableOf(settlement, i);
        if (!live) return;
        if (i.flags & settlement.FLAG_ESCROW() != 0) {
            if (settlement.reserved(settlement.hashIntent(i)) == 0) return;
        }

        uint256 delivered = settlement.quote(i, 1, block.timestamp).delivered;

        vm.prank(executors[whoSeed % executors.length]);
        try settlement.fill(i, signatures[k], 1, ANY_FEE) {
            callsDust++;
            _bookFill(i, 1, delivered);
        } catch {}
    }

    function fillBatchSome(uint256 which, uint256 takeSeed, uint256 whoSeed) external {
        uint256 first = which % intents.length;
        address executor = executors[whoSeed % executors.length];

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        uint256[2] memory takes;
        uint256[2] memory delivereds;

        for (uint256 n = 0; n < 2; n++) {
            uint256 k = (first + n) % intents.length;
            ProveSettlement.Intent memory i = intents[k];
            (uint256 remaining, bool live) = availableOf(settlement, i);
            uint256 take = !live
                ? 0
                : (i.flags & settlement.FLAG_PARTIAL() != 0
                        ? bound(takeSeed + n, 1, remaining)
                        : remaining);
            takes[n] = take;
            if (take > 0) delivereds[n] = settlement.quote(i, take, block.timestamp).delivered;
            reqs[n] = ProveSettlement.FillRequest({
                intent: i, signature: signatures[k], take: take, arming: ""
            });
        }

        uint256[2] memory beforeFilled;
        for (uint256 n = 0; n < 2; n++) {
            beforeFilled[n] = settlement.filled(settlement.hashIntent(reqs[n].intent));
        }

        vm.prank(executor);
        try settlement.fillBatch(reqs, true, ANY_FEE) {
            callsBatch++;
            for (uint256 n = 0; n < 2; n++) {
                bytes32 h = settlement.hashIntent(reqs[n].intent);
                uint256 done = settlement.filled(h) - beforeFilled[n];
                if (done > 0) _bookFill(reqs[n].intent, done, delivereds[n]);
            }
        } catch {}
    }

    /// @dev Funds the reservation behind one of the escrow-mode intents.
    function depositEscrow(uint256 which, uint256 amount) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];
        if (i.flags & settlement.FLAG_ESCROW() == 0) return;

        uint256 value = bound(amount, 1, 1_000_000e18);
        if (tokenA.balanceOf(i.maker) < value) return;

        vm.prank(i.maker);
        try settlement.deposit(i, value) {
            callsDeposit++;
            ghostEscrowNet += value;
        } catch {}
    }

    function withdrawEscrow(uint256 which) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];
        bytes32 h = settlement.hashIntent(i);
        uint256 before = settlement.reserved(h);

        vm.prank(i.maker);
        try settlement.withdraw(i) {
            callsWithdraw++;
            ghostEscrowNet -= before - settlement.reserved(h);
        } catch {}
    }

    /**
     * @notice A destination empties its book, mid-run, at a moment the fuzzer picks.
     *
     * A fee is booked now rather than transferred, so without this action every fee the run
     * charges sits in one place for ever and the invariant only ever witnesses a book that
     * grows. This is what makes it witness one that also falls — and it runs the reentrancy
     * guard and the zero-book early return alongside every fill, deposit and withdrawal the
     * fuzzer can interleave.
     *
     * Called by nobody in particular. `claim` pays the address in the key whoever asks, which is
     * the property, so the handler asks as itself and the money still goes to the destination.
     */
    function claimFees(uint256 which) external {
        // One claim in five asks for the default sink's book, which no fill fills. The other
        // four pick a named sink.
        address feeTo = which % 5 == 4 ? ghostDefaultSink : feeTos[which % 2];
        address token = _tokenAt(which % 7);
        try settlement.claim(singleConfig(feeTo), token) returns (uint256 paid) {
            if (paid > 0) callsClaim++;
            _claimed(feeTo, token, paid);
        } catch {}
    }

    function cancelOne(uint256 which) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];
        vm.prank(i.maker);
        try settlement.cancel(i) {
            callsCancel++;
        } catch {}
    }

    /**
     * @notice Sign a brand new intent while the run is in flight.
     *
     * This is the action that would have caught the escrow self-dealing bug: a maker inventing a
     * fresh intent, mid-sequence, to spend funds an executor is relying on. A fixed set of
     * intents built in the constructor can never express it.
     */
    function signNewIntent(uint256 whoSeed, uint256 shape, uint256 size) external {
        if (intents.length > 24) return; // keep the invariant loops bounded
        uint256 m = whoSeed % MAKERS;
        uint256 amountIn = bound(size, 1e18, 50_000e18);

        ProveSettlement.Intent memory i = ProveSettlement.Intent({
            maker: makers[m],
            recipient: makers[m],
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: amountIn,
            minOutStart: amountIn / 30,
            minOutEnd: shape % 2 == 0 ? amountIn / 30 : amountIn / 60,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + (shape % 3 == 2 ? 7 days : 1 hours)),
            executor: address(0),
            feeConfig: feeCfg(shape % 2 == 0 ? address(0) : feeTos[shape % 2]),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: shape % 2 == 0 ? 0 : _rateFor(shape % 5),
            minFill: 0,
            authNonce: bytes32(0),
            flags: (shape % 3 == 0 ? settlement.FLAG_PARTIAL() : 0)
                | (shape % 3 == 2 ? settlement.FLAG_ESCROW() : 0),
            nonce: 5_000 + intents.length,
            curve: bytes32(0)
        });
        intents.push(i);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKeys[m], settlement.hashIntent(i));
        signatures.push(abi.encodePacked(r, s, v));
        callsSign++;
    }

    /**
     * @notice Fill through the callback path, so it gets the same fuzzing as the direct one.
     *
     * The bot sends this one itself: the callback target is the caller, so a callback fill has
     * exactly one executor and it is a contract.
     */
    function fillViaCallback(uint256 which, uint256 takeSeed) external {
        uint256 k = which % intents.length;
        ProveSettlement.Intent memory i = intents[k];

        (uint256 remaining, bool live) = availableOf(settlement, i);
        if (!live) return;
        uint256 take =
            i.flags & settlement.FLAG_PARTIAL() != 0 ? bound(takeSeed, 1, remaining) : remaining;
        if (i.flags & settlement.FLAG_ESCROW() != 0) {
            if (settlement.reserved(settlement.hashIntent(i)) < take) return;
        }

        uint256 delivered = settlement.quote(i, take, block.timestamp).delivered;

        try bot.settle(settlement, i, signatures[k], take, "", ANY_FEE) {
            callsCallback++;
            _bookFill(i, take, delivered);
        } catch {}
    }

    /**
     * @notice Move the clock.
     *
     * One jump in four is exactly one cooldown, because the withdrawal window is one cooldown
     * wide and a uniform draw over two days almost never lands inside it. Without this the
     * fuzzer would never reach a successful `withdraw`.
     */
    function skipTime(uint256 secs) external {
        uint256 dt = bound(secs, 1, 2 days);
        vm.warp(block.timestamp + dt);
    }

    // ── Books ────────────────────────────────────────────────────────────────

    /// @dev Worked out here, from the signed terms, rather than by asking `quote()`. A ghost
    ///      that calls the contract can only ever agree with it.
    function _owed(ProveSettlement.Intent memory i, uint256 take) private view returns (uint256) {
        uint256 rate;
        if (block.timestamp <= i.startTime || i.minOutEnd == i.minOutStart) {
            rate = i.minOutStart;
        } else if (block.timestamp >= i.endTime) {
            rate = i.minOutEnd;
        } else {
            uint256 span = uint256(i.endTime) - uint256(i.startTime);
            uint256 elapsed = block.timestamp - uint256(i.startTime);
            rate = i.minOutStart - ((i.minOutStart - i.minOutEnd) * elapsed) / span;
        }
        uint256 n = take * rate;
        return n == 0 ? 0 : (n - 1) / i.amountIn + 1;
    }

    function _bookFill(ProveSettlement.Intent memory i, uint256 take, uint256 delivered) private {
        uint256 gross = _owed(i, take);
        // The fee is carved out of the gross this handler worked out, never out of one it was
        // quoted. What the maker is owed is what is left.
        uint256 charged = _bookFee(i.feeConfig, address(tokenB), i.feeRateProceeds, gross);
        ghostTokenBReceived += delivered;
        ghostTokenBGross += gross;
        ghostTokenBOwed += gross - charged;
        if (i.flags & settlement.FLAG_ESCROW() != 0) {
            ghostEscrowNet -= take;
        } else {
            ghostTokenAReleased += take;
        }
        ghostTakes += take;
    }

    // ── Arming ───────────────────────────────────────────────────────────────

    /// @dev The makers whose funds only a signature reaches. Its own frame, so the constructor
    ///      keeps a shallow stack under the coverage build.
    function _castTheArmingMakers() private {
        (permitMaker, permitKey) = makeAddrAndKey("permit maker");
        (keyMaker, keyMakerKey) = makeAddrAndKey("gasless maker");
        (permit2Maker, permit2Key) = makeAddrAndKey("permit2 maker");
        address signer;
        (signer, walletKey) = makeAddrAndKey("wallet signer");
        walletMaker = new SmartWallet(signer);
    }

    /// @notice Every token this handler moves, in the order the invariants name them.
    function tokenAt(uint256 t) external view returns (address) {
        return _tokenAt(t);
    }

    function _tokenAt(uint256 t) private view returns (address) {
        if (t == 0) return address(tokenA);
        if (t == 1) return address(tokenB);
        if (t == 2) return address(permitIn);
        if (t == 3) return address(legacyIn);
        if (t == 4) return address(wideIn);
        if (t == 5) return address(taxedIn);
        return address(permit2In);
    }

    function tokenCount() external pure returns (uint256) {
        return 7;
    }

    function armedCount() external view returns (uint256) {
        return armedIntents.length;
    }

    /**
     * @notice One armed leg, in flat values.
     *
     * Flat, and not the `Intent` itself. A getter that returns the struct makes solc write an
     * encoder the legacy pipeline cannot reach under `forge coverage --ir-minimum`, and the
     * invariants want six numbers rather than sixteen.
     */
    function armedAt(uint256 k)
        external
        view
        returns (
            bytes32 intentHash,
            address token,
            address maker,
            bytes32 authNonce,
            uint256 amountIn,
            uint256 minFill
        )
    {
        return (
            armedHashes[k],
            armedTokens[k],
            armedMakers[k],
            armedNonces[k],
            ARM_SIZE,
            armedIntents[k].minFill
        );
    }

    function twinCount() external view returns (uint256) {
        return twins.length;
    }

    /// @notice The two intent hashes of one pair of offers over the same lot.
    function twinAt(uint256 k) external view returns (bytes32, bytes32) {
        return (armedHashes[twins[k][0]], armedHashes[twins[k][1]]);
    }

    /**
     * @notice True if any maker's authorization was spent by a leg that never filled.
     *
     * The whole griefing argument, asked of the run rather than of one leg. A 3009 nonce is
     * single use, so burning one on a leg that did not settle kills that signature for good and
     * costs the attacker only gas. It lives here rather than in the invariant because the answer
     * needs two passes over the same array, and an invariant cannot keep a mark between them.
     *
     * Siblings share a nonce on purpose, so the question is whether *some* offer naming it
     * filled — not whether this one did. The inner walk runs only for a spent nonce whose own
     * leg came up empty, which is the losing twin and nothing else.
     */
    function aNonceWasBurnedForNothing() external view returns (bool) {
        uint256 n = armedHashes.length;
        bool[] memory earned = new bool[](n);
        for (uint256 k = 0; k < n; k++) {
            earned[k] = _isAuthRung(k) && settlement.filled(armedHashes[k]) > 0;
        }
        for (uint256 k = 0; k < n; k++) {
            if (earned[k] || !_isAuthRung(k)) continue;
            if (!IAuthToken(armedTokens[k]).authorizationState(armedMakers[k], armedNonces[k])) {
                continue;
            }
            bool sibling;
            for (uint256 j = 0; j < n; j++) {
                // A nonce belongs to one maker on one token. All three have to match, or this
                // would forgive a burned nonce on the strength of an unrelated fill.
                if (
                    earned[j] && armedNonces[j] == armedNonces[k]
                        && armedMakers[j] == armedMakers[k] && armedTokens[j] == armedTokens[k]
                ) {
                    sibling = true;
                    break;
                }
            }
            if (!sibling) return true;
        }
        return false;
    }

    /**
     * @notice The same question of the permit2 rung: was a Permit2 nonce spent by a leg that
     *         never filled?
     *
     * The nonce lives in Permit2's bitmap rather than in the token, so it needs its own walk, and
     * the griefing argument is identical. A leg whose arming failed has to leave the bitmap bit
     * clear, because a spent nonce is a signature the maker cannot get back — and `armTwins`
     * puts two offers on one nonce on purpose, so *some* offer naming it having filled is what
     * makes a spent nonce honest, not this particular one.
     */
    function aPermit2NonceWasBurnedForNothing() external view returns (bool) {
        uint256 n = armedHashes.length;
        bool[] memory earned = new bool[](n);
        for (uint256 k = 0; k < n; k++) {
            earned[k] = armedRungs[k] == RUNG_PERMIT2 && settlement.filled(armedHashes[k]) > 0;
        }
        for (uint256 k = 0; k < n; k++) {
            if (earned[k] || armedRungs[k] != RUNG_PERMIT2) continue;
            if (!_permit2NonceSpent(uint256(armedNonces[k]))) continue;
            bool sibling;
            for (uint256 j = 0; j < n; j++) {
                if (earned[j] && armedNonces[j] == armedNonces[k]) {
                    sibling = true;
                    break;
                }
            }
            if (!sibling) return true;
        }
        return false;
    }

    /// @dev Bit `nonce & 0xff` of word `nonce >> 8`, which is how Permit2 keeps it.
    function _permit2NonceSpent(uint256 nonce) private view returns (bool) {
        return permit2.nonceBitmap(permit2Maker, nonce >> 8) & (1 << (nonce & 0xff)) != 0;
    }

    // ── The arming actions ───────────────────────────────────────────────────

    /**
     * @notice Sign a fresh intent on one of the five ways a signature reaches a maker's funds,
     *         attach arming bytes, and offer the leg to a batch.
     *
     * The bytes are as often broken as sound, and that is the point of the action. A leg that
     * cannot be armed has to leave nothing behind — no spent nonce, no moved tokens, no
     * reservation — because a failure that burned a maker's signature would hand anybody with a
     * copy of the intent a free way to cost solvers a batch each, for ever.
     *
     * `skipInvalid` is true, so a leg that cannot be armed is stepped over rather than taking
     * the call down. The batch is one leg long, so the two are the same outcome here and the
     * ring shape belongs to `RingHandler`.
     */
    function armAndFill(
        uint256 rungSeed,
        uint256 shapeSeed,
        uint256 takeSeed,
        uint256 minFillSeed,
        uint256 whoSeed
    ) external {
        if (armedIntents.length >= ARMED_CAP) return;
        uint8 rung = uint8(rungSeed % RUNGS);
        uint8 shape = uint8(shapeSeed % SHAPES);
        uint256 k = _pushArmed(rung, minFillSeed, bytes32(0));
        _offerArmedLeg(k, shape, bound(takeSeed, 1, ARM_SIZE), whoSeed);
    }

    /**
     * @notice Fill an armed intent again, out of the escrow its redemption left behind.
     *
     * This is where the floor meets the remainder. `_redeem` moves the maker's whole `amountIn`
     * however small the fill that triggered it, so a partial first take leaves the rest
     * reserved — and the next take is drawn against a remainder that is often under the floor.
     * That is the one case `take == remaining` has to rescue, and without it the remainder is
     * unreachable from both sides and the maker's escrow sits behind it until they withdraw.
     *
     * Every other draw asks for the whole remainder, because a uniform draw lands on it about
     * never and the escape hatch is the branch worth reaching.
     */
    function fillArmedAgain(uint256 which, uint256 takeSeed, uint256 whoSeed) external {
        if (armedIntents.length == 0) return;
        uint256 k = which % armedIntents.length;
        ProveSettlement.Intent memory i = armedIntents[k];

        (uint256 remaining, bool live) = availableOf(settlement, i);
        if (!live || remaining == 0) return;

        // A gasless leg fills only out of what the redemption actually credited, which a taxed
        // token makes smaller than the take that paid for it.
        uint256 room = remaining;
        if (i.flags & settlement.FLAG_ESCROW() != 0) {
            uint256 held = settlement.reserved(armedHashes[k]);
            if (held < room) room = held;
        }
        if (room == 0) return;

        uint256 take = takeSeed % 2 == 0 ? room : bound(takeSeed, 1, room);
        uint256 filledBefore = settlement.filled(armedHashes[k]);

        vm.prank(executors[whoSeed % executors.length]);
        try settlement.fill(i, armedSigs[k], take, ANY_FEE) {
            callsArmAgain++;
            _bookArmedFill(k, take, remaining, filledBefore);
        } catch {}
    }

    /**
     * @notice A dead armed offer's escrow moves to its maker's parked row.
     *
     * Half the calls kill the offer first, as the maker, because waiting for a seven-day window
     * to close is not the case #120 is about: a maker re-pricing calls their old offer off and
     * expects the capital free the same block. The other half take whatever the time skips have
     * already killed, so both halves of "dead" are driven.
     *
     * Called by the handler itself and not by the maker, because `park` takes no caller check
     * and that is the property — it can only move a maker's money into that maker's own row.
     */
    function parkDeadArmed(uint256 which, uint256 killSeed) external {
        if (armedIntents.length == 0) return;
        uint256 k = which % armedIntents.length;
        ProveSettlement.Intent memory i = armedIntents[k];

        if (killSeed % 2 == 0 && settlement.cancelledAt(armedHashes[k]) == 0) {
            vm.prank(i.maker);
            try settlement.cancel(i) {} catch {}
        }

        try settlement.park(i) {
            callsPark++;
        } catch {}
    }

    /**
     * @notice Arm an armed escrow leg out of its maker's parked capital, and fill it.
     *
     * The fourth arming source, driven the way the other three are: the solver names where the
     * tokens are and the settlement moves them. There is no signature in these bytes — one word
     * asks, and the intent's own preimage decides whose money and which token — so nothing here
     * can be spoiled the way `_armingFor` spoils the other three.
     *
     * A leg whose maker has nothing parked, or not enough, is stepped over. That is not a wasted
     * call: it is the run witnessing that a draw which cannot cover the leg moves nothing.
     */
    function fillFromParked(uint256 which, uint256 takeSeed, uint256 whoSeed) external {
        if (armedIntents.length == 0) return;
        uint256 k = which % armedIntents.length;
        ProveSettlement.Intent memory i = armedIntents[k];
        if (i.flags & settlement.FLAG_ESCROW() == 0) return;

        (uint256 remaining, bool live) = availableOf(settlement, i);
        if (!live || remaining == 0) return;

        uint256 take = bound(takeSeed, 1, remaining);
        uint256 filledBefore = settlement.filled(armedHashes[k]);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = ProveSettlement.FillRequest({
            intent: i,
            signature: armedSigs[k],
            take: take,
            arming: abi.encode(settlement.ARM_FROM_PARKED())
        });

        uint256 restingBefore = settlement.parked(i.maker, i.tokenIn);
        vm.prank(executors[whoSeed % executors.length]);
        try settlement.fillBatch(reqs, true, ANY_FEE) returns (uint256 n) {
            if (n == 1) callsParkedFill++;
            // Measured, never assumed. The leg may have settled out of a reservation an earlier
            // redemption left behind, and that leg still owes its nonce.
            if (settlement.parked(i.maker, i.tokenIn) < restingBefore) {
                armedFundedFromParked[k] = true;
            }
            _bookArmedFill(k, take, remaining, filledBefore);
        } catch {}
    }

    /**
     * @notice A maker takes one parked row home, mid-run, at a moment the fuzzer picks.
     *
     * Without this the parked book only ever grows, and the sweep's third term would be witnessed
     * rising and never falling — the same reason `claimFees` exists beside the fee book.
     */
    function unparkRow(uint256 which) external {
        address maker = _armMaker(uint8(which % RUNGS));
        address token = _tokenAt(which % 7);

        vm.prank(maker);
        try settlement.withdrawParked(token) {
            callsUnpark++;
        } catch {}
    }

    /**
     * @notice Two offers over one lot, sharing a 3009 nonce, put to the same batch.
     *
     * The token spends that nonce once, so exactly one of the two can ever be funded. Both legs
     * carry a real authorization naming it, both are asked to fill, and the maker's balance may
     * move only once. A permit is not part of this: it grants an allowance rather than spending
     * a counter, so exclusion is not a property that rung has.
     */
    function armTwins(uint256 rungSeed, uint256 takeSeed, uint256 whoSeed) external {
        if (armedIntents.length + 2 > ARMED_CAP) return;
        uint8 rung = uint8(RUNG_LEGACY + (rungSeed % (RUNGS - 1)));
        bytes32 shared = keccak256(abi.encodePacked("one lot, two prices", armedIntents.length));

        uint256 a = _pushArmed(rung, 0, shared);
        uint256 b = _pushArmed(rung, 0, shared);
        twins.push([a, b]);

        uint256 take = bound(takeSeed, 1, ARM_SIZE);
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _armedRequest(a, SHAPE_GOOD, take);
        reqs[1] = _armedRequest(b, SHAPE_GOOD, take);

        vm.prank(executors[whoSeed % executors.length]);
        try settlement.fillBatch(reqs, true, ANY_FEE) {
            callsTwins++;
            _bookArmedFill(a, take, ARM_SIZE, 0);
            _bookArmedFill(b, take, ARM_SIZE, 0);
        } catch {}
    }

    /**
     * @notice Ask what a batch would do, then check that asking did nothing.
     *
     * `dryRun` arms for real — the maker's nonce is spent, their tokens move into the escrow,
     * the leg is booked and token A is released to the caller — and then reverts with the
     * answer. Predicting any of that is the guess the function exists to replace, so the only
     * honest test of "it changes nothing" is a fingerprint of everything it could have changed,
     * taken either side of the call: every reservation, every `filled`, every `totalReserved`,
     * every balance this handler knows of, and every 3009 nonce.
     *
     * A plain leg rides beside the armed one, so the walk books and releases as well as arming.
     */
    function dryRunArmed(uint256 which, uint256 takeSeed, uint256 whoSeed) external {
        if (armedIntents.length == 0) return;
        uint256 k = which % armedIntents.length;
        uint256 j = which % intents.length;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _armedRequest(k, SHAPE_GOOD, bound(takeSeed, 1, ARM_SIZE));
        // Every third walk arms out of the maker's parked capital instead of out of a signature,
        // when there is any to draw. That source spends no nonce and moves no token — it moves
        // four storage slots — so a walk that failed to give it back would leave a maker's
        // capital inside a hash and nothing the other invariants read would notice.
        // `_reservePrint` reads both parked books for exactly this.
        //
        // The row has to be non-empty or this would only ever swap a signature that works for
        // one that funds nothing, and the walk would stop arming anything at all. An offer
        // welded to a sibling is skipped too, because the source refuses one.
        if (
            takeSeed % 3 == 0 && armedNonces[k] == armedHashes[k]
                && armedIntents[k].flags & settlement.FLAG_ESCROW() != 0
                && settlement.parked(armedIntents[k].maker, armedIntents[k].tokenIn) != 0
        ) {
            reqs[0].arming = abi.encode(settlement.ARM_FROM_PARKED());
        }
        reqs[1] = ProveSettlement.FillRequest({
            intent: intents[j], signature: signatures[j], take: 1, arming: ""
        });

        bytes32 before = _fingerprint();
        vm.prank(executors[whoSeed % executors.length]);
        (bool returned, bytes memory answer) =
            address(settlement).call(abi.encodeCall(ProveSettlement.dryRun, (reqs, ANY_FEE)));

        if (returned) {
            ghostDryRunsThatReturned++;
            return;
        }
        if (_fingerprint() != before) ghostDryRunsThatMovedSomething++;
        if (_saidOk(answer)) callsDryRunThatArmed++;
        callsDryRun++;
    }

    /**
     * @dev Whether the walk said the armed leg would fill.
     *
     * A run whose every dry run reported a dead leg would pass the invariant above without ever
     * arming anything, which is the one case that would make it a green statement about nothing.
     * The armed leg is first in the request, so its reason is first in the answer.
     *
     * The selector is checked before the decode, and the length after it. `dryRun` reverts with
     * something else when a token does — a hostile one can burn the caller's gas and say so —
     * and decoding that as a `Reason[]` would revert here and take the whole action down.
     * A selector, an offset, a length and one reason is a hundred bytes.
     */
    function _saidOk(bytes memory answer) private pure returns (bool) {
        if (answer.length < 100 || bytes4(answer) != ProveSettlement.DryRun.selector) return false;
        bytes memory body = new bytes(answer.length - 4);
        for (uint256 k = 0; k < body.length; k++) {
            body[k] = answer[k + 4];
        }
        ProveSettlement.Reason[] memory reasons = abi.decode(body, (ProveSettlement.Reason[]));
        return reasons.length > 0 && reasons[0] == ProveSettlement.Reason.Ok;
    }

    /// @notice The state a dry run must give back, in one word. Exposed so a test can prove the
    ///         instrument works: a real fill has to move it, or it is measuring nothing.
    function fingerprint() external view returns (bytes32) {
        return _fingerprint();
    }

    // ── Building an armed leg ────────────────────────────────────────────────

    /// @dev Sign a fresh intent on one rung and file it. The terms live in their own frame for
    ///      the reason `_startingIntent` gives: the literal and the signing together run the
    ///      unoptimised IR a slot past the deepest word the stack can reach.
    function _pushArmed(uint8 rung, uint256 minFillSeed, bytes32 authNonce)
        private
        returns (uint256 k)
    {
        address maker = _armMaker(rung);
        address token = _armToken(rung);
        // Minted per intent, so a long run never goes dry and a sibling has its own lot to sell.
        // An authorization commits to `amountIn`, not to a balance.
        IMintable(token).mint(maker, ARM_SIZE);

        ProveSettlement.Intent memory i = _armedTerms(rung, minFillSeed, authNonce);
        bytes32 h = settlement.hashIntent(i);

        k = armedIntents.length;
        armedIntents.push(i);
        armedHashes.push(h);
        armedTokens.push(token);
        armedMakers.push(maker);
        // A permit spends no counter of this kind at all. Every other rung spends exactly one,
        // and `_redeemInto` and `_pullPermit2In` both decide which before the token or Permit2
        // hears about it — so this is the only nonce the leg could burn whatever bytes a caller
        // presents. A permit2 leg's lives in Permit2's bitmap rather than in the token's ledger,
        // which is why `_isAuthRung` gates every read of it.
        armedNonces.push(
            rung == RUNG_PERMIT ? bytes32(0) : (authNonce == bytes32(0) ? h : authNonce)
        );
        armedRungs.push(rung);
        armedSigs.push(_sign65(_armKey(rung), h));
    }

    /// @dev The terms of one armed intent. Its own frame, for the stack.
    function _armedTerms(uint8 rung, uint256 minFillSeed, bytes32 authNonce)
        private
        view
        returns (ProveSettlement.Intent memory)
    {
        // Escrow on the three gasless rungs; the permit and permit2 rungs leave the tokens in
        // the maker's wallet until the fill reaches for them.
        bool escrow = rung != RUNG_PERMIT && rung != RUNG_PERMIT2;
        return ProveSettlement.Intent({
            maker: _armMaker(rung),
            recipient: _armMaker(rung),
            tokenIn: _armToken(rung),
            tokenOut: address(tokenB),
            amountIn: ARM_SIZE,
            // Flat, so nothing here turns on the decay curve. The floor is what is under test.
            minOutStart: ARM_SIZE / 4,
            minOutEnd: ARM_SIZE / 4,
            startTime: uint64(block.timestamp),
            // A permit leg gets the short window and the others get a long one, so the campaign
            // exercises both. The settlement stopped bounding any of them, but a permit is still
            // the rung whose signature a later re-approval can revive, so it is the one worth
            // driving at both lengths across the suite.
            endTime: uint64(block.timestamp + (rung == RUNG_PERMIT ? 30 minutes : 7 days)),
            executor: address(0),
            // No fee. The fee books above are a statement about the intents this handler signs
            // through `_bookFill`, and an armed leg must not move them. A zero `feeTo` would pay
            // the default sink, so this names a sink whose floor is zero, at a rate of zero.
            feeConfig: feeCfg(feeTos[0]),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0,
            minFill: _floor(minFillSeed),
            authNonce: authNonce,
            flags: settlement.FLAG_PARTIAL() | (escrow ? settlement.FLAG_ESCROW() : 0)
                | (rung == RUNG_PERMIT2 ? settlement.FLAG_PERMIT2() : 0),
            nonce: 9_000 + armedIntents.length,
            curve: bytes32(0)
        });
    }

    /**
     * @dev The five values of `minFill` worth signing, and the reason each one is here.
     *
     * Zero is what every intent carried before the field existed, so it is the shape that must
     * not have changed. One is the smallest floor that is not none. A third of the lot is the
     * ordinary case, and it is the one that leaves a remainder under its own floor. The whole
     * lot, and one more than the whole lot, both turn a partial intent into an all-or-nothing
     * one — through `take == remaining` rather than through the flag, which is a different
     * route to the same offer and the arithmetic has to agree.
     */
    function _floor(uint256 seed) private pure returns (uint256) {
        uint256 pick = seed % 5;
        if (pick == 0) return 0;
        if (pick == 1) return 1;
        if (pick == 2) return ARM_SIZE / 3;
        if (pick == 3) return ARM_SIZE;
        return ARM_SIZE + 1;
    }

    function _armToken(uint8 rung) private view returns (address) {
        if (rung == RUNG_PERMIT) return address(permitIn);
        if (rung == RUNG_LEGACY) return address(legacyIn);
        if (rung == RUNG_TAXED) return address(taxedIn);
        if (rung == RUNG_PERMIT2) return address(permit2In);
        return address(wideIn);
    }

    function _armMaker(uint8 rung) private view returns (address) {
        if (rung == RUNG_PERMIT) return permitMaker;
        if (rung == RUNG_PERMIT2) return permit2Maker;
        if (rung == RUNG_7598_WALLET) return address(walletMaker);
        return keyMaker;
    }

    /// @dev The key that answers for a rung's maker. On the wallet rung it is the key the wallet
    ///      checks an ERC-1271 answer against, and it is never the wallet's own address.
    function _armKey(uint8 rung) private view returns (uint256) {
        if (rung == RUNG_PERMIT) return permitKey;
        if (rung == RUNG_PERMIT2) return permit2Key;
        if (rung == RUNG_7598_WALLET) return walletKey;
        return keyMakerKey;
    }

    /// @notice True when this armed leg is reached by a Permit2 signature rather than an
    ///         EIP-3009 authorization. The invariants that read a token's `authorizationState`
    ///         have to skip it: `permit2In` has no such ledger, and no rung asked it to.
    function isPermit2Rung(uint256 k) external view returns (bool) {
        return armedRungs[k] == RUNG_PERMIT2;
    }

    /// @dev True when the rung spends an EIP-3009 nonce on the token itself.
    function _isAuthRung(uint256 k) private view returns (bool) {
        return armedRungs[k] != RUNG_PERMIT && armedRungs[k] != RUNG_PERMIT2;
    }

    function _sign65(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _armedRequest(uint256 k, uint8 shape, uint256 take)
        private
        returns (ProveSettlement.FillRequest memory)
    {
        return ProveSettlement.FillRequest({
            intent: armedIntents[k],
            signature: armedSigs[k],
            take: take,
            arming: _armingFor(k, shape, take)
        });
    }

    /// @dev The bytes that reach one maker's funds. The intent's custody flags say which of the
    ///      three they are, which is the same rule `_armLeg` reads.
    function _armingFor(uint256 k, uint8 shape, uint256 take) private returns (bytes memory) {
        if (armedRungs[k] == RUNG_PERMIT) return _permitBytes(shape, take);
        if (armedRungs[k] == RUNG_PERMIT2) return _permit2Bytes(k, shape, take);
        return _authBytes(k, shape);
    }

    /**
     * @dev One Permit2 SignatureTransfer, spoiled the ways this rung can be spoiled.
     *
     * Three of the seven shapes mean something here and the rest produce a sound leg, which is
     * the rule the shape table already states: a shape that means nothing on the rung it lands
     * on arms perfectly well, and the refusal counters say how often each one really bit.
     *
     *   - a deadline already past, which is `SHAPE_WINDOW_CLOSED`'s meaning on this rung. There
     *     is no "not open yet": Permit2 has one bound, not two.
     *   - a nonce naming another offer, which `_pullPermit2In` refuses before Permit2 hears of it
     *   - sixty-six bytes, which is nobody's signature
     *
     * **The compact width arms.** Permit2 reads EIP-2098's sixty-four byte form, so where the
     * legacy EIP-3009 overload refuses it outright this rung takes it — a difference between the
     * two gasless standards that only running both can state.
     *
     * **The value is the take and not the lot**, for `_permitBytes`'s reason turned inside out.
     * Permit2 allows a request under the permitted amount, so signing for exactly what the leg
     * spends proves the rung draws no more than it fills, and leaves nothing behind either way —
     * the nonce is spent whatever the size.
     */
    function _permit2Bytes(uint256 k, uint8 shape, uint256 take)
        private
        view
        returns (bytes memory)
    {
        ProveSettlement.Permit2Transfer memory p;
        p.token = armedTokens[k];
        p.amount = take;
        p.nonce = shape == SHAPE_WRONG_AUTH_NONCE
            ? uint256(keccak256(abi.encodePacked("a permit for somewhere else", k)))
            : uint256(armedNonces[k]);
        // Equal to now is still open — Permit2 refuses only `block.timestamp > deadline` — so a
        // deadline that has really passed is one second behind the clock.
        p.deadline = shape == SHAPE_WINDOW_CLOSED ? block.timestamp - 1 : block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(permit2Key, _permit2Digest(p));
        p.signature = _signatureAt(shape, v, r, sv);
        return abi.encode(p);
    }

    /**
     * @dev Permit2's digest, built the way Permit2 builds it.
     *
     * Two things are unlike every other EIP-712 digest in this repository and both are
     * load-bearing. Permit2's domain carries **no version string**. And the spender is **not a
     * field of the permit**: Permit2 hashes `msg.sender` in, so this signature names the relayer
     * because the relayer is the only address that will ever present it.
     */
    function _permit2Digest(ProveSettlement.Permit2Transfer memory p)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                permit2.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        permit2.PERMIT_TRANSFER_FROM_TYPEHASH(),
                        keccak256(
                            abi.encode(permit2.TOKEN_PERMISSIONS_TYPEHASH(), p.token, p.amount)
                        ),
                        relayerAddr,
                        p.nonce,
                        p.deadline
                    )
                )
            )
        );
    }

    /**
     * @dev A permit for the relayer, sometimes against a nonce the token has already passed.
     *
     * **The value is the take and not the lot**, which is the difference between exercising this
     * rung and exercising it once. `permit` *sets* an allowance, and `_grantAllowance` asks for
     * one only when the standing allowance falls short — so a permit for the whole lot leaves
     * change behind, every later leg is covered by it, and the token is never called again. A
     * permit for exactly what the leg spends leaves nothing, and the rung is armed afresh each
     * time. A solver would write it this way too: the narrower grant is the safer one.
     *
     * The stale shape is the one worth building. It is **not** the front-running race: a
     * stranger who replays the maker's own permit sets the allowance, `_grantAllowance` sees the
     * allowance standing and never calls the token, and the leg fills. This is the other half —
     * the token moved past the nonce and granted nothing — where the call is made and refused,
     * and the whole arming frame has to unwind around it.
     */
    function _permitBytes(uint8 shape, uint256 take) private returns (bytes memory) {
        ProveSettlement.Permit memory p;
        p.value = take;
        p.deadline = block.timestamp + 1 days;
        (p.v, p.r, p.s) = vm.sign(
            permitKey, _permitDigest(relayerAddr, p.value, permitIn.nonces(permitMaker), p.deadline)
        );
        if (shape == SHAPE_STALE_PERMIT_NONCE) _burnPermitNonce();
        return abi.encode(p);
    }

    /// @dev Move the token past the nonce the maker just signed against, without granting the
    ///      allowance the leg needs. A permit of the maker's own, for nothing, to nowhere.
    function _burnPermitNonce() private {
        uint256 deadline = block.timestamp + 1 days;
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(permitKey, _permitDigest(NOWHERE, 0, permitIn.nonces(permitMaker), deadline));
        permitIn.permit(permitMaker, NOWHERE, 0, deadline, v, r, s);
    }

    function _permitDigest(address spender, uint256 value, uint256 nonce, uint256 deadline)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                permitIn.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        permitIn.PERMIT_TYPEHASH(), permitMaker, spender, value, nonce, deadline
                    )
                )
            )
        );
    }

    /**
     * @dev An EIP-3009 authorization for the maker's whole `amountIn`, spoiled three ways and
     *      signed at three widths.
     *
     * The window shapes are the pair nothing on chain reconciles: the token enforces
     * `validAfter` and `validBefore`, `_evaluate` enforces `startTime` and `endTime`, and a
     * gasless leg is alive only where the two overlap. A leg outside the token's window comes
     * back `EscrowShort` — the same answer a taxed token gives, and the same one a maker who
     * never signed anything gives — which is why that reason means "not now" and never "not
     * ever" on a leg that asked to be armed.
     */
    function _authBytes(uint256 k, uint8 shape) private view returns (bytes memory) {
        ProveSettlement.Authorization memory a;
        a.validAfter = shape == SHAPE_WINDOW_NOT_OPEN ? block.timestamp + 1 hours : 0;
        // Equal to now, not before it: the token wants `block.timestamp < validBefore`, so this
        // is the widest window that is already shut.
        a.validBefore = shape == SHAPE_WINDOW_CLOSED ? block.timestamp : block.timestamp + 1 days;
        a.nonce = shape == SHAPE_WRONG_AUTH_NONCE
            ? keccak256(abi.encodePacked("an authorization for somewhere else", k))
            : armedNonces[k];

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_armKey(armedRungs[k]), _authDigest(k, a));
        a.signature = _signatureAt(shape, v, r, s);
        return abi.encode(a);
    }

    function _authDigest(uint256 k, ProveSettlement.Authorization memory a)
        private
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "\x19\x01",
                IAuthToken(armedTokens[k]).DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        IAuthToken(armedTokens[k]).RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        armedMakers[k],
                        address(settlement),
                        ARM_SIZE,
                        a.validAfter,
                        a.validBefore,
                        a.nonce
                    )
                )
            )
        );
    }

    /**
     * @dev The signature at the three widths `_receive` branches on.
     *
     * Sixty-five is what a key produces and the only width the legacy overload can read, so it
     * is tried first. Sixty-four is EIP-2098's compact form — the parity folded into the top bit
     * of `s` — and cannot be `v, r, s` at all, so it goes straight to ERC-7598. Sixty-six is
     * here so that "any other length" is a width somebody ran rather than a sentence in a
     * comment.
     *
     * A width is not a fault. A contract wallet's 65 bytes fail the legacy overload and arm
     * through the fall-through; its 64 bytes skip that step and arm anyway. Every other rung
     * refuses both, and the refusal counters are what say so.
     */
    function _signatureAt(uint8 shape, uint8 v, bytes32 r, bytes32 s)
        private
        pure
        returns (bytes memory)
    {
        if (shape == SHAPE_COMPACT_SIGNATURE) {
            return abi.encodePacked(r, bytes32(uint256(s) | (uint256(v - 27) << 255)));
        }
        if (shape == SHAPE_LONG_SIGNATURE) return abi.encodePacked(r, s, v, uint8(0));
        return abi.encodePacked(r, s, v);
    }

    // ── Offering an armed leg, and the books it moves ────────────────────────

    /// @dev Put one armed leg to a batch and write down what came of it. Its own frame, so the
    ///      request array, the snapshot and the booking never share a stack.
    function _offerArmedLeg(uint256 k, uint8 shape, uint256 take, uint256 whoSeed) private {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _armedRequest(k, shape, take);

        vm.prank(executors[whoSeed % executors.length]);
        try settlement.fillBatch(reqs, true, ANY_FEE) returns (uint256 n) {
            if (n == 1) {
                callsArm++;
                armFillsByRung[armedRungs[k]]++;
                _bookArmedFill(k, take, ARM_SIZE, 0);
            } else {
                callsArmRefused++;
                armRefusalsByShape[shape]++;
            }
        } catch {}
    }

    /**
     * @dev What one armed fill owed, and the floor it had to clear.
     *
     * `filledBefore` is read from the chain rather than assumed, because a leg the batch stepped
     * over moved nothing and must book nothing. The rule is `take >= minFill || take ==
     * remaining`, and both halves are counted: a take under the floor with the intent still open
     * is the fault, and one that closed the intent is the escape hatch running.
     */
    function _bookArmedFill(uint256 k, uint256 take, uint256 remaining, uint256 filledBefore)
        private
    {
        if (settlement.filled(armedHashes[k]) == filledBefore) return;

        uint256 floor = armedIntents[k].minFill;
        if (take < floor) {
            if (take == remaining) ghostClosingFillsUnderTheFloor++;
            else ghostFillsUnderTheFloor++;
        }
        ghostArmedOwed += _owed(armedIntents[k], take);
    }

    // ── The fingerprint a dry run must not change ────────────────────────────

    /// @dev Everything `dryRun` could have moved, in one word. Three passes, each in its own
    ///      frame, because one function holding all of them is deeper than the coverage build's
    ///      stack can reach.
    function _fingerprint() private view returns (bytes32) {
        return keccak256(abi.encodePacked(_bookPrint(), _balancePrint(), _noncePrint()));
    }

    /// @dev Every `filled`, every reservation, and the per-token sum the sweep reads.
    function _bookPrint() private view returns (bytes32 fp) {
        for (uint256 k = 0; k < intents.length; k++) {
            bytes32 h = settlement.hashIntent(intents[k]);
            fp = keccak256(abi.encodePacked(fp, settlement.filled(h), settlement.reserved(h)));
        }
        for (uint256 k = 0; k < armedHashes.length; k++) {
            fp = keccak256(
                abi.encodePacked(
                    fp, settlement.filled(armedHashes[k]), settlement.reserved(armedHashes[k])
                )
            );
        }
        fp = _reservePrint(fp);
    }

    /// @dev The per-token sums the sweep reads, over every token — the output one no intent here
    ///      ever escrows included, because a reservation appearing against it would be a walk
    ///      crediting a book it has no business touching. Its own frame, for the stack.
    ///
    ///      The parked book is in here for the same reason the reserved one is: a walk may arm a
    ///      leg out of a maker's parked capital, and the whole claim is that it gives every wei
    ///      of it back.
    function _reservePrint(bytes32 fp) private view returns (bytes32) {
        for (uint256 t = 0; t < 7; t++) {
            address token = _tokenAt(t);
            fp = keccak256(
                abi.encodePacked(fp, settlement.totalReserved(token), settlement.totalParked(token))
            );
        }
        return fp;
    }

    /// @notice Every parked row this run could ever credit, in this token, added up. The
    ///         invariant holds it against `totalParked`, which is the relation `_reserved` has to
    ///         `_totalReserved` and `_pendingFees` has to `_totalPendingFees`.
    function parkedRows(address token) external view returns (uint256 sum) {
        for (uint8 rung = 0; rung < RUNGS; rung++) {
            address who = _armMaker(rung);
            // The rungs share makers, so a row must be counted once. Count it against the first
            // rung that names its owner and skip every later mention.
            bool seen = false;
            for (uint8 e = 0; e < rung; e++) {
                if (_armMaker(e) == who) seen = true;
            }
            if (!seen) sum += settlement.parked(who, token);
        }
        for (uint256 m = 0; m < MAKERS; m++) {
            sum += settlement.parked(makers[m], token);
        }
    }

    /// @dev Every balance of every token, over everyone who could hold one. A release the walk
    ///      failed to unwind lands in the caller's balance, so the executors are in here too.
    function _balancePrint() private view returns (bytes32 fp) {
        for (uint256 t = 0; t < 7; t++) {
            fp = this.oneTokensHolders(fp, _tokenAt(t));
        }
    }

    /**
     * @notice Everyone who could hold one token, in one word.
     *
     * External, and called through `this`, which is the only thing here that is not a matter of
     * taste. Thirteen reads, an accumulator and a loop counter in one frame is a slot past what
     * the IR pipeline can reach, and a private helper does not fix it: the optimizer inlines the
     * call back into the loop and the frame is the same size again. An external call is a
     * boundary it cannot fold away.
     */
    function oneTokensHolders(bytes32 fp, address which) external view returns (bytes32) {
        IERC20 token = IERC20(which);
        return keccak256(
            abi.encodePacked(
                fp,
                token.balanceOf(address(settlement)),
                token.balanceOf(relayerAddr),
                token.balanceOf(makers[0]),
                token.balanceOf(makers[1]),
                token.balanceOf(makers[2]),
                token.balanceOf(permitMaker),
                token.balanceOf(keyMaker),
                token.balanceOf(permit2Maker),
                token.balanceOf(address(walletMaker)),
                token.balanceOf(executors[0]),
                token.balanceOf(executors[1]),
                token.balanceOf(address(bot)),
                token.balanceOf(defaultProceeds),
                token.balanceOf(TAX_COLLECTOR)
            )
        );
    }

    /// @dev Every 3009 nonce and every Permit2 nonce the run has ever named, and the relayer
    ///      allowance a permit grants. All three are things a walk arms for real and has to give
    ///      back — a `dryRun` that left one spent would burn a maker's signature for nothing.
    function _noncePrint() private view returns (bytes32 fp) {
        for (uint256 k = 0; k < armedNonces.length; k++) {
            if (armedRungs[k] == RUNG_PERMIT2) {
                fp = keccak256(abi.encodePacked(fp, _permit2NonceSpent(uint256(armedNonces[k]))));
                continue;
            }
            if (armedNonces[k] == bytes32(0)) continue;
            fp = keccak256(
                abi.encodePacked(
                    fp,
                    IAuthToken(armedTokens[k]).authorizationState(armedMakers[k], armedNonces[k])
                )
            );
        }
        fp = keccak256(
            abi.encodePacked(
                fp, permitIn.nonces(permitMaker), permitIn.allowance(permitMaker, relayerAddr)
            )
        );
    }
}
