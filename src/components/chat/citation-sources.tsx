// SOURCING: assistant-ui LinkPreview, the shared link-metadata query, and coss
// Popover for the owner's Sources hyperlink + chevron dropdown. This panel
// contains evidence and several controls, so normal Tab navigation applies.
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { FC } from 'react'
import { useAuiState } from '@assistant-ui/react'
import { hashKey, useQueryClient } from '@tanstack/react-query'
import { LinkPreview } from '@/components/assistant-ui/elements/link-preview'
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/coss/popover'
import { Icon } from '@/components/icons'
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { askAbout } from '@/components/chat/composer-references'
import {
  citationContextReference,
  citationEvidenceKind,
  collectCitationSources,
} from '@/lib/theorem/citations'
import type { CitationSource } from '@/lib/theorem/citations'
import {
  linkMetadataQueryKey,
  useLinkMetadata,
} from '@/lib/theorem/link-preview'

export { citationUrl } from '@/lib/theorem/citations'
export type { CitationSource } from '@/lib/theorem/citations'

const sourceControl =
  'inline-flex min-h-8 items-center gap-1 rounded-sm px-1.5 text-xs text-ink-muted outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus [@media(pointer:coarse)]:min-h-11'

/** One durable source identity, with all of its distinct supporting passages. */
export function useCitationSources(): CitationSource[] {
  const content = useAuiState((s) => s.message.content)
  return useMemo(() => collectCitationSources(content), [content])
}

/**
 * Full previews where metadata resolved, with a navigable Sources dropdown
 * for loading, failed and unlinked evidence. Each source owns its query so
 * streaming a new citation never changes another component's hook order.
 */
export const CitationSources: FC = () => {
  const sources = useCitationSources()
  if (sources.length === 0) return null
  return (
    <div data-slot="citation-sources" className="mt-2 flex flex-col gap-2">
      {sources.map((source) => (
        <SourceSlot key={source.key} source={source} />
      ))}
      <SourcesRow sources={sources} />
    </div>
  )
}

const SourceSlot: FC<{ source: CitationSource }> = ({ source }) => {
  const metadata = useLinkMetadata(source.url)
  if (!source.url || !metadata.data) return null
  // Page authors control metadata image URLs. Keep the complete text card and
  // local site initial without making automatic requests from the viewer.
  return (
    <div
      className="flex max-w-md flex-col gap-1"
      data-source-id={source.sourceId}
      data-source-key={source.key}
    >
      <LinkPreview
        layout="compact"
        href={source.url}
        title={metadata.data.title ?? source.label}
        description={metadata.data.description ?? source.passages[0]?.excerpt}
        siteName={metadata.data.siteName}
      />
      <EvidenceLine source={source} />
      <SourceActions source={source} />
    </div>
  )
}

/** Each passage keeps its own inspector and copy feedback as more arrive. A
 * retained capture's passage also names the exact UTF-8 byte range within
 * its version, so the reader sees which slice of the kept text the quote is. */
const SourcePassage: FC<{
  source: CitationSource
  excerpt: string
  index: number
}> = ({ source, excerpt, index }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard()
  const passageName =
    source.passages.length > 1
      ? `supporting passage ${index + 1} of ${source.passages.length}`
      : 'supporting passage'
  const span = source.passages[index]?.span
  return (
    <div
      data-slot="source-passage"
      className="flex flex-wrap items-center gap-1"
    >
      <Popover>
        <PopoverTrigger
          className={`${sourceControl} min-w-0 text-start leading-relaxed underline decoration-dotted underline-offset-2`}
          aria-label={`Read the ${passageName} of ${source.label}`}
        >
          {excerpt.length > 140 ? `${excerpt.slice(0, 140)}…` : excerpt}
        </PopoverTrigger>
        <PopoverPopup
          side="right"
          align="start"
          className="w-80 max-w-[calc(100vw-2rem)]"
        >
          <PopoverTitle className="sr-only">
            {source.label}: {passageName}
          </PopoverTitle>
          <blockquote
            tabIndex={0}
            className="max-h-64 overflow-y-auto whitespace-pre-wrap px-1 text-sm leading-relaxed outline-none focus-visible:outline-2 focus-visible:outline-focus"
          >
            {excerpt}
          </blockquote>
        </PopoverPopup>
      </Popover>
      <button
        type="button"
        className={sourceControl}
        aria-label={`Copy the ${passageName} of ${source.label}`}
        onClick={() => void copyToClipboard(excerpt)}
      >
        {isCopied ? (
          <Icon.Copied aria-hidden className="size-3" />
        ) : (
          <Icon.Copy aria-hidden className="size-3" />
        )}
        {isCopied ? 'Copied' : 'Copy passage'}
      </button>
      {span && (
        <span data-slot="passage-span" data-appearance-recipe="metadata">
          bytes {span.startByte}–{span.endByte}
        </span>
      )}
    </div>
  )
}

/** What the wire itself proves about where this evidence came from. Only
 * retained captures name a version; the handle is a reference, not a claim
 * that it can still be opened — bounded opening belongs to the server's
 * `source_read`, which rechecks authority when called. */
const EvidenceLine: FC<{ source: CitationSource }> = ({ source }) => {
  const kind = citationEvidenceKind(source)
  if (kind === 'discovery')
    return (
      <span
        data-slot="evidence-kind"
        data-appearance-recipe="metadata"
        className="text-ink-muted"
      >
        Search snippet
      </span>
    )
  if (kind === 'retained' && source.capture)
    return (
      <span
        data-slot="evidence-kind"
        data-appearance-recipe="metadata"
        className="text-ink-muted"
      >
        Retained capture · {source.capture.version}
        {source.capture.coverage.status === 'acquisition_capped'
          ? ` · capped at ${source.capture.coverage.limitBytes} B, tail not fetched`
          : ''}
      </span>
    )
  if (source.sourceKind === 'web_read')
    return (
      <span
        data-slot="evidence-kind"
        data-appearance-recipe="metadata"
        className="text-ink-muted"
      >
        Inspected preview, not retained
      </span>
    )
  return null
}

const SourceActions: FC<{ source: CitationSource }> = ({ source }) => {
  const threadId = useAuiState((s) => s.threadListItem.remoteId)
  const messageId = useAuiState((s) => s.message.id)
  const [contextError, setContextError] = useState<string | null>(null)
  if (source.passages.length === 0 && !threadId) return null
  return (
    <div data-slot="source-actions" className="flex flex-col items-start gap-1">
      {source.passages.map(({ excerpt }, index) => (
        <SourcePassage
          key={excerpt}
          source={source}
          excerpt={excerpt}
          index={index}
        />
      ))}
      {threadId && (
        <button
          type="button"
          className={sourceControl}
          onClick={() => {
            try {
              askAbout(citationContextReference(source, threadId, messageId))
              setContextError(null)
            } catch (error) {
              setContextError(
                error instanceof Error
                  ? error.message
                  : 'Could not add this source to context.',
              )
            }
          }}
        >
          <Icon.Chat aria-hidden className="size-3" />
          Add to context
        </button>
      )}
      {contextError && (
        <p role="alert" className="text-xs text-error-ink">
          {contextError}
        </p>
      )}
    </div>
  )
}

/** A stable primitive snapshot avoids both new-array render loops and keys
 * being split on punctuation that legitimately occurs in source IDs/URLs. */
function useUnresolvedSources(sources: CitationSource[]): CitationSource[] {
  const cache = useQueryClient().getQueryCache()
  const snapshot = useSyncExternalStore(
    (callback) => cache.subscribe(callback),
    () =>
      JSON.stringify(
        sources
          .filter(
            (source) =>
              !source.url ||
              !cache.get(hashKey(linkMetadataQueryKey(source.url)))?.state.data,
          )
          .map((source) => source.key),
      ),
    () => JSON.stringify(sources.map((source) => source.key)),
  )
  const keys = new Set<string>(JSON.parse(snapshot))
  return sources.filter((source) => keys.has(source.key))
}

const SourcesRow: FC<{ sources: CitationSource[] }> = ({ sources }) => {
  const unresolved = useUnresolvedSources(sources)
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [retainedKeys, setRetainedKeys] = useState<readonly string[]>([])
  const rowRef = useRef<HTMLDivElement>(null)
  const resolvedFocus = useRef<HTMLAnchorElement>(null)
  // Keep displayed identities while the panel is open or the closed row owns
  // focus, so metadata cannot remove a source or its invoking control.
  const retain = open || focused
  const addedKeys = retain
    ? unresolved.filter((source) => !retainedKeys.includes(source.key))
    : []
  if (addedKeys.length > 0)
    setRetainedKeys([...retainedKeys, ...addedKeys.map((source) => source.key)])
  const listed = retain
    ? sources.filter(
        (source) =>
          retainedKeys.includes(source.key) ||
          unresolved.some((entry) => entry.key === source.key),
      )
    : unresolved
  if (listed.length === 0) return null
  const firstLink = listed.find((source) => source.url)?.url
  return (
    <div
      ref={rowRef}
      data-slot="sources-row"
      className="flex items-center gap-0.5 text-sm"
      onFocusCapture={(event) => {
        if (
          !open &&
          event.currentTarget.contains(event.target) &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          setFocused(true)
          setRetainedKeys(listed.map((source) => source.key))
        }
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false)
          if (!open) setRetainedKeys([])
        }
      }}
    >
      <Icon.Link
        aria-hidden
        className="me-1 size-3.5 shrink-0 text-ink-muted"
      />
      {firstLink ? (
        <a
          href={firstLink}
          target="_blank"
          rel="noreferrer"
          className="text-link underline underline-offset-2 outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
        >
          Sources{' '}
          <span className="text-ink-muted no-underline">({listed.length})</span>
        </a>
      ) : (
        <span className="text-ink-muted">Sources ({listed.length})</span>
      )}
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          resolvedFocus.current = null
          if (
            !next &&
            (details.reason === 'escape-key' ||
              details.reason === 'trigger-press') &&
            unresolved.length === 0
          ) {
            // Once every source resolves, this trigger disappears on close.
            // Hand focus to the preview for the source the reader was using.
            const row = rowRef.current
            const focusedKey =
              row?.ownerDocument.activeElement?.closest<HTMLElement>(
                '[data-slot="source-entry"]',
              )?.dataset.sourceKey
            const sourceKey = focusedKey ?? listed[0]?.key
            const preview = [
              ...(row?.parentElement?.querySelectorAll<HTMLElement>(
                '[data-source-key]',
              ) ?? []),
            ].find((element) => element.dataset.sourceKey === sourceKey)
            resolvedFocus.current =
              preview?.querySelector<HTMLAnchorElement>(
                '[data-slot="link-preview"] a',
              ) ?? null
          }
          setFocused(false)
          setRetainedKeys(next ? listed.map((source) => source.key) : [])
          setOpen(next)
        }}
      >
        <PopoverTrigger
          aria-label="List sources"
          className="flex size-8 items-center justify-center rounded-sm text-ink-muted outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus [@media(pointer:coarse)]:size-11"
        >
          <Icon.ChevronDown aria-hidden className="size-3.5" />
        </PopoverTrigger>
        <PopoverPopup
          align="start"
          finalFocus={unresolved.length === 0 ? resolvedFocus : undefined}
          className="w-80 max-w-[calc(100vw-2rem)]"
        >
          <PopoverTitle className="sr-only">Sources</PopoverTitle>
          <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
            {listed.map((source) => (
              <SourceEntry key={source.key} source={source} />
            ))}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  )
}

const SourceEntry: FC<{ source: CitationSource }> = ({ source }) => {
  const host = source.url ? new URL(source.url).hostname : undefined
  return (
    <section
      data-slot="source-entry"
      data-source-id={source.sourceId}
      data-source-key={source.key}
      aria-label={source.label}
      className="flex flex-col items-start gap-1"
    >
      <span data-appearance-recipe="ui.section" className="wrap-break-word">
        {source.label}
      </span>
      {host && (
        <span data-appearance-recipe="metadata" className="text-ink-muted">
          {host}
        </span>
      )}
      <EvidenceLine source={source} />
      {source.url && (
        <a
          href={source.url}
          target="_blank"
          rel="noreferrer"
          className={sourceControl}
        >
          <Icon.Detach aria-hidden className="size-3" />
          Open source
        </a>
      )}
      <SourceActions source={source} />
    </section>
  )
}
