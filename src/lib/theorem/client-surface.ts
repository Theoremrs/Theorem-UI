// What a send declares of this page to the turn: the operations the agent may
// ask of it, and the page's revision. Theorem takes one list and one revision
// for a run (theorem-surface-contracts client_operation), so the page's
// surfaces are put together here.
import { appTurnOptions } from '@/lib/blocks/app-operations'
import { faceTurnOptions } from '@/lib/face/operations'
import { kitTurnOptions } from '@/lib/kit/operations'
import { workbenchTurnOptions } from '@/lib/workbench/agent/operations'

/**
 * The page's operations for a turn: checking Apps always, and Kit and Theo
 * while each is on screen. Theorem admits at most sixteen a send; Kit's nine,
 * the check, the face's three and the workbench's two are fifteen. The revision is Kit's stage's
 * when Kit is there, since Kit is the surface whose state a run must not act
 * on stale; a check changes nothing, the face is driven, not edited, and the workbench
 * answers with the revision the run expected (its tree has revisions of its own).
 */
export function clientSurfaceTurnOptions() {
  const kit = kitTurnOptions()
  return {
    clientOperations: [
      ...('clientOperations' in kit ? kit.clientOperations : []),
      ...appTurnOptions().clientOperations,
      ...faceTurnOptions().clientOperations,
      ...workbenchTurnOptions().clientOperations,
    ],
    clientSurface: 'clientSurface' in kit ? kit.clientSurface : { revision: 0 },
  }
}
