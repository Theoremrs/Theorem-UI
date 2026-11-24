// SOURCING: assistant-ui's canvas-split element (vendored in assistant-ui/elements): the document beside the thread, its header (title, version, saved or editing, close) and its body's writing caret; ui/button (ghost icon buttons) for the version steps and Expand; bodies render through the registry (artifact-renderers' ArtifactView), except a live interactive newest, whose runtime belongs to its answer (artifact-referrer)
import { useAuiState } from '@assistant-ui/react'
import { appearancePair } from '@/lib/appearance-policy'
import { useLayoutEffect, useRef } from 'react'
import {
  CanvasSplitBody,
  CanvasSplitDocument,
  CanvasSplitHeader,
} from '@/components/assistant-ui/elements/canvas-split'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { flyGhost, takeLaunch } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { messageIdOf, useThreadArtifacts } from './artifact-model'
import type { TheoremArtifact } from './artifact-model'
import { ArtifactActions } from './artifact-actions'
import { fillsPanel, isLive } from './artifact-registry'
import { ArtifactView } from './artifact-renderers'
import { ArtifactReferrer } from './artifact-referrer'
import { useArtifactView } from './artifact-view'
import { thingProps } from '@/lib/face/things'

export { download } from './artifact-actions'

export function ArtifactKindIcon({
  kind,
  className,
}: {
  kind: string
  className?: string
}) {
  const Glyph =
    kind === 'code'
      ? Icon.Code
      : kind === 'diagram' || kind === 'graph'
        ? Icon.Diagram
        : Icon.Article
  return <Glyph className={className} />
}
/**
 * Canvas for one artifact, the document half of a canvas split: header
 * actions, revision switcher, rendered body. The dock is the split itself,
 * so the conversation keeps its reading width beside it.
 */
export function ArtifactPanel({
  artifactId,
  onClose,
  expanded,
  onExpandedChange,
  className,
}: {
  artifactId: string
  onClose: () => void
  /** Omitted where the canvas cannot expand, as on phones where it is already full screen. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  className?: string
}) {
  const artifacts = useThreadArtifacts()
  const revision = useArtifactView((s) => s.revisions[artifactId])
  const select = useArtifactView((s) => s.select)
  const sectionRef = useRef<HTMLDivElement>(null)
  const newestRevision = artifacts.get(artifactId)?.at(-1)?.revision
  // The turn is still writing the newest revision while the reply that
  // carries it runs; only the last reply can be running.
  const writing = useAuiState((s) => {
    const last = s.thread.messages.at(-1)
    return (
      last?.status?.type === 'running' &&
      newestRevision !== undefined &&
      messageIdOf([last], { artifactId, revision: newestRevision }) !==
        undefined
    )
  })

  // Opened from a chat card, the canvas grows out of that card. The frame
  // after mount is when the dock or the phone overlay has its final size.
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const origin = takeLaunch(`artifact:${artifactId}`)
      if (origin && sectionRef.current)
        flyGhost(origin, sectionRef.current, {
          className: 'rounded-artifact border border-separator bg-artifact',
        })
    })
    return () => cancelAnimationFrame(frame)
  }, [artifactId])

  const versions = artifacts.get(artifactId)
  if (!versions?.length) return null
  const index = selectedArtifactIndex(versions, revision)
  const newest = versions[versions.length - 1]
  const artifact = versions[index] ?? newest
  if (!artifact || !newest) return null
  const latest = artifact === newest
  const editing = writing && latest
  const fills = fillsPanel(artifact, 'interactive')
  // A live interactive artifact runs in the answer that wrote it; the panel
  // refers to that one runtime instead of mounting a second (PR #128 P1).
  const liveNewest = isLive(newest, 'interactive')
  const goTo = (next: number) =>
    select(
      artifactId,
      next >= versions.length - 1 ? undefined : versions[next]?.revision,
    )

  return (
    <CanvasSplitDocument
      ref={sectionRef}
      role="region"
      data-appearance-part="artifact"
      data-appearance-radius-role="artifact"
      data-surface-role="artifact"
      {...appearancePair('primary', 'artifact')}
      aria-label={`Artifact: ${artifact.title}`}
      // The whole of what the conversation's card shows an excerpt of: Theo
      // points here while it is open.
      {...thingProps('artifact', artifactId, {
        label: artifact.title,
        whole: true,
      })}
      className={cn('h-full bg-artifact', className)}
    >
      <ArtifactPanelHeader
        artifact={artifact}
        index={index}
        versionCount={versions.length}
        saved={!editing}
        goTo={goTo}
        expanded={expanded}
        onExpandedChange={onExpandedChange}
        onClose={onClose}
      />

      <div
        className={cn(
          'min-h-0 flex-1',
          fills ? 'flex flex-col' : 'overflow-y-auto',
        )}
      >
        {/* A body that fills the panel, such as an App's frame, has no
            line for the caret to follow. */}
        <CanvasSplitBody
          writing={editing && !fills}
          className={cn(
            'min-h-0 overflow-visible',
            fills
              ? 'gap-0 p-0'
              : 'mx-auto w-full max-w-(--appearance-expanded-measure) flex-none px-6 py-6',
          )}
        >
          {/* The newest slot stays mounted while an older revision is shown,
              so the look back costs nothing on the way back. A passive body
              keeps its unsaved edit; a live interactive one is already kept
              by its answer, so this slot only refers there. */}
          <div
            hidden={!latest}
            className={cn(fills && latest && 'min-h-0 flex-1')}
          >
            {liveNewest ? (
              <ArtifactReferrer artifact={newest} />
            ) : (
              <ArtifactView artifact={newest} distance="interactive" latest />
            )}
          </div>
          {!latest && (
            <div className={cn(fills && 'min-h-0 flex-1')}>
              <ArtifactView
                key={artifact.revision}
                artifact={artifact}
                distance="interactive"
                latest={false}
              />
            </div>
          )}
        </CanvasSplitBody>
      </div>
    </CanvasSplitDocument>
  )
}
function ArtifactPanelHeader({
  artifact,
  index,
  versionCount,
  saved,
  goTo,
  expanded,
  onExpandedChange,
  onClose,
}: {
  artifact: TheoremArtifact
  index: number
  versionCount: number
  saved: boolean
  goTo: (index: number) => void
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  onClose: () => void
}) {
  return (
    <CanvasSplitHeader
      title={artifact.title}
      version={index + 1}
      versions={versionCount}
      saved={saved}
      icon={
        <ArtifactKindIcon
          kind={artifact.kind}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      }
      onClose={onClose}
    >
      {versionCount > 1 && (
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous version"
            className="size-7 p-1.5"
            disabled={index === 0}
            onClick={() => goTo(index - 1)}
          >
            <Icon.Previous className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next version"
            className="size-7 p-1.5"
            disabled={index === versionCount - 1}
            onClick={() => goTo(index + 1)}
          >
            <Icon.Next className="size-3.5" />
          </Button>
        </div>
      )}

      <ArtifactActions
        key={artifact.revision}
        artifact={artifact}
        latest={index === versionCount - 1}
        copy
      />
      {onExpandedChange && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={expanded ? 'Restore layout' : 'Expand'}
          className={cn('size-8 p-1.5', expanded && 'bg-selected')}
          aria-pressed={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          <Icon.Expand className="size-4" />
        </Button>
      )}
    </CanvasSplitHeader>
  )
}

function selectedArtifactIndex(
  versions: readonly TheoremArtifact[],
  revision?: string,
) {
  return Math.max(
    0,
    revision === undefined
      ? versions.length - 1
      : versions.findIndex((v) => v.revision === revision),
  )
}
