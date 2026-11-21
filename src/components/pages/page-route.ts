// SOURCING: @tanstack/react-router's useRouter, as builtins.tsx used it. The page on screen is named
// by its route, and more than one module needs that id — a saved table arrangement and a context
// envelope both key on it — so it is read in one place.
import { useRouter } from '@tanstack/react-router'

/** The vault entry of the page on screen, from its route. */
export function usePageId(): string | undefined {
  // Absent outside a router, as in a page's own tests.
  const router = useRouter({ warn: false }) as
    ReturnType<typeof useRouter> | undefined
  const match = router?.state.location.pathname.match(/\/pages\/([^/]+)/)
  return match?.[1]
}
