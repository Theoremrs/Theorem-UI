// SOURCING: bun:test over the adapter to Theorem's /api/resources/v1 routes, with a recording transport in place of the network. The wire payloads follow resource_api.rs's serde shapes (camelCase fields, kebab-case kinds, snake_case states and relationships).
import { afterEach, expect, test } from 'bun:test'
import { TheoremError } from '@theoremharness/sdk'
import { installBackend } from './backend'
import {
  fromWireRef,
  httpBackend,
  relationshipFromWire,
  relationshipToWire,
  toWireRef,
} from './backend-http'
import { preview, references, resolve } from './registry'
import { RELATIONSHIP_KINDS } from './relationships'
import { live } from './types'
import type { ResourceIdentity } from './types'

const calls: Array<{ operation: string; body: unknown }> = []
const answering =
  (reply: (operation: string, body: unknown) => unknown) =>
  async <T>(operation: string, body: unknown) => {
    calls.push({ operation, body })
    return reply(operation, body) as T
  }

let uninstall: (() => void) | undefined
afterEach(() => {
  uninstall?.()
  uninstall = undefined
  calls.length = 0
})

test('identities cross the wire in the backend’s vocabulary and come back unchanged', () => {
  const cases: Array<[ResourceIdentity, unknown]> = [
    [
      { kind: 'file', workspaceId: 'w', path: 'a.md' },
      { kind: 'file', workspaceId: 'w', path: 'a.md' },
    ],
    [
      { kind: 'document', documentId: 'd1' },
      { kind: 'graph-object', objectId: 'd1' },
    ],
    [
      { kind: 'thread', threadId: 't1' },
      { kind: 'conversation', threadId: 't1' },
    ],
    [
      { kind: 'work-item', itemId: 'wi_1' },
      { kind: 'work-item', itemId: 'wi_1' },
    ],
    [
      { kind: 'record', objectType: 'company', objectId: 'r1' },
      { kind: 'record', objectType: 'company', objectId: 'r1' },
    ],
    [
      { kind: 'extension', extensionKind: 'acme.crm.ticket', id: 'T-1' },
      {
        kind: 'extension',
        namespace: 'acme.crm',
        resourceType: 'ticket',
        id: 'T-1',
      },
    ],
  ]
  for (const [identity, wire] of cases) {
    expect(toWireRef(identity)).toEqual(wire as never)
    if (identity.kind !== 'document')
      expect(fromWireRef(wire as never)).toEqual(identity)
  }
  // The wire's namespace has two segments at least; `acme.ticket` has no form.
  expect(
    toWireRef({ kind: 'extension', extensionKind: 'acme.ticket', id: '1' }),
  ).toBeUndefined()
})

test('every relationship keeps its own meaning across the wire', () => {
  expect(relationshipToWire('citation')).toBe('provenance')
  expect(relationshipToWire('embed')).toBe('authored_embed')
  for (const kind of RELATIONSHIP_KINDS)
    expect(relationshipFromWire(relationshipToWire(kind))).toBe(kind)
  expect(relationshipFromWire('invented')).toBeUndefined()
})

test('resolve asks the route for a kind no provider here answers', async () => {
  uninstall = installBackend(
    httpBackend(
      answering(() => ({
        contract: 'theorem.resource-ref/1',
        results: [{ index: 0, state: 'not_found' }],
      })),
    ),
  )
  const answer = await resolve(
    live({ kind: 'extension', extensionKind: 'theorem.test.item', id: 'x' }),
  )
  expect(answer).toEqual({ state: 'unavailable' })
  expect(calls).toEqual([
    {
      operation: 'resolve',
      body: {
        references: [
          {
            resource: {
              kind: 'extension',
              namespace: 'theorem.test',
              resourceType: 'item',
              id: 'x',
            },
          },
        ],
      },
    },
  ])
})

test('the route’s answer becomes this client’s resolve result', async () => {
  const backend = httpBackend(
    answering((_, body) => {
      const ref = (body as { references: unknown[] }).references[0]
      return {
        contract: 'theorem.resource-ref/1',
        results: [
          {
            index: 0,
            state: 'available',
            resolved: {
              reference: ref,
              state: 'available',
              display: { label: 'Fix the dock', typeLabel: 'Work item' },
              currentRevision: 3,
              operations: ['resolve', 'preview', 'references', 'open'],
            },
          },
        ],
      }
    }),
  )
  expect(
    await backend.resolve!(live({ kind: 'work-item', itemId: 'wi_1' }), {}),
  ).toEqual({
    state: 'ready',
    meta: {
      title: 'Fix the dock',
      typeLabel: 'Work item',
      revision: 3,
      actions: ['preview', 'references', 'open'],
    },
  })
  for (const [wire, mine] of [
    ['deleted', 'deleted'],
    ['not_found', 'unavailable'],
    ['unsupported', 'unsupported'],
    ['unavailable', 'unavailable'],
  ] as const) {
    const answer = await httpBackend(
      answering(() => ({
        contract: 'theorem.resource-ref/1',
        results: [{ index: 0, state: wire }],
      })),
    ).resolve!(live({ kind: 'work-item', itemId: 'wi_1' }), {})
    expect(answer).toEqual({ state: mine })
  }
})

test('a Theorem without the routes answers unsupported, not a failure', async () => {
  const missing = httpBackend(async () => {
    throw new TheoremError({ message: 'no', statusCode: 404, body: undefined })
  })
  const ref = live({ kind: 'work-item', itemId: 'wi_1' })
  expect(await missing.resolve!(ref, {})).toEqual({ state: 'unsupported' })
  expect(await missing.references!(ref, { direction: 'incoming' }, {})).toEqual(
    { state: 'unsupported', operation: 'references' },
  )
  // A resource the route says is not found is not a missing route.
  const notFound = httpBackend(async () => {
    throw new TheoremError({
      message: 'no',
      statusCode: 404,
      body: { code: 'resource_not_found' },
    })
  })
  await expect(
    notFound.references!(ref, { direction: 'incoming' }, {}),
  ).rejects.toBeInstanceOf(TheoremError)
})

const occurrence = (id: string, relationship: string) => ({
  occurrenceId: id,
  source: {
    resource: { kind: 'work-item', itemId: 'wi_src' },
    revision: 7,
    anchor: { kind: 'field', id: 'body' },
  },
  target: { resource: { kind: 'work-item', itemId: 'wi_1' } },
  relationship,
  label: 'see wi_1',
})

test('references read every meaning by default and open each occurrence at its source', async () => {
  uninstall = installBackend(
    httpBackend(
      answering(() => ({
        contract: 'theorem.resource-ref/1',
        resource: { kind: 'work-item', itemId: 'wi_1' },
        direction: 'incoming',
        groups: [
          {
            peer: {
              reference: { resource: { kind: 'work-item', itemId: 'wi_src' } },
              state: 'available',
              display: { label: 'Source item' },
              operations: ['resolve'],
            },
            occurrences: [
              occurrence('o1', 'authored_mention'),
              occurrence('o2', 'provenance'),
            ],
          },
        ],
        visiblePeerCount: 1,
        nextCursor: 'c2',
        coverage: [{ provider: 'theorem.work.items', state: 'complete' }],
      })),
    ),
  )
  // Work items have no references of their own here, so the route answers.
  const page = await references(live({ kind: 'work-item', itemId: 'wi_1' }), {
    direction: 'incoming',
  })
  expect(calls[0]!.operation).toBe('references')
  expect(calls[0]!.body).toEqual({
    resource: { kind: 'work-item', itemId: 'wi_1' },
    direction: 'incoming',
    relationships: RELATIONSHIP_KINDS.map(relationshipToWire),
  })
  if (!('occurrences' in page)) throw new Error('expected a page')
  expect(page.next).toBe('c2')
  expect(page.total).toEqual({ count: 1, unit: 'sources', exact: true })
  expect(page.occurrences.map((o) => o.relationship)).toEqual([
    'authored-mention',
    'citation',
  ])
  const first = page.occurrences[0]!
  expect(first.source).toEqual({
    resource: { kind: 'work-item', itemId: 'wi_src' },
    revision: { mode: 'pinned', revision: 7 },
    location: { anchor: 'body' },
    hint: { label: 'Source item' },
  })
  expect(first.destination).toEqual(first.source)
  expect(first.sourceRevision).toBe(7)
  expect(first.snippet).toBe('see wi_1')
})

test('a partial index says its count is not exact; a page every provider failed is a failure', async () => {
  const ref = live({ kind: 'work-item', itemId: 'wi_1' })
  const page = (coverage: unknown[], groups: unknown[] = []) =>
    httpBackend(
      answering(() => ({
        contract: 'theorem.resource-ref/1',
        resource: { kind: 'work-item', itemId: 'wi_1' },
        direction: 'incoming',
        groups,
        visiblePeerCount: 0,
        coverage,
      })),
    ).references!(ref, { direction: 'incoming' }, {})
  expect(
    await page([
      { provider: 'theorem.work.items', state: 'complete' },
      {
        provider: 'theorem.references.backfill',
        state: 'partial',
        limitation: 'older work items are still being indexed',
      },
    ]),
  ).toEqual({
    occurrences: [],
    total: { count: 0, unit: 'sources', exact: false },
  })
  await expect(
    page([{ provider: 'theorem.work.items', state: 'failed' }]),
  ).rejects.toThrow('theorem.work.items failed')
  expect(
    await page([{ provider: 'theorem.work.items', state: 'unsupported' }]),
  ).toEqual({ state: 'unsupported', operation: 'references' })
})

test('an artifact’s preview comes from the route when no provider here previews it', async () => {
  const ref = live({ kind: 'artifact', artifactId: 'a1' })
  uninstall = installBackend(
    httpBackend(
      answering(() => ({
        resource: {
          reference: { resource: { kind: 'artifact', artifactId: 'a1' } },
          state: 'available',
          display: { label: 'model/gltf+json', typeLabel: 'Artifact result' },
          currentRevision: 'sha256:abc',
          operations: ['resolve', 'preview'],
        },
        fields: [
          { label: 'Media type', value: 'model/gltf+json' },
          { label: 'Reproducibility', value: 'deterministic' },
        ],
      })),
    ),
  )
  expect(await preview(ref)).toEqual({
    state: 'ready',
    preview: {
      title: 'model/gltf+json',
      typeLabel: 'Artifact result',
      fields: [
        { key: '0:Media type', label: 'Media type', value: 'model/gltf+json' },
        {
          key: '1:Reproducibility',
          label: 'Reproducibility',
          value: 'deterministic',
        },
      ],
    },
  })
  expect(calls).toEqual([
    {
      operation: 'preview',
      body: { location: { resource: { kind: 'artifact', artifactId: 'a1' } } },
    },
  ])
  // A result the owner no longer has is not a preview.
  const gone = await httpBackend(
    answering(() => ({
      resource: {
        reference: { resource: { kind: 'artifact', artifactId: 'a1' } },
        state: 'not_found',
        operations: [],
      },
    })),
  ).preview!(ref, {})
  expect(gone).toEqual({ state: 'unavailable' })
})
