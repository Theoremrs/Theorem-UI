import { useMatches } from '@tanstack/react-router'

export type ShellMode =
  'chat' | 'index' | 'notes' | 'pages' | 'vault' | 'spaces' | 'canvas' | 'ide'

/**
 * The mode is the route: /index, /notes, /pages, /vault, /spaces, /canvas and /ide, and chat everywhere else. It reads
 * the router's matches, as useParams does, so the mode and the thread id
 * always describe the same navigation.
 */
export function useShellMode(): ShellMode {
  return useMatches({
    select: (matches) => {
      for (const { routeId } of matches) {
        if (routeId === '/_chat/index') return 'index'
        if (
          routeId === '/_chat/notes' ||
          routeId === '/_chat/notes/$documentId'
        )
          return 'notes'
        if (routeId === '/_chat/pages' || routeId === '/_chat/pages/$pageId')
          return 'pages'
        if (routeId === '/_chat/vault') return 'vault'
        if (routeId === '/_chat/spaces') return 'spaces'
        if (routeId === '/_chat/canvas') return 'canvas'
        if (routeId === '/_chat/ide') return 'ide'
      }
      return 'chat'
    },
  })
}
