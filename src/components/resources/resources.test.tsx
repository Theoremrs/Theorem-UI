// SOURCING: bun:test over the shared resource components (this folder) mounted with React into happy-dom through test/blocks/render, against in-memory providers. No network and no Theorem.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cleanup, render, waitFor } from '../../../test/blocks/render'
import { useContributions } from '@/lib/contributions/registry'
import {
  registerProvider,
  useResourceProviders,
} from '@/lib/resources/registry'
import type {
  ReferenceOccurrence,
  ResourceProvider,
  SearchPage,
} from '@/lib/resources/provider'
import type { ResourceRef } from '@/lib/resources/types'
import { Embed, EmbedRoot } from './embed'
import { ReferencesPanel } from './references-panel'
import { ResourceChip, chipLabel } from './resource-chip'
import { ResourcePicker } from './resource-picker'
import { ResourcePreview } from './resource-preview'

beforeEach(() => {
  useResourceProviders.setState({ providers: new Map() })
  useContributions.setState({ contributions: new Map(), conflicts: [] })
})
afterEach(async () => {
  await cleanup()
})

const ticket = (id: string): ResourceRef => ({
  resource: { kind: 'extension', extensionKind: 'acme.ticket', id },
  hint: { label: 'Fix the kiln' },
  revision: { mode: 'live' },
})

const provider = (over: Partial<ResourceProvider>): ResourceProvider => ({
  id: 'acme.tickets',
  label: 'Tickets',
  serves: ['acme.ticket'],
  support: {},
  ...over,
})

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 20))
  })

describe('chip', () => {
  test('shows the hint only while asking, and never after the owner says it is unavailable', async () => {
    let access: 'ready' | 'inaccessible' = 'ready'
    let changed: (() => void) | undefined
    let calls = 0
    // Only the first answer is slow, so the first paint is still asking.
    const slow = () =>
      calls++ === 0 ? new Promise((r) => setTimeout(r, 40)) : undefined
    registerProvider(
      provider({
        support: { resolve: true, changes: true },
        resolve: async () => {
          await slow()
          return access === 'ready'
            ? {
                state: 'ready',
                meta: {
                  title: 'Fix the kiln (verified)',
                  typeLabel: 'Ticket',
                  actions: ['open'],
                },
              }
            : { state: 'inaccessible' }
        },
        subscribe: (_r, onChange) => {
          changed = onChange
          return () => {}
        },
      }),
    )
    const { container } = await render(
      <ResourceChip resourceRef={ticket('1')} />,
    )
    // First paint: the hint, marked as not yet checked.
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(container.textContent).toContain('Fix the kiln')
    await waitFor(() => container.textContent.includes('(verified)'))
    access = 'inaccessible'
    await act(async () => changed?.())
    await waitFor(() =>
      container.querySelector('[data-resource-state="inaccessible"]'),
    )
    expect(container.textContent).not.toContain('Fix the kiln')
    expect(container.textContent).toContain('acme.ticket')
  })

  test('chipLabel marks an unchecked hint and drops it for any non-ready answer', () => {
    expect(chipLabel(ticket('1'), { status: 'loading' })).toEqual({
      text: 'Fix the kiln',
      verified: false,
    })
    expect(chipLabel(ticket('1'), { status: 'deleted' }).text).not.toContain(
      'Fix the kiln',
    )
  })

  test('has explicit open and preview buttons, with no hover needed', async () => {
    registerProvider(
      provider({
        support: { resolve: true },
        resolve: async () => ({
          state: 'ready',
          meta: { title: 'T', typeLabel: 'Ticket', actions: [] },
        }),
      }),
    )
    const { container } = await render(
      <ResourceChip resourceRef={ticket('1')} />,
    )
    await settle()
    const labels = [...container.querySelectorAll('button')].map((b) =>
      b.getAttribute('aria-label'),
    )
    expect(labels).toContain('Open T')
    expect(labels).toContain('Preview T')
  })
})

describe('picker', () => {
  test('shows a failed provider and incomplete coverage rather than a clean list', async () => {
    const page: SearchPage = {
      hits: [{ ref: ticket('1'), title: 'Fix the kiln', typeLabel: 'Ticket' }],
    }
    registerProvider(
      provider({ support: { search: true }, search: async () => page }),
    )
    registerProvider(
      provider({
        id: 'acme.broken',
        label: 'Broken',
        serves: ['acme.broken'],
        support: { search: true },
        search: async () => {
          throw new Error('down')
        },
      }),
    )
    const { container } = await render(<ResourcePicker onPick={() => {}} />)
    await waitFor(() => container.textContent.includes('Fix the kiln'))
    expect(container.textContent).toContain('Broken could not be searched.')
    expect(container.textContent).toContain('incomplete')
  })

  test('picks a hit and cancels the previous query when typing on', async () => {
    const queries: Array<{ q: string; aborted: () => boolean }> = []
    registerProvider(
      provider({
        support: { search: true },
        search: async ({ query }, { signal }) => {
          queries.push({ q: query, aborted: () => signal?.aborted ?? false })
          await new Promise((r) => setTimeout(r, 30))
          return {
            hits: [
              {
                ref: ticket(query || 'x'),
                title: `T ${query}`,
                typeLabel: 'Ticket',
              },
            ],
          }
        },
      }),
    )
    const picked: string[] = []
    const { container } = await render(
      <ResourcePicker onPick={(h) => picked.push(h.title)} />,
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 160))
    })
    const input = container.querySelector('input')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(input, 'k')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await waitFor(
      () =>
        container.querySelector('[data-option]') &&
        container.textContent.includes('T k'),
    )
    expect(queries[0]!.aborted()).toBe(true)
    await act(async () =>
      (container.querySelector('[data-option]') as HTMLElement).click(),
    )
    expect(picked).toEqual(['T k'])
  })
})

describe('references panel', () => {
  const occurrence = (id: string, source: string): ReferenceOccurrence => ({
    id,
    source: {
      resource: { kind: 'extension', extensionKind: 'acme.ticket', id: source },
    },
    target: ticket('t'),
    relationship: 'authored-mention',
    destination: {
      resource: { kind: 'extension', extensionKind: 'acme.ticket', id: source },
      location: { anchor: id },
    },
  })

  test('a failed first page is a failure, not an empty list', async () => {
    registerProvider(
      provider({
        support: { references: true },
        references: async () => {
          throw new Error('down')
        },
      }),
    )
    const { container } = await render(<ReferencesPanel target={ticket('t')} />)
    await waitFor(() => container.querySelector('[role="alert"]'))
    expect(container.textContent).toContain('not the same as having none')
    expect(container.textContent).not.toContain('Nothing references this')
  })

  test('a failed later page keeps its rows and retries', async () => {
    let fail = true
    registerProvider(
      provider({
        support: { references: true },
        references: async (_r, { cursor }) => {
          if (!cursor)
            return { occurrences: [occurrence('o1', 's1')], next: 'p2' }
          if (fail) throw new Error('page 2 failed')
          return { occurrences: [occurrence('o2', 's2')] }
        },
      }),
    )
    const { container } = await render(<ReferencesPanel target={ticket('t')} />)
    await waitFor(() => container.textContent.includes('Load more'))
    const click = (text: string) =>
      act(async () =>
        [...container.querySelectorAll('button')]
          .find((b) => b.textContent.includes(text))!
          .click(),
      )
    await click('Load more')
    await waitFor(() =>
      container.textContent.includes('What was loaded is still here'),
    )
    expect(container.querySelectorAll('ul > li').length).toBeGreaterThan(0)
    expect(container.textContent).toContain('Mentioned')
    fail = false
    await click('Try again')
    await waitFor(() => !container.textContent.includes('still here'))
    await settle()
    expect(container.textContent).toContain('2 visible sources')
  })

  test('says references are not available when no owner serves them', async () => {
    registerProvider(provider({}))
    const { container } = await render(<ReferencesPanel target={ticket('t')} />)
    await waitFor(() =>
      container.textContent.includes('not available here yet'),
    )
  })
})

describe('embed', () => {
  const live = () =>
    registerProvider(
      provider({
        support: { resolve: true, preview: true },
        resolve: async () => ({
          state: 'ready',
          meta: { title: 'T', typeLabel: 'Ticket', actions: [] },
        }),
        preview: async () => ({
          state: 'ready',
          preview: { title: 'Ticket body', typeLabel: 'Ticket' },
        }),
      }),
    )

  test('labels live and pinned, and is read only by default', async () => {
    live()
    const pinned: ResourceRef = {
      ...ticket('1'),
      revision: { mode: 'pinned', revision: 7 },
    }
    const { container } = await render(
      <EmbedRoot>
        <Embed resourceRef={ticket('1')} mode="embedded" />
        <Embed resourceRef={pinned} mode="compact" />
      </EmbedRoot>,
    )
    await waitFor(
      () => (container.textContent.match(/Ticket body/g)?.length ?? 0) === 2,
    )
    expect(container.textContent).toContain('Live: follows the current version')
    expect(container.textContent).toContain('Pinned to revision 7')
    expect(container.textContent).toContain('Read only')
  })

  test('collapses a self embed with a route to the original', async () => {
    live()
    const { container } = await render(
      <EmbedRoot>
        <Embed resourceRef={ticket('1')} mode="embedded">
          <Embed resourceRef={ticket('1')} mode="embedded" />
        </Embed>
      </EmbedRoot>,
    )
    await waitFor(() =>
      container.querySelector('[data-embed-collapsed="cycle"]'),
    )
    const collapsed = container.querySelector('[data-embed-collapsed="cycle"]')!
    expect(collapsed.textContent).toContain('Open original')
  })

  test('an unavailable embed says so and shows nothing it remembered', async () => {
    registerProvider(
      provider({
        support: { preview: true },
        preview: async () => ({ state: 'inaccessible' }),
      }),
    )
    const { container } = await render(
      <Embed resourceRef={ticket('1')} mode="compact" />,
    )
    await waitFor(() => container.textContent.includes('Unavailable.'))
    expect(container.textContent).not.toContain('Fix the kiln')
  })
})

describe('registerResourceLayer', () => {
  test('registers the first-slice kinds once and removes them on request', async () => {
    const { registerResourceLayer } = await import('./register')
    const { listProviders } = await import('@/lib/resources/registry')
    const remove = registerResourceLayer()
    expect(registerResourceLayer()).toBe(remove)
    const ids = listProviders()
      .map((p) => p.id)
      .sort()
    expect(ids).toEqual([
      'theorem.artifacts',
      'theorem.documents',
      'theorem.files',
      'theorem.records',
      'theorem.runs',
      'theorem.threads',
      'theorem.work',
    ])
    remove()
    expect(listProviders()).toHaveLength(0)
  })
})

describe('preview', () => {
  test('an artifact shows what it was made from, read only when asked', async () => {
    const asked: string[] = []
    const result: ResourceRef = {
      resource: { kind: 'artifact', artifactId: 'a1' },
      revision: { mode: 'live' },
    }
    registerProvider(
      provider({
        id: 'theorem.artifacts',
        serves: ['artifact'],
        support: { preview: true, references: true },
        preview: async () => ({
          state: 'ready',
          preview: { title: 'kiln.gltf', typeLabel: 'Artifact result' },
        }),
        references: async (_target, { direction }) => {
          asked.push(direction)
          return {
            occurrences: [occurrenceTo(result, 'run-7')],
          }
        },
      }),
    )
    const { container } = await render(<ResourcePreview resourceRef={result} />)
    await waitFor(() => container.textContent.includes('kiln.gltf'))
    expect(asked).toEqual([])
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent === 'Made from')!
        .click(),
    )
    await waitFor(() => asked.length > 0)
    expect(asked).toEqual(['outgoing'])
  })
})

const occurrenceTo = (
  target: ResourceRef,
  source: string,
): ReferenceOccurrence => ({
  id: `${source}->${canonical(target)}`,
  source: {
    resource: { kind: 'extension', extensionKind: 'acme.ticket', id: source },
  },
  target,
  relationship: 'authored-mention',
  destination: {
    resource: { kind: 'extension', extensionKind: 'acme.ticket', id: source },
  },
})
const canonical = (ref: ResourceRef) => JSON.stringify(ref.resource)
