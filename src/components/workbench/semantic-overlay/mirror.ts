// SOURCING: hand-roll, no library applies: the host-input textarea (workbench.tsx) is cleared after every input event today, and the accessible overlay needs it to hold the focused text field's text and caret instead. This is the arithmetic that lets both hold: what a person typed is what is new against the mirrored text and caret, and the field is put back to the mirror, not to empty, after each event.

/** The text and selection the overlay has put into the input field for assistive technology to read. UTF-16 units, as the DOM counts. */
export interface InputMirror {
  readonly value: string
  readonly start: number
  readonly end: number
  /** The caret is at `start` (a selection made backwards). */
  readonly backward: boolean
}

/**
 * What the person typed into the field. With nothing mirrored that is the field's whole value, as it
 * has always been. With a mirror, typing replaces the mirrored selection, so what is new is what lies
 * between the text before the selection and the text after it. A change that is not that shape (the
 * browser rewrote the field, a deletion the workbench did not take as a key) typed nothing: the core,
 * not the field, owns the text, and the next publication puts it back.
 */
export function typedSince(mirror: InputMirror | undefined, value: string): string {
  if (!mirror) return value
  const before = mirror.value.slice(0, Math.min(mirror.start, mirror.end))
  const after = mirror.value.slice(Math.max(mirror.start, mirror.end))
  if (
    value.length < before.length + after.length ||
    !value.startsWith(before) ||
    !value.endsWith(after)
  )
    return ''
  return value.slice(before.length, value.length - after.length)
}

type Field = Pick<
  HTMLTextAreaElement,
  'value' | 'selectionStart' | 'selectionEnd' | 'setSelectionRange'
>

/** Puts the field back to what is mirrored (or to empty): where it stands after each input, composition and undo event. */
export function settle(field: Field, mirror: InputMirror | undefined) {
  const value = mirror?.value ?? ''
  if (field.value !== value) field.value = value
  if (mirror)
    field.setSelectionRange(
      mirror.start,
      mirror.end,
      mirror.backward ? 'backward' : 'forward',
    )
}

/**
 * The mirror a text node's selection describes, or `undefined` when it has none to say. A selection
 * is `anchor` and `focus` in UTF-16 units of `text`; `focus` is the caret.
 */
export function mirrorOf(
  text: string,
  selection: { anchor: number; focus: number },
): InputMirror {
  const clamp = (at: number) => Math.min(Math.max(0, Math.trunc(at)), text.length)
  const anchor = clamp(selection.anchor)
  const focus = clamp(selection.focus)
  return {
    value: text,
    start: Math.min(anchor, focus),
    end: Math.max(anchor, focus),
    backward: focus < anchor,
  }
}
