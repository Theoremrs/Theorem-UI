// SOURCING: ui/button (ghost icon buttons) for header actions, useCopyToClipboard hook; bodies render through the registry (artifact-renderers' ArtifactView), except a live interactive newest, whose runtime belongs to its answer (artifact-referrer)
import { appearancePair } from '@/lib/appearance-policy'
import { useLayoutEffect, useRef } from 'react'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { flyGhost, takeLaunch } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { kindLabel, useThreadArtifacts } from './artifact-model'
import type { TheoremArtifact } from './artifact-model'
import { ArtifactActions } from './artifact-actions'
import { fillsPanel, isLive } from './artifact-registry'
import { ArtifactView } from './artifact-renderers'
import { ArtifactReferrer } from './artifact-referrer'
import { shownRevision, useArtifactView, viewOf } from './artifact-view'
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
/** Canvas for one artifact: header actions, revision switcher, rendered body. */
export function ArtifactPanel({
  artifactId,
  versions: given,
  threadId,
  onClose,
  expanded,
  onExpandedChange,
  keepable,
  className,
}: {
  artifactId: string
  /** Revisions read from another conversation; the conversation on screen is read otherwise. */
  versions?: readonly TheoremArtifact[]
  /** The conversation those revisions came from, when it is not the one on screen. */
  threadId?: string
  onClose: () => void
  /** Omitted where the canvas cannot expand, as on phones where it is already full screen. */
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  /** Offers to keep the panel open across chats; only the dock can. */
  keepable?: boolean
  className?: string
}) {
  const artifacts = useThreadArtifacts()
  const view = useArtifactView((s) => viewOf(s.views, artifactId))
  const revision = shownRevision(view)
  const select = useArtifactView((s) => s.select)
  const keep = useArtifactView((s) => s.keep)
  const sectionRef = useRef<HTMLElement>(null)

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

  const versions = given ?? artifacts.get(artifactId)
  if (!versions?.length) return null
  const index = selectedArtifactIndex(versions, revision)
  const newest = versions[versions.length - 1]
  const artifact = versions[index] ?? newest
  if (!artifact || !newest) return null
  const latest = artifact === newest
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
    <section
      ref={sectionRef}
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
      className={cn('flex h-full min-w-0 flex-col bg-artifact', className)}
    >
      <ArtifactPanelHeader
        artifact={artifact}
        index={index}
        versionCount={versions.length}
        goTo={goTo}
        following={view.follow}
        kept={keepable ? view.keep : undefined}
        onKeptChange={(next) => keep(artifactId, next)}
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
        <div
          className={cn(
            fills
              ? 'flex min-h-0 flex-1 flex-col'
              : 'mx-auto w-full max-w-(--appearance-expanded-measure) px-6 py-6',
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
              <ArtifactReferrer artifact={newest} threadId={threadId} />
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
        </div>
      </div>
    </section>
  )
}
function ArtifactPanelHeader({
  artifact,
  index,
  versionCount,
  goTo,
  following,
  kept,
  onKeptChange,
  expanded,
  onExpandedChange,
  onClose,
}: {
  artifact: TheoremArtifact
  index: number
  versionCount: number
  goTo: (index: number) => void
  /** Whether the view moves to each new revision; a chosen revision stays put. */
  following: boolean
  /** Undefined where the panel cannot be kept across chats. */
  kept?: boolean
  onKeptChange: (kept: boolean) => void
  expanded?: boolean
  onExpandedChange?: (expanded: boolean) => void
  onClose: () => void
}) {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-separator px-3">
      <ArtifactKindIcon
        kind={artifact.kind}
        className="size-4 shrink-0 text-ink-muted"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <h2 className="truncate font-heading text-[16px] font-semibold leading-tight">
          {artifact.title}
        </h2>
        <p className="truncate text-xs text-ink-faint">{kindLabel(artifact)}</p>
      </div>

      {/* A chosen revision stays fixed while newer ones arrive (AR-06); this is the one quiet
          way back to the current work. */}
      {!following && index < versionCount - 1 && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-ink-muted"
          onClick={() => goTo(versionCount - 1)}
        >
          Newer version
        </Button>
      )}
      {versionCount > 1 && (
        <div className="flex items-center text-xs text-ink-muted">
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
          <span className="min-w-12 text-center tabular-nums">
            v{index + 1} of {versionCount}
          </span>
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
      {kept !== undefined && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Keep open in other chats"
          title="Keep open in other chats"
          className={cn('size-8 p-1.5', kept && 'bg-selected')}
          aria-pressed={kept}
          onClick={() => onKeptChange(!kept)}
        >
          <Icon.Pin className="size-4" />
        </Button>
      )}
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
      <Button
        variant="ghost"
        size="icon"
        aria-label="Close"
        className="size-8 p-1.5"
        onClick={onClose}
      >
        <Icon.X className="size-4" />
      </Button>
    </header>
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
