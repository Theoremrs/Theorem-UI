// SOURCING: @tanstack/react-router's useRouter, as builtins.tsx used it, and a React context the
// page editor fills. The page on screen is named by its route (its vault entry, which a rename
// keeps: a saved table arrangement keys on it) and by its file's vault path (what Theorem's page
// owner and the agent's page_read name: the context envelope carries it), so both are read here.
import { createContext, useContext } from 'react'
import { useRouter } from '@tanstack/react-router'

/** The vault entry of the page on screen, from its route. */
export function usePageId(): string | undefined {
  // Absent outside a router, as in a page's own tests.
  const router = useRouter({ warn: false }) as
    ReturnType<typeof useRouter> | undefined
  const match = router?.state.location.pathname.match(/\/pages\/([^/]+)/)
  return match?.[1]
}

/** The vault path of the page file on screen, set by the page editor around its modules. */
export const PageFileContext = createContext<string | undefined>(undefined)

/** The page file's vault path, as /api/pages/v1 and page_read name it; absent outside a page. */
export const usePagePath = () => useContext(PageFileContext)
