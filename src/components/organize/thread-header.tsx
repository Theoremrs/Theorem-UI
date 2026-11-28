// SOURCING: coss ui breadcrumb (with the slash separator of coss's custom-separator example) and menu over Base UI, assistant-ui for the open thread's title, lib/theorem/organization, the same ThreadMenuItems the sidebar's rows open.
import { useAuiState } from '@assistant-ui/react'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { useState } from 'react'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/coss/breadcrumb'
import { Input } from '@/components/coss/input'
import { Menu, MenuPopup, MenuTrigger } from '@/components/coss/menu'
import { Icon } from '@/components/icons'
import {
  primaryProjectId,
  useOrganization,
  useOrganizedViews,
  useThreadEdits,
} from '@/lib/theorem/organization'
import { useStartThreadFrom } from '@/lib/theorem/thread-tree'
import { ProjectGlyph } from './glyphs'
import { ThreadMenuItems } from './thread-menu'

const headerButton =
  'group/thread-more flex size-7 min-h-(--appearance-control-min) min-w-(--appearance-control-min) shrink-0 items-center justify-center rounded-md text-ink-muted outline-none hover:text-ink focus-visible:outline-2 focus-visible:outline-focus'

/** Where the thread sits and what can be done to it; the dock's one layout menu sits at its end. */
export function ThreadHeader({ actions }: { actions?: ReactNode }) {
  // On a project's home there is no open thread: the header names the project.
  const { threadId, projectId: home } = useParams({ strict: false })
  const title = useAuiState((s) => s.threadListItem.title)
  const running = useAuiState((s) => s.thread.isRunning)
  const { data: organization } = useOrganization()
  const views = useOrganizedViews()
  const navigate = useNavigate()
  const edits = useThreadEdits()
  const startThread = useStartThreadFrom()
  const [renaming, setRenaming] = useState(false)

  const thread = threadId ? views.byId.get(threadId) : undefined
  const primary = thread && primaryProjectId(thread)
  const project = organization?.projects.find((p) => p.projectId === primary)
  const homeProject =
    home === undefined
      ? undefined
      : organization?.projects.find((p) => p.projectId === home)
  const served = organization?.served ?? false
  const shownTitle = homeProject
    ? homeProject.title
    : thread?.title || title || 'New chat'

  return (
    // No rule under it: the breadcrumb sits in the conversation's own space,
    // and pinning lives in the "More" menu with everything else done to it.
    // Tucked into the corner: a compact line of the project and the title,
    // no glyph, the More button straight after it.
    <header className="appearance-thread-header flex shrink-0 items-center gap-0.5 ps-2.5 pe-2 tracking-[-0.005em]">
      <Breadcrumb aria-label="Thread location" className="min-w-0">
        <BreadcrumbList className="flex-nowrap gap-1 text-[0.8125rem] leading-4 text-ink-muted sm:gap-1">
          {!homeProject && project && !project.isInbox && (
            <>
              <BreadcrumbItem className="max-w-40 shrink-0">
                <span className="truncate">{project.title}</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="text-ink-faint">
                /
              </BreadcrumbSeparator>
            </>
          )}
          <BreadcrumbItem className="min-w-0">
            {renaming && thread ? (
              <Input
                autoFocus
                size="sm"
                aria-label="Rename thread"
                defaultValue={thread.title}
                className="h-6 max-w-80"
                onFocus={(event) => event.target.select()}
                onBlur={() => setRenaming(false)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return
                  if (event.key === 'Escape') setRenaming(false)
                  if (event.key !== 'Enter') return
                  const next = event.currentTarget.value.trim()
                  if (next && next !== thread.title)
                    edits.rename.mutate({
                      threadId: thread.threadId,
                      title: next,
                    })
                  setRenaming(false)
                }}
              />
            ) : (
              <h1 className="min-w-0 truncate">
                <BreadcrumbPage className="font-medium text-ink">
                  {shownTitle}
                </BreadcrumbPage>
              </h1>
            )}
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      {thread && (
        <Menu>
          <MenuTrigger aria-label="More" className={headerButton}>
            <span
              aria-hidden
              className="pointer-events-none flex size-7 items-center justify-center rounded-md group-hover/thread-more:bg-hover group-data-popup-open/thread-more:bg-hover"
            >
              <Icon.More className="size-4" />
            </span>
          </MenuTrigger>
          <MenuPopup align="end" className="min-w-48">
            <ThreadMenuItems
              thread={thread}
              projects={organization?.projects ?? []}
              running={views.running}
              served={served}
              canStartFrom={!running && !startThread.isPending}
              onFork={() =>
                startThread.mutate({
                  kind: 'forked',
                  threadId: thread.threadId,
                })
              }
              onContinue={() =>
                startThread.mutate({
                  kind: 'continued',
                  threadId: thread.threadId,
                })
              }
              onRename={() => setRenaming(true)}
              onArchive={() => {
                edits.archive.mutate(thread.threadId)
                void navigate({ to: '/' })
              }}
              onDelete={() => {
                edits.remove.mutate(thread.threadId)
                void navigate({ to: '/' })
              }}
            />
          </MenuPopup>
        </Menu>
      )}
      {actions && <div className="ms-auto flex shrink-0">{actions}</div>}
    </header>
  )
}

/** The project this thread's context comes from, shown once a brief applies. */
export function ProjectContextChip() {
  // The thread it sits in, which may not be the route's (a docked or side thread).
  const threadId = useAuiState((s) => s.threadListItem.remoteId)
  const views = useOrganizedViews()
  const { data: organization } = useOrganization()
  const thread = threadId ? views.byId.get(threadId) : undefined
  const members = new Set(thread?.memberships.map((m) => m.projectId))
  const withBrief = organization?.projects.filter(
    (project) => project.brief && members.has(project.projectId),
  )
  const first = withBrief?.[0]
  if (!withBrief || !first) return null
  return (
    // A quiet line above the first turn, not a banner: it says where the
    // thread's context comes from without competing with the conversation.
    <p className="mb-5 flex items-center gap-1.5 text-xs text-ink-muted">
      <ProjectGlyph aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate font-medium text-ink">
        {withBrief.map((project) => project.title).join(', ')}
      </span>
      <span aria-hidden>·</span>
      <span className="shrink-0">Project context attached</span>
    </p>
  )
}
