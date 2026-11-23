import { afterEach, expect, test } from 'bun:test'
import { CodeFile } from './code-file'
import { cleanup, render, waitFor } from '../../../../test/blocks/render'

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
  expect((rows[1] as HTMLElement).style.getPropertyValue('--indent')).toBe('2ch')
  expect(block.querySelectorAll('.line .space').length).toBeGreaterThan(0)
})

test('a diff shows its file with the changed rows marked and copies the diff as written', async () => {
  const diff = '--- a/x.py\n+++ b/x.py\n@@ -1,2 +1,2 @@\n-a = 1\n+a = 2\n b = 3'
  const { container } = await render(<CodeFile code={diff} language="diff" streaming />)
  expect(container.querySelector('figcaption')?.textContent).toBe('x.py')
  const rows = [...container.querySelectorAll('.line')]
  expect(rows.map((row) => row.getAttribute('data-change'))).toEqual([
    'hunk',
    'remove',
    'add',
    null,
  ])
  expect(rows.map((row) => row.getAttribute('data-line'))).toEqual([null, null, '1', '2'])
})

test('a block without numbers leaves the gutter empty', async () => {
  const { container } = await render(
    <CodeFile code="done" title="output" lineNumbers={false} streaming />,
  )
  expect(container.querySelector('figcaption')?.textContent).toBe('output')
  expect(container.querySelector('pre[data-line-numbers]')).toBeNull()
  expect(container.querySelector('.line[data-line]')).toBeNull()
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
      (span) => span.textContent === text,
    )?.style.color
  expect(colourOf('fields')).toBeTruthy()
  expect(colourOf('true')).toBeTruthy()
  expect(colourOf('fields')).not.toBe(colourOf('line'))
})
