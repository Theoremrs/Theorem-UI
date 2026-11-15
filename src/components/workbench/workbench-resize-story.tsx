// SOURCING: none — the story for AC-04 (resize without clipping): the real wasm workbench over createFixtureHost, filling the window (FixtureStory with CSS lengths), opened on Files, a document in the editor and the tool picker. It reads the semantic tree through the surface's own handle and sets the person's code-text scale through the app's appearance store; nothing upstream models either.
import { useAppearance } from '@/lib/appearance'
import type { SemanticTree } from '@/lib/workbench/wire'
import { EVERY_TOOL, FixtureStory } from './workbench-story'
import type { Step } from './workbench-story'

declare global {
  interface Window {
    /** What the resize scenario reads: the semantic tree the core publishes, as the surface hands it over. */
    __resize?: { tree: () => SemanticTree | undefined }
  }
}

/** Files, then `docs/notes.txt` into the editor: the steps the editor story opens its document with. */
const OPEN_DOCUMENT: Step[] = [
  { chord: 'e' },
  // Files lands on its first row when it takes focus.
  { see: 'README.md' },
  { key: 'ArrowDown' },
  { key: 'Enter' },
  { see: 'architecture.md' },
  { key: 'ArrowDown' },
  { key: 'ArrowDown' },
  { key: 'ArrowDown' },
  { key: 'Enter' },
  { see: 'Notes' },
]

/**
 * `workbench-resize`: a workbench that fills the window, with Files, the conversation, the document and
 * the tool picker open. The scenario resizes the window and reads the geometry back; the control (never
 * part of the product) raises the person's code-text size through the appearance store, the setting
 * Settings > Appearance offers.
 */
export function WorkbenchResizeStory() {
  return (
    <FixtureStory
      id="workbench-resize"
      width="100vw"
      height="100dvh"
      options={{ granted: EVERY_TOOL, transcript: true }}
      script={OPEN_DOCUMENT}
      wait={['Notes']}
      controls={{
        'text-larger': () =>
          useAppearance.getState().setOverrides({ scales: { content: 1.5, ui: 1.5, code: 1.5 } }),
      }}
      overlay={(_, parts) => {
        window.__resize = {
          tree: () => (parts.handle ? (JSON.parse(parts.handle.semantics()) as SemanticTree) : undefined),
        }
        return null
      }}
    />
  )
}
