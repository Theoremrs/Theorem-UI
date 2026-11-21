// SOURCING: assistant-ui's default directive syntax (`:type[label]{name=id}`, or `:type{label="..." name="..."}` when a label holds `]`), the protocol defaultDirectiveFormatter writes and createDirectiveText reads; ProseMirror decorations, appendTransaction and handleKeyDown through @milkdown/kit/prose
//
// assistant-ui shows a directive as a chip while it is written only in its
// Lexical input. The composer is a Crepe editor, so this plugin does the same
// there: the directive's text stays in the document (the composer's text, and
// what is sent, are unchanged) and is drawn as a chip of its label, with the
// caret kept off its syntax and one Backspace or Delete taking it whole.
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

/** The directives the composer writes: a / tool, a + skill, an @ record or document. */
export const COMPOSER_DIRECTIVE_TYPES = [
  'tool',
  'skill',
  'record',
  'document',
] as const

const QUOTED = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4})){1,1024}"`

/** A composer directive in a run of text, as assistant-ui's formatter writes it. */
const DIRECTIVE = new RegExp(
  String.raw`:(${COMPOSER_DIRECTIVE_TYPES.join('|')})(?:\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?|\{label=(${QUOTED})(?: name=(${QUOTED}))?\})`,
  'gu',
)

export type ComposerDirective = {
  from: number
  to: number
  type: string
  label: string
}

/** The directives in `text`, by offset into it. */
export function findDirectives(text: string): ComposerDirective[] {
  const found: ComposerDirective[] = []
  for (const match of text.matchAll(DIRECTIVE)) {
    let label = match[2]
    if (label === undefined) {
      try {
        label = JSON.parse(match[4]!) as string
      } catch {
        continue
      }
    }
    found.push({
      from: match.index,
      to: match.index + match[0].length,
      type: match[1]!,
      label,
    })
  }
  return found
}

/** The directives in the document, by document position; code is left as written. */
export function documentDirectives(state: EditorState): ComposerDirective[] {
  const found: ComposerDirective[] = []
  state.doc.descendants((node, pos) => {
    if (node.type.spec.code) return false
    if (!node.isTextblock) return true
    // Text with marks is split into several nodes, and a directive can span
    // them; an inline leaf (a hard break) is one character no directive holds.
    let text = ''
    const position: number[] = []
    node.forEach((child, offset) => {
      const run = child.isText ? child.text! : '\uFFFC'
      for (let i = 0; i < run.length; i++) position.push(pos + 1 + offset + i)
      text += run
    })
    for (const directive of findDirectives(text))
      found.push({
        ...directive,
        from: position[directive.from]!,
        to: position[directive.to - 1]! + 1,
      })
    return false
  })
  return found
}

const key = new PluginKey<DecorationSet>('theorem-composer-directives')

function decorate(state: EditorState) {
  return DecorationSet.create(
    state.doc,
    documentDirectives(state).map((directive) =>
      Decoration.inline(directive.from, directive.to, {
        class: 'theorem-composer-directive',
        'data-slot': 'composer-directive-chip',
        'data-directive-type': directive.type,
        'data-label': directive.label,
        'aria-label': `${directive.type}: ${directive.label}`,
      }),
    ),
  )
}

/** The directive the caret is strictly inside, if any. */
const around = (state: EditorState, pos: number) =>
  documentDirectives(state).find(
    (directive) => pos > directive.from && pos < directive.to,
  )

/** Draws composer directives as chips and keeps them whole. */
export function composerDirectivesPlugin() {
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_config, state) => decorate(state),
      apply: (tr, set, _before, state) =>
        tr.docChanged ? decorate(state) : set,
    },
    props: {
      decorations: (state) => key.getState(state),
      handleKeyDown: (view, event) => {
        if (event.key !== 'Backspace' && event.key !== 'Delete') return false
        if (event.altKey || event.ctrlKey || event.metaKey) return false
        const { selection } = view.state
        if (!selection.empty) return false
        const at = selection.head
        const directive = documentDirectives(view.state).find((found) =>
          event.key === 'Backspace'
            ? at > found.from && at <= found.to
            : at >= found.from && at < found.to,
        )
        if (!directive) return false
        view.dispatch(view.state.tr.delete(directive.from, directive.to))
        return true
      },
    },
    // The caret never rests inside a chip's syntax. Moving into one from
    // either side carries it across; a click or an edit lands at the nearer edge.
    appendTransaction: (transactions, before, state) => {
      if (!transactions.some((tr) => tr.selectionSet || tr.docChanged)) return
      const { selection } = state
      if (!selection.empty) return
      const directive = around(state, selection.head)
      if (!directive) return
      const was = transactions.some((tr) => tr.docChanged)
        ? undefined
        : before.selection.head
      const nearer =
        selection.head - directive.from < directive.to - selection.head
          ? directive.from
          : directive.to
      const edge =
        was === undefined
          ? nearer
          : was <= directive.from
            ? directive.to
            : was >= directive.to
              ? directive.from
              : nearer
      return state.tr.setSelection(TextSelection.create(state.doc, edge))
    },
  })
}
