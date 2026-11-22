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

/** Same type, id and keys outside its props, with no prop removed: what a shallow merge keeps. */
function sameShape(before: ComponentData, after: ComponentData): boolean {
  if (before.type !== after.type || before.props.id !== after.props.id)
    return false
  const { props: _beforeProps, ...beforeRest } = before
  const { props: _afterProps, ...afterRest } = after
  return (
    isEqual(beforeRest, afterRest) &&
    Object.keys(before.props).every((key) => key in after.props)
  )
}

/** A slot on both sides whose children kept their places. */
const pairSlots = (was: unknown, value: unknown, ops: PageOp[]): boolean =>
  isSlot(was) && isSlot(value) && pairList(was, value, ops)

function pairComponent(
  before: ComponentData,
  after: ComponentData,
  ops: PageOp[],
): boolean {
  if (!sameShape(before, after)) return false
  const changed: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(after.props)) {
    const was = before.props[key]
    if (isEqual(was, value)) continue
    // A slot whose children kept their places is paired child by child, so a
    // change inside it is that child's own op, never its parent's.
    if (isSlot(was) || isSlot(value)) {
      if (!pairSlots(was, value, ops)) return false
    } else changed[key] = value
  }
  if (Object.keys(changed).length)
    ops.push({ op: 'set_props', componentId: before.props.id, props: changed })
  return true
}

/** The legacy zones: the same names, each one's list paired in place. */
function pairZones(
  before: PageDocument,
  after: PageDocument,
  ops: PageOp[],
): boolean {
  const zonesBefore = before.layout.zones ?? {}
  const zonesAfter = after.layout.zones ?? {}
  const names = Object.keys(zonesBefore)
  if (!isEqual(names.sort(), Object.keys(zonesAfter).sort())) return false
  return names.every((name) =>
    pairList(zonesBefore[name]!, zonesAfter[name]!, ops),
  )
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
  return pairList(before.layout.content, after.layout.content, ops) &&
    pairZones(before, after, ops)
    ? ops
    : null
}
