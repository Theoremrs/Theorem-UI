// SOURCING: bun:test over the References state (./references): grouping by canonical source, labeled counts, and a page reducer that keeps rows when a later page fails.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { ReferenceOccurrence } from './provider'
import {
  countLabel,
  groupOccurrences,
  initialReferences,
  referencesReducer,
  visibleCounts,
} from './references'
import { filterByRelationship } from './relationships'
import { registerProvider, useResourceProviders } from './registry'

beforeEach(() => useResourceProviders.setState({ providers: new Map() }))

const occ = (
  id: string,
  source: string,
  relationship: ReferenceOccurrence['relationship'] = 'authored-mention',
  title = source,
): ReferenceOccurrence => {
  const s = {
    resource: { kind: 'document' as const, documentId: source },
    hint: { label: title },
  }
  return {
    id,
    source: s,
    target: { resource: { kind: 'document', documentId: 'target' } },
    relationship,
    destination: { ...s, location: { anchor: id } },
  }
}

describe('references', () => {
  test('groups repeated mentions by canonical source, not title, and keeps each destination', () => {
    const groups = groupOccurrences([
      occ('1', 'a', 'authored-mention', 'Same title'),
      occ('2', 'b', 'authored-mention', 'Same title'),
      occ('3', 'a', 'embed'),
    ])
    expect(groups.map((g) => [g.sourceKey, g.occurrences.length])).toEqual([
      ['document:a', 2],
      ['document:b', 1],
    ])
    expect(groups[0]!.relationships).toEqual(['authored-mention', 'embed'])
    expect(
      groups[0]!.occurrences.map((o) => o.destination.location?.anchor),
    ).toEqual(['1', '3'])
    expect(visibleCounts(groups)).toEqual({ sources: 2, occurrences: 3 })
  })

  test('uses the owner canonical key when ids differ', () => {
    registerProvider({
      id: 'theorem.docs',
      label: 'd',
      serves: ['document'],
      support: {},
      canonicalize: (r) =>
        r.kind === 'document'
          ? `doc:${r.documentId.replace('alias-', '')}`
          : undefined,
    })
    expect(groupOccurrences([occ('1', 'alias-a'), occ('2', 'a')])).toHaveLength(
      1,
    )
  })

  test('a failed later page keeps the rows and offers to retry; a failed first page is not empty', () => {
    let state = referencesReducer(initialReferences, {
      type: 'page',
      page: { occurrences: [occ('1', 'a')], next: 'c1' },
      append: false,
    })
    state = referencesReducer(state, { type: 'more' })
    expect(state.status).toBe('loading-more')
    state = referencesReducer(state, { type: 'failed', error: 'timeout' })
    expect(state.status).toBe('failed-more')
    expect(state.rows).toHaveLength(1)
    expect(state.next).toBe('c1')
    const first = referencesReducer(initialReferences, {
      type: 'failed',
      error: 'down',
    })
    expect(first.status).toBe('failed')
    expect(first.rows).toHaveLength(0)
  })

  test('a repeated row from a later page is not added twice', () => {
    let state = referencesReducer(initialReferences, {
      type: 'page',
      page: { occurrences: [occ('1', 'a')], next: 'c' },
      append: false,
    })
    state = referencesReducer(state, {
      type: 'page',
      page: { occurrences: [occ('1', 'a'), occ('2', 'b')] },
      append: true,
    })
    expect(state.rows.map((r) => r.id)).toEqual(['1', '2'])
  })

  test('counts name their unit and say when they are partial', () => {
    const base = referencesReducer(initialReferences, {
      type: 'page',
      page: {
        occurrences: [occ('1', 'a'), occ('2', 'a')],
        next: 'c',
        total: { count: 9, unit: 'sources', exact: false },
      },
      append: false,
    })
    expect(countLabel(base)).toBe('1 of at least 9 visible sources')
    const done = referencesReducer(initialReferences, {
      type: 'page',
      page: {
        occurrences: [occ('1', 'a')],
        total: { count: 1, unit: 'sources', exact: true },
      },
      append: false,
    })
    expect(countLabel(done)).toBe('1 visible sources')
    expect(
      countLabel(
        referencesReducer(initialReferences, {
          type: 'page',
          page: { occurrences: [occ('1', 'a')], next: 'x' },
          append: false,
        }),
      ),
    ).toBe('1 visible source so far')
  })

  test('relationship filters keep meanings apart', () => {
    const rows = [
      occ('1', 'a', 'authored-mention'),
      occ('2', 'b', 'suggested'),
      occ('3', 'c', 'operational-dependency'),
    ]
    expect(
      filterByRelationship(rows, new Set(['suggested'])).map((r) => r.id),
    ).toEqual(['2'])
    expect(filterByRelationship(rows, new Set()).length).toBe(3)
  })
})
