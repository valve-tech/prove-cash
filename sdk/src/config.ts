import { pulsechain, pulsechainV4 } from 'viem/chains'
import type { Address, Chain } from 'viem'
import { kv } from './kv.js'
import { hashFeeConfig, type FeeConfig, type FeeDefaultsEntry } from './feeconfig.js'

/**
 * The network registry. Adding a chain is one entry here: give it a viem chain, a label, the
 * settlement address once deployed, and whatever tokens the picker should offer. Everything
 * else — RPC defaults, the EIP-712 domain, the token cache, the network switcher — reads from
 * this list, so nothing else needs to change.
 *
 * A board only needs a node running the `msgboard_` module. The chain id lives inside the
 * EIP-712 domain, so a signature from one chain can never mean anything on another.
 */

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/** A token the picker offers without asking the chain what it is. */
export type PresetToken = { address: Address; symbol: string; decimals: number }

/**
 * One constant-product market on a chain: a router, the factory it deploys pairs from, and the
 * fee those pairs keep.
 *
 * A chain carries a list of these rather than one address because PulseX runs v1 and v2 side by
 * side on mainnet, behind two different factories. Two factories means two separate pools of
 * liquidity for the same pair, and neither is always the better one — measured in a single block
 * on 2026-08-17, v2 paid more for WPLS→PLSX and v1 paid more for WPLS→HEX. Quote one and you
 * quote half the market.
 *
 * "xyk" rather than a brand: this is any `x · y = k` deployment with the UniswapV2 surface.
 */
export type XykVenue = {
  /** The deployment's own name. It rides along on a quote so a caller can see which one won. */
  label: string
  router: Address
  /**
   * The factory this router deploys pairs from. Recorded here rather than discovered, so a probe
   * can hold the chain to it: a router whose `factory()` disagrees means this entry is stale, and
   * reading pairs out of the wrong factory reports "no pool" for pairs that exist.
   */
  factory: Address
  /**
   * Of every `feeDen` units sent into a pair here, the curve credits `feeNum`.
   *
   * The fee lives in the pair, not the router, so it is a property of the venue and not of the
   * brand. Every numerator below was measured, not assumed: read `getReserves` at a pinned block,
   * call `getAmountsOut` at the same block, and solve for the numerator that reproduces the
   * router's answer exactly. `market.live.test.ts` re-runs that measurement against the chains.
   */
  feeNum: bigint
  feeDen: bigint
}

/** One entry in the registry: a chain, where it settles, and what it trades. */
export type Network = {
  id: number
  chain: Chain
  label: string
  /**
   * Settlement contract, as the registry has it. Zero means not deployed. Read it through
   * `settlement()` and never from here — only the resolver honours a runtime override.
   */
  settlement: Address
  /**
   * The day this chain's contracts went on chain, from `contracts/deployments/<id>.json`.
   *
   * Null means the registry names no settlement here, so no deployed build exists to date.
   *
   * A deployment is frozen and this tree moves on, so the two drift between deploys. A client has
   * to know how far: `deployed.ts` reads this date and refuses a call to a function the chain's
   * own build never carried. Without it the call reverts on chain with no reason at all.
   *
   * The deployment record is the authority and this is a copy of it. `deployed.test.ts` holds
   * every live chain's copy to the record, so a redeploy that moves the date and not this line
   * fails a test rather than teaching the SDK something false.
   */
  deployedOn: string | null
  /**
   * This chain's PulseX buy-and-burn, read off `factory.feeTo()`.
   *
   * The destination the defaults suggest (`fees.defaults.config`), and `market.live.test.ts` holds
   * it to the factory. A fee config names it; the sign form shows it by name (`feeToName`).
   */
  feeTo: Address
  /**
   * What that destination is, in words.
   *
   * A proper name and not a translated string: it names one contract on one chain, the way
   * "PulseX" itself is not translated.
   */
  feeToName: string
  /**
   * This chain's `FeeDefaults`, or the zero address until it is deployed. Suggested fee configs
   * and rates for a sign form to pre-fill; the settlement never reads it.
   */
  feeDefaults: Address
  /** This chain's `ProveReader`, or the zero address until it is deployed. */
  reader: Address
  /**
   * The stray config this chain's settlement is constructed with (where unattributed tokens are
   * booked) and the defaults published first. A copy of `contracts/config/fee-configs.json`, which
   * `feeconfig.registry.test.ts` holds it to; the file mirrors `FeeDefaults` for CI.
   */
  fees: {
    strayConfig: FeeConfig
    /** The last entry of `history`: what the deploy publishes first. */
    defaults: FeeDefaultsEntry
    /**
     * Every defaults version this build knows, oldest first: a copy of `history` in
     * `contracts/config/fee-configs.json`. A config a chain's `FeeDefaults` returns that is NOT in
     * here is one this build was not shipped with, and a client must say so before it signs it.
     */
    history: readonly FeeDefaultsEntry[]
  }
  tokens: readonly PresetToken[]
  /**
   * Every constant-product market this chain quotes against. An empty list means no market here.
   *
   * The order is not a ranking. A quote prices all of them and keeps the best answer; the order
   * only decides ties, and which one a caller that must pick exactly one — a write path — gets
   * from `xykRouter`.
   *
   * These addresses differ per chain, which is the whole reason they live here: the mainnet
   * routers have no code on 943, and hard-coding one of them is what made testnet look for
   * months as though it had no market at all.
   */
  xyk: readonly XykVenue[]
  /** Board RPC. Defaults to the valve.city demo endpoint for this chain id. */
  rpc?: string
}

/** Verified on-chain against chain 369 before shipping. */
const PULSECHAIN_TOKENS: PresetToken[] = [
  { address: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27', symbol: 'WPLS', decimals: 18 },
  { address: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab', symbol: 'PLSX', decimals: 18 },
  { address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39', symbol: 'HEX', decimals: 8 },
  { address: '0xefD766cCb38EaF1dfd701853BFCe31359239F305', symbol: 'DAI', decimals: 18 },
  { address: '0x1EABe4a39B404ae7Cd386194f1b10A011f430135', symbol: 'x402PLSX', decimals: 18 },
  { address: '0x33D3BBF903D3E85973aF93d55CDeA7C1523e607B', symbol: 'x402USDC', decimals: 6 },
  { address: '0x7464eC8E2de5fEE14653Ce685058C1904A293eee', symbol: 'x402HEX', decimals: 8 },
]

/**
 * Verified on-chain against chain 943 before shipping.
 *
 * The `t` tokens are ours, deployed from `contracts/script/DeployTestTokens.s.sol`. Testnet has
 * almost no liquid ERC-20s, so a portfolio has to be minted rather than found. Anyone can call
 * `claim()` on them, once per cooldown per address. Their decimals differ on purpose: the
 * settlement quote rounds at 18, 8 and 6, and only a mixed set exercises all three.
 */
const PULSECHAIN_V4_TOKENS: PresetToken[] = [
  { address: '0x70499adEBB11Efd915E3b69E700c331778628707', symbol: 'WPLS', decimals: 18 },
  { address: '0x8a810ea8B121d08342E9e7696f4a9915cBE494B7', symbol: 'PLSX', decimals: 18 },
  { address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39', symbol: 'HEX', decimals: 8 },
  { address: '0xabeF58363E0fc60250D16778848eAED831eA26F9', symbol: 'tPLSX', decimals: 18 },
  { address: '0xA54e1565AB28360B66809803306Ec5b1229808a0', symbol: 'tHEX', decimals: 8 },
  { address: '0x86390129a2079fb7f0FC889473160a3a449117Ab', symbol: 'tUSDC', decimals: 6 },
  { address: '0x7d32f9Ebb6C5813435f4bDF4e9beaF99C805D529', symbol: 'tUSDT', decimals: 6 },
  { address: '0x70c421a8baC4aDAa10285A20EfF09997A5e09565', symbol: 'tWBTC', decimals: 8 },
  { address: '0xCb5C3ED9cD727f142d1b9eFc60790550683aA655', symbol: 'tWETH', decimals: 18 },
]

/**
 * PulseX keeps 29 basis points of every swap, on both mainnet deployments and on testnet.
 *
 * Measured, not taken from the docs. At mainnet block 27,313,834 and testnet block 25,158,344 the
 * only numerator over 10,000 that reproduces `getAmountsOut` exactly, on both WPLS/PLSX and
 * WPLS/HEX, on all three venues, is 9971. The two mainnet routers share a bytecode length and
 * differ in their factory, so this was worth checking rather than assuming; it happens to agree.
 * A venue that ever disagrees gets its own numbers in its own entry — that is why the fee sits on
 * the venue and not in a constant.
 */
export const PULSEX_FEE_NUM = 9971n
/** The denominator the numerator is taken over. */
export const PULSEX_FEE_DEN = 10_000n

const PULSEX_FEE = { feeNum: PULSEX_FEE_NUM, feeDen: PULSEX_FEE_DEN } as const

/** The fee data a chain carries; see `Network.fees`. */
type ChainFees = Network['fees']

// Copied from `contracts/config/fee-configs.json` (the last history entry is the defaults the
// deploy publishes). `fee-configs.registry.test.ts` holds both to the file, so they cannot drift.
const HISTORY_943: readonly FeeDefaultsEntry[] = [
  {
    id: 'burn-0.5-v1',
    config: { destinations: ['0x7cD43983A963c62Add34694E83E896c5AfC3333f'], weights: [1000000000000000000n] },
    rates: { handover: 0n, output: 5000000000000000n, proceeds: 0n },
    warn: { handover: 10000000000000000n, output: 10000000000000000n, proceeds: 10000000000000000n },
    label: 'PulseX buy & burn (testnet)',
  },
]

const FEES_943: ChainFees = {
  strayConfig: { destinations: ['0x7cD43983A963c62Add34694E83E896c5AfC3333f'], weights: [1000000000000000000n] },
  defaults: HISTORY_943[HISTORY_943.length - 1]!,
  history: HISTORY_943,
}

const HISTORY_369: readonly FeeDefaultsEntry[] = [
  {
    id: 'burn-0.5-v1',
    config: { destinations: ['0xd6cA7ee047a6F45d20d2962E4394E070cF27724F'], weights: [1000000000000000000n] },
    rates: { handover: 0n, output: 5000000000000000n, proceeds: 0n },
    warn: { handover: 10000000000000000n, output: 10000000000000000n, proceeds: 10000000000000000n },
    label: 'PulseX buy & burn',
  },
]

const FEES_369: ChainFees = {
  strayConfig: { destinations: ['0xd6cA7ee047a6F45d20d2962E4394E070cF27724F'], weights: [1000000000000000000n] },
  defaults: HISTORY_369[HISTORY_369.length - 1]!,
  history: HISTORY_369,
}

const NETWORK_LIST = [
  {
    id: 369,
    chain: pulsechain,
    label: 'mainnet',
    // Mainnet is on (backlog #52, decided 2026-10-10): the 2026-10-06 deploy, as
    // `contracts/deployments/369.json` records it. The `-369` units still carry SETTLEMENT= and
    // `check:addresses` holds the two to the same address.
    settlement: '0x5EB7cAf15f9Fa7Afad9a45d035f7E0F67140fC7b',
    // `deployedAt` in contracts/deployments/369.json.
    deployedOn: '2026-10-06',
    // PulseX v2's buy-and-burn: `IPulseXFactory(0x29eA7545…).feeTo()`, read on chain 2026-08-22.
    // The first venue's, always — the deployment a write path routes through is the deployment
    // whose burn we feed. v1's is a different address and an equally real buy-and-burn; picking
    // it because v1's WPLS/PLSX pool is deeper confuses where a swap goes with where a fee goes.
    // `market.live.test.ts` holds this to `xykVenues(id)[0].factory.feeTo()`.
    feeTo: '0xd6cA7ee047a6F45d20d2962E4394E070cF27724F',
    feeToName: 'PulseX buy & burn',
    feeDefaults: '0xE92cB6265497F141125E25a9B5231370632e878E',
    reader: '0x8c93958085e4823983b2B811F206874C108C5288',
    fees: FEES_369,
    tokens: PULSECHAIN_TOKENS,
    // v2 leads because a caller that must name one router has always had this one. Both were
    // verified on chain 2026-08-17: each router has code, each `factory()` answers the address
    // below, and each factory holds a live WPLS/PLSX pair — v1 with 65,167 pairs, v2 with
    // 186,205. v1 is by far the deeper of the two on WPLS/PLSX, at 3.2x the reserves.
    xyk: [
      {
        label: 'v2',
        router: '0x165C3410fC91EF562C50559f7d2289fEbed552d9',
        factory: '0x29eA7545DEf87022BAdc76323F373EA1e707C523',
        ...PULSEX_FEE,
      },
      {
        label: 'v1',
        router: '0x98bf93ebf5c380C0e6Ae8e192A7e2AE08edAcc02',
        factory: '0x1715a3E4A142d8b698131108995174F37aEBA10D',
        ...PULSEX_FEE,
      },
    ],
  },
  {
    id: 943,
    chain: pulsechainV4,
    label: 'testnet',
    // Redeployed whole on 2026-09-05, from contracts/deployments/943.json.
    //
    // **This time INTENT_TYPEHASH moved too.** The curve field added a seventeenth member, so an
    // intent signed against the 2026-09-01 settlement is unspendable here twice over: the digest
    // it hashes to is different, and the domain separator carries the verifying contract anyway.
    // The fee also changed meaning underneath it — #119 takes the fee out of the maker's number
    // rather than charging it on top — so an old signature would have meant something else even
    // if it could be spent. The board refills in one heartbeat round.
    //
    // Every standing approval died with the old relayer, because ProveRelayer is built by the
    // settlement's constructor and cannot be pointed elsewhere. A maker on the permit2 rung keeps
    // theirs, which is the whole point of that rung.
    //
    // The 2026-09-01 move is still worth remembering for its own reason: `Payment` gained a leg
    // index, `proveBatchCallback` moved from 0x3b357c3e to 0xc988788e, and a settlement calling
    // the old selector at an executor answering only the new one made every credit ring revert
    // with NO DATA. The two halves move together or neither does.
    //
    // Moved again on 2026-09-09, and the reason this time is a lesson rather than a feature.
    // Two commits had parted the chain from master since 2026-09-05 — #120, escrow that outlives
    // its intent, and #131, lanes on the nonce floor — and both change storage, so both needed a
    // new address. Nothing noticed for four days: `contracts/tools/verify-bytecode.mjs` was
    // written, worked, and was wired into no runner, so the documents went on saying master was
    // deployed here while `parked()` and `laneFloor()` reverted on the chain. It runs nightly now.
    // `INTENT_TYPEHASH` did NOT move this time — the domain separator did, because it carries the
    // verifying contract, so old signatures are unspendable for that reason alone.
    settlement: '0xa8B3f54c1435ea28437fA89A4192064F4bcCDA99',
    // `deployedAt` in contracts/deployments/943.json. Moved again on 2026-10-01 for the fee fix
    // (no fill reads the default sink); INTENT_TYPEHASH did not move. `deployed.ts` reads this date
    // to say which calls an older build cannot answer, and this build answers all of them.
    deployedOn: '2026-10-06',
    // The testnet factory's own `feeTo()`, read on chain 2026-08-22. The chain has one venue, so
    // this is that one's. A different address from mainnet's, which is why it is registry data.
    feeTo: '0x7cD43983A963c62Add34694E83E896c5AfC3333f',
    feeToName: 'PulseX buy & burn',
    // Fee-config redeploy 2026-10-06 (master cfd6e85). FeeDefaults owner is the testnet admin.
    feeDefaults: '0x67e366de6E29289D43894F5587E29FE460405cFf',
    reader: '0x8dCf4A7Fe697ba4705DF86A0D77084700C84cabD',
    fees: FEES_943,
    tokens: PULSECHAIN_V4_TOKENS,
    // One venue, and a list of one is a list. Verified on chain 2026-08-17: factory() reports
    // 0xFf0538…c0f7, which holds 5,761 pairs including the live WPLS/PLSX one, and getAmountsOut
    // quotes 1 WPLS at 5.02 PLSX. It is labelled v1 on the chain's own evidence — its factory
    // reports the same `INIT_CODE_PAIR_HASH` as mainnet v1, 0x59fffff…5d62, not mainnet v2's.
    // Neither mainnet router has any code here.
    xyk: [
      {
        label: 'v1',
        router: '0xDaE9dd3d1A52CfCe9d5F2fAC7fDe164D500E50f7',
        factory: '0xFf0538782D122d3112F75dc7121F61562261c0f7',
        ...PULSEX_FEE,
      },
    ],
  },
] as const satisfies readonly Network[]

/** Every chain id the registry carries. Anything else is not a prove.cash network. */
export type ChainId = (typeof NETWORK_LIST)[number]['id']

/** The registered chain ids, in registry order. */
export const CHAIN_IDS = NETWORK_LIST.map((n) => n.id) as ChainId[]

/** The registry, keyed by chain id. */
export const NETWORKS = Object.fromEntries(
  NETWORK_LIST.map((n) => [n.id, n]),
) as unknown as Record<ChainId, Network>

/**
 * The chain a fresh install starts on.
 *
 * Not `NETWORK_LIST[0]`. Mainnet is first in the list, for the network switcher, and it has no
 * settlement contract. A fresh visitor therefore opened on a board that can never fill, and seven
 * signed offers reached the public mainnet archive that way — every maker holding nothing, every
 * signature bound to the zero address. Start on a chain that can settle. `config.test.ts` holds
 * this to that rule.
 *
 * A visitor who chose mainnet keeps it: the stored selection still wins over this.
 */
export const DEFAULT_CHAIN: ChainId = 943

/** True when this number is a chain the registry knows, and narrows it to `ChainId`. */
export const isSupportedChain = (id: number): id is ChainId => id in NETWORKS

/** The registry entry for a chain. Defaults to the selected chain. */
export const network = (id: ChainId = getChainId()): Network => NETWORKS[id]

/** The endpoint a chain falls back to when nothing is configured. */
export const defaultRpc = (id: ChainId) =>
  NETWORKS[id].rpc ?? `https://one.valve.city/rpc/vk_demo/evm/${id}`

// ── Per-install selections ────────────────────────────────────────────────────

const CHAIN_KEY = 'provecash.chain'
/** Board endpoint override. The key predates the board/chain split, so old overrides carry over. */
const RPC_KEY = (id: ChainId) => `provecash.rpc.${id}`
const CHAIN_RPC_KEY = (id: ChainId) => `provecash.rpc.${id}.chain`
const LINK_KEY = (id: ChainId) => `provecash.rpc.${id}.linked`

let chainId: ChainId = DEFAULT_CHAIN
const storedChain = Number(kv().getItem(CHAIN_KEY))
if (isSupportedChain(storedChain)) chainId = storedChain

/** The chain every helper here defaults to. */
export const getChainId = (): ChainId => chainId

/** Move this process, or this browser, to another registered chain. */
export function setChainId(id: ChainId) {
  chainId = id
  kv().setItem(CHAIN_KEY, String(id))
}

/**
 * Two endpoints per network. The board endpoint needs a node with the `msgboard_` module.
 * The chain endpoint answers plain `eth_` reads and can be any PulseChain node. Locked
 * (the default) means one URL drives both, exactly as before the split.
 */
export type EndpointKind = 'board' | 'chain'

/** True while one URL drives both endpoints. */
export function rpcLinked(id: ChainId = chainId): boolean {
  return kv().getItem(LINK_KEY(id)) !== '0'
}

/** Lock the chain endpoint to the board endpoint, or let them differ. */
export function setRpcLinked(linked: boolean, id: ChainId = chainId) {
  if (linked) kv().removeItem(LINK_KEY(id))
  else kv().setItem(LINK_KEY(id), '0')
}

/** The board endpoint. Kept under its old name for existing callers. */
export function getRpc(id: ChainId = chainId): string {
  return kv().getItem(RPC_KEY(id)) || defaultRpc(id)
}

/** The chain endpoint. Follows the board endpoint while the two are locked together. */
export function getChainRpc(id: ChainId = chainId): string {
  if (rpcLinked(id)) return getRpc(id)
  return kv().getItem(CHAIN_RPC_KEY(id)) || defaultRpc(id)
}

/** Point one endpoint at a URL. An empty URL, or the default, clears the override. */
export function setRpc(url: string, id: ChainId = chainId, kind: EndpointKind = 'board') {
  const key = kind === 'chain' ? CHAIN_RPC_KEY(id) : RPC_KEY(id)
  if (url && url !== defaultRpc(id)) kv().setItem(key, url)
  else kv().removeItem(key)
}

/** One category carries the whole protocol, on every chain. */
export const CATEGORY = 'provecash'

/**
 * Where exclusive RFQ quotes travel, and it is deliberately not `CATEGORY`.
 *
 * An exclusive quote is a price reserved for one named address. It is not part of the public
 * book, and the app renders whatever it finds under `CATEGORY` — so a quote posted there would
 * appear in the order book as an offer nobody but its counterparty can take. A separate category
 * means the app's reader cannot pick one up by accident, and a contributor who wants them on
 * screen has to opt in by naming this constant rather than opt out by filtering.
 *
 * The board is public either way. This separates the marketplaces, not the prices: anybody can
 * read a quote posted here, and only the named counterparty can take it. Deliver the quote
 * off-band instead when the price itself must stay private.
 */
export const RFQ_CATEGORY = 'provecash-rfq'

/**
 * A settlement address can be overridden per chain, so a client can be pointed at a local Anvil
 * fork without editing the registry. Scripts call `setSettlementOverride`; a browser can set
 * `provecash.settlement.<chainId>` in localStorage and reload. The registry is still the answer
 * everywhere else, and an override never survives being cleared.
 */
const settlementOverrides = new Map<ChainId, Address>()

/** Override where a chain settles, or pass null to fall back to the registry. */
export function setSettlementOverride(id: ChainId, address: Address | null) {
  if (address) settlementOverrides.set(id, address)
  else settlementOverrides.delete(id)
  if (address) kv().setItem(`provecash.settlement.${id}`, address)
  else kv().removeItem(`provecash.settlement.${id}`)
}

function storedOverride(id: ChainId): Address | undefined {
  const v = kv().getItem(`provecash.settlement.${id}`)
  return v && v.startsWith('0x') ? (v as Address) : undefined
}

/**
 * Where a chain settles. The one resolver: an in-process override wins, then a stored one, then
 * the registry. Read `NETWORKS[id].settlement` directly and you skip every override.
 */
export const settlement = (id: ChainId = chainId): Address =>
  settlementOverrides.get(id) ?? storedOverride(id) ?? NETWORKS[id].settlement

// Must go through `settlement()`, not the registry: an override that lets a client sign against
// a local fork but leaves every button disabled is worse than no override at all.
/** True when a settlement contract exists to talk to on this chain. */
export const settlementLive = (id: ChainId = chainId) => settlement(id) !== ZERO_ADDRESS

/**
 * The day a chain's deployed build went on chain, or null when the registry names no settlement.
 *
 * The registry and not the override, on purpose. An override points a client at a fork, and a
 * fork is built from this tree rather than from the deployment this date describes.
 */
export const deployedOn = (id: ChainId = chainId): string | null => NETWORKS[id].deployedOn

/**
 * This chain's PulseX buy-and-burn: the destination the default fee config pays.
 *
 * Not something an intent names directly: it names a fee config, whose hash covers this address.
 */
export const feeTarget = (id: ChainId = chainId): Address => NETWORKS[id].feeTo

/** What `feeTarget` is, in words. */
export const feeTargetName = (id: ChainId = chainId): string => NETWORKS[id].feeToName

/** The suggested fee config and rates for this chain (`FeeDefaults`' first version). */
export const defaultFees = (id: ChainId = chainId): FeeDefaultsEntry => NETWORKS[id].fees.defaults

/**
 * Whether this build ships the config with this hash as one of the chain's defaults versions. A
 * `FeeDefaults` read can name any config its owner chose; only one the build was shipped with is
 * a config this build vouches for.
 */
export function isBundledFeeConfig(hash: string, id: ChainId = chainId): boolean {
  return NETWORKS[id].fees.history.some((h) => hashFeeConfig(h.config).toLowerCase() === hash.toLowerCase())
}

/** The stray config this chain's settlement is constructed with. */
export const strayFeeConfig = (id: ChainId = chainId): FeeConfig => NETWORKS[id].fees.strayConfig

/**
 * A `FeeDefaults` override per chain, for the reason `setReaderOverride` gives: a lab or a fork
 * deploys its own beside its own settlement. In-process only.
 */
const feeDefaultsOverrides = new Map<ChainId, Address>()

/** Override a chain's `FeeDefaults`, or pass null to fall back to the registry. */
export function setFeeDefaultsOverride(id: ChainId, address: Address | null) {
  if (address && address !== ZERO_ADDRESS) feeDefaultsOverrides.set(id, address)
  else feeDefaultsOverrides.delete(id)
}

/** This chain's `FeeDefaults`: an override, then the registry, or null until it is deployed. */
export const feeDefaultsAddress = (id: ChainId = chainId): Address | null =>
  feeDefaultsOverrides.get(id) ??
  (NETWORKS[id].feeDefaults === ZERO_ADDRESS ? null : NETWORKS[id].feeDefaults)

/**
 * A `ProveReader` override per chain, for the same reason as `setSettlementOverride`: a lab or a
 * fork deploys its own reader beside its own settlement, and the registry cannot name either.
 * In-process only. A reader answers reads and signs nothing, so there is no stored copy for a
 * browser to pick up by accident.
 */
const readerOverrides = new Map<ChainId, Address>()

/** Override a chain's `ProveReader`, or pass null to fall back to the registry. */
export function setReaderOverride(id: ChainId, address: Address | null) {
  if (address && address !== ZERO_ADDRESS) readerOverrides.set(id, address)
  else readerOverrides.delete(id)
}

/** This chain's `ProveReader`: an override, then the registry, or null until it is deployed. */
export const readerAddress = (id: ChainId = chainId): Address | null =>
  readerOverrides.get(id) ?? (NETWORKS[id].reader === ZERO_ADDRESS ? null : NETWORKS[id].reader)

/**
 * A chain's venues can be overridden, so a client can be pointed at a market the registry has
 * never heard of — a local Anvil, or a fork with its own factory. Scripts call
 * `setXykVenuesOverride`; a browser can set `provecash.xyk.<chainId>` in localStorage and reload.
 * The registry is still the answer everywhere else, and an override never survives being cleared.
 *
 * The registry's own note on `Network.xyk` says why this has to exist: these addresses differ per
 * chain, and hard-coding one of them is what made testnet look for months as though it had no
 * market at all. A fork is the same problem one step further on — the router has no code there.
 */
const xykOverrides = new Map<ChainId, readonly XykVenue[]>()

/**
 * Override the venues a chain quotes against, or pass null to fall back to the registry.
 *
 * An empty list is an override, not a clear: it says "this chain has no market", which is a
 * thing a fork can genuinely be. Only null gives the registry back.
 */
export function setXykVenuesOverride(id: ChainId, venues: readonly XykVenue[] | null) {
  if (venues) xykOverrides.set(id, venues)
  else xykOverrides.delete(id)
  if (venues) kv().setItem(`provecash.xyk.${id}`, serializeVenues(venues))
  else kv().removeItem(`provecash.xyk.${id}`)
}

/**
 * The stored form. JSON, with the two fee numbers written as decimal strings.
 *
 * `JSON.stringify` throws on a bigint rather than dropping it, and `feeNum` and `feeDen` are
 * bigints — a venue is a fraction the solver multiplies exact integers by, and a float would put
 * a rounding error inside the curve the chain is about to walk.
 */
const serializeVenues = (venues: readonly XykVenue[]): string =>
  JSON.stringify(venues, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))

function storedVenues(id: ChainId): readonly XykVenue[] | undefined {
  const raw = kv().getItem(`provecash.xyk.${id}`)
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return undefined
    return parsed.map((v: Record<string, unknown>) => ({
      label: String(v.label),
      router: v.router as Address,
      factory: v.factory as Address,
      feeNum: BigInt(v.feeNum as string),
      feeDen: BigInt(v.feeDen as string),
    }))
  } catch {
    // A stored override nobody can parse is not a market. Reporting the registry's venues is the
    // only safe reading of it, and it is what a cleared override does anyway.
    return undefined
  }
}

/**
 * Every constant-product venue on a chain, in registry order. Empty when it has none.
 *
 * The one resolver, exactly as `settlement()` is: an in-process override wins, then a stored one,
 * then the registry. Read `NETWORKS[id].xyk` directly and you skip every override.
 */
export const xykVenues = (id: ChainId = chainId): readonly XykVenue[] =>
  xykOverrides.get(id) ?? storedVenues(id) ?? NETWORKS[id].xyk

/** The venue on a chain with this label, or undefined when the chain has no such deployment. */
export const xykVenue = (label: string, id: ChainId = chainId): XykVenue | undefined =>
  xykVenues(id).find((v) => v.label === label)

/**
 * The chain's leading router. Zero when it has none.
 *
 * Only for a caller that has to name exactly one address — a swap it is about to send, an
 * allowance it is about to raise. Anything that *reads* the market should take `xykVenues` and
 * price all of them, because the leading venue is only the leader by list order and the other one
 * regularly pays better.
 */
export const xykRouter = (id: ChainId = chainId): Address =>
  xykVenues(id)[0]?.router ?? ZERO_ADDRESS

/** True when this chain has at least one constant-product market to quote against. */
export const xykLive = (id: ChainId = chainId) => xykVenues(id).length > 0

/** The tokens the registry offers on one chain. */
export const presetTokens = (id: ChainId = chainId): readonly PresetToken[] => NETWORKS[id].tokens

/** Every preset token on every chain. A caller that means one chain wants `presetTokens`. */
export const allPresetTokens = (): readonly PresetToken[] => NETWORK_LIST.flatMap((n) => n.tokens)

// ── Where pools are discovered ────────────────────────────────────────────────

/**
 * One venue's PulseX subgraph: where the solver asks which pairs exist.
 *
 * Keyed by factory, never by label. A subgraph indexes one factory, and `pulseXFactories { id }`
 * names it, so the client checks that answer against this key before it trusts a single pair.
 * A label can be renamed; a factory address cannot.
 *
 * **Discovery only.** A subgraph ranks pairs and lists them. It never prices a fill, and the
 * solver never reads its reserves. The chain gives every reserve, through `getReserves` and
 * `Sync`. See `sdk/src/solver/subgraph.ts`.
 *
 * Measured on 2026-09-23: all three answer within two blocks of the chain head, and none reports
 * an indexing error. v1 lists 65,351 pairs, v2 187,810, and testnet 5,780, which equals its
 * factory's `allPairsLength`.
 */
export type VenueSubgraph = { factory: Address; url: string }

const SUBGRAPHS: Record<ChainId, readonly VenueSubgraph[]> = {
  369: [
    {
      factory: '0x29eA7545DEf87022BAdc76323F373EA1e707C523',
      url: 'https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsexv2',
    },
    {
      factory: '0x1715a3E4A142d8b698131108995174F37aEBA10D',
      url: 'https://graph.pulsechain.com/subgraphs/name/pulsechain/pulsex',
    },
  ],
  943: [
    {
      factory: '0xFf0538782D122d3112F75dc7121F61562261c0f7',
      url: 'https://graph.v4.testnet.pulsechain.com/subgraphs/name/pulsechain/pulsex',
    },
  ],
}

/**
 * The subgraph for one venue, or null when none indexes its factory.
 *
 * A venue override (a fork, a local anvil) has a factory no subgraph knows. It gets null, and the
 * solver then prices that venue the old way. That is correct: a subgraph of mainnet lists pairs
 * the fork's factory never made.
 */
export const venueSubgraph = (venue: XykVenue, id: ChainId = chainId): VenueSubgraph | null =>
  SUBGRAPHS[id].find((s) => s.factory.toLowerCase() === venue.factory.toLowerCase()) ?? null

// ── Request headers per endpoint ──────────────────────────────────────────────

/**
 * Headers every client this package builds on one endpoint URL carries. In memory only.
 *
 * The valve gateway takes its key in an `X-API-Key` header, because a key in a URL path reaches
 * access logs and every upstream hop. A bot therefore points the SDK at the keyless URL and
 * registers the header here, and `rpcClient` sends it with every request to that exact URL.
 *
 * Keyed by the whole URL on purpose. A header registered for the gateway never goes to another
 * host, such as an operator's own node. And it is never written to the key-value store, which is
 * `localStorage` in a browser: a key must not outlive the process that was given it. A browser
 * that registers nothing sees no change at all.
 */
const endpointHeaders = new Map<string, Readonly<Record<string, string>>>()

/** Send `headers` with every request to `url`. Null or an empty object stops sending them. */
export function setRpcHeaders(url: string, headers: Record<string, string> | null): void {
  if (headers && Object.keys(headers).length > 0) endpointHeaders.set(url, { ...headers })
  else endpointHeaders.delete(url)
}

/** The headers registered for exactly this URL, if any. */
export const rpcHeadersFor = (url: string): Readonly<Record<string, string>> | undefined =>
  endpointHeaders.get(url)
