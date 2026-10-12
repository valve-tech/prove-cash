import type { Account, Address, Hex } from 'viem'
import { FEE_DEFAULTS_ABI, READER_ABI, SETTLEMENT_ABI } from './abi.js'
import type { ProveWalletClient } from './client.js'
import {
  feeDefaultsAddress,
  getChainId,
  readerAddress,
  settlement,
  settlementLive,
  strayFeeConfig,
  type ChainId,
} from './config.js'
import { assertDeployedAbi } from './deployed.js'
import { rpcClient } from './client.js'
import { feeConfigFault, hashFeeConfig, type FeeConfig, type PointRates } from './feeconfig.js'
import { feeConfigPreimageOf } from './intent.js'
import { batchRead } from './multicall.js'
import type { ReadOptions } from './settlement.js'

/**
 * The fee book on the chain: what is booked under a fee config, and paying it out.
 *
 * There is no registry. A fee is booked under the HASH of the config an intent signed, and
 * `claim(config, token)` pays that cell to the config's destinations by weight. Anyone may call
 * it, and the caller is never a destination by being the caller. A claim needs the preimage,
 * because the chain keeps only the hash; `announceFeeConfig` puts one in the logs, and
 * `ProveReader.remember` caches one.
 *
 * Every call meets the deployed-ABI guard first: a settlement from before the fee-config model
 * has a `claim(sink, token)` that pays a registered sink.
 */

/**
 * Both EIP-1559 fields, pinned by the caller. A write here never lets viem ask the node: chain
 * 943 suggests 500 gwei one minute and a zero tip the next, and a zero tip never mines.
 */
export type PinnedFees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

function writeTerms(wallet: ProveWalletClient, account: Address | Account, fees: PinnedFees | undefined) {
  if (!fees || fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) {
    throw new Error('Pin maxFeePerGas and maxPriorityFeePerGas. A claim never lets the node price it.')
  }
  const own = (wallet as { account?: Account }).account
  return {
    account: own ?? account,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  }
}

/** The calldata form of a config. */
const tuple = (c: FeeConfig) => ({ destinations: [...c.destinations], weights: [...c.weights] })

/**
 * What is booked under a fee config, per token, in order. Null where the read failed.
 * `pendingFees` is keyed by the config's hash, so this needs no preimage.
 */
export async function readPendingFees(
  feeConfig: Hex,
  tokens: readonly Address[],
  opts: ReadOptions = {},
): Promise<(bigint | null)[]> {
  const id = opts.chainId ?? getChainId()
  if (!settlementLive(id) || tokens.length === 0) return tokens.map(() => null)
  const address = settlement(id)
  const results = await batchRead(
    tokens.map((token) => ({
      address,
      abi: SETTLEMENT_ABI,
      functionName: 'pendingFees',
      args: [feeConfig, token],
    })),
    opts.client,
  )
  return results.map((r) => (r.ok ? (r.value as bigint) : null))
}

/**
 * Pay a config's destinations everything booked under it in one token.
 *
 * Anybody may call it. It refuses before the wallet opens when the chain has no settlement, when
 * the build predates the model, and when the config is not a valid one (the contract reverts
 * `InvalidConfig` for that too; refusing here says which fault).
 */
export async function claimFees(
  wallet: ProveWalletClient,
  account: Address | Account,
  config: FeeConfig,
  token: Address,
  fees: PinnedFees,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  assertDeployedAbi('claim', chainId)
  const fault = feeConfigFault(config)
  if (fault !== 'None') throw new Error(`That fee config is invalid (${fault}); claim would revert.`)
  const terms = writeTerms(wallet, account, fees)
  return wallet.writeContract({
    ...terms,
    address: settlement(chainId),
    abi: SETTLEMENT_ABI,
    functionName: 'claim',
    args: [tuple(config), token],
  } as never)
}

/**
 * Pay the book of a fee config named by its HASH, with the preimage this process already holds:
 * one it vouches for, one a board post carried (`readIntent` keeps those), or the chain's stray
 * config. No chain read. Throws, before the wallet opens, when no preimage for the hash is to hand.
 */
export async function claimFeesFor(
  wallet: ProveWalletClient,
  account: Address | Account,
  feeConfig: Hex,
  token: Address,
  fees: PinnedFees,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  const stray = strayFeeConfig(chainId)
  const config =
    feeConfigPreimageOf(feeConfig) ??
    (hashFeeConfig(stray).toLowerCase() === feeConfig.toLowerCase() ? stray : null)
  if (!config) throw new Error(`No preimage is known for fee config ${feeConfig}; claim needs one.`)
  return claimFees(wallet, account, config, token, fees, chainId)
}

/**
 * Put a config's preimage in the settlement's logs (`FeeConfigAnnounced`), for indexers and claim
 * keepers. Logs only; not a gate, and it books nothing.
 */
export async function announceFeeConfig(
  wallet: ProveWalletClient,
  account: Address | Account,
  config: FeeConfig,
  fees: PinnedFees,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  assertDeployedAbi('announceFeeConfig', chainId)
  const terms = writeTerms(wallet, account, fees)
  return wallet.writeContract({
    ...terms,
    address: settlement(chainId),
    abi: SETTLEMENT_ABI,
    functionName: 'announceFeeConfig',
    args: [tuple(config)],
  } as never)
}

/** What `FeeDefaults.current()` publishes. */
export type CurrentFeeDefaults = {
  /** The hash of `config`, which is what an intent signs. */
  feeConfig: Hex
  /**
   * `FeeDefaults.current()`'s first return: the hash of the whole defaults record (config hash,
   * rates and warn rates). Not a fee config hash, and never what an intent signs.
   */
  defaultsHash?: Hex
  config: FeeConfig
  rates: PointRates
  warn: PointRates
  setAt: bigint
  /** How many versions have been published. */
  versions: bigint
}

/**
 * The chain's current suggested fee config and rates, or null when no `FeeDefaults` is deployed or
 * it answers nothing. A sign-time pointer, never a fill-time one: the settlement reads none of it.
 * A null is "unread", and a caller must not read it as a rate of zero.
 */
export async function readFeeDefaults(opts: ReadOptions = {}): Promise<CurrentFeeDefaults | null> {
  const id = opts.chainId ?? getChainId()
  const address = feeDefaultsAddress(id)
  if (address === null) return null
  const client = opts.client ?? rpcClient()
  try {
    const [current, versions] = await Promise.all([
      client.readContract({ address, abi: FEE_DEFAULTS_ABI, functionName: 'current' }),
      client.readContract({ address, abi: FEE_DEFAULTS_ABI, functionName: 'versions' }),
    ])
    // The first value is the DEFAULTS hash (the record's own key), not the config's. The config
    // hash is `rec.feeConfig`, and the preimage must hash to that. Comparing against the first
    // value made every live read null, so every form and bot refused to sign the moment a
    // `FeeDefaults` was deployed.
    const [defaultsHash, rec] = current as unknown as readonly [
      Hex,
      {
        feeConfig: Hex
        rates: { handover: bigint; output: bigint; proceeds: bigint }
        warn: { handover: bigint; output: bigint; proceeds: bigint }
        setAt: bigint
        config: { destinations: readonly Address[]; weights: readonly bigint[] }
      },
    ]
    const config = { destinations: rec.config.destinations, weights: rec.config.weights }
    if (hashFeeConfig(config).toLowerCase() !== rec.feeConfig.toLowerCase()) return null
    return {
      feeConfig: rec.feeConfig,
      defaultsHash,
      config,
      rates: { handover: BigInt(rec.rates.handover), output: BigInt(rec.rates.output), proceeds: BigInt(rec.rates.proceeds) },
      warn: { handover: BigInt(rec.warn.handover), output: BigInt(rec.warn.output), proceeds: BigInt(rec.warn.proceeds) },
      setAt: BigInt(rec.setAt),
      versions: versions as bigint,
    }
  } catch {
    return null
  }
}

/** True when a reader is deployed here: `ProveReader` answers `explainTake`, `available`, and more. */
export const hasReader = (id: ChainId = getChainId()): boolean => readerAddress(id) !== null

export { READER_ABI }
