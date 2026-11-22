// SOURCING: the capability table module (components/capabilities/capability-table), which a custom
// module's manifest names as its semantic fallback: the same view, rows and declared actions a
// placed table shows, narrowed to the actions the fallback names. The reason it stands in comes
// first, as the module's own BlockMessage. The page's settings writer is withheld (page-settings), so
// the table holds a picked view as it does wherever its settings cannot be written.
import type { ReactNode } from 'react'
import { CapabilityTableModule } from '@/components/capabilities/capability-table'
import type { ModuleDefinition, ModuleViewProps } from '@/lib/modules/registry'
import { PageSettingsProvider } from './page-settings'

const nothing = () => {}

/**
 * Why a custom module is not running (`children`) and, when its manifest
 * names a fallback, its records in its place. A module with no fallback shows
 * only why. The fallback publishes nothing and writes no setting: the
 * module's outputs and props are its own, so a picked view holds while it is
 * shown, and an instance made from a template is created but not opened.
 */
export function WithFallback({
  definition,
  view,
  children,
}: {
  definition: ModuleDefinition
  view: ModuleViewProps
  children: ReactNode
}) {
  const { fallback } = definition
  if (!fallback) return children
  return (
    <div className="flex h-full min-h-0 flex-col">
      {children}
      <div
        aria-label={`${definition.label} as records`}
        className="min-h-0 flex-1 overflow-hidden border-t border-separator"
      >
        <PageSettingsProvider value={undefined}>
          <CapabilityTableModule
            {...view}
            settings={{
              instanceId: fallback.instanceId,
              viewKey: fallback.viewKey ?? '',
              ...(fallback.actions ? { actions: fallback.actions } : {}),
            }}
            output={nothing}
            emit={nothing}
          />
        </PageSettingsProvider>
      </div>
    </div>
  )
}
