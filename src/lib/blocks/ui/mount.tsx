// SOURCING: react-dom/client's createRoot. A notebook cell has no React tree
// of its own: `mount` gives it one inside Theorem's Theme, on the React copy
// the App build vendors (export.ts), and hands back what unmounts it, which a
// cell passes to `invalidation` so a re-run or a closed notebook leaves
// nothing registered or running.
import { StrictMode } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Theme } from './theme'

/** Renders `node` into `element` in Theorem's theme; returns what unmounts it. */
export function mount(element: Element, node: ReactNode): () => void {
  const root = createRoot(element)
  root.render(
    <StrictMode>
      <Theme>{node}</Theme>
    </StrictMode>,
  )
  return () => root.unmount()
}
