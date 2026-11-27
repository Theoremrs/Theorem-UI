import { afterEach, expect, spyOn, test } from 'bun:test'
import { act, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'
import type { TheoremArtifact } from './artifact-model'
import { useArtifactRuntimes } from './artifact-runtime'
import type { RuntimeRecord, RuntimeSurface } from './artifact-runtime'
import {
  ArtifactRuntimeHost,
  HostedArtifact,
  mountRuntimes,
  runtimeElement,
  RuntimeSurfaceContext,
  visibleArea,
} from './artifact-runtime-host'

let startups = 0
let stops = 0
function CounterRuntime({ runtime }: { runtime: RuntimeRecord }) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    startups++
    return () => {
      stops++
    }
  }, [])
  return (
    <div data-testid="runtime" data-for={runtime.id}>
      <button onClick={() => setCount((n) => n + 1)}>Count {count}</button>
      <iframe title="Counter frame" />
    </div>
  )
}
function SharedView({
  runtime,
  viewId,
}: {
  runtime: RuntimeRecord
  viewId: string
}) {
  return (
    <p data-testid="shared-view">
      {runtime.title} in {viewId.split(':')[0]}
    </p>
  )
}
mountRuntimes({
  'test-counter': { Runtime: CounterRuntime },
  'test-shared': { Runtime: () => null, shared: { View: SharedView } },
})

const artifact = (extra: Partial<TheoremArtifact> = {}): TheoremArtifact => ({
  partId: 'part-1',
  artifactId: 'counter',
  revision: '1',
  kind: 'app',
  rendererId: 'theorem-app',
  contractVersion: '1',
  lifecycle: 'ready',
  patchSequence: 1,
  title: 'Counter',
  content: '',
  language: undefined,
  fallbackText: 'Counter',
  payloadRef: undefined,
  runId: undefined,
  sourceTool: undefined,
  documentId: 'counter-doc',
  documentPosition: 1,
  ...extra,
})

function View({
  surface,
  renderer = 'test-counter',
  part,
}: {
  surface: RuntimeSurface
  renderer?: string
  part?: Partial<TheoremArtifact>
}) {
  return (
    <RuntimeSurfaceContext value={surface}>
      <HostedArtifact
        artifact={artifact(part)}
        documentId="counter-doc"
        renderer={renderer}
      />
    </RuntimeSurfaceContext>
  )
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      <ArtifactRuntimeHost />
      {children}
    </>
  )
}

afterEach(async () => {
  await cleanup()
  useArtifactRuntimes.getState().reset()
  startups = 0
  stops = 0
})

const frame = () =>
  document.querySelector<HTMLIFrameElement>('iframe[title="Counter frame"]')

test('a runtime starts once and keeps its element, state and identity as views attach, move and close (AR-08, AR-12)', async () => {
  const { rerender } = await render(
    <Shell>
      <View surface="inline" />
    </Shell>,
  )
  const iframe = await waitFor(frame)
  const element = iframe.closest<HTMLElement>('[data-slot="artifact-runtime"]')!
  const parent = element.parentNode
  const runtimeId = element.dataset.runtimeId
  await click(buttonNamed(document.body, 'Count 0')!)

  // A docked view arrives: passive, with the three choices.
  await rerender(
    <Shell>
      <View surface="inline" />
      <View surface="docked" />
    </Shell>,
  )
  const passive = await waitFor(() =>
    document.querySelector('[data-slot="artifact-runtime-passive"]'),
  )
  expect(passive.textContent).toContain('Running in its answer')
  expect(buttonNamed(passive, 'Move here')).toBeDefined()
  expect(buttonNamed(passive, 'Start a separate copy')).toBeDefined()

  await click(buttonNamed(passive, 'Move here')!)
  const docked = document.querySelector<HTMLElement>(
    '[data-slot="artifact-runtime-view"][data-interactive]',
  )!
  expect(docked.dataset.viewId).toStartWith('docked:')
  // The inline view is passive now, and says where the runtime went.
  expect(
    document.querySelector('[data-slot="artifact-runtime-passive"]')
      ?.textContent,
  ).toContain('Running in a panel')

  // Closing the docked view returns the runtime to the answer; nothing stopped.
  await rerender(
    <Shell>
      <View surface="inline" />
    </Shell>,
  )
  // And closing the answer too keeps it running, hidden.
  await rerender(<Shell>{null}</Shell>)
  await act(() => new Promise((resolve) => setTimeout(resolve, 30)))
  expect(element.dataset.visible).toBe('false')
  await rerender(
    <Shell>
      <View surface="docked" />
    </Shell>,
  )
  expect(startups).toBe(1)
  expect(stops).toBe(0)
  expect(frame()).toBe(iframe)
  expect(iframe.closest('[data-slot="artifact-runtime"]')).toBe(element)
  expect(element.parentNode).toBe(parent)
  expect(element.dataset.runtimeId).toBe(runtimeId)
  expect(buttonNamed(document.body, 'Count 1')).toBeDefined()
})

test('a separate copy starts its own runtime with lineage; the original keeps its state', async () => {
  await render(
    <Shell>
      <View surface="inline" />
      <View surface="docked" />
    </Shell>,
  )
  await waitFor(frame)
  await click(buttonNamed(document.body, 'Count 0')!)
  const passive = await waitFor(() =>
    document.querySelector('[data-slot="artifact-runtime-passive"]'),
  )
  await click(buttonNamed(passive, 'Start a separate copy')!)
  await waitFor(() => document.querySelectorAll('iframe').length === 2)
  expect(startups).toBe(2)
  const runtimes = Object.values(useArtifactRuntimes.getState().runtimes)
  const copy = runtimes.find((one) => !one.primary)!
  const original = runtimes.find((one) => one.primary)!
  expect(copy.lineage?.from).toBe(original.id)
  expect(runtimeElement(original.id)?.textContent).toContain('Count 1')
  expect(runtimeElement(copy.id)?.textContent).toContain('Count 0')
  // Each view says what it shows.
  expect(document.body.textContent).toContain('Separate copy, started from')
})

test('a renderer that implements shared interactive views draws one in every view', async () => {
  await render(
    <Shell>
      <View surface="inline" renderer="test-shared" />
      <View surface="docked" renderer="test-shared" />
    </Shell>,
  )
  const views = await waitFor(() => {
    const found = document.querySelectorAll('[data-testid="shared-view"]')
    return found.length === 2 && found
  })
  expect([...views].map((one) => one.textContent)).toEqual([
    'Counter in inline',
    'Counter in docked',
  ])
  expect(
    document.querySelector('[data-slot="artifact-runtime-passive"]'),
  ).toBeNull()
})

test('the host lays the runtime over its holder’s slot, clipped to what can be seen, and hides it with the slot', async () => {
  const rects = new Map<string, DOMRect>()
  const rect = spyOn(
    HTMLElement.prototype,
    'getBoundingClientRect',
  ).mockImplementation(function (this: HTMLElement) {
    return rects.get(this.dataset.slot ?? '') ?? new DOMRect(0, 0, 0, 0)
  })
  try {
    rects.set('artifact-runtime-slot', new DOMRect(40, 600, 300, 400))
    rects.set('scroller', new DOMRect(0, 0, 1024, 2000))
    await render(
      <Shell>
        <div data-slot="scroller" style={{ overflowY: 'auto' }}>
          <View surface="docked" />
        </div>
      </Shell>,
    )
    const element = await waitFor(() =>
      document.querySelector<HTMLElement>(
        '[data-slot="artifact-runtime"][data-visible="true"]',
      ),
    )
    expect(element.style.transform).toBe('translate(40px, 600px)')
    expect(element.style.width).toBe('300px')
    expect(element.style.height).toBe('400px')
    // The window is 768 high: the part of the slot below it is clipped.
    expect(element.style.clipPath).toBe(
      `inset(0px 0px ${600 + 400 - window.innerHeight}px 0px)`,
    )
    // The slot leaves the screen: the runtime is hidden, not stopped.
    rects.set('artifact-runtime-slot', new DOMRect(0, 0, 0, 0))
    await waitFor(() => element.dataset.visible === 'false')
    expect(element.inert).toBe(true)
    expect(startups).toBe(1)
    expect(stops).toBe(0)
  } finally {
    rect.mockRestore()
  }
})

test('what covers the scrolling content clips the runtime under it', () => {
  const scroller = document.createElement('div')
  const slot = document.createElement('div')
  const composer = document.createElement('div')
  composer.dataset.runtimeOccluder = ''
  scroller.append(slot, composer)
  document.body.append(scroller)
  const rect = spyOn(
    HTMLElement.prototype,
    'getBoundingClientRect',
  ).mockImplementation(function (this: HTMLElement) {
    return this === scroller
      ? new DOMRect(0, 0, 800, 700)
      : this === composer
        ? new DOMRect(0, 560, 800, 140)
        : new DOMRect(0, 0, 0, 0)
  })
  try {
    const visible = visibleArea(
      slot,
      { left: 20, top: 300, right: 620, bottom: 900 },
      [scroller],
    )
    expect(visible).toEqual({ left: 20, top: 300, right: 620, bottom: 560 })
  } finally {
    rect.mockRestore()
    scroller.remove()
  }
})
