// SOURCING: none — the stories' scripted fixture workbench: the real wasm workbench over createFixtureHost, driven by real key events and typed text on its own input surface. It uses WorkbenchSurface; nothing else applies.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createFixtureHost } from './fixture-host'
import type { FixtureHost, FixtureOptions } from './fixture-host'
import { FILES_TREE } from './fixtures'
import { WorkbenchSurface } from './workbench'
import type { Dispatch, SemanticsFeed } from './workbench'

/** What the picker lists as live: every tool the fixture host can serve. */
const EVERY_TOOL = [
  'files',
  'environment',
  'documents',
  'scm',
  'terminal',
  'terminal.native',
  'conversation',
  'conversation.side',
  'scm.commit.amend',
  'language',
  'search.query',
  'diagnostics.subscribe',
  'run.start',
  'run.subscribe',
  'run.list',
]

/** What the first stories' host can do: the files owner only, so the picker lists the rest as unavailable. */
const FILES_ONLY = ['files']

/**
 * One scripted step, performed as a person would: a chord or key on the host, text into the input
 * surface, a wait for the semantic tree to name something, or a call on the fixture host.
 */
export type Step =
  | { chord: 'e' | 't' | 'g' | 's' }
  | { key: string; shift?: boolean; ctrl?: boolean; alt?: boolean }
  | { text: string }
  | { see: string }
  /** A person's drag, in pixels of the host: mouse down at `from`, moves, mouse up at `to`. */
  | { drag: { from: [number, number]; to: [number, number] } }
  | { host: (host: FixtureHost) => void }

const mac = () => /Mac/.test(navigator.platform)

function press(
  target: HTMLElement,
  init: KeyboardEventInit & { key: string },
) {
  target.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
  )
}

function drag(
  target: HTMLElement,
  { from, to }: { from: [number, number]; to: [number, number] },
) {
  const rect = target.getBoundingClientRect()
  const at = ([x, y]: [number, number], buttons: number) => ({
    bubbles: true,
    cancelable: true,
    clientX: rect.left + x,
    clientY: rect.top + y,
    button: 0,
    buttons,
  })
  target.dispatchEvent(new MouseEvent('mousedown', { ...at(from, 1), detail: 1 }))
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    const point: [number, number] = [
      from[0] + ((to[0] - from[0]) * i) / steps,
      from[1] + ((to[1] - from[1]) * i) / steps,
    ]
    target.dispatchEvent(new PointerEvent('pointermove', at(point, 1)))
  }
  target.dispatchEvent(new PointerEvent('pointerup', at(to, 0)))
}

function type(input: HTMLTextAreaElement, text: string) {
  input.focus()
  input.value = text
  input.dispatchEvent(
    new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }),
  )
}

const frames = (count: number) =>
  new Promise<void>((resolve) => {
    const next = (left: number) =>
      requestAnimationFrame(() => (left <= 1 ? resolve() : next(left - 1)))
    next(count)
  })

/** Resolves once the semantic tree has named `text`, or after a generous bound so a story never hangs. */
function seen(feed: SemanticsFeed, text: string) {
  return new Promise<void>((resolve) => {
    let all = feed.latest ?? ''
    if (all.includes(text)) return resolve()
    const stop = feed.subscribe((update) => {
      all += update
      if (all.includes(text)) {
        stop()
        resolve()
      }
    })
    setTimeout(() => {
      stop()
      resolve()
    }, 8000)
  })
}

/**
 * The real wasm workbench over the fixture host at a fixed size: no network, no clock. After the
 * first frame the script runs, one step at a time, with two frames of rest after each; the story is
 * pending until the script is done and the semantic tree names every text in `wait`.
 * `data-last-effect` names the kind of the last effect the core asked the host for.
 */
function FixtureStory({
  id,
  width,
  height,
  options,
  script,
  wait,
}: {
  id: string
  width: number
  height: number
  options: Omit<FixtureOptions, 'performed'>
  script: Step[]
  /** What the semantic tree must name before the story is ready. */
  wait: string[]
}) {
  const box = useRef<HTMLDivElement>(null)
  const feedRef = useRef<SemanticsFeed>(undefined)
  const hostRef = useRef<FixtureHost>(undefined)
  const [lastEffect, setLastEffect] = useState<string>()
  const [drawn, setDrawn] = useState(false)
  const [ready, setReady] = useState(false)
  const connect = useCallback(
    (dispatch: Dispatch) => {
      const host = createFixtureHost(dispatch, {
        ...options,
        performed: setLastEffect,
      })
      hostRef.current = host
      return host
    },
    // The options of a story are constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  useEffect(() => {
    if (!drawn) return
    const root = box.current
    const feed = feedRef.current
    const fixture = hostRef.current
    const element = root?.querySelector<HTMLElement>('[id^=workbench-]')
    const input = root?.querySelector('textarea')
    if (!root || !feed || !fixture || !element || !input) return
    const stop = new AbortController()
    void (async () => {
      for (const step of script) {
        if (stop.signal.aborted) return
        if ('chord' in step)
          press(element, {
            key: step.chord,
            altKey: true,
            metaKey: mac(),
            ctrlKey: !mac(),
          })
        else if ('key' in step)
          press(element, {
            key: step.key,
            shiftKey: step.shift,
            ctrlKey: step.ctrl,
            altKey: step.alt,
          })
        else if ('text' in step) type(input, step.text)
        else if ('see' in step) await seen(feed, step.see)
        else if ('drag' in step) drag(element, step.drag)
        else step.host(fixture)
        await frames(3)
      }
      for (const text of wait) await seen(feed, text)
      await frames(2)
      if (!stop.signal.aborted) setReady(true)
    })()
    return () => {
      stop.abort()
    }
    // The script runs once, after the first frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn])
  return (
    <div
      ref={box}
      data-workbench-story={id}
      data-story-pending={ready ? undefined : ''}
      data-last-effect={lastEffect}
      style={{ width, height }}
      className="flex flex-col overflow-hidden bg-term"
    >
      <WorkbenchSurface connect={connect} onDrawn={() => setDrawn(true)}>
        {(feed) => {
          feedRef.current = feed
          return null
        }}
      </WorkbenchSurface>
    </div>
  )
}

/** `workbench-default`: Files, the conversation and tools at 1280x640, a fresh workbench: the picker rests in the tool group and the composer has the focus. */
export function WorkbenchDefaultStory() {
  return (
    <FixtureStory
      id="workbench-default"
      width={1280}
      height={640}
      options={{ granted: FILES_ONLY, transcript: true }}
      script={[]}
      wait={['README.md', 'More tools', 'Allow']}
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
      options={{ granted: EVERY_TOOL }}
      script={[]}
      wait={['README.md', 'More tools']}
    />
  )
}

/** `workbench-files`: the tree with a symlink, an ignored and a hidden entry and a partial listing, opened a level down. */
export function WorkbenchFilesStory() {
  return (
    <FixtureStory
      id="workbench-files"
      width={1280}
      height={640}
      options={{ granted: ['files'], tree: FILES_TREE }}
      script={[
        { chord: 'e' },
        { see: 'README.md' },
        { key: 'ArrowDown' },
        { key: 'Enter' },
        { key: 'ArrowDown' },
        { key: 'ArrowDown' },
        { key: 'Enter' },
        { see: 'architecture.md' },
      ]}
      wait={['latest', 'target', 'architecture.md']}
    />
  )
}

/**
 * `workbench-terminal`: a recorded byte stream replayed through the process pane: a prompt, `ls`
 * in colour, a pager that takes the alternate screen and gives it back, a full-screen program, and a
 * resize the script sends once the program is up.
 */
export function WorkbenchTerminalStory() {
  return (
    <FixtureStory
      id="workbench-terminal"
      width={1280}
      height={640}
      options={{
        granted: EVERY_TOOL,
        terminal: true,
      }}
      script={[
        { chord: 's' },
        { see: 'Existing sessions' },
        { key: 'Enter' },
        { see: 'PID' },
        { host: (host) => host.resizeTerminal() },
        { see: 'resized to fit' },
      ]}
      wait={['resized to fit']}
    />
  )
}

/** `workbench-editor`: a file with tabs, CJK, a ZWJ emoji and a long wrapped line, a selection, and some typing. */
export function WorkbenchEditorStory() {
  return (
    <FixtureStory
      id="workbench-editor"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL }}
      script={EDITOR_SCRIPT}
      wait={['Notes']}
    />
  )
}

/** `workbench-editor-conflict`: the same file with the disk changed under it, the conflict the editor names. */
export function WorkbenchEditorConflictStory() {
  return (
    <FixtureStory
      id="workbench-editor-conflict"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL, conflict: 'docs/notes.txt' }}
      script={EDITOR_SCRIPT.slice(0, EDITOR_OPEN)}
      wait={['Notes']}
    />
  )
}

/** The Files steps that open `docs/notes.txt` into the editor. */
const EDITOR_OPEN = 10
const EDITOR_SCRIPT: Step[] = [
  { chord: 'e' },
  { see: 'README.md' },
  { key: 'ArrowDown' },
  { key: 'ArrowDown' },
  { key: 'Enter' },
  { see: 'architecture.md' },
  { key: 'ArrowDown' },
  { key: 'ArrowDown' },
  { key: 'ArrowDown' },
  { key: 'Enter' },
  { see: 'Notes' },
  { key: 'ArrowRight', shift: true },
  { key: 'ArrowRight', shift: true },
  { key: 'ArrowRight', shift: true },
]

/** The Files steps that open `docs/guide.md` into the Markdown panel. */
const MARKDOWN_OPEN: Step[] = [
  { chord: 'e' },
  { see: 'README.md' },
  { key: 'ArrowDown' },
  { key: 'ArrowDown' },
  { key: 'Enter' },
  { see: 'architecture.md' },
  { key: 'ArrowDown' },
  { key: 'ArrowDown' },
  { key: 'Enter' },
  { see: 'Workbench guide' },
]

/** The Markdown panel in one of its four modes (Alt+1 to Alt+4) over the same document. */
/**
 * The tool group's splitter, dragged left the way a person would: the group is about 43 columns
 * by default and Split needs 60, and the main page keeps its own minimum.
 */
const WIDEN_TOOLS: Step = { drag: { from: [931, 300], to: [720, 300] } }

function MarkdownStory({
  id,
  mode,
  wide = false,
}: {
  id: string
  mode: '1' | '2' | '3' | '4'
  wide?: boolean
}) {
  return (
    <FixtureStory
      id={id}
      width={1280}
      height={700}
      options={{ granted: EVERY_TOOL }}
      script={[...MARKDOWN_OPEN, ...(wide ? [WIDEN_TOOLS] : []), { key: mode, alt: true }]}
      wait={['Workbench guide']}
    />
  )
}

export const WorkbenchMarkdownVisualStory = () => (
  <MarkdownStory id="workbench-markdown-visual" mode="1" />
)
export const WorkbenchMarkdownSourceStory = () => (
  <MarkdownStory id="workbench-markdown-source" mode="2" />
)
export const WorkbenchMarkdownSplitStory = () => (
  <MarkdownStory id="workbench-markdown-split" mode="3" wide />
)
export const WorkbenchMarkdownPreviewStory = () => (
  <MarkdownStory id="workbench-markdown-preview" mode="4" wide />
)

/** `workbench-branches`: a reply with a second branch, switched to with Alt+] through the conversation owner. */
export function WorkbenchBranchesStory() {
  return (
    <FixtureStory
      id="workbench-branches"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL, transcript: true, branches: true }}
      script={[
        { see: 'branch 1 of 2' },
        { key: ']', alt: true },
        { see: 'On the other branch' },
      ]}
      wait={['branch 2 of 2']}
    />
  )
}

/** The picker's route to a tool in More tools: its chord, "More tools" and the tool's name typed into the filter, each with Enter. */
const open = (name: string): Step[] => [
  { chord: 't' },
  { text: 'More tools' },
  { key: 'Enter' },
  { text: name },
  { key: 'Enter' },
]

/** `workbench-search`: a query with matches in two files, one with CJK before the match. */
export function WorkbenchSearchStory() {
  return (
    <FixtureStory
      id="workbench-search"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL }}
      script={[
        ...open('Search'),
        { see: 'Search' },
        { text: 'cell' },
        { key: 'Enter' },
        { see: 'grid.rs' },
      ]}
      wait={['grid.rs', 'guide.md']}
    />
  )
}

/** The Files steps that open the two documents the diagnostics story reports on. */
const DIAGNOSTICS_OPEN: Step[] = [
  ...EDITOR_SCRIPT.slice(0, EDITOR_OPEN),
  { chord: 'e' },
  { key: 'ArrowUp' },
  { key: 'Enter' },
  { see: 'Workbench guide' },
]

/** `workbench-diagnostics`: two open documents with a finding of each severity. */
export function WorkbenchDiagnosticsStory() {
  return (
    <FixtureStory
      id="workbench-diagnostics"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL, diagnostics: true }}
      script={[...DIAGNOSTICS_OPEN, ...open('Diagnostics')]}
      wait={['Unknown name', 'Add the date']}
    />
  )
}

/** The Tab presses from a fresh Run panel's name field to its output, and `l` for the list. */
const RUN_LIST: Step[] = [
  ...open('Run output'),
  { see: 'Run' },
  { key: 'Tab' },
  { key: 'Tab' },
  { key: 'l' },
]

/** `workbench-run`: a finished run listed by the host, attached, with colour in its output. */
export function WorkbenchRunStory() {
  return (
    <FixtureStory
      id="workbench-run"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL }}
      script={[...RUN_LIST, { see: 'tests' }, { key: 'ArrowDown' }, { key: 'Enter' }, { see: 'FAILED' }]}
      wait={['test result']}
    />
  )
}

/** `workbench-run-list`: the list of runs the host gave, before one is attached. */
export function WorkbenchRunListStory() {
  return (
    <FixtureStory
      id="workbench-run-list"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL }}
      script={RUN_LIST}
      wait={['tests', 'build']}
    />
  )
}

/** `workbench-changes`: staged, unstaged, untracked and conflicted groups, a diff open, and a commit draft. */
export function WorkbenchChangesStory() {
  return (
    <FixtureStory
      id="workbench-changes"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL }}
      script={[
        { chord: 'g' },
        { see: 'Cargo.toml' },
        { key: 'ArrowDown' },
        { key: 'Enter' },
        { see: '@@' },
        { key: 'c' },
        { text: 'fix(files): list a partial directory' },
      ]}
      wait={['Cargo.toml', '@@']}
    />
  )
}

export const PICKER_WIDTH = 2304
export const PICKER_HEIGHT = 512
