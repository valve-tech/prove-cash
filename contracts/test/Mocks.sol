// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IProveCallback} from "../src/interfaces/IProveCallback.sol";
import {IProveBatchCallback} from "../src/interfaces/IProveBatchCallback.sol";
import {IPulseXRouter} from "../src/interfaces/IPulseXRouter.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ISignatureTransfer} from "../src/interfaces/IPermit2.sol";

// "I accept whatever fee is configured." Every fill takes a fee bound; most tests are not about
// the bound, and saying so once beats repeating a magic number.
uint256 constant ANY_FEE = type(uint256).max;

// What a test hands the settlement for Permit2 when it never touches that rung.
//
// The constructor refuses a zero, so every deployment names something — and a test that only ever
// fills through an approval, an escrow, an authorization or a permit has no opinion about which
// address that is. This one has no code, so a permit2 leg armed against it fails inside the call
// and reads `EscrowShort` rather than settling quietly on a rung the test never set up.
//
// A test that does exercise the rung deploys `MockPermit2` and passes that instead.
address constant NO_PERMIT2 = address(0x2612);

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice An x402-shaped 1:1 wrapper: same decimals, redeemable at par, never worth routing.
contract MockWrapper is ERC20 {
    address public immutable underlying;
    uint8 private immutable _decimals;

    constructor(address _underlying, uint8 d) ERC20("Wrapped", "xTKN") {
        underlying = _underlying;
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function wrap(uint256 amount) external {
        IERC20(underlying).transferFrom(msg.sender, address(this), amount);
        _mint(msg.sender, amount);
    }

    function unwrap(uint256 amount) external {
        _burn(msg.sender, amount);
        IERC20(underlying).transfer(msg.sender, amount);
    }
}

/// @notice A UniswapV2-shaped router with a fixed price, enough to prove the routing paths.
contract MockRouter {
    /// @dev out = in * rateNum / rateDen, for any pair. Liquidity comes from its own balance.
    uint256 public rateNum = 2;
    uint256 public rateDen = 1;

    /// @dev A third token paid alongside the swap, the way a keeper tip or a reward arrives.
    address public tipToken;
    uint256 public tipAmount;

    function setTip(address token, uint256 amount) external {
        tipToken = token;
        tipAmount = amount;
    }

    function setRate(uint256 num, uint256 den) external {
        rateNum = num;
        rateDen = den;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        external
        view
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 1; i < path.length; i++) {
            amounts[i] = (amounts[i - 1] * rateNum) / rateDen;
        }
    }

    /**
     * @notice The supporting variant, the one a caller uses on a token that taxes its transfers.
     * @dev The difference that matters is one line: the output is priced from what ACTUALLY
     *      arrived, not from `amountIn`. A fee-on-transfer token delivers less than it was asked
     *      for, and a real pair notices — this is where that shows up.
     */
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        uint256 before = IERC20(path[0]).balanceOf(address(this));
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        uint256 arrived = IERC20(path[0]).balanceOf(address(this)) - before;

        uint256 out = arrived;
        for (uint256 i = 1; i < path.length; i++) {
            out = (out * rateNum) / rateDen;
        }
        IERC20(path[path.length - 1]).transfer(to, out);
        // The real router checks the recipient's own delta rather than its computed number.
        // Ours is the same claim, made where a mock can make it.
        require(out >= amountOutMin, "MockRouter: slippage");
        _tip();
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 1; i < path.length; i++) {
            amounts[i] = (amounts[i - 1] * rateNum) / rateDen;
        }
        uint256 out = amounts[path.length - 1];
        require(out >= amountOutMin, "MockRouter: slippage");
        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        IERC20(path[path.length - 1]).transfer(to, out);
        _tip();
    }

    function _tip() private {
        // A tip pays whoever called, not the trade's recipient — which is how a keeper reward
        // or a router rebate actually arrives, and why it lands somewhere nobody swept.
        if (tipToken != address(0) && tipAmount > 0) {
            uint256 tip = tipAmount;
            tipAmount = 0;
            IERC20(tipToken).transfer(msg.sender, tip);
        }
    }
}

/**
 * @notice A UniswapV2 pair, close enough to the real one where it matters: constant product,
 *         reserves taken from its own balances, and a price counter that grows with elapsed time
 *         in UQ112x112. The counter wraps, as the real one does.
 *
 * There is no swap fee. The fee would only shift every number in these tests by the same 0.3%,
 * and the price floors are what the tests are about.
 */
contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;

    uint112 private _reserve0;
    uint112 private _reserve1;
    uint32 private _blockTimestampLast;

    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_reserve0, _reserve1, _blockTimestampLast);
    }

    /// @notice Take whatever has been sent in as the new reserves. Adding liquidity, V2-style.
    function sync() external {
        _update();
    }

    /**
     * @notice Pay out, then check k, the way a real pair does.
     *
     * The k check used to be missing here and it hid a real defect: `swapExactTokensForTokens`
     * prices every hop from `amountIn` and tells the pair to pay that out, so a fee-on-transfer
     * token — which arrives short — makes the product fall and a real pair reverts with
     * `UniswapV2: K`. Without the check the mock completed the sale, and the fee disposal matrix
     * could only measure the product falling and say in prose what a real pair would have done.
     *
     * There is still no swap fee, so the test is `k` not decreasing rather than the real pair's
     * `k` growing by the fee. That is the weaker claim and it is the one this mock can make.
     */
    function swap(uint256 amount0Out, uint256 amount1Out, address to) external {
        uint256 k = uint256(_reserve0) * uint256(_reserve1);
        if (amount0Out > 0) IERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).transfer(to, amount1Out);
        uint256 b0 = IERC20(token0).balanceOf(address(this));
        uint256 b1 = IERC20(token1).balanceOf(address(this));
        require(k == 0 || b0 * b1 >= k, "MockV2: K");
        _update();
    }

    /// @notice Put the counters wherever a test needs them, including one trade short of wrapping.
    function seedCumulative(uint256 c0, uint256 c1) external {
        price0CumulativeLast = c0;
        price1CumulativeLast = c1;
    }

    function _update() private {
        unchecked {
            uint32 t = uint32(block.timestamp);
            uint32 elapsed = t - _blockTimestampLast;
            if (elapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                price0CumulativeLast += ((uint256(_reserve1) << 112) / _reserve0) * elapsed;
                price1CumulativeLast += ((uint256(_reserve0) << 112) / _reserve1) * elapsed;
            }
            _reserve0 = uint112(IERC20(token0).balanceOf(address(this)));
            _reserve1 = uint112(IERC20(token1).balanceOf(address(this)));
            _blockTimestampLast = t;
        }
    }
}

/// @notice The factory the router names its pairs through.
contract MockV2Factory {
    mapping(address => mapping(address => address)) public getPair;

    /**
     * @notice Where this venue sends its own cut, the way PulseX's factory names a buy-and-burn.
     *
     * Nothing here pays it: these pairs take no swap fee, so there is no cut to send. It exists
     * because the registry records a `feeTo` per chain and a probe that asks the factory for it
     * should get an address rather than a revert. A lab that answers nothing to a question the
     * live chains answer is a lab that cannot run the same check.
     */
    address public feeTo;

    function setFeeTo(address to) external {
        feeTo = to;
    }

    function createPair(address a, address b) external returns (address pair) {
        pair = address(new MockV2Pair(a, b));
        getPair[a][b] = pair;
        getPair[b][a] = pair;
    }
}

/**
 * @notice A router over real pairs: it quotes from reserves and settles through the pool.
 *
 * @dev It pulls the way the real one does. UniswapV2 and PulseX both take the maker's tokens
 *      through `TransferHelper.safeTransferFrom`, which accepts an empty return buffer — so a
 *      USDT-shaped token routes fine on chain. A mock that pulled with a plain `IERC20`
 *      `transferFrom` would revert on that token, which makes the fixture STRICTER than the
 *      deployment and turns a supported token into an unsupported one in the test suite.
 */
contract MockV2Router {
    address public immutable factory;

    constructor(address _factory) {
        factory = _factory;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path)
        public
        view
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 1; i < path.length; i++) {
            (uint256 rIn, uint256 rOut) = _reserves(path[i - 1], path[i]);
            amounts[i] = (amounts[i - 1] * rOut) / (rIn + amounts[i - 1]);
        }
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        amounts = getAmountsOut(amountIn, path);
        require(amounts[path.length - 1] >= amountOutMin, "MockV2: slippage");

        _pull(path[0], _pair(path[0], path[1]), amountIn);
        for (uint256 i = 0; i + 1 < path.length; i++) {
            MockV2Pair pair = MockV2Pair(_pair(path[i], path[i + 1]));
            address next = i + 2 < path.length ? _pair(path[i + 1], path[i + 2]) : to;
            (uint256 out0, uint256 out1) = path[i] == pair.token0()
                ? (uint256(0), amounts[i + 1])
                : (amounts[i + 1], uint256(0));
            pair.swap(out0, out1, next);
        }
    }

    /**
     * @notice The supporting variant, the one a caller uses on a token that taxes its transfers.
     * @dev The one difference: each hop is priced from `balanceOf(pair) - reserve`, so the amount
     *      is what the pair actually received. A taxed token then sells for what arrived instead
     *      of asking the pair to pay out on tokens it never got — which the k check refuses.
     */
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        _pull(path[0], _pair(path[0], path[1]), amountIn);
        uint256 last;
        for (uint256 i = 0; i + 1 < path.length; i++) {
            MockV2Pair pair = MockV2Pair(_pair(path[i], path[i + 1]));
            (uint256 rIn, uint256 rOut) = _reserves(path[i], path[i + 1]);
            uint256 got = IERC20(path[i]).balanceOf(address(pair)) - rIn;
            last = (got * rOut) / (rIn + got);
            address next = i + 2 < path.length ? _pair(path[i + 1], path[i + 2]) : to;
            (uint256 out0, uint256 out1) =
                path[i] == pair.token0() ? (uint256(0), last) : (last, uint256(0));
            pair.swap(out0, out1, next);
        }
        require(last >= amountOutMin, "MockV2: slippage");
    }

    /**
     * @dev `TransferHelper.safeTransferFrom`, copied from the router this stands in for.
     *
     * A raw call, and success is "it did not revert AND (it said nothing OR it said true)". The
     * middle clause is the one that matters: it is how a real router carries USDT.
     */
    function _pull(address token, address to, uint256 value) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeCall(IERC20.transferFrom, (msg.sender, to, value)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TransferHelper: FROM");
    }

    function _pair(address a, address b) private view returns (address) {
        return MockV2Factory(factory).getPair(a, b);
    }

    function _reserves(address tokenIn, address tokenOut) private view returns (uint256, uint256) {
        MockV2Pair pair = MockV2Pair(_pair(tokenIn, tokenOut));
        (uint112 r0, uint112 r1,) = pair.getReserves();
        return tokenIn == pair.token0() ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
    }
}

/**
 * @notice The executor side of `fillWithCallback`, as every bot below shares it.
 *
 * The caller is the callback target, so a test drives a callback fill through `settle` instead
 * of pranking an EOA. And the contract pulls the payment, so an executor never transfers to the
 * recipient or the sink itself: it ends the callback holding token B, with an allowance in place.
 */
abstract contract CallbackExecutor is IProveCallback {
    /// @dev What the last `settle` spent, measured from inside this frame. The gas report reads
    ///      it so the mock's own dispatch does not land in the number.
    uint256 public lastGas;

    function approveMax(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    function settle(
        ProveSettlement s,
        ProveSettlement.Intent calldata i,
        bytes calldata signature,
        uint256 take,
        bytes calldata data,
        uint256 maxFeeRate
    ) external {
        uint256 g = gasleft();
        s.fillWithCallback(i, signature, take, data, maxFeeRate);
        lastGas = g - gasleft();
    }
}

/// @notice An executor holding no inventory: it receives token A, sells it at the router, and
///         stands good for token B out of the proceeds.
/// @dev Just enough of `ProveSettlement` for a callback to find the address that will pull it.
interface IProveSettlementRelayer {
    function relayer() external view returns (address);
}

contract RoutingExecutor is CallbackExecutor {
    IPulseXRouter public immutable router;
    address public immutable settlement;

    /// @dev Takes a router address, not a mock, so the same bot runs against the real PulseX
    ///      router in the fork tests.
    constructor(address _router, address _settlement) {
        router = IPulseXRouter(_router);
        settlement = _settlement;
    }

    function proveCallback(address, Terms calldata t, bytes calldata) external {
        address[] memory path = new address[](2);
        path[0] = t.tokenIn;
        path[1] = t.tokenOut;
        IERC20(t.tokenIn).approve(address(router), t.amountIn);
        router.swapExactTokensForTokens(t.amountIn, 0, path, address(this), block.timestamp);

        // The relayer pulls what the settlement is owed, so the bot allows the relayer. It reads
        // the address off the contract that called it, which is what a real executor does.
        IERC20(t.tokenOut).approve(IProveSettlementRelayer(msg.sender).relayer(), t.owed);
        // The handover fee that is physically here (approval rung) goes back through the relayer.
        if (t.feeInDue != 0) {
            IERC20(t.tokenIn).approve(IProveSettlementRelayer(msg.sender).relayer(), t.feeInDue);
        }
    }
}

/// @notice An executor that pays out of its own stock. It holds token B and approves once, so
///         the callback itself does nothing and the gas report measures the contract.
contract PayingExecutor is CallbackExecutor {
    function proveCallback(address, Terms calldata, bytes calldata) external {}
}

/// @notice Gifts the recipient the full delivery before the contract pulls. Under a balance
///         delta the gift discharged the debt; under a pull it is just a gift.
contract DonatingExecutor is CallbackExecutor {
    function proveCallback(address, Terms calldata t, bytes calldata data) external {
        (address to, uint256 amount) = abi.decode(data, (address, uint256));
        IERC20(t.tokenOut).transfer(to, amount);
    }
}

/// @notice Stands good for one wei less than it owes.
contract UnderpayingExecutor is CallbackExecutor {
    function proveCallback(address, Terms calldata t, bytes calldata) external {
        IERC20(t.tokenOut).approve(IProveSettlementRelayer(msg.sender).relayer(), t.owed - 1);
    }
}

/// @notice Stands good for the delivery and nothing for the fee. `data` carries the split,
///         which the callback is not otherwise told.
contract SinkStiffingExecutor is CallbackExecutor {
    function proveCallback(address, Terms calldata t, bytes calldata data) external {
        IERC20(t.tokenOut)
            .approve(IProveSettlementRelayer(msg.sender).relayer(), abi.decode(data, (uint256)));
    }
}

/// @notice Tries to fill the same intent again from inside the callback.
contract ReentrantExecutor is CallbackExecutor {
    ProveSettlement public immutable settlement;

    constructor(ProveSettlement _settlement) {
        settlement = _settlement;
    }

    function proveCallback(address, Terms calldata, bytes calldata data) external {
        (ProveSettlement.Intent memory intent, bytes memory signature, uint256 take) =
            abi.decode(data, (ProveSettlement.Intent, bytes, uint256));
        settlement.fill(intent, signature, take, ANY_FEE);
    }
}

/**
 * @notice From inside the callback, knocks on every guarded door and counts the refusals.
 *
 * The guard is one modifier, but the compiler writes a copy of it into every function that wears
 * it. One test per copy is the only way to know they all hold. The refusals are counted rather
 * than thrown, so the outer fill still completes and the test can assert both halves.
 */
contract ReentryProbe is CallbackExecutor {
    ProveSettlement public immutable settlement;
    uint256 public refusals;

    constructor(ProveSettlement s) {
        settlement = s;
    }

    function proveCallback(address, Terms calldata, bytes calldata data) external {
        (ProveSettlement.Intent memory intent, bytes memory sig) =
            abi.decode(data, (ProveSettlement.Intent, bytes));

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = ProveSettlement.FillRequest({intent: intent, signature: sig, take: 1, arming: ""});

        uint256 n;
        if (_refused(abi.encodeCall(ProveSettlement.fill, (intent, sig, 1, ANY_FEE)))) n++;
        if (_refused(abi.encodeCall(ProveSettlement.fillBatch, (reqs, false, ANY_FEE)))) n++;
        if (_refused(
                abi.encodeCall(ProveSettlement.fillWithCallback, (intent, sig, 1, "", ANY_FEE))
            )) {
            n++;
        }
        if (_refused(abi.encodeCall(ProveSettlement.deposit, (intent, 1)))) n++;
        if (_refused(abi.encodeCall(ProveSettlement.withdraw, (intent)))) n++;
        refusals = n;
    }

    /// @dev True when the settlement contract answered with `Reentrant` and nothing else.
    function _refused(bytes memory payload) private returns (bool) {
        (bool ok, bytes memory err) = address(settlement).call(payload);
        if (ok || err.length < 4) return false;
        bytes4 selector;
        assembly ("memory-safe") {
            selector := mload(add(err, 0x20))
        }
        return selector == ProveSettlement.Reentrant.selector;
    }
}

/// @notice Records every selector the settlement contract says to it. Used to prove that the
///         contract only ever speaks through a selector it chose itself.
contract Recorder is CallbackExecutor {
    bytes4 public lastSelector;
    bytes public lastData;

    function proveCallback(address, Terms calldata, bytes calldata data) external {
        lastSelector = IProveCallback.proveCallback.selector;
        lastData = data;
    }

    /// @dev Anything the contract says that is not `proveCallback` lands here. Nothing does.
    fallback(bytes calldata data) external returns (bytes memory) {
        lastSelector = bytes4(data);
        return "";
    }
}

/// @notice A smart-contract maker that signs through ERC-1271.
contract SmartWallet is IERC1271 {
    address public immutable signer;

    constructor(address _signer) {
        signer = _signer;
    }

    /**
     * @dev Both signature widths, because a real wallet answers both.
     *
     * OpenZeppelin's `tryRecover(bytes32,bytes)` takes 65 bytes and nothing else. EIP-2098's
     * compact form is 64 — the parity folded into the top bit of `s` — and it needs the `r, vs`
     * overload. A wallet that refused it would make every compact signature look like a bad one,
     * which is exactly the mistake this contract exists to keep the settlement honest about.
     */
    function isValidSignature(bytes32 digest, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        address recovered;
        ECDSA.RecoverError err;
        if (signature.length == 64) {
            (recovered, err,) =
                ECDSA.tryRecover(digest, bytes32(signature[0:32]), bytes32(signature[32:64]));
        } else {
            (recovered, err,) = ECDSA.tryRecover(digest, signature);
        }
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return 0x1626ba7e;
        return 0xffffffff;
    }

    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }
}

/**
 * @notice ERC-7598: EIP-3009 with an unstructured signature, checked through ERC-1271.
 *
 * This is how a smart account signs a gasless transfer. It has no key, so `ecrecover` can say
 * nothing about what it signed, and the fixed 65-byte triple EIP-3009 asks for cannot express
 * its answer at all.
 *
 * It carries **both** overloads on purpose, and the legacy one recovers a key exactly as a real
 * 3009 token does — so a contract wallet's 65-byte answer reverts there and the settlement's
 * fall-through to the `bytes` overload is what makes the fill work. That fall-through is the
 * whole reason `_receive` tries rather than decides, and this token is what proves it runs.
 */
contract MockERC7598Wallet is ERC20 {
    /// @dev The `Receive` variant, because `ProveSettlement` uses the one only the recipient can
    ///      submit. A mock that kept the permissionless `Transfer` typehash would let the tests
    ///      pass against a token nobody should integrate.
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    constructor() ERC20("Wallet Auth", "WAUTH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Wallet Auth")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev The EIP-3009 overload, recovering a key like any ordinary 3009 token. A contract
    ///      wallet's signature fails here, which is the point of keeping it.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        bytes32 digest = _digest(from, to, value, validAfter, validBefore, nonce);
        require(ecrecover(digest, v, r, s) == from, "3009: bad signature");
        _redeem(from, to, value, nonce);
    }

    /// @dev The ERC-7598 overload, asking the signer itself.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        bytes32 digest = _digest(from, to, value, validAfter, validBefore, nonce);
        require(
            IERC1271(from).isValidSignature(digest, signature) == ERC1271_MAGIC,
            "7598: bad signature"
        );
        _redeem(from, to, value, nonce);
    }

    function _digest(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) private view returns (bytes32) {
        require(block.timestamp > validAfter, "3009: not yet valid");
        require(block.timestamp < validBefore, "3009: expired");
        require(!authorizationState[from][nonce], "3009: nonce used");
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
    }

    function _redeem(address from, address to, uint256 value, bytes32 nonce) private {
        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}

/// @notice A contract maker whose ERC-1271 answer reverts. The caller must read that as a
///         refusal, not carry the revert out.
contract RevertingWallet {
    error Nope();

    function isValidSignature(bytes32, bytes calldata) external pure returns (bytes4) {
        revert Nope();
    }

    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }
}

/// @notice A contract maker that answers ERC-1271 with four bytes where a word belongs.
contract MumblingWallet {
    function approveToken(address token, address spender, uint256 amount) external {
        IERC20(token).approve(spender, amount);
    }

    fallback(bytes calldata) external returns (bytes memory) {
        return hex"1626ba7e";
    }
}

/// @notice EIP-3009, implemented for real so the gasless path is tested against a real check.
contract MockERC3009 is ERC20 {
    /// @dev The `Receive` variant, because `ProveSettlement` uses the one only the recipient can
    ///      submit. A mock that kept the permissionless `Transfer` typehash would let the tests
    ///      pass against a token nobody should integrate.
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    constructor() ERC20("Auth Token", "AUTH") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("Auth Token")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp > validAfter, "3009: not yet valid");
        require(block.timestamp < validBefore, "3009: expired");
        require(!authorizationState[from][nonce], "3009: nonce used");

        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        require(ecrecover(digest, v, r, s) == from, "3009: bad signature");

        authorizationState[from][nonce] = true;
        _transfer(from, to, value);
    }
}

// ── Batch callback executors ──────────────────────────────────────────────────

/// @notice An executor that settles a whole ring through `fillBatchWithCallback`.
contract BatchExecutor is IProveBatchCallback {
    /// @dev Somewhere to source tokens from mid-callback. Zero means "use what I already hold".
    address public stash;
    /// @dev Pull this much less than asked from the stash, to test the contract's own checks.
    uint256 public short;
    /// @dev Send this much of the first line's token to its payee before the pull. A donation
    ///      must not discharge anything.
    uint256 public donate;
    /// @dev How many lines the last callback was given.
    uint256 public lastLines;
    /// @dev The data the last callback was handed, so a test can prove it arrived untouched.
    bytes public lastData;

    function setStash(address s) external {
        stash = s;
    }

    function setShort(uint256 s) external {
        short = s;
    }

    function setDonate(uint256 d) external {
        donate = d;
    }

    function approveMax(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    /// @dev The executor is the caller, so a test drives the settlement through here.
    function settle(
        ProveSettlement s,
        ProveSettlement.FillRequest[] calldata reqs,
        bool skipInvalid,
        bytes calldata data,
        uint256 maxFeeRate
    ) external returns (uint256) {
        return s.fillBatchWithCallback(reqs, skipInvalid, data, maxFeeRate);
    }

    function proveBatchCallback(Payment[] calldata owed, bytes calldata data) external {
        lastLines = owed.length;
        lastData = data;
        address from = stash;
        for (uint256 k = 0; k < owed.length; k++) {
            if (donate > 0 && k == 0) IERC20(owed[k].token).transfer(owed[k].to, donate);
            if (from == address(0)) continue;
            uint256 want = owed[k].amount + owed[k].fee;
            uint256 pull = want > short ? want - short : 0;
            if (pull > 0) IERC20(owed[k].token).transferFrom(from, address(this), pull);
        }
    }
}

/**
 * @notice The same settlement with none of the bookkeeping. The gas report uses this one, so the
 *         numbers measure the contract and not the mock.
 */
contract LeanBatchExecutor is IProveBatchCallback {
    /// @dev Gas spent inside this frame on the settlement call alone. Measured here rather than
    ///      by the test, because a test measuring `settle` would also be paying to re-encode the
    ///      whole request array as calldata a second time — which the contract never does.
    uint256 public lastGas;

    function approveMax(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    function settle(
        ProveSettlement s,
        ProveSettlement.FillRequest[] calldata reqs,
        bool skipInvalid,
        bytes calldata data,
        uint256 maxFeeRate
    ) external returns (uint256 count) {
        uint256 g = gasleft();
        count = s.fillBatchWithCallback(reqs, skipInvalid, data, maxFeeRate);
        lastGas = g - gasleft();
    }

    /// @dev It already holds inventory, exactly as the executor `fillBatch` measures against
    ///      does. Doing nothing here is what makes the two rows comparable.
    function proveBatchCallback(Payment[] calldata, bytes calldata) external {}
}

/// @notice Tries to fill again from inside the batch callback.
contract ReentrantBatchExecutor is IProveBatchCallback {
    ProveSettlement public immutable settlement;

    constructor(ProveSettlement s) {
        settlement = s;
    }

    function approveMax(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    function settle(ProveSettlement.FillRequest[] calldata reqs, bytes calldata data)
        external
        returns (uint256)
    {
        return settlement.fillBatchWithCallback(reqs, false, data, ANY_FEE);
    }

    function proveBatchCallback(Payment[] calldata, bytes calldata data) external {
        (ProveSettlement.Intent memory intent, bytes memory signature, uint256 take) =
            abi.decode(data, (ProveSettlement.Intent, bytes, uint256));
        settlement.fill(intent, signature, take, ANY_FEE);
    }
}

/// @notice Records the selector the settlement contract used, for the batch path's tripwire.
contract BatchRecorder is IProveBatchCallback {
    bytes4 public lastSelector;
    bytes public lastData;

    function approveMax(address token, address spender) external {
        IERC20(token).approve(spender, type(uint256).max);
    }

    function settle(
        ProveSettlement s,
        ProveSettlement.FillRequest[] calldata reqs,
        bytes calldata data,
        uint256 maxFeeRate
    ) external returns (uint256) {
        return s.fillBatchWithCallback(reqs, false, data, maxFeeRate);
    }

    function proveBatchCallback(Payment[] calldata, bytes calldata data) external {
        lastSelector = IProveBatchCallback.proveBatchCallback.selector;
        lastData = data;
    }
}

/**
 * @notice Permit2's SignatureTransfer half, faithfully enough to test against.
 *
 * The real thing is 9,152 bytes at `0x000000000022D473030F116dDEE9F6B43aC78BA3` on every chain
 * we run on, byte-identical. This is the part of it `ProveRelayer.pullWithPermit2` touches, and
 * nothing else — no AllowanceTransfer, no batch overloads, no witness variant.
 *
 * **A mock, not a fork.** Forking to test a custody rung would put every unit test behind an RPC
 * and behind whatever that chain's state is on the day, and it would still not exercise the
 * failures worth exercising: an expired deadline, a spent nonce, a signature made for a
 * different spender. Those are cheap here and awkward there.
 *
 * Five things about it are not simplifications, and each one is a property something leans on.
 * Get any of them wrong and this mock proves the wrong contract correct:
 *
 *   - **The domain has no version string.** Permit2's is `EIP712Domain(string name,uint256
 *     chainId,address verifyingContract)` with the name "Permit2". Every other EIP-712 domain in
 *     this repository carries a version and this one does not.
 *   - **The spender is `msg.sender`, hashed into the digest rather than read off the permit.**
 *     That is what makes a signature made for our relayer unusable by any other address, and it
 *     is the whole security argument for letting the relayer hold this call.
 *   - **The nonce is an unordered bitmap**, so any `uint256` is a valid nonce and each one is
 *     spendable once. The settlement uses the intent hash, which is what welds one signature to
 *     one offer.
 *   - **`requestedAmount` may be under `permitted.amount` and never over.** A partial fill draws
 *     only what it fills.
 *   - **The nonce is spent BEFORE the signature is checked**, exactly as
 *     `SignatureTransfer._permitTransferFrom` does it: `_useUnorderedNonce(owner, permit.nonce)`
 *     and then `signature.verify(...)`. Verified against Uniswap's source on 2026-09-02.
 *
 *     Two things rest on this line order, and only one of them is obvious. The security argument
 *     does not — `armLeg`'s unwind returns the nonce either way, which is what
 *     `Arming.t.sol:test_ABadPermit2SignatureLeavesNothingBehind` asserts. What rests on it is a
 *     NUMBER: a bad signature still pays for the cold bitmap write, and that write is a large
 *     part of the 74,353 that `one more leg with a bad signature` costs in `Gas.t.sol`. The
 *     landing page publishes that figure. Reorder these two lines as an "optimisation" and every
 *     test here still passes while the page quietly advertises less than a refusal costs.
 *
 *     The split used to read "16,482 of 69,439". Both halves are gone: `one more leg that cannot
 *     be armed` is no longer a row, and nothing measures the bitmap write on its own, so the
 *     share is stated in words rather than as a figure nothing produces.
 *   - **The transfer tolerates a token that returns nothing.** Permit2 sends it through
 *     solmate's `SafeTransferLib.safeTransferFrom`, which accepts an empty return buffer, and
 *     `SafeERC20` below accepts the same. This mock used a plain `IERC20.transferFrom` until
 *     `TokenMatrix.t.sol` added its permit2 column and the silent row failed: the token moved
 *     the money and the ABI decoder then reverted on nothing to decode. That is USDT's shape,
 *     and USDT is the asset this rung exists to reach — so the mock was refusing the one fill
 *     the real Permit2 performs. Verified against Uniswap's `SignatureTransfer.sol` and
 *     solmate's `SafeTransferLib` on 2026-09-03.
 */
contract MockPermit2 {
    using SafeERC20 for IERC20;

    bytes32 private constant TYPE_HASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Permit2");

    bytes32 public constant TOKEN_PERMISSIONS_TYPEHASH =
        keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 public constant PERMIT_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );

    /// @notice Bit `nonce & 0xff` of word `nonce >> 8`, exactly as Permit2 keeps it.
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;

    error SignatureExpired(uint256 deadline);
    error InvalidAmount(uint256 maxAmount);
    error InvalidNonce();
    error InvalidSigner();

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(TYPE_HASH, NAME_HASH, block.chainid, address(this)));
    }

    function permitTransferFrom(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        ISignatureTransfer.SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external {
        if (block.timestamp > permit.deadline) {
            revert SignatureExpired(permit.deadline);
        }
        if (transferDetails.requestedAmount > permit.permitted.amount) {
            revert InvalidAmount(permit.permitted.amount);
        }

        _useUnorderedNonce(owner, permit.nonce);

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        PERMIT_TRANSFER_FROM_TYPEHASH,
                        keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted)),
                        // The caller, never a field. A signature naming one spender is worth
                        // nothing to any other address.
                        msg.sender,
                        permit.nonce,
                        permit.deadline
                    )
                )
            )
        );
        if (!_signedBy(owner, digest, signature)) revert InvalidSigner();

        // Tolerant of an empty return buffer, exactly as Permit2's own `safeTransferFrom` is.
        IERC20(permit.permitted.token)
            .safeTransferFrom(owner, transferDetails.to, transferDetails.requestedAmount);
    }

    /// @notice Burn nonces without spending them — how a maker calls off a signature they have
    ///         already handed out. Nothing in the settlement calls this; a maker does.
    function invalidateUnorderedNonces(uint256 wordPos, uint256 mask) external {
        nonceBitmap[msg.sender][wordPos] |= mask;
    }

    function _useUnorderedNonce(address from, uint256 nonce) private {
        uint256 wordPos = nonce >> 8;
        uint256 bit = 1 << (nonce & 0xff);
        uint256 flipped = nonceBitmap[from][wordPos] ^= bit;
        // The XOR set the bit if it was clear and cleared it if it was not. A cleared bit means
        // the nonce had already been spent, which is the replay this line refuses.
        if (flipped & bit == 0) revert InvalidNonce();
    }

    /// @dev A key's 65 bytes, EIP-2098's compact 64, or an ERC-1271 answer. Permit2 accepts all
    ///      three, and a maker on this rung may well be a contract wallet.
    function _signedBy(address owner, bytes32 digest, bytes calldata signature)
        private
        view
        returns (bool)
    {
        if (owner.code.length == 0) {
            address recovered;
            ECDSA.RecoverError err;
            if (signature.length == 64) {
                (recovered, err,) =
                    ECDSA.tryRecover(digest, bytes32(signature[0:32]), bytes32(signature[32:64]));
            } else {
                (recovered, err,) = ECDSA.tryRecover(digest, signature);
            }
            return err == ECDSA.RecoverError.NoError && recovered == owner;
        }
        (bool ok, bytes memory ret) =
            owner.staticcall(abi.encodeCall(IERC1271.isValidSignature, (digest, signature)));
        return ok && ret.length >= 32 && bytes4(abi.decode(ret, (bytes32))) == 0x1626ba7e;
    }
}
