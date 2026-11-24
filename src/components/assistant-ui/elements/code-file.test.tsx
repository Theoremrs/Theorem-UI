import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { CodeBlock } from '@/components/ui/code-block'
import { CodeFile } from './code-file'
import { SyntaxHighlighter } from './shiki-highlighter'
import { cleanup, click, render, waitFor } from '../../../../test/blocks/render'

afterEach(cleanup)

test('a fence that names its file reads as a breadcrumb over numbered, highlighted rows', async () => {
  const { container } = await render(
    <CodeFile code={'const a = 1\n  const b = 2'} language="ts:src/lib/a.ts" />,
  )
  const block = container.querySelector('figure[data-code-block]')!
  expect(block.querySelector('figcaption')?.textContent).toBe('src/lib/a.ts')
  expect(block.querySelector('button[aria-label="Copy code"]')).not.toBeNull()
  await waitFor(() => block.querySelector('pre.shiki'))
  const rows = [...block.querySelectorAll('.line')]
  expect(rows.map((row) => row.getAttribute('data-line'))).toEqual(['1', '2'])
  expect((rows[1] as HTMLElement).style.getPropertyValue('--indent')).toBe(
    '2ch',
  )
  expect(block.querySelector('pre')?.textContent).toBe(
    'const a = 1\n  const b = 2',
  )
  expect(block.querySelector('.space, .tab') === null).toBe(true)
})

test('streaming and highlighted code preserve tabs, spaces, source copy, and keyboard access', async () => {
  const code = '\tconst value = "two words"  \n    return value\n'
  const { container, rerender } = await render(
    <CodeFile code={code} language="ts" streaming />,
  )
  const viewport = container.querySelector<HTMLElement>(
    '[role="region"][aria-label="Code"]',
  )!
  expect(viewport.tabIndex).toBe(0)
  expect(container.querySelector('pre')?.textContent).toBe(code.trimEnd())
  expect(
    container
      .querySelector<HTMLElement>('.line')
      ?.style.getPropertyValue('--indent'),
  ).toBe('4ch')
  expect(container.querySelector('.space, .tab') === null).toBe(true)

  await rerender(<CodeFile code={code} language="ts" />)
  await waitFor(() => container.querySelector('pre.shiki'))
  expect(container.querySelector('pre')?.textContent).toBe(code.trimEnd())
  expect(container.querySelector('.space, .tab') === null).toBe(true)
  await click(container.querySelector('button[aria-label="Copy code"]')!)
  expect(await navigator.clipboard.readText()).toBe(code)
})

test('a diff shows its file with the changed rows marked and copies the diff as written', async () => {
  const diff = '--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n-a = 1\n+a = 2\n b = 3'
  const { container } = await render(
    <CodeFile code={diff} language="diff" streaming />,
  )
  expect(container.querySelector('figcaption')?.textContent).toBe('x.py')
  const rows = [...container.querySelectorAll('.line')]
  expect(rows.map((row) => row.getAttribute('data-change'))).toEqual([
    'hunk',
    'remove',
    'add',
    null,
  ])
  expect(rows.map((row) => row.getAttribute('data-line'))).toEqual([
    null,
    null,
    '1',
    '2',
  ])
  await click(container.querySelector('button[aria-label="Copy code"]')!)
  expect(await navigator.clipboard.readText()).toBe(diff)
})

test('a multi-file diff keeps both files and does not label the whole patch as its last file', async () => {
  const diff = [
    'diff --git a/first.ts b/first.ts',
    '--- a/first.ts',
    '+++ b/first.ts',
    '@@ -1 +1 @@',
    '-const first = 1',
    '+const first = 2',
    'diff --git a/second.ts b/second.ts',
    '--- a/second.ts',
    '+++ b/second.ts',
    '@@ -1 +1 @@',
    '-const second = 1',
    '+const second = 2',
  ].join('\n')
  const { container } = await render(
    <CodeFile code={diff} language="diff" streaming />,
  )
  expect(container.querySelector('figcaption')?.textContent).toBe('diff')
  expect(container.querySelector('pre')?.textContent).toBe(diff)
  await click(container.querySelector('button[aria-label="Copy code"]')!)
  expect(await navigator.clipboard.readText()).toBe(diff)
})

test('a collapsed block measures complete wrapped source lines again when the pre resizes', async () => {
  const NativeResizeObserver = globalThis.ResizeObserver
  let callback: ResizeObserverCallback = () => {}
  const observed = new Set<Element>()
  let disconnected = false
  globalThis.ResizeObserver = class {
    constructor(onResize: ResizeObserverCallback) {
      callback = onResize
    }
    observe(target: Element) {
      observed.add(target)
    }
    unobserve(target: Element) {
      observed.delete(target)
    }
    disconnect() {
      observed.clear()
      disconnected = true
    }
  }
  try {
    const { container } = await render(
      <CodeBlock title="wrapped.ts" maxCollapsedLines={2}>
        <pre
          style={{
            lineHeight: '21px',
            paddingBlockStart: '10px',
            paddingBlockEnd: '10px',
          }}
        >
          <code>
            <span className="line">a long first source line</span>
            {'\n'}
            <span className="line">second</span>
            {'\n'}
            <span className="line">third</span>
          </code>
        </pre>
      </CodeBlock>,
    )
    const pre = container.querySelector('pre')!
    const viewport = container.querySelector<HTMLElement>('[role="region"]')!
    const rows = [...pre.querySelectorAll('.line')]
    const boxes = [
      new DOMRect(0, 10, 300, 42),
      new DOMRect(0, 52, 300, 21),
      new DOMRect(0, 73, 300, 21),
    ]
    rows.forEach((row, index) => {
      Object.defineProperty(row, 'getBoundingClientRect', {
        value: () => boxes[index]!,
      })
    })
    expect(observed.has(pre)).toBe(true)
    expect(observed.has(viewport)).toBe(false)
    await act(() => callback([], {} as ResizeObserver))
    // Two logical lines occupy three visual rows, plus 20px block padding.
    expect(viewport.style.maxHeight).toBe('83px')

    boxes[0] = new DOMRect(0, 10, 200, 63)
    boxes[1] = new DOMRect(0, 73, 200, 21)
    boxes[2] = new DOMRect(0, 94, 200, 21)
    await act(() => callback([], {} as ResizeObserver))
    expect(viewport.style.maxHeight).toBe('104px')
    const toggle = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Show all 3 lines',
    )!
    await click(toggle)
    expect(viewport.style.maxHeight).toBe('')
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    await cleanup()
    expect(disconnected).toBe(true)
    expect(observed.size).toBe(0)
  } finally {
    await cleanup()
    globalThis.ResizeObserver = NativeResizeObserver
  }
})

test('a block without numbers leaves the gutter empty', async () => {
  const { container } = await render(
    <CodeFile code="done" title="output" lineNumbers={false} streaming />,
  )
  expect(container.querySelector('figcaption')?.textContent).toBe('output')
  expect(container.querySelector('pre[data-line-numbers]')).toBeNull()
  expect(container.querySelector('.line[data-line]')).toBeNull()
})

test('standalone highlighting keeps leading blank lines and their numbers', async () => {
  const { container, rerender } = await render(
    <SyntaxHighlighter code={'\n\nconst a = 1'} language="ts" streaming />,
  )
  expect(container.querySelector('pre')?.textContent).toBe('\n\nconst a = 1')
  expect(
    [...container.querySelectorAll('.line')].map((row) =>
      row.getAttribute('data-line'),
    ),
  ).toEqual(['1', '2', '3'])
  await rerender(
    <SyntaxHighlighter code={'const a = 1\n\n'} language="ts" streaming />,
  )
  expect(container.querySelector('pre')?.textContent).toBe('const a = 1')
})

test('a Windows path reads as a breadcrumb with its folders apart', async () => {
  const { container } = await render(
    <CodeFile
      code="const a = 1"
      language="ts:C:\\workspace\\project\\src\\example.ts"
      streaming
    />,
  )
  expect(container.querySelector('figcaption')?.textContent).toBe(
    'C:/workspace/project/src/example.ts',
  )
})

test('TypeScript keeps its highlighting after an arrow, which `v`-flag patterns lose on JavaScriptCore', async () => {
  const { container } = await render(
    <CodeFile
      code="export const header = (line: string): string[] => fields(line, { strict: true })"
      language="ts"
    />,
  )
  await waitFor(() => container.querySelector('pre.shiki'))
  const colourOf = (text: string) =>
    [...container.querySelectorAll<HTMLElement>('.line span')].find(
      (span) => span.textContent.trim() === text,
    )?.style.color
  expect(colourOf('fields')).toBeTruthy()
  expect(colourOf('true')).toBeTruthy()
  expect(colourOf('fields')).not.toBe(colourOf('line'))
})
