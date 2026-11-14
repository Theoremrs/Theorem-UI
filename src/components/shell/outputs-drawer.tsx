// SOURCING: Base UI Drawer (swipeDirection right, not modal), the same right-hand drawer as the side terminal, sharing its one slot in the shell state; @tanstack/react-router params for the page that is open; the artifact model and view for a conversation's own artifacts; components/projects/project-outputs for a project's. The owner's review on 2026-11-14: the drawer shows the open page's outputs as thumbnails, with no tabs.
import { Drawer } from '@base-ui/react/drawer'
import { useParams } from '@tanstack/react-router'
import { useArtifactView } from '@/components/artifacts/artifact-view'
import { useThreadArtifacts } from '@/components/artifacts/artifact-model'
import { ArtifactTile } from '@/components/artifacts/output-tile'
import { Icon } from '@/components/icons'
import { ProjectOutputs } from '@/components/projects/project-outputs'
import { useOrganization } from '@/lib/theorem/organization'
import { useShell } from './shell-state'

const close = () => useShell.getState().setSideDrawer(undefined)

/** What the conversation on screen made, in the order it made them. */
function ThreadOutputs() {
  const artifacts = [...useThreadArtifacts().values()]
  if (!artifacts.length)
    return (
      <p className="text-sm text-ink-muted">Nothing made in this chat yet.</p>
    )
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-4">
      {artifacts.map((versions) => (
        <ArtifactTile
          key={versions[0]?.artifactId}
          versions={versions}
          mark={versions.at(-1)?.kind === 'app' ? Icon.Apps : Icon.Artifact}
          onOpen={(artifactId) => {
            useArtifactView.getState().open(artifactId)
            close()
          }}
        />
      ))}
    </ul>
  )
}

/**
 * The right-hand drawer's outputs: a project's on its page, a conversation's
 * own in a chat, as a collection of thumbnails. It lies over the page rather
 * than taking its width, and gives way to whatever it opens.
 */
export function OutputsDrawer() {
  const open = useShell((s) => s.sideDrawer === 'outputs')
  const { projectId, threadId } = useParams({ strict: false })
  const { data: organization } = useOrganization()
  const onProject = projectId !== undefined && threadId === undefined
  const project = onProject
    ? organization?.projects.find((p) => p.projectId === projectId)
    : undefined
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) =>
        useShell.getState().setSideDrawer(next ? 'outputs' : undefined)
      }
      modal={false}
      disablePointerDismissal
      swipeDirection="right"
    >
      <Drawer.Portal>
        <Drawer.Viewport className="pointer-events-none fixed inset-0 z-40">
          <Drawer.Popup
            data-outputs-drawer=""
            className="pointer-events-auto absolute top-[3px] right-[3px] bottom-[3px] flex w-[calc(100vw-6px)] flex-col overflow-hidden rounded-xl bg-artifact text-ink shadow-[-8px_0_32px_rgb(0_0_0/0.18)] ring-1 ring-separator outline-none [transform:translateX(var(--drawer-swipe-movement-x))] transition-transform duration-[calc(var(--duration-glide)*var(--drawer-swipe-strength))] ease-glide data-ending-style:duration-(--duration-exit) data-ending-style:ease-exit data-ending-style:[transform:translateX(calc(100%+8px))] data-starting-style:[transform:translateX(calc(100%+8px))] data-swiping:duration-0 data-swiping:select-none md:w-90"
          >
            <div className="flex shrink-0 items-start gap-2 px-4 pt-3.5 pb-3">
              <div className="flex min-w-0 flex-1 flex-col">
                <Drawer.Title
                  data-appearance-recipe="ui.group"
                  className="text-ink"
                >
                  Apps and outputs
                </Drawer.Title>
                <Drawer.Description className="truncate text-xs text-ink-muted">
                  {onProject
                    ? `Made in ${project?.title ?? 'this project'}`
                    : 'Made in this chat'}
                </Drawer.Description>
              </div>
              <Drawer.Close
                aria-label="Close apps and outputs"
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
              >
                <Icon.Close className="size-4" />
              </Drawer.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
              {onProject ? (
                <ProjectOutputs projectId={projectId} onOpened={close} />
              ) : (
                <ThreadOutputs />
              )}
            </div>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}
