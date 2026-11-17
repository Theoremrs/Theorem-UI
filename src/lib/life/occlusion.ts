// SOURCING: none — pure logic over the field's own cell grid (rectangle coverage and a two-pass box blur on a Float32Array); no installed library models the field's cells, and the measuring of text is the browser's Range.getClientRects in life-backdrop.tsx
/**
 * Where the conversation's text lies over the Life field, as a share per
 * cell: 1 where a line of text covers the cell, falling off over `feather`
 * cells around it, 0 elsewhere. The field dims its glyphs by this share, so
 * the cells under words go quiet while the field keeps running between lines
 * and in the margins; following the lines themselves leaves no band.
 */

/** A box in client pixels: a line of the conversation's text over the field. */
export interface ClientBox {
  left: number
  top: number
  right: number
  bottom: number
}

/** How far a glyph under a line of text fades: all but out, so the words read clean. */
export const TEXT_QUIET = 0.97

/** A rectangle in cell units: x across, y down, fractional where it cuts a cell. */
export interface CellRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function occlusionMask(
  rects: readonly CellRect[],
  cols: number,
  rows: number,
  feather = 1,
): Float32Array {
  const covered = new Float32Array(cols * rows)
  for (const rect of rects) {
    const fromX = Math.max(0, Math.floor(rect.x0))
    const toX = Math.min(cols, Math.ceil(rect.x1))
    const fromY = Math.max(0, Math.floor(rect.y0))
    const toY = Math.min(rows, Math.ceil(rect.y1))
    for (let y = fromY; y < toY; y++) {
      const down = Math.min(y + 1, rect.y1) - Math.max(y, rect.y0)
      for (let x = fromX; x < toX; x++) {
        const share = down * (Math.min(x + 1, rect.x1) - Math.max(x, rect.x0))
        const i = y * cols + x
        // Shares add: a cell where two lines meet is covered by both halves.
        covered[i] = Math.min(1, covered[i]! + share)
      }
    }
  }
  if (feather <= 0) return covered
  // A box blur across then down spreads each covered cell over its
  // neighbours; the larger of the two keeps covered cells at full weight.
  const across = blur(covered, cols, rows, feather, true)
  const spread = blur(across, cols, rows, feather, false)
  for (let i = 0; i < covered.length; i++)
    covered[i] = Math.max(covered[i]!, Math.min(1, spread[i]! * 1.5))
  return covered
}

/** A box blur of `radius` cells along rows (`across`) or columns. */
function blur(
  source: Float32Array,
  cols: number,
  rows: number,
  radius: number,
  across: boolean,
): Float32Array {
  const out = new Float32Array(source.length)
  const width = radius * 2 + 1
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      let sum = 0
      for (let d = -radius; d <= radius; d++) {
        const nx = across ? x + d : x
        const ny = across ? y : y + d
        if (nx >= 0 && nx < cols && ny >= 0 && ny < rows) sum += source[ny * cols + nx]!
      }
      out[y * cols + x] = sum / width
    }
  return out
}
