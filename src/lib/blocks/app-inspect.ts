// SOURCING: the pieces an App on screen uses, without a screen: the hosted
// page and its build (hosted-app.ts), the type check (app-checker.ts), the
// block sandbox and its bridge (executor.ts), and the trace of what a frame
// throws (app-trace.ts). What a check of an App reports, and that it runs the
// App where it can change nothing, is this app's.
import { z } from 'zod'
import { documentAppDatabases, openInMemory } from './app-db'
import * as checker from './app-checker'
import { schemesDesignFeedback, unavailableDesign } from './app-design'
import type {
  AppDesignFeedback,
  DesignScheme,
  SchemeMeasurement,
} from './app-design'
import { PICTURE_WIDTH, pictureOf } from './app-picture'
import type { AppPicture } from './app-picture'
import { AppBuildError, appSourcesOf } from './app-source'
import type { AppProblem } from './app-source'
import { traceFrameError } from './app-trace'
import { parseHtmlDeclarations } from './declarations'
import { pinnedAppHost, pinnedAppState } from './document-app'
import { FrameConnection, openFrame } from './executor'
import * as hosted from './hosted-app'
import {
  MAX_OUTLINE,
  MAX_SNAPSHOT,
  PAGE_BACKGROUND,
  call,
} from './sandbox/protocol'
import type {
  CellStatus,
  FrameError,
  PageAttributes,
  SandboxMethods,
} from './sandbox/protocol'
import { readAppTheme } from './sandbox/theme'
import type { AppTheme } from './sandbox/theme'

/** How a notebook's cells stood when its run ended, by id. */
export interface CellOutcomes {
  /** Cells that showed a value. */
  ready: Array<string>
  /** Cells that failed; their errors are in the problems. */
  failed: Array<string>
  /**
   * Cells that had not settled when the run ended: not failed and not shown,
   * only not seen yet. A longer run may see them settle.
   */
  pending: Array<string>
}

/**
 * What a check of an App found. Everything in it is JSON. Each fact is its
 * own: a page that built may not have started, and one that started may not
 * have shown everything by the time the run ended.
 */
export interface AppInspection {
  /** Whether the App's page could be made: false when its source does not build. */
  built: boolean
  /** Whether the page started: it ran and connected to Theorem. False when it was not run. */
  started: boolean
  /** For a notebook, how each of its cells stood when the run ended. */
  cells?: CellOutcomes
  /** The App's source files, when it is built from source. */
  files: Array<string>
  /** Build, type and runtime problems, in that order. */
  problems: Array<AppProblem>
  /** Problems found and not listed, past the most a check reports. */
  omitted: number
  /** Whether the types were checked: only an App built from source has any. */
  typesChecked: boolean
  /** Why the types were not checked, when they should have been. */
  typeCheckError?: string
  /** How long the App ran, in milliseconds; zero when it was not run. */
  ranMs: number
  /**
   * What the App showed once it settled: its text, how many elements, and
   * `outline`, each thing on the page by role, name and state (and, for an App
   * built from source, the place that made it). A `canvas` is listed and not
   * read.
   */
  rendered?: { text: string; elements: number; outline?: string }
  /**
   * An approximate reconstruction, when a picture was asked for: its snapshot
   * drawn in the page, with what it drew on a canvas. Its own fonts are not in
   * it. This is not a browser screenshot or evidence for a pixel comparison.
   */
  picture?: AppPicture
  /** Optional measurements of the live sandbox DOM, with explicit coverage. */
  design?: AppDesignFeedback
}

export interface InspectOptions {
  /**
   * How long to run the App and listen for what it throws. Zero does not run
   * it. A notebook's run ends sooner when every cell has settled.
   */
  runMs?: number
  /**
   * The ids of the cells a notebook page runs. The run lasts until each has
   * shown a value or failed, up to `runMs` (MAX_RUN_MS unless given), and the
   * inspection says how each stood.
   */
  cells?: ReadonlyArray<string>
  /** Also draw what the App showed, for a reader that can see. */
  picture?: boolean
  /** Also collect and evaluate the running App's rendered design measurements. */
  design?: boolean
}

/** How long an App runs unless told otherwise, and the longest it may. */
export const DEFAULT_RUN_MS = 1500
export const MAX_RUN_MS = 5000
/** How long the App's page has to connect before the run is given up. */
const CONNECT_MS = 10_000
/** How tall the frame an App is run in is; it is as wide as a picture. */
const FRAME_HEIGHT = 768
/** How long the App's page has to say what it shows at the end of its run. */
const LOOK_MS = 2_000
/**
 * How long it has to answer a design measurement. Longer than a look: it
 * walks the live document, on the same thread as a chat that is streaming.
 */
const DESIGN_MS = 5_000
/** What a frame answers when asked what it shows. It is the App's word, so it is checked. */
const attributes = z.record(z.string().max(80), z.string())
const looked = z.object({
  html: z.string().max(MAX_SNAPSHOT),
  outline: z.string().max(MAX_OUTLINE),
  page: z
    .object({
      root: attributes,
      body: attributes,
      background: z.string().regex(PAGE_BACKGROUND).optional(),
    })
    .optional(),
})
/** The most problems one check reports, and the most text of the rendered page. */
export const MAX_PROBLEMS = 40
const MAX_MESSAGE = 400
const MAX_RENDERED_TEXT = 2000
const MAX_RENDERED_OUTLINE = 6000

const declarationsOf = (html: string) =>
  parseHtmlDeclarations(
    [
      ...new DOMParser()
        .parseFromString(html, 'text/html')
        .querySelectorAll('meta[name="theorem:uses"]'),
    ].map((meta) => meta.getAttribute('content') ?? ''),
  )

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** How long a copy of the page's stylesheets has to load, to read a scheme it is not showing. */
const STYLES_MS = 3_000

/** The scheme the page shows now. */
const pageScheme = (): DesignScheme =>
  document.documentElement.classList.contains('dark') ? 'dark' : 'light'

/**
 * The page's look in a scheme: read from the page when it shows it, else
 * from the page's own stylesheets in a hidden document whose root carries
 * the page's root attributes in that scheme. The page itself is never
 * switched, so the person sees nothing change.
 */
async function appThemeIn(scheme: DesignScheme): Promise<AppTheme | undefined> {
  if (scheme === pageScheme()) return readAppTheme()
  const frame = document.createElement('iframe')
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  frame.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;border:0;visibility:hidden;pointer-events:none'
  document.body.append(frame)
  try {
    const copy = frame.contentDocument
    if (!copy) return undefined
    const root = copy.documentElement
    for (const { name, value } of document.documentElement.attributes)
      root.setAttribute(name, value)
    root.classList.toggle('dark', scheme === 'dark')
    root.style.setProperty('color-scheme', scheme)
    const loads: Array<Promise<unknown>> = []
    for (const node of document.querySelectorAll(
      'style, link[rel~="stylesheet"]',
    )) {
      const clone = copy.importNode(node, true) as HTMLElement
      // The copy is the hidden document's element, so it is told by its name.
      if (clone.localName === 'link')
        loads.push(
          new Promise((resolve) => {
            clone.onload = clone.onerror = resolve
          }),
        )
      copy.head.append(clone)
    }
    await Promise.race([Promise.all(loads), wait(STYLES_MS)])
    return readAppTheme(root)
  } finally {
    frame.remove()
  }
}

/** Elements that start a new line when a page is read as text. */
const LINE = new Set(
  'address article aside blockquote br dd div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section table tr ul'.split(
    ' ',
  ),
)

/** `text` cut at a line's end, saying how many lines were left out. */
function clipLines(text: string, most: number): string {
  if (text.length <= most) return text
  const kept = text.slice(0, text.lastIndexOf('\n', most))
  const left = text.slice(kept.length).split('\n').length - 1
  return `${kept}\n… ${left} more`
}

/**
 * A snapshot's text, as a person would read it down the page: a line for
 * each block and table row, and a space between the things on a line.
 */
function renderedOf(
  snapshot: string,
  outline: string | undefined,
): AppInspection['rendered'] {
  const page = new DOMParser().parseFromString(snapshot, 'text/html')
  for (const hidden of page.body.querySelectorAll('script, style, template'))
    hidden.remove()
  const elements = [...page.body.querySelectorAll('*')]
  // textContent runs neighbours together: a table's cells, a list's items.
  for (const element of elements)
    element.after(page.createTextNode(LINE.has(element.localName) ? '\n' : ' '))
  const text = page.body.textContent
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
  return {
    text: text.slice(0, MAX_RENDERED_TEXT),
    elements: elements.length,
    ...(outline === undefined
      ? {}
      : { outline: clipLines(outline, MAX_RENDERED_OUTLINE) }),
  }
}

/**
 * Runs an App's page where nobody sees it and nothing it does lasts: off
 * screen, as it runs on the page (network and all), with its state kept in
 * the frame and its databases in memory. Returns what it threw and what it showed.
 */
async function run(
  html: string,
  page: string,
  runMs: number,
  pictured: boolean,
  cells: ReadonlyArray<string> | undefined,
  designed: boolean,
): Promise<{
  problems: Array<AppProblem>
  started: boolean
  cells?: CellOutcomes
  ranMs: number
  rendered?: AppInspection['rendered']
  picture?: AppPicture
  design?: AppDesignFeedback
}> {
  const problems: Array<AppProblem> = []
  // How each cell first settled, and the moment every one has.
  const settled = new Map<string, CellStatus['stage']>()
  let allSettled = () => {}
  const everySettled = new Promise<void>((resolve) => (allSettled = resolve))
  const onStatus = ({ cell, stage }: CellStatus) => {
    if (!cells?.includes(cell) || settled.has(cell)) return
    settled.set(cell, stage)
    if (settled.size === cells.length) allSettled()
  }
  let snapshot: string | undefined
  // What the App's root and body carried when it was last looked at.
  let carried: PageAttributes | undefined
  let outline: string | undefined
  let design: AppDesignFeedback | undefined = designed
    ? unavailableDesign('The App did not connect for design measurement.')
    : undefined
  let height = FRAME_HEIGHT
  const build = hosted.hostedBuild(page)
  const state = pinnedAppState(null)
  await state.ready
  const declarations = declarationsOf(html)
  // A name no App has, so the run can never open an App's own records.
  const databases = documentAppDatabases(`check-${crypto.randomUUID()}`, {
    open: openInMemory,
    historyDays: declarations.dbHistoryDays,
  })
  const url = URL.createObjectURL(new Blob([page], { type: 'text/html' }))
  const frame = document.createElement('iframe')
  openFrame(frame)
  frame.setAttribute('aria-hidden', 'true')
  frame.tabIndex = -1
  // Laid out at a real size, so the App measures what it would on screen.
  // In the viewport and transparent rather than off screen or hidden: the
  // browser gives a frame it counts as unseen no animation frames, and an
  // App drawn in requestAnimationFrame would never draw.
  frame.style.cssText = `position:fixed;left:0;top:0;width:${PICTURE_WIDTH}px;height:${FRAME_HEIGHT}px;opacity:0;z-index:-1;pointer-events:none;border:0`
  const connection = new FrameConnection(frame, {
    ...pinnedAppHost(
      html,
      'check',
      state.state,
      databases,
    ),
    onError: (error: FrameError) => {
      problems.push(traceFrameError(error, build))
    },
    onSnapshot: (copy: string, things?: string) => {
      snapshot = copy
      outline = things
      carried = undefined
    },
    onResize: (tall: number) => {
      height = Math.max(tall, FRAME_HEIGHT)
    },
    onStatus,
  })
  frame.src = url
  document.body.append(frame)
  const started = performance.now()
  let connected = false
  try {
    connected = await Promise.race([
      connection.connected.then(
        () => true,
        () => false,
      ),
      wait(CONNECT_MS).then(() => false),
    ])
    if (!connected)
      problems.push({
        kind: 'runtime',
        message: 'The App did not start: its page never connected to Theorem.',
      })
    else {
      await (cells?.length
        ? Promise.race([everySettled, wait(runMs)])
        : wait(runMs))
      // What the App shows at the end of its run. An App that keeps changing
      // (a clock, an animation) never settles into a snapshot of its own, and
      // one that changed late would leave an older one.
      const seen = await Promise.race([
        connection.connected.then((rpc) =>
          call<SandboxMethods, 'frame.look'>(rpc, 'frame.look', {}),
        ),
        wait(LOOK_MS).then(() => null),
      ]).catch(() => null)
      const last = looked.safeParse(seen)
      if (last.success) {
        snapshot = last.data.html
        outline = last.data.outline
        carried = last.data.page
      }
      if (designed) {
        // Measured in the scheme the page shows, then in the other one: an
        // App is seen in both, and one that reads well in one may not in the
        // other. Each measurement is against the page's background in it.
        const first = pageScheme()
        const measurements: Array<SchemeMeasurement> = []
        for (const scheme of [
          first,
          first === 'dark' ? 'light' : 'dark',
        ] as const) {
          const theme = await appThemeIn(scheme)
          if (!theme) {
            measurements.push({
              scheme,
              reason: `The page's ${scheme} theme could not be read.`,
            })
            continue
          }
          frame.style.setProperty('color-scheme', scheme)
          const captureId = crypto.randomUUID()
          const observed = await Promise.race([
            connection.connected
              .then(async (rpc) => {
                await call<SandboxMethods, 'theme.changed'>(
                  rpc,
                  'theme.changed',
                  theme,
                )
                return call<SandboxMethods, 'frame.design'>(
                  rpc,
                  'frame.design',
                  {
                    captureId,
                    scheme,
                    ...(theme.tokens.background
                      ? { canvas: theme.tokens.background }
                      : {}),
                  },
                )
              })
              .then(
                (value) => ({ value }),
                (error: unknown) => ({
                  failed:
                    error instanceof Error ? error.message : String(error),
                }),
              ),
            wait(DESIGN_MS).then(() => ({ late: true })),
          ])
          measurements.push(
            'value' in observed
              ? { scheme, captureId, value: observed.value }
              : {
                  scheme,
                  reason:
                    'late' in observed
                      ? `The App did not answer the ${scheme} design measurement within ${DESIGN_MS / 1000} s.`
                      : `The App's ${scheme} design measurement failed: ${observed.failed}`,
                },
          )
        }
        design = schemesDesignFeedback(measurements)
      }
    }
  } finally {
    connection.dispose()
    databases.dispose()
    state.dispose()
    frame.remove()
    URL.revokeObjectURL(url)
  }
  const where = (stage?: CellStatus['stage']) =>
    (cells ?? []).filter((cell) => settled.get(cell) === stage)
  return {
    problems,
    started: connected,
    ...(cells && {
      cells: {
        ready: where('ready'),
        failed: where('failed'),
        pending: where(undefined),
      },
    }),
    ranMs: Math.round(performance.now() - started),
    rendered:
      snapshot === undefined ? undefined : renderedOf(snapshot, outline),
    picture:
      pictured && snapshot !== undefined
        ? await pictureOf(snapshot, height, carried)
        : undefined,
    ...(design ? { design } : {}),
  }
}

/**
 * Checks an App the way opening it would, and reports instead of showing: it
 * is built, its types are checked when it is built from source, and it is run
 * off screen for a moment. A draft and a published revision are checked alike;
 * the check reads nothing but the HTML it is given.
 */
export async function inspectApp(
  html: string,
  options: InspectOptions = {},
): Promise<AppInspection> {
  const runMs = Math.min(
    Math.max(
      options.runMs ?? (options.cells ? MAX_RUN_MS : DEFAULT_RUN_MS),
      0,
    ),
    MAX_RUN_MS,
  )
  const found: Array<AppProblem> = []
  const inspection: AppInspection = {
    built: false,
    started: false,
    files: [],
    problems: [],
    omitted: 0,
    typesChecked: false,
    ranMs: 0,
    ...(options.design === true
      ? {
          design: unavailableDesign(
            'The App was not run; design measurements require a successful build and runMs greater than zero.',
          ),
        }
      : {}),
  }
  const finish = (): AppInspection => {
    const unique = found.filter(
      (problem, index) =>
        found.findIndex(
          (other) =>
            other.kind === problem.kind &&
            other.message === problem.message &&
            other.file === problem.file &&
            other.line === problem.line,
        ) === index,
    )
    inspection.problems = unique.slice(0, MAX_PROBLEMS).map((problem) => ({
      ...problem,
      message: problem.message.slice(0, MAX_MESSAGE),
    }))
    inspection.omitted = unique.length - inspection.problems.length
    return inspection
  }

  let page: string
  try {
    const declarations = declarationsOf(html)
    if (declarations.errors.length)
      throw new AppBuildError(
        declarations.errors.map((message) => ({ kind: 'build', message })),
      )
    // A check runs the App as it runs on the page, network and all.
    page = await hosted.hostedAppDocument(html, undefined, {
      keepDrawnFrames: options.picture === true,
    })
  } catch (error) {
    if (!(error instanceof AppBuildError)) throw error
    found.push(...error.problems)
    return finish()
  }
  inspection.built = true

  const sources = appSourcesOf(html)
  if (sources) {
    inspection.files = Object.keys(sources.files)
    try {
      found.push(...(await checker.checkInWorker(sources)).problems)
      inspection.typesChecked = true
    } catch (error) {
      inspection.typeCheckError =
        error instanceof Error ? error.message : String(error)
    }
  }

  if (runMs > 0) {
    const ran = await run(
      html,
      page,
      runMs,
      options.picture === true,
      options.cells,
      options.design === true,
    )
    found.push(...ran.problems)
    inspection.started = ran.started
    if (ran.cells) inspection.cells = ran.cells
    inspection.ranMs = ran.ranMs
    inspection.rendered = ran.rendered
    if (ran.picture) inspection.picture = ran.picture
    if (ran.design) inspection.design = ran.design
  }
  return finish()
}
