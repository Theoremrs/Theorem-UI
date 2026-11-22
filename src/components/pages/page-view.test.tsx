// SOURCING: bun:test over the page editor (page-view.tsx), rendered with
// React into happy-dom with test/workspace's render (a QueryClient) and its
// fake vault, which answers the SDK Files contract and sends its events.
// Puck draws the arrangement in this document; the title is typed through
// the input's own value setter and an input event, as React reads it.
import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import {
  cleanup,
  fakeWorkspace,
  render,
  waitFor,
} from '../../../test/workspace'
import { pageText, parsePage } from '@/lib/modules/contract'
import { pagesUnsaved, usePageDrafts } from '@/lib/modules/drafts'
import { newPage } from '@/lib/modules/layout'
import { patchPage, savePage } from '@/lib/pages/api'
import { stubPageOwner } from '../../../test/page-owner'
import { RECORDS_NOT_AFFECTED } from './page-history'
import { VaultPage } from './page-view'

const happyDom = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM

afterEach(() => {
  cleanup()
  usePageDrafts.setState({ drafts: {} })
})

const button = (container: HTMLElement, name: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.textContent.trim() === name,
  )

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// Review found three ways an unsaved arrangement was lost: leaving the page
// unmounted the editor that held it, and a rename or a revision of the file
// that does not parse replaced the editor with a loading or error state.
test('an unsaved arrangement outlives its view, a rename and a revision that does not parse', async () => {
  const fake = fakeWorkspace({
    'Pages/Desk.page.json': pageText(newPage('Desk')),
  })
  const [entry] = (await fake.client.tree()).filter(
    (e) => e.path === 'Pages/Desk.page.json',
  )
  const ui = <VaultPage client={fake.client} entryId={entry!.id} />
  const { container, queryClient, root } = await render(ui)
  const title = () => container.querySelector('h1')?.textContent

  act(() => button(container, 'Arrange')!.click())
  const input = await waitFor(() =>
    container.querySelector<HTMLInputElement>('input[aria-label="Page title"]'),
  )
  type(input, 'Reading desk')
  await waitFor(() => container.textContent.includes('Unsaved changes'))
  expect(pagesUnsaved()).toBe(true)

  // Another page, then this one again: the arrangement is still unsaved.
  const { QueryClientProvider } = await import('@tanstack/react-query')
  const show = (shown: boolean) =>
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          {shown ? ui : null}
        </QueryClientProvider>,
      ),
    )
  show(false)
  show(true)
  await waitFor(() => title() === 'Reading desk')
  expect(container.textContent).toContain('Unsaved changes')

  await act(() =>
    fake.client.rename('Pages/Desk.page.json', 'Pages/Study.page.json'),
  )
  await waitFor(() => !container.querySelector('[data-slot="skeleton"]'))
  expect(title()).toBe('Reading desk')
  expect(container.textContent).toContain('Unsaved changes')

  await fake.external('Pages/Study.page.json', 'not json')
  await waitFor(() =>
    container.textContent.includes(
      "The vault's copy changed and does not open",
    ),
  )
  expect(title()).toBe('Reading desk')

  // Saving over it asks first, and Keep mine writes the arrangement there.
  act(() => button(container, 'Save')!.click())
  await waitFor(() => button(container, 'Keep mine'))
  act(() => button(container, 'Keep mine')!.click())
  await waitFor(() => !button(container, 'Keep mine') && !pagesUnsaved())
  expect(container.textContent).not.toContain('Unsaved changes')
  expect(
    parsePage('Pages/Study.page.json', fake.text('Pages/Study.page.json')!)
      .title,
  ).toBe('Reading desk')
})

// Review found that an edit made while a save was on its way was cleared
// when the save came back.
test('an edit made while a save runs stays unsaved', async () => {
  const fake = fakeWorkspace({
    'Pages/Desk.page.json': pageText(newPage('Desk')),
  })
  const [entry] = (await fake.client.tree()).filter(
    (e) => e.path === 'Pages/Desk.page.json',
  )
  const write = fake.client.write
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  fake.client.write = async (...args) => {
    await held
    return write(...args)
  }
  const { container } = await render(
    <VaultPage client={fake.client} entryId={entry!.id} />,
  )
  act(() => button(container, 'Arrange')!.click())
  const input = await waitFor(() =>
    container.querySelector<HTMLInputElement>('input[aria-label="Page title"]'),
  )
  type(input, 'Reading')
  await waitFor(() => button(container, 'Save'))
  act(() => button(container, 'Save')!.click())
  type(input, 'Reading desk')
  await act(async () => release())
  await waitFor(() => fake.text('Pages/Desk.page.json')?.includes('"Reading"'))
  await act(() => Bun.sleep(20))
  expect(
    parsePage('Pages/Desk.page.json', fake.text('Pages/Desk.page.json')!).title,
  ).toBe('Reading')
  expect(input.value).toBe('Reading desk')
  expect(container.textContent).toContain('Unsaved changes')
  expect(pagesUnsaved()).toBe(true)
})

// Review found that a page saved and left before the save came back stayed
// unsaved: mutate's own callbacks do not run once the view is gone.
test('a page saved and left before the save returns is saved', async () => {
  const fake = fakeWorkspace({
    'Pages/Desk.page.json': pageText(newPage('Desk')),
  })
  const [entry] = (await fake.client.tree()).filter(
    (e) => e.path === 'Pages/Desk.page.json',
  )
  const write = fake.client.write
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  fake.client.write = async (...args) => {
    await held
    return write(...args)
  }
  const ui = <VaultPage client={fake.client} entryId={entry!.id} />
  const { container, queryClient, root } = await render(ui)
  act(() => button(container, 'Arrange')!.click())
  const input = await waitFor(() =>
    container.querySelector<HTMLInputElement>('input[aria-label="Page title"]'),
  )
  type(input, 'Reading desk')
  await waitFor(() => button(container, 'Save'))
  act(() => button(container, 'Save')!.click())
  const { QueryClientProvider } = await import('@tanstack/react-query')
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>{null}</QueryClientProvider>,
    ),
  )
  await act(async () => release())
  await waitFor(() =>
    fake.text('Pages/Desk.page.json')?.includes('Reading desk'),
  )
  await waitFor(() => !pagesUnsaved())
})

test('in the Theorem vault a pin is a patch, and an earlier version is previewed in place and restored as a new one', async () => {
  happyDom.setURL('http://localhost:3000/')
  const fake = fakeWorkspace({})
  const owner = stubPageOwner(fake)
  try {
    const path = 'Pages/Desk.page.json'
    const first = await savePage({ path, page: newPage('Desk') })
    await patchPage({
      path,
      expectedRevision: first.revision,
      ops: [{ op: 'set_title', title: 'Study' }],
    })
    const entry = (await fake.client.tree()).find((e) => e.path === path)!
    const { container } = await render(
      <VaultPage client={owner.client} entryId={entry.id} />,
    )
    const title = () => container.querySelector('h1')?.textContent
    await waitFor(() => title() === 'Study')

    const before = owner.calls.length
    act(() =>
      container.querySelector<HTMLButtonElement>('[aria-label="Pin"]')!.click(),
    )
    await waitFor(() => owner.calls.length > before)
    expect(owner.calls.at(-1)!.route).toBe('/patch')
    expect(owner.calls.at(-1)!.body!.ops).toEqual([
      { op: 'set_pinned', pinned: true },
    ])
    await waitFor(() => parsePage(path, fake.text(path)!).pinned)

    act(() => button(container, 'History')!.click())
    const body = document.body
    await waitFor(() => body.textContent.includes('Version 1'))
    expect(body.textContent).toContain(RECORDS_NOT_AFFECTED)
    expect(body.textContent).toContain('Version 3')
    const rows = [...body.querySelectorAll('li')]
    const oldest = rows.find((li) => li.textContent.includes('Version 1'))!
    act(() =>
      [...oldest.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === 'Preview')!
        .click(),
    )
    await waitFor(() => title() === 'Desk')
    expect(container.textContent).toContain('You are looking at version 1')
    expect(container.textContent).toContain(RECORDS_NOT_AFFECTED)
    // Nothing is written by looking.
    expect(parsePage(path, fake.text(path)!).title).toBe('Study')

    act(() => button(container, 'Restore this version')!.click())
    await waitFor(() => !button(container, 'Restore this version'))
    expect(owner.calls.at(-1)!.route).toBe('/restore')
    const restored = parsePage(path, fake.text(path)!)
    expect(restored).toEqual(newPage('Desk'))
    expect(title()).toBe('Desk')
    expect(container.textContent).not.toContain('Unsaved changes')
  } finally {
    owner.restore()
    happyDom.setURL('about:blank')
  }
})

test('the page history says when it did not open or keeps no version yet, and pages older versions in', async () => {
  happyDom.setURL('http://localhost:3000/')
  const fake = fakeWorkspace({})
  const owner = stubPageOwner(fake)
  const path = 'Pages/Desk.page.json'
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: {
        'content-type':
          status >= 400 ? 'application/problem+json' : 'application/json',
      },
    })
  // The history route answers as each step needs; every other route is the stub's.
  let answer: 'refuse' | 'empty' | 'paged' = 'refuse'
  const served = window.fetch
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (!url.pathname.endsWith('/history')) return served(input, init)
    if (answer === 'refuse')
      return json(
        { title: 'Unavailable', status: 503, detail: 'The vault is offline.' },
        503,
      )
    if (answer === 'empty') return json({ path, revisions: [] })
    const all = (await (await served(input, init)).json()) as {
      revisions: unknown[]
    }
    return json(
      url.searchParams.has('cursor')
        ? { path, revisions: all.revisions.slice(1) }
        : { path, revisions: all.revisions.slice(0, 1), nextCursor: 1 },
    )
  }) as typeof fetch
  try {
    const first = await savePage({ path, page: newPage('Desk') })
    await patchPage({
      path,
      expectedRevision: first.revision,
      ops: [{ op: 'set_title', title: 'Study' }],
    })
    const entry = (await fake.client.tree()).find((e) => e.path === path)!
    const body = document.body
    const openHistory = async () => {
      const { container } = await render(
        <VaultPage client={owner.client} entryId={entry.id} />,
      )
      await waitFor(
        () => container.querySelector('h1')?.textContent === 'Study',
      )
      act(() => button(container, 'History')!.click())
    }

    await openHistory()
    await waitFor(() => body.textContent.includes('The history did not open'))
    // The refusal is said as the client read it: its status, then its body.
    const refusal = [...body.querySelectorAll('[role="alert"]')].find((one) =>
      one.textContent.startsWith('The history did not open'),
    )!
    expect(refusal.textContent).toStartWith(
      'The history did not open: Theorem answered 503\nStatus code: 503',
    )
    expect(refusal.textContent).toContain('The vault is offline.')
    expect(body.querySelector('[aria-label="Versions"]')).toBeNull()
    cleanup()

    answer = 'empty'
    await openHistory()
    await waitFor(() =>
      body.textContent.includes(
        'No versions are kept for this page yet. The next save starts its history.',
      ),
    )
    expect(button(body, 'Show older versions')).toBeUndefined()
    cleanup()

    answer = 'paged'
    await openHistory()
    await waitFor(() => body.textContent.includes('Version 2'))
    expect(body.textContent).not.toContain('Version 1')
    act(() => button(body, 'Show older versions')!.click())
    await waitFor(() => body.textContent.includes('Version 1'))
    expect(button(body, 'Show older versions')).toBeUndefined()
    // The version on screen says so and offers no preview; an older one offers one.
    const row = (seq: number) =>
      [...body.querySelectorAll('li')].find((li) =>
        li.textContent.includes(`Version ${seq}`),
      )!
    expect(row(2).textContent).toContain('On screen')
    expect(button(row(2), 'Preview')).toBeUndefined()
    expect(row(1).textContent).not.toContain('On screen')
    expect(button(row(1), 'Preview')).toBeTruthy()
  } finally {
    owner.restore()
    happyDom.setURL('about:blank')
  }
})

test('a previewed version that does not open says so, a refused restore says why, and one over a changed page offers the vault’s first', async () => {
  happyDom.setURL('http://localhost:3000/')
  const fake = fakeWorkspace({})
  const owner = stubPageOwner(fake)
  const path = 'Pages/Desk.page.json'
  // The routes named here are refused in turn; every other call is the stub's.
  const refused = new Set<string>()
  const served = window.fetch
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const route = [...refused].find((one) => url.pathname.endsWith(one))
    if (!route) return served(input, init)
    return new Response(
      JSON.stringify({
        title: 'Unavailable',
        status: 503,
        detail: `The ${route} route is down.`,
      }),
      { status: 503, headers: { 'content-type': 'application/problem+json' } },
    )
  }) as typeof fetch
  try {
    const first = await savePage({ path, page: newPage('Desk') })
    await patchPage({
      path,
      expectedRevision: first.revision,
      ops: [{ op: 'set_title', title: 'Study' }],
    })
    const entry = (await fake.client.tree()).find((e) => e.path === path)!
    const { container } = await render(
      <VaultPage client={owner.client} entryId={entry.id} />,
    )
    const title = () => container.querySelector('h1')?.textContent
    await waitFor(() => title() === 'Study')
    const body = document.body
    const bar = () =>
      container.querySelector('[aria-label="Previewing an earlier version"]')
    const alerts = () =>
      [...container.querySelectorAll('[role="alert"]')].map(
        (one) => one.textContent,
      )
    const preview = async (seq: number) => {
      act(() => button(container, 'History')!.click())
      await waitFor(() => body.textContent.includes(`Version ${seq}`))
      const row = [...body.querySelectorAll('li')].find((li) =>
        li.textContent.includes(`Version ${seq}`),
      )!
      act(() => button(row, 'Preview')!.click())
      await waitFor(() => bar())
    }

    // A version that does not open says so, with the way back beside it.
    refused.add('/revision')
    await preview(1)
    await waitFor(() =>
      container.textContent.includes('This version did not open'),
    )
    expect(container.textContent).toContain('The /revision route is down.')
    // The heading falls back to the page's own title while no version is read.
    expect(title()).toBe('Study')
    act(() => button(container, 'Back to the current version')!.click())
    await waitFor(() => title() === 'Study' && !bar())
    refused.delete('/revision')

    // A restore the owner refuses says why, and nothing is written.
    refused.add('/restore')
    await preview(1)
    await waitFor(() => title() === 'Desk')
    act(() => button(container, 'Restore this version')!.click())
    await waitFor(() =>
      alerts().some((one) => one.startsWith('It was not restored')),
    )
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0]).toStartWith('It was not restored: Theorem answered 503')
    expect(alerts()[0]).toContain('The /restore route is down.')
    expect(parsePage(path, fake.text(path)!).title).toBe('Study')
    refused.delete('/restore')

    // The page changed in the vault since it was opened: the restore is a
    // conflict, never an overwrite. The vault's is taken, then it goes through.
    await act(() =>
      fake.external(path, pageText({ ...newPage('Desk'), title: 'Hall' })),
    )
    act(() => button(container, 'Restore this version')!.click())
    await waitFor(() => button(container, 'Use the vault’s'))
    // The conflict is said instead of the refusal the last restore met.
    expect(alerts()).toEqual([
      'This page changed in the vault since you opened it. Use the vault’s version, then restore again.',
    ])
    expect(button(container, 'Restore this version')).toBeUndefined()
    expect(parsePage(path, fake.text(path)!).title).toBe('Hall')
    act(() => button(container, 'Use the vault’s')!.click())
    await waitFor(() => button(container, 'Restore this version'))
    // As it stands, the conflict's own error is then shown as the refusal
    // until the next restore is asked for.
    expect(alerts()).toEqual([
      'It was not restored: Pages/Desk.page.json changed on disk',
    ])
    act(() => button(container, 'Restore this version')!.click())
    await waitFor(() => !bar())
    expect(parsePage(path, fake.text(path)!)).toEqual(newPage('Desk'))
    expect(title()).toBe('Desk')

    // While the page has unsaved changes a version can be looked at, not restored.
    act(() => button(container, 'Arrange')!.click())
    const input = await waitFor(() =>
      container.querySelector<HTMLInputElement>(
        'input[aria-label="Page title"]',
      ),
    )
    type(input, 'Reading desk')
    act(() => button(container, 'Done')!.click())
    await waitFor(() => container.textContent.includes('Unsaved changes'))
    await preview(2)
    expect(container.textContent).toContain(
      'Save or discard your changes to this page first.',
    )
    expect(button(container, 'Restore this version')!.disabled).toBe(true)
  } finally {
    owner.restore()
    happyDom.setURL('about:blank')
  }
})
