/** The independent palette manifest consumed by the TypeScript tests. */
export type PaletteContrastPair = {
  foreground: string
  background: string
  threshold: 3 | 4.5
  id: string
}

export const REQUIRED_PALETTE_PAIRS: readonly PaletteContrastPair[]
export const REQUIRED_PALETTE_MODES: readonly string[]
