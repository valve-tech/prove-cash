/**
 * Letters for a token's fallback mark when no logo loads.
 *
 * Testnet faucet stand-ins are spelled with a lowercase `t` prefix (`tUSDC`, `tWETH`). A blank
 * `toUpperCase()` on the first two characters turned that into `TU` / `TW`, which reads as a
 * different ticker and loses the prefix the registry and the chain both use. Keep the leading
 * `t` lowercase; capitalise only what follows inside the two-character mark.
 *
 * Everything else still uppercases both letters (`WPLS` → `WP`, `DAI` → `DA`).
 */
export function markLetters(symbol: string): string {
  if (symbol.length >= 2 && symbol[0] === 't' && symbol[1] !== 't') {
    // `tt` would be pathological; a single leading `t` before an alnum is the faucet convention.
    if (/^t[A-Za-z0-9]/.test(symbol)) {
      return `t${symbol[1]!.toUpperCase()}`
    }
  }
  return symbol.slice(0, 2).toUpperCase()
}
