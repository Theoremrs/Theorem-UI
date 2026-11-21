// SOURCING: @rerun-io/web-viewer 0.35.0 (WebViewer, LogChannel), the version
// theorem-proto-emit's Rerun SDK is pinned to. Its WebAssembly is loaded from
// Rerun's own hosting (app.rerun.io). The recording is written by Rerun's Rust SDK behind
// `theorem.trace.recording`; this module only feeds and follows the viewer.

import { WebViewer } from '@rerun-io/web-viewer'
import type { LogChannel } from '@rerun-io/web-viewer'
import type { TraceFrame } from './trace'
import type { SpatialModel } from './view'

/** Where Rerun hosts the viewer this library is built against. */
export const RERUN_VIEWER_BASE = 'https://app.rerun.io/version/0.35.0/'

export interface TimelineOptions {
  /** Height in CSS pixels. Default 300. */
  height?: number
  /** Default: the App's own colour scheme. */
  theme?: 'light' | 'dark'
  /**
   * The plots beside each cycle's cause, each a list of values in the words a
   * wire or a cause uses: `'alu.carry'`, `'b.value'` (a port, or else a state
   * key). Default: one plot per top-level part.
   */
  plots?: Array<{ title: string; values: Array<string> }>
  /**
   * Rerun's own panels around the timeline and plots. Default: the selection
   * and blueprint panels hidden, and the time panel collapsed to one row of
   * playback controls, the time slider and the time.
   */
  panels?: Partial<Record<'top' | 'blueprint' | 'selection' | 'time', 'hidden' | 'collapsed' | 'expanded'>>
}

export interface Timeline {
  /** Rerun's own viewer, for anything more: its time, its panels, its events. */
  viewer: WebViewer
  /** The recording the viewer shows now. */
  recordingId: () => string
  /** Resolves once the viewer has loaded, or rejects with why it did not. */
  ready: Promise<void>
  dispose: () => void
}

/** One plot as `theorem.trace.recording` takes it. */
interface TracePlot {
  title: string
  ports: Array<{ part: string; port: string }>
}

type Recording = (trace: {
  recordingId: string
  frames: Array<TraceFrame>
  layout?: { plots?: Array<TracePlot> }
}) => Promise<Uint8Array>

const TIMELINE = 'cycle'
/** The width Rerun's time panel needs to keep its controls on the one row it has room for. */
const VIEWER_MIN_WIDTH = 640

/** `alu.carry` as the recorded value it names: a port of `alu`, or else a key of its state. */
export function plotted(value: string, frame: TraceFrame | undefined): { part: string; port: string } {
  const dot = value.indexOf('.')
  const part = dot < 0 ? value : value.slice(0, dot)
  const port = dot < 0 ? '' : value.slice(dot + 1)
  const state = `${part}/state`
  return frame && !(port in (frame.values[part] ?? {})) && port in (frame.values[state] ?? {})
    ? { part: state, port }
    : { part, port }
}

/**
 * Rerun's viewer under a spatial model: every port of every part plotted
 * against the cycle, and each cycle's cause in a log. Moving the viewer's time
 * shows that cycle in the model as it was; a change made there runs the model
 * again from it, and the new run opens beside the old.
 */
export function mountTimeline(
  element: HTMLElement,
  model: SpatialModel,
  options: TimelineOptions = {},
): Timeline {
  const host = document.createElement('div')
  host.className = 'theorem-timeline'
  host.style.cssText = `position:relative;width:100%;height:${options.height ?? 300}px;overflow:hidden`
  element.append(host)
  // Rerun 0.35, when its time panel is narrower than 600 points, puts the
  // collapsed time bar's controls in two rows inside a bar one row tall, so
  // neither row shows (re_time_panel collapsed_ui). Rerun measures the canvas
  // as drawn, so zooming it down does not help: the viewer keeps
  // VIEWER_MIN_WIDTH and a narrower reply scrolls it sideways.
  const scroller = document.createElement('div')
  scroller.style.cssText = 'width:100%;height:100%;overflow-x:auto;overflow-y:hidden'
  const stage = document.createElement('div')
  stage.style.cssText = `width:100%;min-width:${VIEWER_MIN_WIDTH}px;height:100%`
  scroller.append(stage)
  host.append(scroller)

  const recording = (window as unknown as { theorem?: { trace?: { recording?: Recording } } }).theorem?.trace
    ?.recording
  const viewer = new WebViewer()
  let channel: LogChannel | undefined
  let disposed = false
  /** What the viewer has: the recording and its last cycle. */
  let sent = { recordingId: '', upTo: -1 }
  let sending = false
  let again = false
  /** A recording just opened: the viewer's first time for it is where Rerun put its cursor, not the person's choice. */
  let opening = false

  const shown = () => model.trace.viewing() ?? model.trace.cycle()

  // The viewer's time is the model's: paused, so Rerun's own follow mode does
  // not move it to the newest cycle while the person is looking back.
  const follow = () => {
    if (!sent.recordingId || disposed) return
    viewer.set_playing(sent.recordingId, false)
    viewer.set_current_time(sent.recordingId, TIMELINE, shown())
  }

  async function send() {
    if (!channel || !recording) return
    const recordingId = model.trace.recordingId()
    const fresh = recordingId !== sent.recordingId
    const frames = model.trace.frames(fresh ? model.trace.first() : sent.upTo + 1)
    if (frames.length) {
      // A recording that opens carries its layout; cycles added later do not,
      // so whatever the person rearranged in the viewer stays.
      const layout = fresh
        ? {
            plots: options.plots?.map((plot) => ({
              title: plot.title,
              ports: plot.values.map((value) => plotted(value, frames[0])),
            })),
          }
        : undefined
      const bytes = await recording({ recordingId, frames, layout })
      if (disposed) return
      channel.send_rrd(bytes)
      sent = { recordingId, upTo: frames.at(-1)!.cycle }
      if (fresh) {
        opening = true
        viewer.set_active_recording_id(recordingId)
        viewer.set_active_timeline(recordingId, TIMELINE)
      }
    }
    follow()
  }

  // One recording request at a time; whatever changed meanwhile goes next.
  function schedule() {
    if (sending) {
      again = true
      return
    }
    sending = true
    send()
      .catch((error: unknown) => fail(`The model's recording was not written: ${String(error)}`))
      .finally(() => {
        sending = false
        if (again && !disposed) {
          again = false
          schedule()
        }
      })
  }

  function fail(message: string) {
    const note = document.createElement('p')
    note.className = 'theorem-timeline-error'
    note.style.cssText = 'margin:0;padding:12px;font:13px/1.4 system-ui,sans-serif;color:inherit'
    note.textContent = message
    host.replaceChildren(note)
    reportError(new Error(message))
  }

  const unsubscribe = model.trace.subscribe(schedule)
  const offTime = viewer.on('time_update', (event) => {
    if (event.recording_id !== sent.recordingId) return
    const cycle = Math.round(event.time)
    if (opening) {
      opening = false
      if (cycle !== shown()) follow()
      return
    }
    if (cycle !== shown()) model.trace.scrub(cycle)
  })

  const dark = getComputedStyle(document.documentElement).colorScheme.includes('dark')
  const ready = (async () => {
    if (!recording) throw new Error('This App is shown where no Theorem backend writes recordings.')
    // `base_url` is read by WebViewer.start though its options type leaves it out.
    const start: Record<string, unknown> = {
      base_url: RERUN_VIEWER_BASE,
      hide_welcome_screen: true,
      allow_fullscreen: false,
      enable_history: false,
      width: '100%',
      height: '100%',
      theme: options.theme ?? (dark ? 'dark' : 'light'),
    }
    await viewer.start(null, stage, start)
    if (disposed) return
    for (const [panel, state] of Object.entries({ blueprint: 'hidden', selection: 'hidden', time: 'collapsed', ...options.panels }))
      viewer.override_panel_state(panel as 'top', state as 'hidden')
    channel = viewer.open_channel('theorem-model')
    schedule()
  })()
  ready.catch((error: unknown) => {
    if (disposed) return
    fail(`Rerun's viewer did not load from ${RERUN_VIEWER_BASE}: ${String(error)}.`)
  })

  return {
    viewer,
    recordingId: () => sent.recordingId,
    ready,
    dispose: () => {
      disposed = true
      unsubscribe()
      offTime()
      channel?.close()
      viewer.stop()
      host.remove()
    },
  }
}
