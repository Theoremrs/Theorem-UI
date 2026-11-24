// SOURCING: the agent terminal's own crate (terminal/src/cells.rs, built into src/terminal-wasm): Ratzilla draws a view's cells under a prompt's line as command.rs draws a command, and edits them with the workbench editor's SourceView over an EditSession; loadWasm from terminal-screen loads it and paints it in the workspace's terminal colours, on the agent terminal's canvas and in its type (cell-grid.css data-terminal-type), its height counted in that type's rows. The hidden textarea that takes typed text, an IME's committed text and a paste is the workbench's host-input pattern (workbench.tsx); the cells are one text in Jupytext's percent format (lib/notebooks/percent-cells) and are coloured by @tanstack/highlight through terminal-code's highlightLines; the frame is the elements' lifted frame (surfaces), and the open and close glide without overshoot. Should the terminal not load, the cells show as text.
import { useEffect, useId, useRef, useState } from 'react'
import { useReducedMotion } from 'framer-motion'
import { liftedFrame } from '@/components/assistant-ui/elements/surfaces'
import { joinCells, splitCells } from '@/lib/notebooks/percent-cells'
import { cn } from '@/lib/utils'
import type { CellsHandle } from '@/terminal-wasm/theorem_terminal'
import { highlightLines } from './terminal-code'
import { CellProbe, loadWasm } from './terminal-screen'
import './cell-grid.css'

/** The textarea the crate finds beside its grid (terminal/src/cells.rs FIELD_LABEL). */
const FIELD_LABEL = 'View cells input'

export type CellsStatus = 'idle' | 'running' | 'error'

export interface CellsTerminalProps {
  /** What the prompt's line names: the view's title. */
  title: string
  /** The cells as the agent wrote them; new ones start the editor over. */
  cells: readonly string[]
  status?: CellsStatus
  /** Why the view failed, shown under the cells. */
  error?: string
  /** Mod+Enter: the cells as they read now. */
  onRun: (cells: string[]) => void
  /** After each edit: the cells as they read now. */
  onEdit?: (cells: string[]) => void
  /** Whether the cells show at first. */
  defaultOpen?: boolean
  className?: string
}

/** One Ratzilla mount per host element, so a remounted effect finds the one it made. */
const mounts = new WeakMap<HTMLElement, Promise<CellsHandle | undefined>>()

const tokensOf = (text: string) => JSON.stringify(highlightLines(text, 'js'))

/** A view's cells in the terminal, editable: the person changes them and runs them again. */
export function CellsTerminal({
  title,
  cells,
  status = 'idle',
  error,
  onRun,
  onEdit,
  defaultOpen = false,
  className,
}: CellsTerminalProps) {
  const id = useId()
  const host = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const handle = useRef<CellsHandle>(undefined)
  const still = useReducedMotion() ?? false
  const [open, setOpen] = useState(defaultOpen)
  const [rows, setRows] = useState(1)
  const [failed, setFailed] = useState(false)
  const [byReader, setByReader] = useState(false)
  const source = joinCells(cells)
  const latest = useRef({ source, onRun, onEdit })
  latest.current = { source, onRun, onEdit }
  const head = JSON.stringify({
    title,
    status,
    error: status === 'error' ? (error ?? '') : '',
    open,
    still,
  })
  const latestHead = useRef(head)

  useEffect(() => {
    const element = host.current
    if (!element) return
    let disposed = false
    let mounted = mounts.get(element)
    if (!mounted) {
      // The crate calls on_rows from its frame and the others once it is free again.
      mounted = loadWasm().then((wasm) =>
        element.isConnected
          ? wasm.mount_cells(
              element.id,
              (wanted: number) => setRows(wanted),
              (text: string) => {
                handle.current?.set_tokens(tokensOf(text))
                latest.current.onEdit?.(splitCells(text))
              },
              (text: string) => latest.current.onRun(splitCells(text)),
            )
          : undefined,
      )
      mounts.set(element, mounted)
    }
    mounted.then(
      (made) => {
        if (disposed || !made) return
        handle.current = made
        made.set_state(latestHead.current)
        made.set_source(latest.current.source)
        made.set_tokens(tokensOf(made.text_now()))
      },
      (reason: unknown) => {
        if (disposed) return
        console.error('[cells-terminal] the terminal did not load:', reason)
        setFailed(true)
      },
    )
    // The page scrolls once the cells can go no further, or while they are closed.
    const wheel = (event: WheelEvent) => {
      if (handle.current?.scroll(event.deltaY > 0 ? 3 : -3))
        event.preventDefault()
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => {
      disposed = true
      element.removeEventListener('wheel', wheel)
    }
  }, [])

  useEffect(() => {
    latestHead.current = head
    handle.current?.set_state(head)
  }, [head])

  useEffect(() => {
    const made = handle.current
    if (!made) return
    made.set_source(source)
    made.set_tokens(tokensOf(made.text_now()))
  }, [source])

  const pointer = (
    type: 'down' | 'move' | 'up',
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect()
    handle.current?.pointer(
      JSON.stringify({
        type,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        shiftKey: event.shiftKey,
        detail: event.detail,
      }),
    )
  }

  if (failed)
    return (
      <div
        data-slot="cells-terminal"
        data-terminal-type=""
        className={cn(liftedFrame, className)}
      >
        <pre className="bg-term-canvas px-[1ch] py-1.5 break-all whitespace-pre-wrap text-term-ink">
          <span className="text-term-muted">❯ </span>
          {title}
          {open && `\n${source}`}
        </pre>
      </div>
    )

  return (
    <div
      data-slot="cells-terminal"
      data-terminal-type=""
      data-state={open ? 'open' : 'closed'}
      className={cn(liftedFrame, 'w-full', className)}
    >
      <div
        className="bg-term-canvas py-1.5"
        onKeyDown={(event) => {
          // Keys pressed during an IME composition belong to the composition.
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          )
            return
          if (
            event.target === field.current &&
            handle.current?.key(event.nativeEvent)
          ) {
            event.preventDefault()
            event.stopPropagation()
          }
        }}
      >
        <div
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget) setByReader(false)
          }}
          style={{ height: `${rows}lh` }}
          className={cn(
            'relative overflow-hidden transition-[height] motion-reduce:transition-none',
            byReader
              ? open
                ? 'duration-(--duration-snap) ease-glide'
                : 'duration-(--duration-exit) ease-exit'
              : 'duration-(--duration-glide) ease-glide',
          )}
        >
          <CellProbe />
          <div
            ref={host}
            id={id}
            data-terminal-grid=""
            aria-hidden="true"
            // A press on the grid keeps the keyboard in the textarea and goes in from
            // `mousedown`, the one event whose `detail` is the click count.
            onMouseDown={(event) => {
              if (!open) return
              event.preventDefault()
              field.current?.focus({ preventScroll: true })
              pointer('down', event)
            }}
            onPointerDown={(event) => {
              if (open) event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              if (event.buttons & 1) pointer('move', event)
            }}
            onPointerUp={(event) => pointer('up', event)}
            style={{ height: `${rows}lh` }}
            className="relative w-full cursor-text overflow-hidden whitespace-pre text-term-ink"
          />
          <textarea
            ref={field}
            aria-label={FIELD_LABEL}
            aria-multiline="true"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            rows={1}
            tabIndex={open ? 0 : -1}
            // `sr-only` sets `white-space: nowrap`; WebKit then stores a typed space as U+00A0.
            className="sr-only whitespace-pre-wrap!"
            onFocus={() => handle.current?.set_focused(true)}
            onBlur={() => handle.current?.set_focused(false)}
            onInput={(event) => {
              const input = event.currentTarget
              if (
                event.nativeEvent instanceof InputEvent &&
                event.nativeEvent.isComposing
              )
                return
              const typed = input.value
              input.value = ''
              if (typed) handle.current?.text(typed)
            }}
            onCompositionEnd={(event) => {
              // Some browsers send the input event before this one, some after: the field is
              // cleared here, so the committed text goes in once.
              event.currentTarget.value = ''
              if (event.data) handle.current?.text(event.data)
            }}
            onPaste={(event) => {
              event.preventDefault()
              handle.current?.paste(event.clipboardData.getData('text'))
            }}
          />
          <button
            type="button"
            aria-expanded={open}
            aria-controls={id}
            aria-label={title}
            onClick={() => {
              setByReader(true)
              setOpen(!open)
            }}
            className="absolute inset-x-0 top-0 h-[1lh] cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
          />
        </div>
      </div>
    </div>
  )
}
