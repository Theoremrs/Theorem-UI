export const WORKBENCH_MIN_WIDTH = 360
export const CONVERSATION_MIN_WIDTH = 420

export function dockMaxWidth(viewport: number) {
  return Math.max(0, Math.min(1400, viewport - CONVERSATION_MIN_WIDTH))
}

export function dockMinWidth(viewport: number) {
  return Math.min(WORKBENCH_MIN_WIDTH, dockMaxWidth(viewport))
}
