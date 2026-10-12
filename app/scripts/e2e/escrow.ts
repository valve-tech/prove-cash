/**
 * Escrow, the whole lifecycle, on chain 943.
 *
 *   deposit → fill from escrow → deposit again → withdraw
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     npx tsx scripts/e2e/escrow.ts
 *
 * This was two phases with a state file between them, because the withdrawal waited out a
 * fifteen-minute cooldown and no CI job should hold a sleep that long. The cooldown is gone —
 * every fill path settles in one transaction, so there was never an executor for it to protect —
 * and the whole lifecycle now runs in one pass in under a minute.
 */
import { formatUnits, parseEther, type Hex } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_ESCROW,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  signingDomain,
  intentHashOf,
  quote,
  toStruct,
  type Intent,
  signIntent,
} from '@prove.cash/sdk'
import {
  boundFor,
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  SETTLEMENT,
  balanceOf,
  chainNow,
  derive,
  ensureAllowance,
  finish,
  head,
  log,
  must,
  pub,
  show,
  token,
  topUpGas,
  topUpToken,
  units,
  walletFor,
  write,
} from './common.js'


const IN = token('tPLSX')
const OUT = token('tUSDC')

const maker = derive('prove.cash/e2e/escrow-maker')
const executor = derive('prove.cash/e2e/executor')
const makerWallet = walletFor(maker)
const executorWallet = walletFor(executor)

const FILL_AMOUNT = units(IN, '100')
const FILL_RATE = units(OUT, '3') // 100 tPLSX asks 3 tUSDC
const PARK_AMOUNT = units(IN, '50')



async function sign(intent: Intent): Promise<Hex> {
  return signIntent(maker, intent, { domain: signingDomain(CHAIN) })
}

/** The reservation the contract holds against one intent. */
async function reservation(hash: Hex): Promise<{ amount: bigint }> {
  const amount = (await pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'reserved',
    args: [hash],
  })) as bigint
  return { amount }
}

// ── Phase A ───────────────────────────────────────────────────────────────────

{
  head('setup')
  log(`maker    ${maker.address}`)
  log(`executor ${executor.address}`)
  await topUpGas(maker.address, parseEther('0.1'), 'escrow maker')
  await topUpGas(executor.address, parseEther('0.3'), 'executor')
  await topUpToken(IN, maker.address, FILL_AMOUNT + PARK_AMOUNT, 'escrow maker')
  await topUpToken(OUT, executor.address, units(OUT, '10'), 'executor')
  await ensureAllowance(makerWallet, IN, FILL_AMOUNT + PARK_AMOUNT, 'maker')
  await ensureAllowance(executorWallet, OUT, units(OUT, '10'), 'executor')

  const now = await chainNow()

  // ── The intent that gets filled out of escrow ───────────────────────────────
  head('a signed intent, backed by escrow rather than an allowance')
  const filled: Intent = {
    maker: maker.address,
    recipient: maker.address,
    tokenIn: IN.address,
    tokenOut: OUT.address,
    amountIn: FILL_AMOUNT,
    minOutStart: FILL_RATE,
    minOutEnd: FILL_RATE,
    // A straight line across the whole window: kind 0, and the word it reads none of.
    curve: CURVE_LINEAR,
    startTime: now - 60n,
    endTime: now + 7200n,
    executor: ZERO,
    feeConfig: FEE_CONFIG,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeRate: FEE_RATE,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: FLAG_ESCROW,
    nonce: BigInt(Date.now()),
  }
  const filledSig = await sign(filled)
  const filledHash = intentHashOf(filled, CHAIN)

  const onChainHash = (await pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'hashIntent',
    args: [toStruct(filled)],
  })) as Hex
  must(onChainHash === filledHash, `the SDK digest is the contract's digest · ${filledHash}`)

  const makerInBefore = await balanceOf(IN, maker.address)
  const makerOutBefore = await balanceOf(OUT, maker.address)

  await write(
    makerWallet,
    {
      address: SETTLEMENT,
      abi: SETTLEMENT_ABI,
      functionName: 'deposit',
      args: [toStruct(filled), FILL_AMOUNT],
    },
    `deposited ${show(IN, FILL_AMOUNT)} into the intent's escrow`,
  )

  const held = await reservation(filledHash)
  must(held.amount === FILL_AMOUNT, `the contract reserves ${show(IN, held.amount)} for this intent`)
  must(
    (await balanceOf(IN, maker.address)) === makerInBefore - FILL_AMOUNT,
    'the tokens left the maker and are now in the contract',
  )

  // ── The fill draws on the escrow, not on any allowance ──────────────────────
  head('an executor fills it out of the escrow')
  const escrowBefore = await balanceOf(IN, SETTLEMENT)
  const executorInBefore = await balanceOf(IN, executor.address)

  const fillReceipt = (
    await write(
      executorWallet,
      {
        address: SETTLEMENT,
        abi: SETTLEMENT_ABI,
        functionName: 'fill',
        args: [toStruct(filled), filledSig, FILL_AMOUNT, boundFor([filled])],
      },
      'filled from escrow',
    )
  ).receipt
  const at = (await pub.getBlock({ blockNumber: fillReceipt.blockNumber })).timestamp

  // The maker no longer receives what they signed for. The fee comes out of the signed number,
  // so the floor to check against is `delivered`, and `gross` is only the executor's outlay.
  const { gross, delivered: owed } = quote(filled, FILL_AMOUNT, at)
  const received = (await balanceOf(OUT, maker.address)) - makerOutBefore
  must(
    received >= owed,
    `the maker received ${show(OUT, received)}; the fill owed them ${show(OUT, owed)} out of a signed ${show(OUT, gross)}`,
  )
  must(
    (await balanceOf(IN, executor.address)) - executorInBefore === FILL_AMOUNT,
    `the executor took ${show(IN, FILL_AMOUNT)} out of the escrow`,
  )
  must(
    escrowBefore - (await balanceOf(IN, SETTLEMENT)) === FILL_AMOUNT,
    "the contract's own balance fell by exactly the fill",
  )
  must((await reservation(filledHash)).amount === 0n, 'the reservation is spent')
  must(
    (await balanceOf(IN, maker.address)) === makerInBefore - FILL_AMOUNT,
    'the fill touched no allowance — the maker paid nothing more',
  )

  // ── A second intent, deposited and then unlocked ────────────────────────────
  head('a second intent, deposited and then asked back')
  const parked: Intent = { ...filled, amountIn: PARK_AMOUNT, nonce: BigInt(Date.now()) + 1n }
  const parkedSig = await sign(parked)
  const parkedHash = intentHashOf(parked, CHAIN)

  await write(
    makerWallet,
    {
      address: SETTLEMENT,
      abi: SETTLEMENT_ABI,
      functionName: 'deposit',
      args: [toStruct(parked), PARK_AMOUNT],
    },
    `deposited ${show(IN, PARK_AMOUNT)} into the second intent`,
  )
  must((await reservation(parkedHash)).amount === PARK_AMOUNT, 'the second reservation is in place')

  // ── Out again, in one transaction ─────────────────────────────────────────
  head('the maker takes the escrow back')

  // The offer is fillable right up to the moment it is not, and nothing warns an executor.
  // That is the trade: they are protected by atomicity, not by notice.
  const reason = (await pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'fillability',
    // Unbounded on the fee: the question here is about the escrow, not about the price.
    args: [toStruct(parked), parkedSig, PARK_AMOUNT, executor.address, (1n << 256n) - 1n],
  })) as number
  must(reason === 0, 'the parked intent is fillable while the funds sit there')

  const before = await balanceOf(IN, maker.address)
  await write(
    makerWallet,
    {
      address: SETTLEMENT,
      abi: SETTLEMENT_ABI,
      functionName: 'withdraw',
      args: [toStruct(parked)],
    },
    'withdrew the reservation',
  )
  const back = (await balanceOf(IN, maker.address)) - before
  must(back === PARK_AMOUNT, `the maker got ${show(IN, back)} back, all of it, with no waiting`)
  must((await reservation(parkedHash)).amount === 0n, 'the reservation is empty')

  // Emptying the reservation is the cancel: there is nothing left to fill from.
  const after = (await pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'fillability',
    // Unbounded on the fee: the question here is about the escrow, not about the price.
    args: [toStruct(parked), parkedSig, PARK_AMOUNT, executor.address, (1n << 256n) - 1n],
  })) as number
  must(after !== 0, `withdrawing ended the offer too · reason ${after}`)
}

head('closing balances')
log(`maker    ${show(IN, await balanceOf(IN, maker.address))} · ${show(OUT, await balanceOf(OUT, maker.address))}`)
log(`executor ${show(IN, await balanceOf(IN, executor.address))} · ${show(OUT, await balanceOf(OUT, executor.address))}`)
log(`maker PLS ${formatUnits(await pub.getBalance({ address: maker.address }), 18)}`)

finish('escrow lifecycle')
