// SOURCING: bun:test over the example custom component in test/fixtures/modules/focus, installed as
// vault files and placed through module-harness. Its own script runs against a window.theorem made
// of the bridge calls app-bridge.ts makes (capability.query/invoke, module.output, and the page's
// module.inputs), over the port the page hands the frame, so every call reaches the real host and
// slice2-harness's stand-in for /api/capabilities/v1. The fixture's markup is drawn in this
// document, where a person's click on its Complete is a click on the frame's own button.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { waitFor } from '../../../test/workspace'
import {
  button,
  named,
  press,
  sentTo,
  server,
} from '@/components/capabilities/slice2-harness'
import { useComposerReferences } from '@/components/chat/composer-references'
import { call, serve } from '@/lib/blocks/sandbox/protocol'
import type {
  CapabilityInvokeParams,
  CapabilityQueryParams,
  ModuleValues,
  PageMethods,
  Rpc,
  SandboxMethods,
} from '@/lib/blocks/sandbox/protocol'
import { parseManifest } from '@/lib/modules/contract'
import { bootstrap } from '@/lib/theorem/client'
import {
  FOLDER,
  beginModuleTest,
  endModuleTest,
  frameOf,
  placeModule,
} from './module-harness'

const fixture = join(import.meta.dir, '../../../test/fixtures/modules/focus')
const manifestText = await Bun.file(join(fixture, 'module.json')).text()
const source = await Bun.file(join(fixture, 'index.html')).text()

/** `window.theorem` as the frame's bridge gives it, for the parts the fixture uses. */
function theoremOver(rpc: Rpc) {
  const listeners = new Set<(values: ModuleValues) => void>()
  let last: ModuleValues | undefined
  serve<SandboxMethods, 'module.inputs'>(rpc, 'module.inputs', (values) => {
    last = values
    for (const listener of listeners) listener(values)
    return null
  })
  return {
    capability: {
      describe: (instanceId: string) =>
        call<PageMethods, 'capability.describe'>(rpc, 'capability.describe', {
          instanceId,
        }),
      query: (request: CapabilityQueryParams) =>
        call<PageMethods, 'capability.query'>(rpc, 'capability.query', request),
      invoke: (request: CapabilityInvokeParams) =>
        call<PageMethods, 'capability.invoke'>(
          rpc,
          'capability.invoke',
          request,
        ),
    },
    module: {
      onInputs(listener: (values: ModuleValues) => void) {
        listeners.add(listener)
        if (last) listener(last)
        return () => listeners.delete(listener)
      },
      output: (name: string, value: unknown) =>
        call<PageMethods, 'module.output'>(rpc, 'module.output', {
          name,
          value,
        }),
    },
  }
}

const drawn: HTMLElement[] = []

/** Draws the fixture's markup in a frame of this document and runs its script there. */
function runFixture(rpc: Rpc) {
  const theorem = theoremOver(rpc)
  const page = new DOMParser().parseFromString(source, 'text/html')
  const script = page.querySelector('script')!.textContent
  page.querySelector('script')!.remove()
  const frame = document.createElement('div')
  frame.setAttribute('data-frame', FOLDER)
  frame.innerHTML = page.body.innerHTML
  document.body.append(frame)
  drawn.push(frame)
  new Function('theorem', 'document', script)(theorem, document)
  return { theorem, frame }
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => 'allowed',
    (error: unknown) => (error as Error).message,
  )

beforeEach(beginModuleTest)
afterEach(() => {
  for (const frame of drawn.splice(0)) frame.remove()
  endModuleTest()
})

test('the focus fixture is a vault module that declares only what it reaches', () => {
  const parsed = parseManifest(`${FOLDER}/module.json`, manifestText)
  expect(parsed.capabilities.instances).toEqual([
    {
      instanceId: 'tracker/main',
      methods: ['query', 'invoke'],
      actions: ['complete'],
    },
  ])
  expect(parsed.agent?.summaryOutput).toBe('summary')
  expect(parsed.fallback).toEqual({
    kind: 'capability-records',
    instanceId: 'tracker/main',
    viewKey: 'next',
    actions: ['complete'],
  })
  expect(parsed.implementation).toEqual({
    kind: 'sandboxed-html',
    entry: 'index.html',
  })
})

test('before it is allowed, the fixture shows the tracker’s next tasks through its fallback', async () => {
  const { container } = await placeModule(manifestText, source)
  await waitFor(() => container.textContent.includes('Write the plan'))
  expect(container.textContent).toContain('Read records in tracker/main')
  expect(container.textContent).toContain('Run “complete” in tracker/main')
  expect(button(container, 'Complete')).toBeTruthy()
  expect(button(container, 'Assign')).toBeUndefined()
})

test('allowed, the fixture lists what fits, completes through the page, and an agent reads its summary', async () => {
  const { container } = await placeModule(manifestText, source)
  await press(button(container, 'Run it'))
  const rpc = await frameOf(container)
  // What the fallback read before it was allowed is not the fixture's.
  const earlier = sentTo('/query').length
  const { theorem, frame } = runFixture(rpc)

  // 25 minutes, the setting's default: only the 20-minute task fits; one with
  // no effort set is not counted as fitting.
  await waitFor(() => frame.textContent.includes('1 task fits 25 minutes'))
  expect(frame.textContent).toContain('Write the plan')
  expect(frame.textContent).not.toContain('Sketch the page')
  expect(
    sentTo('/query')
      .slice(earlier)
      .map((request) => request.body),
  ).toEqual([
    {
      instanceId: 'tracker/main',
      viewKey: 'next',
      limit: 50,
    },
  ])

  await press(frame.querySelector('[aria-label="Complete Write the plan"]'))
  await waitFor(() => sentTo('/invoke').length === 1)
  const [sent] = sentTo('/invoke')
  const { csrfToken } = await bootstrap()
  expect(sent?.headers.get('X-CSRF-Token')).toBe(csrfToken)
  expect(sent?.body).toMatchObject({
    instanceId: 'tracker/main',
    actionKey: 'complete',
    recordId: 'rec-1',
    expectedRevision: 6,
    inputs: {},
  })
  // It reads again after the write.
  await waitFor(() => sentTo('/query').length === earlier + 2)

  // What it was not allowed is refused at the bridge, before any route.
  const before = server.calls.length
  expect(await refusal(theorem.capability.describe('tracker/main'))).toContain(
    'capability.describe on "tracker/main" was not allowed',
  )
  expect(
    await refusal(theorem.capability.query({ instanceId: 'payroll/main' })),
  ).toContain(
    'capability("payroll/main") is not among the capability instances',
  )
  expect(
    await refusal(
      theorem.capability.invoke({
        instanceId: 'tracker/main',
        actionKey: 'assign',
        recordId: 'rec-1',
        inputs: { assignee: 'someone' },
      }),
    ),
  ).toContain('the action "assign" of "tracker/main" is not among')
  expect(server.calls.length).toBe(before)

  await press(named('Ask about Focus'))
  const [reference] = useComposerReferences.getState().references
  expect(reference?.location.resource).toMatchObject({
    kind: 'component',
    moduleId: 'vault.focus',
    selectedComponentId: 'focus-1',
    description: (
      JSON.parse(manifestText) as { agent: { description: string } }
    ).agent.description,
    summary: '1 task fits 25 minutes',
    instances: ['tracker/main'],
  })
})

test('allowed without Complete, the fixture’s Complete is refused at the bridge and says why', async () => {
  const { container } = await placeModule(manifestText, source)
  await waitFor(() => container.textContent.includes('Run “complete”'))
  // The person unticks the action before running it.
  const tick = [...container.querySelectorAll('label')]
    .find((label) => label.textContent.includes('Run “complete”'))
    ?.querySelector('input')
  await press(tick)
  await press(button(container, 'Run with what is ticked'))
  const { frame } = runFixture(await frameOf(container))
  await waitFor(() => frame.textContent.includes('1 task fits 25 minutes'))
  await press(frame.querySelector('[aria-label="Complete Write the plan"]'))
  // With no action left, invoke goes too: reading stays allowed.
  await waitFor(() =>
    frame.textContent.includes(
      'capability.invoke on "tracker/main" was not allowed',
    ),
  )
  expect(sentTo('/invoke')).toEqual([])
  expect(
    frame.querySelector<HTMLButtonElement>(
      '[aria-label="Complete Write the plan"]',
    )?.disabled,
  ).toBe(false)
})

test('the minutes the fixture fits tasks to are its own setting', async () => {
  const fifteen = JSON.parse(manifestText) as {
    settings: Array<{ name: string; default: unknown }>
  }
  fifteen.settings[0]!.default = 15
  const { container } = await placeModule(JSON.stringify(fifteen), source)
  await press(button(container, 'Run it'))
  const { frame } = runFixture(await frameOf(container))
  await waitFor(() => frame.textContent.includes('0 tasks fit 15 minutes'))
  expect(frame.textContent).not.toContain('Write the plan')
})
