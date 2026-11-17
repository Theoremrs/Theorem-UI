// SOURCING: hand-roll over painted() and CONTROL_LAYERS (components/icons.tsx, the owner's Streamline marks) and React's useSyncExternalStore: nothing in Ratatui or Ratzilla models an image in a cell, so the core marks where an icon goes (terminal/crates/workbench-core/src/icons.rs) and this layer draws it over the grid, one absolutely positioned element per icon at its cell. The store is icon-layer/store.ts.
import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import { CONTROL_LAYERS } from '@/assets/icons/streamline/control/layers'
import { useTerminalTheme } from '@/components/terminal/live-terminal-theme'
import { painted } from '@/components/icons'
import type { PlacedIcon } from '@/lib/workbench/wire'
import type { WorkbenchHandle } from '@/terminal-wasm/theorem_terminal'
import type { IconStore } from './icon-layer/store'

/** The turn of the wheel each mark takes from the terminal's accent, and whether its page is softened: the sidebar's session marks (icons.tsx), with the plus of a new file kept at the full accent. */
const SHIFT: Partial<Record<keyof typeof CONTROL_LAYERS, number>> = {
  // A folder is the terminal's gold, unturned (FOLDER below).
  folderEmpty: 0,
  folderFile: 0,
  folderHome: 0,
  folderCheck: 0,
  folderEdit: 0,
  fileAdd: 260,
  fileCheck: 135,
  fileModule: 45,
  fileDouble: 45,
  fileDouble2: 45,
}

type Name = keyof typeof CONTROL_LAYERS
const MARKS = Object.fromEntries(
  (Object.keys(CONTROL_LAYERS) as Name[]).map((name) => [
    name,
    painted(
      CONTROL_LAYERS[name],
      SHIFT[name] ?? 180,
      name === 'fileAdd'
        ? { tint: 'paper', paper: 'paper', accent: 'accent', line: 'line' }
        : true,
    ),
  ]),
) as Record<Name, ReturnType<typeof painted>>

/** A cell count as a CSS length in the measured cell, relative to the layer. */
const cells = (count: number, unit: 'w' | 'h') =>
  `calc(var(--wb-cell-${unit}) * ${count})`

/** Two cells wide and one high; the mark inside is the largest square that fits, undistorted. */
const SLOT: CSSProperties = {
  position: 'absolute',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: cells(2, 'w'),
  height: 'var(--wb-cell-h)',
  pointerEvents: 'none',
}
const GLYPH = {
  width: 'var(--wb-icon)',
  height: 'var(--wb-icon)',
} as CSSProperties
/**
 * A folder's fill starts from the terminal's gold, not its accent: the source marks are yellow
 * folders and white pages, and a tree is read by telling the two apart at a glance. The gold is a
 * role the theme already derives, so the folder follows every palette.
 */
const FOLDER = {
  ...GLYPH,
  '--redwood': 'var(--wb-icon-folder)',
} as CSSProperties

/**
 * The icons of the frame, drawn over the grid beside the semantic overlay: inert to the pointer and
 * hidden from assistive technology (the semantic tree says what a row is; an icon only decorates it).
 * The layer takes the terminal's own colours, not the app's, so a mark sits on the ground the grid
 * draws and reads in the grid's ink and accent.
 */
export function IconLayer({
  store,
  handle,
}: {
  store: IconStore
  handle: Pick<WorkbenchHandle, 'cell_size'> | undefined
}) {
  const icons = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  )
  const chrome = useTerminalTheme((state) => state.roles.chrome)
  const gold = useTerminalTheme((state) => state.roles.state.warning)
  const layer = useRef<HTMLDivElement>(null)

  // The measured cell, as CSS lengths on the layer: a change of cell moves every icon without
  // rendering one. The core reports it once a frame has measured, so wait for that.
  useEffect(() => {
    const element = layer.current
    if (!element || !handle) return
    let frame = 0
    const measure = () => {
      const json = handle.cell_size()
      if (!json) return false
      const cell = JSON.parse(json) as { width: number; height: number }
      element.style.setProperty('--wb-cell-w', `${cell.width}px`)
      element.style.setProperty('--wb-cell-h', `${cell.height}px`)
      element.style.setProperty(
        '--wb-icon',
        `${Math.min(cell.width * 2, cell.height)}px`,
      )
      return true
    }
    const wait = () => {
      if (!measure()) frame = requestAnimationFrame(wait)
    }
    wait()
    const stop = store.subscribe(() => void measure())
    window.addEventListener('resize', wait)
    return () => {
      cancelAnimationFrame(frame)
      stop()
      window.removeEventListener('resize', wait)
    }
  }, [handle, store])

  return (
    <div
      ref={layer}
      data-icon-layer=""
      aria-hidden="true"
      style={
        {
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          pointerEvents: 'none',
          '--ink': chrome.text,
          '--rail-ground': chrome.bg,
          '--redwood': chrome.accent,
          '--wb-icon-folder': gold,
        } as CSSProperties
      }
    >
      {icons.map((placed) => (
        <Slot key={`${placed.x},${placed.y}`} placed={placed} />
      ))}
    </div>
  )
}

function Slot({ placed }: { placed: PlacedIcon }) {
  const Mark = MARKS[placed.icon]
  return (
    <span
      aria-hidden="true"
      data-icon={placed.icon}
      data-cell-x={placed.x}
      data-cell-y={placed.y}
      style={{
        ...SLOT,
        left: cells(placed.x, 'w'),
        top: cells(placed.y, 'h'),
      }}
    >
      <Mark
        style={placed.icon.startsWith('folder') ? FOLDER : GLYPH}
        className="size-auto"
      />
    </span>
  )
}
