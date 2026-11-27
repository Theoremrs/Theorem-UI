import { Outlet } from '@tanstack/react-router'
import { AgentProfileDialog } from '@/components/agent/agent-profile-dialog'
import { OrganizationAgentsDialog } from '@/components/agent/organization-agents-dialog'
import { ArtifactLibraryPublication } from '@/components/artifacts/openui/publication'
import { ArtifactRuntimeHost } from '@/components/artifacts/artifact-runtime-host'
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
      {/* Owns every live artifact runtime above the answer, the dock and the
          expanded view, so moving between them never starts one again. */}
      <ArtifactRuntimeHost />
      <CommandPalette />
      {/* Mounted wherever the palette is, which opens it. */}
      <AgentProfileDialog />
      <OrganizationAgentsDialog />
      <PreferencesSync />
      <ArtifactLibraryPublication />
      <Outlet />
    </TheoremRuntimeProvider>
  )
}
