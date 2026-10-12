import { BaseError, ContractFunctionRevertedError, parseAbi, decodeErrorResult, type Abi, type Hex } from 'viem'

/**
 * Naming the error a chain actually raised.
 *
 * viem decodes a revert against the one ABI it was handed, which is the contract that was called.
 * A fill does not fail there. It fails inside the token, or inside the venue the route swaps
 * through, and those errors are not on the settlement's ABI — so viem gives back a bare four-byte
 * selector and the log says nothing. `0xe450d38c` wore three different causes in one afternoon on
 * 943, and each one cost an hour to find because the log printed the selector and stopped.
 *
 * So: try every ABI the caller knows, then the errors any ERC-20 can raise, and if nothing
 * decodes still print the selector. A name is worth an hour; the raw selector is worth a grep.
 */

/** The errors a token raises that are on nobody's contract ABI. */
export const TOKEN_ERRORS = parseAbi([
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InvalidSender(address sender)',
  'error ERC20InvalidReceiver(address receiver)',
  'error ERC20InvalidApprover(address approver)',
  'error ERC20InvalidSpender(address spender)',
])

/** The revert payload buried somewhere in a viem error chain, if there is one. */
export function revertDataOf(e: unknown): Hex | null {
  let c: unknown = e
  for (let i = 0; i < 12 && c; i++) {
    const d = (c as { data?: unknown }).data
    if (typeof d === 'string' && d.startsWith('0x') && d.length >= 10) return d as Hex
    c = (c as { cause?: unknown }).cause
  }
  return null
}

/**
 * A one-line reason for a failed call, decoded against `abis` and then against the token errors.
 *
 * Pass the ABI of every contract the call can revert inside, not just the one it entered.
 */
export function explainRevert(e: unknown, abis: readonly Abi[] = []): string {
  const data = revertDataOf(e)
  if (data) {
    // `decodeErrorResult` knows `Error(string)` and `Panic(uint256)` itself, so those need no
    // entry here — any ABI at all decodes them.
    for (const abi of [...abis, TOKEN_ERRORS as unknown as Abi]) {
      try {
        const d = decodeErrorResult({ abi, data })
        const args = (d.args ?? []).map((a) => String(a)).join(', ')
        return args ? `${d.errorName}(${args})` : `${d.errorName}()`
      } catch {
        /* the next ABI may know it */
      }
    }
    // Nothing knows this one. The selector is still the most useful four bytes we have: it is
    // what you grep the contracts for, and it is exactly what the old code threw away.
    return `reverted ${data.slice(0, 10)}`
  }

  // No payload at all — the call never reached a contract. Take viem's reading, on one line.
  if (e instanceof BaseError) {
    const r = e.walk((err) => err instanceof ContractFunctionRevertedError)
    if (r instanceof ContractFunctionRevertedError) {
      const name = r.data?.errorName ?? r.signature
      if (name) return name
    }
    return e.shortMessage.split('\n').filter(Boolean).join(' ')
  }
  const m = (e as Error)?.message
  return m ? m.split('\n')[0] : 'simulation failed'
}
