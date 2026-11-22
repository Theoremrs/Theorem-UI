// SOURCING: lodash-es isEqual for value comparison; the rule itself is the page owner's op
// vocabulary (lib/pages/contract.ts PageOp, Theorem's theorem-pages patch module). No library
// models "which edits a stable-id shallow merge can express".
import { isEqual } from 'lodash-es'
import type { ComponentData, PageDocument } from '@/lib/modules/contract'
import type { PageOp } from './contract'

const isComponent = (value: unknown): value is ComponentData =>
  value !== null &&
  typeof value === 'object' &&
  typeof (value as ComponentData).type === 'string' &&
  (value as ComponentData).props !== null &&
  typeof (value as ComponentData).props === 'object' &&
  typeof (value as ComponentData).props.id === 'string'

/** A slot: a non-empty list of components. An empty list is an ordinary value. */
const isSlot = (value: unknown): value is ComponentData[] =>
  Array.isArray(value) && value.length > 0 && value.every(isComponent)

/**
 * Pairs two component lists that hold the same components in the same
 * places, adding a set_props for each component whose own values changed.
 * Returns false when the lists differ in shape: a move, an insert, a removal,
 * a changed type, or a removed prop, which a shallow merge cannot say.
 */
function pairList(
  before: ComponentData[],
  after: ComponentData[],
  ops: PageOp[],
): boolean {
  if (before.length !== after.length) return false
  return before.every((one, i) => pairComponent(one, after[i]!, ops))
}

function pairComponent(
  before: ComponentData,
  after: ComponentData,
  ops: PageOp[],
): boolean {
  if (before.type !== after.type || before.props.id !== after.props.id)
    return false
  const { props: _beforeProps, ...beforeRest } = before
  const { props: _afterProps, ...afterRest } = after
  if (!isEqual(beforeRest, afterRest)) return false
  const changed: Record<string, unknown> = {}
  for (const key of Object.keys(before.props))
    if (!(key in after.props)) return false
  for (const [key, value] of Object.entries(after.props)) {
    const was = before.props[key]
    if (isEqual(was, value)) continue
    // A slot whose children kept their places is paired child by child, so a
    // change inside it is that child's own op, never its parent's.
    if (isSlot(was) && isSlot(value)) {
      if (!pairList(was, value, ops)) return false
      continue
    }
    if (isSlot(was) || isSlot(value)) return false
    changed[key] = value
  }
  if (Object.keys(changed).length)
    ops.push({ op: 'set_props', componentId: before.props.id, props: changed })
  return true
}

/**
 * The ops that turn `before` into `after`, by stable component id, when the
 * edit is a change of title, pin, or the props of components that stayed
 * where they were; `null` when it is anything else (a component added,
 * removed, moved or retyped, a prop removed, the root or zones changed), which
 * is saved as a whole document. An unchanged page is no ops.
 */
export function patchOps(
  before: PageDocument,
  after: PageDocument,
): PageOp[] | null {
  if (
    before.schema !== after.schema ||
    !isEqual(before.layout.root, after.layout.root)
  )
    return null
  const ops: PageOp[] = []
  if (before.title !== after.title)
    ops.push({ op: 'set_title', title: after.title })
  if (before.pinned !== after.pinned)
    ops.push({ op: 'set_pinned', pinned: after.pinned })
  if (!pairList(before.layout.content, after.layout.content, ops)) return null
  const zonesBefore = before.layout.zones ?? {}
  const zonesAfter = after.layout.zones ?? {}
  const names = Object.keys(zonesBefore)
  if (!isEqual(names.sort(), Object.keys(zonesAfter).sort())) return null
  for (const name of names)
    if (!pairList(zonesBefore[name]!, zonesAfter[name]!, ops)) return null
  return ops
}
