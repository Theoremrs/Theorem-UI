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

test('a list of plain or typed values is a prop like any other, not a slot', () => {
  const links = page()
  links.layout.content[0]!.props.links = [{ type: 'link', href: '/a' }]
  const relinked = page()
  relinked.layout.content[0]!.props.links = [{ type: 'link', href: '/b' }]
  expect(patchOps(links, relinked)).toEqual([
    {
      op: 'set_props',
      componentId: 'note',
      props: { links: [{ type: 'link', href: '/b' }] },
    },
  ])

  const untagged = page()
  untagged.layout.content[0]!.props.tags = []
  const tagged = page()
  tagged.layout.content[0]!.props.tags = ['urgent']
  expect(patchOps(untagged, tagged)).toEqual([
    { op: 'set_props', componentId: 'note', props: { tags: ['urgent'] } },
  ])
})

test('a component swapped for another in its place, or changed outside its props, is a whole save', () => {
  const swapped = page()
  swapped.layout.content[0]!.props.id = 'other_note'
  expect(patchOps(page(), swapped)).toBeNull()

  const locked = page()
  locked.layout.content[0]!.readOnly = { text: true }
  expect(patchOps(page(), locked)).toBeNull()
})

test('a slot gained, or a child added inside a slot, is a whole save', () => {
  const gained = page()
  gained.layout.content[0]!.props.aside = [
    { type: 'theorem.text', props: { id: 'aside_note', text: 'More' } },
  ]
  expect(patchOps(page(), gained)).toBeNull()

  const grown = page()
  const left = grown.layout.content[1]!.props
    .left as PageDocument['layout']['content']
  left.push({ type: 'theorem.text', props: { id: 'below', text: 'x' } })
  expect(patchOps(page(), grown)).toBeNull()
})

test('a legacy zone that kept its components is patched in place', () => {
  const zoned = (): PageDocument => {
    const one = page()
    one.layout.zones = {
      'cols:extra': [
        { type: 'theorem.text', props: { id: 'zoned', text: 'In a zone' } },
      ],
    }
    return one
  }
  const renamed = { ...zoned(), title: 'Work' }
  expect(patchOps(zoned(), renamed)).toEqual([
    { op: 'set_title', title: 'Work' },
  ])
  const edited = zoned()
  edited.layout.zones!['cols:extra']![0]!.props.text = 'Still in a zone'
  expect(patchOps(zoned(), edited)).toEqual([
    {
      op: 'set_props',
      componentId: 'zoned',
      props: { text: 'Still in a zone' },
    },
  ])
})
