import { defaultFeeTerms, type DefaultFeeConfig, type FeeConfig, type FeeTerms } from '@prove.cash/sdk'

/**
 * The fee terms a bot signs from the chain's defaults, with the preimage its signature needs.
 *
 * `signIntent` builds typed data with the config's destinations in place of its hash, so a
 * non-zero `feeConfig` signs only when the preimage is passed or this process remembered it.
 * The bots used to pass neither, so every tick that named a fee config threw before it posted.
 * The preimage here is the one the defaults were read with: `readFeeDefaults` returns a config
 * only when it hashes to the record's `feeConfig`, and the registry copy is bundled.
 *
 * `cut` is the bot's own rate out of its number (P3), which replaces the defaults' P3.
 * Null when there are no defaults to sign.
 */
export function botFeeTerms(
  def: DefaultFeeConfig | null,
  cut: bigint,
): { terms: FeeTerms; preimage: FeeConfig } | null {
  if (def === null) return null
  return { terms: { ...defaultFeeTerms(def), feeRateProceeds: cut }, preimage: def.config }
}
