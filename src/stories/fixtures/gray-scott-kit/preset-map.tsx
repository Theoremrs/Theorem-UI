// SOURCING: none: a control the kit does not have, written in the App's own
// files: the feed and kill plane with the fixture's nine presets on it. Drag
// or tap to move both rates at once, arrows to nudge them, or pick a preset.
// It reaches the agent as `preset` through useControl, like a kit control.
import { useRef } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { useControl } from '@theorem/ui'

export const PRESETS = [
  ['coral growth', 0.0545, 0.062],
  ['mitosis', 0.0367, 0.0649],
  ['solitons', 0.03, 0.062],
  ['worms', 0.078, 0.061],
  ['mazes', 0.029, 0.057],
  ['chaos', 0.026, 0.051],
  ['moving spots', 0.014, 0.054],
  ['waves', 0.014, 0.045],
  ['u-skate', 0.062, 0.0609],
] as const

export const FEED = { min: 0.01, max: 0.09 }
export const KILL = { min: 0.04, max: 0.07 }
const STEP = 0.0001
const NUDGE = 0.0005

const clamp = (value: number, range: { min: number; max: number }) =>
  Math.round(Math.min(range.max, Math.max(range.min, value)) / STEP) * STEP
const across = (value: number, range: { min: number; max: number }) =>
  `${((value - range.min) / (range.max - range.min)) * 100}%`

/** The preset at these rates, or none. */
export const presetAt = (feed: number, kill: number) =>
  PRESETS.find(([, f, k]) => Math.abs(feed - f) < 1e-6 && Math.abs(kill - k) < 1e-6)?.[0]

export interface PresetMapProps {
  feed: number
  kill: number
  onChange: (feed: number, kill: number) => void
}

export function PresetMap({ feed, kill, onChange }: PresetMapProps) {
  const plane = useRef<HTMLDivElement>(null)
  const current = presetAt(feed, kill)
  useControl('preset', {
    label: 'Preset',
    kind: 'choice',
    options: PRESETS.map(([name]) => name),
    read: () => presetAt(feed, kill) ?? '',
    set: (name) => {
      const preset = PRESETS.find(([n]) => n === name)
      if (preset) onChange(preset[1], preset[2])
    },
  })

  const moveTo = (event: PointerEvent) => {
    const r = plane.current!.getBoundingClientRect()
    const x = (event.clientX - r.left) / r.width
    const y = 1 - (event.clientY - r.top) / r.height
    onChange(clamp(FEED.min + x * (FEED.max - FEED.min), FEED), clamp(KILL.min + y * (KILL.max - KILL.min), KILL))
  }
  const nudge = (event: KeyboardEvent) => {
    const by = event.shiftKey ? NUDGE * 10 : NUDGE
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-by, 0],
      ArrowRight: [by, 0],
      ArrowDown: [0, -by],
      ArrowUp: [0, by],
    }
    const move = moves[event.key]
    if (!move) return
    event.preventDefault()
    onChange(clamp(feed + move[0], FEED), clamp(kill + move[1], KILL))
  }

  return (
    <div className="preset-map">
      <div
        ref={plane}
        className="plane"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('button')) return
          event.currentTarget.setPointerCapture(event.pointerId)
          moveTo(event)
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) moveTo(event)
        }}
      >
        {PRESETS.map(([name, f, k]) => (
          <button
            key={name}
            type="button"
            className="preset"
            aria-label={name}
            aria-pressed={current === name}
            style={{ left: across(f, FEED), bottom: across(k, KILL) }}
            onClick={() => onChange(f, k)}
          />
        ))}
        <div
          className="thumb"
          role="slider"
          tabIndex={0}
          aria-label="Feed and kill"
          aria-valuemin={FEED.min}
          aria-valuemax={FEED.max}
          aria-valuenow={feed}
          aria-valuetext={`feed ${feed.toFixed(4)}, kill ${kill.toFixed(4)}`}
          style={{ left: across(feed, FEED), bottom: across(kill, KILL) }}
          onKeyDown={nudge}
        />
      </div>
      <div className="caption">
        <span>{current ?? 'custom'}</span>
        <span>
          {feed.toFixed(4)} · {kill.toFixed(4)}
        </span>
      </div>
    </div>
  )
}
