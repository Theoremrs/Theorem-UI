// SOURCING: lib/commands (the one command path palette rows, menus and agents share), the Work owner's POST /api/work/v1/items `source` (WORK-01, through ./new-item's dialog and the WorkSource seam) and lib/resources for the reference. Holds only which source the dialog was asked for; the item and its origin are the Work owner's.
import { z } from 'zod'
import { create } from 'zustand'
import { registerCommand } from '@/lib/commands/registry'
import { toWireLocation } from '@/lib/resources/backend-http'
import { isResourceIdentity } from '@/lib/resources/types'
import type { ResourceRef } from '@/lib/resources/types'
import { NewItemDialog } from './new-item'
import { useWorkSource } from './source'

export const CREATE_FROM_COMMAND = 'theorem.work.create-from'

const useWorkFromSource = create<{ from?: ResourceRef }>(() => ({}))

/** Whether the Work owner can keep `ref` as an item's origin. */
export const canMakeWorkFrom = (ref: ResourceRef) =>
  // An item is not made from another item; a source the wire cannot name
  // could not be recorded.
  ref.resource.kind !== 'work-item' && toWireLocation(ref) !== undefined

const refArgs = z.object({
  ref: z.custom<ResourceRef>(
    (value) =>
      typeof value === 'object' &&
      value !== null &&
      isResourceIdentity((value as { resource?: unknown }).resource),
    'a resource reference',
  ),
})

/**
 * `theorem.work.create-from { ref }`: opens the new-item dialog with `ref` as
 * the item's source. Nothing is created until the person submits the form,
 * and nothing of the source's content is copied into it.
 */
export function registerWorkFromSource(): () => void {
  return registerCommand({
    id: CREATE_FROM_COMMAND,
    label: 'Make a work item from this',
    group: 'Work',
    description: 'Create a Work item that keeps a link to where it came from.',
    args: refArgs,
    effect: 'presentation',
    target: 'host',
    capability: 'work.items.create',
    palette: false,
    run: ({ ref }) => {
      if (!canMakeWorkFrom(ref))
        throw new Error('A work item cannot be made from this.')
      useWorkFromSource.setState({ from: ref })
    },
  })
}

/** The dialog the command opens; mounted once by the shell. */
export function WorkFromSourceHost() {
  const from = useWorkFromSource((state) => state.from)
  const source = useWorkSource()
  if (!source.createItem || !from) return null
  return (
    <NewItemDialog
      open
      onOpenChange={(open) => {
        if (!open) useWorkFromSource.setState({ from: undefined })
      }}
      from={from}
    />
  )
}
