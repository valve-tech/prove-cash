import { Cost, Section } from './bits.tsx'
import { num, t } from '../lib/i18n.ts'
import type { Key } from '../i18n/en.ts'
import { GAS } from './gas.ts'

/**
 * Who pays your gas, and why they bother.
 *
 * Costs answers "what does a fill cost". This answers the question that follows and that the
 * page never addressed: *somebody else is paying that, and strangers do not pay strangers' gas
 * for nothing.* A reader who does not know what the solver gets assumes the worst, and the worst
 * they can imagine is worse than the truth — so leaving it out costs more than saying it.
 *
 * Two rules, inherited from `Control.tsx` and worth repeating because this section is the one
 * most likely to break them:
 *
 *  1. **Every claim is a consequence for the reader.** "Solvers compete" is a fact about the
 *     market; "your offer is more likely to be taken" is what it does to them.
 *  2. **Do not sell the risk as generosity.** A solver takes the risk because the surplus pays
 *     for it. Saying so plainly is the argument. Dressing it as a service is the thing a reader
 *     can smell, and once they smell it they stop believing the numbers too.
 *
 * The three failure prices are generated from `Gas.t.sol` like every other figure on this page,
 * and they exist as rows in that test because of this section. The alternative was to transcribe
 * them from a lab script's comment, which is exactly how the whole cost table came to be three
 * times wrong for three weeks.
 */

/** What a leg costs a solver when it does not fill. Measured, marginal, on a batch of eight. */
type Risk = { id: string; label: Key; gas: number; body: Key }

/*
 * Cheapest first, which is also least alarming first. The dear one is last because it is the
 * only one that is somebody's choice rather than the market's weather, and it is the one the
 * section's last card answers.
 */
const RISKS: Risk[] = [
  {
    id: 'expired',
    label: 'landing.solver.risk.expired.label',
    gas: GAS['one more leg, expired'].total,
    body: 'landing.solver.risk.expired.body',
  },
  {
    id: 'taken',
    label: 'landing.solver.risk.taken.label',
    gas: GAS['one more leg a rival took'].total,
    body: 'landing.solver.risk.taken.body',
  },
  {
    id: 'unarmed',
    label: 'landing.solver.risk.unarmed.label',
    /*
      The dearest thing a maker can arrange, which is not the dearest failure.
      
      A signature that was never going to recover costs 74,353 and a solver pays it NEVER: the
      bytes cannot change between the dry run and the block, so `dryRun` reads the refusal over
      `eth_call` for nothing. Pricing that here would advertise a loss nobody takes.
      
      What a maker CAN arrange, after the solver has looked, is to make the state wrong. Two ways,
      and this is the dearer: revoke the ERC-20 approval Permit2 spends, and the whole arming runs
      — nonce written, recover passed — before the token refuses. 80,174 against 48,569 for
      burning the nonce. The page shows what a griefer can actually cost you.
    */
    gas: GAS['one more leg the maker unfunded'].total,
    body: 'landing.solver.risk.unarmed.body',
  },
]

/** The three answers to "so why is it safe to let them". */
const TERMS: { id: string; title: Key; body: Key }[] = [
  { id: 'floor', title: 'landing.solver.term.floor.title', body: 'landing.solver.term.floor.body' },
  { id: 'open', title: 'landing.solver.term.open.title', body: 'landing.solver.term.open.body' },
  { id: 'thin', title: 'landing.solver.term.thin.title', body: 'landing.solver.term.thin.body' },
]

export function Solvers() {
  return (
    <Section id="solvers" label={t('landing.nav.solvers')}>
      <h2 className="text-[15px] font-medium text-(--color-bright)">{t('landing.solver.title')}</h2>
      <p className="mt-2 max-w-[62ch] text-[14px] leading-relaxed text-(--color-body)">
        {t('landing.solver.body')}
      </p>

      <h3 className="num mt-8 text-[11px] tracking-[0.22em] text-(--color-dim) uppercase">
        {t('landing.solver.risk.heading')}
      </h3>
      <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-(--color-body)">
        {t('landing.solver.risk.body', { fill: num(GAS['one more leg that fills'].total) })}
      </p>
      {/* The 1px grid gap lets the line colour behind show through, so no cell owns a border. */}
      <ul className="bleed mt-4 grid gap-px bg-(--color-line) sm:grid-cols-3">
        {RISKS.map((r) => (
          <li key={r.id} className="flex flex-col gap-2 bg-(--color-panel) p-2 sm:p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-[14px] font-medium text-(--color-bright)">{t(r.label)}</h4>
              {/* `bad`, not `mute`: this is money the solver loses, and the page prices losses
                  in the same face it prices costs. */}
              <Cost parts={[[num(r.gas), 'gas']]} tone="bad" />
            </div>
            <p className="text-[13.5px] leading-relaxed text-(--color-body)">{t(r.body)}</p>
          </li>
        ))}
      </ul>

      <h3 className="num mt-10 text-[11px] tracking-[0.22em] text-(--color-dim) uppercase">
        {t('landing.solver.earn.heading')}
      </h3>
      <p className="mt-2 max-w-[62ch] text-[13.5px] leading-relaxed text-(--color-body)">
        {t('landing.solver.earn.body')}
      </p>

      <h3 className="num mt-10 text-[11px] tracking-[0.22em] text-(--color-dim) uppercase">
        {t('landing.solver.terms.heading')}
      </h3>
      <ul className="bleed mt-4 grid gap-px bg-(--color-line) sm:grid-cols-3">
        {TERMS.map((c) => (
          <li key={c.id} className="bg-(--color-panel) p-2 sm:p-4">
            <h4 className="text-[14px] font-medium text-(--color-bright)">{t(c.title)}</h4>
            <p className="mt-2 text-[13.5px] leading-relaxed text-(--color-body)">{t(c.body)}</p>
          </li>
        ))}
      </ul>
    </Section>
  )
}
