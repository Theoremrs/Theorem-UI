// SOURCING: ui/button and the shared artifact actions; bodies render through
// the registry (artifact-registry resolve + artifact-renderers' mount table).
//
// A live authored artifact runs directly in the answer. Its expanded view is
// the same mounted instance. Other results keep their excerpt and panel.
// The representation chooses the behavior, never the artifact kind.
//
// Excerpts can open in the dock's panel. A live artifact always belongs to
// its answer; expanding it does not open a second runtime in the dock.
import { appearancePair } from '@/lib/appearance-policy'
import { useAuiState } from '@assistant-ui/react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
} from 'react'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { followArtifact } from '@/components/ide/follow'
import { useOpenMode } from '@/components/shell/modes'
import { recordLaunch } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { kindLabel, useThreadArtifacts } from './artifact-model'
import type { TheoremArtifact } from './artifact-model'
import { isBare, isLive, representationOf } from './artifact-registry'
import { ArtifactView } from './artifact-renderers'
import { ArtifactActions } from './artifact-actions'
import { focusInlineArtifact, InlineArtifact } from './inline-artifact'
import { OpenLatestContext } from './app-history'
import { useArtifactView } from './artifact-view'
import { OPENS_WHOLE, thingProps } from '@/lib/face/things'

/**
 * Where a conversation's artifacts open: in the dock's panels beside it, or
 * in the message itself when the conversation has no dock beside it.
 */
export const ArtifactPlacement = createContext<'panel' | 'inline'>('panel')

export function ArtifactMessage({ artifact }: { artifact: TheoremArtifact }) {
  const artifacts = useThreadArtifacts()
  const inline = useContext(ArtifactPlacement) === 'inline'
  const liveInline = isLive(artifact, 'interactive')
  const { open } = useArtifactView.getState()
  const openMode = useOpenMode()
  const selected = useArtifactView(
    (s) => s.openId !== undefined && s.openId === artifact.artifactId,
  )
  // A bare artifact is already whole in the reply: the working turn's does
  // not also open in the panel.
  const bare = isBare(artifact, 'preview')
  const { cardRef, launch } = useArtifactLaunch(
    artifact,
    !inline && !liveInline && !bare,
  )

  const versions = artifacts.get(artifact.artifactId) ?? [artifact]
  const position = versions.findIndex((v) => v.revision === artifact.revision)
  const newest = versions.at(-1) ?? artifact
  const latest = position === versions.length - 1 && newest.partId === artifact.partId
  if (bare)
    return (
      <div
        data-slot="theorem-artifact-bare"
        data-artifact-id={artifact.artifactId}
        {...thingProps('artifact', artifact.artifactId, {
          label: artifact.title,
        })}
      >
        <ArtifactView artifact={artifact} distance="preview" latest={latest} />
      </div>
    )
  const show = () => {
    launch()
    open(artifact.artifactId, latest ? undefined : artifact.revision)
    // The dock is chat's; from a page the larger view is there.
    if (inline) void openMode('chat')
  }
  const previewed =
    representationOf(artifact, 'preview').rung !== 'theorem_card'

  if (liveInline)
    return (
      <InlineArtifact
        title={artifact.title}
        artifactId={artifact.artifactId}
        partId={artifact.partId}
        current={latest}
        actions={
          <ArtifactActions
            key={artifact.revision}
            artifact={artifact}
            latest={latest}
          />
        }
      >
        <OpenLatestContext value={() => {
          if (focusInlineArtifact(newest.partId)) return
          launch()
          open(artifact.artifactId)
          if (inline) void openMode('chat')
        }}>
          <ArtifactView artifact={artifact} distance="interactive" latest={latest} />
        </OpenLatestContext>
      </InlineArtifact>
    )

  return (
    <div className="my-3 w-full">
      <ArtifactMessageCard
        artifact={artifact}
        cardRef={cardRef}
        selected={selected}
        latest={latest}
        wide={previewed}
        version={versions.length > 1 ? ` · v${position + 1}` : ''}
        show={show}
      >
        {previewed && (
          <ArtifactView
            artifact={artifact}
            distance="preview"
            latest={latest}
          />
        )}
      </ArtifactMessageCard>
    </div>
  )
}

function ArtifactMessageCard({
  artifact,
  cardRef,
  selected,
  latest,
  wide,
  version,
  show,
  children,
}: {
  artifact: TheoremArtifact
  cardRef: React.RefObject<HTMLDivElement | null>
  selected: boolean
  latest: boolean
  wide: boolean
  version: string
  show: () => void
  children?: React.ReactNode
}) {
  return (
    <div
      ref={cardRef}
      data-slot="theorem-artifact-card"
      data-appearance-part="artifact"
      data-appearance-radius-role="artifact"
      data-surface-role="artifact"
      data-face-perch="artifact"
      {...thingProps('artifact', artifact.artifactId, {
        label: artifact.title,
      })}
      data-artifact-id={artifact.artifactId}
      data-selected={selected || undefined}
      data-appearance-expanded={wide || undefined}
      className={cn(
        'appearance-artifact-card flex w-full flex-col overflow-hidden rounded-artifact border border-separator bg-artifact',
        !wide && 'max-w-md',
        'transition-colors duration-100',
        selected && 'bg-selected outline outline-1 outline-redwood-ink',
      )}
    >
      <div className="flex w-full items-center gap-3 p-4">
        <button
          type="button"
          onClick={show}
          className="flex min-w-0 flex-1 items-center gap-3 text-start"
          aria-label={`Open ${artifact.title}`}
          {...appearancePair('primary', selected ? 'selected' : 'artifact')}
        >
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-raised text-ink-muted">
            <Icon.Artifact className="size-5 animate-float motion-reduce:animate-none" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span
              className={cn(
                'truncate text-sm',
                selected ? 'font-semibold' : 'font-medium',
              )}
            >
              {artifact.title}
            </span>
            <span data-appearance-recipe="metadata" {...appearancePair('secondary', selected ? 'selected' : 'artifact')} className="truncate text-ink-muted">
              {kindLabel(artifact)}
              {version}
            </span>
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            aria-label="Open in larger view"
            // Theo presses this for a part the excerpt below cuts off.
            {...OPENS_WHOLE}
            className="group/open size-8 p-1.5"
            onClick={show}
          >
            <Icon.Open className="size-4" />
          </Button>
          <ArtifactActions
            key={artifact.revision}
            artifact={artifact}
            latest={latest}
          />
        </div>
      </div>
      {children && <div className="border-t border-separator">{children}</div>}
    </div>
  )
}

/** `follows`: an artifact the working turn writes opens in its panel as it does. */
function useArtifactLaunch(artifact: TheoremArtifact, follows: boolean) {
  const live = useAuiState((s) => s.message.status?.type === 'running')
  const { artifactId, revision } = artifact
  // Following the Agent opens what it can show without a live session; a live
  // one waits for the person to ask for it.
  const passive = !isLive(artifact, 'thing')
  const cardRef = useRef<HTMLDivElement>(null)
  const launch = useCallback(() => {
    if (cardRef.current)
      recordLaunch(
        cardRef.current.getBoundingClientRect(),
        `artifact:${artifactId}`,
      )
  }, [artifactId])
  useEffect(() => {
    if (!follows || !live || !passive) return
    launch()
    followArtifact(artifactId)
  }, [follows, live, artifactId, revision, passive, launch])
  return { cardRef, launch }
}
