/**
 * How an address reads on a screen.
 *
 * The same one-liner sat in five files — `App.tsx`, `Compose.tsx`, `IntentRow.tsx`,
 * `charts/chart.ts` and, once the RFQ form needed it, an export out of `Compose.tsx`. That last
 * one is what forced the question: a component file that exports a helper stops working with
 * fast refresh, and the lint says so.
 *
 * `lib/amount.ts` records the same story for typed amounts. A helper that two surfaces need is
 * not a component's business, and five copies are how one surface starts showing six leading
 * characters while another shows eight.
 */

/** Six characters, an ellipsis, and the last four. Enough to recognise, too short to retype. */
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
