// SOURCING: the capability table module (components/capabilities/capability-table), which a custom
// module's manifest names as its semantic fallback: the same view, rows and declared actions a
// placed table shows, narrowed to the actions the fallback names. The reason it stands in comes
// first, as the module's own BlockMessage.
import type { ReactNode } from 'react'
import { CapabilityTableModule } from '@/components/capabilities/capability-table'
import type { ModuleDefinition, ModuleViewProps } from '@/lib/modules/registry'

const nothing = () => {}

/**
 * Why a custom module is not running (`children`) and, when its manifest
 * names a fallback, its records in its place. A module with no fallback shows
 * only why. The fallback publishes nothing: the module's outputs are its own.
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
      </div>
    </div>
  )
}
