// SOURCING: the existing workbench story pieces (FixtureStory over the real wasm workbench, the Hooks the oracle reads, PaletteProfileGate for the profile) and the terminal's own loadWasm, so each palette reaches the Rust terminal through the same set_palette the page uses; the ladder itself is terminal-ladder.ts. This file adds only the two stories and the switch between the ladder and the colours from before it.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { loadWasm } from '@/components/terminal/terminal-screen'
import { useTerminalTheme } from '@/components/terminal/live-terminal-theme'
import { ladderPalette } from '@/components/terminal/terminal-ladder'
import { wasmPalette } from '@/components/terminal/terminal-roles'
import { PALETTE_PROFILES } from '@/stories/palette-matrix'
import { PaletteProfileGate } from './workbench-palette-stories'
import { Hooks, record, THREADS_CAPS } from './workbench-feature-stories'
import {
  PARITY_CHANGES,
  PARITY_CONVERSATION,
  PARITY_THREADS,
  PARITY_VIEWPORT,
  parityDiff,
} from './delta-parity-fixture'
import { FixtureStory } from './workbench-story'
import type { FixtureOptions } from './fixture-host'

declare global {
  interface Window {
    /** The colours the Rust terminal was last given by the parity story: the ladder, or the ones from before it. */
    __parityLadder?: { ladder: boolean }
  }
}

/**
 * Sends the Rust terminal either the ladder (what the page sends by default) or the role palette alone, which is
 * what every terminal drew in before the ladder. The page's own
 * paint runs first (loadWasm subscribes before this does), so the choice is the last word on every theme change.
 * Children wait until the first paint is made.
 */
function LadderGate({
  ladder,
  children,
}: {
  ladder: boolean
  children: ReactNode
}) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let live = true
    let stop = () => {}
    void loadWasm().then((wasm) => {
      if (!live) return
      const paint = () => {
        const { roles } = useTerminalTheme.getState()
        wasm.set_palette(
          JSON.stringify(ladder ? ladderPalette(roles) : wasmPalette(roles)),
        )
        window.__parityLadder = { ladder }
      }
      paint()
      stop = useTerminalTheme.subscribe(paint)
      setReady(true)
    })
    return () => {
      live = false
      stop()
      window.__parityLadder = undefined
    }
  }, [ladder])
  return ready ? children : <div data-story-pending="" />
}

export function ParityStory({
  id,
  ladder,
  repository = { changes: PARITY_CHANGES, diff: parityDiff },
  hooks,
  fill,
  conversation = PARITY_CONVERSATION,
  liveConversation,
  persistLayout,
  documents,
  granted = THREADS_CAPS,
  threadsSeed = PARITY_THREADS,
  owner,
}: {
  id: string
  ladder: boolean
  /** The repository the Changes panel reads, in place of the parity fixture's. */
  repository?: {
    changes: typeof PARITY_CHANGES
    diff: typeof parityDiff
  }
  /** Extra page hooks the story's oracle scenario reads. */
  hooks?: ReactNode
  /** The frame fills the window, so a scenario can resize it (the size is still the reference's at the story's own viewport). */
  fill?: boolean
  /** The conversation Theo shows, in place of the parity fixture's. */
  conversation?: FixtureOptions['conversation']
  /** The conversation keeps moving while the story runs, as a working run's does. */
  liveConversation?: FixtureOptions['liveConversation']
  /** The layout the person saves (each panel's view of it included) survives a reload of the story, and is loaded at start. */
  persistLayout?: boolean
  /** Texts the documents owner holds, by path, for a file the story opens. */
  documents?: FixtureOptions['documents']
  /** What the host can do, in place of the parity story's capabilities. */
  granted?: string[]
  /** The account the Threads panel lists, in place of the parity fixture's. */
  threadsSeed?: FixtureOptions['threadsSeed']
  /** The conversation owner takes input and answers approvals and stops while the story runs. */
  owner?: FixtureOptions['owner']
}) {
  const profile = PALETTE_PROFILES.find((p) => p.id === 'github-sharp-dark')!
  return (
    <PaletteProfileGate profile={profile}>
      <LadderGate ladder={ladder}>
        <FixtureStory
          id={id}
          width={fill ? '100vw' : PARITY_VIEWPORT.width}
          height={fill ? '100dvh' : PARITY_VIEWPORT.height}
          options={{
            granted,
            transcript: true,
            idle: false,
            threads: true,
            terminal: false,
            conversation,
            liveConversation,
            persistLayout,
            documents,
            threadsSeed,
            owner,
            repository,
          }}
          script={[]}
          onEffect={record}
          arrangements={persistLayout}
          wait={['Threads', 'Changes']}
          extra={
            <>
              <Hooks />
              {hooks}
            </>
          }
        />
      </LadderGate>
    </PaletteProfileGate>
  )
}

/**
 * `workbench-delta-parity`: today's panels (Threads, Theo, Changes) over an invented fixture at the reference
 * frame's size, drawn in the colour ladder. Held against the blurred reference.
 */
export function WorkbenchDeltaParityStory() {
  return <ParityStory id="workbench-delta-parity" ladder />
}

/** `workbench-delta-parity-before`: the same fixture in the colours from before the ladder, for the comparison. */
export function WorkbenchDeltaParityBeforeStory() {
  return <ParityStory id="workbench-delta-parity-before" ladder={false} />
}
