import type { GutterLine } from './code-lines'

/** The widest displayed number, without spreading a large file into arguments. */
export function gutterDigits(lines: readonly GutterLine[]) {
  let widest = 1
  for (const line of lines) widest = Math.max(widest, line.number ?? 0)
  return String(widest).length
}
