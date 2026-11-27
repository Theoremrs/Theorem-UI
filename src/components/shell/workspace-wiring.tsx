// SOURCING: the owners the separate workstreams built, joined here because
// none of them owns the shell: components/resources (the resource layer's
// built-in providers and previews), lib/releases (release tracking and the
// rollback recovery actions, through its vault wiring) and lib/shell/recovery
// (the host's recovery page). Mounted once by the shell; renders nothing.
import { useEffect } from 'react'
import { registerResourceLayer } from '@/components/resources'
import { useVaultClient } from '@/components/vault/vault-panels'
import { recoveryActions } from '@/lib/releases/recovery'
import { useReleases } from '@/lib/releases/store'
import { useReleaseTracking } from '@/lib/releases/vault-wiring'
// Its import sets the catalog's admission, so a disabled module stays off.
import '@/lib/releases/lifecycle'
import { registerRecoveryAction } from '@/lib/shell/recovery'

/**
 * Keeps the recovery page's "go back to the last working release" entries in
 * step with the release records: one per module that has an earlier working
 * release, replaced whenever the records change (EXEC-05, OWN-02).
 */
export function connectReleaseRecovery(): () => void {
  let removes: Array<() => void> = []
  const sync = () => {
    for (const remove of removes) remove()
    removes = recoveryActions().map((action) =>
      registerRecoveryAction({
        id: action.id,
        label: action.label,
        description: action.description,
        // After the host's own actions, which keep the lower orders.
        order: 100,
        run: action.run,
      }),
    )
  }
  sync()
  const unsubscribe = useReleases.subscribe(sync)
  return () => {
    unsubscribe()
    for (const remove of removes) remove()
  }
}

export function WorkspaceWiring() {
  const client = useVaultClient()
  useEffect(() => registerResourceLayer(), [])
  useEffect(() => connectReleaseRecovery(), [])
  useReleaseTracking(client)
  return null
}
