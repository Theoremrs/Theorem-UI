// SOURCING: none for the encoding, which is plain percent-encoded fields; the directive text assistant-ui's composer writes (`:type[Label]{name=id}`, components/chat/composer-mentions) and the Markdown link form every editor already round-trips, so a mention an editor cannot render is still a link that keeps its identity. LINK-01 and LINK-05.
import { isResourceIdentity } from './types'
import type { ResourceIdentity } from './types'

/**
 * Inserting a mention changes authored content and its reference projection,
 * and nothing else. It does not grant access, invite anyone, notify anyone
 * outside the workspace or start an agent; an action that does is a named
 * operation with its own recipients and authority (LINK-05).
 */
export const MENTION_EFFECTS = {
  changesContent: true,
  grantsAccess: false,
  notifies: false,
  startsAgent: false,
} as const

/** The scheme of the Markdown link a mention is written as. */
export const MENTION_SCHEME = 'theorem-resource:'

const enc = encodeURIComponent
const dec = decodeURIComponent

/** The identity as one token with no braces, brackets or spaces, so a directive or link keeps it intact. */
export function encodeIdentity(resource: ResourceIdentity): string {
  switch (resource.kind) {
    case 'file':
      return ['file', enc(resource.workspaceId), enc(resource.path)].join('|')
    case 'artifact':
      return [
        'artifact',
        enc(resource.artifactId),
        enc(String(resource.revision ?? '')),
      ].join('|')
    case 'message':
      return ['message', enc(resource.threadId), enc(resource.messageId)].join(
        '|',
      )
    case 'run':
      return ['run', enc(resource.runId)].join('|')
    case 'graph-object':
      return [
        'graph-object',
        enc(resource.objectId),
        enc(resource.objectType ?? ''),
      ].join('|')
    case 'record':
      return ['record', enc(resource.objectType), enc(resource.objectId)].join(
        '|',
      )
    case 'document':
      return ['document', enc(resource.documentId)].join('|')
    case 'work-item':
      return ['work-item', enc(resource.itemId)].join('|')
    case 'work-project':
      return ['work-project', enc(resource.projectId)].join('|')
    case 'thread':
      return ['thread', enc(resource.threadId)].join('|')
    case 'extension':
      return ['ext', enc(resource.extensionKind), enc(resource.id)].join('|')
  }
}

/** What a token names: a known identity, or a kind this client does not know, kept verbatim. */
export type DecodedMention =
  | { known: true; resource: ResourceIdentity }
  | { known: false; kind: string; token: string }

export function decodeIdentity(token: string): DecodedMention {
  const [kind = '', ...parts] = token.split('|')
  let fields: string[]
  try {
    fields = parts.map(dec)
  } catch {
    return { known: false, kind, token }
  }
  const [a = '', b = ''] = fields
  const candidate: unknown =
    kind === 'file'
      ? { kind, workspaceId: a, path: b }
      : kind === 'artifact'
        ? { kind, artifactId: a, ...(b && { revision: b }) }
        : kind === 'message'
          ? { kind, threadId: a, messageId: b }
          : kind === 'run'
            ? { kind, runId: a }
            : kind === 'graph-object'
              ? { kind, objectId: a, ...(b && { objectType: b }) }
              : kind === 'record'
                ? { kind, objectType: a, objectId: b }
                : kind === 'document'
                  ? { kind, documentId: a }
                  : kind === 'work-item'
                    ? { kind, itemId: a }
                    : kind === 'work-project'
                      ? { kind, projectId: a }
                      : kind === 'thread'
                        ? { kind, threadId: a }
                        : kind === 'ext'
                          ? { kind: 'extension', extensionKind: a, id: b }
                          : undefined
  return isResourceIdentity(candidate)
    ? { known: true, resource: candidate }
    : { known: false, kind, token }
}

/** Markdown escapes inside a link label. */
const escapeLabel = (label: string) => label.replace(/[\\[\]]/g, '\\$&')

/**
 * A mention as Markdown: `[Label](theorem-resource:TOKEN)`. The label is a
 * display hint; the token is the identity. An editor that has no mention node
 * keeps it as an ordinary link.
 */
export const mentionMarkdown = (resource: ResourceIdentity, label: string) =>
  `[${escapeLabel(label || 'Untitled')}](${MENTION_SCHEME}${encodeIdentity(resource)})`

export interface ParsedMention {
  token: string
  label: string
  decoded: DecodedMention
  /** The exact source text, so an unknown or unavailable mention is written back unchanged. */
  raw: string
  start: number
  end: number
}

const LINK = /\[((?:\\.|[^\\\]])*)\]\(theorem-resource:([^)\s]+)\)/g

/** Every mention in Markdown, with where it sits. Unknown kinds are returned, never skipped. */
export function parseMentions(markdown: string): ParsedMention[] {
  const found: ParsedMention[] = []
  for (const match of markdown.matchAll(LINK)) {
    const [raw, label = '', token = ''] = match
    found.push({
      token,
      label: label.replace(/\\(.)/g, '$1'),
      decoded: decodeIdentity(token),
      raw,
      start: match.index,
      end: match.index + raw.length,
    })
  }
  return found
}

/**
 * Writes mentions back for a save. A known mention is re-serialized from its
 * identity; an unknown or unavailable one keeps its raw text, so save never
 * drops a reference it could not render.
 */
export function serializeMentions(markdown: string): string {
  let out = ''
  let at = 0
  for (const one of parseMentions(markdown)) {
    out += markdown.slice(at, one.start)
    out += one.decoded.known
      ? mentionMarkdown(one.decoded.resource, one.label)
      : one.raw
    at = one.end
  }
  return out + markdown.slice(at)
}

/**
 * The ProseMirror node an editor adds for a mention: an inline atom that
 * holds the token and the label hint. The editor keeps its own rendering.
 */
export const MENTION_NODE_SPEC = {
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: true,
  attrs: { token: { default: '' }, label: { default: '' } },
  parseDOM: [
    {
      tag: 'span[data-resource-mention]',
      getAttrs: (dom: HTMLElement) => ({
        token: dom.getAttribute('data-resource-mention') ?? '',
        label: dom.textContent ?? '',
      }),
    },
  ],
  toDOM: (node: { attrs: { token: string; label: string } }) =>
    [
      'span',
      { 'data-resource-mention': node.attrs.token, class: 'resource-mention' },
      node.attrs.label || 'Untitled',
    ] as const,
}

/** The Markdown text for the node's attrs, so a node of any kind serializes to a link that keeps its token. */
export const mentionNodeMarkdown = (attrs: {
  token: string
  label: string
}) => {
  const label = escapeLabel(attrs.label || 'Untitled')
  return `[${label}](${MENTION_SCHEME}${attrs.token})`
}
