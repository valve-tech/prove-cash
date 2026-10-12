import { describe, expect, it } from 'vitest'
import { parseUnits, type Address } from 'viem'
import { PULSEX_FEE_DEN, PULSEX_FEE_NUM } from '@prove.cash/sdk/solver'
import { asNumber, movePct, poolKey, poolPays, walkBatch, type Pool, type WalkFill } from './pool'

/**
 * The pair the board runs on chain 943, at the reserves it held when the batch defect was
 * measured: 10,000 tPLSX against 400 tUSDC. Every figure below was taken from that pool, so a
 * change to the fee constants or the curve breaks these tests rather than quietly repricing.
 */
const PLSX = '0x0000000000000000000000000000000000000a11' as Address
const USDC = '0x0000000000000000000000000000000000000b22' as Address

const pool: Pool = {
  address: '0x0B196d5F756060e67416Bf45E3e04146a51eE84b' as Address,
  token0: PLSX,
  token1: USDC,
  reserve0: parseUnits('10000', 18),
  reserve1: parseUnits('400', 6),
  feeNum: PULSEX_FEE_NUM,
  feeDen: PULSEX_FEE_DEN,
  venue: 'v1',
  blockNumber: 1n,
}
const pools = new Map([[poolKey(PLSX, USDC), pool]])

/** The three live rows the tray was measured with: size in tPLSX, floor in tUSDC. */
const ROWS = [
  { size: '259.4', floor: '10.0466' },
  { size: '71.51', floor: '2.8231' },
  { size: '299.9', floor: '11.6030' },
]

function fills(rows = ROWS): WalkFill[] {
  return rows.map((r, i) => {
    const amountIn = parseUnits(r.size, 18)
    const required = parseUnits(r.floor, 6)
    // What the board's own quote says this row is worth: priced against the untouched reserves,
    // as if no other row existed. This is the number the tray used to sum.
    const soloNet = (poolPays(pool, PLSX, amountIn) ?? 0n) - required
    return {
      key: `row-${i}`,
      tokenIn: PLSX,
      tokenOut: USDC,
      symbolIn: 'tPLSX',
      symbolOut: 'tUSDC',
      decimalsIn: 18,
      decimalsOut: 6,
      amountIn,
      required,
      fee: 0n,
      soloNet,
    }
  })
}

const usdc = (v: bigint) => asNumber(v, 6)

describe('the pool curve', () => {
  it('pays 10.0851 tUSDC for 259.4 tPLSX at 10,000 / 400', () => {
    const out = poolPays(pool, PLSX, parseUnits('259.4', 18))
    expect(out).not.toBeNull()
    expect(usdc(out!)).toBeCloseTo(10.0851, 4)
  })

  it('reports how far a size moves the pool, fee included', () => {
    // Spot is 0.04 tUSDC per tPLSX; 259.4 tPLSX executes at 10.0851 / 259.4 = 0.038878.
    expect(movePct(pool, PLSX, parseUnits('259.4', 18), 18, 6)).toBeCloseTo(2.804, 3)
  })

  it('has no answer for a token it does not hold', () => {
    const other = '0x0000000000000000000000000000000000000c33' as Address
    expect(poolPays(pool, other, parseUnits('1', 18))).toBeNull()
  })
})

describe('walkBatch — the tray overstatement', () => {
  it('reproduces the defect: three rows priced alone read as profitable', () => {
    const solo = fills().reduce((sum, f) => sum + (f.soloNet ?? 0n), 0n)
    expect(usdc(solo)).toBeCloseTo(0.0582, 4)
    expect(solo).toBeGreaterThan(0n)
  })

  it('prices the same three rows along the curve and finds a loss', () => {
    const walk = walkBatch(fills(), pools)
    const net = walk.net.get('tUSDC')!
    expect(usdc(net.amount)).toBeCloseTo(-0.8035, 4)
    expect(net.amount).toBeLessThan(0n)
    // The correction is 0.86 tUSDC, and it flips the sign of the batch.
    expect(usdc(walk.solo.get('tUSDC')!.amount - net.amount)).toBeCloseTo(0.8617, 4)
  })

  it('walks in fill order: each row is priced at the reserves the row before it left', () => {
    const walk = walkBatch(fills(), pools)
    expect(walk.steps).toHaveLength(3)
    // Only the first row meets the untouched pool, so only it matches its solo quote.
    expect(walk.steps[0].net).toBe(walk.steps[0].fill.soloNet)
    expect(walk.steps[1].net).toBeLessThan(walk.steps[1].fill.soloNet!)
    expect(walk.steps[2].net).toBeLessThan(walk.steps[2].fill.soloNet!)
    // Rates fall monotonically as the batch eats into the pool.
    expect(walk.steps[1].rate!).toBeLessThan(walk.steps[0].rate!)
    expect(walk.steps[2].rate!).toBeLessThan(walk.steps[1].rate!)
    // Cumulative size is the whole selection by the last step.
    expect(asNumber(walk.steps[2].cumulativeIn, 18)).toBeCloseTo(630.81, 2)
    expect(usdc(walk.steps[2].cumulativeNet)).toBeCloseTo(-0.8035, 4)
  })

  it('stays under the same batch unwound as a single trade', () => {
    // One swap of 630.81 tPLSX pays 23.670 tUSDC against 24.4727 owed: −0.8023. Filling one at a
    // time is worse, because each leg pays the POOL's own swap fee on its own trade. The
    // protocol fee is a different thing and it is inside `required`, not beside it.
    const total = fills().reduce((s, f) => s + f.amountIn, 0n)
    const owed = fills().reduce((s, f) => s + f.required, 0n)
    const oneTrade = (poolPays(pool, PLSX, total) ?? 0n) - owed
    expect(usdc(oneTrade)).toBeCloseTo(-0.8023, 4)
    expect(walkBatch(fills(), pools).net.get('tUSDC')!.amount).toBeLessThan(oneTrade)
  })

  /**
   * The fee stopped being an addition, and this test asserts the opposite of what it used to.
   *
   * It comes out of `required` rather than riding on top of it, so a walk that subtracted it
   * again charged the executor twice and read every fee-charging batch as worse than it is. The
   * strong form of the claim is the second assertion: the walk's answer does not depend on the
   * fee field at all.
   */
  it('leaves the walk alone, because the fee is already inside what each row pays', () => {
    const withFee = fills().map((f) => ({ ...f, fee: parseUnits('0.01', 6) }))
    const walk = walkBatch(withFee, pools)
    expect(usdc(walk.net.get('tUSDC')!.amount)).toBeCloseTo(-0.8035, 4)
    expect(walk.net.get('tUSDC')!.amount).toBe(walkBatch(fills(), pools).net.get('tUSDC')!.amount)
  })
})

describe('walkBatch — opposing rows', () => {
  /** One row sells 100 tPLSX for 4 tUSDC; the other buys 99 tPLSX back with 4 tUSDC. */
  const opposed: WalkFill[] = [
    {
      key: 'sell',
      tokenIn: PLSX,
      tokenOut: USDC,
      symbolIn: 'tPLSX',
      symbolOut: 'tUSDC',
      decimalsIn: 18,
      decimalsOut: 6,
      amountIn: parseUnits('100', 18),
      required: parseUnits('4', 6),
      fee: 0n,
      soloNet: (poolPays(pool, PLSX, parseUnits('100', 18)) ?? 0n) - parseUnits('4', 6),
    },
    {
      key: 'buy',
      tokenIn: USDC,
      tokenOut: PLSX,
      symbolIn: 'tUSDC',
      symbolOut: 'tPLSX',
      decimalsIn: 6,
      decimalsOut: 18,
      amountIn: parseUnits('4', 6),
      required: parseUnits('99', 18),
      fee: 0n,
      soloNet: (poolPays(pool, USDC, parseUnits('4', 6)) ?? 0n) - parseUnits('99', 18),
    },
  ]

  it('nets the two directions before the pool sees either', () => {
    const walk = walkBatch(opposed, pools)
    // 99 of the 100 tPLSX pay the buying row directly; only 1 tPLSX reaches the curve.
    expect(asNumber(walk.steps[0].sold, 18)).toBeCloseTo(1, 6)
    expect(walk.steps[1].sold).toBe(0n)
    expect(asNumber(walk.selfNetted.get('tPLSX')!.amount, 18)).toBeCloseTo(99, 6)
  })

  it('is worth more than the same rows priced alone — the tray understates it', () => {
    const walk = walkBatch(opposed, pools)
    // The tPLSX leg comes out flat: the buyer is paid from the seller's tokens, not the pool.
    expect(walk.net.get('tPLSX')!.amount).toBe(0n)
    expect(walk.solo.get('tPLSX')!.amount).toBeLessThan(0n)
    // And the residual tPLSX still converts to a small tUSDC gain.
    expect(usdc(walk.net.get('tUSDC')!.amount)).toBeGreaterThan(0)
    expect(walk.solo.get('tUSDC')!.amount).toBeLessThan(walk.net.get('tUSDC')!.amount)
  })
})

describe('walkBatch — no pool', () => {
  it('leaves rows it cannot walk at their quoted figure and names them', () => {
    const walk = walkBatch(fills(), new Map())
    expect(walk.unpriced).toHaveLength(3)
    expect(walk.steps).toHaveLength(0)
    expect(usdc(walk.net.get('tUSDC')!.amount)).toBeCloseTo(0.0582, 4)
  })

  it('treats an empty pool as no pool', () => {
    const empty = new Map([[poolKey(PLSX, USDC), { ...pool, reserve1: 0n }]])
    expect(walkBatch(fills(), empty).unpriced).toHaveLength(3)
  })
})
