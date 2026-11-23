// SOURCING: assistant-ui's own accept check (fileMatchesAccept, the test addAttachment applies) and the Web File API; the paste becomes an ordinary text/plain attachment, so Theorem's chat upload route reads it into the turn's context as it does any text file.
//
// A long paste goes into the composer as an attachment rather than as text,
// as other chat apps do. Nothing marks the file but its name, so a pasted
// text reads back as one after it is sent and after a reload.
import { fileMatchesAccept } from '@assistant-ui/core/internal'

/** A paste at least this long becomes an attachment. */
export const PASTED_TEXT_MIN_CHARS = 4_000
/** A paste of at least this many lines becomes an attachment, however short they are. */
export const PASTED_TEXT_MIN_LINES = 80

const PASTED_TYPE = 'text/plain'
const PASTED_NAME = /^Pasted text(?: (\d+))?\.txt$/

/** Whether a paste is long enough to go in as an attachment. */
export function isLongPaste(text: string) {
  if (text.length >= PASTED_TEXT_MIN_CHARS) return true
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1))
    if (++lines >= PASTED_TEXT_MIN_LINES) return true
  return false
}

/** Whether an attachment is a pasted text, by the name the composer gave it. */
export const isPastedText = (name: string | undefined, type?: string) =>
  name !== undefined &&
  PASTED_NAME.test(name) &&
  (type === undefined || type.split(';', 1)[0] === PASTED_TYPE)

/** Whether the composer's attachments take a pasted text at all. */
export const takesPastedText = (accept: string) =>
  fileMatchesAccept({ name: 'Pasted text.txt', type: PASTED_TYPE }, accept)

/** "Pasted text.txt", then "Pasted text 2.txt" and on, so each reads apart. */
function pastedName(taken: readonly string[]) {
  let highest = 0
  for (const name of taken) {
    const match = PASTED_NAME.exec(name)
    if (match) highest = Math.max(highest, Number(match[1] ?? 1))
  }
  return highest ? `Pasted text ${highest + 1}.txt` : 'Pasted text.txt'
}

/** The paste as a file, named apart from the pasted texts already attached. */
export const pastedTextFile = (text: string, taken: readonly string[]) =>
  new File([text], pastedName(taken), { type: PASTED_TYPE })

/** How a pasted text is labelled: "Pasted text 2.txt" reads as "Pasted text 2". */
export const pastedTitle = (name: string) => name.replace(/\.txt$/, '')

export function lineCount(text: string) {
  let lines = text.length ? 1 : 0
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1))
    lines++
  return lines
}

export const count = (n: number, one: string) =>
  `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`

/** A pasted text's size as people read it: "120 lines · 3,371 characters". */
export const textSize = (text: string) =>
  `${count(lineCount(text), 'line')} · ${count(text.length, 'character')}`
