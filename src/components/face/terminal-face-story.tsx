// SOURCING: ./face-bench's FaceView (the face as a story draws it) and ./face-stage (the one Theo), both driven by lib/face/store's one Face; the palettes are components/terminal/terminal-theme's terminalTheme over workspaces, as the terminal derives its own. The cell is the workbench's, measured in workbench-default: 7.5 by 17 CSS pixels at 12.5px JetBrains Mono.
import { useEffect, useState } from 'react'
import {
  SLATE,
  terminalTheme,
  workspaceOf,
} from '@/components/terminal/terminal-theme'
import type {
  TerminalTheme,
  Workspace,
} from '@/components/terminal/terminal-theme'
import { theFace } from '@/lib/face/store'
import { FaceView } from './face-bench'
import { FaceStage } from './face-stage'
import { terminalFace } from './terminal-face'
import { TerminalFacePerch } from './terminal-face-perch'

/** The workbench's cell, in CSS pixels. */
const CELL = { width: 7.5, height: 17 }
/** The face's cells: three wide, one row. */
const FACE_CELLS = { x: 0, y: 0, w: 3, h: 1 }
/** The face at rest, as wide as the cells let it be (components/face/driver keeps it inside them). */
const REAL = Math.min(
  32,
  FACE_CELLS.w * CELL.width,
  (FACE_CELLS.h * CELL.height * 100) / 64,
)

/**
 * A light terminal surface (GitHub Light's). The app's terminal is dark in
 * every workspace today (terminalTheme keeps it a shade below the darkest large
 * colour), so this one is set by hand to prove the face reads on a surface the
 * terminal may one day have.
 */
const LIGHT: Pick<TerminalTheme, 'bg' | 'ink'> = {
  bg: '#ffffff',
  ink: '#1f2328',
}

/** A person's own palette: a warm, dark one that is neither of the two. */
const customWorkspace = (): Workspace => {
  const tokens: Record<string, string> = {
    'surface-neutral': '#2b2118',
    'surface-sidebar': '#241b13',
    'surface-frame': '#241b13',
    'surface-raised': '#34291f',
    'surface-hover': '#3d3126',
    'surface-composer': '#34291f',
    'surface-artifact': '#34291f',
    'surface-rail': '#241b13',
    'sheet-from': '#2b2118',
    'sheet-to': '#241b13',
    ink: '#f2e4cf',
    'ink-muted': '#c4b49c',
    'ink-faint': '#988a76',
    'line-control': '#4a3c2e',
    'line-separator': '#4a3c2e',
  }
  return workspaceOf((name) => tokens[name] as string)
}

const PALETTES: ReadonlyArray<{
  name: string
  theme: Pick<TerminalTheme, 'bg' | 'ink' | 'muted'>
}> = [
  { name: 'dark', theme: SLATE },
  { name: 'light', theme: { ...LIGHT, muted: '#59636e' } },
  { name: 'custom', theme: terminalTheme(customWorkspace()) },
]

/** What the controls ask of the one face: each is an activity or an expression the chat face shows too. */
const STATES: ReadonlyArray<{ id: string; apply: () => void }> = [
  {
    id: 'rest',
    apply: () => {
      const face = theFace()
      face.setLiveness('idle')
      face.express(undefined)
    },
  },
  { id: 'work', apply: () => theFace().setLiveness('work') },
  { id: 'ask', apply: () => theFace().setLiveness('ask') },
  {
    id: 'tilt',
    apply: () => theFace().express({ tilt: 0.8, gaze: [0.6, -0.2] }),
  },
  {
    id: 'skeptic',
    apply: () => {
      theFace().perform('skeptic', { owner: 'story' })
    },
  },
  {
    id: 'sleep',
    apply: () => {
      theFace().perform('sleep', { owner: 'story' })
    },
  },
]

function Strip({
  theme,
  children,
}: {
  theme: Pick<TerminalTheme, 'bg' | 'ink' | 'muted'>
  children?: React.ReactNode
}) {
  return (
    <div
      className="relative overflow-hidden font-mono text-[12.5px] leading-[17px] whitespace-pre"
      style={{
        background: theme.bg,
        color: theme.ink,
        width: 300,
        height: 17 * 3,
      }}
    >
      <div style={{ paddingLeft: FACE_CELLS.w * CELL.width }}>
        working on the build
      </div>
      <div style={{ color: theme.muted }}> ~/theorem · main</div>
      <div>❯ run the tests</div>
      {children}
    </div>
  )
}

/**
 * The inverse Theo on the terminal surface in dark, light and a custom
 * palette, in the workbench's real cell and magnified, all drawn from the one
 * face the stage drives. The buttons change its activity and expression;
 * the palette buttons switch the live strip's surface without touching either.
 */
export function TheoFaceInverse() {
  const [live, setLive] = useState(0)
  const [said, setSaid] = useState('')
  useEffect(() => {
    const timer = setInterval(() => setSaid(theFace().words()), 200)
    return () => clearInterval(timer)
  }, [])
  const palette = PALETTES[live] as (typeof PALETTES)[number]
  return (
    <div
      className="bg-background text-ink flex min-h-dvh flex-col gap-5 p-5 text-sm"
      data-slot="theo-face-inverse"
    >
      <section className="flex flex-wrap gap-1.5" aria-label="Theo's state">
        {STATES.map((state) => (
          <button
            key={state.id}
            type="button"
            className="border-separator hover:bg-hover rounded-md border px-2 py-1"
            onClick={state.apply}
          >
            {state.id}
          </button>
        ))}
        <span
          className="text-ink-muted ml-3 self-center text-xs"
          data-slot="doing"
        >
          {said}
        </span>
      </section>
      <section className="flex gap-6">
        {PALETTES.map(({ name, theme }) => {
          const appearance = terminalFace(theme.bg, theme.ink)
          return (
            <figure
              key={name}
              className="flex w-[300px] flex-col gap-2"
              data-palette={name}
            >
              <Strip theme={theme}>
                <div className="absolute" style={{ left: 0, top: 0 }}>
                  <div
                    className="flex items-center justify-center"
                    style={{
                      width: FACE_CELLS.w * CELL.width,
                      height: CELL.height,
                    }}
                  >
                    <FaceView
                      face={theFace()}
                      width={REAL}
                      running
                      plain
                      appearance={appearance}
                    />
                  </div>
                </div>
              </Strip>
              <div
                className="flex items-center justify-center rounded-md p-3"
                style={{ background: theme.bg }}
              >
                <FaceView
                  face={theFace()}
                  width={110}
                  running
                  plain
                  appearance={appearance}
                />
              </div>
              <figcaption className="text-ink-muted text-xs">
                {name}: body {appearance.bodyOnSurface.toFixed(1)}:1 on the
                surface, eyes {appearance.eyesOnBody.toFixed(1)}:1 on the body,{' '}
                {appearance.look.ink ? 'ink' : 'light'} eyes
              </figcaption>
            </figure>
          )
        })}
      </section>
      <section
        className="flex w-[300px] flex-col gap-2"
        aria-label="The stage's face on a perch"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-ink-muted text-xs">
            Live strip, rested on by the one stage face:
          </span>
          {PALETTES.map(({ name }, index) => (
            <button
              key={name}
              type="button"
              aria-pressed={live === index}
              className="border-separator hover:bg-hover aria-pressed:bg-hover rounded-md border px-2 py-1"
              onClick={() => setLive(index)}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="relative" style={{ width: 300 }} data-slot="live-strip">
          <Strip theme={palette.theme} />
          <TerminalFacePerch
            cells={FACE_CELLS}
            cell={CELL}
            theme={palette.theme}
          />
        </div>
      </section>
      <FaceStage />
    </div>
  )
}
