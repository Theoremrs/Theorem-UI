// SOURCING: none — the story's fixture owner: an Adapter whose answers are committed constants, so the real wasm workbench draws with no network and no clock. It uses WorkbenchSurface; nothing else applies.
import { useCallback, useEffect, useRef } from 'react'
import type { Adapter } from '@/lib/workbench/adapter'
import type { Completion, Effect } from '@/lib/workbench/wire'
import { WorkbenchSurface } from './workbench'
import type { Dispatch } from './workbench'

/** What the fixture host reports it can do: the files owner only, so the picker lists the rest as unavailable. */
const GRANTED = ['files']

/**
 * An adapter with no owners behind it. Every effect is refused with `owner_unavailable`, as the real
 * adapter answers an owner that does not exist, and the capability set is announced once.
 */
function fixtureAdapter(dispatch: Dispatch): Adapter {
  let live = true
  queueMicrotask(() => {
    if (live)
      dispatch({
        type: 'capabilitiesChanged',
        capabilities: { granted: GRANTED },
      })
  })
  return {
    perform(effect: Effect) {
      const completion: Completion = {
        effect: effect.id,
        resource: effect.resource,
        outcome: {
          status: 'refused',
          code: 'owner_unavailable',
          reason: 'This story has no owners',
        },
      }
      queueMicrotask(() => live && dispatch(completion))
    },
    dispose() {
      live = false
    },
  }
}

/** The tool picker's chord, `Mod+Alt+T`: Cmd on a Mac, Ctrl elsewhere (the core's own table). */
function openPicker(host: HTMLElement) {
  const mac = /Mac/.test(navigator.platform)
  host.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 't',
      altKey: true,
      metaKey: mac,
      ctrlKey: !mac,
      bubbles: true,
    }),
  )
}

/**
 * `workbench-default`: Files, main and tools at a fixed size, the picker open in the tools region.
 * Deterministic: a fixed box, a fixture host, no clock.
 */
export function WorkbenchDefaultStory() {
  const box = useRef<HTMLDivElement>(null)
  const connect = useCallback(
    (dispatch: Dispatch) => fixtureAdapter(dispatch),
    [],
  )
  const opened = useRef(false)
  useEffect(() => {
    const element = box.current?.querySelector<HTMLElement>('[id^=workbench-]')
    if (!element || opened.current) return
    // The wasm loads asynchronously; the chord goes in once its first frame has a grid.
    const timer = setInterval(() => {
      if (element.childElementCount === 0) return
      clearInterval(timer)
      opened.current = true
      openPicker(element.parentElement ?? element)
    }, 50)
    return () => clearInterval(timer)
  }, [])
  return (
    <div
      ref={box}
      data-workbench-story="workbench-default"
      className="flex h-[640px] w-[1280px] flex-col overflow-hidden"
    >
      <WorkbenchSurface connect={connect} />
    </div>
  )
}
