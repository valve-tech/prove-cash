import { lazy, Suspense } from 'react'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import Landing from './landing/Landing.tsx'
import { isApp, usePath } from './surface.ts'

// The dapp is the heavy half — viem, the board client, the proof-of-work worker. The landing
// page must not pay for any of it, so it arrives only when the path asks for it.
const App = lazy(() => import('./App.tsx'))

/** Deliberately quiet: a spinner here would flash on a warm cache and read as a fault. */
export function Booting() {
  return (
    <div className="min-h-full flex items-center justify-center">
      <span className="num text-xs text-(--color-dim)">loading…</span>
    </div>
  )
}

/**
 * Both halves sit inside the error boundary, so a throw anywhere shows a sentence rather than an
 * empty tab. The wallet is reached from the dapp half, which is where the white screen came from.
 */
export default function Root() {
  const app = isApp(usePath())
  return (
    <ErrorBoundary>
      {app ? (
        <Suspense fallback={<Booting />}>
          <App />
        </Suspense>
      ) : (
        <Landing />
      )}
    </ErrorBoundary>
  )
}
