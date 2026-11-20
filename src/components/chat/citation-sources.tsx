// SOURCING: the installed assistant-ui link-preview element (elements/link-preview.tsx, props-only) fed by lib/theorem/link-preview's metadata query; coss ui Menu for the Sources dropdown (the owner's attached Edit-row pattern: a hyperlink with a chevron beside it); Icon for the marks; askAbout for Add to context. One renderer per message: previews for the sources whose metadata resolved, one "Sources" hyperlink row with a dropdown for the rest — never chips.
import { useMemo, useSyncExternalStore } from 'react'
import type { FC } from 'react'
import { useAuiState } from '@assistant-ui/react'
import { LinkPreview } from '@/components/assistant-ui/elements/link-preview'
import {
  Menu,
  MenuItem,
  MenuLinkItem,
  MenuPopup,
  MenuTrigger,
} from '@/components/coss/menu'
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from '@/components/coss/popover'
import { Icon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { askAbout } from '@/components/chat/composer-references'
import { hashKey, useQueryClient } from '@tanstack/react-query'
import {
  linkMetadataQueryKey,
  useLinkMetadata,
} from '@/lib/theorem/link-preview'

type Json = Record<string, unknown>

const object = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : {}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/** External evidence links must name an absolute web URL; never infer a destination. */
export function citationUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

export interface CitationSource {
  key: string
  label: string
  url: string | undefined
  passage: string | undefined
  sourceId: string | undefined
}

/** The message's distinct sources, in citation order: one entry per source
 *  (the first citation of a source carries it; later ones draw nothing). */
export function useCitationSources(): CitationSource[] {
  const content = useAuiState((s) => s.message.content)
  return useMemo(() => {
    const seen = new Set<string>()
    const sources: CitationSource[] = []
    for (const part of content) {
      if (part.type !== 'data' || part.name !== 'theorem-citation') continue
      const data = object(part.data)
      const url = citationUrl(object(data.provenance).url)
      const label =
        str(data.label) ?? (url && new URL(url).hostname) ?? 'Source'
      const key = str(data.sourceId) ?? url ?? label
      if (seen.has(key)) continue
      seen.add(key)
      sources.push({
        key,
        label,
        url,
        passage: str(object(data.provenance).excerpt),
        sourceId: str(data.sourceId),
      })
    }
    return sources
  }, [content])
}

/**
 * The sources of one assistant message, drawn once after its parts:
 * a full link preview per source whose metadata resolved (preferred), and
 * one "Sources" hyperlink row with a dropdown for the rest. While metadata
 * is loading the source waits in the row; a failure keeps it there for good.
 */
export const CitationSources: FC = () => {
  const sources = useCitationSources()
  if (sources.length === 0) return null
  return (
    <div data-slot="citation-sources" className="mt-2 flex flex-col gap-2">
      <SourcesBody sources={sources} />
    </div>
  )
}

/** The previews and the row. Each source owns its own metadata query inside
 *  its own component, so a source arriving mid-stream mounts a new hook set
 *  rather than changing this one's. */
const SourcesBody: FC<{ sources: CitationSource[] }> = ({ sources }) => {
  return (
    <>
      {sources.map((source) => (
        <SourceSlot key={source.key} source={source} />
      ))}
      <SourcesRow sources={sources} />
    </>
  )
}

/** One source: a full link preview once its metadata has resolved, nothing
 *  while it loads or after it fails (the Sources row carries those). */
const SourceSlot: FC<{ source: CitationSource }> = ({ source }) => {
  const metadata = useLinkMetadata(source.url)
  if (!source.url || !metadata.data) return null
  return (
    <LinkPreview
      layout="compact"
      href={source.url}
      title={metadata.data.title ?? source.label}
      description={metadata.data.description ?? source.passage}
      image={metadata.data.image}
      siteName={metadata.data.siteName}
      favicon={metadata.data.favicon}
      className="max-w-md"
      data-source-id={source.sourceId}
    />
  )
}

/**
 * "Sources" as a hyperlink with a dropdown beside it (the owner's attached
 * pattern: the underlined link opens, the chevron lists). The link opens the
 * first unresolved source; the dropdown lists every unresolved source with
 * its passage, Open, Add to context and Copy.
 */
/** The sources whose preview metadata is not in the cache yet (loading or
 *  failed). Reads the shared query cache through useSyncExternalStore, so
 *  the row re-renders when a preview resolves without owning any query. */
function useUnresolvedSources(sources: CitationSource[]): CitationSource[] {
  const client = useQueryClient()
  const cache = client.getQueryCache()
  const snapshot = useSyncExternalStore(
    (callback) => cache.subscribe(callback),
    () =>
      sources
        .filter(
          (source) =>
            !cache.get(hashKey(linkMetadataQueryKey(source.url ?? '')))?.state
              .data,
        )
        .map((source) => source.key)
        .join('|'),
    () => '',
  )
  const keys = new Set(snapshot ? snapshot.split('|') : [])
  return sources.filter((source) => keys.has(source.key))
}

/** One row for all the sources whose previews have not resolved. Each
 *  source's query lives in the shared cache (SourceSlot owns the observer);
 *  the row reads that cache, so its own hook set never changes. */
const SourcesRow: FC<{ sources: CitationSource[] }> = ({ sources }) => {
  const unresolved = useUnresolvedSources(sources)
  if (unresolved.length === 0) return null
  const first = unresolved[0]!
  return (
    <div data-slot="sources-row" className="flex items-center gap-0.5 text-sm">
      <Icon.Link className="me-1 size-3.5 shrink-0 text-ink-muted" />
      {first.url ? (
        <a
          href={first.url}
          target="_blank"
          rel="noreferrer"
          className="text-link underline underline-offset-2 hover:text-ink"
        >
          Sources
          <span className="text-ink-muted no-underline">
            {' '}
            ({unresolved.length})
          </span>
        </a>
      ) : (
        <span className="text-ink-muted">Sources ({unresolved.length})</span>
      )}
      <Menu>
        <MenuTrigger
          aria-label="List sources"
          className="flex size-5 items-center justify-center rounded-sm text-ink-muted outline-focus hover:bg-hover hover:text-ink focus-visible:outline-2"
        >
          <Icon.ChevronDown className="size-3.5" />
        </MenuTrigger>
        <MenuPopup align="start" className="w-80 max-w-[calc(100vw-2rem)]">
          {unresolved.map((source) => (
            <SourceEntry key={source.key} source={source} />
          ))}
        </MenuPopup>
      </Menu>
    </div>
  )
}

/** One source in the dropdown: its label and passage, then its actions. */
const SourceEntry: FC<{ source: CitationSource }> = ({ source }) => {
  const threadId = useAuiState((s) => s.threadListItem.remoteId)
  const messageId = useAuiState((s) => s.message.id)
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  const host = source.url ? new URL(source.url).hostname : undefined
  return (
    <div data-slot="source-entry" className="flex flex-col gap-1 px-2 py-1.5">
      <span data-appearance-recipe="ui.section" className="wrap-break-word">
        {source.label}
      </span>
      {host && (
        <span data-appearance-recipe="metadata" className="text-ink-muted">
          {host}
        </span>
      )}
      {source.passage && (
        <Popover>
          <PopoverTrigger
            className="cursor-pointer text-start text-xs leading-relaxed text-ink-muted underline decoration-dotted underline-offset-2 hover:text-ink"
            aria-label={`Read the supporting passage of ${source.label}`}
          >
            {source.passage.length > 140
              ? `${source.passage.slice(0, 140)}…`
              : source.passage}
          </PopoverTrigger>
          <PopoverPopup
            side="right"
            align="start"
            className="w-80 max-w-[calc(100vw-2rem)]"
          >
            <blockquote className="max-h-64 overflow-y-auto px-1 text-sm leading-relaxed">
              {source.passage}
            </blockquote>
          </PopoverPopup>
        </Popover>
      )}
      <div className="flex flex-wrap items-center gap-1">
        {source.url && (
          <MenuLinkItem
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs"
          >
            <Icon.Detach className="size-3" />
            Open source
          </MenuLinkItem>
        )}
        {threadId && (
          <MenuItem
            className="text-xs"
            onClick={() =>
              askAbout({
                label: source.label,
                excerpt: source.passage ?? source.url,
                location: {
                  resource: { kind: 'message', threadId, messageId },
                },
              })
            }
          >
            <Icon.Chat className="size-3" />
            Add to context
          </MenuItem>
        )}
        {source.passage && (
          <MenuItem
            className="text-xs"
            onClick={() => void copyToClipboard(source.passage!)}
          >
            {isCopied ? (
              <Icon.Copied className="size-3" />
            ) : (
              <Icon.Copy className="size-3" />
            )}
            {isCopied ? 'Copied' : 'Copy passage'}
          </MenuItem>
        )}
      </div>
    </div>
  )
}
