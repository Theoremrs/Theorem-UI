// SOURCING: @theoremharness/sdk's TheoremContextReference (a message
// resource, as a scene's entity is asked about in scene-part.tsx), the
// sandbox's AppSelection, and the 8 KB a composer reference may be. No
// library names "what was selected in a view inside a reply".
import type { TheoremContextReference } from '@theoremharness/sdk'
import type { AppSelection } from '@/lib/blocks/sandbox/protocol'

/** The most a reference's excerpt is given, under the 8 KB a reference may be. */
const MAX_EXCERPT = 6000

/**
 * A short, stable name for one definition of a view: its cells and data. A
 * selection names it, so the next turn knows which drawing the person saw.
 */
export function viewRevision(cells: ReadonlyArray<string>, data: unknown): string {
  // FNV-1a over the definition's JSON; identity, not security.
  let hash = 0x811c9dc5
  const text = JSON.stringify([cells, data ?? null])
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** The present operation's name (operations.ts PRESENT), here so readers need not load the component library. */
const PRESENT = 'ui.present'

/**
 * The code of each View a present call draws, as the program the reply runs:
 * its cells, under its title. A view stands in the answer as the drawing
 * alone, so the terminal and the workbench show its code from this. Anything
 * that is not a present call reads as no views.
 */
export function presentedViewSources(data: unknown): string[] {
  const call = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  if (call.operation !== PRESENT) return []
  const sources: string[] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    const { _type, cells, title, children } = node as Record<string, unknown>
    if (_type === 'View' && Array.isArray(cells)) {
      const body = cells.filter((cell) => typeof cell === 'string').join('\n\n')
      if (body) sources.push(typeof title === 'string' && title ? `// ${title}\n${body}` : body)
    }
    walk(children)
  }
  walk(call.args)
  return sources
}

/** Whether the person pointed at anything in the view. */
export const selectionSays = (selection?: AppSelection) =>
  Boolean(
    selection &&
      (selection.text ||
        selection.entityId ||
        selection.rowId ||
        selection.ids?.length ||
        (selection.state && Object.keys(selection.state).length)),
  )

/** What a selection is called in the composer: the view's own words for it. */
function selectionName(selection: AppSelection): string | undefined {
  return (
    selection.entityLabel ||
    selection.text.trim().slice(0, 60) ||
    selection.entityId ||
    selection.rowId
  )
}

/**
 * A reference to a view in a reply, with what the person selected in it:
 * the records' ids, the view's state and the parameters they moved. It names
 * the message the view is in and the view's revision, so the next turn reads
 * the selection against the drawing the person saw. Ids, then state, are
 * shortened until the excerpt fits.
 */
export function viewReference(view: {
  threadId: string
  messageId: string
  title: string
  revision: string
  selection?: AppSelection
}): TheoremContextReference {
  const said = selectionSays(view.selection) ? view.selection : undefined
  const name = said && selectionName(said)
  const excerptOf = (selection?: Partial<AppSelection>) =>
    JSON.stringify({
      view: { title: view.title, revision: view.revision },
      ...(selection && { selection }),
    })
  let selection: Partial<AppSelection> | undefined = said && {
    ...said,
    text: said.text.slice(0, 1000) || undefined,
  }
  let excerpt = excerptOf(selection)
  while (selection?.ids?.length && excerpt.length > MAX_EXCERPT) {
    selection = { ...selection, ids: selection.ids.slice(0, Math.floor(selection.ids.length / 2)) }
    excerpt = excerptOf(selection)
  }
  if (selection && excerpt.length > MAX_EXCERPT) {
    selection = { ...selection, state: undefined }
    excerpt = excerptOf(selection)
  }
  return {
    label: name ? `${view.title}: ${name}` : view.title,
    excerpt,
    location: {
      resource: {
        kind: 'message',
        threadId: view.threadId,
        messageId: view.messageId,
      },
    },
  }
}
