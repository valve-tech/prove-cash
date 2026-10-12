/**
 * The whole path, on a real chain, end to end:
 *
 *   maker signs → broadcast over msgboard → read back → verify → executor fills on-chain
 *   → the maker received at least the rate they signed.
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     TOKEN_OUT=0x… npx tsx scripts/e2e-testnet.ts
 *
 * Chain 943 only. It funds two throwaway accounts from the given key, wraps PLS into WPLS for
 * the maker, mints the output token to the executor, and then does nothing special: the intent
 * goes over the real board and comes back through the real decoder before anybody fills it.
 *
 * The last assertion is the one that matters. Everything before it is setup.
 */
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  concat,
  keccak256,
  maxUint256,
  parseAbi,
  parseEther,
  parseGwei,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { pulsechainV4 } from 'viem/chains'
import { MsgBoardClient, type Provider } from '@msgboard/sdk'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  PROVECASH_CATEGORY,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  decodeIntent,
  signingDomain,
  feeTarget,
  rememberFeeConfig,
  singleFeeConfig,
  encodeIntent,
  grindAndSubmit,
  maxFeeRateFor,
  minOutAt,
  presetTokens,
  settlement,
  verifyIntent,
  type Intent,
  signIntent,
} from '@prove.cash/sdk'
import { rpcUrl, assertChainId } from './rpc.ts'

const CHAIN = 943 as const
const RPC = rpcUrl(CHAIN)
const GAS = parseGwei(process.env.GAS_GWEI ?? '2')

const raw = process.env.DEPLOYER_PK?.trim()
const tokenOut = process.env.TOKEN_OUT as Address | undefined
if (!raw || !tokenOut) throw new Error('DEPLOYER_PK and TOKEN_OUT are required')
const funderKey = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex

const WPLS = presetTokens(CHAIN).find((t) => t.symbol === 'WPLS')!.address
const SETTLEMENT = settlement(CHAIN)
if (SETTLEMENT === ZERO) throw new Error('no settlement in the registry for 943')

const wplsAbi = parseAbi(['function deposit() payable'])
const mintAbi = parseAbi([
  'function mint(address to, uint256 amount)',
  'function claim() returns (uint256)',
  'function owner() view returns (address)',
])

const pub = createPublicClient({ chain: pulsechainV4, transport: http(RPC) })

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(pub, CHAIN)

const funder = privateKeyToAccount(funderKey)
const funderWallet = createWalletClient({ account: funder, chain: pulsechainV4, transport: http(RPC) })

/**
 * Derived from the funding key, not generated fresh. A run that dies halfway used to strand
 * whatever it had already sent, because the keys only ever existed in memory. These addresses
 * are the same on every run, so the next run reuses the funds instead of abandoning them.
 */
// `stringToHex`, not `stringToBytes`. `concat` dispatches on its first element: a hex string
// sends the whole list to `concatHex`, which calls `.replace` on every member and throws
// `TypeError: x.replace is not a function` on a `Uint8Array`. This line threw on import, so the
// script could never run. Both forms mean the same bytes; only one of them survives the dispatch.
const derive = (role: string) =>
  privateKeyToAccount(keccak256(concat([funderKey, stringToHex(role)])))
const maker = derive('prove.cash/e2e/maker')
const executor = derive('prove.cash/e2e/executor')
const makerWallet = createWalletClient({ account: maker, chain: pulsechainV4, transport: http(RPC) })
const executorWallet = createWalletClient({
  account: executor,
  chain: pulsechainV4,
  transport: http(RPC),
})

const log = (m: string) => console.log(`  ${m}`)
const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash, timeout: 180_000 })

/**
 * The terms have to model a trade somebody would actually take, or the run proves settlement
 * and quietly skips the economics. PLS trades near $0.00003, so 10,000 WPLS is worth about
 * thirty cents. A maker asking 25 dollar-tokens for that would be asking an executor to lose
 * eighty times their money — a fill nobody sane, and no executor bot, would ever make.
 *
 * So: price the intent slightly *below* what the executor can get for the tokens. The gap is
 * the executor's reason to bother.
 */
const REFERENCE_PRICE = Number(process.env.PLS_USD ?? '0.00003') // what one PLS fetches
const AMOUNT_IN = parseEther(process.env.AMOUNT_IN ?? '100')
const EDGE_BPS = BigInt(process.env.EDGE_BPS ?? '300') // the maker concedes 3% to get filled

/*
 * The output token's own decimals, read rather than assumed.
 *
 * This file used to hardcode 18 for both sides. The input side is WPLS and really is 18, so the
 * mistake only shows on the output: every test token on 943 is 6 or 8, and a `minOut` computed
 * at 18 asks for a billion times what the maker meant. The fill then reverts with no reason a
 * decoder can name, because the failure is inside the token.
 */
/*
 * The address everyone approves, read from the settlement rather than named here.
 *
 * The settlement holds no allowance from anybody: every `transferFrom` it makes goes through
 * `ProveRelayer`, so an approval to the settlement grants exactly nothing and the fill reverts
 * inside the pull. This file approved the settlement on both sides and had done since the
 * relayer was introduced, which is why nothing it signed could ever be filled.
 */
const RELAYER = await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'relayer',
})

const OUT_DECIMALS = await pub.readContract({
  address: tokenOut,
  abi: erc20Abi,
  functionName: 'decimals',
})

const marketValue = parseUnits(
  (Number(formatUnits(AMOUNT_IN, 18)) * REFERENCE_PRICE).toFixed(OUT_DECIMALS),
  OUT_DECIMALS,
)
const MIN_OUT = (marketValue * (10_000n - EDGE_BPS)) / 10_000n

console.log('\nsetup')
// Gas money, sized to the job: a fill costs about 0.0004 PLS at 2 gwei. The maker needs the
// wrapped amount on top. Anything more is capital sitting idle in a throwaway account.
const gasFloat = parseEther('1')
let nonce = await pub.getTransactionCount({ address: funder.address, blockTag: 'latest' })
for (const [role, who, need] of [
  ['maker', maker.address, gasFloat + AMOUNT_IN],
  ['executor', executor.address, gasFloat],
] as const) {
  const held = await pub.getBalance({ address: who })
  if (held >= need) {
    log(`${role} ${who} already holds ${formatUnits(held, 18)} PLS`)
    continue
  }
  const hash = await funderWallet.sendTransaction({
    to: who,
    value: need - held,
    gasPrice: GAS,
    nonce: nonce++,
  })
  await wait(hash)
  log(`topped up ${role} ${who} to ${formatUnits(need, 18)} PLS`)
}

// The maker's side is real WPLS, wrapped from real testnet PLS.
const wrapped = await pub.readContract({
  address: WPLS,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [maker.address],
})
if (wrapped < AMOUNT_IN) {
  await wait(
    await makerWallet.writeContract({
      address: WPLS,
      abi: wplsAbi,
      functionName: 'deposit',
      value: AMOUNT_IN - wrapped,
      gasPrice: GAS,
    }),
  )
}
log(`maker holds ${formatUnits(AMOUNT_IN, 18)} WPLS`)

/*
 * Mint if this key owns the token, and drip from the faucet if it does not.
 *
 * The test tokens on 943 are owned by the valve address, not by the deployer that signs these
 * runs, so `mint` answers `NotOwner()` — a bare selector that viem cannot name, because the
 * faucet's errors are not on the four-line ABI above. Every other exercise in `scripts/e2e`
 * already went through `claim`; only this one still assumed it could mint.
 */
const owner = await pub.readContract({ address: tokenOut, abi: mintAbi, functionName: 'owner' })
if (owner.toLowerCase() === funder.address.toLowerCase()) {
  await wait(
    await funderWallet.writeContract({
      address: tokenOut,
      abi: mintAbi,
      functionName: 'mint',
      args: [executor.address, parseUnits('1000000', OUT_DECIMALS)],
      gasPrice: GAS,
      nonce: nonce++,
    }),
  )
  log('executor holds the output token, minted')
} else {
  // Look before claiming. The executor account is derived, not random, so it keeps whatever the
  // last run left it — and the faucet answers `CooldownActive(uint64)` to a second claim inside
  // the window. A run that claimed unconditionally would fail on the drip rather than on
  // anything this exercise is about.
  const balanceOfExecutor = () =>
    pub.readContract({
      address: tokenOut,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [executor.address],
    })

  let held = await balanceOfExecutor()
  if (held < marketValue) {
    await wait(
      await executorWallet.writeContract({
        address: tokenOut,
        abi: mintAbi,
        functionName: 'claim',
        args: [],
        gasPrice: GAS,
      }),
    )
    held = await balanceOfExecutor()
    log(`executor holds ${formatUnits(held, OUT_DECIMALS)} of the output token, from the drip`)
  } else {
    log(`executor already holds ${formatUnits(held, OUT_DECIMALS)} of the output token`)
  }
  if (held < marketValue) {
    throw new Error(
      `the drip left the executor ${formatUnits(held, OUT_DECIMALS)}, short of the ` +
        `${formatUnits(marketValue, OUT_DECIMALS)} this fill owes. Wait out the faucet cooldown.`,
    )
  }
}

await wait(
  await makerWallet.writeContract({
    address: WPLS,
    abi: erc20Abi,
    functionName: 'approve',
    args: [RELAYER, maxUint256],
    gasPrice: GAS,
  }),
)
await wait(
  await executorWallet.writeContract({
    address: tokenOut,
    abi: erc20Abi,
    functionName: 'approve',
    args: [RELAYER, maxUint256],
    gasPrice: GAS,
  }),
)
log('both sides approved the relayer')

console.log('\nthe terms')
log(
  `market value of ${formatUnits(AMOUNT_IN, 18)} WPLS at $${REFERENCE_PRICE}: ` +
    `${formatUnits(marketValue, OUT_DECIMALS)}`,
)
log(`the maker asks for ${formatUnits(MIN_OUT, OUT_DECIMALS)}, conceding ${EDGE_BPS} bps`)
log(`the executor's edge before fees: ${formatUnits(marketValue - MIN_OUT, OUT_DECIMALS)}`)

console.log('\nthe maker signs, and pays no gas to publish')
/*
 * The chain's clock, not this machine's.
 *
 * `_evaluate` compares `startTime` against `block.timestamp`, and on 943 a block lands every ten
 * seconds or so, so the chain is routinely a few seconds behind the wall clock here. An intent
 * signed at local `now` and filled in the same breath answers `NotStarted` — a real refusal, for
 * a reason that has nothing to do with the trade.
 */
const head = await pub.getBlock()
const now = head.timestamp
const FEE_CONFIG = rememberFeeConfig(singleFeeConfig(feeTarget(CHAIN)))
const intent: Intent = {
  maker: maker.address,
  recipient: maker.address,
  tokenIn: WPLS,
  tokenOut,
  amountIn: AMOUNT_IN,
  minOutStart: MIN_OUT,
  minOutEnd: MIN_OUT,
  // A straight line across the whole window: kind 0, and the word it reads none of.
  curve: CURVE_LINEAR,
  startTime: now,
  endTime: now + 3600n,
  executor: ZERO,
  // A real config and a real rate, because this script asserts a fee was paid. The fee is booked
  // under the config's hash inside the settlement (`pendingFees`) and paid out by `claim`, so the
  // script reads the ledger rather than a destination's balance. P3 is the point that comes out
  // of the maker's number, which is what the "short-changed" check below is about.
  feeConfig: FEE_CONFIG,
  feeRateIn: 0n,
  feeRate: 0n,
  feeRateProceeds: 1_000_000_000_000_000n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: FLAG_PARTIAL,
  nonce: BigInt(Date.now()),
}
const signature = await signIntent(maker, intent, { domain: signingDomain(CHAIN) })
const data = encodeIntent({ ...intent, signature })
log(`signed · ${(data.length - 2) / 2} bytes`)

const board = new MsgBoardClient(pub as unknown as Provider)
const posted = await grindAndSubmit(board, PROVECASH_CATEGORY, data)
log(`broadcast · proof of work, no gas · ${posted.hash.slice(0, 14)}…`)

console.log('\nan executor reads the board and decides for itself')
const content = await board.content({ category: PROVECASH_CATEGORY })
const found = (content[PROVECASH_CATEGORY] ?? []).find((m) => m.hash === posted.hash)
if (!found) throw new Error('the board did not return the intent')
const decoded = decodeIntent(found.data)
if (!decoded) throw new Error('the board returned something that does not decode')
if (!(await verifyIntent(decoded, CHAIN))) throw new Error('the signature did not verify')
log('read back off the board, decoded, signature verified')

const q3 = (await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'quote',
  args: [decoded, decoded.amountIn, now],
})) as unknown as { delivered: bigint; feeOut: bigint; feeProceeds: bigint }
const [delivered, fee] = [q3.delivered, q3.feeOut + q3.feeProceeds]
log(`quote · deliver ${formatUnits(delivered, OUT_DECIMALS)} · fee ${formatUnits(fee, OUT_DECIMALS)}`)

// Three snapshots, all taken here, so every figure below is a delta over the same window.
//
// Two of these used to be read after the fill and used as if they were deltas. The executor's
// WPLS balance is everything it has ever taken, and the fee destination's balance is every fee
// it has ever been paid by anybody — so a suite that had run three times reported "took 300
// WPLS" for a 100 WPLS intent, and the profit line subtracted a lifetime of fees from one fill.
// The check then failed on terms that were fine. Same mistake as the executor bot's
// short-change alarm on 2026-08-28: a delta compared against a total.
const before = await pub.readContract({
  address: tokenOut,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [decoded.recipient],
})
const tokenInBefore = await pub.readContract({
  address: WPLS,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [executor.address],
})
const booked = () =>
  pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'pendingFees',
    args: [decoded.feeConfig, tokenOut],
  }) as Promise<bigint>
const sinkBefore = await booked()

// The rate the executor agreed to. It is the intent's own signed rate and nothing on chain can
// raise it, so the bound is a number this script computes rather than a number it reads.
const feeCap = maxFeeRateFor([decoded])

/*
 * Ask why before finding out the hard way.
 *
 * `fill` reverts with a custom error that viem cannot name unless every one of them is on the
 * ABI it was handed, so a refusal reads as `execution reverted` and names nothing. `fillability`
 * is the same validator the fill runs, exposed as a view that answers with a reason — so a script
 * that asks first turns "it reverted" into "the maker's allowance is short", which is the whole
 * difference between a minute and an afternoon.
 */
const REASONS = [
  'Ok', 'BadTerms', 'NotStarted', 'Expired', 'Cancelled', 'NonceTooLow', 'WrongExecutor',
  'NothingToFill', 'TooMuch', 'PartialNotAllowed', 'EscrowShort', 'BadSignature', 'FeeTooHigh',
  'BelowMinFill', 'TokenOutUnreadable',
] as const
const reason = await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'fillability',
  args: [decoded, decoded.signature, decoded.amountIn, executor.address, feeCap],
})
log(`the chain says: ${REASONS[Number(reason)] ?? `reason ${reason}`}`)
if (Number(reason) !== 0) {
  throw new Error(
    `the settlement refuses this fill: ${REASONS[Number(reason)] ?? reason}. ` +
      'Nothing was sent.',
  )
}

const { request } = await pub.simulateContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'fill',
  args: [decoded, decoded.signature, decoded.amountIn, feeCap],
  account: executor,
  gasPrice: GAS,
})
const receipt = await wait(await executorWallet.writeContract(request))
log(`filled on-chain · gas ${receipt.gasUsed} · ${receipt.transactionHash}`)

console.log('\nthe assertion this whole thing exists for')
const after = await pub.readContract({
  address: tokenOut,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [decoded.recipient],
})
const received = after - before
const rate = minOutAt(decoded, now)
const owed = (decoded.amountIn * rate + decoded.amountIn - 1n) / decoded.amountIn

const gotTokenIn =
  (await pub.readContract({
    address: WPLS,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [executor.address],
  })) - tokenInBefore
// What the settlement booked under the config the intent named, and the only place a fee goes.
const sinkTook = (await booked()) - sinkBefore

log(
  `maker received  ${formatUnits(received, OUT_DECIMALS)} ` +
    `(signed for at least ${formatUnits(owed, OUT_DECIMALS)})`,
)
log(
  `executor took   ${formatUnits(gotTokenIn, 18)} WPLS, ` +
    `worth ${formatUnits(marketValue, OUT_DECIMALS)}`,
)
log(`executor paid   ${formatUnits(received + sinkTook, OUT_DECIMALS)} including the fee`)
log(`executor profit ${formatUnits(marketValue - received - sinkTook, OUT_DECIMALS)}`)
log(`fee destination ${formatUnits(sinkTook, OUT_DECIMALS)}`)

if (marketValue <= received + sinkTook) {
  console.log('\nFAILED: these terms lose the executor money, so no executor would fill them')
  process.exit(1)
}

if (received < owed) {
  console.log('\nFAILED: the maker was short-changed')
  process.exit(1)
}
console.log('\nthe maker got the rate they signed. end to end, on chain 943.\n')
