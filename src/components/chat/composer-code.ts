import { exitCode } from '@milkdown/kit/prose/commands'
import { Slice } from '@milkdown/kit/prose/model'
import type { Node } from '@milkdown/kit/prose/model'
import { Selection, TextSelection } from '@milkdown/kit/prose/state'
import { closeHistory } from '@milkdown/kit/prose/history'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Parser } from '@milkdown/kit/transformer'

/** Replace an opening fence or insert an empty block after the current block. */
export function insertCodeBlock(view: EditorView, language?: string) {
  const { state } = view
  const selection = state.selection.$from.depth
    ? state.selection
    : Selection.atEnd(state.doc)
  const { $from, empty } = selection
  const block = state.schema.nodes.code_block?.create({
    language: language ?? '',
  })
  if (!block) return false
  const tr = closeHistory(state.tr)
  const replace =
    language !== undefined || (empty && !$from.parent.content.size)
  let at = $from.depth ? $from.after(1) : state.doc.content.size
  if (
    replace &&
    $from.depth &&
    $from
      .node(-1)
      .canReplaceWith($from.index(-1), $from.index(-1) + 1, block.type)
  ) {
    at = $from.before()
    tr.replaceWith(at, $from.after(), block)
  } else {
    if (language !== undefined) {
      tr.delete($from.start(), $from.end())
      at = tr.mapping.map($from.after())
    }
    tr.insert(at, block)
  }
  view.dispatch(
    tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView(),
  )
  view.focus()
  return true
}

export function openCodeFence(view: EditorView) {
  const { $from, empty } = view.state.selection
  if (!empty || $from.parent.type.name !== 'paragraph') return false
  if ($from.parentOffset !== $from.parent.content.size) return false
  const fence = /^ {0,3}(?:`{3,}|~{3,})([\w+.#-]*)[ \t]*$/u.exec(
    $from.parent.textContent,
  )
  return fence ? insertCodeBlock(view, fence[1]) : false
}

export function leaveCodeBlock(view: EditorView) {
  if (!exitCode(view.state, view.dispatch)) return false
  view.focus()
  return true
}

/** Rich clipboard markup should not hide literal Markdown fences from the parser. */
export function pasteMarkdownCode(
  view: EditorView,
  data: DataTransfer,
  parse: Parser,
) {
  const html = data.getData('text/html')
  if (!html || /<pre[\s>]/iu.test(html)) return false
  const fence = /(?:`{3,}|~{3,})/u
  const plain = data.getData('text/plain')
  if (!fence.test(plain) && !fence.test(html)) return false
  const markdown = fence.test(plain) ? plain : literalHtmlText(html)
  const doc = parse(markdown)
  if (!containsCodeBlock(doc)) return false
  view.dispatch(
    closeHistory(view.state.tr)
      .replaceSelection(new Slice(doc.content, 0, 0))
      .setMeta('paste', true)
      .scrollIntoView(),
  )
  return true
}

function containsCodeBlock(node: Node): boolean {
  return node.type.name === 'code_block' || node.children.some(containsCodeBlock)
}

/** The clipboard may carry literal fence paragraphs without a plain-text flavor. */
function literalHtmlText(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const br of template.content.querySelectorAll('br')) br.replaceWith('\n')
  for (const block of template.content.querySelectorAll('p,div,li'))
    block.after('\n')
  return template.content.textContent
}

/** Milkdown reads data-language on pre. Copy aliases from semantic code HTML. */
export function codeClipboardHtml(html: string) {
  if (!/<pre[\s>]/iu.test(html)) return html
  const template = document.createElement('template')
  template.innerHTML = html
  for (const pre of template.content.querySelectorAll('pre')) {
    const code = pre.querySelector('code')
    const classes = [...(code?.classList ?? []), ...pre.classList]
    const label = classes.find((name) => /^(?:language|lang)-.+/u.test(name))
    const language =
      pre.dataset.language ??
      code?.dataset.language ??
      label?.replace(/^(?:language|lang)-/u, '')
    if (language) pre.dataset.language = language
    for (const br of pre.querySelectorAll('br')) br.replaceWith('\n')
  }
  return template.innerHTML
}
