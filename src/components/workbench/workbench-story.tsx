// SOURCING: none — the story's fixture owner: an Adapter whose answers are committed constants, so the real wasm workbench draws with no network and no clock. It uses WorkbenchSurface; nothing else applies.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Adapter } from '@/lib/workbench/adapter'
import type { Completion, Effect, FileListing } from '@/lib/workbench/wire'
import { WorkbenchSurface } from './workbench'
import type { Dispatch, SemanticsFeed } from './workbench'

/** What the fixture host reports it can do: the files owner only, so the picker lists the rest as unavailable. */
const FILES_ONLY = ['files']

/** The picker story's host can serve every tool the picker lists, so its rows are all live, as in the reference. */
const EVERY_TOOL = ['files', 'scm', 'terminal', 'documents', 'conversation']

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
function fixtureAdapter(
  dispatch: Dispatch,
  granted: string[],
  performed: (kind: string) => void,
): Adapter {
  let live = true
  queueMicrotask(() => {
    if (!live) return
    dispatch({
      channel: 'host',
      type: 'workspaceChanged',
      workspace: 'story-workspace',
      environment: 'story',
    })
    dispatch({
      channel: 'host',
      type: 'capabilitiesChanged',
      capabilities: { granted },
    })
  })
  return {
    perform(effect: Effect) {
      performed(effect.kind)
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
      queueMicrotask(
        () => live && dispatch({ channel: 'completion', ...completion }),
      )
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

/** What the story waits to see: the fixture tree's last file, and the picker's last row. */
const SHOWN = ['README.md', 'More tools']

/** Calls `onShown` two frames after the semantic tree has named everything the story waits to see. */
function ReadyWhenShown({
  feed,
  onShown,
}: {
  feed: SemanticsFeed
  onShown: () => void
}) {
  useEffect(() => {
    let seen = feed.latest ?? ''
    let frames: number[] = []
    let done = false
    const check = () => {
      if (done || !SHOWN.every((text) => seen.includes(text))) return
      done = true
      frames = [
        requestAnimationFrame(() => {
          frames = [requestAnimationFrame(onShown)]
        }),
      ]
    }
    check()
    const stop = feed.subscribe((update) => {
      seen += update
      check()
    })
    return () => {
      stop()
      frames.forEach(cancelAnimationFrame)
    }
  }, [feed, onShown])
  return null
}

/**
 * The real wasm workbench over the fixture host at a fixed size: no network, no clock. The picker is
 * opened with its chord once the first frame is on the page. `data-last-effect` names the kind of the
 * last effect the core asked the host for, which is how a story shows a pointer or key reached it.
 */
function FixtureStory({
  id,
  width,
  height,
  granted,
}: {
  id: string
  width: number
  height: number
  granted: string[]
}) {
  const box = useRef<HTMLDivElement>(null)
  const [lastEffect, setLastEffect] = useState<string>()
  const connect = useCallback(
    (dispatch: Dispatch) => fixtureAdapter(dispatch, granted, setLastEffect),
    [granted],
  )
  // Pending until the first frame is on the page, the picker's chord has been sent, and the semantic
  // tree (published with each frame) has carried both the first listing's row and the picker's last
  // row; then two more frames, so what the tree named is on the page.
  const [drawn, setDrawn] = useState(false)
  const [ready, setReady] = useState(false)
  const markReady = useCallback(() => setReady(true), [])
  useEffect(() => {
    if (!drawn) return
    const element = box.current?.querySelector<HTMLElement>('[id^=workbench-]')
    if (element) openPicker(element.parentElement ?? element)
  }, [drawn])
  return (
    <div
      ref={box}
      data-workbench-story={id}
      data-story-pending={ready ? undefined : ''}
      data-last-effect={lastEffect}
      style={{ width, height }}
      className="flex flex-col overflow-hidden"
    >
      <WorkbenchSurface connect={connect} onDrawn={() => setDrawn(true)}>
        {(feed) => <ReadyWhenShown feed={feed} onShown={markReady} />}
      </WorkbenchSurface>
    </div>
  )
}

/** `workbench-default`: Files, main and tools at 1280x640, the picker open in the tools region. */
export function WorkbenchDefaultStory() {
  return (
    <FixtureStory
      id="workbench-default"
      width={1280}
      height={640}
      granted={FILES_ONLY}
    />
  )
}

/**
 * `workbench-picker`: the tool picker in a tools pane wide enough for two columns (the core's fit
 * rule needs 86 cells), beside Files and the main page, every tool live.
 */
export function WorkbenchPickerStory() {
  return (
    <FixtureStory
      id="workbench-picker"
      width={PICKER_WIDTH}
      height={PICKER_HEIGHT}
      granted={EVERY_TOOL}
    />
  )
}

export const PICKER_WIDTH = 2304
export const PICKER_HEIGHT = 512
