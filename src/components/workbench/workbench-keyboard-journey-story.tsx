// SOURCING: none — the story for AC-47 (keyboard-only workflow) and AC-25 (paste, copy): the real wasm workbench over createFixtureHost with every tool granted, a conversation waiting on an approval and a terminal that can be attached; it adds only a control that switches the attached program's bracketed-paste mode on (what a shell does) and a read-only record, on `window`, of every effect the core asked the host for, whole. The semantic tree comes from FixtureStory's own `window.__storyTree`. Nothing here is part of the product.
import type { Effect } from '@/lib/workbench/wire'
import { EVERY_TOOL, FixtureStory } from './workbench-story'

declare global {
  interface Window {
    /** Every effect the core asked the host for in this story, whole, in order. */
    __journeyEffects?: Effect[]
  }
}

/**
 * `workbench-keyboard-journey`: the whole workbench at 1440x900, untouched, for a scenario that drives it with
 * key presses alone: Files, the conversation with an approval waiting, a document, Changes and a terminal are
 * all reachable from the picker and the documented chords. The control stands in for the attached shell asking
 * for bracketed paste (DECSET 2004); it is never part of the product.
 */
export function WorkbenchKeyboardJourneyStory() {
  return (
    <FixtureStory
      id="workbench-keyboard-journey"
      width={1440}
      height={900}
      options={{ granted: EVERY_TOOL, transcript: true, terminal: true }}
      script={[]}
      wait={['Theo']}
      controls={{
        'bracketed-paste-on': (host) => host.terminalWrite('\u001b[?2004h'),
      }}
      onEffect={(effect) => {
        ;(window.__journeyEffects ??= []).push(effect)
      }}
    />
  )
}
