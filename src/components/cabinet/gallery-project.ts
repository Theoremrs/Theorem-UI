// SOURCING: TanStack Router's route params and the shell's open project. Its
// own module so a card in the reply can ask without importing the cabinet,
// whose original view renders artifacts.
import { useParams } from '@tanstack/react-router'
import { useShell } from '@/components/shell/shell-state'

/** The project the Gallery shows: the chat's project, or else the open one. */
export function useGalleryProject(): string | undefined {
  const activeProject = useShell((s) => s.projectId)
  const { projectId: routeProject } = useParams({ strict: false })
  return routeProject ?? activeProject
}
