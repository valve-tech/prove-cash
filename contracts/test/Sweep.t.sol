// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, MockERC20, MockERC3009, NO_PERMIT2} from "./Mocks.sol";
import {RebasingToken} from "./tokens/RebasingToken.sol";
import {WeirdToken} from "./tokens/WeirdToken.sol";
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
 * @notice `sweepUnowned` — the one way a token that belongs to nobody leaves this contract.
 *
 * Tokens arrive here that no intent put here: a plain `transfer` where the sender meant
 * `deposit`, an airdrop, a token that rebases up under a funded escrow. `withdraw` pays
 * `_reserved[h]` and nothing else, so before this every one of them stayed for good.
 *
 * **The whole safety argument is `_totalReserved`, and it is a mirror.** Every site that moves
 * `_reserved[h]` moves it by the same amount in the same statement — `deposit`, `withdraw`, the
 * escrow release inside a fill, and the EIP-3009 redeem. Miss a credit and the sweep pays a
 * maker's escrow to `defaultProceeds`; miss a debit and a maker's own money is stranded behind a
 * number nothing will ever clear. Each of the four has a test below that funds through it and
 * then asks the sweep for everything.
 *
 * **There are three books, and the sweep subtracts all three.** `_totalPendingFees` is the
 * second, and its tests are under "The second book" below. `_totalParked` is the third — a
 * maker's own capital between one offer and the next, credited by `park` and spent by the escrow
 * arm of a fill — and its tests live in `test/Parked.t.sol`, beside the feature they defend.
 *
 * `defaultProceeds` is the destination and the caller chooses only the timing, so neither the
 * caller nor the owner can reach a wei a reservation claims.
 */
contract SweepTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;

    MockERC20 tokenA;
    MockERC20 tokenB;

    address owner = address(0xB0B);
    address proceeds = STRAY_DESTINATION;
    address executor = address(0xE0E);
    address stranger = address(0x57A);
    address feeDest = address(0x5152);

    address maker;
    uint256 makerKey;

    uint256 constant AMOUNT_IN = 1_000e18;
    uint256 constant MIN_OUT = 100e18;
    uint64 constant FEE_RATE = 0.001e18;

    event Swept(address indexed token, bytes32 indexed feeConfig, uint256 amount);

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);

        tokenA.mint(maker, 1_000_000e18);
        tokenA.mint(stranger, 1_000_000e18);
        tokenB.mint(executor, 1_000_000e18);

        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _intent(address tIn, uint8 flags, uint256 nonce)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: tIn,
            tokenOut: address(tokenB),
            amountIn: AMOUNT_IN,
            minOutStart: MIN_OUT,
            minOutEnd: MIN_OUT,
            startTime: uint64(block.timestamp),
            // An hour, because this suite is about sweeping and not about long-dated offers.
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(feeDest),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: FEE_RATE,
            minFill: 0,
            authNonce: bytes32(0),
            flags: flags,
            nonce: nonce,
            curve: bytes32(0)
        });
    }

    function _escrowIntent(address tIn, uint256 nonce)
        internal
        view
        returns (ProveSettlement.Intent memory)
    {
        return _intent(tIn, settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW(), nonce);
    }

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    // ── The ordinary case ────────────────────────────────────────────────────

    /**
     * @notice A plain `transfer` where the sender meant `deposit` is retrievable, and it goes to
     *         `defaultProceeds`.
     *
     * This is the accident the function exists for. The tokens land in the contract's balance
     * against no intent hash at all, so `withdraw` cannot see them and nothing else could either.
     */
    function test_APlainTransferIsSweptToTheProceedsAddress() public {
        vm.prank(stranger);
        tokenA.transfer(address(settlement), 500e18);

        assertEq(settlement.totalReserved(address(tokenA)), 0, "no reservation claims it");

        vm.expectEmit(true, true, false, true, address(settlement));
        emit Swept(address(tokenA), feeCfg(proceeds), 500e18);
        uint256 swept = settlement.sweepUnowned(address(tokenA));

        assertEq(swept, 500e18, "the whole donation");
        assertEq(claimedBalance(settlement, proceeds, address(tokenA)), 500e18);
        assertEq(tokenA.balanceOf(address(settlement)), 0, "and none of it stayed");
    }

    /// @notice Anyone may call it. The caller chooses the timing and nothing else — not the
    ///         amount, which `_totalReserved` decides, and not the destination.
    function test_AnyoneMaySweep() public {
        vm.prank(stranger);
        tokenA.transfer(address(settlement), 1e18);

        vm.prank(stranger);
        assertEq(settlement.sweepUnowned(address(tokenA)), 1e18, "a stranger swept it");
        assertEq(
            claimedBalance(settlement, proceeds, address(tokenA)),
            1e18,
            "to the address the owner set"
        );
        assertEq(tokenA.balanceOf(stranger), 999_999e18, "and kept none of it");
    }

    /// @notice Nothing unowned costs a read and stops. No transfer, no event, no revert — a
    ///         keeper walking a list of tokens must not lose the list to an empty one.
    function test_SweepingNothingReturnsZeroAndMovesNothing() public {
        assertEq(settlement.sweepUnowned(address(tokenA)), 0, "an untouched token");
        assertEq(claimedBalance(settlement, proceeds, address(tokenA)), 0);

        ProveSettlement.Intent memory i = _escrowIntent(address(tokenA), 1);
        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);

        // Exactly solvent: the balance equals the book, so there is nothing unowned.
        assertEq(settlement.sweepUnowned(address(tokenA)), 0, "an exactly-funded escrow");
        assertEq(claimedBalance(settlement, proceeds, address(tokenA)), 0);
    }

    // ── The four sites `_reserved` moves ─────────────────────────────────────

    /**
     * @notice Escrow is not unowned, and a donation beside it is.
     *
     * `deposit` is the first of the four sites. If it credited `_reserved` and not
     * `_totalReserved`, this sweep would take the maker's whole escrow and their `withdraw` would
     * revert on a balance that had left.
     */
    function test_AFundedEscrowIsNeverSweptAndADonationBesideItIs() public {
        ProveSettlement.Intent memory i = _escrowIntent(address(tokenA), 1);
        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);

        vm.prank(stranger);
        tokenA.transfer(address(settlement), 7e18);

        assertEq(settlement.totalReserved(address(tokenA)), AMOUNT_IN, "the deposit was booked");
        assertEq(settlement.sweepUnowned(address(tokenA)), 7e18, "only the donation left");
        assertEq(claimedBalance(settlement, proceeds, address(tokenA)), 7e18);

        // And the maker's money is still theirs, to the wei.
        vm.prank(maker);
        settlement.withdraw(i);
        assertEq(settlement.reserved(settlement.hashIntent(i)), 0);
        assertEq(settlement.totalReserved(address(tokenA)), 0, "the debit mirrored too");
        assertEq(tokenA.balanceOf(address(settlement)), 0, "nothing rests here");
    }

    /**
     * @notice `withdraw` debits both books, so what a maker takes back becomes nobody's rather
     *         than staying booked for ever.
     *
     * The second site, and the failure it guards is the quiet one. A missed debit strands: the
     * balance goes out with the maker, the total stays where it was, and every later sweep of
     * that token subtracts a number that no longer means anything.
     */
    function test_AWithdrawalClearsTheBookAsWellAsTheBalance() public {
        ProveSettlement.Intent memory i = _escrowIntent(address(tokenA), 1);
        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);
        vm.prank(maker);
        settlement.withdraw(i);

        assertEq(settlement.totalReserved(address(tokenA)), 0, "the book is clear");

        vm.prank(stranger);
        tokenA.transfer(address(settlement), 3e18);
        assertEq(settlement.sweepUnowned(address(tokenA)), 3e18, "and a later donation is unowned");
    }

    /**
     * @notice A fill out of escrow debits both books, so the part that left is not still claimed.
     *
     * The third site is inside `_releaseFromEscrow`, which a fill reaches and a caller cannot.
     * A partial fill leaves the rest reserved, and the sweep must see exactly that rest.
     */
    function test_AFillOutOfEscrowMovesBothBooks() public {
        ProveSettlement.Intent memory i = _escrowIntent(address(tokenA), 1);
        bytes memory sig = _sign(i);
        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN / 4, ANY_FEE);

        uint256 rest = AMOUNT_IN - AMOUNT_IN / 4;
        assertEq(settlement.reserved(settlement.hashIntent(i)), rest, "three quarters left");
        assertEq(settlement.totalReserved(address(tokenA)), rest, "and the total agrees");
        assertEq(settlement.sweepUnowned(address(tokenA)), 0, "so nothing is unowned");
        assertEq(tokenA.balanceOf(address(settlement)), rest, "the maker's money is still here");
    }

    /**
     * @notice The EIP-3009 redeem credits both books, so a gasless maker's escrow is as safe as a
     *         deposited one.
     *
     * The fourth site is inside `_redeem`, and it is the easiest of the four to miss because the
     * tokens arrive through the token's own `receiveWithAuthorization` rather than through a pull
     * this contract wrote. A missed credit here would let the first sweep take the whole
     * authorization.
     */
    function test_ARedeemedAuthorizationIsBookedAndNotSweepable() public {
        MockERC3009 auth = new MockERC3009();
        auth.mint(maker, AMOUNT_IN * 2);

        ProveSettlement.Intent memory i = _escrowIntent(address(auth), 1);
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);

        ProveSettlement.Authorization memory a = _authorization(auth, h);

        vm.prank(executor);
        settlement.fillWithAuthorization(i, sig, AMOUNT_IN / 2, a, ANY_FEE);

        uint256 rest = AMOUNT_IN - AMOUNT_IN / 2;
        assertEq(settlement.reserved(h), rest, "the redeem funded the whole amountIn");
        assertEq(settlement.totalReserved(address(auth)), rest, "and the total agrees");
        assertEq(settlement.sweepUnowned(address(auth)), 0, "so the rest is not unowned");
    }

    /// @dev The maker's authorization for the whole `amountIn`, named to this intent's hash.
    function _authorization(MockERC3009 token, bytes32 h)
        private
        view
        returns (ProveSettlement.Authorization memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                maker,
                address(settlement),
                AMOUNT_IN,
                uint256(0),
                type(uint256).max,
                h
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, digest);
        return ProveSettlement.Authorization(0, type(uint256).max, h, abi.encodePacked(r, s, v));
    }

    // ── Tokens that do not behave ────────────────────────────────────────────

    /**
     * @notice A token that taxes its own transfers is booked at what arrived, in both books.
     *
     * `deposit` credits the measured delta rather than the amount it asked for. If
     * `_totalReserved` were credited the amount asked instead, the two books would drift apart by
     * the tax on every deposit — and the sweep would report less than is really unowned, or
     * refuse a donation that plainly is.
     */
    function test_ATaxedDepositBooksWhatArrivedInBothBooks() public {
        WeirdToken taxed = new WeirdToken("Taxed", "TAX", 18);
        taxed.setFeeBps(1_000); // a tenth, taken out of every transfer
        taxed.mint(maker, AMOUNT_IN * 2);
        vm.prank(maker);
        taxed.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _escrowIntent(address(taxed), 1);
        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);

        uint256 arrived = (AMOUNT_IN * 9) / 10;
        assertEq(settlement.reserved(settlement.hashIntent(i)), arrived, "credited what arrived");
        assertEq(settlement.totalReserved(address(taxed)), arrived, "and so was the total");
        assertEq(taxed.balanceOf(address(settlement)), arrived, "which is what is held");
        assertEq(settlement.sweepUnowned(address(taxed)), 0, "so the tax left nothing unowned");
    }

    /**
     * @notice A rebase up strands a surplus reserved to nobody, and the sweep is what retrieves
     *         it. It goes to `defaultProceeds` and not to the maker whose tokens grew.
     *
     * That is a deliberate choice and not an oversight. Paying the gain back needs a
     * share-denominated reservation, and `_reserved` refuses one because shares would spend the
     * guarantee that a donation cannot pay for a fill. So the choice is a destination or nobody
     * having it, and the maker still withdraws exactly the number they deposited.
     */
    function test_ARebaseUpBecomesSweepableAndTheMakerKeepsTheirBookedAmount() public {
        RebasingToken rbs = new RebasingToken();
        rbs.mint(maker, AMOUNT_IN);
        vm.prank(maker);
        rbs.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _escrowIntent(address(rbs), 1);
        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);

        rbs.rebase(2 * rbs.BPS()); // every balance doubles, nobody's slot is written

        assertEq(rbs.balanceOf(address(settlement)), AMOUNT_IN * 2, "the balance grew");
        assertEq(settlement.totalReserved(address(rbs)), AMOUNT_IN, "the book did not");

        assertEq(settlement.sweepUnowned(address(rbs)), AMOUNT_IN, "the gain is unowned");
        assertEq(claimedBalance(settlement, proceeds, address(rbs)), AMOUNT_IN);

        vm.prank(maker);
        settlement.withdraw(i);
        assertEq(rbs.balanceOf(maker), AMOUNT_IN, "the maker takes back the number they booked");
        assertEq(rbs.balanceOf(address(settlement)), 0, "and nothing rests here");
    }

    /**
     * @notice A rebase down leaves the contract insolvent against its own book, and the sweep
     *         returns zero rather than reverting or wrapping.
     *
     * `held - booked` would underflow, and a panic here would cost a keeper walking a list of
     * tokens the whole list. There is nothing unowned in this state — every wei held is claimed
     * twice over — so zero is also the true answer.
     */
    function test_ARebaseDownSweepsNothingAndDoesNotRevert() public {
        RebasingToken rbs = new RebasingToken();
        rbs.mint(maker, AMOUNT_IN);
        vm.prank(maker);
        rbs.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _escrowIntent(address(rbs), 1);
        vm.prank(maker);
        settlement.deposit(i, AMOUNT_IN);

        rbs.rebase(rbs.BPS() / 2); // every balance halves

        assertEq(rbs.balanceOf(address(settlement)), AMOUNT_IN / 2, "the balance fell");
        assertEq(settlement.totalReserved(address(rbs)), AMOUNT_IN, "the book claims the old one");

        assertEq(settlement.sweepUnowned(address(rbs)), 0, "insolvent, so nothing is unowned");
        assertEq(claimedBalance(settlement, proceeds, address(rbs)), 0, "and nothing left");
        assertEq(rbs.balanceOf(address(settlement)), AMOUNT_IN / 2, "the balance is untouched");
    }

    // ── The second book ──────────────────────────────────────────────────────

    /**
     * @notice A booked fee is not unowned, and the sweep cannot take it.
     *
     * **This is the guard, and it is not an edge case.** `_payFee` pulls the fee to this contract
     * and credits `_pendingFees[feeTo][token]`, so the settlement holds token B from the first
     * fill of the first intent that names a destination. Everything held here used to be either a
     * reservation or nobody's; a fee is neither. Without `+ _totalPendingFees[token]` in the
     * subtraction, `sweepUnowned(tokenB)` hands the destination's money to `defaultProceeds` on
     * day one, and the destination's `claim` then reverts on a balance that has left.
     *
     * Drop that term from `sweepUnowned` and this test fails on its first assertion. That is the
     * whole point of it: a guard nothing attacks is a guard nobody defends.
     */
    function test_TheSweepCannotTakeABookedFee() public {
        ProveSettlement.Intent memory i = _intent(address(tokenA), settlement.FLAG_PARTIAL(), 1);
        bytes memory sig = _sign(i);
        uint256 fee = settlement.quote(i, AMOUNT_IN, block.timestamp).feeProceeds;
        assertGt(fee, 0, "this fill charges something worth defending");

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(
            settlement.pendingFees(feeCfg(feeDest), address(tokenB)), fee, "the fee is booked here"
        );
        assertEq(settlement.totalPendingFees(address(tokenB)), fee, "and the total agrees");
        assertEq(tokenB.balanceOf(address(settlement)), fee, "and it is really held here");
        assertEq(settlement.totalReserved(address(tokenB)), 0, "no reservation claims it");

        // The assertion the missing term breaks. Nothing here is unowned: the whole balance is
        // owed to a destination.
        assertEq(settlement.sweepUnowned(address(tokenB)), 0, "the sweep found nothing unowned");
        assertEq(
            claimedBalance(settlement, proceeds, address(tokenB)),
            0,
            "so the owner's address took none of it"
        );
        assertEq(tokenB.balanceOf(address(settlement)), fee, "and the fee is still here");

        // And the destination can still take its money out afterwards.
        assertEq(claimFor(settlement, feeDest, address(tokenB)), fee, "the destination claims it");
        assertEq(tokenB.balanceOf(feeDest), fee, "in full");
    }

    /**
     * @notice A donation beside a booked fee is still unowned, and only the donation leaves.
     *
     * The mirror of the test above. A term that subtracted too much would strand a real donation
     * for ever, which is the failure the sweep exists to prevent — so the guard has to be exact
     * rather than merely conservative.
     */
    function test_ADonationBesideABookedFeeIsStillSweepable() public {
        ProveSettlement.Intent memory i = _intent(address(tokenA), settlement.FLAG_PARTIAL(), 1);
        bytes memory sig = _sign(i);
        uint256 fee = settlement.quote(i, AMOUNT_IN, block.timestamp).feeProceeds;

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        vm.prank(executor);
        tokenB.transfer(address(settlement), 11e18);

        assertEq(settlement.sweepUnowned(address(tokenB)), 11e18, "the donation, and only it");
        assertEq(claimedBalance(settlement, proceeds, address(tokenB)), 11e18);
        assertEq(
            settlement.pendingFees(feeCfg(feeDest), address(tokenB)), fee, "the fee is untouched"
        );
        assertEq(claimFor(settlement, feeDest, address(tokenB)), fee, "and still claimable in full");
    }

    // ── The destination is the owner's, and only this ────────────────────────
}
