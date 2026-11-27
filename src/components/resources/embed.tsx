// SOURCING: lib/resources embed-guard (cycle, depth and budget), the owner's preview through ./use-resource usePreview, the chip and the open action of this folder, React context for the path of ancestors, and the app's Button and the coss Badge. LINK-06: inline, compact and embedded presentations of one resource; live or pinned said in words; read-only unless an editor is explicitly supplied; a collapsed fallback with a way to the original.
import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { Badge } from '@/components/coss/badge'
import { Button } from '@/components/ui/button'
import {
  COLLAPSE_LABEL,
  enterEmbed,
  rootEmbedPath,
} from '@/lib/resources/embed-guard'
import type { EmbedPath } from '@/lib/resources/embed-guard'
import { canonicalKey } from '@/lib/resources/registry'
import { STATE_DETAIL, STATE_LABEL } from '@/lib/resources/state'
import type { ResourceRef } from '@/lib/resources/types'
import { openResource } from './open-resource'
import { ResourceChip } from './resource-chip'
import { DefaultPreviewBody } from './resource-preview'
import { usePreview } from './use-resource'

export type EmbedMode = 'inline' | 'compact' | 'embedded'

const EmbedPathContext = createContext<EmbedPath | undefined>(undefined)

/** Starts a fresh budget for the embeds under it, for a page that is not itself inside an embed. */
export function EmbedRoot({ children }: { children: ReactNode }) {
  const path = useMemo(() => rootEmbedPath(), [])
  return (
    <EmbedPathContext.Provider value={path}>
      {children}
    </EmbedPathContext.Provider>
  )
}

/** The words that say whether an embed follows current state or a retained revision. */
export const embedModeLabel = (ref: ResourceRef) =>
  ref.revision?.mode === 'pinned'
    ? `Pinned to revision ${ref.revision.revision}`
    : 'Live: follows the current version'

export function Embed({
  resourceRef,
  mode = 'compact',
  children,
  editor,
}: {
  resourceRef: ResourceRef
  mode?: EmbedMode
  /** What the embedded content shows beyond the preview, such as further embeds; it sees this embed as its ancestor. */
  children?: ReactNode
  /** An explicitly selected editor. Without one the embed is read-only. */
  editor?: ReactNode
}) {
  const inherited = useContext(EmbedPathContext)
  const ancestors = useMemo(() => inherited ?? rootEmbedPath(), [inherited])
  const key = canonicalKey(resourceRef.resource)
  const entry = useMemo(() => enterEmbed(ancestors, key), [ancestors, key])
  const enabled = mode !== 'inline' && entry.ok
  const view = usePreview(resourceRef, enabled)

  if (mode === 'inline') return <ResourceChip resourceRef={resourceRef} />
  if (!entry.ok)
    return (
      <div
        role="note"
        data-embed-collapsed={entry.reason}
        className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-separator px-2 py-1 text-xs text-ink-muted"
      >
        <ResourceChip resourceRef={resourceRef} withPreview={false} />
        <span>{COLLAPSE_LABEL[entry.reason]}</span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => void openResource(resourceRef)}
        >
          Open original
        </Button>
      </div>
    )
  return (
    <EmbedPathContext.Provider value={entry.path}>
      <figure
        className="flex flex-col gap-1.5 rounded-md border border-separator bg-raised p-2"
        data-embed-mode={mode}
      >
        <figcaption className="flex flex-wrap items-center gap-1.5 text-xs">
          <Badge variant="outline">
            {resourceRef.revision?.mode === 'pinned' ? 'Pinned' : 'Live'}
          </Badge>
          <span className="text-ink-muted">{embedModeLabel(resourceRef)}</span>
          {!editor && <span className="text-ink-muted">Read only</span>}
        </figcaption>
        {view.status === 'loading' && (
          <p role="status" className="text-sm text-ink-muted">
            Loading…
          </p>
        )}
        {view.status !== 'loading' && view.status !== 'ready' && (
          <p role="status" className="text-sm">
            <strong>{STATE_LABEL[view.status]}.</strong>{' '}
            <span className="text-ink-muted">{STATE_DETAIL[view.status]}</span>
          </p>
        )}
        {view.status === 'ready' && (
          <>
            <div className="flex flex-col">
              <span className="text-xs text-ink-muted">
                {view.preview.typeLabel}
              </span>
              <span className="text-sm font-medium text-ink">
                {view.preview.title}
              </span>
            </div>
            {mode === 'embedded' && (
              <DefaultPreviewBody preview={view.preview} />
            )}
            {mode === 'embedded' && editor}
            {mode === 'embedded' && children}
          </>
        )}
        <div>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void openResource(resourceRef)}
          >
            Open original
          </Button>
        </div>
      </figure>
    </EmbedPathContext.Provider>
  )
}
