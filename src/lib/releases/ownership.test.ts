// SOURCING: bun:test over ./merge and ./ownership: OWN-01 and acceptance A07
// (a product update over a user's fork keeps the user's changes, conflicts keep
// both versions, reset is revision-checked and never touches data).
import { describe, expect, test } from 'bun:test'
import { merge3, mergeFiles, resolveMerge, withMarkers } from './merge'
import {
  applyMerge,
  effectiveFiles,
  emptyOwned,
  fork,
  offerProductUpdate,
  replaceWithUpdate,
  resetToDefault,
  saveSettings,
} from './ownership'
import type { OwnedModule } from './ownership'

const lines = (...l: string[]) => l.join('\n')

describe('three-way merge', () => {
  const base = lines('a', 'b', 'c', 'd', 'e')

  test('changes in different places merge cleanly', () => {
    const r = merge3(
      base,
      lines('A', 'b', 'c', 'd', 'e'),
      lines('a', 'b', 'c', 'd', 'E'),
    )
    expect(r.conflicts).toBe(0)
    expect(r.text).toBe(lines('A', 'b', 'c', 'd', 'E'))
  })

  test('the same change on both sides is taken once', () => {
    const r = merge3(
      base,
      lines('a', 'X', 'c', 'd', 'e'),
      lines('a', 'X', 'c', 'd', 'e'),
    )
    expect(r.text).toBe(lines('a', 'X', 'c', 'd', 'e'))
  })

  test('different edits to one line conflict and keep base, yours and theirs', () => {
    const r = merge3(
      base,
      lines('a', 'mine', 'c', 'd', 'e'),
      lines('a', 'theirs', 'c', 'd', 'e'),
    )
    expect(r.conflicts).toBe(1)
    expect(r.text).toBeUndefined()
    const conflict = r.segments.find((s) => s.kind === 'conflict')!
    expect(conflict).toMatchObject({
      base: ['b'],
      mine: ['mine'],
      theirs: ['theirs'],
    })
    expect(withMarkers(r)).toContain('mine')
    expect(withMarkers(r)).toContain('theirs')
    expect(resolveMerge(r, ['theirs'])).toBe(
      lines('a', 'theirs', 'c', 'd', 'e'),
    )
    expect(resolveMerge(r, ['both'])).toBe(
      lines('a', 'mine', 'theirs', 'c', 'd', 'e'),
    )
    expect(resolveMerge(r, [])).toBe(lines('a', 'mine', 'c', 'd', 'e'))
  })

  test('insertions at different places and one-sided deletions merge', () => {
    const r = merge3(
      base,
      lines('a', 'new', 'b', 'c', 'd', 'e'),
      lines('a', 'b', 'c', 'e'),
    )
    expect(r.text).toBe(lines('a', 'new', 'b', 'c', 'e'))
  })

  test('a deletion against an edit of the same line is a conflict', () => {
    const r = merge3(
      base,
      lines('a', 'B', 'c', 'd', 'e'),
      lines('a', 'c', 'd', 'e'),
    )
    expect(r.conflicts).toBe(1)
  })

  test('files: one-sided changes are taken, a delete against an edit conflicts', () => {
    const out = mergeFiles(
      { x: '1', y: '1', z: '1' },
      { x: '1', y: '2', z: '2' },
      { x: '9', y: '1' },
    )
    const by = Object.fromEntries(out.map((m) => [m.path, m]))
    expect(by.x).toMatchObject({ status: 'took-update', text: '9' })
    expect(by.y).toMatchObject({ status: 'kept-yours', text: '2' })
    expect(by.z!.status).toBe('removed-conflict')
  })
})

describe('A07: a product update over a fork', () => {
  const shipped1 = {
    revision: 'r1',
    files: { 'index.html': lines('<h1>', 'title', '</h1>', 'footer') },
  }
  const shipped2 = {
    revision: 'r2',
    files: { 'index.html': lines('<h1>', 'new title', '</h1>', 'footer v2') },
  }

  const forked = (mine: string): OwnedModule => {
    let owned = emptyOwned('acme.crm')
    owned = { ...owned, shipped: shipped1 }
    return fork(owned, { 'index.html': mine }, 1)
  }

  test('a fork records the upstream revision it started from', () => {
    const owned = forked(shipped1.files['index.html'])
    expect(owned.source?.base).toMatchObject({
      upstreamId: 'acme.crm',
      revision: 'r1',
    })
  })

  test('an unedited fork moves up with the product', () => {
    const offer = offerProductUpdate(
      forked(shipped1.files['index.html']),
      shipped2,
      2,
    )
    expect(offer.kind).toBe('fast-forward')
    expect(effectiveFiles(offer.owned)).toEqual(shipped2.files)
  })

  test('an edited fork keeps the user source until the merge is settled, and conflicts keep both', () => {
    const mine = lines('<h1 class="x">', 'title', '</h1>', 'footer')
    const owned = forked(mine)
    const offer = offerProductUpdate(owned, shipped2, 2)
    expect(offer.kind).toBe('merge')
    if (offer.kind !== 'merge') return
    expect(effectiveFiles(offer.owned)).toEqual({ 'index.html': mine }) // user source untouched
    expect(offer.pending.conflicts).toBe(0) // your tag edit and the update's text edits do not overlap
    const settled = applyMerge(offer.owned, offer.owned.revision, {}, 3)
    expect(settled.ok).toBe(true)
    if (settled.ok)
      expect(effectiveFiles(settled.owned)!['index.html']).toBe(
        lines('<h1 class="x">', 'new title', '</h1>', 'footer v2'),
      )
  })

  test('a true conflict needs a choice, retains both, and a stale revision is refused', () => {
    const owned = forked(lines('<h1>', 'my title', '</h1>', 'my footer'))
    const offer = offerProductUpdate(owned, shipped2, 2)
    if (offer.kind !== 'merge') throw new Error('expected a merge')
    expect(offer.pending.conflicts).toBe(1)
    const noChoice = applyMerge(offer.owned, offer.owned.revision, {}, 3)
    expect(noChoice).toMatchObject({
      ok: false,
      reason: 'conflicts-unresolved',
    })
    expect(
      applyMerge(offer.owned, offer.owned.revision - 1, {}, 3),
    ).toMatchObject({ ok: false, reason: 'stale-revision' })
    const result = offer.pending.merges[0]!.result!
    const conflict = result.segments.find((s) => s.kind === 'conflict')!
    expect(conflict).toMatchObject({
      mine: ['my title'],
      theirs: ['new title'],
    })
    const both = applyMerge(
      offer.owned,
      offer.owned.revision,
      { 'index.html': ['both', 'theirs'] },
      3,
    )
    expect(both.ok && effectiveFiles(both.owned)!['index.html']).toContain(
      'my title',
    )
    expect(both.ok && effectiveFiles(both.owned)!['index.html']).toContain(
      'new title',
    )
  })

  test('explicit replacement keeps the user source in history', () => {
    const mine = lines('<h1>', 'my title', '</h1>', 'my footer')
    const offer = offerProductUpdate(forked(mine), shipped2, 2)
    const replaced = replaceWithUpdate(offer.owned, offer.owned.revision, 3)
    expect(replaced.ok).toBe(true)
    if (!replaced.ok) return
    expect(effectiveFiles(replaced.owned)).toEqual(shipped2.files)
    expect(replaced.owned.sourceHistory.at(-1)).toMatchObject({
      reason: 'replaced-by-update',
      files: { 'index.html': mine },
    })
  })

  test('with no fork the shipped default is replaced and settings are untouched', () => {
    let owned = saveSettings(
      { ...emptyOwned('acme.crm'), shipped: shipped1 },
      { density: 'compact' },
    )
    const offer = offerProductUpdate(owned, shipped2, 2)
    expect(offer.kind).toBe('adopt')
    expect(offer.owned.settings).toEqual({ density: 'compact' })
    owned = offer.owned
    expect(effectiveFiles(owned)).toEqual(shipped2.files)
  })

  test('reset-to-default is revision-checked, keeps history and settings', () => {
    const owned = saveSettings(forked('mine'), {
      density: 'compact',
      futureKey: { a: 1 },
    })
    expect(resetToDefault(owned, owned.revision - 1, 5)).toMatchObject({
      ok: false,
      reason: 'stale-revision',
    })
    const reset = resetToDefault(owned, owned.revision, 5)
    expect(reset.ok).toBe(true)
    if (!reset.ok) return
    expect(effectiveFiles(reset.owned)).toEqual(shipped1.files)
    expect(reset.owned.settings).toEqual({
      density: 'compact',
      futureKey: { a: 1 },
    })
    expect(reset.owned.sourceHistory.at(-1)).toMatchObject({
      reason: 'reset-to-default',
      files: { 'index.html': 'mine' },
    })
  })
})
