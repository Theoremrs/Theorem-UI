// SOURCING: @tanstack/react-router file routes (a pathless layout owns the assistant runtime; child routes only carry the thread id or the mode), ui/button's variants for the sign-in link, the ⌘K palette, the model preferences sync and the artifact library publication mounted with the shell, lib/theorem/organization for the project a thread belongs to
import { createFileRoute, useNavigate, useParams } from '@tanstack/react-router'
import { Suspense, lazy, useCallback, useEffect } from 'react'
import { useShellMode } from '@/components/shell/shell-mode'
import { useActiveProject } from '@/components/shell/projects'
import { useShell } from '@/components/shell/shell-state'
import { describeError, isSignedOut } from '@/lib/theorem/client'
import { projectToOpenIn, useOrganization } from '@/lib/theorem/organization'

import { SignIn } from '@/components/auth/sign-in'

// The sign-in and project checks do not need the editor, transcript or workspace.
const SignedInChat = lazy(() => import('@/components/shell/signed-in-chat'))

export const Route = createFileRoute('/_chat')({
  // The runtime, the CSRF bootstrap and the thread list all live in the browser.
  ssr: false,
  component: ChatLayout,
})

function ChatLayout() {
  const { threadId } = useParams({ strict: false })
  const navigate = useNavigate()
  const { project, error } = useActiveProject()

  // Spaces and the IDE keep the last conversation open behind them.
  const mode = useShellMode()
  const chatThreadId = useShell((s) => s.chatThreadId)
  const openThreadId = mode === 'chat' ? threadId : chatThreadId
  useEffect(() => {
    if (mode === 'chat') useShell.getState().setChatThreadId(threadId)
  }, [mode, threadId])

  // A thread opens in a project it belongs to, wherever it was reached from: the one its row was
  // picked under when it is placed in several, else its primary one.
  const { data: organization } = useOrganization()
  const openThread = organization?.threads.find(
    (thread) => thread.threadId === openThreadId,
  )
  const asked = useShell((s) => s.askedProject)
  const homeOfThread =
    openThread &&
    projectToOpenIn(
      openThread,
      asked && asked.threadId === openThreadId ? asked.projectId : undefined,
    )
  useEffect(() => {
    if (homeOfThread) useShell.getState().setProjectId(homeOfThread)
  }, [openThreadId, homeOfThread])
  // What was asked for one thread says nothing about the next one opened.
  useEffect(() => {
    const shell = useShell.getState()
    if (shell.askedProject && shell.askedProject.threadId !== openThreadId)
      shell.askProject(undefined)
  }, [openThreadId])

  // Outside chat the mode stays on screen and only the conversation behind it moves.
  const onThreadIdChange = useCallback(
    (id: string | undefined) => {
      if (mode !== 'chat') useShell.getState().setChatThreadId(id)
      else if (id)
        void navigate({ to: '/c/$threadId', params: { threadId: id } })
      else void navigate({ to: '/' })
    },
    [navigate, mode],
  )

  if (isSignedOut(error))
    return (
      <SignIn
        failure={
          new URLSearchParams(window.location.search).get('signin_error') ??
          undefined
        }
        returnTo={window.location.pathname + window.location.search}
      />
    )
  if (error)
    return (
      <ShellStatus
        title="Theorem is unreachable"
        detail={describeError(error)}
      />
    )
  if (!project) return <ShellStatus title="Theorem" />

  return (
    <Suspense fallback={<ShellStatus title="Theorem" />}>
      <SignedInChat
        projectId={project.projectId}
        threadId={openThreadId}
        onThreadIdChange={onThreadIdChange}
      />
    </Suspense>
  )
}

/** Full-height status for the shell before a project is available. */
function ShellStatus({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-2 bg-background px-6 text-center">
      <p className="font-heading text-[20px] font-medium">{title}</p>
      {detail && <p className="max-w-md text-sm text-ink-muted">{detail}</p>}
    </div>
  )
}
