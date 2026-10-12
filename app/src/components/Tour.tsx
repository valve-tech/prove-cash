import { useState } from 'react'
import { t } from '../lib/i18n'
import { useDialog } from './useDialog'

/**
 * How it works, in one dismissible pass. This is the only place the app explains its mechanics —
 * a maker does not choose the proof of work and cannot change it, so it is not in the form.
 * Everything else the UI has to say, it says with its shape.
 */

/**
 * The six steps, as key pairs rather than as prose.
 *
 * The order is the reading order and the dots count it, so the array stays the structure and the
 * dictionary holds the words. A step's key is named after what it teaches, not after its number:
 * inserting a seventh step must not renumber the other six for every translator.
 */
const STEPS = [
  { title: 'tour.work.title', body: 'tour.work.body' },
  { title: 'tour.where.title', body: 'tour.where.body' },
  { title: 'tour.ladder.title', body: 'tour.ladder.body' },
  { title: 'tour.callback.title', body: 'tour.callback.body' },
  { title: 'tour.offboard.title', body: 'tour.offboard.body' },
  { title: 'tour.cancel.title', body: 'tour.cancel.body' },
] as const

const KEY = 'provecash.tour'

export function tourSeen(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return true
  }
}

export function Tour({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0)
  const last = step === STEPS.length - 1

  function dismiss() {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      /* this tab only */
    }
    onClose()
  }

  const box = useDialog<HTMLDivElement>(dismiss)

  // No overlay gutter below `sm`: the dialog is the width of the phone, and it pads itself.
  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-center justify-center sm:p-4"
      onClick={dismiss}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        tabIndex={-1}
        className="panel w-full min-w-72 max-w-sm p-2 sm:p-4 grid gap-3"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5" role="group" aria-label={t('tour.steps')}>
          {STEPS.map((s2, i) => (
            <button
              key={s2.title}
              aria-label={t('tour.step', {
                n: i + 1,
                total: STEPS.length,
                title: t(s2.title),
              })}
              aria-current={i === step ? 'true' : undefined}
              onClick={() => setStep(i)}
              className={`h-1 rounded-full transition-all cursor-pointer hover:bg-(--color-dim) ${
                i === step ? 'w-6 bg-(--color-proven)' : 'w-2 bg-(--color-line)'
              }`}
            />
          ))}
        </div>
        <h2 id="tour-title" className="text-base font-semibold text-(--color-bright)">
          <span className="sr-only">
            {t('tour.title', { n: step + 1, total: STEPS.length })}{' '}
          </span>
          {t(STEPS[step].title)}
        </h2>
        {/* Tall enough for the longest step, so the controls never move as you page. */}
        <p className="min-h-44 text-sm text-(--color-body) leading-relaxed">
          {t(STEPS[step].body)}
        </p>
        <div className="flex items-center justify-between gap-3 mt-1">
          <button className="text-xs text-(--color-dim) hover:text-(--color-body)" onClick={dismiss}>
            {t('tour.skip')}
          </button>
          <div className="flex items-center gap-2">
            <button
              className="btn btn-ghost text-xs py-1.5 disabled:opacity-30"
              disabled={step === 0}
              onClick={() => setStep(step - 1)}>
              {t('tour.back')}
            </button>
            <button
              className="btn btn-primary text-xs py-1.5 min-w-20"
              onClick={() => (last ? dismiss() : setStep(step + 1))}>
              {last ? t('tour.done') : t('tour.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
