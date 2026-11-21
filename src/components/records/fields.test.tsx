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
