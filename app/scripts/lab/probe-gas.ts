/** Native balance of an address, so a send is not attempted on an empty account. */
import { formatUnits, type Address } from 'viem'
import { log, pub } from '../e2e/common.ts'

const who = (process.argv[2] ?? '') as Address
if (!who) throw new Error('usage: probe-gas.ts 0xAddress')
log(`${who}  ${formatUnits(await pub.getBalance({ address: who }), 18)} PLS`)
