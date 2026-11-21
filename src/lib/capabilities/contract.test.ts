// SOURCING: bun:test over the wire vectors Theorem's own contract tests assert
// (rustyredcore_THG/crates/theorem-surface-contracts/src/capabilities_api.rs, mod tests), copied here
// so the mirror in lib/capabilities/contract.ts is held to the same JSON both sides exchange. What
// these can prove on this side is the shape: the Rust `deny_unknown_fields` strictness lives in the
// contract owner and has no TypeScript equivalent, so a body this app sends with an extra field would
// only be caught by the server.
import { expect, test } from 'bun:test'
import {
  trackerDefinition,
  instance,
  ownerGrant,
} from '@/components/capabilities/fixture'
import { matchAll } from './contract'
import type {
  CreateInstanceRequest,
  DefinitionPatch,
  Grant,
  InvocationReceipt,
  QueryRequest,
  QueryFilter,
} from './contract'

/** The body as it goes over the wire: JSON.stringify, then read back as plain data. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

/** One path out of plain JSON, so a test names a wire key without fighting the types. */
function pick(value: unknown, ...path: Array<string | number>): unknown {
  let at = value
  for (const step of path) {
    if (Array.isArray(at)) {
      at = at[Number(step)]
      continue
    }
    if (at && typeof at === 'object') {
      at = (at as Record<string, unknown>)[String(step)]
      continue
    }
    return undefined
  }
  return at
}

test('the definition wire is camelCase and survives the trip unchanged', () => {
  const sent = wire(trackerDefinition)
  expect(Object.keys(sent as Record<string, unknown>)).toEqual([
    'capabilityId',
    'name',
    'purpose',
    'collections',
    'views',
    'actions',
    'agent',
  ])
  expect(pick(sent, 'capabilityId')).toBe('project-tracker')
  expect(pick(sent, 'collections', 0, 'objectTypeId')).toBe('ot:tasks')
  expect(pick(sent, 'collections', 0, 'semanticRoles', 'statusField')).toBe(
    'status',
  )
  expect(pick(sent, 'collections', 0, 'lifecycle', 'fieldKey')).toBe('status')
  expect(
    pick(sent, 'collections', 0, 'lifecycle', 'transitions', 1, 'from'),
  ).toEqual(['done'])
  expect(pick(sent, 'views', 0, 'filter', 'op')).toBe('eq')
  expect(pick(sent, 'views', 0, 'filter', 'fieldKey')).toBe('status')
  expect(pick(sent, 'views', 0, 'orderBy', 'direction')).toBe('asc')
  expect(pick(sent, 'views', 1, 'filter', 'op')).toBe('and')
  expect(pick(sent, 'actions', 1, 'effects', 1)).toEqual({
    fieldKey: 'completed_at',
    source: 'now',
  })
  expect(pick(sent, 'actions', 0, 'effects', 0)).toEqual({
    fieldKey: 'title',
    source: 'input',
    key: 'title',
  })
  expect(pick(sent, 'agent', 'discoverable')).toBe(true)
  // Nothing is lost: the same plain data reads back as it was written.
  expect(sent).toEqual(wire(wire(trackerDefinition)))
  // A collection with no roles or lifecycle carries neither key.
  expect(
    Object.keys(pick(sent, 'collections', 1) as Record<string, unknown>),
  ).toEqual(['key', 'objectTypeId', 'label'])
})

test('the filter tree round-trips and nests', () => {
  const filter: QueryFilter = {
    op: 'and',
    conditions: [
      { op: 'eq', fieldKey: 'status', value: 'next' },
      { op: 'not', condition: { op: 'is_empty', fieldKey: 'due_at' } },
      {
        op: 'or',
        conditions: [
          { op: 'lte', fieldKey: 'effort_minutes', value: 20 },
          { op: 'contains', fieldKey: 'title', value: 'quick' },
        ],
      },
    ],
  }
  const sent = wire(filter)
  expect(pick(sent, 'op')).toBe('and')
  expect(pick(sent, 'conditions', 1, 'op')).toBe('not')
  expect(pick(sent, 'conditions', 1, 'condition', 'op')).toBe('is_empty')
  expect(pick(sent, 'conditions', 2, 'conditions', 0, 'fieldKey')).toBe(
    'effort_minutes',
  )
  expect(pick(sent, 'conditions', 0, 'fieldKey')).toBe('status')
  expect(sent).toEqual(wire(filter))
  // `match_all` is an empty `and`, as the contract's own helper says.
  expect(wire(matchAll())).toEqual({ op: 'and', conditions: [] })
})

test('a receipt carries its status and outcome on the wire', () => {
  const receipt: InvocationReceipt = {
    recordId: 'capop:abc',
    invocationKey: 'key-1',
    instanceId: 'tracker/main',
    actionKey: 'complete',
    definitionId: 'capdef:abc',
    requestDigest: 'sha256:abc',
    startedAtMs: 1,
    status: 'finished',
    outcome: {
      outcome: 'completed',
      affected: [{ id: 'rec-1', revision: 7 }],
      fields: { status: 'done' },
    },
    finishedAtMs: 2,
  }
  const sent = wire(receipt) as Record<string, unknown>
  expect(sent.status).toBe('finished')
  expect(pick(sent, 'outcome', 'outcome')).toBe('completed')
  expect(pick(sent, 'outcome', 'affected', 0, 'revision')).toBe(7)
  expect(pick(sent, 'outcome', 'fields')).toEqual({ status: 'done' })
  expect(sent.finishedAtMs).toBe(2)

  // A call the journal still holds carries no outcome and no finish time.
  const dispatched: InvocationReceipt = {
    recordId: 'capop:abc',
    invocationKey: 'key-1',
    instanceId: 'tracker/main',
    actionKey: 'complete',
    definitionId: 'capdef:abc',
    requestDigest: 'sha256:abc',
    startedAtMs: 1,
    status: 'dispatched',
  }
  expect(wire(dispatched)).toEqual({
    recordId: 'capop:abc',
    invocationKey: 'key-1',
    instanceId: 'tracker/main',
    actionKey: 'complete',
    definitionId: 'capdef:abc',
    requestDigest: 'sha256:abc',
    startedAtMs: 1,
    status: 'dispatched',
  })
})

test('a query request omits its absent options', () => {
  const request: QueryRequest = {
    instanceId: 'tracker/main',
    viewKey: 'next',
    query: undefined,
    cursor: undefined,
    limit: undefined,
  }
  expect(wire(request)).toEqual({ instanceId: 'tracker/main', viewKey: 'next' })
})

test('patch ops are tagged', () => {
  const patch: DefinitionPatch = {
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'add_field',
        collectionKey: 'tasks',
        field: {
          key: 'effort_minutes',
          label: 'Effort (minutes)',
          fieldType: { kind: 'integer' },
          required: false,
        },
      },
      {
        op: 'rename_field',
        collectionKey: 'tasks',
        fieldKey: 'title',
        label: 'Task',
      },
      { op: 'set_view_filter', viewKey: 'next', filter: matchAll() },
    ],
  }
  const sent = wire(patch)
  expect(pick(sent, 'expectedDefinitionId')).toBe('capdef:abc')
  expect(pick(sent, 'ops', 0, 'op')).toBe('add_field')
  expect(pick(sent, 'ops', 0, 'collectionKey')).toBe('tasks')
  expect(pick(sent, 'ops', 0, 'field', 'fieldType', 'kind')).toBe('integer')
  expect(pick(sent, 'ops', 1, 'op')).toBe('rename_field')
  expect(pick(sent, 'ops', 2, 'filter')).toEqual({ op: 'and', conditions: [] })
  expect(sent).toEqual(wire(patch))
})

test('the create request and author result round-trip', () => {
  const request: CreateInstanceRequest = {
    definition: trackerDefinition,
    instanceId: 'tracker/main',
    workspaceId: undefined,
    declareTypes: [{ name_singular: 'task' }],
  }
  const sent = wire(request) as Record<string, unknown>
  expect(sent.instanceId).toBe('tracker/main')
  expect('workspaceId' in sent).toBe(false)
  expect(pick(sent, 'declareTypes')).toEqual([{ name_singular: 'task' }])
  expect(pick(sent, 'definition', 'capabilityId')).toBe('project-tracker')

  const result = { definitionId: 'capdef:abc', instance: instance() }
  expect(pick(wire(result), 'definitionId')).toBe('capdef:abc')
  expect(pick(wire(result), 'instance', 'grants', 0, 'invoke')).toEqual(['*'])
  expect(
    'workspaceId' in
      (pick(wire(result), 'instance') as Record<string, unknown>),
  ).toBe(false)
})

test('a grant separates invoke from author', () => {
  const grant: Grant = {
    principal: 'agent:planner',
    read: true,
    invoke: ['complete'],
    author: false,
  }
  expect(wire(grant)).toEqual({
    principal: 'agent:planner',
    read: true,
    invoke: ['complete'],
    author: false,
  })
  expect((wire(ownerGrant) as Grant).invoke).toEqual(['*'])
})
