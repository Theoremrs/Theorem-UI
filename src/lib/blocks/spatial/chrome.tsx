// SOURCING: @theorem/annotate places every label and note over the scene
// (Floating UI's math, one positioning owner); Astryx (`@astryxdesign/core`)
// draws every control: Breadcrumbs, Button, ToggleButton, Switch, Slider,
// NumberInput, SegmentedControl, Selector, Text. What is ours is which tier a
// part shows: its name and the values that matter at rest, a short
// explanation on hover or focus, its controls when it is clicked, and a pin
// that keeps them out.
//
// An App can pass its own chrome to `mount` (`chrome: MyChrome`) and compose
// these pieces or write new ones: a ChromeProps is everything the view knows.
import { Breadcrumbs, BreadcrumbItem } from '@astryxdesign/core/Breadcrumbs'
import { Button } from '@astryxdesign/core/Button'
import { NumberInput } from '@astryxdesign/core/NumberInput'
import { SegmentedControl, SegmentedControlItem } from '@astryxdesign/core/SegmentedControl'
import { Selector } from '@astryxdesign/core/Selector'
import { Slider } from '@astryxdesign/core/Slider'
import { Switch } from '@astryxdesign/core/Switch'
import { Text } from '@astryxdesign/core/Text'
import { ToggleButton, ToggleButtonGroup } from '@astryxdesign/core/ToggleButton'
import { Annotation, AnnotationLayer, KeepClear, Label, Note, Theme } from '@theorem/annotate'
import type { Anchors } from '@theorem/annotate'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ControlSpec } from './engine'
import './chrome.css'

export interface PortSnapshot {
  name: string
  label: string
  dir: 'in' | 'out'
  value: unknown
  /** The value as the part formats it. */
  text: string
  /** An input no wire reaches, which the person sets. */
  editable: boolean
  control?: ControlSpec
  /** Changed by the change now travelling the model. */
  changed: boolean
  on: boolean
}

export interface StateSnapshot {
  name: string
  value: unknown
  text: string
  control?: ControlSpec
}

export interface PartSnapshot {
  path: string
  label: string
  about?: string
  openable: boolean
  pulled: boolean
  ports: Array<PortSnapshot>
  state: Array<StateSnapshot>
  /** Changed by the change now travelling the model. */
  changed: boolean
  /** What its label says at rest: the values that matter now. */
  summary: Array<string>
}

export interface ChromeSnapshot {
  title: string
  /** From the whole model down to the open part. */
  trail: Array<{ path: string; label: string }>
  open: string
  selected: string | null
  hovered: string | null
  pinned: Array<string>
  /** Where the person dragged a pinned note: its top left from its part's centre, in pixels. */
  placed: Record<string, [number, number]>
  /** The parts of the open network. */
  parts: Array<PartSnapshot>
  /** The open part itself, whose ports are the open network's boundary. */
  boundary: PartSnapshot | null
  replay: { active: boolean; stage: number; end: number; paused: boolean }
  running: boolean
  slow: boolean
  ticking: boolean
  /** Too narrow to hold a note beside a part: controls go below the scene. */
  narrow: boolean
}

export interface ChromeActions {
  set: (path: string, key: string, value: unknown) => void
  step: () => void
  open: (path: string) => void
  select: (path: string | null) => void
  hover: (path: string | null) => void
  pin: (path: string, pinned: boolean) => void
  /** Keeps a pinned note where the person dragged it. */
  place: (path: string, offset: [number, number]) => void
  putBack: (path: string) => void
  run: (on: boolean) => void
  slow: (on: boolean) => void
  pause: (on: boolean) => void
}

export interface ChromeProps {
  snapshot: ChromeSnapshot
  actions: ChromeActions
  /** Where each part (`part:<path>`) and port (`port:<path>:<name>`) is on screen now. */
  anchors: Anchors
  /** The element the scene is drawn in; notes and the breadcrumb go over it. */
  stage: HTMLElement
}

/** Where a leader enters a part's note: level with its title. */
const NOTE_ATTACH = 17

/** The anchor id the view writes a part's screen box under. */
export const partAnchor = (path: string) => `part:${path}`
/** The anchor id the view writes a port's screen point under. */
export const portAnchor = (path: string, port: string) => `port:${path}:${port}`

const truthy = (value: unknown) =>
  typeof value === 'number' ? value !== 0 : typeof value === 'boolean' ? value : value != null && value !== ''
const isBit = (value: unknown) => value === 0 || value === 1 || typeof value === 'boolean'

/** The Astryx control that sets a value, chosen by its ControlSpec, or by the value when there is none. */
export function Control({ path, name, value, spec, set }: {
  path: string
  name: string
  value: unknown
  spec?: ControlSpec
  set: ChromeActions['set']
}) {
  const label = `${spec?.label ?? name} of ${path}`
  // A toggle that names what each setting does is two labelled choices, so it says it.
  if (spec?.kind === 'toggle' && spec.off !== undefined && spec.on !== undefined)
    return (
      <SegmentedControl
        label={label}
        size="sm"
        value={truthy(value) ? 'on' : 'off'}
        onChange={(next: string) => set(path, name, typeof value === 'boolean' ? next === 'on' : next === 'on' ? 1 : 0)}
      >
        <SegmentedControlItem value="off" label={spec.off} />
        <SegmentedControlItem value="on" label={spec.on} />
      </SegmentedControl>
    )
  if (spec?.kind === 'toggle' || (!spec && isBit(value)))
    return (
      <Switch
        label={label}
        isLabelHidden
        size="sm"
        value={truthy(value)}
        onChange={(checked) => set(path, name, typeof value === 'boolean' ? checked : checked ? 1 : 0)}
      />
    )
  if (spec?.kind === 'bits') {
    const bits = Array.from({ length: spec.bits }, (_, index) => spec.bits - 1 - index)
    const on = bits.filter((bit) => (Number(value) >> bit) & 1).map(String)
    return (
      <ToggleButtonGroup
        type="multiple"
        className="ts-bits"
        label={label}
        size="sm"
        value={on}
        onChange={(next) => set(path, name, next.reduce((sum, bit) => sum | (1 << Number(bit)), 0))}
      >
        {bits.map((bit) => (
          <ToggleButton key={bit} value={String(bit)} className="ts-bit" label={`bit ${bit} of ${name}`}>
            {on.includes(String(bit)) ? '1' : '0'}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    )
  }
  if (spec?.kind === 'select')
    return spec.options.length <= 4 ? (
      <SegmentedControl label={label} size="sm" value={String(value)} onChange={(next: string) => set(path, name, next)}>
        {spec.options.map((option, index) => (
          <SegmentedControlItem key={option} value={option} label={spec.labels?.[index] ?? option} />
        ))}
      </SegmentedControl>
    ) : (
      <Selector
        label={label}
        isLabelHidden
        size="sm"
        options={spec.options.map((option, index) => ({ value: option, label: spec.labels?.[index] ?? option }))}
        value={String(value)}
        onChange={(next: string | null) => next !== null && set(path, name, next)}
      />
    )
  if (spec?.kind === 'range')
    return (
      <Slider
        label={label}
        isLabelHidden
        min={spec.min}
        max={spec.max}
        step={spec.step ?? 1}
        value={Number(value ?? spec.min)}
        valueDisplay="text"
        onChange={(next: number) => set(path, name, next)}
      />
    )
  return (
    <NumberInput
      label={label}
      isLabelHidden
      size="sm"
      min={spec && 'min' in spec ? spec.min : undefined}
      max={spec && 'max' in spec ? spec.max : undefined}
      step={spec && 'step' in spec ? spec.step : undefined}
      value={Number(value ?? 0)}
      onChange={(next: number | null) => next !== null && set(path, name, next)}
    />
  )
}

/** A name and its value or control, in a note's rows. */
function Row({ name, children, tone = 'normal' }: { name: ReactNode; children: ReactNode; tone?: 'normal' | 'quiet' | 'on' }) {
  return (
    <div className="ts-row" data-tone={tone}>
      <Text size="sm" color="secondary">{name}</Text>
      <div className="ts-row-value">{children}</div>
    </div>
  )
}

/** A control whose choices are named (Add / AND) says what it does: it needs no name beside it. */
const speaksForItself = (spec?: ControlSpec) =>
  (spec?.kind === 'toggle' && spec.off !== undefined && spec.on !== undefined) || (spec?.kind === 'select' && spec.labels !== undefined)

/** A setting the person changes: its control on its own line when it names its choices, else in a row. */
function Setting({ path, name, label, value, spec, set }: { path: string; name: string; label: string; value: unknown; spec?: ControlSpec; set: ChromeActions['set'] }) {
  const control = <Control path={path} name={name} value={value} spec={spec} set={set} />
  return speaksForItself(spec) ? <div className="ts-row-wide">{control}</div> : <Row name={label}>{control}</Row>
}

/**
 * What a clicked part offers: the inputs the person sets, with controls,
 * first; then what reaches it by wire and what it shows, in that order, so
 * the rows read from cause to effect.
 */
export function PartControls({ part, actions }: { part: PartSnapshot; actions: ChromeActions }) {
  const set = part.ports.filter((port) => port.dir === 'in' && port.editable)
  const shows = part.ports.filter((port) => port.dir === 'out')
  const receives = part.ports.filter((port) => port.dir === 'in' && !port.editable)
  const value = (port: PortSnapshot) => (
    <Text size="sm" hasTabularNumbers color={port.on ? 'accent' : 'primary'}>{port.text}</Text>
  )
  return (
    <>
      {(set.length > 0 || part.state.some((entry) => entry.control)) && (
        <div className="ts-rows">
          {set.map((port) => (
            <Setting key={port.name} path={part.path} name={port.name} label={port.label} value={port.value} spec={port.control} set={actions.set} />
          ))}
          {part.state.filter((entry) => entry.control).map((entry) => (
            <Setting key={entry.name} path={part.path} name={entry.name} label={entry.name} value={entry.value} spec={entry.control} set={actions.set} />
          ))}
        </div>
      )}
      {(receives.length > 0 || shows.length > 0 || part.state.some((entry) => !entry.control)) && (
        <div className="ts-rows">
          {receives.map((port) => (
            <Row key={port.name} name={port.label}>{value(port)}</Row>
          ))}
          {shows.map((port) => (
            <Row key={port.name} name={port.label} tone={port.changed ? 'on' : 'normal'}>{value(port)}</Row>
          ))}
          {part.state.filter((entry) => !entry.control).map((entry) => (
            <Row key={entry.name} name={entry.name}>
              <Text size="sm" hasTabularNumbers>{entry.text}</Text>
            </Row>
          ))}
        </div>
      )}
      {(part.openable || part.pulled) && (
        <div className="ts-actions">
          {part.openable && <Button label="Open" size="sm" variant="ghost" onClick={() => actions.open(part.path)} />}
          {part.pulled && <Button label="Put back" size="sm" variant="ghost" onClick={() => actions.putBack(part.path)} />}
        </div>
      )}
    </>
  )
}

/**
 * The note a clicked or pinned part shows beside itself: its inputs, outputs
 * and controls, and, expanded, the `dossier` (an explanation, a conversation,
 * history: whatever the chrome puts there).
 */
export function PartNote({ part, pinned, actions, dossier }: { part: PartSnapshot; pinned: boolean; actions: ChromeActions; dossier?: ReactNode }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <Note
      title={part.label}
      detail={part.about}
      showDetail
      pinned={pinned}
      onPinnedChange={(next) => actions.pin(part.path, next)}
      onClose={() => (pinned ? actions.pin(part.path, false) : actions.select(null))}
      expanded={expanded}
      onExpandedChange={dossier === undefined ? undefined : setExpanded}
    >
      <PartControls part={part} actions={actions} />
      {expanded && dossier !== undefined && <div className="ts-dossier">{dossier}</div>}
    </Note>
  )
}

/** Where the person is, shown once they are inside a part. */
export function Trail({ snapshot, actions }: Pick<ChromeProps, 'snapshot' | 'actions'>) {
  if (!snapshot.open) return null
  return (
    <div className="ts-crumbs">
      <Breadcrumbs label="Where you are in the model">
        {snapshot.trail.map((step, index) => {
          const last = index === snapshot.trail.length - 1
          return (
            <BreadcrumbItem key={step.path || 'model'} isCurrent={last} onClick={last ? undefined : () => actions.open(step.path)}>
              {step.label}
            </BreadcrumbItem>
          )
        })}
      </Breadcrumbs>
    </div>
  )
}

/** What the person can do next, from where they are. */
export function hintFor(snapshot: ChromeSnapshot): string {
  const selected = snapshot.parts.find((part) => part.path === snapshot.selected)
  if (selected)
    return [
      selected.pulled ? 'Esc puts it back' : 'Drag it to pull it out',
      selected.openable ? 'double-click to open' : '',
      selected.pulled ? '' : 'Esc to let go',
    ].filter(Boolean).join(' · ')
  if (snapshot.open) return 'Esc or double-click empty space to go back up'
  return 'Click a part to inspect it · drag to pull it out · double-click to open'
}

/** Step, run, slow and the stage a change has reached, below the scene. */
export function PlaybackStrip({ snapshot, actions }: Pick<ChromeProps, 'snapshot' | 'actions'>) {
  const { replay } = snapshot
  return (
    <div className="ts-bar" role="toolbar" aria-label="Playback">
      {snapshot.ticking && <Button label="Step" size="sm" variant="secondary" onClick={actions.step} />}
      {snapshot.ticking && <ToggleButton label="Run" size="sm" isPressed={snapshot.running} onPressedChange={(on) => actions.run(on)} />}
      <ToggleButton label="Slow" size="sm" isPressed={snapshot.slow} onPressedChange={(on) => actions.slow(on)} />
      {replay.active && (
        <Button label={replay.paused ? 'Continue' : 'Pause'} size="sm" variant="ghost" onClick={() => actions.pause(!replay.paused)} />
      )}
      {replay.active && (
        <Text size="sm" color="secondary" hasTabularNumbers>
          {`stage ${replay.stage} of ${replay.end}`}
        </Text>
      )}
      <span className="ts-hint">
        <Text size="sm" color="disabled">{hintFor(snapshot)}</Text>
      </span>
    </div>
  )
}

/** One part over the scene, at the tier where the person has it. */
export function PartAnnotation({ part, snapshot, actions, dossier }: {
  part: PartSnapshot
  snapshot: ChromeSnapshot
  actions: ChromeActions
  /** What the note shows expanded, for a part; without it the note does not expand. */
  dossier?: (part: PartSnapshot) => ReactNode
}) {
  const pinned = snapshot.pinned.includes(part.path)
  const selected = snapshot.selected === part.path
  const entity = { 'data-entity-id': part.path, 'data-entity-label': `${part.label} (${part.path})` }
  const handlers = {
    onClick: () => actions.select(part.path),
    onPointerEnter: () => actions.hover(part.path),
    onPointerLeave: () => actions.hover(null),
    onFocus: () => actions.hover(part.path),
    onBlur: () => actions.hover(null),
  }
  if ((selected && !snapshot.narrow) || pinned)
    return (
      <Annotation
        // A note is placed afresh, not where the label it grew from sat.
        key="note"
        anchor={partAnchor(part.path)}
        className="ts-card"
        subject="bracket"
        connector="leader"
        attach={NOTE_ATTACH}
        gap={36}
        padding={8}
        priority={pinned ? 30 : 40}
        pinned={pinned}
        offset={snapshot.placed[part.path]}
        onPlace={(offset) => actions.place(part.path, offset)}
        {...entity}
      >
        <PartNote part={part} pinned={pinned} actions={actions} dossier={dossier?.(part)} />
      </Annotation>
    )
  // At rest a name and its one value that matters, on a rule a leader runs
  // into; hovered or focused the same label with its explanation and the
  // part bracketed, so keyboard focus stays on it and Enter selects it.
  const near = snapshot.hovered === part.path && !selected
  const quiet = snapshot.selected !== null && !selected
  return (
    <Annotation
      key="label"
      anchor={partAnchor(part.path)}
      subject={near ? 'bracket' : 'none'}
      connector="leader"
      gap={near ? 28 : 24}
      padding={near ? 8 : 2}
      priority={near ? 20 : selected ? 15 : part.changed ? 2 : 1}
      yields={!near}
      {...entity}
    >
      <Label
        name={part.label}
        values={quiet ? [] : part.summary.slice(0, 1)}
        detail={near ? part.about : undefined}
        emphasis={selected ? 'strong' : quiet && !near ? 'quiet' : 'normal'}
        aria-pressed={selected}
        {...handlers}
      />
    </Annotation>
  )
}

/** A port's name and value beside it, for the part in hand and the open part's boundary. */
export function PortTag({ part, port }: { part: PartSnapshot; port: PortSnapshot }) {
  return (
    <Annotation
      anchor={portAnchor(part.path, port.name)}
      placements={port.dir === 'in' ? ['left', 'left-start', 'left-end'] : ['right', 'right-start', 'right-end']}
      connector="none"
      gap={6}
      priority={port.editable || port.changed ? 4 : 0}
      yields
    >
      <span className="ts-port" data-on={port.on || undefined} data-editable={port.editable || undefined} data-changed={port.changed || undefined}>
        {port.label} <b>{port.text}</b>
      </span>
    </Annotation>
  )
}

/** The view's own chrome. */
export function SpatialChrome({ snapshot, actions, anchors, stage }: ChromeProps) {
  const inHand = snapshot.parts.filter((part) => part.path === snapshot.selected || part.pulled)
  const docked = snapshot.narrow ? snapshot.parts.find((part) => part.path === snapshot.selected) : undefined
  return (
    <Theme className="ts-chrome">
      {createPortal(
        <AnnotationLayer anchors={anchors}>
          <KeepClear className="ts-crumbs-slot">
            <Trail snapshot={snapshot} actions={actions} />
          </KeepClear>
          {snapshot.parts.map((part) => (
            <PartAnnotation key={part.path} part={part} snapshot={snapshot} actions={actions} />
          ))}
          {inHand.flatMap((part) => part.ports.map((port) => <PortTag key={`${part.path}:${port.name}`} part={part} port={port} />))}
          {snapshot.boundary?.ports.map((port) => (
            <PortTag key={`boundary:${port.name}`} part={snapshot.boundary!} port={port} />
          ))}
        </AnnotationLayer>,
        stage,
      )}
      <PlaybackStrip snapshot={snapshot} actions={actions} />
      {docked && (
        <div className="ts-dock ts-card" data-entity-id={docked.path} data-entity-label={`${docked.label} (${docked.path})`}>
          <PartNote part={docked} pinned={false} actions={actions} />
        </div>
      )}
    </Theme>
  )
}
