// SOURCING: bun:test over the draft slot rules in ./drafts: UX-02 and
// acceptance A17 (a save clears only the submitted revision, a newer revision
// is offered over an active edit, unknown settings survive).
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  RevisionMoved,
  acceptOffered,
  applySettingsEdit,
  beginSave,
  editDraft,
  incomingRevision,
  isDirty,
  keepMine,
  openDraft,
  saveDraft,
  saveSucceeded,
  useDraftSlots,
  pagesUnsaved,
} from './drafts'

describe('draft slot rules', () => {
  test('saving clears only the submitted revision', () => {
    let slot = editDraft(openDraft('h1', 'a'), 'ab')
    const begun = beginSave(slot)
    slot = editDraft(begun.slot, 'abc') // typed while the write is in flight
    const after = saveSucceeded(slot, begun.submitted, 'h2')
    expect(after).toBeDefined()
    expect(after!.value).toBe('abc')
    expect(after!.saved).toBe('ab')
    expect(after!.base).toBe('h2')
    expect(isDirty(after!)).toBe(true)
  })

  test('with no edit in flight the draft is cleared', () => {
    const slot = editDraft(openDraft('h1', 'a'), 'ab')
    const begun = beginSave(slot)
    expect(saveSucceeded(begun.slot, begun.submitted, 'h2')).toBeUndefined()
  })

  test('a newer revision is offered over an active edit and replaces nothing', () => {
    const slot = editDraft(openDraft('h1', 'a'), 'mine')
    const next = incomingRevision(slot, { base: 'h2', value: 'theirs' })
    expect(next.value).toBe('mine')
    expect(next.offered).toEqual({ base: 'h2', value: 'theirs' })
    expect(acceptOffered(next).value).toBe('theirs')
    const kept = keepMine(next)
    expect(kept.value).toBe('mine')
    expect(kept.base).toBe('h2')
    expect(kept.offered).toBeUndefined()
  })

  test('a clean slot takes the newer revision; the same revision changes nothing', () => {
    const slot = openDraft('h1', 'a')
    expect(incomingRevision(slot, { base: 'h2', value: 'b' }).value).toBe('b')
    expect(incomingRevision(slot, { base: 'h1', value: 'a' })).toBe(slot)
  })

  test('unknown settings are kept, a known key the edit omits is removed', () => {
    const next = applySettingsEdit(
      { density: 'compact', zoom: 2, future: { a: 1 } },
      { density: 'roomy' },
      ['density', 'zoom'],
    )
    expect(next).toEqual({ density: 'roomy', future: { a: 1 } })
  })
})

describe('saveDraft over the store', () => {
  beforeEach(() => useDraftSlots.setState({ slots: {} }))
  const put = (slot: ReturnType<typeof openDraft<string>>) =>
    useDraftSlots.getState().put('k', slot)
  const slot = () =>
    useDraftSlots.getState().slots.k as
      ReturnType<typeof openDraft<string>> | undefined

  test('an edit made during the write stays unsaved', async () => {
    put(editDraft(openDraft('h1', 'a'), 'ab'))
    const result = await saveDraft<string>('k', async () => {
      put(editDraft(slot()!, 'abc'))
      return { base: 'h2' }
    })
    expect(result).toBe('saved-with-newer-edits')
    expect(slot()!.value).toBe('abc')
    expect(isDirty(slot()!)).toBe(true)
    expect(pagesUnsaved()).toBe(true)
  })

  test('a plain save clears the draft', async () => {
    put(editDraft(openDraft('h1', 'a'), 'ab'))
    expect(await saveDraft<string>('k', async () => ({ base: 'h2' }))).toBe(
      'saved',
    )
    expect(slot()).toBeUndefined()
  })

  test('a failed write keeps the draft with the reason', async () => {
    put(editDraft(openDraft('h1', 'a'), 'ab'))
    const result = await saveDraft<string>('k', async () => {
      throw new Error('offline')
    })
    expect(result).toBe('failed')
    expect(slot()).toMatchObject({ value: 'ab', failure: 'offline' })
  })

  test('A17: another client saved first: the draft is kept and the saved revision held beside it', async () => {
    put(editDraft(openDraft('h1', 'a'), 'mine'))
    const result = await saveDraft<string>('k', async () => {
      throw new RevisionMoved({ base: 'h9', value: 'theirs' })
    })
    expect(result).toBe('conflict')
    expect(slot()).toMatchObject({
      value: 'mine',
      conflict: { base: 'h9', value: 'theirs' },
    })
  })

  test('a second save while one is in flight does nothing', async () => {
    put(editDraft(openDraft('h1', 'a'), 'ab'))
    let inner: string | undefined
    await saveDraft<string>('k', async () => {
      inner = await saveDraft<string>('k', async () => ({ base: 'x' }))
      return { base: 'h2' }
    })
    expect(inner).toBe('nothing')
  })
})
