// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {IERC2612} from "../src/interfaces/IERC2612.sol";
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
 * @notice The gasless rung for tokens that cannot do EIP-3009.
 *
 *   forge test --match-path test/Permit.t.sol -vv
 *
 * A permit grants an allowance from a signature, so the maker sends nothing. It is the approval
 * rung with the transaction removed, and this file is mostly about holding that line: it must not
 * be mistaken for escrow, it must take the wallet window, and its allowance must land on the
 * relayer rather than on the settlement.
 *
 * The test that earns its keep is the front-running one. `nonces` moves on every permit, so a
 * stranger can replay the maker's signed permit first and leave ours reverting on a bad signature
 * while the allowance sits there perfectly set. If that reverted the fill, anybody could stop
 * every gasless fill on the board for the price of gas.
 *
 * **`fillWithPermit` runs `_armLeg` now, which is the same code a batch leg arms itself with.**
 * The seventy lines of pre-flight that used to sit here, beside `fillBatch`'s copy of the same
 * rules, are gone; the door is not. It is worth keeping because a batch of one pays for an array,
 * a loop and a fee run that one leg cannot use. `test/Arming.t.sol` fills the same rung through a
 * batch, so both doors onto those rules are covered.
 *
 * One thing reads differently for it. Arming re-checks the leg deeply, so a maker who cannot pay
 * is `EscrowShort` here rather than whatever the token would have said one step later.
 */

/// @notice A plain ERC-20 with EIP-2612, hand-rolled: OpenZeppelin's `EIP712` reaches `mcopy` and
///         will not compile under this repo's `paris` target.
contract MockERC2612 is ERC20 {
    bytes32 public constant PERMIT_TYPEHASH = keccak256(
        "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
    );

    mapping(address => uint256) public nonces;

    error PermitExpired();
    error BadPermitSignature();

    constructor() ERC20("Permit", "PMT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Permit")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function permit(
        address owner_,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external virtual {
        if (block.timestamp > deadline) revert PermitExpired();
        uint256 nonce = nonces[owner_];
        nonces[owner_] = nonce + 1;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(abi.encode(PERMIT_TYPEHASH, owner_, spender, value, nonce, deadline))
            )
        );
        if (ecrecover(digest, v, r, s) != owner_) revert BadPermitSignature();
        _approve(owner_, spender, value);
    }
}

/// @notice A token whose `permit` always reverts, so the fill has to survive it failing.
contract HostilePermit is MockERC2612 {
    function permit(address, address, uint256, uint256, uint8, bytes32, bytes32)
        external
        pure
        override
    {
        revert("no permits here");
    }
}

contract PermitTest is Test {
    ProveSettlement settlement;
    /// @dev `vm.prank` is single-shot and `settlement.relayer()` is a call, so it is read once.
    address relayer;
    MockERC2612 tokenA;
    MockERC20 tokenB;

    address owner = address(0xB0B);
    address sink = address(0x5152);
    address executor = address(0xE0E);
    address stranger = address(0x5747);
    address maker;
    uint256 makerKey;

    uint256 constant AMOUNT_IN = 1_000e18;
    uint256 constant MIN_OUT = 10e18;
    /// @dev What the maker keeps out of a gross of `MIN_OUT`. The fee comes out of the number
    ///      the maker signed, so the curve's figure is the executor's outlay and this is the
    ///      maker's receipt. Ten basis points, and it divides exactly here.
    uint256 constant NET_OUT = MIN_OUT - (MIN_OUT * 0.001e18) / 1e18;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        tokenA = new MockERC2612();
        tokenB = new MockERC20("B", "B", 18);

        tokenA.mint(maker, 1_000_000e18);
        tokenB.mint(executor, 1_000_000e18);
        // The maker grants nothing up front. That is the whole point of this path.
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── It works ─────────────────────────────────────────────────────────────

    function test_AMakerWhoSentNoTransactionGetsPaid() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        ProveSettlement.Permit memory p = _permit(AMOUNT_IN, block.timestamp + 1 days);

        assertEq(tokenA.allowance(maker, relayer), 0, "no allowance before");
        assertEq(vm.getNonce(maker), 0, "and the maker has sent nothing");

        vm.prank(executor);
        settlement.fillWithPermit(i, sig, AMOUNT_IN, p, ANY_FEE);

        assertEq(tokenB.balanceOf(maker), NET_OUT, "the maker received the signed rate");
        assertEq(tokenA.balanceOf(maker), 1_000_000e18 - AMOUNT_IN, "and paid the token A");
        assertEq(vm.getNonce(maker), 0, "having still sent no transaction");
    }

    function test_TheAllowanceLandsOnTheRelayerAndNotTheSettlement() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_PARTIAL();
        bytes memory sig = _sign(i);
        // Signed for more than this fill takes, so a remainder is left to inspect.
        ProveSettlement.Permit memory p = _permit(AMOUNT_IN * 2, block.timestamp + 1 days);

        vm.prank(executor);
        settlement.fillWithPermit(i, sig, AMOUNT_IN / 2, p, ANY_FEE);

        assertEq(
            tokenA.allowance(maker, address(settlement)), 0, "the settlement holds no allowance"
        );
        assertGt(tokenA.allowance(maker, relayer), 0, "the relayer holds it, per rule 3");
    }

    /**
     * @notice A stranger replays the permit first, and the fill still lands.
     *
     * This is the one that matters. Reverting when the permit fails would let anybody stop every
     * gasless fill on the board: watch the mempool, copy the signed permit, submit it, and the
     * real call dies on a nonce that has already moved — with the allowance set by the copy.
     */
    function test_AFrontRunPermitDoesNotCostTheFill() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        ProveSettlement.Permit memory p = _permit(AMOUNT_IN, block.timestamp + 1 days);

        // The stranger submits the maker's permit, taking the nonce and setting the allowance.
        vm.prank(stranger);
        tokenA.permit(maker, relayer, p.value, p.deadline, p.v, p.r, p.s);
        assertEq(tokenA.nonces(maker), 1, "the nonce moved");
        assertEq(tokenA.allowance(maker, relayer), AMOUNT_IN, "and the allowance is set");

        // The same permit would now revert, and the fill does not care: the allowance the copy
        // set already covers the take, so `_grantAllowance` never asks the token for one.
        vm.prank(executor);
        settlement.fillWithPermit(i, sig, AMOUNT_IN, p, ANY_FEE);
        assertEq(tokenB.balanceOf(maker), NET_OUT, "the maker was paid anyway");
    }

    /// @notice A token that refuses every permit still fills, provided the allowance is there.
    function test_APermitThatRevertsIsNotAFailedFill() public {
        HostilePermit hostile = new HostilePermit();
        hostile.mint(maker, AMOUNT_IN);
        vm.prank(maker);
        hostile.approve(relayer, AMOUNT_IN);

        ProveSettlement.Intent memory i = _intent();
        i.tokenIn = address(hostile);
        bytes memory sig = _sign(i);

        ProveSettlement.Permit memory p = _permit(AMOUNT_IN, block.timestamp + 1 days);
        vm.prank(executor);
        settlement.fillWithPermit(i, sig, AMOUNT_IN, p, ANY_FEE);
        assertEq(tokenB.balanceOf(maker), NET_OUT, "the standing allowance carried it");
    }

    // ── It refuses ───────────────────────────────────────────────────────────

    /**
     * @notice An intent wearing the escrow flag is not funded by a permit.
     *
     * Escrow is funded by a deposit or by a redeemed authorization, and by nothing else. The flag
     * this door refuses is the same one `_armLeg` reads to pick its arm, so the door and the
     * batch cannot disagree about which signature a maker's bytes hold.
     */
    function test_APermitCannotFundAnEscrowIntent() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);

        ProveSettlement.Permit memory p = _permit(AMOUNT_IN, block.timestamp + 1 days);
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.fillWithPermit(i, sig, AMOUNT_IN, p, ANY_FEE);

        assertEq(settlement.reserved(settlement.hashIntent(i)), 0, "nothing was escrowed");
        assertEq(tokenB.balanceOf(maker), 0, "and the maker was paid nothing");
    }

    /**
     * @notice A permit intent may run as long as the maker signed for, and this one fills.
     *
     * Three hours used to be `BadTerms` here. The settlement bounded a wallet window at an hour,
     * because a permit grants an allowance and revoking an allowance never cancels an intent —
     * true, and not the contract's call to make, since the loss is the signer's alone.
     */
    function test_APermitIntentMayRunLongerThanAnHour() public {
        ProveSettlement.Intent memory i = _intent();
        i.endTime = uint64(block.timestamp + 3 hours);
        bytes memory sig = _sign(i);

        // `EscrowShort` and not `BadTerms_`: a permit grants no allowance until it lands, so the
        // shallow read says "not now" rather than "not ever". Three hours used to answer
        // `BadTerms_` here, and the terms are what changed.
        assertEq(
            uint256(settlement.fillability(i, sig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.EscrowShort),
            "unarmed, which is what any permit intent says before its permit lands"
        );
        ProveSettlement.Permit memory p = _permit(AMOUNT_IN, block.timestamp + 1 days);
        vm.prank(executor);
        settlement.fillWithPermit(i, sig, AMOUNT_IN, p, ANY_FEE);
        assertGt(tokenB.balanceOf(maker), 0, "and it settles");
    }

    /// @notice A permit for less than the fill lands, and the leg is still out of reach. The
    ///         allowance probe inside the arming says so before any token is asked to move
    ///         anything.
    function test_APermitTooSmallToCoverTheFillReverts() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveSettlement.Permit memory p = _permit(AMOUNT_IN / 2, block.timestamp + 1 days);
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fillWithPermit(i, sig, AMOUNT_IN, p, ANY_FEE);
        assertEq(tokenB.balanceOf(maker), 0, "and the maker was paid nothing");
    }

    /**
     * @notice An expired permit takes the fill with it, and the maker has granted nothing.
     *
     * @dev This is the case the old `try ... catch` covered up. Swallowing the token's error here
     *      bought nothing — the fill died one step later on an allowance that was never set — and
     *      it cost the caller the reason. The front-running defence is the `if` in
     *      `_grantAllowance`, not the swallow, and the test above is what proves it.
     */
    function test_AnExpiredPermitTakesTheFillWithIt() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        ProveSettlement.Permit memory p = _permit(AMOUNT_IN, block.timestamp - 1);

        vm.prank(executor);
        vm.expectRevert(MockERC2612.PermitExpired.selector);
        settlement.fillWithPermit(i, sig, AMOUNT_IN, p, ANY_FEE);
        assertEq(tokenA.allowance(maker, relayer), 0, "nothing was granted");
    }

    /// @notice A maker with a standing allowance costs nobody a permit, and keeps their nonce.
    function test_AStandingAllowanceSkipsThePermitEntirely() public {
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        ProveSettlement.Permit memory p = _permit(AMOUNT_IN, block.timestamp + 1 days);
        vm.prank(executor);
        settlement.fillWithPermit(i, sig, AMOUNT_IN, p, ANY_FEE);

        assertEq(tokenA.nonces(maker), 0, "the permit nonce never moved");
        assertEq(tokenB.balanceOf(maker), NET_OUT, "and the maker was paid");
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _intent() internal view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: AMOUNT_IN,
            minOutStart: MIN_OUT,
            minOutEnd: MIN_OUT,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(sink),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0.001e18,
            minFill: 0,
            authNonce: bytes32(0),
            flags: 0,
            nonce: 1,
            curve: bytes32(0)
        });
    }

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /**
     * @dev Assign this to a local before any `vm.prank` or `vm.expectRevert`, never inline it as
     *      an argument. It calls the token for the domain and the nonce, and an argument is
     *      evaluated after the cheatcode — so the helper's own staticcall becomes "the next call"
     *      and eats the prank or satisfies the expectation. That cost five failures here.
     */
    function _permit(uint256 value, uint256 deadline)
        internal
        view
        returns (ProveSettlement.Permit memory p)
    {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                tokenA.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        tokenA.PERMIT_TYPEHASH(),
                        maker,
                        relayer,
                        value,
                        tokenA.nonces(maker),
                        deadline
                    )
                )
            )
        );
        (p.v, p.r, p.s) = vm.sign(makerKey, digest);
        p.value = value;
        p.deadline = deadline;
    }
}
