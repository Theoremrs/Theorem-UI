// SOURCING: next-themes (the theme switch's own setTheme, as shell/rail uses it) and lib/appearance's useAppearance (the palette a person picks, as the cabinet overlay and Settings set it), so a profile is painted the way the app paints it and terminalTheme computes from the live tokens. The surfaces are the existing workbench stories' own scripts over FixtureStory.
import { useCallback, useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import { FaceStage } from '@/components/face/face-stage'
import { useAppearance } from '@/lib/appearance'
import { theFace } from '@/lib/face/store'
import {
  PALETTE_PROFILES,
  PALETTE_SURFACES,
  paletteStoryId,
} from '@/stories/palette-matrix'
import type { PaletteProfile, PaletteSurface } from '@/stories/palette-matrix'
import {
  EVERY_TOOL,
  FixtureStory,
  MARKDOWN_OPEN,
  OPEN_ARTIFACTS,
  WIDEN_TOOLS,
} from './workbench-story'
import type { Step } from './workbench-story'
import type { ReactNode } from 'react'

declare global {
  interface Window {
    /** A story's hook: puts the page in another profile the way the Settings and the theme switch do, without a reload. */
    __setPaletteProfile?: (id: string) => Promise<void>
  }
}

const ESC = '\u001b'
const CSI = `${ESC}[`
const sgr = (code: string, text: string) => `${CSI}${code}m${text}${CSI}0m`
const two = (n: number) => String(n).padStart(2, '0')

/** The foreground SGR for ANSI slot `n`: 30 to 37, then 90 to 97. */
const fgCode = (n: number) => String(n < 8 ? 30 + n : 82 + n)
/** The background SGR for ANSI slot `n`: 40 to 47, then 100 to 107. */
const bgCode = (n: number) => String(n < 8 ? 40 + n : 92 + n)
const slots = Array.from({ length: 16 }, (_, n) => n)

/** A 256-colour row: cells of `from` to `to` as backgrounds, each a space. */
const ramp = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => sgr(`48;5;${from + i}`, ' ')).join('') + '\r\n'

/** The truecolor gradient: red falling and blue rising across sixty-four cells. */
export const TRUECOLOR_CELLS = 64
export const truecolorAt = (i: number): [number, number, number] => [
  Math.round(255 - (255 * i) / (TRUECOLOR_CELLS - 1)),
  Math.round(96 + 64 * Math.sin((Math.PI * i) / (TRUECOLOR_CELLS - 1))),
  Math.round((255 * i) / (TRUECOLOR_CELLS - 1)),
]

/**
 * What a test run leaves on a terminal: results in colour, the sixteen ANSI slots as foreground and as
 * background, the 256-colour cube and grey ramp, a truecolor gradient, and the text attributes. Every
 * line is under 72 columns, which the process pane shows once the tools group is widened.
 */
export const TERMINAL_TEST_OUTPUT: string[] = [
  `${sgr('1;32', 'ada@story')}:${sgr('1;34', '~/project')}$ cargo test\r\n`,
  `   ${sgr('1;32', 'Compiling')} theorem-terminal v0.1.0\r\n`,
  'running 4 tests\r\n',
  `test grid::cell_width ... ${sgr('32', 'ok')}\r\n`,
  `test grid::wide_cells ... ${sgr('32', 'ok')}\r\n`,
  `test panel::draw ... ${sgr('1;31', 'FAILED')}\r\n`,
  `test picker::filter ... ${sgr('33', 'ignored')}\r\n`,
  `${sgr('1;33', 'warning')}: unused variable: \`width\`\r\n`,
  `${sgr('1;31', 'error[E0308]')}: mismatched types\r\n`,
  `test result: ${sgr('31', 'FAILED')}. 2 passed; 1 failed; 1 ignored\r\n`,
  `fg:${slots.map((n) => sgr(fgCode(n), ` ${two(n)}`)).join('')}\r\n`,
  `bg:${slots.map((n) => sgr(bgCode(n), ` ${two(n)} `)).join('')}\r\n`,
  `c6:${ramp(16, 51)}`,
  `   ${ramp(52, 87)}`,
  `   ${ramp(88, 123)}`,
  `   ${ramp(124, 159)}`,
  `   ${ramp(160, 195)}`,
  `   ${ramp(196, 231)}`,
  `gr:${ramp(232, 255)}`,
  `tc:${Array.from({ length: TRUECOLOR_CELLS }, (_, i) => sgr(`48;2;${truecolorAt(i).join(';')}`, ' ')).join('')}\r\n`,
  `${sgr('1', 'bold')} ${sgr('2', 'dim')} ${sgr('3', 'italic')} ${sgr('4', 'underline')} ${sgr('7', 'inverse')} ${sgr('9', 'strike')}\r\n`,
  `${sgr('38;2;255;128;0', 'truecolor ink')} ${sgr('38;5;208', '256 ink')} ${sgr('1;33;44', 'bold on blue')}\r\n`,
]

/** The tools group widened, then the Shell opened onto the recorded output. */
const OPEN_TERMINAL: Step[] = [
  WIDEN_TOOLS,
  { chord: 's' },
  { see: 'Existing sessions' },
  { key: 'Enter' },
  { see: 'test result' },
]

/**
 * Paints the page in `profile` the way a person does (the palette they pick, the theme switch), and
 * holds its children back until the root has the palette and the terminal's own colours have followed it.
 * `window.__setPaletteProfile` puts the page in another profile live, for an oracle to measure a switch.
 */
export function PaletteProfileGate({
  profile,
  children,
}: {
  profile: PaletteProfile
  children: ReactNode
}) {
  const { theme, setTheme } = useTheme()
  const [applied, setApplied] = useState(false)
  const apply = useCallback(
    async (next: PaletteProfile) => {
      useAppearance.getState().setOverrides({ palette: next.palette })
      setTheme(next.mode)
      const root = document.documentElement
      for (let i = 0; i < 120; i++) {
        if (
          root.dataset.palette === next.palette &&
          root.classList.contains('dark') === (next.mode === 'dark')
        )
          break
        await new Promise((resolve) => setTimeout(resolve, 16))
      }
      // The terminal's colours follow the root's attributes from a MutationObserver.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    },
    [setTheme],
  )
  useEffect(() => {
    const { preset, overrides } = useAppearance.getState()
    const before = theme
    let live = true
    void apply(profile).then(() => live && setApplied(true))
    window.__setPaletteProfile = async (id) => {
      const next = PALETTE_PROFILES.find((p) => p.id === id)
      if (!next) throw new Error(`no profile ${id}`)
      await apply(next)
    }
    return () => {
      live = false
      delete window.__setPaletteProfile
      useAppearance.getState().loadSelection({ preset, overrides })
      if (before) setTheme(before)
    }
    // A story is one profile for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // Until the profile is on the page, the story is pending, so no oracle reads it before its colours are the profile's.
  return applied ? children : <div data-story-pending="" />
}

/**
 * Theo working: the one face the stage drives, held in its working liveness the way a run in flight
 * holds it (the transcript fixture's own runs finish and settle the face to rest, so it is set again).
 */
function TheoWorking() {
  useEffect(() => {
    const hold = () => theFace().setLiveness('work')
    hold()
    const timer = window.setInterval(hold, 200)
    return () => {
      window.clearInterval(timer)
      theFace().setLiveness('idle')
    }
  }, [])
  return null
}

const surfaces: Record<PaletteSurface, (id: string) => ReactNode> = {
  chat: (id) => (
    <FixtureStory
      id={id}
      width={1280}
      height={640}
      options={{ granted: ['files'], transcript: true }}
      script={[]}
      wait={['README.md', 'More tools', 'Allow']}
    />
  ),
  markdown: (id) => (
    <FixtureStory
      id={id}
      width={1280}
      height={700}
      options={{ granted: EVERY_TOOL }}
      script={[...MARKDOWN_OPEN, WIDEN_TOOLS, { key: '4', alt: true }]}
      wait={['Workbench guide']}
    />
  ),
  changes: (id) => (
    <FixtureStory
      id={id}
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL }}
      script={[
        { chord: 'g' },
        { see: 'Cargo.toml' },
        // main.rs, the one file whose diff replaces a line: removed, added, and the words that differ.
        { key: 'ArrowDown' },
        { key: 'ArrowDown' },
        { key: 'ArrowDown' },
        { key: 'Enter' },
        { see: '@@' },
      ]}
      wait={['Cargo.toml', '@@']}
    />
  ),
  cabinet: (id) => (
    <FixtureStory
      id={id}
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL, transcript: true }}
      project={{ id: 'project-theorem', title: 'Theorem' }}
      script={OPEN_ARTIFACTS}
      wait={['Gallery']}
    />
  ),
  terminal: (id) => (
    <FixtureStory
      id={id}
      width={1280}
      height={640}
      options={{
        granted: EVERY_TOOL,
        terminal: true,
        terminalOutput: TERMINAL_TEST_OUTPUT,
      }}
      script={OPEN_TERMINAL}
      wait={['test result']}
    />
  ),
  face: (id) => (
    <FixtureStory
      id={id}
      width={1280}
      height={640}
      options={{ granted: ['files'], transcript: true }}
      script={[]}
      wait={['README.md', 'Allow']}
      extra={
        <>
          <TheoWorking />
          <FaceStage />
        </>
      }
    />
  ),
}

/** `workbench-palette-<surface>-<profile>`: one surface of the workbench in one palette and mode. */
export function PaletteMatrixStory({
  surface,
  profile,
}: {
  surface: PaletteSurface
  profile: PaletteProfile
}) {
  const id = paletteStoryId(surface, profile.id)
  return (
    <PaletteProfileGate profile={profile}>
      {surfaces[surface](id)}
    </PaletteProfileGate>
  )
}

/** The registry's entries: every surface in every profile. */
export const PALETTE_MATRIX_REGISTRY = Object.fromEntries(
  PALETTE_SURFACES.flatMap(({ id: surface }) =>
    PALETTE_PROFILES.map((profile) => [
      paletteStoryId(surface, profile.id),
      () => <PaletteMatrixStory surface={surface} profile={profile} />,
    ]),
  ),
)
