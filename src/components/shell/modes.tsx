// SOURCING: @tanstack/react-router (each mode is a route), assistant-ui Thread element, the Spaces canvas (React Flow), the IDE frame (browser-only Theia), the Vault's file list on a phone (FoldersSection), the program canvas (React Flow), Index mode (its page, pages/mode-page.tsx), Pages (Puck over the vault's page files; a mode's page opens there to be arranged), Notes (Theorem documents in the Milkdown note editor), a project's home in chat mode (components/projects/project-home), and records (components/crm: saved people, organizations and what is owed) inside Index mode
import { MODES } from './builtin-nav'
import './builtin-chrome'
import { LifeBackdrop } from '@/components/life/life-backdrop'
import { Thread } from '@/components/assistant-ui/elements/thread.aui'
import { Suspense, lazy, useCallback } from 'react'
import type React from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { ProjectHome } from '@/components/projects/project-home'
import {
  ModePageView,
  PageStatus,
  PageView,
} from '@/components/pages/page-view'
import { isPageMode } from '@/lib/modules/templates'
import { useShell } from './shell-state'

import { useShellMode } from './shell-mode'
import type { ShellMode } from './shell-mode'

export { useShellMode } from './shell-mode'
export type { ShellMode } from './shell-mode'

const Canvas = lazy(() =>
  import('@/components/canvas/canvas').then((module) => ({
    default: module.Canvas,
  })),
)
const ProgramSurface = lazy(() =>
  import('@/components/program/program-surface').then((module) => ({
    default: module.ProgramSurface,
  })),
)
const IdeFrame = lazy(() =>
  import('@/components/ide/ide-frame').then((module) => ({
    default: module.IdeFrame,
  })),
)
const VaultPhone = lazy(() =>
  import('@/components/vault/vault-phone').then((module) => ({
    default: module.VaultPhone,
  })),
)
const IndexMode = lazy(() =>
  import('@/components/pages/mode-page').then((module) => ({
    default: module.IndexMode,
  })),
)
const NotesView = lazy(() =>
  import('@/components/notes/notes-view').then((module) => ({
    default: module.NotesView,
  })),
)

export { MODES } from './builtin-nav'

/** The modes that show their own view and list in place of the conversation and its threads. */
export const hasOwnView = (mode: ShellMode) =>
  mode === 'index' ||
  mode === 'notes' ||
  mode === 'pages' ||
  mode === 'spaces' ||
  mode === 'canvas'

/**
 * Whether the file tree sits under the mode's own list. Notes keeps its own
 * folders and ends with its Trash; the rail's Files control still shows the
 * files there.
 */
export const filesUnderPanel = (mode: ShellMode) =>
  hasOwnView(mode) && mode !== 'notes'

export const modeLabel = (mode: ShellMode) =>
  MODES.find((entry) => entry.mode === mode)!.label

/**
 * The mode whose panel beside the rail shows: the Vault covers the sheet, so
 * Chat's panel stays under it. The IDE has its own, its sessions.
 */
export const navigatorMode = (mode: ShellMode): ShellMode =>
  mode === 'vault' ? 'chat' : mode

/** Navigates to a mode; chat returns to the conversation last left. */
export function useOpenMode() {
  const navigate = useNavigate()
  return useCallback(
    (next: ShellMode) => {
      if (next === 'index') return navigate({ to: '/index' })
      if (next === 'notes') return navigate({ to: '/notes' })
      if (next === 'pages') return navigate({ to: '/pages' })
      if (next === 'vault') return navigate({ to: '/vault' })
      if (next === 'spaces') return navigate({ to: '/spaces' })
      if (next === 'canvas') return navigate({ to: '/canvas' })
      if (next === 'ide') return navigate({ to: '/ide' })
      const threadId = useShell.getState().chatThreadId
      return threadId
        ? navigate({ to: '/c/$threadId', params: { threadId } })
        : navigate({ to: '/' })
    },
    [navigate],
  )
}
/**
 * The view for the current mode. The conversation stays mounted behind the
 * other modes, so its scroll position and composer draft survive a switch.
 * On the desktop the Vault covers the whole sheet, so the dock keeps the
 * conversation laid out beneath it, and the IDE's page has its own
 * conversation beside Theia; on a phone they take the screen.
 */
export function ModeView({
  docked = false,
  actions,
}: {
  docked?: boolean
  /** The dock's panel controls, for a mode that draws its own top edge (Notes). */
  actions?: React.ReactNode
}) {
  const mode = useShellMode()
  // A project's home stands in for the conversation, which stays mounted behind it.
  const { projectId } = useParams({ strict: false })
  const projectHome = mode === 'chat' && projectId !== undefined
  const showThread =
    (mode === 'chat' && !projectHome) || (docked && mode === 'vault')
  return (
    <>
      {projectHome && <ProjectHome key={projectId} projectId={projectId} />}
      <div hidden={!showThread} className="h-full">
        <LifeBackdrop>
          <Thread covered={mode !== 'chat'} />
        </LifeBackdrop>
      </div>
      <Suspense
        fallback={
          <p role="status" className="p-3 text-sm">
            Loading {modeLabel(mode)}…
          </p>
        }
      >
        {mode === 'ide' && !docked && <IdeFrame />}
        {mode === 'vault' && !docked && <VaultPhone />}
        {mode === 'index' && <IndexMode />}
        {mode === 'notes' && <NotesView docked={docked} actions={actions} />}
        {mode === 'pages' && <PagesView />}
        {mode === 'spaces' && <Canvas />}
        {mode === 'canvas' && <ProgramSurface />}
      </Suspense>
    </>
  )
}

/** A mode's page in the Pages route: `mode:index`. */
const MODE_PREFIX = 'mode:'

/** The open page, or a word on how to open one. */
function PagesView() {
  const { pageId } = useParams({ strict: false })
  const mode = pageId?.startsWith(MODE_PREFIX)
    ? pageId.slice(MODE_PREFIX.length)
    : undefined
  if (mode !== undefined)
    return isPageMode(mode) ? (
      <ModePageView key={mode} mode={mode} />
    ) : (
      <PageStatus title="There is no such mode" />
    )
  return pageId ? (
    <PageView key={pageId} entryId={pageId} />
  ) : (
    <PageStatus
      title="Pages"
      detail="A page is modules you arrange and connect. Open one from the list, or make a new one."
    />
  )
}
