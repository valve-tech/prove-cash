import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { TokenInfo } from '@prove.cash/sdk'
import type { Pool } from '../../lib/pool'
import { SignPreview, signCurve } from './SignPreview'

/**
 * The frame the sign preview draws in.
 *
 * The panel puts a draft offer on the pool's own curve, so the pay curve, the spot line, the queue
 * ticks and the draft marker have to stay legible at every size a person can type. One series can
 * run away: `poolAmountIn` divides by `reserveOut − amountOut`, so a charge sample near the pool's
 * own reserve costs an unbounded amount. One of those used to set the whole y axis and squash
 * everything else into the bottom one per cent of the plot.
 */

const TPLSX = '0x000000000000000000000000000000000000000a' as Address
const TUSDC = '0x000000000000000000000000000000000000000b' as Address

/** Chain 943's 10,000 tPLSX / 400 tUSDC pool — the one the defect was measured on. Spot 0.04. */
const pool: Pool = {
  address: '0x0B196d5F756060e67416Bf45E3e04146a51eE84b' as Address,
  token0: TPLSX,
  token1: TUSDC,
  reserve0: 10_000n * 10n ** 18n,
  reserve1: 400n * 10n ** 6n,
  feeNum: 9971n,
  feeDen: 10_000n,
  venue: 'PulseX v2',
  blockNumber: 25_156_707n,
}

const SPOT = 0.04
const DEPTH = 10_000

type Input = Parameters<typeof signCurve>[0]

const frame = (sizeNum: number, over: Partial<Input> = {}) =>
  signCurve({
    pool,
    tokenIn: TPLSX,
    decimalsIn: 18,
    decimalsOut: 6,
    sizeNum,
    samples: 96,
    floors: [],
    floorRate: null,
    withCharge: true,
    ...over,
  })

const numbers = (values: readonly (number | null)[]) =>
  values.filter((v): v is number => v !== null)

describe('the y domain', () => {
  it('does not let a near-asymptote charge sample set the top of the frame', () => {
    // At 40% of the reserve typed, the window reaches the reserve itself, and the sample before
    // it charges 96 times spot. That one number used to be the top of the axis.
    const f = frame(DEPTH * 0.4)
    expect(Math.max(...numbers(f.points.map((p) => p.charge)))).toBeGreaterThan(SPOT * 20)
    expect(f.yHi).toBeLessThan(SPOT * 3)
  })

  it('keeps the pay curve inside the plot, and big enough to read, at 40% and 120% of the reserve', () => {
    // Inside the frame was never the problem — the old axis contained the pay curve too. The
    // reading is what broke: every point of it landed within a pixel or two of the bottom edge.
    for (const sizeNum of [DEPTH * 0.4, DEPTH * 1.2]) {
      const f = frame(sizeNum)
      const pays = numbers(f.points.map((p) => p.pay))
      expect(pays.length).toBeGreaterThan(0)
      for (const rate of pays) {
        expect(rate).toBeGreaterThanOrEqual(f.yLo)
        expect(rate).toBeLessThanOrEqual(f.yHi)
      }
      const share = (Math.max(...pays) - Math.min(...pays)) / (f.yHi - f.yLo)
      expect(share).toBeGreaterThan(0.2)
    }
  })

  it('keeps the spot line and the draft floor in view at a size that clips the charge curve', () => {
    // The marker and the spot line are the answer the panel exists to give. They set the domain
    // outright, so no ceiling can push either of them off the plot.
    const f = frame(DEPTH * 0.4, { floorRate: SPOT * 0.9 })
    expect(f.spot).toBeCloseTo(SPOT)
    expect(f.spot!).toBeGreaterThan(f.yLo)
    expect(f.spot!).toBeLessThan(f.yHi)
    expect(f.yLo).toBeLessThan(SPOT * 0.9)
  })

  it('leaves a floor nowhere near the pool off the axis', () => {
    const f = frame(0, {
      floors: [
        { key: 'near', rate: SPOT * 1.2 },
        { key: 'far', rate: SPOT * 40 },
      ],
    })
    expect(f.nearby.map((n) => n.key)).toEqual(['near'])
    expect(f.yHi).toBeLessThan(SPOT * 2)
  })
})

describe('what the plot has to say about the charge curve', () => {
  it('reports the curve as clipped only when it really leaves the frame', () => {
    // The flag is what moves the curve's label to where the line was last visible. Reporting it
    // when nothing was clipped would put the label in the middle of a curve that is all there.
    expect(frame(DEPTH * 0.4).clipped).toBe(true)
    expect(frame(0).clipped).toBe(false)
  })

  it('frames both curves whole while the amount field is empty', () => {
    // The empty state was never broken and must stay unbroken: at 5% of the reserve the fee band
    // is a few per cent wide and both edges of it fit.
    const f = frame(0)
    expect(f.xMax).toBeCloseTo(DEPTH * 0.05)
    expect(Math.max(...numbers(f.points.map((p) => p.charge)))).toBeLessThanOrEqual(f.yHi)
    expect(Math.min(...numbers(f.points.map((p) => p.pay)))).toBeGreaterThanOrEqual(f.yLo)
  })

  it('frames no charge curve for the compact plot, which does not draw one', () => {
    const f = frame(DEPTH * 0.4, { withCharge: false })
    expect(f.points.every((p) => p.charge === null)).toBe(true)
    expect(f.clipped).toBe(false)
    expect(f.yHi).toBeLessThan(SPOT * 1.2)
  })
})

describe('sizes the pool cannot serve', () => {
  it('draws a window past the whole reserve, where the charge curve stops existing', () => {
    // Past the reserve the pool cannot release the amount at any price, so `poolAmountIn` returns
    // null. Two thirds of this window is past it.
    const f = frame(DEPTH * 1.2)
    expect(f.points.some((p) => p.charge === null)).toBe(true)
    expect(f.points.some((p) => p.charge !== null)).toBe(true)
    expect(isFinite(f.yLo)).toBe(true)
    expect(isFinite(f.yHi)).toBe(true)
    expect(f.yHi).toBeGreaterThan(f.yLo)
  })

  it('returns a drawable frame for a pool that holds nothing', () => {
    // The panel guards this state before it plots, but a zero-height axis divides by zero and
    // puts every point on one pixel, so the frame has to be safe on its own.
    const f = frame(0, { pool: { ...pool, reserve0: 0n, reserve1: 0n } })
    expect(f.spot).toBeNull()
    expect(f.points.every((p) => p.pay === null)).toBe(true)
    expect(f.yHi).toBeGreaterThan(f.yLo)
  })
})

describe('the panel', () => {
  const tokenIn: TokenInfo = { address: TPLSX, symbol: 'tPLSX', decimals: 18 }
  const tokenOut: TokenInfo = { address: TUSDC, symbol: 'tUSDC', decimals: 6 }

  const draw = (amountIn: string, minOut: string, into: TokenInfo | null = tokenIn) =>
    renderToStaticMarkup(
      <SignPreview
        tokenIn={into}
        tokenOut={tokenOut}
        amountIn={amountIn}
        minOut={minOut}
        minOutEnd=""
        dutch={false}
        duration={3600}
      />,
    )

  it('renders with an empty amount, which is how the page first opens', () => {
    // No width and no reserves in a static render, so the sentence is the assertion. The point is
    // that the empty field is a state the panel draws, not a state it throws in.
    expect(draw('', '')).toContain('Reading')
  })

  it('asks for a pair rather than drawing a frame it has no market for', () => {
    expect(draw('', '', null)).toContain('Pick two different tokens')
  })
})

describe('a floor typed far from spot', () => {
  it("the draft's own floor sets the domain however far out it is", () => {
    // A maker types what they want, not what the pool offers. A floor above spot has to be ON the
    // axis — a plot that framed only the pool would show the offer as absent rather than as
    // ambitious, which is the one thing the reader is looking for.
    const high = frame(100, { floorRate: SPOT * 4 })
    expect(high.yHi).toBeGreaterThanOrEqual(SPOT * 4)

    const low = frame(100, { floorRate: SPOT / 8 })
    expect(low.yLo).toBeLessThanOrEqual(SPOT / 8)
  })

  it('somebody else\'s far-off floor does not stretch the axis', () => {
    // `nearby` is half to 1.6 times spot. A resting offer outside that band belongs to a
    // different market in all but name, and letting it set the domain flattens this one.
    const far = frame(100, {
      floors: [
        { rate: SPOT * 10, amountIn: 1n, maker: TPLSX },
        { rate: SPOT / 100, amountIn: 1n, maker: TPLSX },
      ] as never,
    })
    expect(far.nearby).toHaveLength(0)
    const bare = frame(100)
    expect(far.yHi).toBeCloseTo(bare.yHi, 12)
    expect(far.yLo).toBeCloseTo(bare.yLo, 12)
  })

  it('a floor inside the band is kept, and does stretch it', () => {
    const near = frame(100, { floors: [{ rate: SPOT * 1.5, amountIn: 1n, maker: TPLSX }] as never })
    expect(near.nearby).toHaveLength(1)
    expect(near.yHi).toBeGreaterThanOrEqual(SPOT * 1.5)
  })
})

describe('the x window', () => {
  it('it opens at two and a half times the typed size, so the marker sits at 40%', () => {
    // The same fraction of the plot whatever is typed, which is what makes one size comparable to
    // the next. It holds above the depth floor below — under that the floor wins, on purpose.
    // Sizes here sit above 2% of the reserve so the 2.5× rule, not the floor, sets the window.
    for (const size of [500, 2_000, 4_000]) {
      const f = frame(size)
      expect(f.xMax / size, `size ${size}`).toBeCloseTo(2.5, 6)
    }
  })

  it('below a fraction of the pool the window stops shrinking with the size', () => {
    // Two and a half times a dust amount is dust, and a plot that wide shows a straight line. The
    // floor is 5% of the pool — the same opening the empty field uses — so a small draft still
    // gets a curve with a bend in it, and typing the first digit does not zoom the chart.
    const dust = frame(1)
    expect(dust.xMax).toBeCloseTo(DEPTH * 0.05, 6)
    expect(dust.xMax / 1).toBeGreaterThan(2.5)
  })

  it('an empty amount still draws a window', () => {
    // The panel is on screen before anything is typed. A zero-width window divides by nothing.
    const f = frame(0)
    expect(f.xMax).toBeGreaterThan(0)
    expect(f.points.length).toBeGreaterThan(0)
  })

  it('a size the pool cannot serve is clamped to three times its depth', () => {
    // Past this the curve is asymptotic and the plot says nothing. Clamping keeps the axis
    // readable and lets the marker sit at the far edge, which is itself the message.
    const f = frame(DEPTH * 100)
    expect(f.xMax).toBeCloseTo(DEPTH * 3, 6)
  })

  it('a tiny size still opens a window wide enough to have a shape', () => {
    // Two and a half times a dust amount is dust. The floor is a fraction of the pool's depth, so
    // the curve has somewhere to bend.
    const f = frame(1e-9)
    expect(f.xMax).toBeGreaterThanOrEqual(DEPTH * 0.05)
  })
})

describe('the depth valley', () => {
  it('the window never drops when the first digit is typed', () => {
    // The empty field opens at 5% of the reserve. The typed floor used to be 0.2%, so the first
    // keystroke zoomed the chart twenty-five times and the marker leapt across the plot. The two
    // floors are one number now, so the window is monotonic in the typed size from empty onward.
    const empty = frame(0).xMax
    expect(empty).toBeCloseTo(DEPTH * 0.05, 6)
    for (const size of [1e-12, 1e-9, 1, 10, 50, 100, DEPTH * 0.02]) {
      expect(frame(size).xMax, `size ${size}`).toBeGreaterThanOrEqual(empty - 1e-12)
    }
  })

  it('as the size grows, the window only rises or holds until the depth ceiling', () => {
    // A valley in xMax(size) is the defect by name: each step must be ≥ the last, until the
    // three-depth clamp. Sample across the floor, the 2.5× ramp, and past the ceiling.
    const sizes = [
      0,
      1,
      DEPTH * 0.01,
      DEPTH * 0.02,
      DEPTH * 0.04,
      DEPTH * 0.2,
      DEPTH * 0.8,
      DEPTH * 1.2,
      DEPTH * 4,
      DEPTH * 100,
    ]
    let prev = 0
    for (const size of sizes) {
      const x = frame(size).xMax
      expect(x, `size ${size}`).toBeGreaterThanOrEqual(prev)
      prev = x
    }
    expect(prev).toBeCloseTo(DEPTH * 3, 6)
  })
})

describe('the compact plot', () => {
  it('it frames no charge curve, because it draws none', () => {
    // A domain padded for a series that is not on the plot is empty space at the top of a chart
    // that has none to spare at 375px.
    const wide = frame(100, { withCharge: true })
    const narrow = frame(100, { withCharge: false })
    expect(narrow.points.every((p) => p.charge === null)).toBe(true)
    expect(narrow.yHi).toBeLessThanOrEqual(wide.yHi)
    expect(narrow.clipped).toBe(false)
  })

  it('the pay curve is identical either way', () => {
    // Only the framing changes. If the compact plot drew a different curve it would be a
    // different claim about the same pool.
    const wide = frame(100, { withCharge: true })
    const narrow = frame(100, { withCharge: false })
    expect(narrow.points.map((p) => p.pay)).toEqual(wide.points.map((p) => p.pay))
  })
})

describe('the depth ribbon', () => {
  it('keeps both edges of the band wherever the charge curve is still on the plot', () => {
    // The fill between pays and charges is the round-trip cost at each size — thin is deep.
    // Every unclipped sample must have both edges, and charge sits above pay, or the polygon
    // would fold.
    const f = frame(100)
    const both = f.points.filter((p) => p.pay !== null && p.charge !== null && p.charge <= f.yHi)
    expect(both.length).toBeGreaterThan(2)
    for (const p of both) {
      expect(p.charge!).toBeGreaterThanOrEqual(p.pay!)
    }
  })

  it('still has a band to fill while the amount field is empty', () => {
    const f = frame(0)
    expect(f.clipped).toBe(false)
    expect(f.points.every((p) => p.pay !== null && p.charge !== null)).toBe(true)
  })
})

describe('synthetic stress', () => {
  /** A pool shaped only for the frame — never a claim about a live market. */
  const synth = (reserveIn: bigint, reserveOut: bigint): Pool => ({
    ...pool,
    reserve0: reserveIn,
    reserve1: reserveOut,
    token0: TPLSX,
    token1: TUSDC,
  })

  const stressFrame = (
    reserveIn: bigint,
    reserveOut: bigint,
    decimalsIn: number,
    decimalsOut: number,
    sizeNum: number,
    over: Partial<Input> = {},
  ) =>
    signCurve({
      pool: synth(reserveIn, reserveOut),
      tokenIn: TPLSX,
      decimalsIn,
      decimalsOut,
      sizeNum,
      samples: 96,
      floors: [],
      floorRate: null,
      withCharge: true,
      ...over,
    })

  it.each([
    // Balanced mid-size, the shape the asymptote defect was measured on.
    ['balanced 1e4/400', 10_000n * 10n ** 18n, 400n * 10n ** 6n, 18, 6],
    // A one-wei reserve still has to return a drawable frame.
    ['dust in', 1n, 10n ** 6n, 18, 6],
    // A pool that holds almost nothing of the output side.
    ['dust out', 10_000n * 10n ** 18n, 1n, 18, 6],
    // Eighteen-decimal both sides, enormous reserves — Number must not overflow the axis.
    ['huge 18/18', 10n ** 30n, 10n ** 30n, 18, 18],
    // Six-decimal stable pair, thin.
    ['thin stables', 50n * 10n ** 6n, 50n * 10n ** 6n, 6, 6],
    // Skewed 1:1_000_000 — the charge asymptote arrives early.
    ['skewed', 10n ** 24n, 10n ** 6n, 18, 6],
  ] as const)('%s keeps a finite rising frame at empty, mid and past-depth sizes', (_name, rin, rout, din, dout) => {
    const depth = Number(rin) / 10 ** din
    for (const sizeNum of [0, depth * 0.01, depth * 0.4, depth * 1.2, depth * 100]) {
      if (!isFinite(sizeNum)) continue
      const f = stressFrame(rin, rout, din, dout, sizeNum)
      expect(isFinite(f.xMax), `xMax size=${sizeNum}`).toBe(true)
      expect(f.xMax).toBeGreaterThan(0)
      expect(isFinite(f.yLo), `yLo size=${sizeNum}`).toBe(true)
      expect(isFinite(f.yHi), `yHi size=${sizeNum}`).toBe(true)
      expect(f.yHi).toBeGreaterThan(f.yLo)
      const pays = numbers(f.points.map((p) => p.pay))
      for (const rate of pays) {
        expect(rate).toBeGreaterThanOrEqual(f.yLo)
        expect(rate).toBeLessThanOrEqual(f.yHi)
      }
      // Spot, when the pool holds both sides, stays inside the frame it helped set.
      if (f.spot !== null) {
        expect(f.spot).toBeGreaterThan(f.yLo)
        expect(f.spot).toBeLessThan(f.yHi)
      }
    }
  })

  it('selling the scarce side still frames without an asymptote takeover', () => {
    // tokenIn is tUSDC against a 10,000 / 400 pool: depth is only 400, and a typed size of 160
    // reaches 40% of it. The charge curve still may not set the top of the axis.
    const f = signCurve({
      pool,
      tokenIn: TUSDC,
      decimalsIn: 6,
      decimalsOut: 18,
      sizeNum: 160,
      samples: 96,
      floors: [],
      floorRate: null,
      withCharge: true,
    })
    expect(f.xMax).toBeCloseTo(400, 6) // 160 * 2.5
    expect(f.yHi).toBeLessThan((f.spot ?? 0) * 3 || 1)
    expect(f.clipped).toBe(true)
  })

  it('a draft floor far above spot on a skewed pool still lands on the axis', () => {
    // Spot is 1e-6 tUSDC per tPLSX on this pool. A floor four orders above it is ambitious and
    // must still set the domain — the same rule the balanced-pool floor tests pin, under skew.
    const f = stressFrame(10n ** 24n, 10n ** 6n, 18, 6, 100, { floorRate: 1e-2 })
    expect(f.spot!).toBeCloseTo(1e-6, 12)
    expect(f.yHi).toBeGreaterThanOrEqual(1e-2)
  })
})
