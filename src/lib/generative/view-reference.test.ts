import { expect, test } from 'bun:test'
import { presentedViewSources, selectionSays, viewReference, viewRevision } from './view-reference'

const at = { threadId: 'thread-1', messageId: 'message-1', title: 'Retrieval scores' }

test('a revision names one definition: the same cells and data, the same name', () => {
  const cells = ['views.linked(data, {x: "a", y: "b"})']
  expect(viewRevision(cells, [{ a: 1 }])).toBe(viewRevision([...cells], [{ a: 1 }]))
  expect(viewRevision(cells, [{ a: 1 }])).not.toBe(viewRevision(cells, [{ a: 2 }]))
  expect(viewRevision(cells, undefined)).toMatch(/^[0-9a-f]{8}$/)
})

test('a view with nothing selected is referred to by its title and revision', () => {
  const reference = viewReference({ ...at, revision: 'abc' })
  expect(reference.label).toBe('Retrieval scores')
  expect(JSON.parse(reference.excerpt!)).toEqual({ view: { title: 'Retrieval scores', revision: 'abc' } })
  expect(reference.location).toEqual({
    resource: { kind: 'message', threadId: 'thread-1', messageId: 'message-1' },
  })
})

test('a selection carries its ids and state, and is named in the view\'s words', () => {
  const selection = {
    text: '',
    entityLabel: '3 of 24 documents',
    ids: ['d1', 'd2', 'd3'],
    state: { linked1: [[0, 1], [2, 3]], params: { threshold: 0.7 } },
  }
  expect(selectionSays(selection)).toBe(true)
  expect(selectionSays({ text: '' })).toBe(false)
  const reference = viewReference({ ...at, revision: 'abc', selection })
  expect(reference.label).toBe('Retrieval scores: 3 of 24 documents')
  const excerpt = JSON.parse(reference.excerpt!)
  expect(excerpt.selection.ids).toEqual(['d1', 'd2', 'd3'])
  expect(excerpt.selection.state.params).toEqual({ threshold: 0.7 })
})

test('a large selection is shortened, ids first, until it fits a composer reference', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `record-${i}-${'x'.repeat(40)}`)
  const reference = viewReference({
    ...at,
    revision: 'abc',
    selection: { text: '', entityLabel: 'All', ids, state: { params: { k: 1 } } },
  })
  expect(reference.excerpt!.length).toBeLessThanOrEqual(6000)
  const excerpt = JSON.parse(reference.excerpt!)
  expect(excerpt.selection.ids.length).toBeLessThan(200)
  expect(excerpt.selection.ids[0]).toBe(ids[0])
  expect(excerpt.selection.state).toEqual({ params: { k: 1 } })
})

test('a present call\'s views are read as their code, titled, wherever they sit in the tree', () => {
  const sources = presentedViewSources({
    operation: 'ui.present',
    args: {
      _type: 'Stack',
      children: [
        { _type: 'View', title: 'Prices', cells: ['const k = 2', 'k * 2'] },
        { _type: 'Card', children: { _type: 'View', cells: ['1'] } },
      ],
    },
  })
  expect(sources).toEqual(['// Prices\nconst k = 2\n\nk * 2', '1'])
  expect(presentedViewSources({ operation: 'other', args: { _type: 'View', cells: ['1'] } })).toEqual([])
})
