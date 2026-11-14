// SOURCING: the chat Composer (as the compare pane carries it away from the conversation: the runtime's new thread is filed in the project the shell names), @tanstack/react-router for the session links, date-fns for how long ago, lucide-react marks for the context kinds Theorem does not serve yet, lib/theorem/organization and components/shell/projects for the records. The layout (one page: a header, a composer, the sessions below it, the project's context beside them, and its apps and outputs in the dock's side group) follows Claude's project page on Mobbin; docs/plans/projects-sidebar-and-session-graph.md §7.
import { useParams } from '@tanstack/react-router'
import { formatDistanceToNowStrict } from 'date-fns'
import { Database, FileText, FolderGit2, Link2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Composer } from '@/components/chat/composer'
import { Icon } from '@/components/icons'
import { ProjectGlyph } from '@/components/organize/glyphs'
import { ProjectStateDialog } from '@/components/organize/project-state-dialog'
import { useProjects } from '@/components/shell/projects'
import { useShell } from '@/components/shell/shell-state'
import { Button } from '@/components/ui/button'
import { lastMoved, useOrganization } from '@/lib/theorem/organization'
import { isPinned, useSidebarPrefs } from '@/lib/theorem/sidebar-prefs'
import { cn } from '@/lib/utils'
import { ProjectEditDialog } from './project-edit-dialog'
import { ProjectSessions } from './project-sessions'

const ago = (atMs: number) =>
  Date.now() - atMs < 60_000
    ? 'just now'
    : `${formatDistanceToNowStrict(atMs)} ago`

function Section({
  title,
  action,
  children,
  className,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('flex flex-col gap-2', className)}>
      <div className="flex min-h-7 items-center gap-2">
        <h2 data-appearance-recipe="ui.group" className="flex-1 text-ink">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/** Context Theorem does not serve per project yet, said plainly instead of drawn as empty controls. */
const NOT_SERVED = [
  {
    Mark: FileText,
    label: 'Documents',
    detail: 'Files and notes attached to the project for every session.',
  },
  {
    Mark: FolderGit2,
    label: 'Repositories',
    detail: 'Code the project works in.',
  },
  {
    Mark: Link2,
    label: 'Links',
    detail: 'Pages and references kept with the project.',
  },
  {
    Mark: Database,
    label: 'Databases and servers',
    detail: 'Connections sessions here may use.',
  },
] as const

function NotServedList() {
  return (
    <ul className="flex flex-col gap-3">
      {NOT_SERVED.map(({ Mark, label, detail }) => (
        <li key={label} className="flex items-start gap-3">
          <Mark
            aria-hidden
            strokeWidth={1.75}
            className="mt-0.5 size-4 shrink-0 text-ink-muted"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span data-appearance-recipe="ui.label">{label}</span>
            <span className="text-xs text-ink-muted">{detail}</span>
          </span>
          <span className="shrink-0 text-xs text-ink-muted">
            Not served yet
          </span>
        </li>
      ))}
    </ul>
  )
}

/** On a project's home, the title that stands where the open thread's would: in the phone header and the dock's tab. */
export function useProjectHomeTitle() {
  const { threadId, projectId } = useParams({ strict: false })
  const { data } = useOrganization()
  if (threadId !== undefined || projectId === undefined) return undefined
  return (
    data?.projects.find((p) => p.projectId === projectId)?.title ?? 'Project'
  )
}

/**
 * A project's page, as one page: what it is, a composer that starts a session
 * in it, its sessions below, and beside them the context its sessions share.
 */
export function ProjectHome({ projectId }: { projectId: string }) {
  const { data: organization, isPending } = useOrganization()
  const { data: records = [] } = useProjects()
  const [editing, setEditing] = useState(false)
  const [editingState, setEditingState] = useState(false)
  const pin = { kind: 'project', id: projectId } as const
  const pinned = useSidebarPrefs((s) => isPinned(s.pins, pin))
  const togglePin = useSidebarPrefs((s) => s.togglePin)

  // The composer files its new session in the project the shell names.
  useEffect(() => {
    useShell.getState().setProjectId(projectId)
  }, [projectId])
  const project = organization?.projects.find((p) => p.projectId === projectId)
  const record = records.find((p) => p.projectId === projectId)
  const threads = useMemo(
    () =>
      (organization?.threads ?? [])
        .filter((t) => t.memberships.some((m) => m.projectId === projectId))
        .sort((a, b) => lastMoved(b) - lastMoved(a)),
    [organization, projectId],
  )
  const titles = useMemo(
    () =>
      new Map(
        (organization?.threads ?? []).map((t) => [
          t.threadId,
          t.title || 'New chat',
        ]),
      ),
    [organization],
  )

  if (isPending)
    return <div className="p-10 text-sm text-ink-muted">Loading project…</div>
  if (!project)
    return (
      <div className="flex flex-col gap-2 p-10">
        <p data-appearance-recipe="ui.group">There is no such project</p>
        <p className="text-sm text-ink-muted">
          It may have been archived, or it belongs to another workspace.
        </p>
      </div>
    )

  const instructions = record?.instructions ?? ''

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-8">
        <header className="flex flex-wrap items-start gap-3">
          <ProjectGlyph aria-hidden className="mt-1 size-6 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1
              data-appearance-recipe="heading.medium"
              className="truncate text-ink"
            >
              {project.title}
            </h1>
            <p className="text-sm text-ink-muted">
              {threads.length} {threads.length === 1 ? 'session' : 'sessions'}
              {threads[0] ? ` · last moved ${ago(lastMoved(threads[0]))}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={pinned}
              onClick={() => togglePin(pin)}
            >
              {pinned ? (
                <Icon.Unpin className="size-4" />
              ) : (
                <Icon.Pin className="size-4" />
              )}
              {pinned ? 'Unpin' : 'Pin'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Icon.Edit className="size-4" />
              Edit
            </Button>
          </div>
        </header>

        <div className="grid gap-8 @min-[54rem]:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="flex min-w-0 flex-col gap-8">
            {/* The face perches on the composer's top edge, so the space above it stays clear. */}
            <section
              aria-label={`Start a session in ${project.title}`}
              className="pt-6"
            >
              <Composer autoFocus={false} />
            </section>
            <ProjectSessions threads={threads} titles={titles} />
          </div>

          <aside
            aria-label="Project context"
            className="flex flex-col divide-y divide-separator self-start rounded-xl ring-1 ring-separator"
          >
            <Section
              title="Instructions"
              className="p-4"
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  Edit
                </Button>
              }
            >
              {instructions.trim() ? (
                <p className="line-clamp-6 text-sm whitespace-pre-wrap text-ink">
                  {instructions}
                </p>
              ) : (
                <p className="text-sm text-ink-muted">
                  None yet. Instructions are given to every session started
                  here.
                </p>
              )}
            </Section>
            {organization?.served && (
              <Section
                title="Where it stands"
                className="p-4"
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditingState(true)}
                  >
                    Edit
                  </Button>
                }
              >
                {project.state ? (
                  <>
                    <p className="line-clamp-6 text-sm whitespace-pre-wrap text-ink">
                      {project.state.text}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {project.state.by === 'librarian'
                        ? 'The Librarian'
                        : 'You'}
                      , {ago(project.state.atMs)}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-ink-muted">Not written yet.</p>
                )}
              </Section>
            )}
            <Section title="Knowledge and connections" className="p-4">
              <NotServedList />
            </Section>
          </aside>
        </div>
      </div>
      <ProjectEditDialog
        projectId={projectId}
        title={project.title}
        instructions={instructions}
        open={editing}
        onOpenChange={setEditing}
      />
      {organization?.served && (
        <ProjectStateDialog
          project={project}
          open={editingState}
          onOpenChange={setEditingState}
        />
      )}
    </div>
  )
}
