import { describe, expect, it } from 'vitest'
import { keccak256, toHex } from 'viem'
import { PERMIT_TYPES, RECEIVE_WITH_AUTHORIZATION_TYPES } from './custody.js'

/**
 * The typed-data shapes, pinned against the standards that define them.
 *
 * A wrong field name, a wrong order, or a wrong type produces a different typehash, and a
 * different typehash produces a signature the token rejects. Nothing else in the stack notices:
 * the wallet signs, the codec encodes, the board carries it, and the failure only surfaces on
 * chain when the fill reverts. So the hashes are compared to the literal strings from the
 * specifications rather than rebuilt from the same table they are meant to check.
 */

/** Rebuild the EIP-712 type string the way a signer does, from the field table. */
function typeString(name: string, fields: readonly { name: string; type: string }[]): string {
  return `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`
}

describe('the EIP-2612 permit', () => {
  it('hashes to the typehash the standard names', () => {
    // Straight from EIP-2612. Every 2612 token on chain computes this exact string.
    const spec = 'Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'
    expect(typeString('Permit', PERMIT_TYPES.Permit)).toBe(spec)
    expect(keccak256(toHex(typeString('Permit', PERMIT_TYPES.Permit)))).toBe(
      keccak256(toHex(spec)),
    )
  })

  it('keeps the field order the hash depends on', () => {
    expect(PERMIT_TYPES.Permit.map((f) => f.name)).toEqual([
      'owner',
      'spender',
      'value',
      'nonce',
      'deadline',
    ])
  })
})

describe('the EIP-3009 authorization', () => {
  it('signs the receive variant, never the transfer one', () => {
    // `transferWithAuthorization` is a permissionless relay: anybody holding a copy could push
    // the maker's tokens to the settlement with no reservation credited, spending the nonce and
    // losing the lot. The receive variant requires `to == msg.sender`. Only the name differs
    // between the two typehashes, which is exactly why this is worth a test.
    const spec =
      'ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'
    expect(
      typeString('ReceiveWithAuthorization', RECEIVE_WITH_AUTHORIZATION_TYPES.ReceiveWithAuthorization),
    ).toBe(spec)
    expect(Object.keys(RECEIVE_WITH_AUTHORIZATION_TYPES)).toEqual(['ReceiveWithAuthorization'])
  })
})
