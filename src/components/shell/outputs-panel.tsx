// SOURCING: zustand (the mounted dock's opener, as lib/theorem/project-files' useFileDock is), @tanstack/react-router params for the page that is open, components/projects/project-outputs for a project's apps and outputs, the artifact model and view for a conversation's own artifacts. The owner's review on 2026-11-14 moved a project's apps and outputs from its page into the dock's side group, scoped to whatever page is open.
import { useParams } from '@tanstack/react-router'
import { create } from 'zustand'
import { useArtifactView } from '@/components/artifacts/artifact-view'
import {
  kindLabel,
  useThreadArtifacts,
} from '@/components/artifacts/artifact-model'
import { Icon } from '@/components/icons'
import { ProjectOutputs } from '@/components/projects/project-outputs'
import { useOrganization } from '@/lib/theorem/organization'

/** The dock panel's id and component name. */
export const OUTPUTS_PANEL = 'outputs'

/** Opens the outputs panel in the mounted dock; unset while no dock is mounted. */
export const useOutputsDock = create<{ open?: () => void }>(() => ({}))

/** What the conversation on screen made, newest last as the thread made them. */
function ThreadOutputs() {
  const artifacts = [...useThreadArtifacts().values()]
  if (!artifacts.length)
    return (
      <p className="text-sm text-ink-muted">Nothing made in this chat yet.</p>
    )
  return (
    <ul className="flex flex-col gap-px">
      {artifacts.map((versions) => {
        const latest = versions.at(-1)
        if (!latest) return null
        return (
          <li key={latest.artifactId}>
            <button
              type="button"
              title={latest.title}
              onClick={() => useArtifactView.getState().open(latest.artifactId)}
              className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-start hover:bg-hover"
            >
              <Icon.Artifact
                aria-hidden
                className="size-4 shrink-0 text-ink-muted"
              />
              <span
                data-appearance-recipe="ui.label"
                className="min-w-0 flex-1 truncate"
              >
                {latest.title}
              </span>
              <span className="shrink-0 text-xs text-ink-muted">
                {versions.length > 1
                  ? `${versions.length} revisions`
                  : kindLabel(latest)}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The apps and outputs of the page that is open: a project's on its page, a
 * conversation's own in a chat. Each opens beside it, in this same group.
 */
export function OutputsDockPanel() {
  const { projectId, threadId } = useParams({ strict: false })
  const { data: organization } = useOrganization()
  const onProject = projectId !== undefined && threadId === undefined
  const project = onProject
    ? organization?.projects.find((p) => p.projectId === projectId)
    : undefined
  return (
    <div className="h-full overflow-y-auto bg-artifact">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex flex-col">
          <h2 data-appearance-recipe="ui.group" className="text-ink">
            Apps and outputs
          </h2>
          <p className="truncate text-xs text-ink-muted">
            {onProject
              ? `Made in ${project?.title ?? 'this project'}`
              : 'Made in this chat'}
          </p>
        </div>
        {onProject ? (
          <ProjectOutputs projectId={projectId} />
        ) : (
          <ThreadOutputs />
        )}
      </div>
    </div>
  )
}
