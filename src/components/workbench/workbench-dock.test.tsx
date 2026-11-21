// SOURCING: none — bun:test over ./dock-geometry and ./workbench-dock, rendered into happy-dom through test/blocks/render with the real shell state; a stub stands in for the wasm workbench
import { afterEach, describe, expect, test } from 'bun:test'
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import { act, useState } from 'react'
import { useShell } from '@/components/shell/shell-state'
import { dockMaxWidth, dockMinWidth } from './dock-geometry'
import type { Placement } from './placement'
import { WorkbenchDock } from './workbench-dock'
import { cleanup, click, render } from '../../../test/blocks/render'

test('the resize bounds keep the conversation minimum at a narrow viewport', () => {
  expect(dockMaxWidth(700)).toBe(280)
  expect(dockMinWidth(700)).toBe(280)
  expect(dockMaxWidth(1200)).toBe(780)
  expect(dockMinWidth(1200)).toBe(360)
  expect(dockMaxWidth(390)).toBe(0)
  expect(dockMinWidth(390)).toBe(0)
})

const initial = useShell.getState()
afterEach(async () => {
  await cleanup()
  useShell.setState(initial, true)
  localStorage.removeItem('theorem-ui:shell')
})

type View = { shown: boolean; companion: boolean }

/**
 * The shell's row as chat-shell draws it: the conversation column the
 * Workspace attaches to, and the Workspace, placed where the shell state says.
 */
function Shell({ seen }: { seen: (view: View) => void }) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const choice = useShell((s) => s.workbench)
  const placement: Placement | undefined =
    choice === undefined || choice === 'closed' ? undefined : choice
  return (
    <div ref={setFrame} data-testid="frame">
      <div data-workbench-anchor="" data-testid="conversation">
        conversation
      </div>
      <WorkbenchDock placement={placement} frame={frame}>
        {(view) => {
          seen(view)
          return <div data-testid="workspace">workspace</div>
        }}
      </WorkbenchDock>
    </div>
  )
}

const doubleClick = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })

async function open(placement: Placement) {
  let view: View | undefined
  useShell.getState().setWorkbench(placement)
  const router = createRouter({
    routeTree: createRootRoute({
      component: () => <Shell seen={(next) => (view = next)} />,
    }),
    history: createMemoryHistory(),
  })
  await router.load()
  await render(<RouterProvider router={router} />)
  const by = (id: string) =>
    document.querySelector(`[data-testid="${id}"]`) as HTMLElement
  return {
    view: () => view,
    frame: by('frame'),
    conversation: by('conversation'),
    workspace: by('workspace'),
  }
}

describe('the Workspace is a drawer unless the person makes it part of the screen', () => {
  test('with no choice made, at the bottom it is a drawer that a double-click outside closes', async () => {
    const { conversation, workspace } = await open('bottom')
    expect(useShell.getState().workbenchAttachment).toBe('drawer')
    await doubleClick(workspace)
    expect(useShell.getState().workbench).toBe('bottom')
    await doubleClick(conversation)
    expect(useShell.getState().workbench).toBe('closed')
  })

  test('on the right it is a drawer as well, closed the same way', async () => {
    const { conversation } = await open('side')
    await doubleClick(conversation)
    expect(useShell.getState().workbench).toBe('closed')
  })

  test('a drawer covers the conversation, so the core is not told it stands beside it', async () => {
    const drawer = await open('bottom')
    expect(drawer.view()).toEqual({ shown: true, companion: false })
    await cleanup()
    useShell.getState().setWorkbenchAttachment('docked')
    const docked = await open('side')
    expect(docked.view()).toEqual({ shown: true, companion: true })
  })

  test('as part of the screen it stays open on a double-click outside', async () => {
    useShell.getState().setWorkbenchAttachment('docked')
    const { conversation } = await open('side')
    await doubleClick(conversation)
    expect(useShell.getState().workbench).toBe('side')
  })

  test('Bottom overlays the frame while preserving the Right docking preference', async () => {
    useShell.getState().setWorkbenchAttachment('docked')
    const side = await open('side')
    const region = side.frame.querySelector('[data-workbench-placement]')!
    const choose = (label: string) =>
      click(
        [...region.querySelectorAll('button')].find(
          (button) => button.textContent === label,
        )!,
      )

    await choose('Bottom')
    expect(region.getAttribute('data-workbench-attachment')).toBe('drawer')
    expect(region.classList.contains('absolute')).toBe(true)
    expect(side.view()).toEqual({ shown: true, companion: false })
    expect(useShell.getState().workbenchAttachment).toBe('docked')

    await choose('Right')
    expect(region.getAttribute('data-workbench-attachment')).toBe('docked')
    expect(side.view()).toEqual({ shown: true, companion: true })
  })
})
