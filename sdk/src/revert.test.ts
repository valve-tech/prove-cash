import { describe, expect, it } from 'vitest'
import { BaseError, encodeErrorResult, parseAbi } from 'viem'
import { TOKEN_ERRORS, explainRevert, revertDataOf } from './revert.js'

/**
 * What a failed call is allowed to tell us.
 *
 * The solver logged `reverted with the following signature:` and then nothing, for hours, while
 * rings quietly refused to settle. The failure was real and the message carried none of it. These
 * tests say the message always carries something a person can act on.
 */

const VENUE_ERRORS = parseAbi(['error InsufficientLiquidity(address pair, uint256 want)'])

/** A viem-shaped error: the payload sits some way down a `cause` chain. */
const wrap = (data: `0x${string}`, depth = 3) => {
  let e: unknown = { data }
  for (let i = 0; i < depth; i++) e = { cause: e }
  return e
}

describe('revertDataOf', () => {
  it('digs the payload out of a nested cause chain', () => {
    const data = encodeErrorResult({
      abi: TOKEN_ERRORS,
      errorName: 'ERC20InvalidSender',
      args: ['0x0000000000000000000000000000000000000001'],
    })
    expect(revertDataOf(wrap(data, 8))).toBe(data)
  })

  it('gives back null when there is no payload, rather than a fragment', () => {
    expect(revertDataOf(new Error('connection reset'))).toBeNull()
    expect(revertDataOf(wrap('0x' as `0x${string}`))).toBeNull()
  })
})

describe('explainRevert', () => {
  it('names an ERC-20 failure and its amounts without being told the token ABI', () => {
    const data = encodeErrorResult({
      abi: TOKEN_ERRORS,
      errorName: 'ERC20InsufficientBalance',
      args: ['0x00000000000000000000000000000000000000aa', 1n, 214n],
    })
    expect(explainRevert(wrap(data))).toBe(
      'ERC20InsufficientBalance(0x00000000000000000000000000000000000000AA, 1, 214)',
    )
  })

  it('reads an error the caller knows about, which no token ABI carries', () => {
    const data = encodeErrorResult({
      abi: VENUE_ERRORS,
      errorName: 'InsufficientLiquidity',
      args: ['0x00000000000000000000000000000000000000bb', 5n],
    })
    expect(explainRevert(wrap(data), [VENUE_ERRORS as never])).toBe(
      'InsufficientLiquidity(0x00000000000000000000000000000000000000bb, 5)',
    )
  })

  it('decodes a plain require string', () => {
    const data = encodeErrorResult({
      abi: parseAbi(['error Error(string)']),
      errorName: 'Error',
      args: ['UniswapV2: K'],
    })
    expect(explainRevert(wrap(data))).toBe('Error(UniswapV2: K)')
  })

  it('decodes a panic', () => {
    const data = encodeErrorResult({
      abi: parseAbi(['error Panic(uint256)']),
      errorName: 'Panic',
      args: [17n],
    })
    expect(explainRevert(wrap(data))).toBe('Panic(17)')
  })

  it('prints the selector when nothing decodes, so the cause is still greppable', () => {
    expect(explainRevert(wrap('0xdeadbeef'))).toContain('0xdeadbeef')
  })

  it('never returns a multi-line message, because a log line is one line', () => {
    const e = new BaseError('short', { metaMessages: ['one', 'two'] })
    expect(explainRevert(e)).not.toContain('\n')
  })

  it('falls back to the first line of an ordinary error', () => {
    expect(explainRevert(new Error('nonce too low\nat some frame'))).toBe('nonce too low')
  })

  it('says something even when handed nothing at all', () => {
    expect(explainRevert(undefined)).toBe('simulation failed')
  })
})
