import { useState } from 'react'
import { num, t } from '../lib/i18n.ts'
import type { Key } from '../i18n/en.ts'
import { Section, Tip } from './bits.tsx'
import { GAS } from './gas.ts'

/**
 * The bill, as bars of measured gas. Every number is generated from the contract's gas tests by
 * `scripts/gen-gas.mjs` and checked in CI, so the chart is a report rather than a promise.
 *
 * It has to be. This page advertised 33,381 gas for a warm allowance fill, and then 33,403, and
 * the contract has never charged either — `Gas.t.sol` has reported about 99,000 for that row
 * since the first commit. The numbers came from a spec that claimed to have taken them from the
 * test. Three times too low, in thirty-five languages, for three weeks.
 *
 * Grouped by the action a reader is about to take, not by which side of the trade they are on.
 * "Maker" and "taker" put a free post and a cold first fill in the same bucket, which is the one
 * comparison that misleads: those two numbers differ by a factor of infinity.
 */

/*
  The two hints are the same length on purpose, and the line that holds them reserves two lines
  whichever is showing. The cold hint used to run to three lines against the warm hint's two, so
  switching modes moved every bar under it by 20px and the section jumped.
*/
type Row = {
  label: Key
  /** What the reader pays once the slot is warm. This is the steady state, so it is the default. */
  warm: number
  /** The first touch, when it differs. Absent means the action has no cold form. */
  cold?: number
  note?: Key
  /** Filled into `note` when it carries a figure. */
  noteVars?: Record<string, string>
  tip?: Key
}

type Group = { actor: Key; title: Key; rows: Row[] }

const GROUPS: Group[] = [
  {
    actor: 'landing.costs.actor.you',
    title: 'landing.costs.post.title',
    rows: [
      {
        label: 'landing.costs.post.label',
        warm: 0,
        note: 'landing.costs.post.note',
        tip: 'landing.costs.tip.post',
      },
    ],
  },
  {
    actor: 'landing.costs.actor.you',
    title: 'landing.costs.arm.title',
    rows: [
      {
        label: 'landing.costs.arm.label',
        warm: GAS['deposit, first touch'].total,
        note: 'landing.costs.arm.note',
        tip: 'landing.costs.tip.arm',
      },
    ],
  },
  {
    actor: 'landing.costs.actor.executor',
    title: 'landing.costs.fill.title',
    rows: [
      {
        label: 'landing.costs.fill.allowance',
        warm: GAS['fill, allowance, warm'].total,
        cold: GAS['fill, allowance, first touch'].total,
      },
      {
        label: 'landing.costs.fill.escrow',
        warm: GAS['fill, escrow, warm'].total,
        cold: GAS['fill, escrow, cold slots'].total,
      },
      {
        label: 'landing.costs.fill.callback',
        warm: GAS['fillWithCallback'].total,
        tip: 'landing.costs.tip.callback',
      },
    ],
  },
  {
    actor: 'landing.costs.actor.executor',
    title: 'landing.costs.batch.title',
    rows: [
      {
        label: 'landing.costs.batch.onePair',
        warm: GAS['fillBatch x20, one token'].each,
      },
      {
        label: 'landing.costs.batch.mixed',
        warm: GAS['fillBatch x20, alternating'].each,
      },
      {
        label: 'landing.costs.batch.next',
        warm: GAS['fillBatch marginal intent'].each,
        note: 'landing.costs.batch.marginal',
        tip: 'landing.costs.tip.next',
      },
      {
        label: 'landing.costs.batch.callbacks',
        warm: GAS['fillBatchWithCallback x20'].each,
        note: 'landing.costs.note.credit',
        noteVars: { gas: num(GAS['the credit premium, per leg'].each) },
        tip: 'landing.costs.tip.callbacks',
      },
    ],
  },
]

const MODES = [
  { id: 'warm', label: 'landing.costs.mode.warm', hint: 'landing.costs.mode.warm.hint' },
  { id: 'cold', label: 'landing.costs.mode.cold', hint: 'landing.costs.mode.cold.hint' },
] as const satisfies readonly { id: string; label: Key; hint: Key }[]

type Mode = (typeof MODES)[number]['id']

/** What a row costs in this mode. A row with no cold form prices the same either way. */
const priceOf = (r: Row, mode: Mode) => (mode === 'cold' ? (r.cold ?? r.warm) : r.warm)

function Bar({ gas, max }: { gas: number; max: number }) {
  return (
    <div aria-hidden="true" className="h-1.5 bg-(--color-line)/45">
      {gas > 0 && (
        <div className="h-full bg-(--color-proven)" style={{ width: `${(gas / max) * 100}%` }} />
      )}
    </div>
  )
}

function Amount({ gas, className = '' }: { gas: number; className?: string }) {
  return (
    <span
      className={`num text-sm ${gas === 0 ? 'text-(--color-proven)' : 'text-(--color-bright)'} ${className}`}>
      {num(gas)}
    </span>
  )
}

export function Costs() {
  const [mode, setMode] = useState<Mode>('warm')

  // Rescale to what is on screen. Held against the cold peak, every warm bar reads as a stub and
  // the differences that matter between them disappear.
  const max = Math.max(
    ...GROUPS.flatMap((g) => g.rows.map((r) => priceOf(r, mode))),
    1,
  )

  return (
    <Section id="costs" label={t('landing.nav.costs')}>
      <h2 className="max-w-[24ch] text-[clamp(1.6rem,4.5vw,2.4rem)] leading-[1.05] font-semibold tracking-[-0.03em] text-(--color-bright)">
        {t('landing.costs.title')}
      </h2>
      <p className="mt-5 max-w-[62ch] text-[15px] leading-relaxed text-(--color-body)">
        {t('landing.costs.body')}
      </p>

      <div className="mt-8 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div
          role="radiogroup"
          aria-label={t('landing.costs.toggle')}
          className="inline-flex gap-px bg-(--color-line)">
          {MODES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={mode === m.id}
              onClick={() => setMode(m.id)}
              className={`num lp-focus px-3 py-1.5 text-[11px] tracking-[0.18em] uppercase ${
                mode === m.id
                  ? 'bg-(--color-proven) text-(--color-ink)'
                  : 'bg-(--color-panel) text-(--color-dim) hover:text-(--color-bright)'
              }`}>
              {t(m.label)}
            </button>
          ))}
        </div>
        <p className="max-w-[44ch] min-h-[3.25em] text-[12.5px] leading-relaxed text-(--color-dim)">
          {/*
            Through `t`, like the label above it. This rendered the KEY — every visitor in every
            language read `landing.costs.mode.warm.hint` where the sentence should be — and the
            comment at the top of this file is about the line lengths of hints nobody ever saw.
            Nothing caught it: the app's views and chrome have a leaked-key guard and this page
            had none, which is the second half of this fix.
          */}
          {t(MODES.find((m) => m.id === mode)?.hint ?? 'landing.costs.mode.warm.hint')}
        </p>
      </div>

      {GROUPS.map((g) => (
        <div key={g.title} className="mt-9">
          <div className="flex items-baseline gap-3">
            <h3 className="text-[15px] font-medium text-(--color-bright)">{t(g.title)}</h3>
            <span className="num text-[10px] tracking-[0.22em] text-(--color-proven) uppercase">
              {t(g.actor)}
            </span>
          </div>
          <ul className="mt-3 grid gap-3">
            {g.rows.map((r) => {
              const gas = priceOf(r, mode)
              return (
                <li
                  key={r.label}
                  className="grid items-center gap-x-4 gap-y-1.5 md:grid-cols-[16rem_minmax(0,1fr)_5rem]">
                  <div className="flex min-w-0 items-baseline justify-between gap-3 md:block">
                    <span className="text-[13px] text-(--color-body)">
                      {t(r.label)}
                      {r.note && (
                        <span className="num ps-2 text-[10px] tracking-wider text-(--color-dim) uppercase">
                          {r.tip ? (
                            <Tip label={t(r.note, r.noteVars)} tip={t(r.tip)} />
                          ) : (
                            t(r.note, r.noteVars)
                          )}
                        </span>
                      )}
                      {!r.note && r.tip && (
                        <span className="num ps-2 text-[10px] tracking-wider text-(--color-dim) uppercase">
                          <Tip label={t('landing.costs.why')} tip={t(r.tip)} />
                        </span>
                      )}
                    </span>
                    <Amount gas={gas} className="md:hidden" />
                  </div>
                  <Bar gas={gas} max={max} />
                  <Amount gas={gas} className="hidden text-end md:block" />
                </li>
              )
            })}
          </ul>
        </div>
      ))}

      <p className="mt-9 max-w-[62ch] text-[13px] leading-relaxed text-(--color-dim)">
        {t('landing.costs.note')}
      </p>
    </Section>
  )
}
