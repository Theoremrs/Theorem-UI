// SOURCING: the terminal crate's mount_cabinet (Ratatui on Ratzilla) draws
// the cabinet and allocates its rectangles inside the right-hand host
// (terminal/side-terminal); canvas 2D paints previews on those rectangles;
// real buttons, an input and a select sit over the drawn controls so the
// gallery is operable and named; ui/dialog (Base UI Dialog) shows an
// original; components/artifacts' ArtifactView renders an artifact revision.
// The controller, the overlay and the original view are shared with the
// workbench's Artifacts panel (workbench-cabinet.tsx).
//
// The artifact cabinet's browser host (SPEC-THEOREM-ARTIFACT-CABINET-1.0 §8):
// React owns the catalog and the preference, Ratatui owns layout, selection
// and scroll, and this host lays inert pictures and semantic controls exactly
// over what Ratatui drew. It replaces the outputs drawer: one collection
// browser.
import { useEffect, useRef, useState } from 'react'
import { loadWasm } from '@/components/terminal/terminal-screen'
import { useOrganization } from '@/lib/theorem/organization'
import { useGalleryProject } from './gallery-project'
import type { CabinetHandle } from '@/terminal-wasm/theorem_terminal'
import { CabinetOverlay, cellOf, useScrollGestures } from './cabinet-overlay'
import type { Geometry } from './cabinet-overlay'
import { useCabinetController } from './use-cabinet-controller'
import type { CabinetAction } from './use-cabinet-controller'
import '../terminal/cell-grid.css'

const HOST_ID = 'theorem-artifact-cabinet'

/** One cabinet mount per host element; frames stop when it leaves the page. */
const mounts = new WeakMap<HTMLElement, Promise<CabinetHandle | undefined>>()

/** The gallery for one project: catalog, Ratatui view, previews, controls. */
export function Cabinet({
  projectId,
  projectTitle,
  expanded = false,
}: {
  projectId: string
  projectTitle: string
  expanded?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const [handle, setHandle] = useState<CabinetHandle>()
  const [geometry, setGeometry] = useState<Geometry>()
  const controller = useCabinetController({
    projectId,
    projectTitle,
    expanded,
    surface: handle,
    geometry,
  })

  useEffect(() => {
    const element = host.current
    if (!element) return
    let live = true
    let mount = mounts.get(element)
    if (!mount) {
      mount = loadWasm().then((wasm) => {
        // The project may have changed while the module loaded: a host that
        // left the page must not mount into its successor's element.
        if (
          !element.isConnected ||
          document.getElementById(HOST_ID) !== element
        )
          return undefined
        return wasm.mount_cabinet(
          HOST_ID,
          (json: string) =>
            controller.actions.current(JSON.parse(json) as CabinetAction),
          (json: string) =>
            setGeometry((JSON.parse(json) as { geometry: Geometry }).geometry),
        )
      })
      mounts.set(element, mount)
    }
    void mount.then((h) => live && setHandle(h))
    return () => {
      live = false
    }
    // The mount hears actions through the controller's ref, which is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const cell = cellOf(geometry)
  // The host's tab strip starts its first label on the gallery's content
  // inset (the grid's PAD_PX rounded to whole cells), so tab and content
  // share one start edge at any text size.
  useEffect(() => {
    const drawer = host.current?.closest<HTMLElement>('[data-cabinet-layout]')
    if (!drawer || !geometry) return
    const cw = geometry.cell[0]
    const inset = Math.max(1, Math.round(20 / cw)) * cw
    drawer.style.setProperty('--gallery-inset', `${inset}px`)
  }, [geometry])

  // A vertical swipe scrolls the drawn gallery a row at a time.
  const gestures = useScrollGestures(handle, cell[1])

  // Ratzilla measures its cell only on a window resize, so a change of text
  // size (browser setting, 200% zoom of text) is passed on as one (§9).
  const probe = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const element = probe.current
    if (!element) return
    let last = ''
    const observer = new ResizeObserver(() => {
      const size = `${element.offsetWidth}x${element.offsetHeight}`
      if (last && size !== last) window.dispatchEvent(new Event('resize'))
      last = size
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div
      data-artifact-cabinet=""
      className="relative min-h-0 flex-1 overflow-hidden bg-term font-mono text-[0.78125rem] text-term-ink"
      {...gestures}
      style={{ touchAction: 'pinch-zoom' }}
    >
      <span
        ref={probe}
        aria-hidden="true"
        className="pointer-events-none invisible absolute h-[1em] w-[1ch]"
      />
      <div
        id={HOST_ID}
        ref={host}
        aria-hidden="true"
        className="absolute inset-0 whitespace-pre"
      />
      <CabinetOverlay
        controller={controller}
        geometry={geometry}
        surface={handle}
      />
    </div>
  )
}

/**
 * The cabinet view of the right-hand host: the open project's outputs from
 * every session. In a chat it shows the chat's project; outside any project
 * it says so.
 */
export function CabinetView({ expanded = false }: { expanded?: boolean }) {
  const { data: organization } = useOrganization()
  const projectId = useGalleryProject()
  const project = organization?.projects.find((p) => p.projectId === projectId)
  return projectId ? (
    <Cabinet
      key={projectId}
      projectId={projectId}
      projectTitle={project?.title ?? 'This project'}
      expanded={expanded}
    />
  ) : (
    <p className="p-5 font-mono text-[0.78125rem] text-term-muted">
      Open a project to browse what its sessions made.
    </p>
  )
}
