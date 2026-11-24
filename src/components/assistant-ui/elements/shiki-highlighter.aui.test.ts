import { expect, test } from 'bun:test'
import { sameHighlighterProps } from './shiki-highlighter.aui'
import type { HighlighterProps } from './shiki-highlighter.aui'

const fence = (over: Partial<HighlighterProps> = {}): HighlighterProps => ({
  code: 'const a = 1',
  language: 'ts',
  ...over,
})

const nodeWith = (meta: string | undefined) =>
  ({ data: { meta } }) as HighlighterProps['node']

test('a new node identity with the same fence meta still reads as the same block', () => {
  expect(
    sameHighlighterProps(
      fence({ node: nodeWith('title="a.ts"') }),
      fence({ node: nodeWith('title="a.ts"') }),
    ),
  ).toBe(true)
})

test('a changed fence meta reads as a different block', () => {
  expect(
    sameHighlighterProps(
      fence({ node: nodeWith('title="a.ts"') }),
      fence({ node: nodeWith('title="b.ts"') }),
    ),
  ).toBe(false)
})

test('every forwarded rendering prop takes part in the comparison', () => {
  const base = fence()
  expect(sameHighlighterProps(base, fence())).toBe(true)
  expect(sameHighlighterProps(base, fence({ code: 'const b = 2' }))).toBe(false)
  expect(sameHighlighterProps(base, fence({ language: 'rs' }))).toBe(false)
  expect(sameHighlighterProps(base, fence({ title: 'src/a.ts' }))).toBe(false)
  expect(sameHighlighterProps(base, fence({ lineNumbers: false }))).toBe(false)
  expect(sameHighlighterProps(base, fence({ maxCollapsedLines: 3 }))).toBe(false)
  expect(sameHighlighterProps(base, fence({ className: 'wide' }))).toBe(false)
  expect(
    sameHighlighterProps(base, fence({ viewportClassName: 'max-h-96' })),
  ).toBe(false)
})
