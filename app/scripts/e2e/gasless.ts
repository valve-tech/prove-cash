/**
 * The gasless path, on chain 943: the maker signs twice and sends nothing.
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     npx tsx scripts/e2e/gasless.ts
 *
 * The maker signs the intent, signs an EIP-3009 `receiveWithAuthorization` naming the intent's
 * own hash as its 3009 nonce, and broadcasts both over msgboard, which charges proof of work
 * rather than gas. An executor redeems the authorization into the intent's escrow and fills from
 * it in one transaction — through `fillWithAuthorization` here, or on a batch leg's `arming`
 * field, which is the same code behind a different door.
 *
 * The headline claim is a number, so it is asserted as a number: the maker's transaction count is
 * read before anything happens and again at the end, and it must not have moved. The maker's PLS
 * balance is checked too — an account that has never been funded cannot have paid for anything.
 */
import { formatUnits, parseEther, type Hex } from 'viem'
import { MsgBoardClient, type Provider } from '@msgboard/sdk'
import {
  CURVE_LINEAR,
  FLAG_ESCROW,
  PROVECASH_CATEGORY,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  armingFor,
  callFor,
  decodeIntent,
  signingDomain,
  encodeIntent,
  grindAndSubmit,
  authNonceOf,
  authWindowFor,
  intentHashOf,
  isDeadWindow,
  liveWindow,
  quote,
  authorizationRequest,
  supports3009,
  toStruct,
  verifyIntent,
  type Intent,
  signIntent,
} from '@prove.cash/sdk'
import {
  boundFor,
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  SETTLEMENT,
  balanceOf,
  derive,
  ensureAllowance,
  finish,
  head,
  log,
  must,
  pub,
  show,
  token,
  topUpGas,
  topUpToken,
  units,
  walletFor,
  write,
} from './common.js'

const IN = token('tPLSX')
const OUT = token('tUSDC')

/**
 * A maker of its own, because the claim under test is that this address never sends anything.
 * Give it a role no other script drives and its transaction count is evidence rather than noise.
 */
const maker = derive('prove.cash/e2e/gasless-maker')
const executor = derive('prove.cash/e2e/executor')
const executorWallet = walletFor(executor)

const AMOUNT_IN = units(IN, '100')
const RATE = units(OUT, '3')

head('setup — everything the maker needs arrives from outside')
log(`maker    ${maker.address}`)
log(`executor ${executor.address}`)
const nonceBefore = await pub.getTransactionCount({ address: maker.address, blockTag: 'latest' })
const plsBefore = await pub.getBalance({ address: maker.address })
log(`maker starts with ${nonceBefore} transactions and ${formatUnits(plsBefore, 18)} PLS`)

await topUpGas(executor.address, parseEther('0.3'), 'executor')
await topUpToken(IN, maker.address, AMOUNT_IN, 'gasless maker')
await topUpToken(OUT, executor.address, units(OUT, '10'), 'executor')
await ensureAllowance(executorWallet, OUT, units(OUT, '10'), 'executor')

must(await supports3009(IN.address), `${IN.symbol} speaks EIP-3009`)

head('the maker signs the intent')
const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
const intent: Intent = {
  maker: maker.address,
  recipient: maker.address,
  tokenIn: IN.address,
  tokenOut: OUT.address,
  amountIn: AMOUNT_IN,
  minOutStart: RATE,
  minOutEnd: RATE,
  // A straight line across the whole window: kind 0, and the word it reads none of.
  curve: CURVE_LINEAR,
  startTime: now - 60n,
  endTime: now + 3600n,
  executor: ZERO,
  feeConfig: FEE_CONFIG,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  feeRate: FEE_RATE,
  minFill: 0n,
  authNonce: ZERO_HASH,
  // The authorization funds the escrow at fill time, so the intent has to be an escrow intent.
  flags: FLAG_ESCROW,
  nonce: BigInt(Date.now()),
}
const signature = await signIntent(maker, intent, { domain: signingDomain(CHAIN) })
const hash = intentHashOf(intent, CHAIN)
const onChainHash = (await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'hashIntent',
  args: [toStruct(intent)],
})) as Hex
must(onChainHash === hash, `the SDK digest is the contract's digest · ${hash}`)

head('and signs an authorization that names that intent')
/**
 * The authorization's own window, and it is not the intent's.
 *
 * `validAfter` matches the intent's `startTime` rather than sitting at the epoch. That is what
 * the sign form now does, and it is the case worth covering on chain: the token refuses a
 * redemption outside these two bounds, and nothing in the settlement compares them with the
 * intent's. `liveWindow` says where the two agree, and this script asserts it is not empty
 * before it posts anything.
 */
const authSpan = authWindowFor(intent.startTime, now + 3600n)
const validBefore = authSpan.validBefore
const settleIn = liveWindow(intent, authSpan)
must(!isDeadWindow(settleIn), `the two windows overlap · ${settleIn.from}–${settleIn.until}`)

/**
 * `authorizationRequest` builds the typed data; the local account signs it.
 *
 * The SDK's `signAuthorization` wrapper cannot be used from a private key. It types its `account`
 * as an `Address` and hands that same string to `wallet.signTypedData`, and viem reads a bare
 * address as a JSON-RPC account — so it asks the node to sign, and the node answers
 * `eth_signTypedData_v4: Method not found`. Every write helper in the SDK has the same shape.
 * See the report; this is a finding, not a workaround the caller should have to know.
 */
const request = await authorizationRequest(
  maker.address,
  IN.address,
  AMOUNT_IN,
  // Whichever nonce the intent asks for. This one names none, so it is the intent's own hash and
  // the authorization funds nothing else. An intent that names one makes siblings sharing it
  // mutually exclusive instead.
  authNonceOf(intent, CHAIN),
  authSpan,
  CHAIN,
)
must(
  request.message.to.toLowerCase() === SETTLEMENT.toLowerCase(),
  'the authorization pays the settlement contract',
)
must(request.message.nonce === hash, 'and its 3009 nonce is the intent hash')
const authSig = await maker.signTypedData(request)
log(`authorization signed · valid until ${validBefore} · domain ${request.domain.name}`)

head('both go over the board, which charges work and not gas')
const data = encodeIntent({ ...intent, signature, auth: { ...authSpan, signature: authSig } })
log(`packed · ${(data.length - 2) / 2} bytes, intent and authorization together`)

const board = new MsgBoardClient(pub as unknown as Provider)
const posted = await grindAndSubmit(board, PROVECASH_CATEGORY, data)
log(`broadcast · ${posted.hash}${posted.recovered ? ' (the RPC lied; the board had it)' : ''}`)

const content = await board.content({ category: PROVECASH_CATEGORY })
const found = (content[PROVECASH_CATEGORY] ?? []).find((m) => m.hash === posted.hash)
must(!!found, 'the board hands the message back')
const decoded = decodeIntent(found!.data)
must(!!decoded, 'it decodes')
must(!!decoded?.auth, 'and the authorization survived the round trip')
must(await verifyIntent(decoded!, CHAIN), "the maker's signature verifies off the wire")
must(
  decoded!.auth!.signature === authSig &&
    decoded!.auth!.validBefore === validBefore &&
    decoded!.auth!.validAfter === authSpan.validAfter,
  'the authorization came back byte for byte, both bounds included',
)

head('an executor redeems the authorization and fills, in one transaction')
const makerInBefore = await balanceOf(IN, maker.address)
const makerOutBefore = await balanceOf(OUT, maker.address)
const executorInBefore = await balanceOf(IN, executor.address)

const call = callFor(
  {
    mode: 'authorization',
    fills: [{ intent: decoded!, take: AMOUNT_IN }],
    maxFeeRate: boundFor([decoded!]),
  },
  CHAIN,
)
must(call.functionName === 'fillWithAuthorization', `the SDK builds ${call.functionName}`)

// The same signature reaches the same code through the batch, on `FillRequest.arming`. The door
// above is the cheaper one for a single leg; only the batch settles several at a time.
const armed = callFor(
  {
    mode: 'batch',
    fills: [{ intent: decoded!, take: AMOUNT_IN }],
    maxFeeRate: boundFor([decoded!]),
    skipInvalid: false,
  },
  CHAIN,
)
const legs = armed.args[0] as readonly { arming: Hex }[]
must(
  legs.length === 1 && legs[0].arming === armingFor(decoded!, CHAIN),
  'and a batch leg would carry the same authorization on its arming field',
)

const { receipt } = await write(
  executorWallet,
  { address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: call.functionName, args: call.args },
  'filled with authorization',
)
const at = (await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp

head('the assertions')
// The maker no longer receives what they signed for. The fee comes out of the signed number, so
// the floor to check against is `delivered`, and `gross` is only the executor's outlay.
const { gross, delivered: owed } = quote(intent, AMOUNT_IN, at)
const received = (await balanceOf(OUT, maker.address)) - makerOutBefore
must(
  received >= owed,
  `the maker received ${show(OUT, received)}; the fill owed them ${show(OUT, owed)} out of a signed ${show(OUT, gross)}`,
)
must(
  makerInBefore - (await balanceOf(IN, maker.address)) === AMOUNT_IN,
  `${show(IN, AMOUNT_IN)} left the maker, pulled by the authorization`,
)
must(
  (await balanceOf(IN, executor.address)) - executorInBefore === AMOUNT_IN,
  'the executor holds the maker\'s token A',
)

const nonceAfter = await pub.getTransactionCount({ address: maker.address, blockTag: 'latest' })
const plsAfter = await pub.getBalance({ address: maker.address })
must(
  nonceAfter === nonceBefore,
  `the maker's transaction count is unchanged: ${nonceBefore} before, ${nonceAfter} after`,
)
must(
  plsAfter === plsBefore,
  `the maker's PLS balance is unchanged: ${formatUnits(plsBefore, 18)} before, ${formatUnits(plsAfter, 18)} after`,
)

// A used 3009 nonce cannot be spent twice. Without this the authorization is a standing order.
const spent = await pub.readContract({
  address: IN.address,
  abi: [
    {
      type: 'function',
      name: 'authorizationState',
      stateMutability: 'view',
      inputs: [
        { name: 'authorizer', type: 'address' },
        { name: 'nonce', type: 'bytes32' },
      ],
      outputs: [{ type: 'bool' }],
    },
  ] as const,
  functionName: 'authorizationState',
  args: [maker.address, hash],
})
must(spent === true, 'the authorization nonce is spent, so it cannot be replayed')

finish('gasless fill')
