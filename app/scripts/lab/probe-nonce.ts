/** The nonce gap on an account. A pending-minus-latest above zero is a blocker, not a slow chain. */
import type { Address } from 'viem'
import { log, pub } from '../e2e/common.ts'

const who = (process.argv[2] ?? '') as Address
if (!who) throw new Error('usage: probe-nonce.ts 0xAddress')
const [latest, pending] = await Promise.all([
  pub.getTransactionCount({ address: who, blockTag: 'latest' }),
  pub.getTransactionCount({ address: who, blockTag: 'pending' }),
])
log(`${who}  latest ${latest} · pending ${pending} · gap ${pending - latest}`)
if (pending > latest) log('a transaction the miners will not take is blocking every later nonce — see scripts/unjam.ts')
