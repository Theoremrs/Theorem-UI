// SOURCING: the module registry (lib/modules/registry) the way work-modules.tsx uses it — each
// capability module is one component behind the instance's own contract, with its selection as an
// output, its context envelope as a reference, and select/deselect actions, so a page wires a table
// to a record detail with the same wires the Index view and Inspector use.
import { CapabilityRecordModule } from '@/components/capabilities/capability-record'
import { CapabilityTableModule } from '@/components/capabilities/capability-table'
import { builtin } from '@/lib/modules/registry'
import type { ModuleDefinition } from '@/lib/modules/registry'

const item = (name: string, label: string) => ({
  name,
  label,
  type: 'item' as const,
})

const reference = (name: string, label: string) => ({
  name,
  label,
  type: 'reference' as const,
})

const json = (name: string, label: string) => ({
  name,
  label,
  type: 'json' as const,
})

/** Which instance a module reads, and nothing else: the definition decides its views. */
const instanceSetting = {
  name: 'instanceId',
  label: 'Capability instance',
  kind: 'text' as const,
  default: '',
  description:
    'The instance id as capability_discover names it, for example tracker/main.',
}

export const CAPABILITY_MODULES: ReadonlyArray<ModuleDefinition> = [
  builtin({
    id: 'theorem.capability.table',
    label: 'Capability table',
    description:
      "One view of a capability instance: its records as a list or a table, with the definition's quick-add over them and one button per update action. Selecting rows puts them in the composer as context.",
    category: 'Theorem',
    settings: [
      instanceSetting,
      {
        name: 'viewKey',
        label: 'View',
        kind: 'text',
        default: '',
        description:
          "Which of the definition's views to open on; empty starts at its first.",
      },
    ],
    outputs: [
      item('selected', 'Selected record'),
      json('selection', 'Selected records, at their revisions'),
      reference('context', 'Page context'),
    ],
    events: [
      item('opened', 'Opened a record'),
      reference('context', 'Selection changed'),
    ],
    actions: [
      item('select', 'Select a record'),
      json('deselect', 'Clear the selection'),
    ],
    Component: CapabilityTableModule,
  }),
  builtin({
    id: 'theorem.capability.record',
    label: 'Capability record',
    description:
      "One capability record: its fields as the register holds them, saved through a declared action, with the definition's other actions beside it. It has nothing to show until a record comes in.",
    category: 'Theorem',
    settings: [
      instanceSetting,
      {
        name: 'recordId',
        label: 'Record',
        kind: 'text',
        default: '',
        description:
          'The record id to show when none is connected. A connected Item names its own collection as well.',
      },
    ],
    inputs: [item('record', 'Record')],
    outputs: [
      item('selected', 'Shown record'),
      reference('context', 'Page context'),
    ],
    events: [reference('context', 'What it shows')],
    Component: CapabilityRecordModule,
  }),
]
