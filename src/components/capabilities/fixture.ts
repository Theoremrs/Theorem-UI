// SOURCING: the definition Theorem's own contract tests build (capabilities_api.rs `tracker_definition`
// and its receipt and query vectors), copied so these tests exercise the same wire the Rust asserts.
// One fixture, so a table test, an authoring test and the client test all read the same instance.
import type {
  CollectionSchema,
  CapabilityDefinition,
  CapabilityInstance,
  CapabilityRecordRow,
  DescribeResult,
  DiscoverResult,
  Grant,
  InvocationReceipt,
  QueryResult,
} from '@/lib/capabilities/contract'

export const INSTANCE = 'tracker/main'

export const trackerDefinition: CapabilityDefinition = {
  capabilityId: 'project-tracker',
  name: 'Project tracker',
  purpose: 'Track personal projects and tasks',
  collections: [
    {
      key: 'tasks',
      objectTypeId: 'ot:tasks',
      label: 'Tasks',
      semanticRoles: {
        statusField: 'status',
        completionField: 'completed_at',
        targetDateField: 'due_at',
      },
      lifecycle: {
        fieldKey: 'status',
        // Governed: a create must write 'next', and nothing else.
        initial: ['next'],
        transitions: [
          { from: ['next', 'in_progress', 'waiting'], to: 'done' },
          { from: ['done'], to: 'next' },
        ],
      },
    },
    { key: 'people', objectTypeId: 'ot:people', label: 'People' },
  ],
  views: [
    {
      key: 'next',
      label: 'Next',
      collectionKey: 'tasks',
      filter: { op: 'eq', fieldKey: 'status', value: 'next' },
      orderBy: { fieldKey: 'due_at', direction: 'asc' },
      layout: 'list',
    },
    {
      key: 'all',
      label: 'All tasks',
      collectionKey: 'tasks',
      filter: { op: 'and', conditions: [] },
      layout: 'table',
    },
    {
      key: 'people',
      label: 'People',
      collectionKey: 'people',
      filter: { op: 'and', conditions: [] },
      layout: 'list',
    },
  ],
  actions: [
    {
      key: 'add',
      label: 'Add task',
      collectionKey: 'tasks',
      creates: true,
      input: [
        { key: 'title', fieldType: { kind: 'text' }, required: true },
        { key: 'due_at', fieldType: { kind: 'date' }, required: false },
      ],
      preconditions: [],
      effects: [
        { fieldKey: 'title', source: 'input', key: 'title' },
        { fieldKey: 'status', source: 'literal', value: 'next' },
      ],
    },
    {
      key: 'complete',
      label: 'Complete',
      collectionKey: 'tasks',
      creates: false,
      input: [],
      preconditions: [
        {
          op: 'in',
          fieldKey: 'status',
          values: ['next', 'in_progress', 'waiting'],
        },
      ],
      effects: [
        { fieldKey: 'status', source: 'literal', value: 'done' },
        { fieldKey: 'completed_at', source: 'now' },
      ],
    },
    {
      key: 'update',
      label: 'Edit',
      collectionKey: 'tasks',
      creates: false,
      input: [
        { key: 'title', fieldType: { kind: 'text' }, required: false },
        { key: 'status', fieldType: { kind: 'text' }, required: false },
        {
          key: 'effort_minutes',
          fieldType: { kind: 'integer' },
          required: false,
        },
      ],
      preconditions: [],
      effects: [
        { fieldKey: 'title', source: 'input', key: 'title' },
        { fieldKey: 'status', source: 'input', key: 'status' },
        { fieldKey: 'effort_minutes', source: 'input', key: 'effort_minutes' },
      ],
    },
    {
      key: 'assign',
      label: 'Assign',
      collectionKey: 'tasks',
      creates: false,
      input: [
        {
          key: 'assignee',
          fieldType: { kind: 'reference', collectionKey: 'people' },
          required: false,
        },
      ],
      preconditions: [],
      effects: [{ fieldKey: 'assignee', source: 'input', key: 'assignee' }],
    },
  ],
  agent: { discoverable: true, description: 'Personal task tracker' },
}

export const tasksSchema: CollectionSchema = {
  collectionKey: 'tasks',
  objectTypeId: 'ot:tasks',
  label: 'Tasks',
  fields: [
    {
      key: 'title',
      label: 'Title',
      fieldType: { kind: 'text' },
      required: true,
    },
    {
      key: 'status',
      label: 'Status',
      fieldType: {
        kind: 'enum',
        variants: ['next', 'in_progress', 'waiting', 'done'],
      },
      required: true,
    },
    {
      key: 'due_at',
      label: 'Due',
      fieldType: { kind: 'date' },
      required: false,
    },
    {
      key: 'effort_minutes',
      label: 'Effort (minutes)',
      fieldType: { kind: 'integer' },
      required: false,
    },
    {
      key: 'assignee',
      label: 'Assignee',
      fieldType: {
        kind: 'relation',
        targetObjectTypeId: 'ot:people',
        cardinality: 'one',
      },
      required: false,
    },
    {
      key: 'completed_at',
      label: 'Completed',
      fieldType: { kind: 'timestamp' },
      required: false,
    },
  ],
}

export const peopleSchema: CollectionSchema = {
  collectionKey: 'people',
  objectTypeId: 'ot:people',
  label: 'People',
  fields: [
    { key: 'name', label: 'Name', fieldType: { kind: 'text' }, required: true },
  ],
}

export const ownerGrant: Grant = {
  principal: 'user:travis',
  read: true,
  invoke: ['*'],
  author: true,
}

export const readerGrant: Grant = {
  principal: 'user:travis',
  read: true,
  invoke: [],
  author: false,
}

export const row = (
  id: string,
  fields: Record<string, unknown>,
  revision: number,
  links?: Record<string, string[]>,
): CapabilityRecordRow => ({
  id,
  fields,
  revision,
  ...(links ? { links } : {}),
})

export const taskRows: CapabilityRecordRow[] = [
  row(
    'rec-1',
    {
      title: 'Write the plan',
      status: 'next',
      due_at: '2026-11-22',
      effort_minutes: 20,
    },
    6,
  ),
  row(
    'rec-2',
    { title: 'Sketch the page', status: 'next', due_at: '2026-11-25' },
    3,
  ),
]

export const describeResult = (grant: Grant = ownerGrant): DescribeResult => ({
  definitionId: 'capdef:abc',
  definition: trackerDefinition,
  callerGrant: grant,
  collectionSchemas: [tasksSchema, peopleSchema],
  // The full grant list is disclosed only to a caller who may author.
  ...(grant.author ? { grants: [ownerGrant] } : {}),
})

export const queryResult = (
  records: CapabilityRecordRow[],
  over?: Partial<QueryResult>,
): QueryResult => ({
  records,
  total: records.length,
  filtered: false,
  truncated: false,
  definitionId: 'capdef:abc',
  ...over,
})

export const instance = (definitionId = 'capdef:abc'): CapabilityInstance => ({
  instanceId: INSTANCE,
  capabilityId: 'project-tracker',
  definitionId,
  config: {},
  grants: [ownerGrant],
  ownerPrincipal: 'user:travis',
  createdAtMs: 1,
})

export const discoverResult = (): DiscoverResult => ({
  instances: [
    {
      instanceId: INSTANCE,
      capabilityId: 'project-tracker',
      name: 'Project tracker',
      purpose: 'Track personal projects and tasks',
      collectionLabels: ['Tasks', 'People'],
      definitionId: 'capdef:abc',
    },
  ],
})

/** A receipt for a finished, completed call over one record. */
export const completedReceipt = (
  actionKey: string,
  affected: Array<{ id: string; revision: number }>,
  fields: Record<string, unknown> = {},
): InvocationReceipt => ({
  recordId: 'capop:abc',
  invocationKey: 'key-1',
  instanceId: INSTANCE,
  actionKey,
  definitionId: 'capdef:abc',
  requestDigest: 'sha256:abc',
  startedAtMs: 1,
  status: 'finished',
  outcome: { outcome: 'completed', affected, fields },
  finishedAtMs: 2,
})
