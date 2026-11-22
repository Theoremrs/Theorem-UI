// SOURCING: bun:test over module-harness: a vault module placed as a page places it and run through
// VaultModule, its frame's calls made on the port the page hands the frame, so they reach the host
// the module really runs with. What is asserted is the fallback a person sees, the request each call
// sends and the envelope the composer carries.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { waitFor } from '../../../test/workspace'
import {
  button,
  named,
  press,
  sentTo,
} from '@/components/capabilities/slice2-harness'
import { capabilityKeys } from '@/components/capabilities/queries'
import { useComposerReferences } from '@/components/chat/composer-references'
import { call } from '@/lib/blocks/sandbox/protocol'
import type { PageMethods } from '@/lib/blocks/sandbox/protocol'
import { bootstrap } from '@/lib/theorem/client'
import {
  beginModuleTest,
  endModuleTest,
  frameOf,
  placeModule,
} from './module-harness'

const manifest = {
  schema: 'theorem.module/1',
  id: 'vault.focus',
  label: 'Focus',
  outputs: [{ name: 'summary', label: 'Summary', type: 'text' }],
  capabilities: {
    instances: [
      {
        instanceId: 'tracker/main',
        methods: ['describe', 'query', 'invoke'],
        actions: ['complete'],
      },
    ],
  },
  agent: {
    description: 'Shows open tasks that fit the minutes you have.',
    summaryOutput: 'summary',
  },
  fallback: {
    kind: 'capability-records',
    instanceId: 'tracker/main',
    viewKey: 'next',
    actions: ['complete'],
  },
  implementation: { kind: 'sandboxed-html' },
}

const source = '<!doctype html><html><body><main>Focus</main></body></html>'

const place = (extra: Record<string, unknown> = {}) =>
  placeModule(JSON.stringify({ ...manifest, ...extra }), source)

beforeEach(beginModuleTest)
afterEach(endModuleTest)

test('a module not yet allowed asks first, and meanwhile shows its records through the fallback', async () => {
  const { container } = await place()
  await waitFor(() => container.textContent.includes('It asks to'))
  await waitFor(() => container.textContent.includes('Write the plan'))
  expect(container.textContent).toContain('Run “complete” in tracker/main')
  // The fallback offers only the actions it names, on the view it names.
  expect(button(container, 'Complete')).toBeTruthy()
  expect(button(container, 'Assign')).toBeUndefined()
  expect(button(container, 'Update')).toBeUndefined()
  expect(sentTo('/query')[0]?.body).toMatchObject({
    instanceId: 'tracker/main',
    viewKey: 'next',
  })
})

test('a module that names no fallback still only asks', async () => {
  const { container } = await place({ fallback: undefined })
  await waitFor(() => container.textContent.includes('It asks to'))
  expect(container.textContent).not.toContain('Write the plan')
  expect(sentTo('/query')).toEqual([])
})

test('asking about the module carries how an agent reads it, with its summary as it stands', async () => {
  const { container } = await place()
  await press(button(container, 'Run it'))
  const frame = await frameOf(container)
  await call<PageMethods, 'module.output'>(frame, 'module.output', {
    name: 'summary',
    value: '2 tasks fit 25 minutes',
  })
  await press(named('Ask about Focus'))
  const references = useComposerReferences.getState().references
  expect(references).toHaveLength(1)
  expect(references[0]).toMatchObject({
    label: 'Focus',
    location: {
      resource: {
        kind: 'component',
        moduleId: 'vault.focus',
        selectedComponentId: 'focus-1',
        description: 'Shows open tasks that fit the minutes you have.',
        summary: '2 tasks fit 25 minutes',
        instances: ['tracker/main'],
      },
    },
  })
  // Asking again refreshes the one reference with the summary as it now stands.
  await call<PageMethods, 'module.output'>(frame, 'module.output', {
    name: 'summary',
    value: '1 task fits 25 minutes',
  })
  await press(named('Ask about Focus'))
  const again = useComposerReferences.getState().references
  expect(again).toHaveLength(1)
  expect(again[0]?.location.resource).toMatchObject({
    summary: '1 task fits 25 minutes',
  })
})

test('a running module reaches only what was granted, through the page’s own session', async () => {
  const { container, queryClient } = await place()
  // Anything the page read of the instance is read again after a write.
  const shown = [...capabilityKeys.instance('tracker/main'), 'read before']
  queryClient.setQueryData(shown, 'as read before')
  await press(button(container, 'Run it'))
  const frame = await frameOf(container)
  const queried = await call<PageMethods, 'capability.query'>(
    frame,
    'capability.query',
    { instanceId: 'tracker/main', viewKey: 'next' },
  )
  expect(queried.ok).toBe(true)
  const { csrfToken } = await bootstrap()
  expect(sentTo('/query')[0]?.headers.get('X-CSRF-Token')).toBe(csrfToken)
  expect(JSON.stringify(queried)).not.toContain(csrfToken)
  const invoked = await call<PageMethods, 'capability.invoke'>(
    frame,
    'capability.invoke',
    {
      instanceId: 'tracker/main',
      actionKey: 'complete',
      recordId: 'rec-1',
      expectedRevision: 6,
      inputs: {},
    },
  )
  expect(invoked.ok).toBe(true)
  expect(sentTo('/invoke')).toHaveLength(1)
  await waitFor(() => queryClient.getQueryState(shown)?.isInvalidated)
  const refused = await call<PageMethods, 'capability.invoke'>(
    frame,
    'capability.invoke',
    { instanceId: 'tracker/main', actionKey: 'assign', inputs: {} },
  ).then(
    () => 'allowed',
    (error: unknown) => (error as Error).message,
  )
  expect(refused).toContain(
    'the action "assign" of "tracker/main" is not among',
  )
  expect(sentTo('/invoke')).toHaveLength(1)
})

test('a module whose frame reports an error gives way to its fallback until it is run again', async () => {
  const { container } = await place()
  await press(button(container, 'Run it'))
  const frame = await frameOf(container)
  await call<PageMethods, 'frame.error'>(frame, 'frame.error', {
    message: 'tasks is not defined',
    name: 'ReferenceError',
  })
  await waitFor(() => container.textContent.includes('Write the plan'))
  expect(container.textContent).toContain('tasks is not defined')
  expect(container.querySelector('iframe')).toBeNull()
  await press(button(container, 'Run'))
  await waitFor(() => container.querySelector('iframe'))
  expect(container.textContent).not.toContain('tasks is not defined')
})

test('a running module says so; Stop gives way to its fallback, Run starts it again, and an error says it stopped', async () => {
  const { container } = await place()
  await press(button(container, 'Run it'))
  await frameOf(container)
  // What the module's bar says it is doing.
  const says = (text: string) =>
    [...container.querySelectorAll('span')].some(
      (one) => one.textContent === text,
    )
  expect(says('Running in a sandbox')).toBe(true)
  expect(button(container, 'Run')).toBeUndefined()
  expect(button(container, 'Revoke')).toBeTruthy()

  await press(button(container, 'Stop'))
  expect(says('Stopped')).toBe(true)
  expect(container.querySelector('iframe')).toBeNull()
  await waitFor(() => container.textContent.includes('Write the plan'))
  expect(button(container, 'Stop')).toBeUndefined()

  await press(button(container, 'Run'))
  const frame = await frameOf(container)
  expect(says('Running in a sandbox')).toBe(true)
  expect(container.textContent).not.toContain('Write the plan')

  await call<PageMethods, 'frame.error'>(frame, 'frame.error', {
    message: 'tasks is not defined',
    name: 'ReferenceError',
  })
  await waitFor(() => says('Stopped by an error'))
  expect(container.textContent).toContain('Focus stopped: tasks is not defined')
  expect(button(container, 'Stop')).toBeUndefined()
})

test('a module with no fallback keeps running when its frame reports an error', async () => {
  const { container } = await place({ fallback: undefined })
  await press(button(container, 'Run it'))
  const frame = await frameOf(container)
  await call<PageMethods, 'frame.error'>(frame, 'frame.error', {
    message: 'tasks is not defined',
    name: 'ReferenceError',
  })
  // The error reached the host: had it been heard, the frame would be gone by now.
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(container.querySelector('iframe')).toBeTruthy()
  expect(
    [...container.querySelectorAll('span')].some(
      (one) => one.textContent === 'Running in a sandbox',
    ),
  ).toBe(true)
  expect(container.textContent).not.toContain('tasks is not defined')
})
