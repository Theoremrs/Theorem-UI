import { afterEach, expect, test } from 'bun:test'
import { act, useState } from 'react'
import { buttonNamed, cleanup, click, render } from '../../../test/blocks/render'
import { InlineArtifact } from './inline-artifact'
import { askAbout, useComposerReferences } from '@/components/chat/composer-references'
import { pinnedAppReference } from '@/lib/theorem/app-references'

afterEach(cleanup)
afterEach(() => { useComposerReferences.getState().take() })

function Counter() {
  const [value, setValue] = useState(0)
  return <button onClick={() => setValue((n) => n + 1)}>Value {value}</button>
}

test('an arriving live artifact leaves focus in the composer and is immediately usable', async () => {
  const composer = document.createElement('textarea')
  document.body.append(composer)
  composer.focus()
  try {
    const { container } = await render(
      <InlineArtifact title="Custom control"><Counter /></InlineArtifact>,
    )
    expect(document.activeElement).toBe(composer)
    expect(container.querySelector('dialog')?.open).toBe(true)
    expect(container.querySelector('[inert]')).toBeNull()
    await click(buttonNamed(container, 'Value 0')!)
    expect(buttonNamed(container, 'Value 1')).toBeDefined()
  } finally {
    composer.remove()
  }
})

test('expansion, streamed rerenders, and Escape preserve the authored component and its state', async () => {
  const view = (title: string) => (
    <InlineArtifact title={title}><Counter /><iframe title="Authored frame" /></InlineArtifact>
  )
  const { container, rerender } = await render(view('Custom control'))
  const dialog = container.querySelector('dialog')!
  const frame = container.querySelector('iframe')!
  await click(buttonNamed(container, 'Value 0')!)
  await click(buttonNamed(container, 'Expand')!)
  expect(dialog.dataset.layout).toBe('full')
  expect(buttonNamed(container, 'Collapse')?.getAttribute('aria-expanded')).toBe('true')
  await rerender(view('Updated answer title'))
  expect(dialog.getAttribute('aria-label')).toBe('Updated answer title')
  expect(buttonNamed(container, 'Value 1')).toBeDefined()
  expect(container.querySelector('iframe')).toBe(frame)

  const cancel = new Event('cancel', { cancelable: true })
  await act(() => { dialog.dispatchEvent(cancel) })
  expect(cancel.defaultPrevented).toBe(true)
  expect(dialog.open).toBe(true)
  expect(dialog.dataset.layout).toBe('inline')
  expect(document.activeElement).toBe(buttonNamed(container, 'Expand'))
  expect(buttonNamed(container, 'Value 1')).toBeDefined()
  expect(container.querySelector('iframe')).toBe(frame)

  await click(buttonNamed(container, 'Expand')!)
  await click(buttonNamed(container, 'Collapse')!)
  expect(buttonNamed(container, 'Value 1')).toBeDefined()
  expect(container.querySelector('iframe')).toBe(frame)
})

test('Ask from an expanded artifact collapses before focusing the composer', async () => {
  const composer = document.createElement('div')
  composer.className = 'aui-composer-input'
  const input = document.createElement('div')
  input.className = 'ProseMirror'
  input.tabIndex = 0
  Object.defineProperty(input, 'checkVisibility', { value: () => true })
  composer.append(input)
  document.body.append(composer)
  try {
    const { container } = await render(
      <InlineArtifact title="Custom control" artifactId="custom" partId="part-1" current>
        <Counter />
        <button onClick={() => askAbout(pinnedAppReference({ documentId: 'custom', title: 'Custom control', position: '1' }))}>Ask</button>
      </InlineArtifact>,
    )
    const dialog = container.querySelector('dialog')!
    expect(dialog.getAttribute('data-face-thing')).toBe('artifact:custom')
    expect(buttonNamed(container, 'Expand')?.hasAttribute('data-face-opens')).toBe(true)
    await click(buttonNamed(container, 'Value 0')!)
    await click(buttonNamed(container, 'Expand')!)
    await click(buttonNamed(container, 'Ask')!)
    expect(dialog.dataset.layout).toBe('inline')
    expect(dialog.open).toBe(true)
    expect(buttonNamed(container, 'Value 1')).toBeDefined()
    expect(useComposerReferences.getState().references).toHaveLength(1)
    expect(document.activeElement).toBe(input)
  } finally {
    composer.remove()
  }
})
