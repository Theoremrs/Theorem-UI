// SOURCING: @theoremharness/sdk-ide — each call is the generated client.ide.language / navigation / refactor / diagnostics operation, sent through ../ask with the request id as the idempotency key. The SDK's WorkspaceLanguage class is not used: it freezes one CSRF token at construction, mints its own idempotency key per call (so the workbench's request id cannot be the host's), and has no place for a stale-generation guard. Its request bodies (document and position fields) and its reading of the host's answers are copied from it.

import type { TheoremClient } from '@theoremharness/sdk-ide'
import type { Environment, HostClient } from '../environment/environment'
import { refused } from '../environment/result'
import type { Completion } from '../environment/result'
import { createAsk, num, outsideWorkspace, raw, str } from '../ask'

/** The calls the language owner makes of a Theorem client. */
export type LanguageClient = HostClient & {
  ide: {
    language: Pick<
      TheoremClient['ide']['language'],
      'hover' | 'complete' | 'format'
    >
    navigation: Pick<
      TheoremClient['ide']['navigation'],
      | 'definition'
      | 'declaration'
      | 'typeDefinition'
      | 'implementation'
      | 'references'
    >
    refactor: Pick<TheoremClient['ide']['refactor'], 'prepare' | 'apply'>
    diagnostics: Pick<TheoremClient['ide']['diagnostics'], 'subscribe'>
  }
}

export const NAVIGATION_KINDS = [
  'definition',
  'declaration',
  'typeDefinition',
  'implementation',
] as const
export type NavigationKind = (typeof NAVIGATION_KINDS)[number]

/** LSP position: `character` counts UTF-16 code units. */
export interface Position {
  line: number
  character: number
}
export interface Range {
  start: Position
  end: Position
}

/** A span of a whole document in the host's own units; converting it needs the text it was read against. */
export interface Span {
  start: number
  end: number
  encoding: 'utf8_bytes' | 'utf16_code_units' | 'unicode_scalars'
}

export interface Place {
  range?: Range
  span?: Span
}

export interface HoverResult extends Place {
  /** Markdown; empty when no provider answered. */
  contents: string
}

export interface CompletionItem {
  label: string
  /** Monaco's CompletionItemKind numbering. */
  kind?: number
  detail?: string
  documentation?: string
  insertText?: string
  range?: Range | { inserting: Range; replacing: Range }
  itemId?: string
}

export interface LocationRow {
  /** A document of this workspace. */
  resourceId?: string
  /** A location the host named by URI, outside the workspace's documents. */
  uri?: string
  range?: Range
  span?: Span
  /** The document revision a span was computed against. */
  revision?: number
}

export interface Finding {
  id: string
  /** UTF-8 byte offsets into the text of the snapshot's revision. */
  start: number
  end: number
  severity: 'error' | 'warning' | 'info' | 'hint'
  message: string
  provider?: string
  fixHandle?: string
}

export interface DiagnosticsResult {
  revision?: number
  sessionEpoch?: number
  contentHash?: string
  full: boolean
  findings: Finding[]
}

export interface PlanResult {
  planId?: string
}

interface Request {
  requestId: string
}
export interface DocumentRequest extends Request {
  resourceId: string
  /** The document session's revision the caller asks about; the host refuses without one. */
  revision: number
  language?: string
}
export interface PositionRequest extends DocumentRequest, Position {}

export interface Language {
  readonly workspaceId: string
  hover: (request: PositionRequest) => Promise<Completion<HoverResult>>
  complete: (request: PositionRequest) => Promise<Completion<CompletionItem[]>>
  /** `kind` outside {@link NAVIGATION_KINDS} is refused `unsupported_navigation`. */
  navigate: (
    request: PositionRequest & { kind: string },
  ) => Promise<Completion<LocationRow[]>>
  references: (
    request: PositionRequest & { includeDeclaration?: boolean },
  ) => Promise<Completion<LocationRow[]>>
  /** The snapshot carries the revision the host computed it against; the caller compares. */
  diagnostics: (
    request: DocumentRequest,
  ) => Promise<Completion<DiagnosticsResult>>
  format: (request: DocumentRequest) => Promise<Completion<PlanResult>>
  rename: (
    request: PositionRequest & { newName: string },
  ) => Promise<Completion<PlanResult>>
  /** The host's authority applies the plan; the edits arrive as the documents owner's changes. */
  applyPlan: (
    request: Request & { planId: string },
  ) => Promise<Completion<{ planId: string }>>
  /** Answers withheld because the environment had moved on. */
  dropped: () => number
  dispose: () => void
}

const positionOf = (value: unknown): Position | undefined => {
  const body = raw(value)
  const line = num(body.line)
  const character = num(body.character)
  return line === undefined || character === undefined
    ? undefined
    : { line, character }
}

const rangeOf = (value: unknown): Range | undefined => {
  const body = raw(value)
  const start = positionOf(body.start)
  const end = positionOf(body.end)
  return start && end ? { start, end } : undefined
}

const ENCODINGS = new Set(['utf8_bytes', 'utf16_code_units', 'unicode_scalars'])

const spanOf = (value: unknown): Span | undefined => {
  const body = raw(value)
  const start = num(body.start)
  const end = num(body.end)
  const encoding = str(body.coordinate_encoding)
  return start === undefined ||
    end === undefined ||
    encoding === undefined ||
    !ENCODINGS.has(encoding)
    ? undefined
    : { start, end, encoding: encoding as Span['encoding'] }
}

/** A result tied to part of the document: a `range`, or a `location` span. */
function placeOf(body: Record<string, unknown>): Place {
  const range = rangeOf(body.range)
  const span = spanOf(body.location)
  return { ...(range ? { range } : {}), ...(span ? { span } : {}) }
}

function locationOf(value: unknown): LocationRow | undefined {
  const body = raw(value)
  const document = raw(body.document)
  const resourceId = str(document.resource_id)
  if (resourceId !== undefined) {
    const span = spanOf(body)
    return span
      ? {
          resourceId,
          span,
          ...(num(raw(body.version).revision) !== undefined
            ? { revision: num(raw(body.version).revision) }
            : {}),
        }
      : undefined
  }
  const uri = str(body.uri)
  const range = rangeOf(body.range)
  return uri !== undefined && range ? { uri, range } : undefined
}

/** Locations as the host sends them: a flat list, or groups that each hold a `locations` list. */
function locationsOf(list: unknown): LocationRow[] {
  return (Array.isArray(list) ? list : []).flatMap((item): LocationRow[] => {
    const group = raw(item).locations
    if (Array.isArray(group)) return locationsOf(group)
    const location = locationOf(item)
    return location ? [location] : []
  })
}

function itemOf(value: unknown): CompletionItem[] {
  const body = raw(value)
  const label = str(body.label)
  if (label === undefined) return []
  const range = raw(body.range)
  const inserting = rangeOf(range.inserting)
  const replacing = rangeOf(range.replacing)
  const plain = rangeOf(range)
  return [
    {
      label,
      ...(num(body.kind) !== undefined ? { kind: num(body.kind) } : {}),
      ...(str(body.detail) ? { detail: str(body.detail) } : {}),
      ...(str(body.documentation)
        ? { documentation: str(body.documentation) }
        : {}),
      ...(str(body.insertText) !== undefined
        ? { insertText: str(body.insertText) }
        : {}),
      ...(inserting && replacing
        ? { range: { inserting, replacing } }
        : plain
          ? { range: plain }
          : {}),
      ...(str(body.item_id) ? { itemId: str(body.item_id) } : {}),
    },
  ]
}

const SEVERITIES = new Set(['error', 'warning', 'info', 'hint'])

export function createLanguage(env: Environment<LanguageClient>): Language {
  const { ask, workspaceId, dropped, dispose } = createAsk(env)
  const api = () => env.client.ide
  /** A write is sent once; the SDK's own retries are off, so the host sees it once. */
  const once = { maxRetries: 0 }

  const doc = ({ resourceId, language, revision }: DocumentRequest) => ({
    resource_id: resourceId,
    language,
    revision,
  })
  const at = (request: PositionRequest) => ({
    ...doc(request),
    line: request.line,
    character: request.character,
  })

  /** Refused before sending: a path outside the workspace, or no integer revision to bind the answer to. */
  const invalid = (request: DocumentRequest) => {
    if (outsideWorkspace(request.resourceId)) {
      return refused(
        { workspaceId, requestId: request.requestId },
        'outside_workspace',
        `${request.resourceId} is outside the workspace`,
      )
    }
    if (!Number.isInteger(request.revision) || request.revision < 0) {
      return refused(
        { workspaceId, requestId: request.requestId },
        'no_revision',
        'A language request needs the document revision it asks about',
      )
    }
    return undefined
  }

  const planOf = (answer: unknown): PlanResult => {
    const planId = str(raw(answer).plan_id)
    return planId ? { planId } : {}
  }

  return {
    workspaceId,
    dropped,
    dispose,

    async hover(request) {
      const bad = invalid(request)
      if (bad) return bad
      return ask(
        request.requestId,
        'language.hover',
        false,
        (headers) => api().language.hover({ ...headers, body: at(request) }),
        (answer) => {
          const body = raw(answer)
          return { contents: str(body.contents) ?? '', ...placeOf(body) }
        },
      )
    },

    async complete(request) {
      const bad = invalid(request)
      if (bad) return bad
      return ask(
        request.requestId,
        'language.complete',
        false,
        (headers) => api().language.complete({ ...headers, body: at(request) }),
        (answer) => {
          const items = raw(answer).items
          return (Array.isArray(items) ? items : []).flatMap(itemOf)
        },
      )
    },

    async navigate(request) {
      const kind = NAVIGATION_KINDS.find((name) => name === request.kind)
      if (!kind) {
        return refused(
          { workspaceId, requestId: request.requestId },
          'unsupported_navigation',
          `${request.kind} is not a navigation this owner sends`,
        )
      }
      const bad = invalid(request)
      if (bad) return bad
      return ask(
        request.requestId,
        `navigation.${kind}`,
        false,
        (headers) => api().navigation[kind]({ ...headers, body: at(request) }),
        (answer) => locationsOf(raw(answer).locations),
      )
    },

    async references(request) {
      const bad = invalid(request)
      if (bad) return bad
      return ask(
        request.requestId,
        'navigation.references',
        false,
        (headers) =>
          api().navigation.references({
            ...headers,
            body: {
              ...at(request),
              include_declaration: request.includeDeclaration ?? true,
            },
          }),
        (answer) => {
          const body = raw(answer)
          return locationsOf(body.groups ?? body.locations)
        },
      )
    },

    async diagnostics(request) {
      const bad = invalid(request)
      if (bad) return bad
      return ask(
        request.requestId,
        'diagnostics.subscribe',
        false,
        (headers) =>
          api().diagnostics.subscribe({ ...headers, body: doc(request) }),
        (answer) => {
          const body = raw(answer)
          const list = body.diagnostics
          const findings = (Array.isArray(list) ? list : []).flatMap(
            (item): Finding[] => {
              const finding = raw(item)
              const severity = str(finding.severity)
              const start = num(finding.start)
              const end = num(finding.end)
              if (
                start === undefined ||
                end === undefined ||
                severity === undefined ||
                !SEVERITIES.has(severity)
              ) {
                return []
              }
              return [
                {
                  id: str(finding.id) ?? '',
                  start,
                  end,
                  severity: severity as Finding['severity'],
                  message: str(finding.message) ?? '',
                  ...(str(finding.provider)
                    ? { provider: str(finding.provider) }
                    : {}),
                  ...(str(finding.fix_handle)
                    ? { fixHandle: str(finding.fix_handle) }
                    : {}),
                },
              ]
            },
          )
          return {
            ...(num(body.revision) !== undefined
              ? { revision: num(body.revision) }
              : {}),
            ...(num(body.session_epoch) !== undefined
              ? { sessionEpoch: num(body.session_epoch) }
              : {}),
            ...(str(body.content_hash)
              ? { contentHash: str(body.content_hash) }
              : {}),
            full: body.full === true,
            findings,
          }
        },
      )
    },

    async format(request) {
      const bad = invalid(request)
      if (bad) return bad
      return ask(
        request.requestId,
        'language.format',
        true,
        (headers) =>
          api().language.format({ ...headers, body: doc(request) }, once),
        planOf,
      )
    },

    async rename(request) {
      const bad = invalid(request)
      if (bad) return bad
      if (request.newName.trim() === '') {
        return refused(
          { workspaceId, requestId: request.requestId },
          'empty_name',
          'A rename needs a new name',
        )
      }
      return ask(
        request.requestId,
        'refactor.prepare',
        true,
        (headers) =>
          api().refactor.prepare(
            {
              ...headers,
              body: {
                ...at(request),
                operation: 'rename',
                new_name: request.newName,
              },
            },
            once,
          ),
        planOf,
      )
    },

    async applyPlan({ requestId, planId }) {
      if (planId === '') {
        return refused(
          { workspaceId, requestId },
          'no_plan',
          'Applying a plan needs its id',
        )
      }
      return ask(
        requestId,
        'refactor.apply',
        true,
        (headers) =>
          api().refactor.apply({ ...headers, body: { plan_id: planId } }, once),
        () => ({ planId }),
      )
    },
  }
}
