// SOURCING: none — stories for host states the workbench must show in words (terminal adoption, a binary conflict, run exit codes, saved layouts, recovery after a reload): the same FixtureStory over createFixtureHost, one option set each. It uses FixtureStory; nothing else applies.
import { EVERY_TOOL, FixtureStory, WIDEN_TOOLS, open } from './workbench-story'
import type { Step } from './workbench-story'

/**
 * The tool group's splitter dragged well left, as a person would: at its default width (about 43
 * columns) the chooser's notes are clipped at the pane's edge, so the words cannot be read.
 */
const WIDE_TOOLS: Step = { drag: { from: [1141, 300], to: [700, 300] } }

/** The Shell chooser against a host whose terminal inventory is still being found: the list may be incomplete. */
export function WorkbenchTerminalAdoptionPendingStory() {
  return (
    <FixtureStory
      id="workbench-terminal-adoption-pending"
      width={1600}
      height={640}
      options={{
        granted: EVERY_TOOL,
        terminal: true,
        terminalEmpty: true,
        terminalAdoption: { state: 'pending' },
      }}
      script={[WIDE_TOOLS]}
      wait={['README.md']}
    />
  )
}

/** The Shell chooser against a host that cannot reach its terminal backend, with the reason it gives. */
export function WorkbenchTerminalAdoptionUnavailableStory() {
  return (
    <FixtureStory
      id="workbench-terminal-adoption-unavailable"
      width={1600}
      height={640}
      options={{
        granted: EVERY_TOOL,
        terminal: true,
        terminalEmpty: true,
        terminalAdoption: {
          state: 'unavailable',
          reason: 'the Herdr socket is not answering',
        },
      }}
      script={[WIDE_TOOLS]}
      wait={['README.md']}
    />
  )
}

/** The Shell chooser against a host that has finished looking and has no terminal to offer. */
export function WorkbenchTerminalAdoptionSettledStory() {
  return (
    <FixtureStory
      id="workbench-terminal-adoption-settled"
      width={1600}
      height={640}
      options={{
        granted: EVERY_TOOL,
        terminal: true,
        terminalEmpty: true,
        terminalAdoption: { state: 'settled' },
      }}
      script={[WIDE_TOOLS]}
      wait={['README.md']}
    />
  )
}

/** `workbench-changes-binary-conflict`: the one conflicted file is an image; its sides cannot be shown as text. */
export function WorkbenchChangesBinaryConflictStory() {
  return (
    <FixtureStory
      id="workbench-changes-binary-conflict"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL, binaryConflict: true }}
      // Changes opens on the Review; opening a conflict's sides is the Stage view's, so the story switches to it first.
      script={[{ chord: 'g' }, { see: 'logo.png' }, { key: 'w' }, WIDEN_TOOLS]}
      wait={['logo.png']}
    />
  )
}

/** `workbench-run-list-exits`: the host's run list with an exit code of 0, of 2 and none, and each run's kind. */
export function WorkbenchRunListExitsStory() {
  return (
    <FixtureStory
      id="workbench-run-list-exits"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL, runExits: true }}
      script={[
        ...open('Run output'),
        { see: 'Run' },
        { key: 'Tab' },
        { key: 'Tab' },
        { key: 'l' },
      ]}
      wait={['unit tests', 'release build']}
    />
  )
}

/** The person's key overrides: Mod+Alt+F1 to F4 apply the four presets (the defaults bind none of them). */
const PRESET_KEYS = JSON.stringify({
  version: 1,
  bind: ['default', 'editor', 'agent', 'minimal'].map((preset, index) => ({
    chord: `Mod+Alt+F${index + 1}`,
    context: { type: 'global' },
    action: `workbench.layout.${preset}`,
  })),
})

/**
 * `workbench-layouts-page`: an account whose layouts persist, with the preset keys bound. A scenario
 * arranges the workbench, saves it by name, applies a preset, applies the saved layout from the
 * Layouts page, then renames and deletes it, by keyboard only.
 */
export function WorkbenchLayoutsPageStory() {
  return (
    <FixtureStory
      id="workbench-layouts-page"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL, transcript: true, account: 'ada', persistLayout: true }}
      arrangements
      script={[{ host: (_, surface) => surface.setKeys(PRESET_KEYS) }]}
      wait={['README.md']}
    />
  )
}

/**
 * `workbench-recovery-reload`: the host cannot confirm an edit (it answers `uncertain`), so the documents owner
 * keeps the typing on this device. The story opens nothing: the scenario types, reloads the page for real and
 * opens the file again by keyboard, which is when the owner offers the kept edits back.
 */
export function WorkbenchRecoveryReloadStory() {
  return (
    <FixtureStory
      id="workbench-recovery-reload"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL, holdEdits: true }}
      script={[]}
      wait={['Files']}
    />
  )
}
