// SOURCING: the composer's askAbout (components/chat/composer-references), the page runtime's
// published outputs (./page-runtime) for the module's summary as it stands, and the app's Button
// and Icon, as the capability table's own Ask control uses them. The envelope is
// lib/modules/agent-reference. The page is named by its file's vault path (page-route's usePagePath),
// as the capability table's envelope names it and the agent's page_read and page_patch take it.
import { askAbout } from '@/components/chat/composer-references'
import { Icon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { componentContextReference } from '@/lib/modules/agent-reference'
import type { ModuleDefinition, ModuleViewProps } from '@/lib/modules/registry'
import { usePageRuntime } from './page-runtime'
import { usePagePath } from './page-route'

/**
 * Puts the module's agent representation in the composer: what it is for,
 * and its summary output as it stands when the person asks. A module that
 * declares no `agent` offers nothing here.
 */
export function AskAboutModule({
  definition,
  view,
}: {
  definition: ModuleDefinition
  view: ModuleViewProps
}) {
  const runtime = usePageRuntime()
  const pageId = usePagePath()
  const { agent } = definition
  if (!agent) return null
  const ask = () =>
    askAbout(
      componentContextReference({
        moduleId: definition.id,
        selectedComponentId: view.instanceId,
        pageId,
        label: definition.label,
        description: agent.description,
        summary: agent.summaryOutput
          ? runtime.outputs.getState()[view.path]?.[agent.summaryOutput]
          : undefined,
        instances: (definition.capabilities.instances ?? []).map(
          (one) => one.instanceId,
        ),
      }),
    )
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={`Ask about ${definition.label}`}
      onClick={ask}
    >
      <Icon.Sparkle className="size-3.5" />
      Ask
    </Button>
  )
}
