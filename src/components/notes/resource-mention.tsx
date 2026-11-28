// SOURCING: Milkdown's $remark, $node and $view and unist-util-visit, the same way ./kinds/block-syntax and ./kinds/block-view carry a theorem-embed fence; @prosemirror-adapter/react for the React node view; the mention encoding of lib/resources/mention, whose token is the identity. LINK-01: an identity-based mention in a note is one inline atom, written back as the Markdown link `[Label](theorem-resource:TOKEN)` that any other editor keeps as a link, and a token this client does not know is kept verbatim.
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { RemarkPluginRaw } from '@milkdown/kit/transformer'
import { $node, $remark, $view } from '@milkdown/kit/utils'
import { useNodeViewContext } from '@prosemirror-adapter/react'
import type { Link, PhrasingContent, Text } from 'mdast'
import { visit } from 'unist-util-visit'
import { nodeViewFactoryCtx } from '@/components/handlers/markdown/syntax'
import { ResourceChip } from '@/components/resources/resource-chip'
import { MENTION_SCHEME, decodeIdentity } from '@/lib/resources/mention'

const NODE = 'resourceMention'
const MDAST = 'resourceMention'

const textOf = (nodes: PhrasingContent[]): string =>
  nodes
    .map((node) =>
      'value' in node
        ? String((node as Text).value)
        : 'children' in node
          ? textOf(node.children)
          : '',
    )
    .join('')

type MentionMdast = { type: typeof MDAST; token: string; label: string }

/** A link to `theorem-resource:` is a mention, not a link, once read. */
const remarkMention: RemarkPluginRaw<undefined> = () => (tree) => {
  visit(tree, 'link', (node: Link, index, parent) => {
    if (!node.url.startsWith(MENTION_SCHEME) || !parent || index === undefined)
      return
    const mention: MentionMdast = {
      type: MDAST,
      token: node.url.slice(MENTION_SCHEME.length),
      label: textOf(node.children),
    }
    ;(parent.children as unknown[])[index] = mention
  })
}

export const remarkResourceMention = $remark(
  'resourceMention',
  () => remarkMention,
)

export const resourceMentionNode = $node(NODE, () => ({
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  marks: '',
  attrs: { token: { default: '' }, label: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-resource-mention]',
      getAttrs: (dom) => ({
        token: dom.getAttribute('data-resource-mention') ?? '',
        label: dom.textContent,
      }),
    },
  ],
  toDOM: (node: ProseNode) => [
    'span',
    { 'data-resource-mention': String(node.attrs.token) },
    String(node.attrs.label || 'Untitled'),
  ],
  parseMarkdown: {
    match: (node) => node.type === MDAST,
    runner: (state, node, type) => {
      const mention = node as unknown as MentionMdast
      state.addNode(type, { token: mention.token, label: mention.label })
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === NODE,
    runner: (state, node) => {
      // The token is written back exactly as read, known or not.
      state
        .openNode('link', undefined, {
          url: `${MENTION_SCHEME}${String(node.attrs.token)}`,
        })
        .addNode('text', undefined, String(node.attrs.label || 'Untitled'))
        .closeNode()
    },
  },
}))

function MentionView() {
  const { node } = useNodeViewContext()
  const token = String(node.attrs.token)
  const label = String(node.attrs.label || 'Untitled')
  const decoded = decodeIdentity(token)
  return (
    <span contentEditable={false} className="mx-0.5 inline-flex align-baseline">
      {decoded.known ? (
        <ResourceChip
          resourceRef={{
            resource: decoded.resource,
            revision: { mode: 'live' },
            hint: { label },
          }}
        />
      ) : (
        // A kind this client has no provider for: shown as its label, kept as its token.
        <span
          className="rounded-sm bg-ink/4 px-1 text-[13px] text-ink-muted"
          title="This kind of resource cannot be shown here yet."
        >
          {label}
        </span>
      )}
    </span>
  )
}

export const resourceMentionView = $view(resourceMentionNode, (ctx) => {
  const create = ctx.get(nodeViewFactoryCtx.key)
  if (!create) throw new Error('The note editor sets nodeViewFactoryCtx.')
  return create({
    component: MentionView,
    stopEvent: () => false,
    ignoreMutation: () => true,
  })
})
