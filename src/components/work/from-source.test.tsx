// SOURCING: bun:test over `theorem.work.create-from` (./from-source) through the shared command registry, with the dialog it opens rendered into happy-dom (test/workspace's render) against a fake WorkSource that records what it was asked to create.
import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { executeCommand } from '@/lib/commands/registry'
import { live } from '@/lib/resources/types'
import { cleanup, render, waitFor } from '../../../test/workspace'
import type { NewWorkItem } from './contract'
import { fakeSource, item } from './fixtures'
import {
  CREATE_FROM_COMMAND,
  WorkFromSourceHost,
  registerWorkFromSource,
} from './from-source'
import { WorkSourceProvider } from './source'

let unregister: (() => void) | undefined
afterEach(() => {
  unregister?.()
  unregister = undefined
  cleanup()
})

const run = (ref: unknown) =>
  executeCommand(
    CREATE_FROM_COMMAND,
    { ref },
    { focus: 'none', path: '/' },
    'menu',
  )

test('the command opens the dialog, and the item is created with its source as a reference only', async () => {
  unregister = registerWorkFromSource()
  const asked: NewWorkItem[] = []
  const source = fakeSource({
    createItem: async (input) => {
      asked.push(input)
      return item('new', { title: input.title })
    },
  })
  await render(
    <WorkSourceProvider source={source}>
      <WorkFromSourceHost />
    </WorkSourceProvider>,
  )
  expect(document.querySelector('[placeholder="Title"]')).toBeNull()

  const ref = live({ kind: 'thread', threadId: 't1' })
  expect((await run(ref)).ok).toBe(true)
  await waitFor(() => document.querySelector('[placeholder="Title"]') !== null)
  expect(document.body.textContent).toContain('Made from')

  const title = document.querySelector<HTMLInputElement>(
    '[placeholder="Title"]',
  )!
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    set.call(title, 'Follow up')
    title.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    title.form!.requestSubmit()
  })
  await waitFor(() => asked.length === 1)
  expect(asked[0]!.title).toBe('Follow up')
  expect(asked[0]!.source).toEqual({
    resource: { kind: 'conversation', threadId: 't1' },
  })
})

test('an item is not made from another item, nor from a source the wire cannot name', async () => {
  unregister = registerWorkFromSource()
  const itself = await run(live({ kind: 'work-item', itemId: 'wi_1' }))
  expect(itself.ok).toBe(false)
  const unnamed = await run(
    live({ kind: 'extension', extensionKind: 'acme.ticket', id: '1' }),
  )
  expect(unnamed.ok).toBe(false)
  expect((await run({ nope: true })).ok).toBe(false)
})
