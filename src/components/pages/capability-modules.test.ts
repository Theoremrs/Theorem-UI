// SOURCING: bun:test over the two capability modules as registrations in the page catalog (the way
// page.test.tsx reads BUILTIN_MODULES), and over the composer reference path the context envelope
// rides. What is asserted is the contract with the page system: the module names, their settings and
// ports, and that a capability reference behaves like the record reference already in the composer —
// keyed, deduped, and readable by the module wiring.
import { describe, expect, test } from 'bun:test'
import { BUILTIN_MODULES } from './builtins'
import { SPLIT_TYPE } from './puck-config'
import type { ComponentData, LayoutData } from '@/lib/modules/contract'
import { COMPOSITE_INPUT, extractComposite } from '@/lib/modules/layout'
import { moduleById } from '@/lib/modules/registry'
import { isReference } from '@/lib/modules/values'
import {
  referenceKey,
  useComposerReferences,
} from '@/components/chat/composer-references'
import { capabilityContextReference } from '@/lib/capabilities/reference'
import { trackerDefinition } from '@/components/capabilities/fixture'

const table = moduleById('theorem.capability.table')!
const record = moduleById('theorem.capability.record')!

describe('the catalog', () => {
  test('both modules are built-ins under the names the plan pins', () => {
    expect(BUILTIN_MODULES.map((module) => module.id)).toContain(
      'theorem.capability.table',
    )
    expect(BUILTIN_MODULES.map((module) => module.id)).toContain(
      'theorem.capability.record',
    )
    expect(table.origin).toBe('builtin')
    expect(record.origin).toBe('builtin')
    expect(table.implementation.kind).toBe('builtin')
  })

  test('each binds its instance and view through settings, inside the page document', () => {
    expect(table.settings.map((setting) => setting.name)).toEqual([
      'instanceId',
      'viewKey',
    ])
    expect(record.settings.map((setting) => setting.name)).toEqual([
      'instanceId',
      'recordId',
    ])
    // Every setting defaults to nothing, so a page saved without one still parses
    // and says what is missing rather than guessing at an instance.
    for (const setting of [...table.settings, ...record.settings])
      expect(setting.default).toBe('')
    // The kinds the editor renders natively: no new resource kind is invented here.
    for (const setting of [...table.settings, ...record.settings])
      expect(setting.kind).toBe('text')
  })

  test('a table’s selection and context reach a connected detail and the composer', () => {
    const outputs = table.outputs.map((port) => [port.name, port.type])
    expect(outputs).toEqual([
      ['selected', 'item'],
      ['selection', 'json'],
      ['context', 'reference'],
    ])
    expect(record.inputs.map((port) => [port.name, port.type])).toEqual([
      ['record', 'item'],
      ['instanceId', 'text'],
      ['viewKey', 'text'],
    ])
    expect(table.events.map((port) => port.name)).toEqual(['opened', 'context'])
    expect(table.actions.map((port) => port.name)).toEqual([
      'select',
      'deselect',
    ])
  })

  test('neither module asks for a capability the host grants: a built-in reaches its own routes', () => {
    // requestedCapabilities gate a sandboxed module; these are built in, and the
    // instance's grants are what limits them.
    expect(table.capabilities).toEqual({
      read: [],
      write: [],
      state: [],
      net: [],
    })
    expect(record.capabilities).toEqual({
      read: [],
      write: [],
      state: [],
      net: [],
    })
  })
})

describe('instance and view as inputs', () => {
  test('both modules take their instance and view as text inputs under the settings’ names', () => {
    expect(table.inputs.map((port) => [port.name, port.type])).toEqual([
      ['instanceId', 'text'],
      ['viewKey', 'text'],
    ])
    // A bound input of a setting's name takes that setting's place, so each
    // input names a setting the module already reads (the record's view is
    // read by its envelope instead).
    for (const port of table.inputs)
      expect(table.settings.map((setting) => setting.name)).toContain(port.name)
    expect(record.settings.map((setting) => setting.name)).toContain(
      'instanceId',
    )
  })

  test('a composite over a capability table exposes its instance and view as inputs', () => {
    const lookup = (id: string) => moduleById(id)
    const component = (
      type: string,
      id: string,
      props: Record<string, unknown> = {},
    ): ComponentData => ({ type, props: { id, ...props } })
    const layout: LayoutData = {
      root: { props: {} },
      content: [
        component('theorem.text', 'which', { text: 'tracker/main' }),
        component('theorem.text', 'pick', { text: 'all' }),
        component(SPLIT_TYPE, 'box', {
          first: [
            component('theorem.capability.table', 'table', {
              instanceId: '',
              viewKey: '',
              bind: {
                instanceId: { from: 'which', port: 'text' },
                viewKey: { from: 'pick', port: 'text' },
              },
            }),
          ],
          second: [],
        }),
      ],
    }
    const extracted = extractComposite(layout, 'box', 'acme.tracker', lookup)!
    // The ports the module declares, by their own labels and types; an
    // undeclared input would come through as a bare json port.
    expect(extracted.inputs).toEqual([
      { name: 'instanceId', label: 'Capability instance', type: 'text' },
      { name: 'viewKey', label: 'View', type: 'text' },
    ])
    const inner = (extracted.content[0]!.props.first as ComponentData[])[0]!
    expect(inner.props.bind).toEqual({
      instanceId: { from: COMPOSITE_INPUT, port: 'instanceId' },
      viewKey: { from: COMPOSITE_INPUT, port: 'viewKey' },
    })
    const placed = extracted.layout.content.find(
      (one) => one.type === 'acme.tracker',
    )!
    expect(placed.props.bind).toEqual({
      instanceId: { from: 'which', port: 'text' },
      viewKey: { from: 'pick', port: 'text' },
    })
  })
})

describe('the context envelope', () => {
  const envelope = {
    instanceId: 'tracker/main',
    collectionKey: 'tasks',
    pageId: 'Desk',
    viewKey: 'next',
    purpose: trackerDefinition.purpose,
    label: 'Project tracker · Next · 2 selected',
    selected: [
      { id: 'rec-1', revision: 6 },
      { id: 'rec-2', revision: 3 },
    ],
    filtered: true,
    truncated: false,
  }
  const reference = capabilityContextReference(envelope)

  test('it rides the existing reference path, so a route to the composer takes it', () => {
    expect(isReference(reference)).toBe(true)
    expect(referenceKey(reference)).toBe('capability:tracker/main/tasks/next')
  })

  test('one envelope per instance and view, refreshed in place as the selection moves', () => {
    useComposerReferences.setState({ references: [] })
    const { add } = useComposerReferences.getState()
    add(reference)
    add(
      capabilityContextReference({
        ...envelope,
        selected: [{ id: 'rec-2', revision: 3 }],
      }),
    )
    // Re-read the store: `add` replaces the array, it does not mutate it.
    const held = useComposerReferences.getState().references
    expect(held.length).toBe(1)
    // The later read is what the turn carries.
    expect(held[0]!.location.resource).toMatchObject({
      selected: [{ id: 'rec-2', revision: 3 }],
    })
    // A different view is its own context.
    add(capabilityContextReference({ ...envelope, viewKey: 'all' }))
    expect(useComposerReferences.getState().references.length).toBe(2)
    useComposerReferences.setState({ references: [] })
  })

  test('a record with no revision is not carried, and a large selection is cut short and says so', () => {
    const many = Array.from({ length: 250 }, (_, at) => ({
      id: `rec-${at}`,
      revision: at,
    }))
    const cut = capabilityContextReference({ ...envelope, selected: many })
    const { selected, truncated } = cut.location.resource
    expect(selected.length).toBe(100)
    expect(truncated).toBe(true)
    // Every id it carries names the revision it was read at.
    expect(selected[0]).toEqual({ id: 'rec-0', revision: 0 })
  })

  test('a view with no key and a page with no id are simply not named', () => {
    const bare = capabilityContextReference({
      ...envelope,
      pageId: undefined,
      viewKey: undefined,
    })
    expect(Object.keys(bare.location.resource)).toEqual([
      'kind',
      'instanceId',
      'collectionKey',
      'purpose',
      'selected',
      'filtered',
      'truncated',
    ])
    expect(referenceKey(bare)).toBe('capability:tracker/main/tasks')
  })
})
