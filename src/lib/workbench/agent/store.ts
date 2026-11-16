// SOURCING: zustand, as lib/face/store.ts keeps `mounted` for the face: the one place the page knows the workbench is on screen (components/workbench/workbench.tsx registers its mounted handle here) and what a turn's agent may reach of it. The handle is the wasm WorkbenchHandle of terminal/src/workbench.rs, narrowed to the three methods the agent's entry uses.
import { create } from 'zustand'
import type { WorkbenchHandle } from '@/terminal-wasm/theorem_terminal'

/** The agent's entry on the mounted core (spec R34): the same registry a key press uses, with the run named. */
export interface AgentSurface {
  /** Every registered action as the agent sees it (JSON array of `CatalogEntry`). */
  agent_catalog: () => string
  /**
   * Runs an action for one agent run (JSON `AgentOutcome`: `accepted` with effects, notices and the panel it opened or
   * acted on, or `refused` with a code and reason). `args` is the JSON of `ActionArgs` (`{ input?, option? }`), for
   * the actions that take any, such as `code.start`, `code.send` and `code.stop`.
   */
  agent_act: (action: string, run_id: string, panel?: string, args?: string) => string
}

/**
 * What the page holds of a mounted workbench. The agent methods are optional
 * so a core built before they existed is refused readably instead of thrown at.
 */
export type AgentHandle = Pick<WorkbenchHandle, 'semantics'> &
  Partial<AgentSurface>

interface WorkbenchAgentState {
  readonly handle: AgentHandle | undefined
}

export const useWorkbenchAgent = create<WorkbenchAgentState>(() => ({
  handle: undefined,
}))

/** Called with the mounted handle, and with `undefined` when the workbench leaves the page. */
export function setWorkbenchHandle(handle: AgentHandle | undefined) {
  useWorkbenchAgent.setState({ handle })
}
