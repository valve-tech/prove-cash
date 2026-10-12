import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import Root from './Root.tsx'
import { redirectLegacyPath } from './surface.ts'

// Before the first render, so a shared old link never paints the wrong view on its way out.
redirectLegacyPath()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
