import { afterEach, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { FieldEditor, FieldEditorPopover } from './fields'
import type { FieldSpec } from './contract'
import { cleanup, render, waitFor } from '../../../test/blocks/render'

afterEach(cleanup)

const tags: FieldSpec = {
  key: 'tags',
  label: 'Tags',
  field_type: { kind: 'enum_many', variants: ['red', 'blue'] },
  required: false,
  system: false,
}

async function open(
  onCommit: (value: unknown) => void,
  onCommitAway?: (value: unknown) => void,
  onDiscard: () => void = () => {},
) {
  await render(
    <FieldEditorPopover
      anchor={document.body}
      field={tags}
      value={['red']}
      onCommit={onCommit}
      onCommitAway={onCommitAway}
      onDiscard={onDiscard}
    />,
  )
  const option = await waitFor(() =>
    [...document.querySelectorAll('[role="option"]')].find(
      (item) => item.textContent.trim() === 'blue',
    ),
  )
  await act(async () => (option as HTMLElement).click())
}

const clickAway = () =>
  act(async () => {
    const outside = document.documentElement
    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    outside.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    outside.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

test('clicking away saves what a multi-select is holding', async () => {
  const onCommit = mock((_value: unknown) => {})
  await open(onCommit)
  expect(onCommit).not.toHaveBeenCalled()
  await clickAway()
  await waitFor(() => (onCommit.mock.calls.length ? true : undefined))
  expect(onCommit.mock.calls[0]?.[0]).toEqual(['red', 'blue'])
})

test('clicking away saves through onCommitAway, leaving focus alone', async () => {
  const onCommit = mock((_value: unknown) => {})
  const onCommitAway = mock((_value: unknown) => {})
  await open(onCommit, onCommitAway)
  await clickAway()
  await waitFor(() => (onCommitAway.mock.calls.length ? true : undefined))
  expect(onCommitAway.mock.calls[0]?.[0]).toEqual(['red', 'blue'])
  expect(onCommit).not.toHaveBeenCalled()
})

// Changed deliberately: this case used to assert that Escape saved what the
// editor held. Escape now cancels, so the value stays as it was and the
// editor's owner is told to close it.
test('Escape cancels: nothing is saved, and the editor is asked to close', async () => {
  const onCommit = mock((_value: unknown) => {})
  const onCommitAway = mock((_value: unknown) => {})
  const onDiscard = mock(() => {})
  await open(onCommit, onCommitAway, onDiscard)
  const input = document.querySelector('input')!
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  await waitFor(() => (onDiscard.mock.calls.length ? true : undefined))
  expect(onDiscard.mock.calls).toHaveLength(1)
  expect(onCommit).not.toHaveBeenCalled()
  expect(onCommitAway).not.toHaveBeenCalled()
})

const name: FieldSpec = {
  key: 'name',
  label: 'Name',
  field_type: { kind: 'text' },
  required: false,
  system: false,
}

test('Escape in a text editor restores the value; Enter saves it', async () => {
  const onCommit = mock((_value: unknown, _move?: string) => {})
  const onDiscard = mock(() => {})
  const type = (input: HTMLInputElement, text: string) => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    set.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const key = (input: HTMLInputElement, which: string) =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: which, bubbles: true }),
    )

  const view = await render(
    <FieldEditor
      field={name}
      value="Noor"
      onCommit={onCommit}
      onDiscard={onDiscard}
    />,
  )
  const input = view.container.querySelector('input')!
  await act(async () => type(input, 'Noor Haddad'))
  await act(async () => key(input, 'Escape'))
  expect(onDiscard.mock.calls).toHaveLength(1)
  // The blur that follows a cancelled edit does not save it after all.
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
  expect(onCommit).not.toHaveBeenCalled()
  await cleanup()

  const again = await render(
    <FieldEditor
      field={name}
      value="Noor"
      onCommit={onCommit}
      onDiscard={onDiscard}
    />,
  )
  const second = again.container.querySelector('input')!
  await act(async () => type(second, 'Noor Haddad'))
  await act(async () => key(second, 'Enter'))
  expect(onCommit.mock.calls).toEqual([['Noor Haddad', 'down']])
})

// ── Clearing: on by default, off where a store cannot clear a field ─────────

const due: FieldSpec = {
  key: 'due',
  label: 'Due',
  field_type: { kind: 'date' },
  required: false,
  system: false,
}

const stage: FieldSpec = {
  key: 'stage',
  label: 'Stage',
  field_type: { kind: 'enum', variants: ['open', 'won'] },
  required: false,
  system: false,
}

const setText = (input: HTMLInputElement, text: string) => {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

const enter = (input: HTMLInputElement) =>
  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  )

const clearButton = (root: ParentNode) =>
  [...root.querySelectorAll('button')].find(
    (one) => one.textContent.trim() === 'Clear',
  )

test('where clearing is valid, an emptied text, a date and a select each save as cleared', async () => {
  const onCommit = mock((_value: unknown, _move?: string) => {})
  const text = await render(
    <FieldEditor
      field={name}
      value="Noor"
      onCommit={onCommit}
      onDiscard={() => {}}
    />,
  )
  const input = text.container.querySelector('input')!
  await act(async () => setText(input, '  '))
  await act(async () => enter(input))
  expect(onCommit.mock.calls).toEqual([[null, 'down']])
  await cleanup()

  const date = await render(
    <FieldEditor
      field={due}
      value="2026-11-22"
      onCommit={onCommit}
      onDiscard={() => {}}
    />,
  )
  await act(async () => clearButton(date.container)!.click())
  expect(onCommit.mock.calls.at(-1)?.[0]).toBeNull()
  await cleanup()

  const select = await render(
    <FieldEditor
      field={stage}
      value="open"
      onCommit={onCommit}
      onDiscard={() => {}}
    />,
  )
  await act(async () => clearButton(select.container)!.click())
  expect(onCommit.mock.calls.at(-1)?.[0]).toBeNull()
  expect(onCommit.mock.calls).toHaveLength(3)
})

test('clearable={false} offers no clear control and never commits null', async () => {
  const onCommit = mock((_value: unknown, _move?: string) => {})
  const onDiscard = mock(() => {})

  // An emptied text is refused in place, and says why.
  const text = await render(
    <FieldEditor
      field={name}
      value="Noor"
      clearable={false}
      onCommit={onCommit}
      onDiscard={onDiscard}
    />,
  )
  const input = text.container.querySelector('input')!
  await act(async () => setText(input, ''))
  await act(async () => enter(input))
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(input.placeholder).toBe('Cannot be emptied')
  // A value typed after that saves as usual.
  await act(async () => setText(input, 'Noor H'))
  await act(async () => enter(input))
  expect(onCommit.mock.calls).toEqual([['Noor H', 'down']])
  await cleanup()

  // Nothing was there and nothing was typed: it leaves without saving.
  const blank = await render(
    <FieldEditor
      field={name}
      value={undefined}
      clearable={false}
      onCommit={onCommit}
      onDiscard={onDiscard}
    />,
  )
  await act(async () => enter(blank.container.querySelector('input')!))
  expect(onDiscard.mock.calls).toHaveLength(1)
  await cleanup()

  // A date has no Clear, and an emptied one is refused.
  const date = await render(
    <FieldEditor
      field={due}
      value="2026-11-22"
      clearable={false}
      onCommit={onCommit}
      onDiscard={onDiscard}
    />,
  )
  expect(clearButton(date.container)).toBeUndefined()
  const day = date.container.querySelector('input')!
  await act(async () => setText(day, ''))
  await act(async () => enter(day))
  expect(day.getAttribute('aria-invalid')).toBe('true')
  expect(date.container.textContent).toContain('Cannot be emptied')
  await cleanup()

  // A select has no Clear either.
  const select = await render(
    <FieldEditor
      field={stage}
      value="open"
      clearable={false}
      onCommit={onCommit}
      onDiscard={onDiscard}
    />,
  )
  await waitFor(() =>
    select.container.querySelector('[role="option"]') ? true : undefined,
  )
  expect(clearButton(select.container)).toBeUndefined()

  expect(onCommit.mock.calls.map(([value]) => value)).not.toContain(null)
  expect(onCommit.mock.calls).toHaveLength(1)
})
