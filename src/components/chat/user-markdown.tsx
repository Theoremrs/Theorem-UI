import { defaultDirectiveFormatter } from '@assistant-ui/react'
import type { Root, Text } from 'mdast'
import { decodeString } from 'micromark-util-decode-string'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Plugin } from 'unified'
import { SKIP, visit } from 'unist-util-visit'
import { createDirectiveText } from '@/components/assistant-ui/elements/directive-text'
import { appearancePair } from '@/lib/appearance-policy'

const ToolText = createDirectiveText(defaultDirectiveFormatter)

const QUOTED = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4})){1,1024}"`

/** The directives the composer writes, as they appear in the sent Markdown. */
const USER_DIRECTIVE = new RegExp(
  String.raw`:tool\[[\p{L}\p{N}_.:/-]{1,1024}\]|:skill\[[^\]\n]{1,256}\](?:\{name=[^}\n]{1,1024}\})?|:(?:record|document)(?:\[[^\]\n]{1,1024}\](?:\{name=[^}\n]{1,1024}\})?|\{label=${QUOTED}(?: name=${QUOTED})?\})`,
  'gu',
)

/** A character Markdown can escape with a backslash. */
const ESCAPABLE = /[!-/:-@[-`{-~]/
/** A character reference, such as `&#58;` or `&amp;`. */
const REFERENCE = /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{0,31});/

/**
 * The text Markdown decodes `raw` to, with the source offset each character
 * came from: an escaped character comes from its backslash, a character
 * reference from its `&`, and any other character from itself.
 */
function decodeWithSource(raw: string) {
  let text = ''
  const from: number[] = []
  for (let i = 0; i < raw.length; ) {
    const char = raw[i]!
    if (char === '\\' && ESCAPABLE.test(raw[i + 1] ?? '')) {
      text += raw[i + 1]
      from.push(i)
      i += 2
      continue
    }
    const reference = char === '&' ? REFERENCE.exec(raw.slice(i, i + 40)) : null
    const value = reference && decodeString(reference[0])
    if (reference && value !== reference[0]) {
      text += value
      from.push(...Array<number>(value!.length).fill(i))
      i += reference[0].length
      continue
    }
    text += char
    from.push(i)
    i++
  }
  return { text, from }
}

/** Parse Markdown first: directive-looking code and link labels stay their own text. */
const remarkUserTools: Plugin<[], Root> = () => (tree, file) => {
  const source = String(file)
  visit(tree, (node, index, parent) => {
    if (node.type === 'link' || node.type === 'linkReference') return SKIP
    if (node.type !== 'text' || index === undefined || !parent) return
    const { start, end } = node.position ?? {}
    if (start?.offset === undefined || end?.offset === undefined) return
    const raw = source.slice(start.offset, end.offset)
    // Source escapes distinguish a literal directive from an actual tool chip.
    // If block indentation changed the text, leave it readable rather than guess.
    const decoded = decodeWithSource(raw)
    if (decoded.text !== node.value) return
    // Whether the decoded character at `at` is written as itself in the source.
    const written = (at: number) => raw[decoded.from[at]!] === node.value[at]
    const parts: Text[] = []
    let cursor = 0
    // A / tool pick writes `:tool[name]`; a skill from the + menu writes
    // `:skill[title]`, with `{name=id}` when the pack id differs from its title;
    // an @ pick writes `:record[title]{name=id}` or `:document[title]{name=id}`,
    // or `:record{label="..." name="..."}` when its title holds a `]`. Matching
    // the decoded text keeps a title's own escapes (`\*`, `\[`) out of its chip,
    // while the directive's syntax must be written plainly: an escaped `:`,
    // bracket or brace, or one written as a character reference, stays text.
    for (const match of node.value.matchAll(USER_DIRECTIVE)) {
      const from = match.index
      const to = from + match[0].length
      const open = from + match[0].search(/[[{]/)
      if (!written(from) || !written(open) || !written(to - 1)) continue
      // A literal Markdown link example is not an instruction to use a tool.
      if (node.value[to] === '(') continue
      if (from > cursor)
        parts.push({ type: 'text', value: node.value.slice(cursor, from) })
      parts.push({
        type: 'text',
        value: match[0],
        data: { hName: 'span', hProperties: { 'data-user-directive': match[0] } },
      })
      cursor = to
    }
    if (!parts.length) return
    if (cursor < node.value.length)
      parts.push({ type: 'text', value: node.value.slice(cursor) })
    parent.children.splice(index, 1, ...parts)
    return index + parts.length
  })
}

const components: Components = {
  p: ({ node: _node, ...props }) => <p data-appearance-recipe="prose" {...appearancePair('primary', 'user-message')} {...props} />,
  a: ({ node: _node, ...props }) => <a {...appearancePair('link', 'user-message')} {...props} />,
  code: ({ node: _node, ...props }) => <code data-appearance-recipe="code" {...appearancePair('code', 'popover')} {...props} />,

  span: ({ node, children, ...props }) => {
    const directive = node?.properties['data-user-directive']
    return typeof directive === 'string' ? (
      <ToolText text={directive} />
    ) : (
      <span {...props}>{children}</span>
    )
  },
  // Attachments have their own preview. Markdown images remain links so opening
  // a sent message cannot silently make third-party image requests.
  img: ({ src, alt, title }) => (
    <a href={typeof src === 'string' ? src : undefined} title={title}>
      {alt || 'Image'}
    </a>
  ),
}

export function UserMarkdown({ text }: { text: string }) {
  return (
    <div className="aui-user-markdown whitespace-normal [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:ps-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:ps-5 [&_li]:my-1 [&_blockquote]:my-2 [&_blockquote]:border-s-2 [&_blockquote]:border-separator [&_blockquote]:ps-3 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-popover [&_pre]:p-3 [&_pre]:text-[0.9em] [&_code]:bg-popover [&_code]:text-ink [&_code]:font-mono [&_pre_code]:whitespace-pre [&_a]:text-link [&_a]:underline [&_a]:underline-offset-2 [&_:is(h1,h2,h3,h4,h5,h6)]:my-2 [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkUserTools]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
