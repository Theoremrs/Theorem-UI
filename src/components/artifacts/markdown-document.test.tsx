import { afterEach, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, click, render, waitFor } from '../../../test/blocks/render'
import { MarkdownDocument } from './artifact-renderers'

afterEach(cleanup)

const FENCE = '```'
const code = 'const value = 1\n'
const documentWithFence = (info: string, source = code) =>
  `${FENCE}${info}\n${source}${FENCE}`

test.each([
  ['ts:src/lib/a.ts', 'src/lib/a.ts'],
  ['ts title="src/lib/file with spaces.ts"', 'src/lib/file with spaces.ts'],
  ['ts:old.ts filename="src/new.ts"', 'src/new.ts'],
])(
  'document fence %s preserves its filename through CodeFile',
  async (info, title) => {
    const { container } = await render(
      <MarkdownDocument content={documentWithFence(info)} />,
    )
    expect(container.querySelector('figcaption')?.textContent).toBe(title)
    await waitFor(() => container.querySelector('pre.shiki'))
    expect(container.querySelector('pre')?.textContent).toBe(code.trimEnd())
    await click(container.querySelector('button[aria-label="Copy code"]')!)
    expect(await navigator.clipboard.readText()).toBe(code)
  },
)

test('a document Mermaid fence keeps its diagram renderer and has no CodeFile header', () => {
  // Static rendering verifies routing without happy-dom's incomplete mutable
  // CSSStyleRule API, which Mermaid's browser stylesheet effect requires.
  const markup = renderToStaticMarkup(
    <MarkdownDocument
      content={documentWithFence(
        'mermaid title="Flow"',
        'graph TD\n  A --> B\n',
      )}
    />,
  )
  expect(markup).toMatch(/data-slot="mermaid-(?:skeleton|diagram)"/)
  expect(markup).not.toContain('data-code-block')
  expect(markup).not.toContain('<figcaption')
})
