// SOURCING: none — the story's fixture owner: an Adapter whose answers are committed constants, so the real wasm workbench draws with no network and no clock. It uses WorkbenchSurface; nothing else applies.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Adapter } from '@/lib/workbench/adapter'
import type { Completion, Effect, FileListing } from '@/lib/workbench/wire'
import { WorkbenchSurface } from './workbench'
import type { Dispatch } from './workbench'

/** What the fixture host reports it can do: the files owner only, so the picker lists the rest as unavailable. */
const GRANTED = ['files']

type Entries = FileListing['entries']

/** The fixture workspace's tree, by directory path: folders, files, one ignored, one hidden, one symlink. */
const TREE: Record<string, Entries> = {
  '': [
    { name: 'src', kind: 'directory' },
    { name: 'docs', kind: 'directory' },
    { name: 'node_modules', kind: 'directory', ignored: true },
    { name: '.github', kind: 'directory', hidden: true },
    { name: 'latest', kind: 'symlink' },
    { name: 'Cargo.toml', kind: 'file' },
    { name: 'README.md', kind: 'file' },
    { name: 'package.json', kind: 'file' },
  ],
  src: [
    { name: 'components', kind: 'directory' },
    { name: 'lib.rs', kind: 'file' },
    { name: 'main.rs', kind: 'file' },
  ],
  'src/components': [
    { name: 'button.rs', kind: 'file' },
    { name: 'panel.rs', kind: 'file' },
  ],
  docs: [
    { name: 'architecture.md', kind: 'file' },
    { name: 'notes.md', kind: 'file' },
  ],
  node_modules: [{ name: 'left-pad', kind: 'directory', ignored: true }],
  '.github': [{ name: 'workflows', kind: 'directory', hidden: true }],
}

/** A path as the tree keys it: no leading `./` or `/`, no trailing `/`. */
const treeKey = (path: string) =>
  path.replace(/^\.?\/*/, '').replace(/\/+$/, '')

/**
 * An adapter with one owner behind it: the fixed file tree above, answering `filesList`. Every
 * other effect is refused with `owner_unavailable`, as the real adapter answers an owner that
 * does not exist. The workspace and the capability set are announced once.
 */
function fixtureAdapter(dispatch: Dispatch): Adapter {
  let live = true
  queueMicrotask(() => {
    if (!live) return
    dispatch({
      type: 'workspaceChanged',
      workspace: 'story-workspace',
      environment: 'story',
    })
    dispatch({
      type: 'capabilitiesChanged',
      capabilities: { granted: GRANTED },
    })
  })
  return {
    perform(effect: Effect) {
      const listing =
        effect.kind === 'filesList'
          ? TREE[treeKey(effect.payload.path)]
          : undefined
      const completion: Completion = listing
        ? {
            effect: effect.id,
            resource: effect.resource,
            outcome: { status: 'accepted' },
            payload: { type: 'files', entries: listing, partial: false },
          }
        : {
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
  // Pending until the first frame is on the page and the picker's chord has been sent.
  const [drawn, setDrawn] = useState(false)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!drawn) return
    const element = box.current?.querySelector<HTMLElement>('[id^=workbench-]')
    if (!element) return
    openPicker(element.parentElement ?? element)
    // The chord's frame and the listing's: two animation frames after the input.
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setReady(true))
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
    }
  }, [drawn])
  return (
    <div
      ref={box}
      data-workbench-story="workbench-default"
      data-story-pending={ready ? undefined : ''}
      className="flex h-[640px] w-[1280px] flex-col overflow-hidden"
    >
      <WorkbenchSurface connect={connect} onDrawn={() => setDrawn(true)} />
    </div>
  )
}
