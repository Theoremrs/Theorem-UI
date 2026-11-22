import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import type { ReactNode } from 'react'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { UserMarkdown } from './user-markdown'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import { OpenDocumentProvider } from '@/components/crm/open-document'

afterEach(cleanup)

test('sent user documents render headings, lists, marks, code and hard breaks', async () => {
  const { container } = await render(
    <UserMarkdown
      text={
        '# Plan\n\nUse **bold**, *emphasis*, ~~old~~ and `code`.\n\n- First\n- Second\n\nFirst line\\\nSecond line\n\n```ts\nconst value = "literal"\n```'
      }
    />,
  )
  expect(container.querySelector('h1')?.textContent).toBe('Plan')
  expect(container.querySelector('strong')?.textContent).toBe('bold')
  expect(container.querySelector('em')?.textContent).toBe('emphasis')
  expect(container.querySelector('del')?.textContent).toBe('old')
  expect(
    [...container.querySelectorAll('li')].map((li) => li.textContent),
  ).toEqual(['First', 'Second'])
  expect(container.querySelector('p br')).not.toBeNull()
  expect(container.querySelector('pre code')?.textContent).toBe(
    'const value = "literal"\n',
  )
})

test('safe Markdown escapes display as literal text, not as raw backslashes or formatting', async () => {
  const { container } = await render(
    <UserMarkdown
      text={
        'Use \\*literal\\* and \\[brackets]\\(https://example.com), a\\_b, https\\://example.com.'
      }
    />,
  )
  expect(container.textContent).toBe(
    'Use *literal* and [brackets](https://example.com), a_b, https://example.com.',
  )
  expect(container.querySelector('em, strong')).toBeNull()
  expect(container.querySelector('a')?.textContent).not.toBe('brackets')
})

test('tool chips stay inside prose formatting and stay literal in code and links', async () => {
  const { container } = await render(
    <UserMarkdown
      text={
        '**Use :tool[recall]** and :tool[rustyweb_search].\n\n`:tool[inline]`\n\n```text\n:tool[fenced]\n```\n\n[:tool[linked]](https://example.com)'
      }
    />,
  )
  expect(
    [...container.querySelectorAll('[data-slot="directive-text-chip"]')].map(
      (chip) => chip.textContent,
    ),
  ).toEqual(['recall', 'rustyweb_search'])
  expect(
    container.querySelector('strong [data-directive-id="recall"]'),
  ).not.toBeNull()
  expect(container.querySelector('code')?.textContent).toBe(':tool[inline]')
  expect(container.querySelector('pre code')?.textContent).toBe(
    ':tool[fenced]\n',
  )
  expect(container.querySelector('a')?.textContent).toBe(':tool[linked]')
})

test('escaped directives and literal link syntax do not become chips', async () => {
  const { container } = await render(
    <UserMarkdown
      text={
        'Use :tool\\[literal], \\:tool[escaped], &#58;tool[entity], :tool[example]\\(https://example.com), then :tool[real].'
      }
    />,
  )
  expect(
    [...container.querySelectorAll('[data-slot="directive-text-chip"]')].map(
      (chip) => chip.textContent,
    ),
  ).toEqual(['real'])
  expect(container.textContent).toBe(
    'Use :tool[literal], :tool[escaped], :tool[entity], :tool[example](https://example.com), then real.',
  )
})

test('user Markdown does not execute HTML or automatically fetch embedded images', async () => {
  const { container } = await render(
    <UserMarkdown
      text={
        '<script>alert(1)</script>\n\n![diagram](https://example.com/image.png)\n\n[unsafe](javascript:alert(1))'
      }
    />,
  )
  expect(container.querySelector('script, img, iframe')).toBeNull()
  expect(container.textContent).toContain('<script>alert(1)</script>')
  expect(
    container.querySelector('a[href="https://example.com/image.png"]')
      ?.textContent,
  ).toBe('diagram')
  expect(container.querySelector('a[href^="javascript:"]')).toBeNull()
})

test('a skill named from the + menu shows as a chip by its title', async () => {
  const { container } = await render(
    <UserMarkdown text={'Please :skill[Document review]{name=pack-7} this, then :skill[tidy].'} />,
  )
  const chips = [...container.querySelectorAll('[data-slot="directive-text-chip"]')]
  expect(chips.map((chip) => chip.textContent)).toEqual(['Document review', 'tidy'])
  expect(chips[0]!.getAttribute('data-directive-id')).toBe('pack-7')
  expect(container.textContent).toContain('Please ')
  expect(container.textContent).not.toContain('{name=')
})

test('an @ pick reads as a chip of its title, naming what it cites', async () => {
  const { container } = await render(
    <UserMarkdown
      text={
        'Ask :record[Noor Haddad]{name=record:Person/person:noor} about :document[Notes on the kiln visit]{name=document:doc:kiln} and :record{label="Studio [east]" name="record:Place/place:east"}. `:record[code]`'
      }
    />,
  )
  const chips = [
    ...container.querySelectorAll('[data-slot="directive-text-chip"]'),
  ].map((chip) => [
    chip.textContent,
    chip.getAttribute('data-directive-type'),
    chip.getAttribute('data-directive-id'),
  ])
  expect(chips).toEqual([
    ['Noor Haddad', 'record', 'record:Person/person:noor'],
    ['Notes on the kiln visit', 'document', 'document:doc:kiln'],
    ['Studio [east]', 'record', 'record:Place/place:east'],
  ])
  expect(container.textContent).not.toContain('{name=')
  expect(container.querySelector('code')?.textContent).toBe(':record[code]')
})

test("a title's Markdown escapes stay out of its chip and the words after it stay", async () => {
  const { container } = await render(
    <UserMarkdown
      text={
        'Open :document[Road \\*map\\* \\_v2\\_]{name=document:doc:road} next, and :record{label="Studio \\[east] \\*b\\*" name="record:Place/place:east"} too.'
      }
    />,
  )
  const chips = [
    ...container.querySelectorAll('[data-slot="directive-text-chip"]'),
  ].map((chip) => [chip.textContent, chip.getAttribute('data-directive-id')])
  expect(chips).toEqual([
    ['Road *map* _v2_', 'document:doc:road'],
    ['Studio [east] *b*', 'record:Place/place:east'],
  ])
  expect(container.textContent).toBe(
    'Open Road *map* _v2_ next, and Studio [east] *b* too.',
  )
})

test('a directive whose own brackets, braces or quotes are escaped stays literal', async () => {
  const { container } = await render(
    <UserMarkdown
      text={
        'See :document[Notes]\\{name=document:doc:notes}, :record[Noor\\]{name=x}, :record{label=\\"Studio [east]" name="x"} and :document[Real]{name=document:doc:real}.'
      }
    />,
  )
  const chips = [
    ...container.querySelectorAll('[data-slot="directive-text-chip"]'),
  ].map((chip) => chip.textContent)
  expect(chips).toEqual(['Real'])
  expect(container.textContent).toContain(':document[Notes]{name=document:doc:notes}')
})

const PICKS =
  'Ask :record[Noor Haddad]{name=record:Person/person:noor} about :document[Notes on the kiln visit]{name=document:doc:kiln} with :tool[search] and :skill[tidy].'

async function inRouter(children: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => children }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  const view = await render(<RouterProvider router={router} />)
  await waitFor(() =>
    view.container.querySelector('[data-slot="directive-text-chip"]'),
  )
  return { ...view, router }
}

const chip = (container: ParentNode, label: string) =>
  [...container.querySelectorAll('[data-slot="directive-text-chip"]')].find(
    (found) => found.textContent === label,
  )!

test('an @ pick in a sent message opens the record or document it cites', async () => {
  const { container, router } = await inRouter(<UserMarkdown text={PICKS} />)
  const record = chip(container, 'Noor Haddad')
  const document = chip(container, 'Notes on the kiln visit')
  expect(record.tagName).toBe('A')
  expect(document.tagName).toBe('A')
  // A / tool or + skill names no item to open.
  expect(chip(container, 'search').tagName).toBe('SPAN')
  expect(chip(container, 'tidy').tagName).toBe('SPAN')
  expect(
    new URL(record.getAttribute('href')!, 'http://x').searchParams.get('item'),
  ).toBe('record:Person/person:noor')
  expect(
    new URL(document.getAttribute('href')!, 'http://x').searchParams.get(
      'item',
    ),
  ).toBe('doc:kiln')
  await act(async () => {
    record.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    )
  })
  await waitFor(() => router.state.location.pathname === '/index')
  expect(router.state.location.search).toMatchObject({
    item: 'record:Person/person:noor',
  })
})

test('a document pick opens where the surrounding inspector opens documents', async () => {
  const opened: string[] = []
  const { container } = await inRouter(
    <OpenDocumentProvider value={(id) => opened.push(id)}>
      <UserMarkdown text={PICKS} />
    </OpenDocumentProvider>,
  )
  const document = chip(container, 'Notes on the kiln visit')
  expect(document.tagName).toBe('BUTTON')
  await act(async () => {
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  expect(opened).toEqual(['doc:kiln'])
  // A record still opens in the Index.
  expect(chip(container, 'Noor Haddad').tagName).toBe('A')
})

test('with nowhere to open it, an @ pick stays a chip of text', async () => {
  const { container } = await render(<UserMarkdown text={PICKS} />)
  for (const label of ['Noor Haddad', 'Notes on the kiln visit'])
    expect(chip(container, label).tagName).toBe('SPAN')
})
