// SOURCING: bun:test over patchOps, the pure rule that decides when a page edit is a patch by
// stable component id and when it is a whole-document save.
import { expect, test } from 'bun:test'
import type { PageDocument } from '@/lib/modules/contract'
import { patchOps } from './patch'

const page = (): PageDocument => ({
  schema: 'theorem.page/1',
  title: 'Projects',
  pinned: false,
  layout: {
    root: { props: {} },
    content: [
      { type: 'theorem.text', props: { id: 'note', text: 'Hello' } },
      {
        type: 'theorem.split',
        props: {
          id: 'cols',
          left: [
            {
              type: 'theorem.capability.table',
              props: {
                id: 'tasks',
                instanceId: 'tracker/main',
                viewKey: 'next',
              },
            },
          ],
          right: [],
        },
      },
    ],
  },
})

test('one component whose props changed is one set_props naming only what changed', () => {
  const after = page()
  after.layout.content[0]!.props.text = 'Hello again'
  expect(patchOps(page(), after)).toEqual([
    { op: 'set_props', componentId: 'note', props: { text: 'Hello again' } },
  ])
})

test('a component inside a slot is patched by its own id, not its parent', () => {
  const after = page()
  const left = after.layout.content[1]!.props
    .left as PageDocument['layout']['content']
  left[0]!.props.viewKey = 'done'
  expect(patchOps(page(), after)).toEqual([
    { op: 'set_props', componentId: 'tasks', props: { viewKey: 'done' } },
  ])
})

test('a title, a pin and a new prop are ops; an unchanged page is none', () => {
  const after = { ...page(), title: 'Work', pinned: true }
  after.layout.content[0]!.props.size = 'large'
  expect(patchOps(page(), after)).toEqual([
    { op: 'set_title', title: 'Work' },
    { op: 'set_pinned', pinned: true },
    { op: 'set_props', componentId: 'note', props: { size: 'large' } },
  ])
  expect(patchOps(page(), page())).toEqual([])
})

test('anything a shallow merge cannot say is a whole-document save', () => {
  const removedKey = page()
  delete removedKey.layout.content[0]!.props.text
  expect(patchOps(page(), removedKey)).toBeNull()

  const reordered = page()
  reordered.layout.content.reverse()
  expect(patchOps(page(), reordered)).toBeNull()

  const added = page()
  added.layout.content.push({ type: 'theorem.text', props: { id: 'more' } })
  expect(patchOps(page(), added)).toBeNull()

  const movedInSlot = page()
  const cols = movedInSlot.layout.content[1]!.props
  cols.right = cols.left
  cols.left = []
  expect(patchOps(page(), movedInSlot)).toBeNull()

  const root = page()
  root.layout.root = { props: { fill: true } }
  expect(patchOps(page(), root)).toBeNull()

  const zones = page()
  zones.layout.zones = { 'cols:extra': [] }
  expect(patchOps(page(), zones)).toBeNull()
})
