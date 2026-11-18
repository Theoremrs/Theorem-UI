// The reservation App's presentation: book, edit and cancel equipment, see
// why a booking conflicts, undo and redo from the keyboard. The bookings are
// kept in the App's `reservations` state, so a reload or a new presentation
// revision finds them as they were. Each accepted change is computed by the
// `apply` operation and kept as a result, so the evidence of what was done
// outlives this revision.
import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent } from 'react'
import { Operations, canonicalJson, digestOf } from '@theorem/runtime'
import type { ArtifactSourceRef } from '@theorem/runtime'
import { History, RULES, apply, instant } from './rules'
import type { Command, Outcome, Reservation } from './rules'
import { explain } from './refusal'
import type { Explanation } from './refusal'
import './look.css'

const EQUIPMENT = ['Microscope A', 'Microscope B', 'Centrifuge', '3D printer']

/** The zone times are shown and entered in: the person's own. Bookings are instants. */
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

const shown = new Intl.DateTimeFormat(undefined, {
  timeZone: zone,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

/** A `datetime-local` value, read in the person's zone, as an instant with its offset. */
function fromLocal(value: string): string {
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? '' : at.toISOString()
}

function toLocal(utc: string): string {
  const at = new Date(utc)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

const readBookings = (value: unknown): Array<Reservation> =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Reservation =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as Reservation).id === 'string' &&
          instant(String((item as Reservation).start)) !== undefined &&
          instant(String((item as Reservation).end)) !== undefined,
      )
    : []

async function operationsFor(source: ArtifactSourceRef) {
  const operations = new Operations({ source })
  operations.define({
    name: 'apply',
    version: RULES.version,
    summary:
      'Apply one booking command to the bookings, under the reservation rules',
    input: { bookings: 'Array<Reservation>', command: 'Command' },
    output: 'Outcome',
    reproducibility: 'deterministic',
    recovery: ['rerun'],
    // The rules are what an outcome depends on; a presentation revision is not.
    implementation: await digestOf(RULES),
    examples: [
      {
        input:
          'A 09:30–10:30 booking against 09:00–10:00 on the same microscope',
        output: 'Refused: conflict',
      },
    ],
    run: ({
      bookings,
      command,
    }: {
      bookings: Array<Reservation>
      command: Command
    }) => apply(bookings, command),
  })
  return operations
}

function App() {
  const history = useRef(new History())
  const [bookings, setBookings] = useState<Array<Reservation>>([])
  const [ready, setReady] = useState(false)
  const [explanation, setExplanation] = useState<Explanation | null>(null)
  const [editing, setEditing] = useState<Reservation | null>(null)
  const [can, setCan] = useState({ undo: false, redo: false })
  const [evidence, setEvidence] = useState<Array<string>>([])
  const operations = useRef<Operations | null>(null)
  const store = useRef<Awaited<ReturnType<typeof theorem.state>> | null>(null)

  useEffect(() => {
    let stop = () => {}
    void (async () => {
      await theorem.ready
      const state = await theorem.state('reservations')
      store.current = state
      history.current = new History(readBookings(state.get('bookings')))
      setBookings(history.current.current)
      setEvidence((state.get('evidence') as Array<string> | undefined) ?? [])
      stop = state.subscribe(() => {
        // Another view of this App changed the bookings: follow it.
        const now = readBookings(state.get('bookings'))
        if (canonicalJson(now) !== canonicalJson(history.current.current)) {
          history.current = new History(now)
          setBookings(now)
          setCan({ undo: false, redo: false })
        }
      })
      try {
        operations.current = await operationsFor(
          (await theorem.artifacts.source()) as ArtifactSourceRef,
        )
      } catch {
        // No backend keeps results here; the App still works, without evidence.
      }
      setReady(true)
    })()
    return () => stop()
  }, [])

  async function keep(next: Array<Reservation>) {
    setCan({ undo: history.current.canUndo, redo: history.current.canRedo })
    setBookings(next)
    await store.current?.set('bookings', next)
  }

  async function run(command: Command): Promise<Outcome> {
    const before = history.current.current
    const outcome = history.current.run(command)
    if (!outcome.ok) {
      setExplanation(
        explain(
          outcome.refusal,
          command.kind === 'cancel' ? undefined : command.reservation,
        ),
      )
      return outcome
    }
    setExplanation(null)
    await keep(history.current.current)
    const done = await operations.current
      ?.invoke('apply', { bookings: before, command })
      .catch(() => undefined)
    if (done) {
      const bytes = new TextEncoder().encode(canonicalJson(done.output))
      const kept = await theorem.artifacts
        .result(done.result, bytes)
        .catch(() => undefined)
      if (kept) {
        const held =
          (store.current?.get('evidence') as Array<string> | undefined) ?? []
        const next = [...held, kept.id].slice(-200)
        setEvidence(next)
        await store.current?.set('evidence', next)
      }
    }
    return outcome
  }

  async function undo() {
    if (history.current.undo()) await keep(history.current.current)
  }

  async function redo() {
    if (history.current.redo()) await keep(history.current.current)
  }

  function onKeyDown(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey
    if (!mod || event.key.toLowerCase() !== 'z') return
    const target = event.target as HTMLElement
    // A text field's own undo stays the field's.
    if (
      target.tagName === 'INPUT' &&
      (target as HTMLInputElement).type === 'text'
    )
      return
    event.preventDefault()
    void (event.shiftKey ? redo() : undo())
  }

  const byResource = useMemo(
    () =>
      EQUIPMENT.map((resource) => ({
        resource,
        items: bookings.filter((item) => item.resource === resource),
      })),
    [bookings],
  )

  return (
    <main onKeyDown={onKeyDown}>
      <header>
        <h1>Equipment bookings</h1>
        <p className="zone">Times are shown in {zone}.</p>
        <div className="history" role="group" aria-label="History">
          <button
            type="button"
            onClick={() => void undo()}
            disabled={!can.undo}
          >
            Undo <kbd>Ctrl Z</kbd>
          </button>
          <button
            type="button"
            onClick={() => void redo()}
            disabled={!can.redo}
          >
            Redo <kbd>Ctrl Shift Z</kbd>
          </button>
        </div>
      </header>
      <BookingForm
        key={editing?.id ?? 'new'}
        editing={editing}
        disabled={!ready}
        onSubmit={async (reservation) => {
          const outcome = await run(
            editing
              ? { kind: 'edit', reservation }
              : { kind: 'create', reservation },
          )
          if (outcome.ok) setEditing(null)
          return outcome.ok
        }}
        onCancelEdit={() => setEditing(null)}
      />
      {explanation && <Refused explanation={explanation} />}
      {byResource.map(({ resource, items }) => (
        <section key={resource} aria-labelledby={`r-${resource}`}>
          <h2 id={`r-${resource}`}>{resource}</h2>
          {items.length === 0 ? (
            <p className="empty">No bookings.</p>
          ) : (
            <ul>
              {items.map((item) => (
                <li
                  key={item.id}
                  data-row-id={item.id}
                  data-entity-id={item.id}
                  data-entity-label={`${item.holder}, ${resource}`}
                >
                  <span>
                    {shown.format(new Date(item.start))} to{' '}
                    {shown.format(new Date(item.end))}
                  </span>
                  <span className="holder">{item.holder}</span>
                  <button type="button" onClick={() => setEditing(item)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void run({ kind: 'cancel', id: item.id })}
                  >
                    Cancel booking
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
      <footer>{evidence.length} changes kept as evidence.</footer>
    </main>
  )
}

function Refused({ explanation }: { explanation: Explanation }) {
  return (
    <div role="alert" className="refused">
      <p>{explanation.headline}</p>
      {explanation.clashes.length > 0 && (
        <ul>
          {explanation.clashes.map((clash) => (
            <li key={clash.id}>
              {clash.holder} has it from {shown.format(new Date(clash.from))} to{' '}
              {shown.format(new Date(clash.to))}.
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function BookingForm(props: {
  editing: Reservation | null
  disabled: boolean
  onSubmit: (reservation: Reservation) => Promise<boolean>
  onCancelEdit: () => void
}) {
  const { editing } = props
  const [resource, setResource] = useState(editing?.resource ?? EQUIPMENT[0]!)
  const [holder, setHolder] = useState(editing?.holder ?? '')
  const [start, setStart] = useState(editing ? toLocal(editing.start) : '')
  const [end, setEnd] = useState(editing ? toLocal(editing.end) : '')

  async function submit(event: FormEvent) {
    event.preventDefault()
    const ok = await props.onSubmit({
      id: editing?.id ?? crypto.randomUUID(),
      resource,
      holder: holder.trim() || 'Unnamed',
      start: fromLocal(start),
      end: fromLocal(end),
    })
    if (ok && !editing) {
      setStart('')
      setEnd('')
    }
  }

  return (
    <form
      onSubmit={(event) => void submit(event)}
      aria-label={editing ? 'Edit booking' : 'New booking'}
    >
      <label>
        Equipment
        <select
          value={resource}
          onChange={(event) => setResource(event.target.value)}
        >
          {EQUIPMENT.map((item) => (
            <option key={item}>{item}</option>
          ))}
        </select>
      </label>
      <label>
        Who
        <input
          type="text"
          value={holder}
          onChange={(event) => setHolder(event.target.value)}
        />
      </label>
      <label>
        From
        <input
          type="datetime-local"
          required
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </label>
      <label>
        Until
        <input
          type="datetime-local"
          required
          value={end}
          onChange={(event) => setEnd(event.target.value)}
        />
      </label>
      <button type="submit" disabled={props.disabled}>
        {editing ? 'Save' : 'Book'}
      </button>
      {editing && (
        <button type="button" onClick={props.onCancelEdit}>
          Stop editing
        </button>
      )}
    </form>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
