// SOURCING: the terminal crate's cabinet panel (terminal/src/cabinet_panel.rs)
// draws the cabinet inside the workbench's grid and reports where its previews
// and controls sit; this lays the same canvases and real controls over those
// rectangles with the same controller, overlay and original view as the
// mounted cabinet (cabinet-view.tsx). React's createPortal puts them in an
// element the page owns, over the grid.
//
// Workbench spec section 12: the cabinet is a tool panel that uses the same
// project and artifact owners, settings, preview generation and revision
// identity. This is not another artifact list.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CabinetOverlay, cellOf, useScrollGestures } from './cabinet-overlay'
import type { Geometry } from './cabinet-overlay'
import { useCabinetController } from './use-cabinet-controller'
import type {
  CabinetAction,
  CabinetInitial,
  CabinetSurface,
} from './use-cabinet-controller'

/**
 * What the workbench handle gives the Artifacts panel's page side. Each
 * method is a thin export of the terminal crate's `CabinetLink`; this file
 * does not import the mount.
 */
export interface WorkbenchCabinetHost {
  /** The controller's `CabinetView` JSON for a project. Throws if unreadable. */
  cabinet_set_view: (project: string, json: string) => void
  /**
   * The published geometry as JSON `{epoch, panel, project, view, geometry}`,
   * or nothing while `since` is still the latest epoch. `geometry` is null
   * when no cabinet is on screen. Cells are the workbench grid's.
   */
  cabinet_geometry: (since: number) => string | undefined | null
  /** The actions the panel's keys and pointer produced: a JSON array. */
  cabinet_actions: () => string
  /** `{type: 'select' | 'scroll' | 'key', ...}` for the cabinet on screen. */
  cabinet_command: (json: string) => boolean
}

type Published = {
  epoch: number
  project: string | null
  view: CabinetInitial | null
  geometry: Geometry | null
}

/**
 * Follows what the Artifacts panel reports and, while one is on screen, runs
 * the cabinet controller for the project over it. Render it once, beside the
 * grid; it renders nothing while no Artifacts panel is drawn.
 *
 * `overlay` is an element the page owns, positioned (`relative`) with its top
 * left corner on the grid's first cell and outside the grid host, whose
 * contents the terminal replaces and whose pointer handlers take focus.
 */
export function WorkbenchCabinet({
  host,
  overlay,
  projectId,
  projectTitle,
  expanded = false,
}: {
  host: WorkbenchCabinetHost
  overlay: HTMLElement | null
  projectId: string
  projectTitle: string
  expanded?: boolean
}) {
  const [published, setPublished] = useState<Published>()
  const sink = useRef<((action: CabinetAction) => void) | undefined>(undefined)
  const listen = useCallback(
    (fn: ((action: CabinetAction) => void) | undefined) => {
      sink.current = fn
    },
    [],
  )

  // The panel's geometry changes at most once a frame; the epoch says whether
  // it did. Actions are drained on the same tick, while a controller listens.
  useEffect(() => {
    let epoch = 0
    let frame = 0
    const tick = () => {
      const json = host.cabinet_geometry(epoch)
      if (json) {
        const next = JSON.parse(json) as Published
        epoch = next.epoch
        setPublished(next)
      }
      if (sink.current) {
        const actions = JSON.parse(host.cabinet_actions()) as CabinetAction[]
        for (const action of actions) sink.current(action)
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [host])

  if (!overlay || !published?.geometry) return null
  return createPortal(
    <Layer
      // A new project starts a new controller.
      key={projectId}
      host={host}
      geometry={published.geometry}
      initial={published.view ?? undefined}
      projectId={projectId}
      projectTitle={projectTitle}
      expanded={expanded}
      listen={listen}
    />,
    overlay,
  )
}

function Layer({
  host,
  geometry,
  initial,
  projectId,
  projectTitle,
  expanded,
  listen,
}: {
  host: WorkbenchCabinetHost
  geometry: Geometry
  initial: CabinetInitial | undefined
  projectId: string
  projectTitle: string
  expanded: boolean
  listen: (fn: ((action: CabinetAction) => void) | undefined) => void
}) {
  const surface = useMemo<CabinetSurface>(
    () => ({
      set_view: (json) => host.cabinet_set_view(projectId, json),
      key: (event) =>
        host.cabinet_command(
          JSON.stringify({
            type: 'key',
            key: event.key,
            ctrl: event.ctrlKey,
            alt: event.altKey,
            shift: event.shiftKey,
          }),
        ),
      select: (key) =>
        void host.cabinet_command(JSON.stringify({ type: 'select', key })),
      scroll: (rows) =>
        void host.cabinet_command(JSON.stringify({ type: 'scroll', rows })),
    }),
    [host, projectId],
  )
  const controller = useCabinetController({
    projectId,
    projectTitle,
    expanded,
    surface,
    geometry,
    initial,
  })
  useEffect(() => {
    listen((action) => controller.actions.current(action))
    return () => listen(undefined)
  }, [listen, controller.actions])
  const gestures = useScrollGestures(surface, cellOf(geometry)[1])
  return (
    // A zero-size anchor at the grid's corner: its children are positioned in
    // the grid's cells and nothing of it takes the grid's pointer. Keys typed
    // in its controls belong to them, not to the workbench behind.
    <div
      data-workbench-cabinet=""
      className="absolute top-0 left-0 size-0 font-mono text-[0.78125rem] text-term-ink"
      onKeyDown={(event) => event.stopPropagation()}
      {...gestures}
    >
      <CabinetOverlay
        controller={controller}
        geometry={geometry}
        surface={surface}
      />
    </div>
  )
}
