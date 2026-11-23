// SOURCING: Jupytext's percent format (a `%%` comment line opens each cell: `// %%` in JavaScript), the plain-text cell notation editors already read, so the cells of a view are one text a person edits and splits or joins by its lines. No library ships the format's reader for JavaScript in the browser; it is a line split.
//
// The cells of an interactive view as one editable text, and back.

/** A line that opens a cell: `// %%`, with anything after it (a title, as Jupytext allows). */
const MARKER = /^[ \t]*\/\/[ \t]*%%/

/** The cells as one text, each under its marker; the marker alone parts one cell from the next. */
export function joinCells(cells: readonly string[]): string {
  return cells.map((cell) => `// %%\n${cell.replace(/\s+$/, '')}`).join('\n')
}

/**
 * The text's cells: what follows each marker, up to the next, without the
 * blank lines at either end. Text before the first marker is a cell of its
 * own; a marker with nothing under it opens no cell.
 */
export function splitCells(text: string): string[] {
  const cells: string[][] = [[]]
  for (const line of text.split(/\r?\n/)) {
    if (MARKER.test(line)) cells.push([])
    else cells[cells.length - 1]?.push(line)
  }
  return cells
    .map((lines) => lines.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, ''))
    .filter((cell) => cell.trim() !== '')
}
