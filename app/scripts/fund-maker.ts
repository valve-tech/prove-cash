/**
 * Give the heartbeat's maker the tokens it is quoting, and the allowance to move them.
 *
 *   DEPLOYER_PK=… npx tsx scripts/fund-maker.ts            # dry run, sends nothing
 *   DEPLOYER_PK=… npx tsx scripts/fund-maker.ts --send
 *
 * **A market the maker cannot honour is not a market.** The heartbeat says so itself, about its
 * own size caps: "a cap the float cannot cover puts rows on the board that no executor can fill,
 * and an offer nobody can take is worse than no offer." Adding a pair to `MARKETS` does not add
 * the tokens behind it, so this is the step that has to follow one.
 *
 * Measured on 943 on 2026-08-31, right after `seed-triangle.ts` gave tWETH and tWBTC pools to
 * price against: the maker held 36.96 tPLSX and was posting offers of 60 to 250 tPLSX, and held
 * none at all of tWETH or tWBTC while quoting both. Every one of those rows was a signature
 * backed by nothing. That is a worse state than the silent one it replaced, because a dead market
 * shows a visitor nothing and an unfillable one shows them a lie.
 *
 * The maker's key is derived from the deployer's, the way the heartbeat's own header says, so
 * this needs no second secret and the bot host's copy is never read.
 *
 * Idempotent: it tops up to a floor and skips an allowance that is already there.
 */
import {
  concat,
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { defaultRpc, network, presetTokens, setChainId, setRpc, settlement } from '@prove.cash/sdk'
import { SETTLEMENT_ABI } from '@prove.cash/sdk/settlement'
import { fees, assertChainId } from './rpc.ts'

const SEND = process.argv.includes('--send')
const CHAIN = 943
const RPC = process.env.RPC ?? defaultRpc(CHAIN)

setChainId(CHAIN)
setRpc(RPC, CHAIN)

const raw = process.env.DEPLOYER_PK
if (!raw) throw new Error('DEPLOYER_PK is required')
const deployerKey = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
const deployer = privateKeyToAccount(deployerKey)

/** The same derivation the heartbeat prints in its own startup error. One secret, not two. */
const makerKey = keccak256(concat([deployerKey, stringToHex('prove.cash/heartbeat')]))
const maker = privateKeyToAccount(makerKey)

const chain = network(CHAIN).chain
const pub = createPublicClient({ chain, transport: http(RPC) })

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(pub, CHAIN)

const fromDeployer = createWalletClient({ account: deployer, chain, transport: http(RPC) })
const fromMaker = createWalletClient({ account: maker, chain, transport: http(RPC) })

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
])
const FAUCET = parseAbi([
  'function claim() returns (uint256)',
  'function claimAmount() view returns (uint256)',
  'function nextClaimAt(address) view returns (uint64)',
])

const log = (m: string) => console.log(`  ${m}`)
const head = (m: string) => console.log(`\n${m}`)
const txFees = await fees(pub)

const tok = (symbol: string) => {
  const t = presetTokens(CHAIN).find((p) => p.symbol === symbol)
  if (!t) throw new Error(`no preset token ${symbol} on chain ${CHAIN}`)
  return t
}

/**
 * The float each token needs, in whole units.
 *
 * Sized from what the bot actually posts: five offers a side every 240 seconds, live for about an
 * hour, so roughly fifteen of each direction outstanding. These cover that several times over,
 * which is the right side to err on — the cost of an unspent testnet token is nothing and the
 * cost of an unfillable row is a visitor who thinks the protocol is broken.
 */
const FLOOR: Record<string, string> = {
  tPLSX: '5000',
  tUSDC: '400',
  tWETH: '2',
  tWBTC: '0.2',
}

/** The address that actually moves a maker's tokens. Read off the settlement, never configured. */
const SETTLEMENT = settlement(CHAIN)
const RELAYER = await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'relayer',
})

head('who')
log(`deployer   ${deployer.address}`)
log(`maker      ${maker.address}`)
log(`relayer    ${RELAYER}`)

async function send(
  wallet: typeof fromDeployer,
  request: Parameters<typeof fromDeployer.writeContract>[0],
  what: string,
) {
  if (!SEND) {
    log(`would ${what}`)
    return
  }
  const hash = await wallet.writeContract({ ...request, ...txFees } as never)
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  log(`${what} · gas ${r.gasUsed} · ${hash}`)
  if (r.status !== 'success') throw new Error(`${what} reverted`)
}

head('the float')
const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
for (const [symbol, whole] of Object.entries(FLOOR)) {
  const t = tok(symbol)
  const floor = parseUnits(whole, t.decimals)
  const read = (who: Address) =>
    pub.readContract({ address: t.address, abi: ERC20, functionName: 'balanceOf', args: [who] })

  const held = await read(maker.address)
  if (held >= floor) {
    log(`${symbol.padEnd(6)} ${formatUnits(held, t.decimals)} — at or above its floor`)
    continue
  }

  const short = floor - held
  let mine = await read(deployer.address)
  if (mine < short) {
    // The faucet is permissionless behind a cooldown, so top up from it rather than asking a
    // person for tokens the chain will hand out.
    const [amount, readyAt] = await Promise.all([
      pub.readContract({ address: t.address, abi: FAUCET, functionName: 'claimAmount' }),
      pub.readContract({
        address: t.address,
        abi: FAUCET,
        functionName: 'nextClaimAt',
        args: [deployer.address],
      }),
    ])
    if (readyAt > now) throw new Error(`${symbol} claim is on cooldown for ${readyAt - now}s`)
    if (mine + amount < short) {
      throw new Error(`${symbol}: one claim still leaves the deployer short of ${formatUnits(short, t.decimals)}`)
    }
    await send(
      fromDeployer,
      { address: t.address, abi: FAUCET, functionName: 'claim', account: deployer, chain },
      `claim ${formatUnits(amount, t.decimals)} ${symbol}`,
    )
    mine += amount
  }

  await send(
    fromDeployer,
    {
      address: t.address,
      abi: ERC20,
      functionName: 'transfer',
      args: [maker.address, short],
      account: deployer,
      chain,
    },
    `send ${formatUnits(short, t.decimals)} ${symbol} to the maker`,
  )
}

head('the allowance')
for (const symbol of Object.keys(FLOOR)) {
  const t = tok(symbol)
  const allowance = await pub.readContract({
    address: t.address,
    abi: ERC20,
    functionName: 'allowance',
    args: [maker.address, RELAYER],
  })
  // Half of max, so a partial spend never drops it under a floor and re-approving is rare.
  if (allowance >= 2n ** 200n) {
    log(`${symbol.padEnd(6)} already approved`)
    continue
  }
  await send(
    fromMaker,
    {
      address: t.address,
      abi: ERC20,
      functionName: 'approve',
      args: [RELAYER, 2n ** 255n],
      account: maker,
      chain,
    },
    `approve the relayer for ${symbol}`,
  )
}

head('gas')
const gas = await pub.getBalance({ address: maker.address })
log(`maker holds ${formatUnits(gas, 18)} PLS`)
if (gas < parseUnits('5', 18)) {
  await send(
    fromDeployer,
    { to: maker.address, value: parseUnits('20', 18), account: deployer, chain } as never,
    'top the maker up with 20 PLS',
  )
}
