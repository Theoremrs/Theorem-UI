// SOURCING: bun:test over the saved-view contract (./saved-view) with synthetic Work and Index views.
import { describe, expect, test } from 'bun:test'
import type { IndexView } from '@/components/index/contract'
import type { WorkView } from '@/components/work/contract'
import {
  compileIndex,
  compileWork,
  fromIndexView,
  fromWorkView,
  isAdjusted,
} from './saved-view'

const work = (over: Partial<WorkView> = {}): WorkView => ({
  id: 'v1',
  name: 'Mine',
  scope: 'items',
  layout: 'list',
  filter: {
    op: 'and',
    conditions: [{ field: 'assignee', operator: 'is', value: 'me' }],
  },
  groupBy: 'status',
  orderBy: { field: 'updatedAt', direction: 'desc' },
  displayFields: ['title'],
  builtin: false,
  revision: 'r1',
  ...over,
})

describe('saved views over Work', () => {
  test('compiles a supported definition and keeps the viewer-relative value for the owner', () => {
    const view = fromWorkView(work())
    expect(view.schema).toBe('theorem.saved-view/1')
    expect(view.owner).toEqual({ kind: 'work', scope: 'items' })
    const result = compileWork(view)
    expect(result.ok).toBe(true)
    if (result.ok) expect(JSON.stringify(result.query.filter)).toContain('"me"')
  })

  test('blocks a filter the tracker cannot run instead of widening the view', () => {
    const stored = work({
      filter: {
        op: 'and',
        conditions: [
          { field: 'assignee', operator: 'is', value: 'me' },
          {
            op: 'or',
            conditions: [
              {
                field: 'sprintGoal' as never,
                operator: 'matches_semantically' as never,
                value: 'x',
              },
            ],
          },
        ],
      },
    })
    const view = fromWorkView(stored)
    const result = compileWork(view)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.blocked).toBe('unsupported-filter')
    expect(result.unsupported.map((c) => c.field)).toEqual(['sprintGoal'])
    // The stored definition is untouched.
    expect(result.original).toBe(stored)
    expect(view.filters.conditions).toHaveLength(2)
  })

  test('an unsupported layout draws as a list, announced, and keeps the stored layout', () => {
    const view = fromWorkView(work({ layout: 'timeline' as never }))
    expect(view.presentation).toEqual({
      layout: 'timeline',
      fallback: {
        shown: 'list',
        reason: 'Layout timeline is not available here.',
      },
    })
  })

  test('an unknown sort or group blocks too', () => {
    const view = fromWorkView(work())
    expect(
      compileWork({ ...view, sort: { field: 'karma', direction: 'asc' } }).ok,
    ).toBe(false)
    expect(compileWork({ ...view, group: 'astrology' }).ok).toBe(false)
  })

  test('unsaved adjustments are separate from the definition', () => {
    expect(isAdjusted({ viewId: 'v1', search: 'x' })).toBe(false)
    expect(isAdjusted({ viewId: 'v1', adjustments: { group: null } })).toBe(
      true,
    )
  })
})

describe('saved views over the Index', () => {
  const index = (query: object): IndexView =>
    ({
      viewId: 'default:docs',
      scope: { kind: 'home' },
      origin: 'user',
      pinned: false,
      archived: false,
      createdAtMs: 1,
      updatedAtMs: 2,
      current: {
        revision: 4,
        title: 'Docs',
        purpose: '',
        program: '',
        bindings: { main: { kind: 'items', query }, atlas: { kind: 'map' } },
        operations: [],
        note: '',
        author: { kind: 'human', actorId: 'a' },
        createdAtMs: 1,
      },
    }) as unknown as IndexView

  test('reads the items binding as filters and keeps every binding for the owner', () => {
    const view = fromIndexView(
      index({ q: 'kiln', kind: 'note', sort: 'updated' }),
    )
    expect(view.filters.conditions).toEqual([
      { field: 'q', operator: 'contains', value: 'kiln' },
      { field: 'kind', operator: 'is', value: 'note' },
    ])
    expect(view.revision).toBe(4)
    const compiled = compileIndex(view)
    expect(compiled.ok).toBe(true)
    if (compiled.ok)
      expect(Object.keys(compiled.query)).toEqual(['main', 'atlas'])
  })

  test('blocks a condition the Index cannot run', () => {
    const view = fromIndexView(index({ q: 'x' }))
    const widened = {
      ...view,
      filters: {
        op: 'and' as const,
        conditions: [{ field: 'embedding', operator: 'near', value: 'x' }],
      },
    }
    const result = compileIndex(widened)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.original).toBe(view.original)
  })
})
