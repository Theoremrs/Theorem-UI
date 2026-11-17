// SOURCING: none — a story of the workbench saving and applying its theme with a layout: the real wasm workbench over createFixtureHost, with the real appearance owner and the real appearance store answering the one effect the fixture host has no owner for. It uses WorkbenchSurface; nothing else applies.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppearance } from '@/lib/appearance'
import { completionFor } from '@/lib/workbench/adapter'
import type { Adapter } from '@/lib/workbench/adapter'
import {
  createAppearancePort,
  tellAppearance,
} from '@/lib/workbench/appearance/appearance'
import { createFixtureHost } from './fixture-host'
import type { FixtureHost } from './fixture-host'
import { WorkbenchSurface } from './workbench'
import type { Dispatch, SemanticsFeed, SurfaceHost } from './workbench'
import { EVERY_TOOL } from './workbench-story'

/** The theme the story starts in, and the one a control switches to: visibly different presets and palettes. */
const START = {
  preset: 'calm',
  overrides: { palette: 'github-sharp' },
} as const
const OTHER = { preset: 'expressive', overrides: { palette: 'stone' } } as const

/** Mod+Alt+F1..F4 apply the presets; Mod+Alt+L opens the Layouts page of the picker. */
const KEYS = JSON.stringify({
  version: 1,
  bind: [
    ...['default', 'editor', 'agent', 'minimal'].map((preset, index) => ({
      chord: `Mod+Alt+F${index + 1}`,
      context: { type: 'global' },
      action: `workbench.layout.${preset}`,
    })),
    {
      chord: 'Mod+Alt+L',
      context: { type: 'global' },
      action: 'workbench.layouts',
    },
  ],
})

/** What the story's controls do: the save, and the person's theme switched through the store. */
const CONTROLS: Record<string, (surface: SurfaceHost) => void> = {
  'save-mine': (surface) => surface.arrangement({ type: 'save', name: 'Mine' }),
  'theme-start': () => useAppearance.getState().loadSelection(START),
  'theme-other': () => useAppearance.getState().loadSelection(OTHER),
}

/**
 * `workbench-appearance`: a workbench that tells the core the person's theme, so a saved layout
 * carries it, and applies the theme of a saved layout it is asked to. `data-appearance-preset` and
 * `data-appearance-palette` on the box are the resolved theme; the controls (never part of the
 * product) save the layout "Mine" and switch the theme through the store.
 */
export function WorkbenchAppearanceStory() {
  const box = useRef<HTMLDivElement>(null)
  const feedRef = useRef<SemanticsFeed>(undefined)
  const surfaceRef = useRef<SurfaceHost>(undefined)
  const [drawn, setDrawn] = useState(false)
  const [ready, setReady] = useState(false)
  const preset = useAppearance((state) => state.appearance.preset)
  const palette = useAppearance((state) => state.appearance.palette)

  const connect = useCallback(
    (dispatch: Dispatch, surface: SurfaceHost): Adapter => {
      surfaceRef.current = surface
      useAppearance.getState().loadSelection(START)
      const stopTelling = tellAppearance(useAppearance, (value) =>
        surface.arrangement({ type: 'appearance', value }),
      )
      const port = createAppearancePort(useAppearance)
      const host: FixtureHost = createFixtureHost(dispatch, {
        granted: EVERY_TOOL,
        transcript: true,
        persistLayout: true,
      })
      return {
        perform(effect) {
          if (effect.kind !== 'appearanceApply') return host.perform(effect)
          void port.perform(effect, `story-${effect.id}`).then((answer) =>
            dispatch({
              channel: 'completion',
              ...completionFor(effect, answer),
            }),
          )
        },
        dispose() {
          stopTelling()
          host.dispose()
        },
      }
    },
    [],
  )

  useEffect(() => {
    if (!drawn) return
    const feed = feedRef.current
    const surface = surfaceRef.current
    if (!feed || !surface) return
    surface.setKeys(KEYS)
    let all = feed.latest ?? ''
    let frame = 0
    const settle = () => {
      if (!all.includes('README.md')) return
      off()
      frame = requestAnimationFrame(() =>
        requestAnimationFrame(() => setReady(true)),
      )
    }
    const off = feed.subscribe((update) => {
      all += update
      settle()
    })
    settle()
    return () => {
      off()
      cancelAnimationFrame(frame)
    }
  }, [drawn])

  return (
    <div
      ref={box}
      data-workbench-story="workbench-appearance"
      data-story-pending={ready ? undefined : ''}
      data-appearance-preset={preset}
      data-appearance-palette={palette}
      style={{ width: 1280, height: 640 }}
      className="relative flex flex-col overflow-hidden bg-term"
    >
      <WorkbenchSurface
        connect={connect}
        onDrawn={() => setDrawn(true)}
        loadArrangements
      >
        {(feed) => {
          feedRef.current = feed
          return null
        }}
      </WorkbenchSurface>
      <div
        data-story-controls=""
        className="absolute right-0 bottom-0 flex opacity-0"
      >
        {Object.keys(CONTROLS).map((name) => (
          <button
            key={name}
            type="button"
            data-story-control={name}
            tabIndex={-1}
            onClick={() => {
              const surface = surfaceRef.current
              if (surface) CONTROLS[name]?.(surface)
            }}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}
