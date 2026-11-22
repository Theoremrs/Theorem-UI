// SOURCING: bun:test; a vault module read from test/blocks/memory-workspace, placed as a page places
// it (useInstance under a PageRuntimeProvider) and rendered through VaultModule, with
// slice2-harness's stand-in for /api/capabilities/v1. The frame's side of the bridge is the port the
// page hands the frame when it says it is ready, so its calls reach the host the module really
// runs with; what is asserted is the fallback a person sees, the request each call sends and the
// envelope the composer carries.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as esbuild from 'esbuild-wasm'
import { act } from 'react'
import { memoryWorkspace } from '../../../test/blocks/memory-workspace'
import { cleanup, render, waitFor } from '../../../test/workspace'
import {
  button,
  install,
  named,
  press,
  sentTo,
  uninstall,
} from '@/components/capabilities/slice2-harness'
import { capabilityKeys } from '@/components/capabilities/queries'
import { useComposerReferences } from '@/components/chat/composer-references'
import * as hosted from '@/lib/blocks/hosted-app'
import { call, READY_MESSAGE, rpcOver } from '@/lib/blocks/sandbox/protocol'
import type { PageMethods, Rpc } from '@/lib/blocks/sandbox/protocol'
import { parseManifest } from '@/lib/modules/contract'
import { bootstrap } from '@/lib/theorem/client'
import { useModuleGrants } from '@/lib/modules/grants'
import { fromManifest } from '@/lib/modules/registry'
import type { ModuleDefinition } from '@/lib/modules/registry'
import type { WorkspaceClient } from '@/lib/workspace/types'
import {
  InstanceProvider,
  PageRuntimeProvider,
  useInstance,
} from './page-runtime'
import { VaultModule } from './sandboxed-module'

const FOLDER = 'Modules/focus'

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

function files(extra: Record<string, unknown> = {}) {
  const text = JSON.stringify({ ...manifest, ...extra })
  const definition = fromManifest(
    parseManifest(`${FOLDER}/module.json`, text),
    `${FOLDER}/module.json`,
  )
  const client = memoryWorkspace({
    [`${FOLDER}/module.json`]: text,
    [`${FOLDER}/index.html`]: source,
  })
  return { client: client as unknown as WorkspaceClient, definition }
}

function Placed({
  client,
  definition,
}: {
  client: WorkspaceClient
  definition: ModuleDefinition
}) {
  const view = useInstance(definition, { id: 'focus-1' }, false)
  return (
    <InstanceProvider path={view.path}>
      <VaultModule
        client={client}
        definition={definition}
        folder={FOLDER}
        entry="index.html"
        view={view}
      />
    </InstanceProvider>
  )
}

async function place(extra: Record<string, unknown> = {}) {
  const { client, definition } = files(extra)
  return render(
    <PageRuntimeProvider>
      <Placed client={client} definition={definition} />
    </PageRuntimeProvider>,
  )
}

/**
 * Says ready from the module's frame, as its bridge script does, and returns
 * the frame's end of the port the page answers with.
 */
async function frameOf(container: HTMLElement): Promise<Rpc> {
  const iframe = await waitFor(() => container.querySelector('iframe'), {
    timeout: 10_000,
  })
  // happy-dom loads no frame page, so the frame's window is a stand-in that
  // keeps the port the page sends it.
  let port: MessagePort | undefined
  const target = {
    postMessage: (
      _message: unknown,
      _origin: string,
      transfer?: Transferable[],
    ) => {
      port = transfer?.[0] as MessagePort
    },
  }
  Object.defineProperty(iframe, 'contentWindow', { value: target })
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: target as unknown as Window,
        data: { type: READY_MESSAGE },
      }),
    )
  })
  await waitFor(() => port)
  return rpcOver(port!)
}

const originalHosted = hosted.hostedAppDocument
// The frame's document is built as in the browser, with esbuild's Node build.
let building: { mockRestore: () => void } | undefined

beforeEach(() => {
  building = spyOn(hosted, 'hostedAppDocument').mockImplementation(
    (html, _esbuild, options) => originalHosted(html, esbuild, options),
  )
  install()
  useModuleGrants.setState({ grants: {} })
  useComposerReferences.setState({ references: [] })
})
afterEach(() => {
  cleanup()
  uninstall()
  building?.mockRestore()
})

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
