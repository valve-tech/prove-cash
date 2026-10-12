import { Component, type ErrorInfo, type ReactNode } from 'react'
import { errorLine } from './lib/errors.ts'
import { t } from './lib/i18n.ts'

/**
 * The last thing between a thrown error and a white screen.
 *
 * React unmounts the whole tree when a render, an effect or a lifecycle throws and nothing
 * catches it. The page then has no markup at all — no sentence, no button, nothing that says the
 * app is even still there. That is what production showed: a wallet extension installed
 * `window.ethereum` as a Proxy that threw on a property read, the read happened inside a mount
 * effect, and the tab went blank.
 *
 * `lib/wallet.ts` no longer reads an injected object unguarded, so this is not the fix for that
 * defect. It is the floor under the next one. It wraps both halves of the app in `Root.tsx`, the
 * landing page and the dapp, which is why it imports neither.
 *
 * **It shows the first line and nothing more.** A caught error carries a whole report — viem puts
 * the URL and the request body in the message — and an endpoint with a key in its path is a
 * credential. `errorLine` is that redaction. The console still has all of it.
 */
type Props = { children: ReactNode }
type State = { message: string | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { message: null }

  static getDerivedStateFromError(error: unknown): State {
    return { message: errorLine((error as Error)?.message ?? String(error)) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('prove.cash: render error', error, info.componentStack)
  }

  render() {
    if (this.state.message === null) return this.props.children
    return <CrashNotice detail={this.state.message} />
  }
}

/**
 * What a person reads instead of a blank tab.
 *
 * One sentence they can act on, then the first line of what broke — kept because it is the only
 * thing they can quote to us, and set in the mono face because it is not language.
 */
export function CrashNotice({ detail }: { detail: string }) {
  return (
    <div role="alert" className="min-h-full">
      <div className="max-w-[52ch] p-2 ring-1 ring-(--color-line) sm:p-4">
        <p className="text-[13px] leading-relaxed text-(--color-body)">{t('crash.lead')}</p>
        {detail !== '' && (
          <p className="num mt-2 text-[11px] leading-relaxed break-words text-(--color-dim)">
            {detail}
          </p>
        )}
      </div>
    </div>
  )
}
