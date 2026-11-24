// SOURCING: a bench for CellsTerminal (cells-terminal.tsx) as an interactive view's reply holds it: a view's cells to edit and run, the run answered on a timer (a cell that throws fails it) in place of the view's frame. No library models a view's rebuild; it is a timer over the component's own props.
'use client'

import { useState } from 'react'
import { CellsTerminal } from './cells-terminal'
import type { CellsStatus } from './cells-terminal'

const CELLS = [
  'const regions = [\n  { name: "North", sales: 42 },\n  { name: "South", sales: 31 },\n  { name: "East", sales: 27 },\n]',
  'const min = view(Inputs.range([0, 50], { label: "At least", step: 1 }))',
  'Plot.barY(regions.filter((d) => d.sales >= min), { x: "name", y: "sales" }).plot()',
]

export function CellsTerminalStory() {
  const [status, setStatus] = useState<CellsStatus>('idle')
  const [error, setError] = useState<string>()
  const [ran, setRan] = useState<string[]>(CELLS)
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <CellsTerminal
        title="Sales by region"
        cells={CELLS}
        status={status}
        error={error}
        defaultOpen
        onRun={(cells) => {
          setStatus('running')
          setTimeout(() => {
            const thrown = cells.find((cell) => /\bthrow\b/.test(cell))
            setError(thrown ? 'Error: the cell threw' : undefined)
            setStatus(thrown ? 'error' : 'idle')
            setRan(cells)
          }, 900)
        }}
      />
      <pre data-testid="ran" className="text-xs text-ink-muted">
        {JSON.stringify(ran, null, 2)}
      </pre>
    </div>
  )
}
