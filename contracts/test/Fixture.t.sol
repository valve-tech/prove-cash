// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {
    proceedsRate,
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION,
    ratesOf
} from "./Fees.sol";
import {RfqVenue} from "../src/RfqVenue.sol";
import {NO_PERMIT2} from "./Mocks.sol";

/**
 * @notice Writes the canonical EIP-712 fixture the TypeScript side asserts against.
 *
 *   forge test --match-path test/Fixture.t.sol
 *
 * The app and the bots hash intents in TypeScript; the contract hashes them in Solidity. If the
 * two ever disagree by one field, every signature the app produces becomes unspendable and
 * nothing else in either test suite would notice. This is the only thing that binds them.
 *
 * The file it writes is committed, and CI fails if a run changes it. Regenerate whenever the
 * Intent struct changes; the TypeScript test then fails until the codec is changed to match.
 *
 * Every number goes out as a string. A JSON number cannot hold 1e23 without losing digits, and
 * a fixture that quietly rounds is worse than no fixture.
 */
contract FixtureTest is Test {
    string constant OUT = "../app/src/lib/__fixtures__/eip712.json";

    function test_WriteEip712Fixture() public {
        vm.chainId(369);
        ProveSettlement settlement = newSettlement(NO_PERMIT2);
        ProveSettlement.Intent memory i = _canonicalIntent();

        string memory root = "root";
        vm.serializeString(
            root, "_comment", "Written by contracts/test/Fixture.t.sol. Do not edit by hand."
        );
        vm.serializeUint(root, "chainId", 369);
        vm.serializeAddress(root, "verifyingContract", address(settlement));
        vm.serializeBytes32(root, "typehash", settlement.INTENT_TYPEHASH());
        vm.serializeBytes32(root, "domainSeparator", settlement.domainSeparator());
        vm.serializeBytes32(root, "digest", settlement.hashIntent(i));
        vm.serializeString(root, "intent", _intentJson(i));
        vm.serializeString(root, "rfq", _rfqJson(settlement, i));
        vm.serializeString(root, "flags", _flagsJson(settlement));
        vm.serializeString(root, "reasons", _reasonsJson());
        vm.serializeString(root, "minOutAt", _curveJson(settlement, i));
        string memory out = vm.serializeString(root, "quoteAtStart", _quoteJson(settlement, i));

        vm.writeJson(out, OUT);
        emit log(string.concat("wrote ", OUT));
    }

    function _canonicalIntent() private pure returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: 0x1111111111111111111111111111111111111111,
            recipient: 0x2222222222222222222222222222222222222222,
            tokenIn: 0xA1077a294dDE1B09bB078844df40758a5D0f9a27,
            tokenOut: 0x95B303987A60C71504D99Aa1b13B4DA07b0790ab,
            amountIn: 100_000e18,
            minOutStart: 3_000e18,
            minOutEnd: 1_500e18,
            startTime: 1_700_000_000,
            endTime: 1_700_003_600,
            executor: 0x3333333333333333333333333333333333333333,
            /**
             * Distinct and non-zero, like every other address here, and for the reason they are.
             *
             * Not to catch a dropped field — the typehash already does that, because it hashes
             * the type string and `abi.encode` gives a zero address a full 32-byte word like any
             * other. What a zero here would hide is a field plumbed as a constant instead of
             * passed through. That happened while this field was being added: the SDK's
             * `intentHashOf` briefly wrote `feeConfig: ZERO`, and against a zero fixture every test
             * on both sides still passed.
             */
            feeConfig: feeCfg(0x4444444444444444444444444444444444444444),
            /**
             * Negative, and that is the point of the value.
             *
             * `feeRate` is the only signed member of the struct, so it is the only one a client
             * can encode with the wrong sign extension and still produce a well-formed digest.
             * The rate was `int16` once, and this fixture carried -25 to pin the sign extension
             * EIP-712 lays down for a negative word. `uint64` has no sign, so that hazard is
             * gone and the fixture now carries the thing worth pinning instead: a rate that is
             * not a round number of the old unit, so a client that still thinks in basis points
             * cannot reproduce this hash by accident.
             *
             * 25 basis points was 25. It is 0.0025e18 now, and the two are the same rate.
             */
            feeRate: 0.0025e18,
            feeRateIn: 0.0005e18,
            feeRateProceeds: 0.001e18,
            /**
             * Non-zero, and not a round fraction of `amountIn`.
             *
             * Zero is the default and the default is what a client that dropped the field would
             * produce, so a zero here would pin nothing: every side would agree on a hash neither
             * had really computed. A real floor makes a dropped `minFill` a different digest.
             */
            minFill: 5_000e18,
            /**
             * Non-zero, and not the intent's own hash.
             *
             * Zero is the default and means "use the hash", so a zero here would pin nothing: a
             * client that dropped the field would still agree. A named nonce makes a dropped
             * `authNonce` a different digest, which is the only thing this fixture is for.
             */
            authNonce: keccak256("a nonce two intents can share"),
            /**
             * `FLAG_PARTIAL | FLAG_ESCROW | KIND_STRETCH` — 1, 2 and 8.
             *
             * The kind bits are private to the settlement, so nothing here can read them off the
             * contract the way `_flagsJson` reads the custody rungs. What pins them instead is
             * the answer: the `minOutAt` block below samples this curve at ten instants, and a
             * client that reads the wrong bit prices the straight line and reproduces none of
             * the eight in the middle. That is the stronger pin of the two, because it also
             * catches a client that knows the bit and gets the arithmetic wrong.
             */
            flags: 3 | 8,
            nonce: 42,
            /**
             * `startF = 16384`, `lenF = 16384` — flat a quarter, dutch a quarter, flat a half.
             *
             * Non-zero, for the reason `minFill` and `authNonce` are: a zero word is what a
             * client that dropped the field would produce, so a zero here would pin nothing.
             * A zero word is also the straight line exactly, so it would pin no arithmetic
             * either — the one value of this field that witnesses nothing at all.
             *
             * Both corners are fractions of 65,535 rather than of the window, so neither falls
             * on a round second: the fall starts 900.02 seconds in and ends 1,800.04 seconds in,
             * against a 3,600-second window. A mirror that works in percentages of the window
             * agrees with this fixture nowhere.
             */
            curve: bytes32(uint256(16_384) << 240 | uint256(16_384) << 224)
        });
    }

    /**
     * The three custody bits, read off the contract that defines them.
     *
     * `sdk/src/intent.ts` types them out again, and the app and the e2e scripts read them from
     * there. A bit is one character. Nothing in either suite compares the two numbers, so a
     * fourth rung taking bit 2 for itself would leave every permit2 intent in the app signing
     * for escrow, and both suites would stay green.
     */
    function _flagsJson(ProveSettlement settlement) private returns (string memory) {
        string memory k = "flags";
        vm.serializeUint(k, "partial", settlement.FLAG_PARTIAL());
        vm.serializeUint(k, "escrow", settlement.FLAG_ESCROW());
        return vm.serializeUint(k, "permit2", settlement.FLAG_PERMIT2());
    }

    /**
     * Every member of `Reason`, by the name the compiler knows and the number it hands out.
     *
     * `fillability` answers with the ordinal and nothing else, so the number is a wire format and
     * `FILL_REASONS` in `sdk/src/settlement.ts` is a client mirroring it by position. Insert a
     * member anywhere but the end and every reason after it is renamed at once — the solver reads
     * `EscrowShort` as "not now" and would start reading `BadSignature` that way instead.
     *
     * The names here are compile-checked: rename a member and this file stops building. The count
     * comes from `type(Reason).max`, so a member appended and not listed here is caught too, which
     * is the one case a hand-written list cannot catch on its own.
     */
    function _reasonsJson() private returns (string memory) {
        string memory k = "reasons";
        vm.serializeUint(k, "count", uint256(type(ProveSettlement.Reason).max) + 1);
        vm.serializeUint(k, "Ok", uint256(ProveSettlement.Reason.Ok));
        vm.serializeUint(k, "BadTerms_", uint256(ProveSettlement.Reason.BadTerms_));
        vm.serializeUint(k, "NotStarted", uint256(ProveSettlement.Reason.NotStarted));
        vm.serializeUint(k, "Expired", uint256(ProveSettlement.Reason.Expired));
        vm.serializeUint(k, "Cancelled", uint256(ProveSettlement.Reason.Cancelled));
        vm.serializeUint(k, "NonceTooLow", uint256(ProveSettlement.Reason.NonceTooLow));
        vm.serializeUint(k, "WrongExecutor", uint256(ProveSettlement.Reason.WrongExecutor));
        vm.serializeUint(k, "NothingToFill", uint256(ProveSettlement.Reason.NothingToFill));
        vm.serializeUint(k, "TooMuch", uint256(ProveSettlement.Reason.TooMuch));
        vm.serializeUint(k, "PartialNotAllowed", uint256(ProveSettlement.Reason.PartialNotAllowed));
        vm.serializeUint(k, "EscrowShort", uint256(ProveSettlement.Reason.EscrowShort));
        vm.serializeUint(k, "BadSignature", uint256(ProveSettlement.Reason.BadSignature));
        vm.serializeUint(k, "FeeTooHigh_", uint256(ProveSettlement.Reason.FeeTooHigh_));
        vm.serializeUint(k, "BelowMinFill_", uint256(ProveSettlement.Reason.BelowMinFill_));
        return vm.serializeUint(
            k, "TokenOutUnreadable", uint256(ProveSettlement.Reason.TokenOutUnreadable)
        );
    }

    /**
     * The venue's binding, pinned the same way and for a sharper reason.
     *
     * An exclusive quote carries two signatures over two domains. The intent's domain is bound
     * above. The binding's was bound by nothing: `EXCLUSIVE_TYPES` in `sdk/src/rfq.ts` is a
     * hand-written copy of `EXCLUSIVE_TYPEHASH`, and `rfq.test.ts` checked it against a second
     * hand-written copy of the same string. Two copies of one mistake agree. Rename a field here
     * and both TypeScript suites stay green while the chain rejects every binding they sign.
     *
     * `intentHash` is the fixture intent's own digest, so the two domains are bound to each other
     * as well: a client that hashes the intent wrongly cannot reach this binding's digest either.
     */
    function _rfqJson(ProveSettlement settlement, ProveSettlement.Intent memory i)
        private
        returns (string memory)
    {
        RfqVenue venue = new RfqVenue(address(settlement));
        RfqVenue.Exclusive memory ex = RfqVenue.Exclusive({
            intentHash: settlement.hashIntent(i),
            counterparty: 0x5555555555555555555555555555555555555555,
            // A third of the quote, and not a round fraction of `amountIn`. A binding is spent
            // once, so a client that dropped `take` would release the whole quote — and against a
            // fixture that took all of it, that client would still agree on the digest.
            take: 33_333e18,
            // Thirty seconds after the intent opens. An RFQ is firm for seconds; the intent's own
            // hour is far too long, and a fixture carrying `endTime` here would hide a client
            // that read the wrong field.
            expiry: uint64(i.startTime) + 30,
            // Not one, and not the intent's nonce. Both are values a client could reach by
            // accident.
            nonce: 7
        });

        string memory k = "rfq";
        vm.serializeAddress(k, "verifyingContract", address(venue));
        vm.serializeBytes32(k, "typehash", venue.EXCLUSIVE_TYPEHASH());
        vm.serializeBytes32(k, "domainSeparator", venue.domainSeparator());
        vm.serializeBytes32(k, "digest", venue.hashExclusive(ex));
        vm.serializeString(k, "intentHash", vm.toString(ex.intentHash));
        vm.serializeAddress(k, "counterparty", ex.counterparty);
        vm.serializeString(k, "take", vm.toString(ex.take));
        vm.serializeString(k, "expiry", vm.toString(uint256(ex.expiry)));
        return vm.serializeString(k, "nonce", vm.toString(ex.nonce));
    }

    function _intentJson(ProveSettlement.Intent memory i) private returns (string memory) {
        string memory k = "intent";
        vm.serializeAddress(k, "maker", i.maker);
        vm.serializeAddress(k, "recipient", i.recipient);
        vm.serializeAddress(k, "tokenIn", i.tokenIn);
        vm.serializeAddress(k, "tokenOut", i.tokenOut);
        vm.serializeString(k, "amountIn", vm.toString(i.amountIn));
        vm.serializeString(k, "minOutStart", vm.toString(i.minOutStart));
        vm.serializeString(k, "minOutEnd", vm.toString(i.minOutEnd));
        vm.serializeString(k, "startTime", vm.toString(uint256(i.startTime)));
        vm.serializeString(k, "endTime", vm.toString(uint256(i.endTime)));
        vm.serializeAddress(k, "executor", i.executor);
        vm.serializeBytes32(k, "feeConfig", i.feeConfig);
        vm.serializeString(k, "feeRate", vm.toString(uint256(i.feeRate)));
        vm.serializeString(k, "feeRateIn", vm.toString(uint256(i.feeRateIn)));
        vm.serializeString(k, "feeRateProceeds", vm.toString(uint256(i.feeRateProceeds)));
        vm.serializeString(k, "minFill", vm.toString(i.minFill));
        vm.serializeString(k, "authNonce", vm.toString(i.authNonce));
        vm.serializeString(k, "flags", vm.toString(uint256(i.flags)));
        vm.serializeString(k, "nonce", vm.toString(i.nonce));
        return vm.serializeString(k, "curve", vm.toString(i.curve));
    }

    /**
     * The curve, sampled segment by segment rather than only at its ends.
     *
     * Three points used to be enough, because there were only ever two: a straight line is
     * pinned by its endpoints, and a midpoint says nothing a client could get wrong on its own.
     * A stretch has three regions and two corners, and every one of them is a place a mirror can
     * disagree — a client that clamps at the wrong fraction, rounds the wrong way, or reads the
     * fall as a fraction of the window rather than of 65,535 matches the endpoints and misses
     * all of these.
     *
     * So the samples are one per region and one either side of each corner:
     *
     *   start, flatEarly       the opening flat, where the price rests at the ceiling
     *   corner1, afterCorner1  the last second of that flat, and the first of the fall
     *   fallMid                the middle of the fall
     *   beforeCorner2          the last second of the fall, a shade above the floor
     *   corner2, flatLate      the closing flat, where it rests at the floor
     *   end                    the close
     *
     * `midpoint` keeps its name so a reader comparing two versions of this file can see it did
     * not move. It sits inside the closing flat now rather than half way down, which is the
     * whole point of the shape.
     */
    function _curveJson(ProveSettlement settlement, ProveSettlement.Intent memory i)
        private
        returns (string memory)
    {
        string memory k = "minOutAt";
        uint256 t0 = uint256(i.startTime);
        vm.serializeString(k, "start", vm.toString(settlement.minOutAt(i, t0)));
        vm.serializeString(k, "flatEarly", vm.toString(settlement.minOutAt(i, t0 + 450)));
        vm.serializeString(k, "corner1", vm.toString(settlement.minOutAt(i, t0 + 900)));
        vm.serializeString(k, "afterCorner1", vm.toString(settlement.minOutAt(i, t0 + 901)));
        vm.serializeString(k, "fallMid", vm.toString(settlement.minOutAt(i, t0 + 1_350)));
        vm.serializeString(k, "beforeCorner2", vm.toString(settlement.minOutAt(i, t0 + 1_800)));
        vm.serializeString(k, "corner2", vm.toString(settlement.minOutAt(i, t0 + 1_801)));
        vm.serializeString(k, "midpoint", vm.toString(settlement.minOutAt(i, t0 + 2_700)));
        vm.serializeString(k, "flatLate", vm.toString(settlement.minOutAt(i, t0 + 3_400)));
        return vm.serializeString(k, "end", vm.toString(settlement.minOutAt(i, i.endTime)));
    }

    /**
     * The split, and the one wei that decides which way it rounds.
     *
     * `delivered + fee` is the gross the curve asks for, and `fee` is the rate on that gross
     * rounded **down**, so the dust of the division stays with the maker. A mirror that rounded
     * up would be a wei out on every fill that does not divide, and nothing else binds the two
     * languages on the direction.
     *
     * **The odd wei on `take` is what makes this fixture able to tell the two apart.** At a round
     * 33,333 token A the gross is 999.99 token B and 25 basis points of it is exactly
     * 2.499975 token B — no remainder, so a ceiling and a floor produce the same number and the
     * fixture witnesses nothing. One wei more of `take` raises the gross by a wei, leaves a
     * remainder of 2.5e15 in the division, and the two directions disagree by one. The assertion
     * below refuses to write a fixture where that stops being true.
     */
    function _quoteJson(ProveSettlement settlement, ProveSettlement.Intent memory i)
        private
        returns (string memory)
    {
        uint256 take = 33_333e18 + 1;
        TakePoints.Quote memory q = settlement.quote(i, take, i.startTime);
        (uint256 rateIn, uint256 rate, uint256 rateProceeds) = ratesOf(i);

        // All three rates are non-zero in the canonical intent, so every field below is
        // witnessed by something. A fixture where one point charges nothing cannot tell a
        // mirror that forgot that point from one that has it.
        assertTrue(rateIn != 0 && rate != 0 && rateProceeds != 0, "every take point charges");
        assertTrue(q.feeIn != 0 && q.feeOut != 0 && q.feeProceeds != 0, "and each fee is non-zero");
        assertEq(q.delivered, q.owedToMaker - q.feeProceeds, "the maker bears only P3");
        assertEq(q.owed, q.owedToMaker + q.feeOut, "the solver bears P2 on top");
        assertEq(q.usable, q.take - q.feeIn, "and P1 comes off what it receives");

        string memory k = "quoteAtStart";
        vm.serializeString(k, "take", vm.toString(take));
        vm.serializeString(k, "rateIn", vm.toString(rateIn));
        vm.serializeString(k, "rate", vm.toString(rate));
        vm.serializeString(k, "rateProceeds", vm.toString(rateProceeds));
        vm.serializeString(k, "feeIn", vm.toString(q.feeIn));
        vm.serializeString(k, "usable", vm.toString(q.usable));
        vm.serializeString(k, "owedToMaker", vm.toString(q.owedToMaker));
        vm.serializeString(k, "feeOut", vm.toString(q.feeOut));
        vm.serializeString(k, "feeProceeds", vm.toString(q.feeProceeds));
        vm.serializeString(k, "delivered", vm.toString(q.delivered));
        return vm.serializeString(k, "owed", vm.toString(q.owed));
    }

    // ── A TypeScript signature, on chain ─────────────────────────────────────

    /**
     * @dev The settlement this file's fixture is written against.
     *
     * Deployed, not written down: `test_WriteEip712Fixture` builds it with these constructor
     * arguments as the first `new` of its test, and forge resets state between tests, so the
     * deployment below lands on the same address. The assertion says so out loud, because every
     * value under it is only meaningful if it did — the domain separator carries this address.
     */
    address constant VERIFYING_CONTRACT = 0x5615dEB798BB3E4dFa0139dFa1b3D433Cc23b72f;

    /**
     * @dev Anvil's first published account, which signed the vector below.
     *
     * The key is `0xac09…ff80`, published in every foundry document and already in this
     * repository — `app/scripts/lab/up.sh` signs the whole local lab with it and
     * `docs/ADDRESSES.md` names it. It holds nothing on any real chain and is here so anybody can
     * reproduce the signature rather than trust it.
     */
    address constant TS_SIGNER = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    /// @dev `hashTypedData` in viem, over `_canonicalIntent()` with `maker` set to `TS_SIGNER`.
    bytes32 constant TS_DIGEST = 0x3fbb49a4c76f436c99dc97664bec9a08d21b649fcd854f7f5274f27deadcb4a7;

    /// @dev `account.signTypedData(...)` in viem, over that same intent and that same domain.
    bytes constant TS_SIGNATURE =
        hex"d4620e5aad5d46ea3f5428dcdc4fe4b140969b5fceae6b3cfb66fc384bc226ac51c12bc761e62ba2bb78e9c41e793f8eabd61fc63dc48a5e27a0ab8948370e401b";

    /**
     * @notice A signature made in TypeScript, checked against the digest this contract computes.
     *
     * The fixture next door pins the two languages to the same **digest**, which is most of the
     * story and not all of it. A digest is a number both sides can agree on while neither has
     * ever produced a signature the other would accept: `intentHashOf` could match perfectly and
     * the app could still sign under a domain the contract does not build, because nothing in
     * either suite ever took bytes from one language and put them through the other's verifier.
     *
     * So this takes a signature viem actually produced, over the canonical intent, under the
     * domain of the contract deployed below, and asks this contract's own recovery to name the
     * signer. That is the operation `_validSignature` performs on every fill for an ordinary
     * wallet — a 65-byte blob goes to `ECDSA.tryRecover` and the result is compared with
     * `i.maker` — so a pass here is the fill path's answer to "would you accept this".
     *
     * **`fillability` is the function you would expect this to call, and it cannot be.** The
     * signature check is the last thing `_evaluate` does, because `ecrecover` costs more than
     * every check above it combined, and the canonical intent wears `FLAG_ESCROW`. So the escrow
     * branch answers `EscrowShort` first and returns the same reason whether the signature is
     * good or gibberish — the negative case below would pass while proving nothing. Funding an
     * escrow to reach one `ecrecover` would put a token, a deposit and an approval between this
     * test and the fact it is trying to state.
     *
     * Regenerate both constants whenever `Intent` changes, the same moment the fixture is
     * regenerated: a new field moves the digest, and the old signature then recovers a stranger.
     */
    function test_ATypeScriptSignatureRecoversOnChain() public {
        vm.chainId(369);
        ProveSettlement settlement = newSettlement(NO_PERMIT2);
        assertEq(
            address(settlement),
            VERIFYING_CONTRACT,
            "the vector was signed against this address, so it has to be this address"
        );

        ProveSettlement.Intent memory i = _canonicalIntent();
        // The one field that differs from the fixture's. A signature can only be checked against
        // the maker it claims, and the fixture's maker is a literal nobody holds the key to.
        i.maker = TS_SIGNER;

        bytes32 digest = settlement.hashIntent(i);
        assertEq(digest, TS_DIGEST, "Solidity and TypeScript hash this intent the same way");

        (bytes32 r, bytes32 s, uint8 v) = _split(TS_SIGNATURE);
        assertEq(ecrecover(digest, v, r, s), TS_SIGNER, "and this chain accepts what viem signed");

        /*
         * The negative, because the assertion above passes for a test that recovers nothing.
         *
         * `ecrecover` answers `address(0)` for a signature it cannot use, and `address(0)` is not
         * `TS_SIGNER`, so a check that only ever compared those two would look identical whether
         * the vector was real or sixty-five zero bytes. One flipped byte in `s` is still a
         * well-formed signature and recovers a different address, which is the thing a settlement
         * has to refuse.
         */
        bytes memory tampered = TS_SIGNATURE;
        tampered[40] = bytes1(uint8(tampered[40]) ^ 0x01);
        (bytes32 r2, bytes32 s2, uint8 v2) = _split(tampered);
        assertTrue(
            ecrecover(digest, v2, r2, s2) != TS_SIGNER, "a tampered signature names somebody else"
        );
    }

    /// @dev `r ‖ s ‖ v`, the layout every wallet returns and `_validSignature` reads.
    function _split(bytes memory sig) private pure returns (bytes32 r, bytes32 s, uint8 v) {
        require(sig.length == 65, "a key's signature is sixty-five bytes");
        assembly {
            r := mload(add(sig, 0x20))
            s := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
    }
}
