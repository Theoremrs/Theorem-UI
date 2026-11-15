// SOURCING: @theoremharness/sdk-ide for the host's terminal types (attach reply, binding, lease, modes, list, adoption, live events); the outcome shape every call returns and the refusal reading are this workbench's own (docs/plans/theo-workbench/gate-0/terminal-path.md), and no upstream library models them.
import type { Theorem, WorkspaceLiveEvent } from '@theoremharness/sdk-ide'
import { reason as readableReason } from '../environment/workspace-recovery'

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

/**
 * What `terminal.attach` answers, as the SDK types it: the offsets and bytes, the binding (one
 * `program` number), the lease `control`, the screen `modes` and the repaint.
 */
export type AttachReply = Theorem.IdeTerminalAttachReply

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

const TERMINAL_KINDS = [
  'terminal.adoption',
  'terminal.opened',
  'terminal.output',
  'terminal.resized',
  'terminal.exited',
  'terminal.control',
] as const

/** Every terminal event the host publishes, as the SDK types the live stream. */
export type TerminalLiveEvent = {
  [K in (typeof TERMINAL_KINDS)[number]]: WorkspaceLiveEvent<K>
}[(typeof TERMINAL_KINDS)[number]]

export const isTerminalEvent = (
  event: WorkspaceLiveEvent,
): event is TerminalLiveEvent =>
  (TERMINAL_KINDS as readonly string[]).includes(event.kind)

/** Each refusal the host or this module can give. */
export type Refusal =
  | { code: 'terminal_control_refused'; reason: LeaseRefusalReason }
  | { code: 'terminal_backend_unavailable'; reason: string; backend?: string }
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

const LEASE_REASONS: ReadonlySet<string> = new Set([
  'observer',
  'held',
  'stale_generation',
  'stale_epoch',
  'unknown_attachment',
])

/**
 * What an SDK error means. The host's three terminal codes become typed refusals; a reply that never
 * came (no status, a timeout, a gateway timeout) is uncertain, because the host may have acted.
 */
export function classify(error: unknown): Failure {
  const { statusCode, body } = error as { statusCode?: unknown; body?: unknown }
  const record =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const code = record.code ?? record.error
  const reason = readableReason(error)
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
