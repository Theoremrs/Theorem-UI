import { defaultDirectiveFormatter } from '@assistant-ui/react'
import { Link, useRouter } from '@tanstack/react-router'
import type { Root, Text } from 'mdast'
import { decodeString } from 'micromark-util-decode-string'
import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { createContext, useContext } from 'react'
import type { HTMLAttributes, MouseEvent } from 'react'
import type { Plugin } from 'unified'
import { SKIP, visit } from 'unist-util-visit'
import { createDirectiveText } from '@/components/assistant-ui/elements/directive-text'
import {
  InlineCode,
  MARKDOWN_REMARK,
  markdownElements,
  markdownRehype,
  preprocessMarkdown,
} from '@/components/chat/markdown-elements'
import { useOpenDocumentHandler } from '@/components/crm/open-document'
import { parseRecordItemId } from '@/components/records/model'
import { appearancePair } from '@/lib/appearance-policy'

const DOCUMENT_MENTION = 'document:'

/**
 * The element an @ pick's chip renders as, so the chip opens what it cites:
 * a document where the surrounding inspector opens documents, else (as any
 * record or document) as the Index's open item, beside its view. With nowhere
 * to open it (no router, as in a story), and for a / tool or + skill, the chip
 * stays text.
 */
function MentionLink({
  type,
  id,
  ...props
}: { type: string; id: string } & HTMLAttributes<HTMLElement>) {
  const router = useRouter({ warn: false })
  const openDocument = useOpenDocumentHandler()
  const documentId =
    type === 'document' && id.startsWith(DOCUMENT_MENTION)
      ? id.slice(DOCUMENT_MENTION.length) || undefined
      : undefined
  const item =
    documentId ?? (type === 'record' && parseRecordItemId(id) ? id : undefined)
  // The message around the chip has its own click handling (selecting, editing).
  const stop = (event: MouseEvent) => event.stopPropagation()
  if (documentId && openDocument)
    return (
      <button
        type="button"
        {...props}
        onClick={(event) => {
          stop(event)
          openDocument(documentId)
        }}
      />
    )
  if (item && router)
    return (
      <Link
        to="/index"
        search={(prev) => ({ ...prev, item })}
        {...props}
        onClick={stop}
      />
    )
  return <span {...props} />
}

const ToolText = createDirectiveText(defaultDirectiveFormatter, {
  renderChip: ({ type, id }) =>
    type === 'record' || type === 'document' ? (
      <MentionLink type={type} id={id} />
    ) : undefined,
})

/** The inside of a JSON string, as assistant-ui writes a quoted label or id. */
const QUOTED = String.raw`(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4})){1,1024}`

/**
 * The directives the composer writes, as they appear in the sent Markdown.
 * Each group is a title or id; everything outside the groups is syntax.
 */
const USER_DIRECTIVE = new RegExp(
  String.raw`:tool\[([\p{L}\p{N}_.:/-]{1,1024})\]|:skill\[([^\]\n]{1,256})\](?:\{name=([^}\n]{1,1024})\})?|:(?:record|document)(?:\[([^\]\n]{1,1024})\](?:\{name=([^}\n]{1,1024})\})?|\{label="(${QUOTED})"(?: name="(${QUOTED})")?\})`,
  'dgu',
)

/** A character Markdown can escape with a backslash. */
const ESCAPABLE = /[!-/:-@[-`{-~]/
/** A character reference, such as `&#58;` or `&amp;`. */
const REFERENCE =
  /^&(?:#\d{1,7}|#[xX][\da-fA-F]{1,6}|[A-Za-z][A-Za-z\d]{0,31});/

/**
 * The text Markdown decodes `raw` to, with the source offset each character
 * came from: an escaped character comes from its backslash, a character
 * reference from its `&`, and any other character from itself.
 */
function decodeWithSource(raw: string) {
  let text = ''
  const from: number[] = []
  for (let i = 0; i < raw.length;) {
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
    // while every character of the directive's syntax must be written plainly:
    // one escaped (`\:`, `\[`, `\{`) or written as a character reference stays
    // text, and so does the whole directive.
    for (const match of node.value.matchAll(USER_DIRECTIVE)) {
      const from = match.index
      const to = from + match[0].length
      const titles = match
        .indices!.slice(1)
        .filter((span) => span !== undefined)
      const syntax = (at: number) =>
        !titles.some(([first, last]) => at >= first && at < last)
      let plain = true
      for (let at = from; at < to && plain; at++)
        plain = !syntax(at) || written(at)
      if (!plain) continue
      // A literal Markdown link example is not an instruction to use a tool.
      if (node.value[to] === '(') continue
      if (from > cursor)
        parts.push({ type: 'text', value: node.value.slice(cursor, from) })
      parts.push({
        type: 'text',
        value: match[0],
        data: {
          hName: 'span',
          hProperties: { 'data-user-directive': match[0] },
        },
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

/** Set inside a fenced block, so its code is the block's and not inline. */
const InCodeBlock = createContext(false)

const components: Components = {
  ...markdownElements('human'),
  pre: ({ node: _node, ...props }) => (
    <InCodeBlock.Provider value>
      <pre
        className="bg-popover overflow-x-auto rounded-lg p-3 text-[0.9em]"
        {...props}
      />
    </InCodeBlock.Provider>
  ),
  code: function Code(props) {
    const block = useContext(InCodeBlock)
    if (!block) return <InlineCode voice="human" {...props} />
    const { node: _node, ...rest } = props
    return (
      <code
        data-appearance-recipe="code"
        {...appearancePair('primary', 'popover')}
        className="whitespace-pre"
        {...rest}
      />
    )
  },

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

const HUMAN_REMARK = [...MARKDOWN_REMARK, remarkUserTools]
const HUMAN_REHYPE = markdownRehype('human')

/**
 * The person's sent turn: the reply's elements and math in their own voice
 * (Manrope at their own line), with chips for their tool, skill and @ picks.
 */
export function UserMarkdown({ text }: { text: string }) {
  return (
    <div className="aui-user-markdown whitespace-normal">
      <ReactMarkdown
        remarkPlugins={HUMAN_REMARK}
        rehypePlugins={HUMAN_REHYPE}
        components={components}
      >
        {preprocessMarkdown(text)}
      </ReactMarkdown>
    </div>
  )
}
