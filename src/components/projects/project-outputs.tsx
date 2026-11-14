// SOURCING: lib/theorem/organization's project outputs read, the artifact view and review opener, the owned output marks from components/icons, the output tiles the right drawer shows. A project's outputs carry no picture yet, so each tile shows its mark until Theorem serves a poster.
import { useNavigate } from '@tanstack/react-router'
import { Icon } from '@/components/icons'
import { OutputTile } from '@/components/artifacts/output-tile'
import { useArtifactView } from '@/components/artifacts/artifact-view'
import { useShell } from '@/components/shell/shell-state'
import { describeError } from '@/lib/theorem/client'
import { useProjectOutputs } from '@/lib/theorem/organization'
import { openReview } from '@/lib/theorem/reviews'

export const OUTPUT_MARK = {
  app: Icon.Apps,
  artifact: Icon.Artifact,
  upload: Icon.Attachment,
  review: Icon.Compare,
} as const

const OUTPUT_KIND = {
  app: 'App',
  artifact: 'Artifact',
  upload: 'Upload',
  review: 'Review',
} as const

/** Files, apps and artifact revisions a project's sessions produced; each opens where it was made. */
export function ProjectOutputs({
  projectId,
  onOpened,
}: {
  projectId: string
  /** Called once an output has been opened. */
  onOpened?: () => void
}) {
  const outputs = useProjectOutputs(projectId)
  const navigate = useNavigate()
  const items = outputs.data?.items ?? []
  if (outputs.error)
    return (
      <p className="text-sm text-error-ink">{describeError(outputs.error)}</p>
    )
  if (outputs.isPending)
    return <p className="text-sm text-ink-muted">Loading…</p>
  if (!items.length)
    return <p className="text-sm text-ink-muted">Nothing produced yet.</p>
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-4">
      {items.map((item) => (
        <OutputTile
          key={item.outputId}
          title={item.title}
          detail={
            item.revisionCount > 1
              ? `${OUTPUT_KIND[item.kind]} · ${item.revisionCount} revisions`
              : OUTPUT_KIND[item.kind]
          }
          mark={OUTPUT_MARK[item.kind]}
          onOpen={async () => {
            useShell.getState().setProjectId(projectId)
            await navigate({
              to: '/c/$threadId',
              params: { threadId: item.threadId },
            })
            if (item.artifactId)
              useArtifactView.getState().open(item.artifactId)
            if (item.reviewId) openReview(item.reviewId)
            onOpened?.()
          }}
        />
      ))}
    </ul>
  )
}
