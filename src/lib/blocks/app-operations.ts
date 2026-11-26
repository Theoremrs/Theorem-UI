// SOURCING: Theorem's client operations (theorem-surface-contracts
// client_operation: a page declares operations in `clientOperations` on its
// send, each becomes a tool of the turn, a call streams a `client_operation`
// part in state `pending`, and the page answers with a
// `client-operation-receipt` command through @theoremharness/sdk's
// chat.runs.command), as Kit's operations use them (lib/kit/operations.ts);
// @tanstack/react-query's MutationObserver retries a receipt that failed to
// post. What the operations are is this app's: the agent asks the page to
// check an App, because the compiler and the sandbox are in the page.
import type { ThreadMessage } from '@assistant-ui/react'
import { MutationObserver, QueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { ObservableForm } from '@/lib/notebooks/forms'
import type { ObservableNotebook } from '@/lib/notebooks/forms'
import { appDocumentFor } from '@/lib/theorem/apps'
import type { AppSnapshot } from '@/lib/theorem/apps'
import { hasStatus, mutate, theorem } from '@/lib/theorem/client'
import { MAX_RUN_MS, inspectApp } from './app-inspect'
import type { AppInspection } from './app-inspect'
import { canonicalJson, digestBytes } from './artifact-runtime'
import {
  libraryDeclarations,
  theoremAppDeclarations,
} from './check/theorem-app.generated'
import { runningApp, runningApps } from './running-apps'
import { call } from './sandbox/protocol'
import type { ControlState, Rpc, SandboxMethods } from './sandbox/protocol'

/** The operation that checks an App, as the turn's tool `app__check`. */
export const APP_CHECK = 'app.check'
/** The operation that reads and changes a running App's named controls, as `app__control`. */
export const APP_CONTROL = 'app.control'
/** What `app.check` with `library` calls the declarations of `window.theorem` itself. */
export const BRIDGE_LIBRARY = 'window.theorem'

/** The largest App a check is given, as the server allows one to be. */
const MAX_HTML = 1024 * 1024

/**
 * The operations every turn declares so the agent can reach the page's
 * compiler: what each does, and the schema of its arguments.
 */
export const APP_OPERATIONS = [
  {
    name: APP_CHECK,
    // One operation for both, since a send admits sixteen and Kit, the face,
    // the workbench and the present one take the rest (client-surface.ts).
    description:
      "Builds and checks an App in the person's browser. Pass `html` (a complete App document as it would be published) or `artifact` (another form as write_app takes it) to check a draft, or `documentId` to check one as saved. Returns whether it built, build, type and runtime problems by file, line and column, its text, and `outline`: each thing on the page by role, name, state and the source that made it. `design: true` adds measurements of the page as drawn: text contrast against its real background, overflowing text, and text and controls under size targets, each located in the source, with what was not measured. `picture: true` adds an approximate image, if you read images. It runs hidden with empty state and an in-memory database. Pass `library` instead to read the declarations an App is checked against: window.theorem, @theorem/ui, @theorem/runtime, @theorem/spatial, @theorem/annotate (the files, index.d.ts or `file`, and a `digest`). Read what you use instead of guessing its shape.",
    effect: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        html: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_HTML,
          description: 'A complete App document to check as a draft.',
        },
        artifact: {
          type: 'object',
          description:
            'An artifact in another form, as write_app takes it, to check as a draft.',
        },
        documentId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description:
            'A published App, checked as it is saved now. For a notebook, `visible` is added when the person has that revision open: what their open view shows, apart from the hidden run.',
        },
        runMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_RUN_MS,
          description:
            'How long to run the App and listen for errors. 0 builds and checks types without running it. Default 1500; for a notebook, the run ends once every cell settles, at most 5000. `started` says whether the page ran; a notebook\'s `cells` say which showed a value, failed, or were still `pending` when the run ended, which is not seen yet rather than failed.',
        },
        picture: {
          type: 'boolean',
          description:
            "Also return an approximate image reconstruction. It omits the App's fonts and is not a browser screenshot. Only a model that reads images is shown it.",
        },
        design: {
          type: 'boolean',
          description:
            'Collect live sandbox DOM geometry and styles, then return bounded design findings, authority, evidence and coverage. Requires runMs > 0; defaults to false.',
        },
        library: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description:
            'Read declarations instead of checking: window.theorem, @theorem/ui, @theorem/runtime, @theorem/spatial or @theorem/annotate.',
        },
        file: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description:
            'With library: one declaration file its listing names, such as operations.d.ts.',
        },
      },
    },
  },
  {
    name: APP_CONTROL,
    description:
      "Reads and changes the controls a running App on the person's screen names for you (with `theorem.controls.register`, or @theorem/ui's `control` prop). `list` returns each control: its name, label, kind (number, boolean, choice, text or action), value, and range or options. `set` gives one a value and `invoke` presses one, through the same function the visible control calls; the person sees the change. The result is the control as read back once the App has drawn it, which can differ from what was asked (a number is held to its range and step). Pass `documentId` for a saved App; without it, the one running App is used.",
    effect: 'presentation',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'set', 'invoke'] },
        documentId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'The saved App, when more than one is running.',
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'With set or invoke: the control, by the name `list` gives.',
        },
        value: { description: 'With set: the new value, of the control\'s kind.' },
      },
    },
  },
] as const

/** A library's declaration files as the App check reads them, by file name. */
const declarationsOf = (library: string): Record<string, string> | undefined =>
  library === BRIDGE_LIBRARY
    ? theoremAppDeclarations
    : Object.hasOwn(libraryDeclarations, library)
      ? libraryDeclarations[library]
      : undefined

/** What `app.check` with `library` answers: the library's files, its identity, and the text asked for. */
export interface AppLibraryRead {
  library: string
  digest: string
  files: Array<{ name: string; bytes: number }>
  file: string
  text: string
}

/**
 * Reads one library's declarations as the page's App check holds them, so
 * what the agent reads is what an App it writes is checked against. Answers
 * undefined, with the libraries there are, for a library or file not held.
 */
export async function readAppLibrary(
  library: string,
  file = 'index.d.ts',
): Promise<AppLibraryRead | { missing: string }> {
  const files = declarationsOf(library)
  if (!files)
    return {
      missing: `There is no library ${library}; there are ${[BRIDGE_LIBRARY, ...Object.keys(libraryDeclarations)].join(', ')}.`,
    }
  if (!Object.hasOwn(files, file))
    return {
      missing: `${library} has no file ${file}; it has ${Object.keys(files).join(', ')}.`,
    }
  const encoder = new TextEncoder()
  return {
    library,
    digest: await digestBytes(encoder.encode(canonicalJson(files))),
    files: Object.entries(files).map(([name, text]) => ({
      name,
      bytes: encoder.encode(text).length,
    })),
    file,
    text: files[file]!,
  }
}

/** What a send carries so the turn can check Apps. */
export const appTurnOptions = () => ({ clientOperations: APP_OPERATIONS })

/** One request the run made of the page's App operations, read off a message. */
export interface AppRequest {
  readonly runId: string
  readonly requestRef: string
  readonly operation: string
  readonly args: Record<string, unknown>
  /** The page revision the run expects; a check changes nothing, so it is the receipt's too. */
  readonly expectedRevision: number
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** The App requests still pending among one run's message parts. */
function pendingAppRequests(
  runId: string,
  content: ThreadMessage['content'],
): Array<AppRequest> {
  return content.flatMap((part) => {
    if (part.type !== 'data' || part.name !== 'theorem-client_operation')
      return []
    const data = record(part.data)
    const { requestRef, operation, expectedRevision } = data
    if (
      (data.state ?? 'pending') !== 'pending' ||
      typeof requestRef !== 'string' ||
      typeof operation !== 'string' ||
      !operation.startsWith('app.')
    )
      return []
    return [
      {
        runId,
        requestRef,
        operation,
        args: record(data.args),
        expectedRevision:
          typeof expectedRevision === 'number' ? expectedRevision : 0,
      },
    ]
  })
}

/**
 * The App requests pending in the conversation's live turn: the last
 * assistant message, while it runs.
 */
export function appRequestsOf(
  messages: readonly ThreadMessage[],
  running: boolean,
): Array<AppRequest> {
  const last = messages.at(-1)
  if (!running || last?.role !== 'assistant') return []
  const runId = record(last.metadata.custom).theoremRunId
  if (typeof runId !== 'string') return []
  return pendingAppRequests(runId, last.content)
}

/**
 * The App requests pending in a specialist's run. A builder is handed the
 * page's check when the turn that started it was sent from a page, and asks on
 * its own run, which is not a message of the conversation: the page follows
 * that run by its id while the specialist works.
 */
export function appRequestsOfRun(
  runId: string,
  message: ThreadMessage | undefined,
): Array<AppRequest> {
  if (message?.status?.type !== 'running') return []
  return pendingAppRequests(runId, message.content)
}

type Outcome = 'applied' | 'rejected' | 'failed'

/** What the page says back: the check's findings, or why there are none. */
export interface AppAnswer {
  readonly outcome: Outcome
  readonly reason?: string
  readonly result?:
    | AppControlResult
    | (AppInspection & {
        /** The saved revision that was checked, when a published App was. */
        revision?: string
        /** What the open view of that revision shows on the page, when one is open. */
        visible?: unknown
      })
    | AppLibraryRead
}

/**
 * What answering needs of the page: the check, an App's saved source, and an
 * Observable notebook's page, which is checked as an App is.
 */
export interface AppOperationHost {
  inspect: typeof inspectApp
  /** The newest running frame of a saved App, and the Apps running on the page. */
  running: { app: (documentId: string) => Rpc | undefined; list: typeof runningApps }
  /** A saved App's head, its source read as the form it is saved in. */
  load: (
    documentId: string,
  ) => Promise<
    Pick<AppSnapshot, 'html' | 'form' | 'publication' | 'unreadable'> & {
      revision: { position: unknown }
    }
  >
  notebookPage: (notebook: ObservableNotebook) => Promise<string>
  /** What a view of the saved notebook open on the page shows, when one is open on `notebook`. */
  visible: (documentId: string, notebook: ObservableNotebook) => Promise<unknown>
}

const pageHost: AppOperationHost = {
  inspect: inspectApp,
  running: { app: runningApp, list: runningApps },
  load: (documentId) => appDocumentFor(documentId).load(),
  // Loaded only when a notebook is checked: the notebook runtime is large.
  notebookPage: async (notebook) => {
    const [{ observablePage }, { resolvedTheme }] = await Promise.all([
      import('@/lib/notebooks/observable-document'),
      import('@/lib/blocks/sandbox/theme'),
    ])
    return observablePage(notebook, resolvedTheme())
  },
  visible: async (documentId, notebook) => {
    const { currentReceipt, documentViewKey, notebookRevision, useViewInstances } =
      await import('@/lib/generative/view-instances')
    const key = documentViewKey(documentId)
    const view = useViewInstances.getState().byKey[key]
    return view && view.revision === notebookRevision(notebook)
      ? currentReceipt(key, view)
      : undefined
  },
}

/**
 * Why a form is not checked here, by form: what checks it instead, so the
 * agent knows the save is not the last word on it.
 */
const UNCHECKED: Record<string, string> = {
  marimo:
    'This page does not run a marimo notebook before the person starts it; its outputs are recorded when it runs.',
  openui:
    'This page does not run an OpenUI program before it is shown; the host checks its components when it is saved.',
}

/**
 * Checks an artifact in another form as write_app takes it. An Observable
 * notebook is read cell by cell before it runs (notebooks/cells.ts), then its
 * page is built and run as an App is, so a cell that throws is found too.
 */
async function checkArtifact(
  artifact: Readonly<Record<string, unknown>>,
  options: Parameters<typeof inspectApp>[1],
  host: AppOperationHost,
): Promise<AppAnswer> {
  const form = typeof artifact.form === 'string' ? artifact.form : undefined
  if (form === 'html-app' && typeof artifact.html === 'string' && artifact.html)
    return { outcome: 'applied', result: await host.inspect(artifact.html, options) }
  if (form && Object.hasOwn(UNCHECKED, form))
    return { outcome: 'rejected', reason: UNCHECKED[form] }
  const parsed = ObservableForm.safeParse(artifact)
  if (!parsed.success)
    return {
      outcome: 'rejected',
      reason: `This page checks an App, as html or as form html-app, and an Observable notebook, as form observable with title and cells: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'artifact'}: ${issue.message}`).join('; ')}`,
    }
  const { cellProblems } = await import('@/lib/notebooks/cells')
  const read = cellProblems(parsed.data.cells).map((message) => ({
    kind: 'build' as const,
    message,
  }))
  const ran = await host.inspect(await host.notebookPage(parsed.data), {
    ...options,
    cells: parsed.data.cells.map((cell) => cell.id),
  })
  return {
    outcome: 'applied',
    result: { ...ran, problems: [...read, ...ran.problems] },
  }
}

const failure = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

/** What `app.control` returns: the App reached, and its controls or the one acted on. */
export interface AppControlResult {
  documentId: string
  controls?: Array<ControlState>
  control?: ControlState
}

/** Lists, sets or presses a running App's named controls, in its frame. */
async function controlApp(args: Record<string, unknown>, host: AppOperationHost): Promise<AppAnswer> {
  const { action, name, value } = args
  const apps = host.running.list()
  const documentId =
    typeof args.documentId === 'string' && args.documentId
      ? args.documentId
      : apps.length === 1
        ? apps[0]!.documentId
        : undefined
  const named = apps.map((app) => `${app.documentId} (${app.title})`).join(', ')
  if (!documentId)
    return {
      outcome: 'rejected',
      reason: apps.length ? `Name the App by documentId: ${named}.` : 'No App is running on the page.',
    }
  const rpc = host.running.app(documentId)
  if (!rpc)
    return {
      outcome: 'rejected',
      reason: `App ${documentId} is not running on the page${apps.length ? `; ${named} is` : ''}.`,
    }
  try {
    if (action === 'list')
      return {
        outcome: 'applied',
        result: { documentId, controls: await call<SandboxMethods, 'controls.list'>(rpc, 'controls.list', {}) },
      }
    if ((action !== 'set' && action !== 'invoke') || typeof name !== 'string' || !name)
      return { outcome: 'rejected', reason: 'Pass action list, or set or invoke with the control\'s name.' }
    const control = await call<SandboxMethods, 'controls.act'>(rpc, 'controls.act', {
      name,
      action,
      ...(action === 'set' && { value }),
    })
    return { outcome: 'applied', result: { documentId, control } }
  } catch (error) {
    // The App's refusal (no such control, a value it does not take) is its answer.
    return { outcome: 'rejected', reason: failure(error) }
  }
}

/**
 * Answers one request. A check that finds problems is `applied`: the check
 * was made, and its result says what it found. `failed` is a check that could
 * not be made.
 */
export async function answerAppRequest(
  request: AppRequest,
  host: AppOperationHost = pageHost,
): Promise<AppAnswer> {
  if (request.operation === APP_CONTROL) return controlApp(request.args, host)
  if (request.operation !== APP_CHECK)
    return {
      outcome: 'rejected',
      reason: `This page has no operation ${request.operation}.`,
    }
  if (request.args.library !== undefined) {
    const { library, file } = request.args
    if (typeof library !== 'string' || !library)
      return { outcome: 'rejected', reason: 'Name the library to read.' }
    const read = await readAppLibrary(
      library,
      typeof file === 'string' && file ? file : undefined,
    )
    return 'missing' in read
      ? { outcome: 'rejected', reason: read.missing }
      : { outcome: 'applied', result: read }
  }
  const { html, documentId, runMs, picture, design } = request.args
  const options = {
    ...(typeof runMs === 'number' ? { runMs } : {}),
    ...(picture === true ? { picture: true } : {}),
    ...(design === true ? { design: true } : {}),
  }
  try {
    if (typeof html === 'string' && html)
      return { outcome: 'applied', result: await host.inspect(html, options) }
    if (Object.keys(record(request.args.artifact)).length)
      return await checkArtifact(record(request.args.artifact), options, host)
    if (typeof documentId === 'string' && documentId) {
      // A saved artifact is checked as the form it is saved in, the way its
      // draft was: an HTML App's page, another form's publication.
      const saved = await host.load(documentId)
      if (!saved.publication)
        return {
          outcome: 'rejected',
          reason: saved.unreadable ?? `The saved ${saved.form} could not be read.`,
        }
      const checked = await checkArtifact(saved.publication, options, host)
      const visible =
        checked.result && saved.publication.form === 'observable'
          ? await host.visible(documentId, saved.publication)
          : undefined
      return checked.result
        ? {
            ...checked,
            result: {
              ...checked.result,
              revision: String(saved.revision.position),
              ...(visible !== undefined && { visible }),
            },
          }
        : checked
    }
  } catch (error) {
    return { outcome: 'failed', reason: failure(error) }
  }
  return {
    outcome: 'rejected',
    reason:
      'Pass html or artifact to check a draft, or documentId to check a saved App.',
  }
}

export interface AppReceipt extends AppAnswer {
  readonly revision: number
}

function postReceipt(request: AppRequest, receipt: AppReceipt) {
  return mutate((headers) =>
    theorem().chat.runs.command({
      runId: request.runId,
      command: 'client-operation-receipt',
      requestRef: request.requestRef,
      receipt: { ...receipt },
      ...headers,
    }),
  )
}

const RECEIPT_RETRIES = 6
const receiptDelay = (failures: number) => Math.min(500 * 2 ** failures, 8_000)
const receipts = new QueryClient()
// Mounted for the page's life: only a mounted client resumes what it paused offline.
receipts.mount()
const served = new Set<string>()
let queue: Promise<void> = Promise.resolve()

/**
 * Answers each request once, whichever conversation reports it, one at a
 * time: the checker is one worker and a run is one frame. A receipt that
 * fails to post is sent again; the check is not made again.
 */
export function serveAppRequests(
  requests: ReadonlyArray<AppRequest>,
  post: (
    request: AppRequest,
    receipt: AppReceipt,
  ) => Promise<unknown> = postReceipt,
  host: AppOperationHost = pageHost,
  retryDelay: (failures: number) => number = receiptDelay,
): Promise<void> {
  for (const request of requests) {
    if (served.has(request.requestRef)) continue
    served.add(request.requestRef)
    queue = queue.then(async () => {
      const answer = await answerAppRequest(request, host)
      await new MutationObserver(receipts, {
        mutationFn: (receipt: AppReceipt) => post(request, receipt),
        retry: (failures, error) =>
          failures < RECEIPT_RETRIES && !hasStatus(error, 400, 404, 409, 422),
        retryDelay,
      })
        .mutate({ ...answer, revision: request.expectedRevision })
        .catch((error: unknown) => {
          console.warn('The App check could not answer its run', error)
        })
    })
  }
  return queue
}

/** The part of an assistant-ui thread runtime requests are read from. */
interface ThreadSource {
  readonly thread: {
    getState: () => {
      readonly messages: readonly ThreadMessage[]
      readonly isRunning: boolean
    }
    subscribe: (callback: () => void) => () => void
  }
}

/** Serves the App requests of one specialist's run for as long as it is mounted. */
export function useSpecialistAppRequests(
  runId: string,
  message: ThreadMessage | undefined,
) {
  useEffect(() => {
    void serveAppRequests(appRequestsOfRun(runId, message))
  }, [runId, message])
}

/** Serves App requests from one conversation for as long as it is mounted. */
export function useAppRequests(runtime: ThreadSource) {
  useEffect(() => {
    const serve = () => {
      const { messages, isRunning } = runtime.thread.getState()
      void serveAppRequests(appRequestsOf(messages, isRunning))
    }
    serve()
    return runtime.thread.subscribe(serve)
  }, [runtime])
}
