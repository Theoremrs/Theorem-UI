// SOURCING: bun:test over the authoring dialog rendered on its own with test/workspace's render (a
// QueryClient) into happy-dom, window.fetch standing in for a Theorem that serves the slice-2
// capability routes, as capability-table.test.tsx stands one in. What is asserted is what the person
// sees and the patch each control sends; no backend is reached.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { cleanup, render, waitFor } from '../../../test/workspace'
import { CAPABILITIES } from '@/lib/capabilities/api'
import { codes } from '@/lib/capabilities/contract'
import type { DescribeResult } from '@/lib/capabilities/contract'
import { AuthoringDialog } from './authoring'
import {
  describeResult,
  ownerGrant,
  peopleSchema,
  tasksSchema,
  trackerDefinition,
} from './fixture'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
page.setURL('http://localhost:3000/pages/Desk')

const realFetch = window.fetch

type Call = { method: string; path: string; search: string; body?: unknown }
let calls: Call[]
let described: DescribeResult
/**
 * What a route answers instead of its default, by the route's last segment,
 * or by method and last segment ("GET templates") where one path serves two.
 */
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
    const override = answers[`${method} ${last}`] ?? answers[last]
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
  expect(screen().textContent).toContain(
    'a variant the field does not have yet',
  )
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
    screen().textContent.includes(
      'Variant added · the definition is now capdef:def',
    ),
  )
})

test('a definition refused as invalid says what the server named, and only that it was refused when it names nothing', async () => {
  answers.author = {
    status: 422,
    body: {
      type: 'about:blank',
      title: 'Unprocessable',
      status: 422,
      code: codes.DEFINITION_INVALID,
      detail: 'lifecycle on `status` must allow at least one transition',
    },
  }
  await openDialog()
  await click(button('Add variant'))
  await waitFor(() => named('Variant field'))
  fill('New variant', 'blocked')
  await click(named('Add enum variant'))
  await waitFor(() => screen().textContent.includes('refused as invalid'))
  expect(screen().textContent).toContain(
    'The definition was refused as invalid: lifecycle on `status` must allow at least one transition.',
  )
  // A refusal that names nothing says only that it was refused.
  answers.author = {
    status: 422,
    body: {
      title: 'Unprocessable',
      status: 422,
      code: codes.DEFINITION_INVALID,
    },
  }
  await click(named('Add enum variant'))
  await waitFor(() => !screen().textContent.includes('must allow'))
  expect(screen().textContent).toContain(
    'The definition was refused as invalid.',
  )
  expect(screen().textContent).not.toContain('Unprocessable')
  expect(authored().length).toBe(2)
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
  expect(named('Transition 1 from waiting')?.getAttribute('aria-checked')).toBe(
    'true',
  )

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

test('a refused clear keeps the question open, and a taken one closes it', async () => {
  await openDialog()
  await click(button('Lifecycle'))
  await waitFor(() => button('Clear lifecycle'))
  answers.author = {
    status: 403,
    body: {
      title: 'Forbidden',
      status: 403,
      code: 'capability_author_denied',
      detail: 'No author grant.',
    },
  }
  await click(button('Clear lifecycle'))
  await click(named('Confirm clear lifecycle'))
  await waitFor(() =>
    screen().textContent.includes(
      "You do not have permission to change this capability's definition.",
    ),
  )
  expect(named('Confirm clear lifecycle')).toBeTruthy()
  expect(button('Clear lifecycle')).toBeUndefined()

  delete answers.author
  await click(named('Confirm clear lifecycle'))
  await waitFor(() => named('Confirm clear lifecycle') === null)
  expect(screen().textContent).toContain(
    'Lifecycle cleared · the definition is now capdef:def',
  )
  expect(screen().textContent).not.toContain('records are not changed')
  expect(button('Clear lifecycle')).toBeTruthy()
  expect(authored().at(-1)).toEqual({
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

test('adding a variant names what is still to do, over any select field, and a collection with none has nothing to add to', async () => {
  described = {
    ...describeResult(),
    collectionSchemas: [
      {
        ...tasksSchema,
        fields: [
          ...tasksSchema.fields,
          {
            key: 'tags',
            label: 'Tags',
            fieldType: { kind: 'enum_many', variants: [] },
            required: false,
          },
        ],
      },
      peopleSchema,
    ],
  }
  await openDialog()
  await click(button('Add variant'))
  await waitFor(() => named('Variant field'))
  expect(
    [...named<HTMLSelectElement>('Variant field')!.options].map(
      (one) => one.value,
    ),
  ).toEqual(['status', 'tags'])
  expect(screen().textContent).toContain('Still to do: the new variant.')
  expect(named<HTMLButtonElement>('Add enum variant')?.disabled).toBe(true)
  fill('New variant', 'blocked')
  expect(screen().textContent).not.toContain('Still to do')
  fill('Variant field', 'tags')
  expect(screen().textContent).toContain('Its variants now: none.')

  // A collection with no select field: nothing to add to, and the typed variant is kept.
  fill('Variant collection', 'people')
  expect(named('Variant field')).toBeNull()
  expect(screen().textContent).toContain(
    'This collection declares no select field to add a variant to.',
  )
  expect(screen().textContent).not.toContain('Its variants now')
  expect(screen().textContent).toContain('Still to do: a select field.')
  expect(named<HTMLButtonElement>('Add enum variant')?.disabled).toBe(true)

  // Back on tasks the field starts over at the first select field.
  fill('Variant collection', 'tasks')
  expect(named<HTMLSelectElement>('Variant field')?.value).toBe('status')
  fill('Variant field', 'tags')
  await click(named('Add enum variant'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'add_enum_variant',
        collectionKey: 'tasks',
        fieldKey: 'tags',
        variant: 'blocked',
      },
    ],
  })
})

test('a lifecycle over a field no longer a select is still shown from its transitions, and moving it starts over', async () => {
  described = {
    ...describeResult(),
    definition: {
      ...trackerDefinition,
      collections: [
        {
          ...trackerDefinition.collections[0]!,
          lifecycle: {
            fieldKey: 'stage',
            initial: ['draft', 'gone'],
            transitions: [
              { from: ['draft'], to: 'live' },
              { from: ['live'], to: 'archived' },
            ],
          },
        },
        trackerDefinition.collections[1]!,
      ],
    },
  }
  await openDialog()
  await click(button('Lifecycle'))
  await waitFor(() => named('Lifecycle field'))
  expect(named<HTMLSelectElement>('Lifecycle field')?.value).toBe('stage')
  expect(
    [...named<HTMLSelectElement>('Lifecycle field')!.options].map(
      (one) => one.value,
    ),
  ).toEqual(['stage', 'status'])
  // Its values are the ones its transitions name.
  expect(named('Initial draft')?.getAttribute('aria-checked')).toBe('true')
  expect(named('Initial live')?.getAttribute('aria-checked')).toBe('false')
  expect(named('Initial archived')?.getAttribute('aria-checked')).toBe('false')
  expect(named('Initial gone')).toBeNull()
  expect(screen().textContent).toContain(
    'Still to do: gone is not a value the field holds.',
  )
  expect(button('Save lifecycle')?.disabled).toBe(true)
  expect(screen().textContent).not.toContain('governs stage now')

  // Ungoverned, then governed with none chosen, then one start value.
  await click(named('Govern initial values'))
  expect(screen().textContent).not.toContain('Still to do')
  await click(named('Govern initial values'))
  expect(screen().textContent).toContain(
    'With none chosen, no create may write this field.',
  )
  await click(named('Initial live'))
  expect(screen().textContent).not.toContain('With none chosen')
  await click(button('Save lifecycle'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'set_lifecycle',
        collectionKey: 'tasks',
        lifecycle: {
          fieldKey: 'stage',
          initial: ['live'],
          transitions: [
            { from: ['draft'], to: 'live' },
            { from: ['live'], to: 'archived' },
          ],
        },
      },
    ],
  })

  // On another field the form starts over, and says the lifecycle moves.
  fill('Lifecycle field', 'status')
  expect(screen().textContent).toContain(
    "This collection's lifecycle governs stage now; saving moves it to this field.",
  )
  expect(screen().textContent).toContain(
    'No transition is allowed yet: once saved, the field cannot change.',
  )
  expect(screen().textContent).toContain(
    'Ungoverned: a new record may start at any value the field holds.',
  )
  expect(named('Transition 1 to')).toBeNull()
  await click(button('Save lifecycle'))
  await waitFor(() => authored().length === 2)
  expect(authored()[1]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'set_lifecycle',
        collectionKey: 'tasks',
        lifecycle: { fieldKey: 'status', transitions: [] },
      },
    ],
  })
})

test('each collection starts from its own lifecycle or its first select field; a transition to a value the field does not hold is shown and named; keeping it cancels a clear', async () => {
  const tasks = trackerDefinition.collections[0]!
  const people = trackerDefinition.collections[1]!
  described = {
    ...describeResult(),
    definition: {
      ...trackerDefinition,
      // People first: the editor opens on a collection with no lifecycle.
      collections: [
        people,
        {
          ...tasks,
          lifecycle: {
            fieldKey: 'status',
            transitions: [
              { from: ['next'], to: 'done' },
              { from: ['done'], to: 'cancelled' },
            ],
          },
        },
      ],
    },
    collectionSchemas: [
      tasksSchema,
      {
        ...peopleSchema,
        fields: [
          ...peopleSchema.fields,
          {
            key: 'role',
            label: 'Role',
            fieldType: { kind: 'enum', variants: ['lead', 'member'] },
            required: false,
          },
        ],
      },
    ],
  }
  const toOptions = () =>
    [...named<HTMLSelectElement>('Transition 2 to')!.options].map(
      (one) => one.value,
    )
  await openDialog()
  await click(button('Lifecycle'))
  await waitFor(() => named('Lifecycle field'))

  // No lifecycle: its first select field, ungoverned, nothing to clear.
  expect(named<HTMLSelectElement>('Lifecycle collection')?.value).toBe('people')
  expect(named<HTMLSelectElement>('Lifecycle field')?.value).toBe('role')
  expect(screen().textContent).not.toContain('lifecycle governs')
  expect(button('Clear lifecycle')).toBeUndefined()
  expect(named('Initial lead')).toBeNull()
  await click(button('Add transition'))
  expect(named<HTMLSelectElement>('Transition 1 to')?.value).toBe('lead')
  await click(named('Transition 1 from member'))
  await click(button('Save lifecycle'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'set_lifecycle',
        collectionKey: 'people',
        lifecycle: {
          fieldKey: 'role',
          transitions: [{ from: ['member'], to: 'lead' }],
        },
      },
    ],
  })

  // A lifecycle as read: a target the field does not hold is still offered, and named.
  fill('Lifecycle collection', 'tasks')
  expect(named<HTMLSelectElement>('Lifecycle field')?.value).toBe('status')
  expect(named<HTMLSelectElement>('Transition 2 to')?.value).toBe('cancelled')
  expect(toOptions()).toEqual([
    'cancelled',
    'next',
    'in_progress',
    'waiting',
    'done',
  ])
  expect(screen().textContent).toContain(
    'Still to do: transition 2 moves to a value the field does not hold.',
  )
  expect(button('Save lifecycle')?.disabled).toBe(true)
  fill('Transition 2 to', 'next')
  expect(toOptions()).toEqual(['next', 'in_progress', 'waiting', 'done'])
  expect(screen().textContent).not.toContain('Still to do')

  // Keeping it closes the question and sends nothing.
  await click(button('Clear lifecycle'))
  expect(button('Clear lifecycle')).toBeUndefined()
  await click(button('Keep it'))
  expect(screen().textContent).not.toContain('records are not changed')
  expect(button('Clear lifecycle')).toBeTruthy()
  expect(authored().length).toBe(1)

  // Back on people the field starts over at its first select field.
  fill('Lifecycle collection', 'people')
  expect(named<HTMLSelectElement>('Lifecycle field')?.value).toBe('role')
  expect(named('Transition 1 to')).toBeNull()
  await click(button('Add transition'))
  expect(named<HTMLSelectElement>('Transition 1 to')?.value).toBe('lead')
})

// ── Agent access: three separate controls ───────────────────────────────────

test('discoverability is its own control: set_agent with the description, granting nothing', async () => {
  await openDialog()
  await click(button('Agent access'))
  await waitFor(() => named('Discoverable to agents'))
  expect(named('Discoverable to agents')?.getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(named<HTMLInputElement>('Agent description')?.value).toBe(
    'Personal task tracker',
  )
  expect(screen().textContent).toContain('Being listed grants nothing')
  await click(named('Discoverable to agents'))
  fill('Agent description', ' Tasks for this week ')
  await click(named('Save discoverability'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'set_agent',
        agent: { discoverable: false, description: 'Tasks for this week' },
      },
    ],
  })
})

test('the grants editor starts from the list describe disclosed and sends it back whole', async () => {
  described = {
    ...describeResult(),
    grants: [
      // Background permission is not drawn as a control; it must survive.
      { ...ownerGrant, background: true },
      {
        principal: 'user:sam',
        read: true,
        // A key the definition no longer declares is still the grant's.
        invoke: ['complete', 'retired'],
        author: false,
      },
    ],
  }
  await openDialog()
  await click(button('Agent access'))
  await waitFor(() => named('Principal 1'))
  expect(named<HTMLInputElement>('Principal 1')?.value).toBe('user:travis')
  expect(
    named('Grant 1 invokes every action')?.getAttribute('aria-checked'),
  ).toBe('true')
  expect(named('Grant 1 authors')?.getAttribute('aria-checked')).toBe('true')
  expect(named('Grant 2 invokes complete')?.getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(named('Grant 2 invokes assign')?.getAttribute('aria-checked')).toBe(
    'false',
  )
  expect(named('Grant 2 invokes retired')?.getAttribute('aria-checked')).toBe(
    'true',
  )
  expect(screen().textContent).toContain('Saving replaces the whole grant list')

  // Sam may now assign and author; invoking still does not imply authoring.
  await click(named('Grant 2 invokes assign'))
  await click(named('Grant 2 authors'))
  // A new grant that repeats a principal is named before anything is sent.
  await click(button('Add grant'))
  fill('Principal 3', 'user:travis')
  expect(screen().textContent).toContain('user:travis has two grants')
  expect(button('Save grants')?.disabled).toBe(true)
  fill('Principal 3', ' agent:helper ')
  await click(named('Grant 3 reads'))
  // A grant added by mistake goes again.
  await click(button('Add grant'))
  expect(screen().textContent).toContain('grant 4 names no principal')
  await click(named('Remove grant 4'))

  await click(button('Save grants'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'set_grants',
        grants: [
          {
            principal: 'user:travis',
            read: true,
            invoke: ['*'],
            author: true,
            background: true,
          },
          {
            principal: 'user:sam',
            read: true,
            invoke: ['complete', 'retired', 'assign'],
            author: true,
          },
          { principal: 'agent:helper', read: false, invoke: [], author: false },
        ],
      },
    ],
  })
})

test('a grant’s actions are ticked off one at a time or all at once, and only a background grant says it keeps that', async () => {
  described = {
    ...describeResult(),
    grants: [
      { ...ownerGrant, background: true },
      {
        principal: 'user:sam',
        read: true,
        invoke: ['complete', 'retired'],
        author: false,
      },
    ],
  }
  await openDialog()
  await click(button('Agent access'))
  await waitFor(() => named('Principal 2'))
  const grantText = (n: number) =>
    named(`Principal ${n}`)?.closest('fieldset')?.textContent ?? ''
  const kept =
    'May also run background behavior; this editor keeps that as it is.'
  expect(grantText(1)).toContain(kept)
  expect(grantText(2)).not.toContain(kept)
  // A declared action is named by its label; a retired key by itself.
  expect(grantText(2)).toContain('Complete')
  expect(grantText(2)).toContain('retired')
  expect(named('Grant 1 invokes complete')).toBeNull()

  await click(named('Grant 2 invokes complete'))
  expect(named('Grant 2 invokes complete')?.getAttribute('aria-checked')).toBe(
    'false',
  )
  await click(named('Grant 1 invokes every action'))
  expect(named('Grant 1 invokes complete')?.getAttribute('aria-checked')).toBe(
    'false',
  )
  await click(named('Grant 2 invokes every action'))
  expect(named('Grant 2 invokes retired')).toBeNull()

  await click(button('Save grants'))
  await waitFor(() => authored().length === 1)
  expect(authored()[0]).toEqual({
    expectedDefinitionId: 'capdef:abc',
    ops: [
      {
        op: 'set_grants',
        grants: [
          {
            principal: 'user:travis',
            read: true,
            invoke: [],
            author: true,
            background: true,
          },
          { principal: 'user:sam', read: true, invoke: ['*'], author: false },
        ],
      },
    ],
  })
})

test('without the grant list in the answer, no grants editor is offered', async () => {
  const { grants: _withheld, ...withheld } = describeResult()
  described = withheld
  await openDialog()
  await click(button('Agent access'))
  await waitFor(() => named('Discoverable to agents'))
  expect(named('Principal 1')).toBeNull()
  expect(button('Save grants')).toBeUndefined()
  expect(screen().textContent).toContain(
    'The grant list is disclosed only to a caller who may author',
  )
})

test('use in this conversation hands back to the module that opened the dialog', async () => {
  await openDialog()
  await click(button('Agent access'))
  await waitFor(() => button('Use in this conversation'))
  // Opened with nothing to put in the conversation, it says so instead.
  expect(button('Use in this conversation')?.disabled).toBe(true)
  cleanup()

  let asked = 0
  await openDialog({ onAsk: () => asked++ })
  await click(button('Agent access'))
  await click(await waitFor(() => button('Use in this conversation')))
  expect(asked).toBe(1)
  // Using it here authors nothing.
  expect(authored()).toEqual([])
})

// ── Definition history and re-pin ───────────────────────────────────────────

const pin = (
  seq: number,
  definitionId: string,
  reason: 'created' | 'authored' | 'repinned' | 'instantiated',
  ops: string[] = [],
) => ({
  seq,
  definitionId,
  reason,
  principal: 'user:travis',
  atMs: Date.UTC(2026, 10, 20 + seq, 15, 0),
  ops,
})

test('history lists the pins newest first, pages back, and re-pins an older one', async () => {
  answers.history = {
    status: 200,
    body: {
      instanceId: 'tracker/main',
      currentDefinitionId: 'capdef:abc',
      entries: [
        {
          ...pin(4, 'capdef:abc', 'authored', ['add_view', 'replace_view']),
          previousDefinitionId: 'capdef:two',
        },
        pin(3, 'capdef:two', 'repinned'),
      ],
      nextCursor: 'h3',
    },
  }
  await openDialog()
  await click(button('History'))
  await waitFor(() => screen().textContent.includes('capdef:two'))
  const read = calls.filter((call) => call.path.endsWith('/history'))
  expect(read[0]?.path).toBe(
    `${CAPABILITIES}/instances/${encodeURIComponent('tracker/main')}/history`,
  )
  expect(read[0]?.search).toBe('')
  expect(screen().textContent).toContain('Records are not changed')
  expect(screen().textContent).toContain('add_view, replace_view')
  // The pin in force is marked, and offers no re-pin to itself.
  expect(screen().textContent).toContain('In use')
  expect(named('Re-pin entry 4')).toBeNull()
  expect(named('Re-pin entry 3')).toBeTruthy()

  // The older page comes from the cursor the first answered with.
  answers.history = {
    status: 200,
    body: {
      instanceId: 'tracker/main',
      currentDefinitionId: 'capdef:abc',
      entries: [
        pin(2, 'capdef:one', 'instantiated', ['captpl:reading']),
        pin(1, 'capdef:zero', 'created'),
      ],
    },
  }
  await click(button('Show older entries'))
  await waitFor(() => screen().textContent.includes('capdef:zero'))
  expect(
    calls.filter((call) => call.path.endsWith('/history')).at(-1)?.search,
  ).toBe('?cursor=h3')
  expect(screen().textContent).toContain('Created from template captpl:reading')
  expect(button('Show older entries')).toBeUndefined()

  answers.repin = {
    status: 200,
    body: {
      definitionId: 'capdef:one',
      instance: { instanceId: 'tracker/main', definitionId: 'capdef:one' },
    },
  }
  await click(named('Re-pin entry 2'))
  const repinned = await waitFor(() =>
    calls.find((call) => call.path.endsWith('/repin')),
  )
  expect(repinned.method).toBe('POST')
  expect(repinned.body).toEqual({ definitionId: 'capdef:one' })
  await waitFor(() =>
    screen().textContent.includes(
      'Re-pinned · the instance now uses capdef:one. Records are not changed.',
    ),
  )
  // A re-pin is not an authoring patch.
  expect(authored()).toEqual([])
})

test('a refused history read says why, and Try again reads it again', async () => {
  answers.history = {
    status: 404,
    body: {
      title: 'Not found',
      status: 404,
      code: 'capability_not_found',
      detail: 'gone',
    },
  }
  await openDialog()
  await click(button('History'))
  await waitFor(() => button('Try again'))
  expect(screen().querySelector('[role="alert"]')?.textContent).toContain(
    'This capability instance is not there.',
  )
  expect(named('Definition history')).toBeNull()
  const reads = () => calls.filter((call) => call.path.endsWith('/history'))
  const before = reads().length
  answers.history = {
    status: 200,
    body: {
      currentDefinitionId: 'capdef:abc',
      entries: [pin(1, 'capdef:abc', 'created')],
    },
  }
  await click(button('Try again'))
  await waitFor(() => named('Definition history'))
  expect(reads().length).toBe(before + 1)
  expect(screen().querySelector('[role="alert"]')).toBeNull()
})

test('an instance with no recorded pins says why, rather than inventing a past', async () => {
  answers.history = {
    status: 200,
    body: {
      instanceId: 'tracker/main',
      currentDefinitionId: 'capdef:abc',
      entries: [],
    },
  }
  await openDialog()
  await click(button('History'))
  await waitFor(() => screen().textContent.includes('No history is recorded'))
  expect(screen().textContent).toContain('until its next change')
})

test('a refused re-pin says why and moves nothing', async () => {
  answers.history = {
    status: 200,
    body: {
      instanceId: 'tracker/main',
      currentDefinitionId: 'capdef:abc',
      entries: [
        pin(2, 'capdef:abc', 'authored'),
        pin(1, 'capdef:old', 'created'),
      ],
    },
  }
  answers.repin = {
    status: 403,
    body: {
      title: 'Forbidden',
      status: 403,
      code: 'capability_author_denied',
      detail: 'No author grant.',
    },
  }
  await openDialog()
  await click(button('History'))
  await click(await waitFor(() => named('Re-pin entry 1')))
  await waitFor(() =>
    screen().textContent.includes(
      "You do not have permission to change this capability's definition.",
    ),
  )
  expect(screen().textContent).not.toContain('Re-pinned ·')
})

// ── Templates: save this design, or start a new instance from one ──────────

const template = (templateId: string, name: string, description: string) => ({
  templateId,
  name,
  description,
  definition: describeResult().definition,
  declareTypes: [],
  requirements: { modules: ['theorem.capability.table'] },
  savedBy: 'user:travis',
  savedAtMs: 1,
})

test('save as template names the instance, a name and a description, and says what stays behind', async () => {
  answers['POST templates'] = {
    status: 201,
    body: template('captpl:weekly', 'Weekly tracker', 'Tasks by week'),
  }
  answers['GET templates'] = { status: 200, body: { templates: [] } }
  await openDialog()
  await click(button('Templates'))
  await waitFor(() => named('Template name'))
  // It starts from the definition's own name and purpose.
  expect(named<HTMLInputElement>('Template name')?.value).toBe(
    'Project tracker',
  )
  expect(named<HTMLInputElement>('Template description')?.value).toBe(
    'Track personal projects and tasks',
  )
  expect(screen().textContent).toContain(
    'Records, grants, enabled schedules and credentials are not included',
  )
  fill('Template name', '  ')
  expect(button('Save as template')?.disabled).toBe(true)
  fill('Template name', ' Weekly tracker ')
  fill('Template description', 'Tasks by week')
  await click(button('Save as template'))
  const saved = await waitFor(() =>
    calls.find(
      (call) => call.method === 'POST' && call.path.endsWith('/templates'),
    ),
  )
  expect(saved.path).toBe(`${CAPABILITIES}/library/templates`)
  expect(saved.body).toEqual({
    instanceId: 'tracker/main',
    name: 'Weekly tracker',
    description: 'Tasks by week',
  })
  await waitFor(() =>
    screen().textContent.includes(
      'Saved as template Weekly tracker · captpl:weekly.',
    ),
  )
  expect(authored()).toEqual([])
})

test('new from template binds a fresh instance under the id chosen, then opens it', async () => {
  answers['GET templates'] = {
    status: 200,
    body: {
      templates: [
        template('captpl:weekly', 'Weekly tracker', 'Tasks by week'),
        template('captpl:reading', 'Reading list', 'Books to read'),
      ],
    },
  }
  answers.instantiate = {
    status: 201,
    body: {
      definitionId: 'capdef:fresh',
      instance: { instanceId: 'reading/home', definitionId: 'capdef:fresh' },
    },
  }
  const opened: string[] = []
  await openDialog({ onOpenInstance: (id) => opened.push(id) })
  await click(button('Templates'))
  await waitFor(() => named('Template to use'))
  expect(
    [...named<HTMLSelectElement>('Template to use')!.options].map(
      (option) => option.textContent,
    ),
  ).toEqual(['Weekly tracker', 'Reading list'])
  fill('Template to use', 'captpl:reading')
  expect(screen().textContent).toContain('Books to read')
  expect(screen().textContent).toContain(
    'Its own empty collections, with you as its only owner',
  )
  // An id is chosen first, and one with a space is refused before sending.
  expect(button('Create instance')?.disabled).toBe(true)
  fill('New instance id', 'reading home')
  expect(screen().textContent).toContain('an instance id without spaces')
  fill('New instance id', ' reading/home ')
  await click(button('Create instance'))
  const made = await waitFor(() =>
    calls.find((call) => call.path.endsWith('/instantiate')),
  )
  expect(made.path).toBe(
    `${CAPABILITIES}/library/templates/${encodeURIComponent('captpl:reading')}/instantiate`,
  )
  expect(made.body).toEqual({ instanceId: 'reading/home' })
  await waitFor(() => opened.length === 1)
  expect(opened).toEqual(['reading/home'])
})

test('a new instance with nowhere to open it says where to name it', async () => {
  answers['GET templates'] = {
    status: 200,
    body: { templates: [template('captpl:reading', 'Reading list', 'Books')] },
  }
  answers.instantiate = {
    status: 201,
    body: {
      definitionId: 'capdef:fresh',
      instance: { instanceId: 'reading/home', definitionId: 'capdef:fresh' },
    },
  }
  await openDialog()
  await click(button('Templates'))
  await waitFor(() => named('New instance id'))
  fill('New instance id', 'reading/home')
  await click(button('Create instance'))
  await waitFor(() =>
    screen().textContent.includes(
      "Created reading/home from Reading list. Name it in a capability module's Instance setting to open it.",
    ),
  )
})

test('a template names the modules it is shown through, and a refused create says why', async () => {
  answers['GET templates'] = {
    status: 200,
    body: {
      templates: [
        {
          ...template('captpl:bare', 'Bare tracker', ''),
          requirements: { modules: [] },
        },
        template('captpl:reading', 'Reading list', 'Books to read'),
      ],
    },
  }
  answers.instantiate = {
    status: 409,
    body: {
      title: 'Conflict',
      status: 409,
      code: 'capability_instance_exists',
      detail: 'taken',
    },
  }
  await openDialog()
  await click(button('Templates'))
  await waitFor(() => named('Template to use'))
  expect(screen().textContent).not.toContain('Shown through')
  expect(screen().textContent).toContain('Still to do: an instance id.')
  fill('Template to use', 'captpl:reading')
  expect(screen().textContent).toContain(
    'Shown through theorem.capability.table.',
  )
  fill('New instance id', 'reading/home')
  expect(screen().textContent).not.toContain('Still to do')
  await click(button('Create instance'))
  await waitFor(() => calls.find((call) => call.path.endsWith('/instantiate')))
  await waitFor(() => !screen().textContent.includes('Creating reading/home…'))
  expect(screen().textContent).not.toContain('Created reading/home')
  expect(screen().textContent).toContain(
    'An instance with that id is already bound.',
  )
})

test('a refused template list says why and offers no form', async () => {
  answers['GET templates'] = {
    status: 404,
    body: {
      title: 'Not found',
      status: 404,
      code: 'capability_template_not_found',
      detail: 'gone',
    },
  }
  await openDialog()
  await click(button('Templates'))
  await waitFor(() => screen().querySelector('[role="alert"]'))
  expect(screen().querySelector('[role="alert"]')?.textContent).toBe(
    'That template is not there: it was never saved, or it is not yours to read.',
  )
  expect(named('Template to use')).toBeNull()
  expect(button('Create instance')).toBeUndefined()
})

test('a created instance that can be opened says what it was made from', async () => {
  answers['GET templates'] = {
    status: 200,
    body: { templates: [template('captpl:reading', 'Reading list', 'Books')] },
  }
  answers.instantiate = {
    status: 201,
    body: {
      definitionId: 'capdef:fresh',
      instance: { instanceId: 'reading/home', definitionId: 'capdef:fresh' },
    },
  }
  await openDialog({ onOpenInstance: () => {} })
  await click(button('Templates'))
  await waitFor(() => named('New instance id'))
  fill('New instance id', 'reading/home')
  await click(button('Create instance'))
  await waitFor(() =>
    screen().textContent.includes('Created reading/home from Reading list.'),
  )
  expect(screen().textContent).not.toContain('Name it in a capability module')
})

test('with no templates saved, new from template says how to make one', async () => {
  answers['GET templates'] = { status: 200, body: { templates: [] } }
  await openDialog()
  await click(button('Templates'))
  await waitFor(() => screen().textContent.includes('No templates saved yet'))
  expect(button('Create instance')).toBeUndefined()
})
