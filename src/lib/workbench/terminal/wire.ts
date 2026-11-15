// SOURCING: none — the host's terminal contract (docs/plans/theo-workbench/gate-0/terminal-path.md) as types, and the one outcome shape every call returns; no upstream library models either.

/** The five reasons the host refuses a keystroke, paste or resize with `terminal_control_refused`. */
export type LeaseRefusalReason =
  | 'observer'
  | 'held'
  | 'stale_generation'
  | 'stale_epoch'
  | 'unknown_attachment'

/** How the program in a binding came to be there. */
export type ProgramOrigin =
  'launched' | 'adopted' | 'replacement' | 'reattached'

/** `unleased` is a client that names no attachment; it cannot be requested. */
export type LeaseRole = 'controller' | 'observer' | 'unleased'

export type InputKind = 'human' | 'reply'

/** What the host calls a terminal binding. `program` is the incarnation: 1 = original, +1 per replacement. */
export interface WireBinding {
  backend?: string
  epoch: number
  core_id?: string
  terminal?: string
  program?: number | { generation: number; origin?: ProgramOrigin }
}

export interface WireControl {
  attachment?: string
  role?: string
  /** This attachment holds the lease. */
  controlling?: boolean
  /** Somebody holds the lease. */
  controlled?: boolean
  generation?: number
  epoch?: number
}

export interface OpenReply {
  session: string
  cols?: number
  rows?: number
  backend?: string
  binding?: WireBinding
  process_owned_by?: string
}

export interface AttachReply {
  session?: string
  attachment?: string
  control?: WireControl
  epoch?: number
  binding?: WireBinding
  /** Escape-coded repaint of the visible grid at `offset_end`. */
  formatted?: string
  screen?: string
  offset_start: number
  offset_end: number
  /** Base64 bytes from `offset_start` to `offset_end`. */
  data?: string
  /** The requested offset is no longer in the log. */
  truncated?: boolean
}

export interface InputReply {
  accepted?: boolean
  duplicate?: boolean
  discarded?: boolean
}

/** The claim a write carries so the host can refuse a stale one. */
export interface WriteClaim {
  attachment?: string
  generation?: number
  epoch?: number
}

/** Live events as the host publishes them. The SDK's typed events drop everything after `session`. */
export type TerminalLiveEvent =
  | {
      kind: 'terminal.opened'
      data: {
        session: string
        epoch?: number
        program?: number
        backend?: string
        origin?: ProgramOrigin
        cols?: number
        rows?: number
      }
    }
  | {
      kind: 'terminal.output'
      data: { session: string; epoch?: number; offset: number; data: string }
    }
  | {
      kind: 'terminal.resized'
      data: { session: string; cols: number; rows: number }
    }
  | {
      kind: 'terminal.exited'
      data: {
        session: string
        epoch?: number
        exit_code?: number | null
        signal?: string | null
        reason?: string
      }
    }
  | {
      kind: 'terminal.control'
      data: {
        session: string
        epoch?: number
        generation?: number
        controlled?: boolean
      }
    }

/** Each refusal the host or this module can give. */
export type Refusal =
  | { code: 'terminal_control_refused'; reason: LeaseRefusalReason }
  | { code: 'terminal_backend_unavailable'; reason: string; backend?: string }
  | { code: 'terminal_session_not_found'; reason: string }
  /** The host does not advertise `terminal.kill`, or no generic operation call was supplied. */
  | { code: 'kill_unavailable'; reason: string }

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

const LEASE_REASONS: ReadonlySet<string> = new Set([
  'observer',
  'held',
  'stale_generation',
  'stale_epoch',
  'unknown_attachment',
])

function describe(error: unknown, body: unknown): string {
  if (body && typeof body === 'object') {
    const text =
      (body as { message?: unknown; cause?: unknown; reason?: unknown })
        .message ?? (body as { cause?: unknown }).cause
    if (typeof text === 'string' && text) {
      return text
    }
  }
  if (typeof body === 'string' && body) {
    return body
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * What an SDK error means. The host's three terminal codes become typed refusals; a reply that never
 * came (no status, a timeout, a gateway timeout) is uncertain, because the host may have acted.
 */
export function classify(error: unknown): Failure {
  const { statusCode, body } = error as { statusCode?: unknown; body?: unknown }
  const record =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const code = record.code ?? record.error
  const reason = describe(error, body)
  if (typeof statusCode !== 'number') {
    return { outcome: 'uncertain', reason }
  }
  if (statusCode === 404 && code === 'terminal_session_not_found') {
    return { outcome: 'refused', code, reason }
  }
  if (statusCode === 503 && code === 'terminal_backend_unavailable') {
    return {
      outcome: 'refused',
      code,
      reason: typeof record.cause === 'string' ? record.cause : reason,
      ...(typeof record.backend === 'string'
        ? { backend: record.backend }
        : {}),
    }
  }
  if (
    statusCode === 409 &&
    code === 'terminal_control_refused' &&
    typeof record.reason === 'string' &&
    LEASE_REASONS.has(record.reason)
  ) {
    return {
      outcome: 'refused',
      code,
      reason: record.reason as LeaseRefusalReason,
    }
  }
  if (statusCode === 408 || statusCode === 502 || statusCode === 504) {
    return { outcome: 'uncertain', reason }
  }
  return { outcome: 'failed', reason }
}
