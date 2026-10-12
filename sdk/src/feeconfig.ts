import { concat, encodeAbiParameters, getAddress, keccak256, toHex, type Address, type Hex } from 'viem'

/**
 * A fee config: who an intent's fees reach, and in what shares.
 *
 * An intent signs the HASH of one (`Intent.feeConfig`), so a destination exists because a maker
 * named it. There is no registry and nobody to ask. This file is `FeeConfig.sol` in TypeScript,
 * byte for byte: `contracts/test/FeeConfig.t.sol` writes `app/src/lib/__fixtures__/fee-config.json`
 * and `feeconfig.test.ts` holds every hash, fault and split here to it.
 *
 * Pure. Nothing fetches and nothing reads a clock.
 */

/** One ether. A weight sum and a rate denominator. */
export const WAD = 10n ** 18n

/** A claim makes at most this many token transfers. */
export const MAX_DESTINATIONS = 8

/** The EIP-712 type of a config. A future format uses a new type name, never an edit. */
export const FEE_CONFIG_TYPE = 'FeeConfig(address[] destinations,uint256[] weights)'
export const FEE_CONFIG_TYPEHASH: Hex = keccak256(toHex(FEE_CONFIG_TYPE))

/** The destinations and weights an intent's `feeConfig` hashes. */
export type FeeConfig = {
  /** Strictly ascending by address, none zero, 1 to `MAX_DESTINATIONS`. */
  destinations: readonly Address[]
  /** Each above zero, one per destination, summing to `WAD`. */
  weights: readonly bigint[]
}

/** `FeeConfig.Fault`, in its declared order. `ReservedDestination` is the settlement's own rule. */
export const FEE_CONFIG_FAULTS = [
  'None',
  'NoDestinations',
  'TooMany',
  'LengthMismatch',
  'ZeroDestination',
  'NotAscending',
  'ZeroWeight',
  'WeightsDoNotSumToWad',
  'ReservedDestination',
] as const
export type FeeConfigFault = (typeof FEE_CONFIG_FAULTS)[number]

const word = (v: bigint): Hex => toHex(v, { size: 32 })
const addrWord = (a: Address): Hex => toHex(BigInt(a), { size: 32 })

/**
 * `hashStruct(config)` in EIP-712 — what `Intent.feeConfig` is. It accepts any arrays, valid or
 * not, exactly as the contract's `hash` does; `feeConfigFault` is the separate question.
 */
export function hashFeeConfig(c: FeeConfig): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [
        FEE_CONFIG_TYPEHASH,
        keccak256(concat(c.destinations.map(addrWord))),
        keccak256(concat(c.weights.map(word))),
      ],
    ),
  )
}

/** The config that pays one destination everything. */
export const singleFeeConfig = (destination: Address): FeeConfig => ({
  destinations: [getAddress(destination)],
  weights: [WAD],
})

/** `hashFeeConfig(singleFeeConfig(d))`: the key a deferred share is re-booked under. */
export const singleFeeConfigHash = (destination: Address): Hex =>
  hashFeeConfig(singleFeeConfig(destination))

/** Why the chain would refuse this config, or `'None'`. Context-free, as `FeeConfig.fault`. */
export function feeConfigFault(c: FeeConfig): FeeConfigFault {
  const n = c.destinations.length
  if (n === 0) return 'NoDestinations'
  if (n > MAX_DESTINATIONS) return 'TooMany'
  if (c.weights.length !== n) return 'LengthMismatch'
  if (BigInt(c.destinations[0]) === 0n) return 'ZeroDestination'
  let sum = 0n
  for (let k = 0; k < n; k++) {
    if (k !== 0 && BigInt(c.destinations[k]) <= BigInt(c.destinations[k - 1])) return 'NotAscending'
    const w = c.weights[k]
    if (w === 0n) return 'ZeroWeight'
    if (w > WAD) return 'WeightsDoNotSumToWad'
    sum += w
  }
  return sum === WAD ? 'None' : 'WeightsDoNotSumToWad'
}

/**
 * Divide `amount` by `weights`: floor for every share but the last, which takes the remainder, so
 * the shares add to `amount` exactly and nothing is left behind.
 */
export function splitByWeights(amount: bigint, weights: readonly bigint[]): bigint[] {
  const shares: bigint[] = []
  let given = 0n
  for (let k = 0; k + 1 < weights.length; k++) {
    const s = (amount * weights[k]) / WAD
    shares.push(s)
    given += s
  }
  if (weights.length) shares.push(amount - given)
  return shares
}

/** `floor(base * rate / WAD)`: every fee at every take point. */
export const feeOf = (base: bigint, rate: bigint): bigint => (base * rate) / WAD

/** The gross that leaves `net` after a cut of `rate`: `ceilDiv(net * WAD, WAD - rate)`. */
export function grossForNetCut(net: bigint, rate: bigint): bigint {
  if (net === 0n) return 0n
  return (net * WAD - 1n) / (WAD - rate) + 1n
}

/** The three rates, by take point: P1 handover, P2 output, P3 proceeds. Fractions of `WAD`. */
export type PointRates = { handover: bigint; output: bigint; proceeds: bigint }

/**
 * The suggested config and rates of one defaults version: what `FeeDefaults.current()` publishes,
 * and what `contracts/config/fee-configs.json` mirrors for CI. A sign-time pointer, never a
 * fill-time one: the settlement reads none of it.
 */
export type FeeDefaultsEntry = {
  /** A name for the version. Not on chain. */
  id: string
  config: FeeConfig
  rates: PointRates
  /** The rate above which a client warns at each point. A display threshold, not a limit. */
  warn: PointRates
  /** What the destination is, for a person. A proper name, so it is not translated. */
  label: string
}
