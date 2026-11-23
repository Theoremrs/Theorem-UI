import { afterEach, expect, test } from 'bun:test'
import { GlassCodeBlock } from './glass-code-block'
import { cleanup, render, waitFor } from '../../../../test/blocks/render'

afterEach(cleanup)

test('frames numbered code under a chrome row titled by its language, with copy and no window lights', async () => {
  const { container } = await render(
    <GlassCodeBlock code={'const a = 1\nconst b = 2'} language="typescript" />,
  )
  await waitFor(() => container.querySelector('.th-keyword'))
  const frame = container.querySelector('figure[data-glass-code]')!
  expect(frame.querySelector('figcaption')?.textContent).toBe('typescript')
  expect(frame.querySelectorAll('span.rounded-full')).toHaveLength(0)
  expect(frame.querySelector('button[aria-label="Copy code"]')).not.toBeNull()
  const block = frame.querySelector('.aui-code-block')!
  expect(block.getAttribute('data-code-surface')).toBe('glass')
  expect(block.querySelectorAll('.th-line')).toHaveLength(2)
})

test('a title stands in for the language', async () => {
  const { container } = await render(
    <GlassCodeBlock code="done" language="text" title="output" lineNumbers={false} />,
  )
  expect(container.querySelector('figcaption')?.textContent).toBe('output')
  expect(container.querySelector('.th-code--line-numbers')).toBeNull()
})
