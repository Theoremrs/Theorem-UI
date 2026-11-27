// SOURCING: @theorem/ui (Astryx in Theorem's theme), study C as the owner
// picked it on 2026-11-24: the Gray–Scott fixture as an App on the kit. The
// picture alone; Pause, Reset and Parameters float over it, and Parameters
// opens the rates, the preset map and the seeding actions. Each control has
// a name the agent reaches it by.
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { Button, Dock, DockRow, Slider, Stage, Theme } from '@theorem/ui'
import { FEED, KILL, PresetMap } from './preset-map'
import { simulate } from './simulation'
import type { Settings, Simulation } from './simulation'
import './look.css'

const four = (value: number) => value.toFixed(4)

function GrayScott() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const simulation = useRef<Simulation | null>(null)
  const [settings, setSettings] = useState<Settings>({ feed: 0.037, kill: 0.06, speed: 10, brush: 12, running: true })
  const [failed, setFailed] = useState<string>()
  const now = useRef(settings)
  now.current = settings
  const change = (next: Partial<Settings>) => setSettings((was) => ({ ...was, ...next }))

  useEffect(() => {
    try {
      const started = simulate(canvas.current!, () => now.current)
      simulation.current = started
      if (started.software) change({ speed: 4, brush: 7 })
      return () => {
        started.stop()
        simulation.current = null
      }
    } catch (error) {
      setFailed(error instanceof Error ? error.message : String(error))
      return undefined
    }
  }, [])

  useEffect(() => {
    const space = (event: KeyboardEvent) => {
      const active = document.activeElement?.tagName ?? ''
      if (event.code !== 'Space' || /INPUT|BUTTON|SELECT|TEXTAREA/.test(active)) return
      if ((document.activeElement as HTMLElement | null)?.getAttribute('role') === 'slider') return
      event.preventDefault()
      setSettings((was) => ({ ...was, running: !was.running }))
    }
    window.addEventListener('keydown', space)
    return () => window.removeEventListener('keydown', space)
  }, [])

  const panel = (
    <>
      <Slider label="Feed rate" value={settings.feed} min={FEED.min} max={FEED.max} step={0.0001}
        formatValue={four} control="feed" onChange={(feed) => change({ feed })} />
      <Slider label="Kill rate" value={settings.kill} min={KILL.min} max={KILL.max} step={0.0001}
        formatValue={four} control="kill" onChange={(kill) => change({ kill })} />
      <Slider label="Steps / frame" value={settings.speed} min={1} max={24} step={1}
        control="speed" onChange={(speed) => change({ speed })} />
      <Slider label="Brush" value={settings.brush} min={2} max={40} step={1}
        control="brush" onChange={(brush) => change({ brush })} />
      <DockRow>
        <PresetMap feed={settings.feed} kill={settings.kill} onChange={(feed, kill) => change({ feed, kill })} />
      </DockRow>
      <DockRow>
        <Button label="Sprinkle" variant="secondary" size="sm" control="sprinkle"
          onClick={() => simulation.current?.sprinkle()} />
        <Button label="Clear" variant="secondary" size="sm" control="clear"
          onClick={() => simulation.current?.clear()} />
      </DockRow>
    </>
  )

  return (
    <Stage className="gs" narrowAspect="3 / 4">
      <canvas ref={canvas} aria-label="Gray–Scott simulation; drag to seed" />
      {failed ? (
        <div className="err">{failed}</div>
      ) : (
        <Dock panel={panel}>
          <Button label={settings.running ? 'Pause' : 'Resume'} variant="primary" size="sm" control="pause"
            onClick={() => change({ running: !settings.running })} />
          <Button label="Reset" variant="ghost" size="sm" control="reset"
            onClick={() => simulation.current?.reset()} />
        </Dock>
      )}
    </Stage>
  )
}

createRoot(document.getElementById('root')!).render(
  <Theme>
    <GrayScott />
  </Theme>,
)
