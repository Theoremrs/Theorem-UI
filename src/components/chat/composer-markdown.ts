// SOURCING: mdast-util-to-markdown's text handler escapes literal Markdown
// punctuation according to the surrounding document. Theorem's tool picker
// uses assistant-ui's :tool[name] directive protocol inside that document, and
// the + menu's Skills its :skill[title]{name=id}.
import type { Text } from 'mdast'
import { defaultHandlers } from 'mdast-util-to-markdown'
import type { Handle } from 'mdast-util-to-markdown'

/**
 * Preserve the document's meaning when it is sent or reopened for editing.
 * Tool and skill directives are the intentional exceptions: assistant-ui and
 * the turn's model read their bracket syntax directly from the payload. Keep the serializer's escaping of
 * surrounding punctuation (including a following parenthesis) intact.
 */
export const serializeComposerText: Handle = (
  node: Text,
  parent,
  state,
  info,
) => {
  // The slash picker inserts a final space and locates its caret in this text.
  // A paragraph's synthetic following newline must not turn that space into
  // an entity. A real hard break is a following node and keeps its context.
  const atParagraphEnd =
    parent?.type === 'paragraph' && parent.children.at(-1) === node
  const context =
    atParagraphEnd && info.after === '\n' ? { ...info, after: '' } : info
  // A skill from the + menu is `:skill[title]`, with `{name=id}` when its id
  // differs from its title, the same shape user-markdown reads as a chip.
  return defaultHandlers
    .text(node, parent, state, context)
    .replace(/:tool\\\[([\p{L}\p{N}_.:/-]{1,1024})\]/gu, ':tool[$1]')
    .replace(/:skill\\\[([^\]\n]{1,256})\]/gu, ':skill[$1]')
}
