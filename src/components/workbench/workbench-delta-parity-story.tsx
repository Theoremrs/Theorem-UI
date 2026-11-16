// SOURCING: the existing workbench story pieces (FixtureStory over the real wasm workbench, the Hooks the oracle reads, PaletteProfileGate for the profile) and the terminal's own loadWasm, so the proposal reaches the Rust palette through the same set_palette the page uses; the ladder itself is terminal-ladder.ts. This file adds only the two stories and the switch that sends the proposed palette.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useWorkbenchAgent } from '@/lib/workbench/agent/store'
import { loadWasm } from '@/components/terminal/terminal-screen'
import { useTerminalTheme } from '@/components/terminal/live-terminal-theme'
import { proposedPalette } from '@/components/terminal/terminal-ladder'
import { wasmPalette } from '@/components/terminal/terminal-roles'
import { PALETTE_PROFILES } from '@/stories/palette-matrix'
import { PaletteProfileGate } from './workbench-palette-stories'
import { THREADS_CAPS } from './workbench-feature-stories'
import {
  PARITY_CHANGES,
  PARITY_CONVERSATION,
  PARITY_THREADS,
  PARITY_VIEWPORT,
  parityDiff,
} from './delta-parity-fixture'
import { FixtureStory } from './workbench-story'

declare global {
  interface Window {
    /** The colours the Rust terminal was last given by the parity story: `proposed` says which set. */
    __parityLadder?: { proposed: boolean }
  }
}

/**
 * Sends the Rust terminal either the proposed ladder (`proposed`) or what the page always sends. The page's own
 * paint runs first (loadWasm subscribes before this does), so the choice is the last word on every theme change.
 * Children wait until the first paint is made.
 */
function LadderGate({
  proposed,
  children,
}: {
  proposed: boolean
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
          JSON.stringify(proposed ? proposedPalette(roles) : wasmPalette(roles)),
        )
        window.__parityLadder = { proposed }
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
  }, [proposed])
  return ready ? children : <div data-story-pending="" />
}

/** The semantic tree, for the oracle, off the mounted handle. */
function Hooks() {
  useEffect(() => {
    window.__workbenchTree = () =>
      JSON.parse(
        useWorkbenchAgent.getState().handle?.semantics() ?? '{"nodes":[]}',
      )
    return () => {
      window.__workbenchTree = undefined
    }
  }, [])
  return null
}

function ParityStory({ id, proposed }: { id: string; proposed: boolean }) {
  const profile = PALETTE_PROFILES.find((p) => p.id === 'github-sharp-dark')!
  return (
    <PaletteProfileGate profile={profile}>
      <LadderGate proposed={proposed}>
        <FixtureStory
          id={id}
          width={PARITY_VIEWPORT.width}
          height={PARITY_VIEWPORT.height}
          options={{
            granted: THREADS_CAPS,
            transcript: true,
            idle: false,
            threads: true,
            terminal: false,
            conversation: PARITY_CONVERSATION,
            threadsSeed: PARITY_THREADS,
            repository: { changes: PARITY_CHANGES, diff: parityDiff },
          }}
          script={[]}
          wait={['Threads', 'Changes']}
          extra={<Hooks />}
        />
      </LadderGate>
    </PaletteProfileGate>
  )
}

/**
 * `workbench-delta-parity`: today's panels (Threads, Theo, Changes) over an invented fixture at the reference
 * frame's size, drawn in the proposed colour ladder. Held against the blurred reference; the ladder is opt-in.
 */
export function WorkbenchDeltaParityStory() {
  return <ParityStory id="workbench-delta-parity" proposed />
}

/** `workbench-delta-parity-current`: the same fixture with the proposal off, for the comparison. */
export function WorkbenchDeltaParityCurrentStory() {
  return <ParityStory id="workbench-delta-parity-current" proposed={false} />
}
