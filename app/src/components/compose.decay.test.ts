import { describe, expect, test } from 'vitest'
import { parseUnits } from 'viem'
import { CURVE_LINEAR, KIND_LINEAR, KIND_STRETCH, stretchCurve } from '@prove.cash/sdk'
import { DECAY_ON_BY_DEFAULT, offerCurve } from './Compose'
import { FULL_FALL, STEPS, type Fall } from '../lib/curve'

/**
 * What the form signs, and which way round the maker's number goes.
 *
 * Every offer this app made before today was flat. The decay defaulted to off, so the price stood
 * still for the whole window and the first valid transaction took it — a race on latency, which
 * the maker cannot win and collects nothing from. The decay is the only term that makes fillers
 * compete in the maker's favour, so it is on by default now.
 *
 * The flip that goes with it is the one worth guarding: the number in the field is the floor. It
 * used to be the start, and a decay from it went *below* what the maker had typed under a label
 * promising them at least that much.
 */

const usdc = (v: string) => parseUnits(v, 6)
const floor = usdc('400')
const quote = usdc('412')

/**
 * The constant and the form have to stay tied together. A default is only a default where it is
 * read, and this one was a literal `false` sitting in a `useState` for the life of the app.
 */
const SOURCE = Object.values(
  import.meta.glob('./Compose.tsx', { query: '?raw', import: 'default', eager: true }),
)[0] as string

describe('the form as it opens', () => {
  test('the decay is on', () => {
    expect(DECAY_ON_BY_DEFAULT).toBe(true)
    expect(SOURCE).toContain('useState(DECAY_ON_BY_DEFAULT)')
  })

  test('and the offer it signs decays rather than standing still', () => {
    const curve = offerCurve({ dutch: DECAY_ON_BY_DEFAULT, floor, quote, fall: FULL_FALL })
    expect(curve.minOutStart).toBeGreaterThan(curve.minOutEnd)
  })
})

describe('the typed number', () => {
  test('is the end of the curve, so nothing fills below it', () => {
    expect(offerCurve({ dutch: true, floor, quote, fall: FULL_FALL }).minOutEnd).toBe(floor)
    expect(offerCurve({ dutch: false, floor, quote, fall: FULL_FALL }).minOutEnd).toBe(floor)
  })

  test('is beaten by an early fill, which is what the decay is for', () => {
    expect(offerCurve({ dutch: true, floor, quote, fall: FULL_FALL }).minOutStart).toBeGreaterThan(floor)
  })
})

describe('the offer stays flat when it should', () => {
  test('with the decay turned off', () => {
    expect(offerCurve({ dutch: false, floor, quote, fall: FULL_FALL })).toEqual({
      minOutStart: floor,
      minOutEnd: floor,
      curve: CURVE_LINEAR,
      kind: KIND_LINEAR,
    })
  })

  /** No pool, no market, or a read still in flight: all three reach the form as a null quote. */
  test('with no market to open above', () => {
    expect(offerCurve({ dutch: true, floor, quote: null, fall: FULL_FALL })).toEqual({
      minOutStart: floor,
      minOutEnd: floor,
      curve: CURVE_LINEAR,
      kind: KIND_LINEAR,
    })
  })

  test('with a market below the floor, which the contract would refuse to start under', () => {
    const curve = offerCurve({ dutch: true, floor, quote: usdc('300'), fall: FULL_FALL })
    expect(curve.minOutStart).toBe(floor)
    expect(curve.minOutStart).toBeGreaterThanOrEqual(curve.minOutEnd)
  })

  test('while the amount field is empty and there is no floor yet', () => {
    expect(offerCurve({ dutch: true, floor: 0n, quote, fall: FULL_FALL })).toEqual({
      minOutStart: 0n,
      minOutEnd: 0n,
      curve: CURVE_LINEAR,
      kind: KIND_LINEAR,
    })
  })
})

/**
 * The shape is a separate decision from the height, and the form has to keep them separate.
 *
 * A maker who drags a handle changes when a filler's cost is crossed. They must never change what
 * they are owed at the close, and they must never change what the offer opens at.
 */
describe('the shape the maker draws', () => {
  const quarter: Fall = { from: 0, to: STEPS / 4 }

  test('the default is the straight line, and it costs no extra word and no extra gas', () => {
    const offer = offerCurve({ dutch: true, floor, quote, fall: FULL_FALL })
    expect(offer.curve).toBe(CURVE_LINEAR)
    expect(offer.kind).toBe(KIND_LINEAR)
  })

  test('a stretch signs the stretch kind and the word that draws it', () => {
    const offer = offerCurve({ dutch: true, floor, quote, fall: quarter })
    expect(offer.kind).toBe(KIND_STRETCH)
    expect(offer.curve).toBe(stretchCurve(0, 0.25))
  })

  test('and it moves neither end of the curve', () => {
    const line = offerCurve({ dutch: true, floor, quote, fall: FULL_FALL })
    const bent = offerCurve({ dutch: true, floor, quote, fall: quarter })
    expect(bent.minOutStart).toBe(line.minOutStart)
    expect(bent.minOutEnd).toBe(line.minOutEnd)
  })

  /**
   * A flat offer has one price for its whole window, so every kind of curve returns it at every
   * instant. Signing a stretch there would buy the maker nothing and charge them 480 gas a fill
   * plus 0.27% more proof of work for the post.
   */
  test('a flat offer signs no shape, whatever the handles say', () => {
    const offer = offerCurve({ dutch: false, floor, quote, fall: quarter })
    expect(offer.curve).toBe(CURVE_LINEAR)
    expect(offer.kind).toBe(KIND_LINEAR)
  })
})
