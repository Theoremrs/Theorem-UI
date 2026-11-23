// SOURCING: the agent terminal's own crate (terminal/src/command.rs, built into src/terminal-wasm): in the reply where a call ran a command (chat/theorem-parts' tool-call slot, and a host call's part, which the server rewrites with what the command has printed while it runs), Ratzilla draws the command on the prompt's line and what it printed through the VT interpreter the workbench's process panes use; loadWasm from terminal-screen loads it and paints it in the workspace's terminal colours; the frame is the assistant-ui elements' response frame (surfaces). It opens and closes as assistant-ui's Reasoning element does (open while it works, closed after unless the reader chose), the crate drawing the shimmer, the clock and the chevron; framer-motion's useReducedMotion holds the shimmer still. While output streams it takes the column so wider lines never widen it, lines past the fold slide in as the crate reports the scroll, and what the work moves glides while the reader's own clicks spring. The output scrolls by wheel, by keys once it has focus and by a finger's drag, the page scrolling once the output can go no further; opening a cut command shows all of it, and the copy over the prompt copies it with useCopyToClipboard and the Copy/Copied icons, as the code block's header does (markdown-text). Should the terminal not load, the command and what it printed show as text.
import { useReducedMotion } from 'framer-motion'
import { useEffect, useId, useRef, useState } from 'react'
import { responseFrame } from '@/components/assistant-ui/elements/surfaces'
import { Icon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
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
/** The crate's time before the ending ("10m 10s "), kept whole so the terminal does not widen as it counts. */
const TIME_COLS = 8
/** The chevron after the ending (" ▸"). */
const CHEVRON_COLS = 2
/** Escape sequences, which take no columns on the screen. */
// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
/** More rows than the scrollback keeps (workbench-vt's SCROLLBACK_LINES), for the first or last. */
const ALL_ROWS = 1 << 16
/** Keys that scroll the output once it has focus, and by how many rows: towards newer is positive. */
const SCROLL_KEYS: Partial<Record<string, number>> = {
  ArrowUp: -1,
  ArrowDown: 1,
  PageUp: -FOLD,
  PageDown: FOLD,
  Home: -ALL_ROWS,
  End: ALL_ROWS,
}

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
/** An exit code, which the crate reads as an i32: anything else would lose the whole call. */
const num = (value: unknown): number | undefined =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= -(2 ** 31) &&
  value < 2 ** 31
    ? value
    : undefined
/** The text of a result's `content` entries, as an MCP tool returns what it printed. */
const contentText = (value: unknown): string | undefined =>
  Array.isArray(value)
    ? value
        .map(object)
        .flatMap((entry) =>
          entry.type === 'text' && typeof entry.text === 'string'
            ? [entry.text]
            : [],
        )
        .join('\n')
    : undefined

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
      : (fields.stdout ??
        fields.output ??
        fields.text ??
        contentText(fields.content))
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
 * Whether what is under its line shows (the rest of a command too long for
 * the line, and its output): as the reader last chose, or else, when it
 * printed, while the command works and when it went wrong, by its state or by
 * the exit code it ended with. A command that ended well closes to its line,
 * as the Reasoning element closes once it has thought, and a cut command that
 * printed nothing opens only when the reader opens it.
 */
export function outputShows(
  state: CallState,
  {
    printed,
    cut = false,
    exitCode,
  }: { printed: boolean; cut?: boolean; exitCode?: number },
  chosen?: boolean,
): boolean {
  if (!printed && !cut) return false
  const failedExit = exitCode !== undefined && exitCode !== 0
  return chosen ?? (printed && (state !== 'done' || failedExit))
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

/** One Ratzilla mount per host element, so a remounted effect finds the one it made; none for a host the page let go of first. */
const mounts = new WeakMap<HTMLElement, Promise<CommandHandle | undefined>>()

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
  // The crate says when the command is longer than its line.
  const [cut, setCut] = useState(false)
  const [chosen, setChosen] = useState<boolean>()
  const open = outputShows(state, { printed, cut, exitCode }, chosen)
  // Whether the prompt's line opens the terminal: there is something to show.
  const opens = printed || cut
  const [failed, setFailed] = useState(false)
  const { isCopied, copyToClipboard } = useCopyToClipboard({
    copiedDuration: 1500,
  })
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
      // The crate calls these from its frame; React sets the height after they return.
      mounted = loadWasm().then((wasm) =>
        element.isConnected
          ? wasm.mount_command(
              element.id,
              (wanted: number, longer: boolean) => {
                setRows(wanted)
                setCut(longer)
              },
              (by: number) => slide(element, by),
            )
          : undefined,
      )
      mounts.set(element, mounted)
    }
    mounted.then(
      (made) => {
        if (disposed || !made) return
        handle.current = made
        made.set_state(latest.current)
      },
      (error: unknown) => {
        if (disposed) return
        console.error('[command-terminal] the terminal did not load:', error)
        setFailed(true)
      },
    )
    // The page scrolls only once the output has no further to go, or while it is closed.
    const wheel = (event: WheelEvent) => {
      if (shows.current && handle.current?.scroll(event.deltaY > 0 ? 3 : -3))
        event.preventDefault()
    }
    // A finger drags the output a row at a time, as it would drag the page.
    let touchedAt: number | undefined
    const touchstart = (event: TouchEvent) => {
      touchedAt = event.touches[0]?.clientY
    }
    const touchmove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY
      const made = handle.current
      if (touchedAt === undefined || y === undefined || !made || !shows.current)
        return
      const by = touchedAt - y
      if (!made.can_scroll(Math.sign(by))) return
      event.preventDefault()
      const row = parseFloat(getComputedStyle(element).fontSize) * 1.5
      const lines = Math.trunc(by / row)
      if (lines === 0) return
      made.scroll(lines)
      touchedAt -= lines * row
    }
    element.addEventListener('wheel', wheel, { passive: false })
    element.addEventListener('touchstart', touchstart, { passive: true })
    element.addEventListener('touchmove', touchmove, { passive: false })
    return () => {
      disposed = true
      element.removeEventListener('wheel', wheel)
      element.removeEventListener('touchstart', touchstart)
      element.removeEventListener('touchmove', touchmove)
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
        {failed ? (
          <pre className="px-[1ch] font-mono text-[12.5px] leading-[1.5] break-all whitespace-pre-wrap text-term-ink">
            <span className="text-term-muted">❯ </span>
            {command}
            {stdout && `\n${stdout.replace(ESCAPES, '').trimEnd()}`}
            {stderr && (
              <span className="text-term-error">
                {`\n${stderr.replace(ESCAPES, '').trimEnd()}`}
              </span>
            )}
          </pre>
        ) : (
          <div
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget) setByReader(false)
            }}
            style={{ height: `${(open ? rows : 1) * 1.5}em` }}
            className={cn(
              'group/command relative overflow-hidden font-mono text-[12.5px] transition-[height] motion-reduce:transition-none',
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
              role="region"
              aria-label={`Output of ${command}`}
              tabIndex={open && printed ? 0 : -1}
              onKeyDown={(event) => {
                const lines = SCROLL_KEYS[event.key]
                if (lines && open && handle.current?.scroll(lines))
                  event.preventDefault()
              }}
              style={{
                height: `${rows * 1.5}em`,
                width: wide ? '100%' : `${cols + 0.25}ch`,
              }}
              className="relative max-w-full overflow-hidden whitespace-pre text-term-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
            />
            {opens && (
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
            <button
              type="button"
              aria-label={isCopied ? 'Copied' : 'Copy command'}
              onClick={() => void copyToClipboard(command)}
              className={cn(
                // Over the prompt while the terminal is pointed at or the copy has focus; a
                // finger, which cannot point, finds it once the terminal is open, or at
                // once when there is nothing to open.
                'absolute top-0 left-0 flex h-[1.5em] w-[3ch] items-center justify-center bg-term text-term-muted opacity-0 transition-opacity group-hover/command:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus motion-reduce:transition-none',
                open || isCopied || !opens
                  ? 'pointer-coarse:opacity-100'
                  : 'pointer-coarse:pointer-events-none',
                isCopied && 'opacity-100',
              )}
            >
              {isCopied ? (
                <Icon.Copied className="size-3" />
              ) : (
                <Icon.Copy className="size-3" />
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
