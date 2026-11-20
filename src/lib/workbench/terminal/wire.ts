// SOURCING: @theoremharness/sdk for the host's terminal types (attach reply, binding, modes, list, adoption, live events); the outcome shape every call returns and the refusal reading are this workbench's own (docs/plans/theo-workbench/gate-0/terminal-path.md), and no upstream library models them.
import type { Theorem, WorkspaceLiveEvent } from '@theoremharness/sdk'
import { reason as readableReason } from '../environment/workspace-recovery'
import { readable } from '../environment/redact'

/** How the program in a binding came to be there. */
export type ProgramOrigin =
  'launched' | 'adopted' | 'replacement' | 'reattached'

export type InputKind = 'human' | 'reply'

/** What the host calls a terminal binding. `program` is the incarnation: 1 = original, +1 per replacement. */
export interface WireBinding {
  backend?: string
  epoch: number
  core_id?: string
  terminal?: string
  program?: number | { generation: number; origin?: ProgramOrigin }
}

export interface OpenReply {
  session: string
  cols?: number
  rows?: number
  backend?: string
  binding?: WireBinding
  process_owned_by?: string
  /** The program's own status report; read by `parseProgramReport`, never trusted as typed. */
  program_report?: unknown
}

/**
 * What `terminal.attach` answers, as the SDK types it: the offsets and bytes, the binding (one
 * `program` number), the attachment name, the screen `modes` and the repaint.
 */
export type AttachReply = Theorem.IdeTerminalAttachReply

export interface InputReply {
  accepted?: boolean
  duplicate?: boolean
  discarded?: boolean
  /** The host cannot say whether the bytes were delivered (`terminal_input_uncertain`); they are never resent. */
  uncertain?: boolean
  code?: string
  next_step?: string
}

/**
 * Whether the host's terminal can be reached. `lost` means the process outcome is unknown, never that
 * it exited. `reason` and `nextStep` are the host's own stable words, read defensively and kept as sent.
 */
export type Connectivity =
  | { state: 'running' }
  | { state: 'lost'; reason: string | undefined; nextStep: string | undefined }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The connectivity a live update, a list row or an attach reply states, or undefined when it states
 * none (an older host, or a state this client does not know), which leaves what is held unchanged.
 */
export function readConnectivity(data: unknown): Connectivity | undefined {
  if (!isRecord(data)) return undefined
  if (data.state === 'running') return { state: 'running' }
  if (data.state !== 'lost') return undefined
  return {
    state: 'lost',
    reason: typeof data.reason === 'string' ? data.reason : undefined,
    nextStep: typeof data.next_step === 'string' ? data.next_step : undefined,
  }
}

const CAUSES: Record<string, string> = {
  core_closed: 'the core closed the connection',
  core_unavailable: 'the core cannot be reached',
  subscribe_timed_out: 'the core did not answer the subscription in time',
}
const STEPS: Record<string, string> = {
  retry: 'Retry to reconnect.',
  reconcile: 'Check the terminal before doing it again.',
}

/** The host's stable cause in plain words; a cause this client does not know is shown as sent. */
export const causeWords = (reason: string | undefined): string =>
  reason === undefined
    ? 'the cause is not known'
    : (CAUSES[reason] ?? readable(reason))

/** Whether the cause is one of the host's stable codes (an older host sends free text instead). */
export const isKnownCause = (reason: string | undefined): boolean =>
  reason !== undefined && Object.hasOwn(CAUSES, reason)

/** The host's advice in plain words. Advice, never an automatic action. */
export const stepWords = (nextStep: string | undefined): string =>
  nextStep === undefined ? '' : (STEPS[nextStep] ?? readable(nextStep))

/**
 * What a person reads when a terminal's core connection is lost: why, that the process is not known
 * to have ended, and the host's next step.
 */
export function lostWords(
  reason: string | undefined,
  nextStep: string | undefined,
): string {
  const step = stepWords(nextStep)
  return `Connection to the terminal lost: ${causeWords(reason)}. The program may still be running; its outcome is not known.${step ? ` ${step}` : ''}`
}

/** The claim a write carries so the host can refuse one drawn against an older binding (`stale_epoch`). */
export interface WriteClaim {
  attachment?: string
  epoch?: number
}

const TERMINAL_KINDS = [
  'terminal.adoption',
  'terminal.unadmitted',
  'terminal.opened',
  'terminal.output',
  'terminal.resized',
  'terminal.exited',
  'terminal.updated',
] as const

/** Every terminal event the host publishes, as the SDK types the live stream. */
export type TerminalLiveEvent =
  | {
      [
        K in Exclude<(typeof TERMINAL_KINDS)[number], 'terminal.updated'>
      ]: WorkspaceLiveEvent<K>
    }[Exclude<(typeof TERMINAL_KINDS)[number], 'terminal.updated'>]
  /** Passive: replaces the program's report for one binding epoch (omission clears it). Not in the SDK's typed stream yet, so the payload is read as unknown. */
  | {
      kind: 'terminal.updated'
      data: {
        session: string
        epoch?: unknown
        program_report?: unknown
        /** `lost` or `running`; absent leaves connectivity unchanged. */
        state?: unknown
        reason?: unknown
        next_step?: unknown
      }
    }

export const isTerminalEvent = (event: {
  kind: string
}): event is TerminalLiveEvent =>
  (TERMINAL_KINDS as readonly string[]).includes(event.kind)

/** Each refusal the host or this module can give. */
export type Refusal =
  /** The write was drawn against an older binding epoch; nothing was written. */
  | { code: 'terminal_control_refused'; reason: 'stale_epoch' }
  | {
      code: 'terminal_backend_unavailable'
      reason: string
      backend?: string
      nextStep?: string
    }
  /** The host refused a launch argument it owns (`env`, `cwd`, `labels`, ...) or one that is invalid; nothing started. */
  | { code: 'terminal_argument_refused'; reason: string; field?: string }
  /** The terminal's core connection is lost; nothing was sent, because the host cannot deliver it and the outcome would be unknown. */
  | { code: 'terminal_core_lost'; reason: string }
  | { code: 'terminal_session_not_found'; reason: string }
  /** The host does not list the operation this call needs (`terminal.input.bytes`). */
  | { code: 'missing_capability'; reason: string }
  /** The host does not advertise `terminal.kill`, or no generic operation call was supplied. */
  | { code: 'kill_unavailable'; reason: string }
  /** The host reports no Herdr core this client is pinned to; nothing was sent and no native shell stands in for it. */
  | { code: 'terminal_protocol_unsupported'; reason: string }
  /** The host answered a launch or attach as a different backend or in a shape this client does not read; nothing it sent was applied. */
  | { code: 'terminal_reply_mismatch'; reason: string }
  /** A write named an attachment this session no longer holds and it could not be shown to be the current one; nothing was sent. */
  | { code: 'terminal_attachment_superseded'; reason: string }

/** Which terminal and binding epoch an outcome answers. */
export interface Answers {
  terminalId: string | undefined
  bindingEpoch: number | undefined
}

/** One shape for every call. `uncertain` means the host may or may not have acted. */
export type Outcome<T> = Answers &
  (
    | { outcome: 'accepted'; value: T }
    | ({ outcome: 'refused' } & Refusal)
    | { outcome: 'uncertain'; reason: string }
    | { outcome: 'failed'; reason: string }
  )

export type Failure =
  | ({ outcome: 'refused' } & Refusal)
  | { outcome: 'uncertain'; reason: string }
  | { outcome: 'failed'; reason: string }

/** The `detail` the host's refusals carry; the older flat fields are read when it is absent. */
function detailOf(record: Record<string, unknown>): Record<string, unknown> {
  return isRecord(record.detail) ? { ...record, ...record.detail } : record
}

/**
 * What an SDK error means. The host's terminal codes become typed refusals; a reply that never
 * came (no status, a timeout, a gateway timeout) is uncertain, because the host may have acted, and
 * so is `terminal_operation_uncertain`: the host cannot say whether a launch started a program.
 */
export function classify(error: unknown): Failure {
  const { statusCode, body } = error as { statusCode?: unknown; body?: unknown }
  const record = isRecord(body) ? body : {}
  const detail = detailOf(record)
  const code = record.code ?? record.error
  const reason = readableReason(error)
  if (typeof statusCode !== 'number') {
    return { outcome: 'uncertain', reason }
  }
  if (statusCode === 404 && code === 'terminal_session_not_found') {
    return { outcome: 'refused', code, reason }
  }
  if (statusCode === 503 && code === 'terminal_backend_unavailable') {
    const cause = typeof detail.cause === 'string' ? detail.cause : undefined
    const nextStep =
      typeof detail.next_step === 'string' ? detail.next_step : undefined
    return {
      outcome: 'refused',
      code,
      reason:
        cause === undefined
          ? reason
          : !isKnownCause(cause)
            ? cause
            : `The terminal backend cannot be used: ${causeWords(cause)}.${nextStep ? ` ${stepWords(nextStep)}` : ''}`,
      ...(typeof detail.backend === 'string'
        ? { backend: detail.backend }
        : {}),
      ...(nextStep ? { nextStep } : {}),
    }
  }
  if (statusCode === 400 && code === 'terminal_argument_refused') {
    const field = typeof detail.field === 'string' ? detail.field : undefined
    return {
      outcome: 'refused',
      code,
      reason:
        field === undefined
          ? 'The host refused a terminal argument it owns or cannot accept; nothing started.'
          : `The host refused the terminal argument "${readable(field)}": it is set by the host, not the client; nothing started.`,
      ...(field ? { field } : {}),
    }
  }
  if (statusCode === 409 && code === 'terminal_operation_uncertain') {
    return {
      outcome: 'uncertain',
      reason: `The host cannot say whether this terminal launch started a program. It was not launched again; look for the terminal in the list before launching another.${typeof detail.operation_id === 'string' ? ` (operation ${readable(detail.operation_id)})` : ''}`,
    }
  }
  if (statusCode === 409 && code === 'terminal_control_refused') {
    if (detail.reason === 'stale_epoch') {
      return { outcome: 'refused', code, reason: 'stale_epoch' }
    }
    // Any other word is a failed send, never a change of what this view may do.
    if (typeof detail.reason === 'string') {
      return {
        outcome: 'failed',
        reason: `The host refused this write (${readable(detail.reason)}); it was not written.`,
      }
    }
  }
  if (statusCode === 408 || statusCode === 502 || statusCode === 504) {
    return { outcome: 'uncertain', reason }
  }
  return { outcome: 'failed', reason }
}
