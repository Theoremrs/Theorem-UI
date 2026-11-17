// SOURCING: ./driver, which looks for `[data-face-perch="terminal"]` each frame and rests Theo's one face there, drawn for the surface the attributes name (./terminal-face). This only places that element over the cells the workbench reports and passes the terminal palette's colours; it draws nothing and owns no state.
import type { TerminalTheme } from '@/components/terminal/terminal-theme'

/** The cells the Theo panel reserved, in workbench grid cells, as the panel reports them. */
export interface FaceCells {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Lays the perch over the reserved cells. `cell` is the grid's cell in CSS
 * pixels; the parent is the grid's own box (positioned). Render nothing
 * when the panel reports no cells.
 */
export function TerminalFacePerch({
  cells,
  cell,
  theme,
}: {
  cells: FaceCells | null
  cell: { width: number; height: number }
  theme: Pick<TerminalTheme, 'bg' | 'ink'>
}) {
  if (!cells) return null
  return (
    <span
      aria-hidden
      data-face-perch="terminal"
      data-face-surface={theme.bg}
      data-face-ink={theme.ink}
      className="pointer-events-none absolute"
      style={{
        left: cells.x * cell.width,
        top: cells.y * cell.height,
        width: cells.w * cell.width,
        height: cells.h * cell.height,
      }}
    />
  )
}
