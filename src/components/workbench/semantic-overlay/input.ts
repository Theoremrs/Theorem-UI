// SOURCING: hand-roll over the DOM's own attributes (aria-activedescendant, aria-label, aria-describedby) and the mirror in ./mirror: nothing upstream models "a text control that stays focused while the accessibility tree says focus is elsewhere". It is the reading of ARIA 1.2's activedescendant on a textbox and of the Authoring Practices' combobox pattern, which keeps DOM focus in the field while a list's highlight moves.
import { descriptionId, describe, elementId } from './aria'
import { mirrorOf, settle } from './mirror'
import type { InputMirror } from './mirror'
import type { Store } from './tree'

/**
 * Keeps the one real text control telling assistive technology where the core's focus is, without
 * moving DOM focus: it names the focused node's element with `aria-activedescendant`, and when that
 * node is a text field whose text and caret the core publishes, it holds that text and caret itself
 * under the node's name and is the node's one accessible owner (the node's element steps aside).
 * `mirror` is told what the field holds, so the input path forwards only what was typed. During an IME
 * composition the field belongs to the IME; the mirror is updated and the field is put back to it when
 * the composition ends (workbench.tsx does, from `mirror`). Returns the function that lets go.
 */
export function bindInput(
  field: HTMLTextAreaElement,
  mirror: { current: InputMirror | undefined },
  store: Store,
  prefix: string,
): () => void {
  const label = field.getAttribute('aria-label')
  let composing = false
  const start = () => {
    composing = true
  }
  const end = () => {
    composing = false
  }
  field.addEventListener('compositionstart', start)
  field.addEventListener('compositionend', end)
  let held = false
  const sync = () => {
    const tree = store.tree()
    const target = store.mirrored()
    const node = target && tree ? tree.nodes.get(target) : undefined
    if (node && node.text !== undefined && node.selection) {
      const next = mirrorOf(node.text, node.selection)
      mirror.current = next
      if (!composing) settle(field, next)
      field.setAttribute('aria-label', node.name)
      field.removeAttribute('aria-activedescendant')
      if (describe(node)) field.setAttribute('aria-describedby', descriptionId(elementId(prefix, node.id)))
      else field.removeAttribute('aria-describedby')
      held = true
      return
    }
    if (held) {
      mirror.current = undefined
      if (!composing) settle(field, undefined)
      if (label) field.setAttribute('aria-label', label)
      field.removeAttribute('aria-describedby')
      held = false
    }
    const active = store.active()
    if (active) field.setAttribute('aria-activedescendant', elementId(prefix, active))
    else field.removeAttribute('aria-activedescendant')
  }
  sync()
  const stop = store.subscribe(sync)
  return () => {
    stop()
    field.removeEventListener('compositionstart', start)
    field.removeEventListener('compositionend', end)
    mirror.current = undefined
    field.removeAttribute('aria-activedescendant')
    field.removeAttribute('aria-describedby')
    if (label) field.setAttribute('aria-label', label)
  }
}
