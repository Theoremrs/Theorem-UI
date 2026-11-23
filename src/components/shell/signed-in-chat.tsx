import { Outlet } from '@tanstack/react-router'
import { ArtifactLibraryPublication } from '@/components/artifacts/openui/publication'
import { PreferencesSync } from '@/lib/theorem/models'
import { TheoremRuntimeProvider } from '@/lib/theorem/runtime'
import { ChatShell } from './chat-shell'
import { CommandPalette } from './command-palette'
import { useShellMode } from './modes'
import { useWorkbenchPlacement } from '@/components/workbench/use-workbench-placement'

export default function SignedInChat({
  projectId,
  threadId,
  onThreadIdChange,
}: {
  projectId: string
  threadId: string | undefined
  onThreadIdChange: (id: string | undefined) => void
}) {
  const mode = useShellMode()
  const { placement } = useWorkbenchPlacement()
  return (
    <TheoremRuntimeProvider
      projectId={projectId}
      threadId={threadId}
      refreshVisible={mode === 'chat' || placement !== undefined}
      onThreadIdChange={onThreadIdChange}
    >
      <ChatShell projectId={projectId} threadId={threadId} />
      <CommandPalette />
      <PreferencesSync />
      <ArtifactLibraryPublication />
      <Outlet />
    </TheoremRuntimeProvider>
  )
}
