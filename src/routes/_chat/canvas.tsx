import { createFileRoute } from '@tanstack/react-router'

type CanvasSearch = {
  /** The node id of the standing program open on the canvas. */
  program?: string
  /** The node id of a saved session graph. */
  view?: string
  /** A session graph not saved yet: `project:<id>` or `tree:<any chat of it>` (lib/theorem/sessions). */
  sessions?: string
}

export const Route = createFileRoute('/_chat/canvas')({
  validateSearch: (search: Record<string, unknown>): CanvasSearch => {
    const out: CanvasSearch = {}
    for (const key of ['program', 'view', 'sessions'] as const) {
      const value = search[key]
      if (typeof value === 'string' && value) out[key] = value
    }
    return out
  },
  component: () => null,
})
