// SOURCING: the agent terminal's own crate (terminal/src/command.rs, built into src/terminal-wasm): in the reply where a call ran a command (chat/theorem-parts' tool-call slot, and a host call's part, which the server rewrites with what the command has printed while it runs), Ratzilla draws the command on the prompt's line and what it printed through the VT interpreter the workbench's process panes use; loadWasm from terminal-screen loads it and paints it in the workspace's terminal colours; the frame is the assistant-ui elements' response frame (surfaces). It opens and closes as assistant-ui's Reasoning element does (open while it works, closed after unless the reader chose), the crate drawing the shimmer, the clock and the chevron; framer-motion's useReducedMotion holds the shimmer still. While output streams it takes the column so wider lines never widen it, lines past the fold slide in as the crate reports the scroll, and what the work moves glides while the reader's own clicks spring.
import { useReducedMotion } from 'framer-motion'
import { useEffect, useId, useRef, useState } from 'react'
import { responseFrame } from '@/components/assistant-ui/elements/surfaces'
import { cn } from '@/lib/utils'
import type { CommandHandle } from '@/terminal-wasm/theorem_terminal'
import type { CallState } from '@/components/chat/theorem-parts'
import { loadWasm } from './terminal-screen'
import './cell-grid.css'

/** The crate's fold, for the first guess at the height before the crate says. */
const FOLD = 6
/** The prompt the crate draws before the command (terminal/src/lib.rs PROMPT). */
const PROMPT_COLS = 2
/** The crate's margin, a column at each side. */
const MARGIN_COLS = 2
/** The narrowest the terminal is drawn, so a short command still reads as one. */
const MIN_COLS = 20
/** The crate's time before the ending ("4m 12s "), kept whole so the terminal does not widen as it counts. */
const TIME_COLS = 7
/** The chevron after the ending (" ▸"). */
const CHEVRON_COLS = 2
/** Escape sequences, which take no columns on the screen. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

const STATUS: Record<CallState, string> = {
  running: 'running',
  awaiting: 'awaiting',
  done: 'complete',
  failed: 'error',
  interrupted: 'interrupted',
}

/** A command a call ran, and what it printed: stderr apart when the result keeps it apart. */
export interface CommandRun {
  command: string
  stdout: string
  stderr: string
  exitCode: number | undefined
}

type Json = Record<string, unknown>
const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {}
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The command a call runs, read from the `command` its arguments carry; none when it carries none. */
export function readCommand(
  args: unknown,
  result: unknown,
): CommandRun | undefined {
  const given = object(args).command ?? object(args).cmd
  const command = Array.isArray(given)
    ? given.filter((word) => typeof word === 'string').join(' ')
    : str(given)
  if (!command) return undefined
  const fields = object(result)
  const printed =
    typeof result === 'string'
      ? result
      : (fields.stdout ?? fields.output ?? fields.text)
  return {
    command,
    stdout: str(printed) ?? '',
    stderr: str(fields.stderr) ?? '',
    exitCode: num(fields.exitCode ?? fields.exit_code ?? fields.code),
  }
}

/**
 * The command a host call runs, as its `theorem-host_call` part carries it:
 * the server rewrites the part with what the command has printed so far while
 * it runs, and with how it ended once it has. None for any other call.
 */
export function readHostCommand(call: unknown): CommandRun | undefined {
  const terminal = object(object(call).terminal)
  const command = str(terminal.command)
  if (!command) return undefined
  return {
    command,
    stdout: typeof terminal.stdout === 'string' ? terminal.stdout : '',
    stderr: typeof terminal.stderr === 'string' ? terminal.stderr : '',
    exitCode: num(terminal.exitCode),
  }
}

export interface CommandTerminalProps extends CommandRun {
  state: CallState
  className?: string
}

/** Whether it printed anything a terminal shows (the crate's `has_output`). */
export const printedAnything = ({
  stdout,
  stderr,
}: Pick<CommandRun, 'stdout' | 'stderr'>) =>
  [stdout, stderr].some((text) => text.replace(/[\r\n]+$/, '') !== '')

/**
 * Whether its output shows under it: as the reader last chose, or else while
 * the command works and when it went wrong. A command that ended well closes
 * to its line, as the Reasoning element closes once it has thought.
 */
export function outputShows(
  state: CallState,
  printed: boolean,
  chosen?: boolean,
): boolean {
  return printed && (chosen ?? state !== 'done')
}

/**
 * The columns the terminal takes: its widest line, the command with how it
 * ended (as terminal/src/command.rs lays out the prompt's line) or a line it
 * printed, inside the crate's margin. The terminal is drawn that wide, so a
 * short command is a short terminal. `timed` keeps room for the time the
 * crate counts once it has seen the command run.
 */
export function terminalColumns(
  {
    command,
    state,
    stdout,
    stderr,
    exitCode,
  }: Omit<CommandTerminalProps, 'className'>,
  timed = false,
): number {
  const ending =
    state !== 'running' &&
    state !== 'awaiting' &&
    state !== 'interrupted' &&
    exitCode !== undefined &&
    exitCode !== 0
      ? `✗ exit ${exitCode}`.length
      : 1
  const width = (line: string) =>
    [...line.replace(ESCAPES, '').replaceAll('\t', '        ')].length
  const printed = [stdout, stderr]
    .join('\n')
    .split(/\r?\n/)
    .map((line) => width(line.slice(line.lastIndexOf('\r') + 1)))
  const prompt =
    PROMPT_COLS +
    width(command.replaceAll('\n', ' ')) +
    1 +
    (timed ? TIME_COLS : 0) +
    ending +
    (printedAnything({ stdout, stderr }) ? CHEVRON_COLS : 0)
  return Math.max(MIN_COLS, prompt, ...printed) + MARGIN_COLS
}

/** One Ratzilla mount per host element, so a remounted effect finds the one it made. */
const mounts = new WeakMap<HTMLElement, Promise<CommandHandle>>()

/**
 * Slides the output rows new output moved up back into place: drawn `rows`
 * lower in the frame the crate draws them (cell-grid.css --slide), then let
 * rise. A slide still rising goes on from where it is, `rows` lower; less
 * motion asked for leaves them as drawn.
 */
function slide(grid: HTMLElement, rows: number) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const style = getComputedStyle(grid)
  const rising = parseFloat(style.getPropertyValue('--slide')) || 0
  const row = parseFloat(style.fontSize) * 1.5
  grid.dataset.sliding = ''
  grid.style.setProperty('--slide', `${rising + rows * row}px`)
  requestAnimationFrame(() => {
    delete grid.dataset.sliding
    grid.style.setProperty('--slide', '0px')
  })
}

/** A command the agent ran, drawn by the terminal: the command, how it ended, what it printed. */
export function CommandTerminal({
  command,
  state,
  stdout,
  stderr,
  exitCode,
  className,
}: CommandTerminalProps) {
  const id = useId()
  const host = useRef<HTMLDivElement>(null)
  const handle = useRef<CommandHandle>(undefined)
  const still = useReducedMotion() ?? false
  const printed = printedAnything({ stdout, stderr })
  const [chosen, setChosen] = useState<boolean>()
  const open = outputShows(state, printed, chosen)
  // The crate counts the time from the first state it sees running.
  const [timed, setTimed] = useState(false)
  if (state === 'running' && !timed) setTimed(true)
  // While output streams in, the terminal takes the column, so wider lines never widen it.
  const wide = state === 'running' && printed
  // The reader's own open springs and their close is quick; what the work
  // does (output arriving, the run ending) glides, so streamed text never bounces.
  const [byReader, setByReader] = useState(false)
  const shows = useRef(open)
  useEffect(() => {
    shows.current = open
  }, [open])
  const run = JSON.stringify({
    command,
    stdout,
    stderr,
    status: STATUS[state],
    exitCode,
    open,
    still,
  })
  const latest = useRef(run)
  const [rows, setRows] = useState(() => {
    const lines = [stdout, stderr].filter((text) => text.trim()).join('\n')
    return 1 + Math.min(lines ? lines.split('\n').length : 0, FOLD)
  })

  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false
    let mounted = mounts.get(element)
    if (!mounted) {
      // The crate calls this from its frame; React sets the height after it returns.
      mounted = loadWasm().then((wasm) =>
        wasm.mount_command(
          element.id,
          (wanted: number) => setRows(wanted),
          (by: number) => slide(element, by),
        ),
      )
      mounts.set(element, mounted)
    }
    void mounted.then((made) => {
      if (disposed) return
      handle.current = made
      made.set_state(latest.current)
    })
    // The page scrolls only once the output has no further to go, or while it is closed.
    const wheel = (event: WheelEvent) => {
      if (shows.current && handle.current?.scroll(event.deltaY > 0 ? 3 : -3))
        event.preventDefault()
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => {
      disposed = true
      element.removeEventListener('wheel', wheel)
    }
  }, [])

  useEffect(() => {
    latest.current = run
    handle.current?.set_state(run)
  }, [run])

  // The grid measures a cell as 1ch of its own font, so the width is said in
  // ch; a quarter more keeps rounding from losing the last column.
  const cols = terminalColumns(
    { command, state, stdout, stderr, exitCode },
    timed,
  )
  // The crate draws every row the output wants; closed, all but the command's are clipped.
  return (
    <div
      data-slot="command-terminal"
      data-state={open ? 'open' : 'closed'}
      className={cn(
        responseFrame,
        wide ? 'w-full' : 'w-fit max-w-full',
        className,
      )}
    >
      <div className="bg-term py-1.5">
        <div
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget) setByReader(false)
          }}
          style={{ height: `${(open ? rows : 1) * 1.5}em` }}
          className={cn(
            'relative overflow-hidden font-mono text-[12.5px] transition-[height] motion-reduce:transition-none',
            byReader
              ? open
                ? 'duration-(--duration-snap) ease-snap'
                : 'duration-(--duration-exit) ease-exit'
              : 'duration-(--duration-glide) ease-glide',
          )}
        >
          <div
            ref={host}
            id={id}
            data-terminal-grid=""
            style={{
              height: `${rows * 1.5}em`,
              width: wide ? '100%' : `${cols + 0.25}ch`,
            }}
            className="relative max-w-full overflow-hidden whitespace-pre text-term-ink"
          />
          {printed && (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={id}
              aria-label={command}
              onClick={() => {
                setByReader(true)
                setChosen(!open)
              }}
              className="absolute inset-x-0 top-0 h-[1.5em] cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
            />
          )}
        </div>
      </div>
    </div>
  )
}
