import { afterEach, expect, test } from 'bun:test'
import { SyntaxHighlighter } from './code-highlighter'
import { cleanup, render, waitFor } from '../../../../test/blocks/render'

afterEach(cleanup)

const source = 'const answer = 42\n// the reason\nreturn answer'

test('numbers each line and colours its tokens once the languages load', async () => {
  const { container } = await render(
    <SyntaxHighlighter code={source} language="typescript" />,
  )
  await waitFor(() => container.querySelector('.th-keyword'))
  const pre = container.querySelector('pre.th-code')!
  expect(pre.classList.contains('th-code--line-numbers')).toBe(true)
  expect(pre.getAttribute('data-language')).toBe('ts')
  const lines = [...container.querySelectorAll('.th-line')]
  expect(lines.map((line) => line.getAttribute('data-line'))).toEqual(['1', '2', '3'])
  expect(container.querySelector('.th-comment')?.textContent).toBe('// the reason')
  expect(pre.textContent).toBe(source)
})

test('streams as plain lines in the same pre, and a language it lacks reads as text', async () => {
  const { container, rerender } = await render(
    <SyntaxHighlighter code={source} language="typescript" streaming />,
  )
  expect(container.querySelectorAll('.th-line')).toHaveLength(3)
  expect(container.querySelector('.th-keyword')).toBeNull()
  await rerender(
    <SyntaxHighlighter code="plain words" language="no-such-language" lineNumbers={false} />,
  )
  await waitFor(() => container.querySelector('pre[data-language="plaintext"]'))
  expect(container.querySelector('.th-code--line-numbers')).toBeNull()
})
