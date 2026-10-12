/**
 * Measured gas, generated. Do not edit.
 *
 *   cd app && node scripts/gen-gas.mjs
 *
 * Source: contracts/test/Gas.t.sol. `total` is the whole call, `each` is per intent for the
 * batch rows and the same as `total` everywhere else.
 */
export const GAS = {
  "fill, allowance, first touch": { total: 214942, each: 214942 },
  "fill, allowance, warm": { total: 124975, each: 124975 },
  "fill, escrow, cold slots": { total: 148647, each: 148647 },
  "fill, escrow, warm": { total: 131561, each: 131561 },
  "deposit, first touch": { total: 126132, each: 126132 },
  "fillWithCallback": { total: 139561, each: 139561 },
  "fillBatch x20, one token": { total: 1284557, each: 64227 },
  "fillBatch marginal intent": { total: 1135841, each: 59781 },
  "fillBatch x20, alternating": { total: 1308599, each: 65429 },
  "fillBatchWithCallback x20": { total: 1292854, each: 64642 },
  "the credit premium, per leg": { total: 1597, each: 1597 },
  "eight legs, one batch": { total: 695959, each: 86994 },
  "eight legs, one at a time": { total: 1190037, each: 148754 },
  "one more leg that fills": { total: 69841, each: 69841 },
  "one more leg, expired": { total: 15218, each: 15218 },
  "one more leg a rival took": { total: 15982, each: 15982 },
  "one more leg whose nonce was burnt": { total: 48569, each: 48569 },
  "one more leg with a bad signature": { total: 74353, each: 74353 },
  "one more permit2 leg that fills": { total: 163104, each: 163104 },
  "one more leg the maker unfunded": { total: 80174, each: 80174 },
  "atomic 3, all fill": { total: 283087, each: 94362 },
  "atomic 2, the FIRST leg gone": { total: 59727, each: 59727 },
  "atomic 2, one leg gone": { total: 155799, each: 155799 },
  "atomic 3, one leg gone": { total: 222044, each: 222044 },
  "atomic 8, the FIRST leg gone": { total: 121329, each: 121329 },
  "atomic 8, the LAST leg gone": { total: 554731, each: 554731 },
  "claim, a destination empties its book": { total: 65042, each: 65042 },
  "a fallback carried, the first": { total: 19630, each: 19630 },
  "a fallback carried, each after": { total: 20537, each: 20537 },
  "a solver's first sink, once ever": { total: 59323, each: 59323 },
} as const satisfies Record<string, { total: number; each: number }>

export type GasKey = keyof typeof GAS
