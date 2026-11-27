// SOURCING: the owner's pick of 2026-11-24, study C of
// docs/plans/chromeless-artifacts.md ("the picture alone; Pause, Reset and
// Parameters float over it, and Parameters opens the rest"), on Theorem's
// tokens. Astryx's ToggleButton opens the panel. A Stage is a picture whose
// size comes from its own aspect, never from the frame; a Dock floats an
// App's few controls over it, clear of the host's actions at its top corner.
import { useId, useState } from 'react'
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { ToggleButton } from './controls'
import './stage.css'

export interface StageProps extends HTMLAttributes<HTMLDivElement> {
  /** Width over height, as CSS `aspect-ratio` takes it. */
  aspect?: string
  /** The aspect at 520 CSS pixels wide and under, where a wide picture would be a strip. */
  narrowAspect?: string
}

/** The picture an App is about: full width, its height from its aspect. */
export function Stage({ aspect = '16 / 9', narrowAspect = '1', className, style, ...rest }: StageProps) {
  return (
    <div
      data-slot="stage"
      className={['tu-stage', className].filter(Boolean).join(' ')}
      style={{ '--tu-aspect': aspect, '--tu-narrow-aspect': narrowAspect, ...style } as CSSProperties}
      {...rest}
    />
  )
}

export interface DockProps {
  /** The few controls that are always there: a primary action first. */
  children: ReactNode
  /** What Parameters opens. Without it the Dock is its bar alone. */
  panel?: ReactNode
  /** The toggle's name, and the panel's. */
  panelLabel?: string
  /** Whether the panel starts open. */
  defaultOpen?: boolean
}

/** Controls floating over a Stage: a bar of a few, and a panel the bar opens. */
export function Dock({ children, panel, panelLabel = 'Parameters', defaultOpen = false }: DockProps) {
  const [open, setOpen] = useState(defaultOpen)
  const id = useId()
  return (
    <div data-slot="dock" className="tu-dock" data-open={open || undefined}>
      {panel !== undefined && open && (
        <div id={id} role="group" aria-label={panelLabel} className="tu-dock-panel">
          {panel}
        </div>
      )}
      <div className="tu-dock-bar">
        {children}
        {panel !== undefined && (
          <ToggleButton
            label={panelLabel}
            size="sm"
            isPressed={open}
            onPressedChange={setOpen}
            aria-expanded={open}
            aria-controls={id}
          />
        )}
      </div>
    </div>
  )
}

/** A row across a Dock's panel, for its secondary actions or presets. */
export function DockRow(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={['tu-dock-row', props.className].filter(Boolean).join(' ')} />
}
