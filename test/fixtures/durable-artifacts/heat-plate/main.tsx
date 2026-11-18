// The heat plate App's presentation: a plate's steady temperature field
// drawn with a colormap, its boundaries and material set by the person. The
// field is computed by the `solve` operation, whose results are kept by what
// they depend on (the solver and its input), not by this file: changing the
// colormap or the layout reuses a solved field, even one solved by an earlier
// revision and read back from the store; changing a boundary or the material
// solves again.
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import {
  Operations,
  canonicalJson,
  digestOf,
  readResultRef,
} from '@theorem/runtime'
import type { ArtifactSourceRef } from '@theorem/runtime'
import { SOLVER, UNITS, solvePlate } from './solver'
import type { Boundary, PlateField, PlateInput } from './solver'
import { COLORMAP, colorAt } from './colormap'
import './look.css'

const MATERIALS = {
  aluminium: 237,
  steel: 50,
  glass: 1.0,
} as const
type Material = keyof typeof MATERIALS

const DEFAULT: PlateInput = {
  width: 0.2,
  height: 0.1,
  nx: 41,
  ny: 21,
  conductivity: MATERIALS.steel,
  left: { kind: 'fixed', temperature: 100 },
  right: { kind: 'convective', h: 25, ambient: 20 },
  bottom: { kind: 'insulated' },
  top: { kind: 'insulated' },
  tolerance: 1e-6,
}

async function operationsFor(source: ArtifactSourceRef) {
  const operations = new Operations({ source })
  operations.define({
    name: 'solve',
    version: SOLVER.version,
    summary:
      'The steady temperature field of a plate with no internal heat source',
    input: { plate: 'PlateInput: m, °C, W/(m·K), W/(m²·K)' },
    output: 'PlateField',
    representation: { schema: 'theorem.example.plate-field', version: '1' },
    reproducibility: 'deterministic',
    recovery: ['rerun', 'reopen'],
    // The solver is what a field depends on; a colormap or layout is not.
    implementation: await digestOf(SOLVER),
    dependencies: ['solver.ts'],
    run: (plate: PlateInput) => solvePlate(plate),
  })
  return operations
}

function BoundaryControl(props: {
  label: string
  value: Boundary
  onChange: (value: Boundary) => void
}) {
  const { value } = props
  return (
    <fieldset>
      <legend>{props.label}</legend>
      <select
        value={value.kind}
        onChange={(event) => {
          const kind = event.target.value as Boundary['kind']
          props.onChange(
            kind === 'fixed'
              ? { kind, temperature: 20 }
              : kind === 'convective'
                ? { kind, h: 25, ambient: 20 }
                : { kind },
          )
        }}
      >
        <option value="fixed">Held at</option>
        <option value="insulated">Insulated</option>
        <option value="convective">Cooled by air</option>
      </select>
      {value.kind === 'fixed' && (
        <label>
          {UNITS.temperature}
          <input
            type="number"
            value={value.temperature}
            onChange={(event) =>
              props.onChange({
                ...value,
                temperature: Number(event.target.value),
              })
            }
          />
        </label>
      )}
      {value.kind === 'convective' && (
        <>
          <label>
            h, {UNITS.convection}
            <input
              type="number"
              min={0}
              value={value.h}
              onChange={(event) =>
                props.onChange({ ...value, h: Number(event.target.value) })
              }
            />
          </label>
          <label>
            air, {UNITS.temperature}
            <input
              type="number"
              value={value.ambient}
              onChange={(event) =>
                props.onChange({
                  ...value,
                  ambient: Number(event.target.value),
                })
              }
            />
          </label>
        </>
      )}
    </fieldset>
  )
}

function Field({ field }: { field: PlateField }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    const rows = field.t.length
    const columns = field.t[0]!.length
    const values = field.t.flat()
    const low = Math.min(...values)
    const high = Math.max(...values)
    element.width = columns
    element.height = rows
    const image = context.createImageData(columns, rows)
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < columns; i++) {
        const [r, g, b] = colorAt((field.t[j]![i]! - low) / (high - low || 1))
        // Row 0 is the bottom edge; the canvas draws from the top.
        const at = ((rows - 1 - j) * columns + i) * 4
        image.data.set([r, g, b, 255], at)
      }
    context.putImageData(image, 0, 0)
  }, [field])
  const values = field.t.flat()
  return (
    <figure>
      <canvas ref={canvas} aria-label="Temperature across the plate" />
      <figcaption>
        {Math.min(...values).toFixed(1)} {UNITS.temperature} to{' '}
        {Math.max(...values).toFixed(1)} {UNITS.temperature}, colormap{' '}
        {COLORMAP.name}. {field.converged ? 'Converged' : 'Not converged'} after{' '}
        {field.sweeps} sweeps.
      </figcaption>
    </figure>
  )
}

function App() {
  const [plate, setPlate] = useState<PlateInput>(DEFAULT)
  const [field, setField] = useState<PlateField | null>(null)
  const [reused, setReused] = useState<string>('')
  const operations = useRef<Operations | null>(null)
  const state = useRef<Awaited<ReturnType<typeof theorem.state>> | null>(null)

  useEffect(() => {
    void (async () => {
      await theorem.ready
      state.current = await theorem.state('plate')
      const kept = state.current.get('input') as PlateInput | undefined
      if (kept) setPlate(kept)
      try {
        operations.current = await operationsFor(
          (await theorem.artifacts.source()) as ArtifactSourceRef,
        )
      } catch {
        operations.current = await operationsFor({
          kind: 'document',
          documentId: 'unsaved',
          position: '0',
          contentDigest: 'unsaved',
        })
      }
      // A field solved before, perhaps by an earlier revision: reuse it if it still stands.
      const resultId = state.current.get('result') as string | undefined
      if (kept && resultId) {
        try {
          const opened = await theorem.artifacts.open(resultId)
          const result = readResultRef(opened.result)
          const output: unknown = JSON.parse(
            new TextDecoder().decode(opened.bytes),
          )
          if (result) {
            const verdict = await operations.current.adopt(
              'solve',
              kept,
              output,
              result,
            )
            setReused(
              verdict.reusable
                ? 'Reused the field solved earlier.'
                : `Solving again: ${verdict.changed.join(', ')} changed.`,
            )
          }
        } catch {
          // Not kept, or not reachable: solve.
        }
      }
      setPlate((current) => ({ ...current }))
    })()
  }, [])

  useEffect(() => {
    const operations_ = operations.current
    if (!operations_) return
    const run = { stale: false }
    void (async () => {
      const done = await operations_.invoke<PlateField>('solve', plate)
      if (run.stale) return
      setField(done.output)
      if (done.reused) setReused('Reused the field solved earlier.')
      await state.current?.set('input', plate)
      if (!done.reused) {
        const bytes = new TextEncoder().encode(canonicalJson(done.output))
        const kept: { id: string } | undefined = await theorem.artifacts
          .result(done.result, bytes)
          .catch(() => undefined)
        if (kept) await state.current?.set('result', kept.id)
      }
    })()
    return () => {
      run.stale = true
    }
  }, [plate])

  // The material shown is the one the plate's conductivity is, so a restored plate shows its own.
  const material =
    (Object.keys(MATERIALS) as Array<Material>).find(
      (name) => MATERIALS[name] === plate.conductivity,
    ) ?? 'steel'

  const side = (name: 'left' | 'right' | 'bottom' | 'top', label: string) => (
    <BoundaryControl
      label={label}
      value={plate[name]}
      onChange={(value) => setPlate({ ...plate, [name]: value })}
    />
  )

  return (
    <main>
      <h1>Heat through a plate</h1>
      <p>
        {plate.width} {UNITS.length} by {plate.height} {UNITS.length}, steady
        state, no internal heat source.
      </p>
      <label>
        Material
        <select
          value={material}
          onChange={(event) => {
            const next = event.target.value as Material
            setPlate({ ...plate, conductivity: MATERIALS[next] })
          }}
        >
          {Object.entries(MATERIALS).map(([name, k]) => (
            <option key={name} value={name}>
              {name}, k = {k} {UNITS.conductivity}
            </option>
          ))}
        </select>
      </label>
      <div className="sides">
        {side('left', 'Left edge')}
        {side('right', 'Right edge')}
        {side('bottom', 'Bottom edge')}
        {side('top', 'Top edge')}
      </div>
      {field ? <Field field={field} /> : <p>Solving…</p>}
      {reused && <p className="reuse">{reused}</p>}
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
