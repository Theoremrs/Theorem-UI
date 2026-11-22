// SOURCING: bun:test over the authoring dialog rendered on its own with test/workspace's render (a
// QueryClient) into happy-dom, window.fetch standing in for a Theorem that serves the slice-2
// capability routes, as capability-table.test.tsx stands one in. What is asserted is what the person
// sees and the patch each control sends; no backend is reached.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { CAPABILITIES } from '@/lib/capabilities/api'
import type { DescribeResult } from '@/lib/capabilities/contract'
import { AuthoringDialog } from './authoring'
import { describeResult } from './fixture'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
page.setURL('http://localhost:3000/pages/Desk')

const realFetch = window.fetch

type Call = { method: string; path: string; search: string; body?: unknown }
let calls: Call[]
let described: DescribeResult
/** What a route answers instead of its default, by the route's last segment. */
let answers: Record<string, { status: number; body: unknown }>

beforeEach(() => {
  calls = []
  described = describeResult()
  answers = {}
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const method = init?.method ?? (request ? request.method : 'GET')
    const raw =
      init?.body ?? (request ? await request.clone().text() : undefined)
    const body = raw ? (JSON.parse(String(raw)) as unknown) : undefined
    calls.push({ method, path: url.pathname, search: url.search, body })
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: {
          'content-type':
            status >= 400 ? 'application/problem+json' : 'application/json',
        },
      })
    if (url.pathname === '/api/chat/v1/bootstrap')
      return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    const tail = url.pathname.slice(CAPABILITIES.length + 1)
    const last = tail.split('/').at(-1) ?? ''
    const override = answers[last]
    if (override) return json(override.body, override.status)
    if (last === 'author')
      return json({
        definitionId: 'capdef:def',
        instance: { instanceId: 'tracker/main', definitionId: 'capdef:def' },
      })
    if (tail === `instances/${encodeURIComponent('tracker/main')}`)
      return json(described)
    return json({ title: 'Not served', status: 404 }, 404)
  }) as typeof fetch
})

afterEach(() => {
  window.fetch = realFetch
  cleanup()
})

const screen = () => document.body

const button = (name: string) =>
  [...screen().querySelectorAll('button')].find(
    (one) => one.textContent.trim() === name,
  )

const named = <T extends Element = HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`)

async function click(target: HTMLElement | null | undefined) {
  expect(target).toBeTruthy()
  await act(async () => target!.click())
}

function fill(label: string, value: string) {
  const field = named<HTMLInputElement | HTMLSelectElement>(label)
  expect(field).toBeTruthy()
  const proto =
    field instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(field, value)
    field!.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    )
  })
}

const authored = () =>
  calls.filter((call) => call.path.endsWith('/author')).map((call) => call.body)

async function openDialog(
  extra: Partial<Parameters<typeof AuthoringDialog>[0]> = {},
) {
  const shown = await render(
    <AuthoringDialog
      instanceId="tracker/main"
      described={described}
      viewKey="next"
      onClose={() => {}}
      {...extra}
    />,
  )
  await waitFor(() => screen().textContent.includes('Author Project tracker'))
  return shown
}

// ── Fields: add an enum variant, and the lifecycle editor ────────────────────

test('a new enum variant is added to the field it names, and one it already has is refused first', async () => {
  await openDialog()
  await click(button('Add variant'))
  await waitFor(() => named('Variant field'))
  expect(named<HTMLSelectElement>('Variant field')?.value).toBe('status')
  expect(screen().textContent).toContain(
    'Its variants now: next, in_progress, waiting, done.',
  )
  fill('New variant', 'done')
  expect(screen().textContent).toContain('a variant the field does not have yet')
  expect(named<HTMLButtonElement>('Add enum variant')?.disabled).toBe(true)
  fill('New variant', ' blocked ')
  await click(named('Add enum variant'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'add_enum_variant',
        collectionKey: 'tasks',
        fieldKey: 'status',
        variant: 'blocked',
      },
    ],
  })
  await waitFor(() =>
    screen().textContent.includes('Variant added · the definition is now capdef:def'),
  )
})

test('the lifecycle editor reads the declared lifecycle and sends it back edited', async () => {
  await openDialog()
  await click(button('Lifecycle'))
  await waitFor(() => named('Lifecycle field'))
  expect(named<HTMLSelectElement>('Lifecycle field')?.value).toBe('status')
  // Governed creates: 'next' is the one start value.
  expect(named('Govern initial values')?.getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(named('Initial next')?.getAttribute('aria-checked')).toBe('true')
  expect(named('Initial waiting')?.getAttribute('aria-checked')).toBe('false')
  expect(named<HTMLSelectElement>('Transition 1 to')?.value).toBe('done')
  expect(
    named('Transition 1 from waiting')?.getAttribute('aria-checked'),
  ).toBe('true')

  // Let a new record also start as waiting; add waiting -> in_progress.
  await click(named('Initial waiting'))
  await click(button('Add transition'))
  await click(named('Transition 3 from waiting'))
  fill('Transition 3 to', 'in_progress')
  // A transition from nothing is named before anything is sent.
  await click(button('Add transition'))
  expect(screen().textContent).toContain('transition 4 moves from no value')
  expect(button('Save lifecycle')?.disabled).toBe(true)
  await click(named('Remove transition 4'))

  await click(button('Save lifecycle'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'set_lifecycle',
        collectionKey: 'tasks',
        lifecycle: {
          fieldKey: 'status',
          initial: ['next', 'waiting'],
          transitions: [
            { from: ['next', 'in_progress', 'waiting'], to: 'done' },
            { from: ['done'], to: 'next' },
            { from: ['waiting'], to: 'in_progress' },
          ],
        },
      },
    ],
  })
})

test('ungoverned creates send no initial list, and clearing sends null after asking', async () => {
  await openDialog()
  await click(button('Lifecycle'))
  await waitFor(() => named('Govern initial values'))
  await click(named('Govern initial values'))
  expect(screen().textContent).toContain(
    'Ungoverned: a new record may start at any value the field holds.',
  )
  await click(button('Save lifecycle'))
  await waitFor(() => authored().length === 1)
  const sent = authored()[0] as {
    ops: [{ lifecycle: Record<string, unknown> }]
  }
  // Absent, not an empty list: an empty list would forbid every create.
  expect('initial' in sent.ops[0].lifecycle).toBe(false)

  await click(button('Clear lifecycle'))
  expect(screen().textContent).toContain('records are not changed')
  await click(named('Confirm clear lifecycle'))
  await waitFor(() => authored().length === 2)
  expect(authored()[1]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [{ op: 'set_lifecycle', collectionKey: 'tasks', lifecycle: null }],
  })
})

test('a collection with no select field says it has nothing to govern', async () => {
  await openDialog()
  await click(button('Lifecycle'))
  await waitFor(() => named('Lifecycle collection'))
  fill('Lifecycle collection', 'people')
  expect(screen().textContent).toContain(
    'This collection declares no select field',
  )
  expect(button('Save lifecycle')).toBeUndefined()
})
