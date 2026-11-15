// SOURCING: hand-roll — the binding state machine (four separate versions, lease, reset, input ledger) is Theorem's own host contract; the SDK's TerminalChannel (0.6.0-alpha.8) now tracks epochs, leases and kill, but answers a bare boolean, reports a refused claim to a listener, mints its own input ids and has no `uncertain`, while this workbench needs the panel's `input_id` and claim and four outcomes. Transport is the SDK (host.ts); profiles are terminal-profile.ts.
import { terminalHost } from './host'
import type { InputBody, TerminalDeps, TerminalHost } from './host'
import { readable } from '../environment/redact'
import { openBody } from './terminal-profile'
import type { TheoremTerminalProfile } from './terminal-profile'
import { reason as readableReason } from '../environment/workspace-recovery'
import type { HerdrIdentity } from './protocol'
import { classify } from './wire'
import type {
  AttachReply,
  Failure,
  InputKind,
  LeaseRefusalReason,
  LeaseRole,
  Outcome,
  ProgramOrigin,
  TerminalLiveEvent,
  WireBinding,
  WriteClaim,
} from './wire'

/** The host remembers the last 256 input ids per binding; so does this module. */
const LEDGER_SIZE = 256

export type TerminalPhase =
  'idle' | 'opening' | 'attached' | 'detached' | 'exited' | 'lost'

/**
 * Everything this session knows. The four versions are four fields and are never compared with
 * one another: `streamEpoch` (the host's live stream), `bindingEpoch` (one byte log and screen),
 * `program` (which process incarnation) and `lease.generation` (who may write).
 */
export interface TerminalState {
  profile: TheoremTerminalProfile | undefined
  terminalId: string | undefined
  phase: TerminalPhase
  /** The browser's link to the host's live stream, not the program's liveness. */
  connection: 'connected' | 'reconnecting'
  cols: number | undefined
  rows: number | undefined
  /** Absolute offset of the next byte this session has not applied, within the current binding epoch. */
  offset: number
  streamEpoch: string | undefined
  bindingEpoch: number | undefined
  program: number | undefined
  origin: ProgramOrigin | undefined
  /** What the host reported (`host` or `herdr-core`); absent when it did not. */
  processOwnedBy: string | undefined
  lease: {
    role: LeaseRole
    generation: number | undefined
    held: boolean
    attachment: string | undefined
  }
  exit:
    | {
        reason: string
        code: number | null | undefined
        signal: number | null | undefined
      }
    | undefined
}

export type TerminalEvent =
  | {
      type: 'opened'
      terminalId: string
      origin: ProgramOrigin
      bindingEpoch: number | undefined
      program: number | undefined
    }
  | {
      type: 'adopted'
      terminalId: string
      bindingEpoch: number | undefined
      program: number | undefined
    }
  | {
      type: 'output'
      offset: number
      bytes: Uint8Array
      epoch: number | undefined
    }
  /** Discard the screen and replay `formatted`; it already includes everything up to the next `output`. */
  | { type: 'reset'; formatted: string; epoch: number | undefined }
  | { type: 'lease'; lease: TerminalState['lease'] }
  | { type: 'resized'; cols: number; rows: number }
  | {
      type: 'exited'
      reason: string
      code: number | null | undefined
      signal: number | null | undefined
    }
  /** The program or its session is gone and cannot be resumed. A new program is a new `open`. */
  | { type: 'lost'; cause: 'program_lost' | 'session_gone' | 'stream_closed' }
  | { type: 'reconnected' }

export interface OpenOptions {
  profile: TheoremTerminalProfile | undefined
  cols: number
  rows: number
  name?: string
  /** The lease to ask for with the first attach. Default `controller`: the opener types. */
  role?: 'controller' | 'observer'
  /** The caller's own attachment name for the attach that follows the launch, sent to the host unchanged. */
  attachment?: string
  /** Reuse after an uncertain launch so the gateway can recognise the same request (host behaviour unverified). */
  idempotencyKey?: string
}

export interface Bound {
  terminalId: string
  bindingEpoch: number | undefined
  program: number | undefined
}

const decode = (base64: string) =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))

/** The bytes of a frame the host sent as base64, or undefined when it is not base64: never a guess at another encoding. */
function frameBytes(data: unknown): Uint8Array | undefined {
  if (typeof data !== 'string') return undefined
  try {
    return decode(data)
  } catch {
    return undefined
  }
}

const quoted = (value: unknown) => readable(String(value))

/**
 * Why a host answer is not from the backend that was asked for, or undefined when it is (or names
 * no backend at all; capabilities, read before a Herdr launch, are the positive evidence).
 */
function backendMismatch(
  wanted: 'native' | 'herdr',
  reply: {
    backend?: unknown
    binding?: { backend?: unknown } | undefined
    process_owned_by?: unknown
  },
): string | undefined {
  const owner = wanted === 'herdr' ? 'herdr-core' : 'host'
  const told = [
    ['backend', reply.backend, wanted],
    ['binding.backend', reply.binding?.backend, wanted],
    ['process_owned_by', reply.process_owned_by, owner],
  ] as const
  const wrong = told.find(
    ([, value, expected]) => value !== undefined && value !== expected,
  )
  return wrong
    ? `${wrong[0]} is "${quoted(wrong[1])}", not "${wrong[2]}"`
    : undefined
}

/** Why an attach answer cannot be read as the host's JSON reply, or undefined when it can. */
function attachProblem(reply: unknown): string | undefined {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) {
    return 'it is not a JSON object'
  }
  const { offset_start, offset_end, data, epoch } = reply as Record<
    string,
    unknown
  >
  if (!Number.isFinite(offset_start) || !Number.isFinite(offset_end)) {
    return 'it carries no byte offsets'
  }
  if (data !== undefined && frameBytes(data) === undefined) {
    return 'its data is not base64'
  }
  if (epoch !== undefined && typeof epoch !== 'number') {
    return 'its epoch is not a number'
  }
  return undefined
}

function programOf(binding: Pick<WireBinding, 'program'> | undefined): {
  program?: number
  origin?: ProgramOrigin
} {
  const raw = binding?.program
  if (typeof raw === 'number') {
    return { program: raw }
  }
  return raw
    ? { program: raw.generation, ...(raw.origin ? { origin: raw.origin } : {}) }
    : {}
}

/** A claim a caller drew its write against: the attachment and the lease generation and epoch it believes current. */
interface SuppliedClaim {
  attachment: string
  leaseGeneration: number
  epoch: number
}

interface Sent {
  /** Text or exact bytes, as the first send chose; a resend uses the same one. */
  body: InputBody
  kind: InputKind
  claim: WriteClaim
  /** No reply was seen, so the host may or may not have written it. */
  uncertain: boolean
}

/** One terminal binding: its open, attach, input, lease and end, as the host's contract defines them. */
export class TerminalSession {
  private current: TerminalState = {
    profile: undefined,
    terminalId: undefined,
    phase: 'idle',
    connection: 'connected',
    cols: undefined,
    rows: undefined,
    offset: 0,
    streamEpoch: undefined,
    bindingEpoch: undefined,
    program: undefined,
    origin: undefined,
    processOwnedBy: undefined,
    lease: {
      role: 'unleased',
      generation: undefined,
      held: false,
      attachment: undefined,
    },
    exit: undefined,
  }
  private readonly listeners = new Set<(event: TerminalEvent) => void>()
  private readonly stops: (() => void)[] = []
  private readonly ledger = new Map<string, Sent>()
  /** Names this session sent that the host replaced with one it minted, with the binding epoch they were replaced in. */
  private readonly superseded = new Map<string, number | undefined>()
  private catchingUp: Promise<Outcome<Bound>> | undefined
  private linkWasDown = false

  constructor(private readonly host: TerminalHost) {}

  static from(deps: TerminalDeps): TerminalSession {
    return new TerminalSession(terminalHost(deps))
  }

  get state(): Readonly<TerminalState> {
    return this.current
  }

  subscribe(listener: (event: TerminalEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Start a new program and attach to it. A launch with no reply is `uncertain` and is never
   * repeated here: the host has no lookup, so the caller decides, and an adoption announcement
   * may show the program that did start.
   */
  async open(options: OpenOptions): Promise<Outcome<Bound>> {
    this.current.profile = options.profile
    this.current.phase = 'opening'
    const wanted = options.profile?.backend ?? 'native'
    if (wanted === 'herdr') {
      // A Herdr terminal is started only on a host that reports the core this client is pinned to;
      // otherwise nothing is sent, and no native shell stands in for it.
      const core = await this.host.herdr().catch((error): HerdrIdentity => ({
        supported: false,
        reason: `The host's Herdr identity could not be read: ${readableReason(error)}`,
      }))
      if (!core.supported) {
        this.current.phase = 'idle'
        return this.answer({
          outcome: 'refused',
          code: 'terminal_protocol_unsupported',
          reason: core.reason,
        })
      }
    }
    const body = {
      ...openBody(options.profile, options.cols, options.rows),
      ...(options.name ? { name: options.name } : {}),
    }
    let reply
    try {
      reply = await this.host.open(
        body,
        options.idempotencyKey ?? crypto.randomUUID(),
      )
    } catch (error) {
      this.current.phase = 'idle'
      return this.answer(classify(error))
    }
    const mismatch = backendMismatch(wanted, reply)
    if (mismatch) {
      this.current.phase = 'idle'
      // The host has started something, but not what was asked for: it is not bound, attached or typed to.
      return this.answer({
        outcome: 'refused',
        code: 'terminal_reply_mismatch',
        reason: `A ${wanted} terminal was asked for and the host answered as another backend (${mismatch}); terminal ${quoted(reply.session)} is not attached and nothing is sent to it`,
      })
    }
    const { program } = programOf(reply.binding)
    Object.assign(this.current, {
      terminalId: reply.session,
      cols: reply.cols ?? options.cols,
      rows: reply.rows ?? options.rows,
      bindingEpoch: reply.binding?.epoch,
      program,
      origin: 'launched',
      processOwnedBy: reply.process_owned_by,
      offset: 0,
    })
    if (options.attachment) this.current.lease.attachment = options.attachment
    this.listen()
    this.emit({
      type: 'opened',
      terminalId: reply.session,
      origin: 'launched',
      bindingEpoch: this.current.bindingEpoch,
      program,
    })
    // The program is running now; if this attach fails the caller still holds its id and can attach again.
    return this.catchUp({ role: options.role ?? 'controller', from: 0 })
  }

  /**
   * Reach a program that already exists, for example after a reload. Observing never moves the lease.
   * `attachment` is the caller's own, sent to the host unchanged; the session mints none.
   */
  async attach(options: {
    terminalId: string
    fromOffset: number
    role?: 'controller' | 'observer'
    attachment?: string
  }): Promise<Outcome<Bound>> {
    this.stopListening()
    this.superseded.clear()
    Object.assign(this.current, {
      terminalId: options.terminalId,
      offset: options.fromOffset,
      phase: 'opening',
      exit: undefined,
    })
    if (options.attachment) this.current.lease.attachment = options.attachment
    this.listen()
    return this.catchUp({
      role: options.role ?? 'observer',
      from: options.fromOffset,
    })
  }

  /**
   * Type. Only the controller may; anyone else is refused here with the host's reason and nothing
   * is sent. The caller mints `inputId` (the terminal panel does, once per logical input) and may
   * name the `claim` it believes current; neither is rewritten. The id is fresh only when the caller
   * names none. A repeat of an id whose acknowledgement was lost resends the original body, claim
   * included, so the host writes it once; a repeat of an id already answered sends nothing.
   */
  async input(
    bytes: string,
    kind: InputKind = 'human',
    options: {
      inputId?: string
      claim?: SuppliedClaim
    } = {},
  ): Promise<
    Outcome<{ inputId: string; duplicate: boolean; discarded: boolean }>
  > {
    return this.enter(options, kind, async () => ({ bytes }))
  }

  /**
   * Type exact bytes (base64), which need not be UTF-8: sent as `bytes_base64` on the host's bytes
   * input, with the same id, claim and ledger as text. A host that does not list
   * `terminal.input.bytes` reads text only, so bytes that are valid UTF-8 go as that text and any
   * others are refused `missing_capability` rather than corrupted.
   */
  async inputBytes(
    base64: string,
    kind: InputKind = 'human',
    options: {
      inputId?: string
      claim?: SuppliedClaim
    } = {},
  ): Promise<
    Outcome<{ inputId: string; duplicate: boolean; discarded: boolean }>
  > {
    return this.enter(options, kind, async () => {
      if (await this.host.canInputBytes()) return { bytes_base64: base64 }
      try {
        return {
          bytes: new TextDecoder('utf-8', { fatal: true }).decode(
            decode(base64),
          ),
        }
      } catch {
        return {
          outcome: 'refused',
          code: 'missing_capability',
          reason:
            'the host does not advertise terminal.input.bytes, so it cannot take bytes that are not UTF-8 text',
        } as const
      }
    })
  }

  private async enter(
    options: { inputId?: string; claim?: SuppliedClaim },
    kind: InputKind,
    body: () => Promise<InputBody | Failure>,
  ): Promise<
    Outcome<{ inputId: string; duplicate: boolean; discarded: boolean }>
  > {
    const inputId = options.inputId ?? crypto.randomUUID()
    const known = this.ledger.get(inputId)
    if (known) {
      if (!known.uncertain) {
        return this.answer<never>({
          outcome: 'uncertain',
          reason: 'the input was already answered; not resent',
        })
      }
      return this.send(inputId, known)
    }
    const unfit = this.unfit()
    if (unfit) {
      return unfit
    }
    const chosen = await body()
    if ('outcome' in chosen) {
      return this.answer(chosen)
    }
    const claim = this.claim(options.claim)
    if ('outcome' in claim) return claim
    return this.send(inputId, {
      body: chosen,
      kind,
      claim,
      uncertain: false,
    })
  }

  async resize(
    cols: number,
    rows: number,
    options: { claim?: SuppliedClaim } = {},
  ): Promise<Outcome<{ cols: number; rows: number }>> {
    const unfit = this.unfit()
    if (unfit) {
      return unfit
    }
    const claim = this.claim(options.claim)
    if ('outcome' in claim) return claim
    return this.write(async (id) => {
      await this.host.resize({
        session: id,
        cols,
        rows,
        ...claim,
      })
      this.current.cols = cols
      this.current.rows = rows
      return { cols, rows }
    })
  }

  async paste(text: string): Promise<Outcome<{ accepted: boolean }>> {
    const unfit = this.unfit()
    if (unfit) {
      return unfit
    }
    const claim = this.claim()
    if ('outcome' in claim) return claim
    return this.write(async (id) => {
      const reply = (await this.host.paste({
        session: id,
        text,
        ...claim,
      })) as { accepted?: boolean } | undefined
      return { accepted: reply?.accepted !== false }
    })
  }

  /** Take the lease; the generation advances and a previous holder is refused from then on. */
  async requestControl(): Promise<Outcome<Bound>> {
    return this.catchUp({ role: 'controller' })
  }

  /** Give the lease up and keep watching. */
  async releaseControl(): Promise<Outcome<Bound>> {
    return this.catchUp({ role: 'observer' })
  }

  /** Close this view. The program keeps running for its other attachments and for a later attach. */
  async detach(): Promise<Outcome<{ detached: true }>> {
    this.stopListening()
    const result = await this.write(async (id) => {
      await this.host.close({
        session: id,
        ...(this.current.lease.attachment
          ? { attachment: this.current.lease.attachment }
          : {}),
      })
      return { detached: true as const }
    })
    if (this.current.phase === 'attached' || this.current.phase === 'opening') {
      this.current.phase = 'detached'
    }
    return result
  }

  /** End the program. Refused unless the host advertises `terminal.kill`; never what closing a view does. */
  async kill(): Promise<
    Outcome<{ processKilled: boolean; sessionLive: boolean }>
  > {
    if (!this.current.terminalId) {
      return this.answer({ outcome: 'failed', reason: 'no terminal is bound' })
    }
    let advertised = false
    try {
      advertised = await this.host.canKill()
    } catch (error) {
      return this.answer(classify(error))
    }
    if (!advertised) {
      return this.answer({
        outcome: 'refused',
        code: 'kill_unavailable',
        reason: 'the host does not advertise terminal.kill',
      })
    }
    return this.write(async (id) => {
      const reply = await this.host.kill(id)
      return {
        processKilled: reply.process_killed !== false,
        sessionLive: reply.session_live === true,
      }
    })
  }

  // ---- internals ----

  private answer<T>(failure: Failure): Outcome<T> {
    return {
      terminalId: this.current.terminalId,
      bindingEpoch: this.current.bindingEpoch,
      ...failure,
    }
  }

  private accepted<T>(value: T): Outcome<T> {
    return {
      terminalId: this.current.terminalId,
      bindingEpoch: this.current.bindingEpoch,
      outcome: 'accepted',
      value,
    }
  }

  /**
   * The claim a write presents. The host's own name for this attachment (the one its attach reply
   * returned) is what goes out. A caller's claim that names a name this session sent and the host
   * replaced is translated only when the replacement, the claim and the binding are the same epoch;
   * across epochs it is refused here and never guessed. Any other name is the caller's own.
   */
  private claim(supplied?: SuppliedClaim): WriteClaim | Outcome<never> {
    const { lease, bindingEpoch } = this.current
    if (!supplied) {
      return {
        attachment: lease.attachment,
        generation: lease.generation,
        epoch: bindingEpoch,
      }
    }
    const name = supplied.attachment
    if (!this.superseded.has(name) || name === lease.attachment) {
      return {
        attachment: name,
        generation: supplied.leaseGeneration,
        epoch: supplied.epoch,
      }
    }
    const replacedIn = this.superseded.get(name)
    if (
      lease.attachment &&
      replacedIn !== undefined &&
      replacedIn === supplied.epoch &&
      supplied.epoch === bindingEpoch
    ) {
      return {
        attachment: lease.attachment,
        generation: supplied.leaseGeneration,
        epoch: supplied.epoch,
      }
    }
    return this.answer({
      outcome: 'refused',
      code: 'terminal_attachment_superseded',
      reason: `The write named attachment "${name}" at binding epoch ${supplied.epoch}; the host replaced it with "${lease.attachment ?? 'none'}" (replaced in epoch ${replacedIn ?? 'unknown'}, binding is now epoch ${bindingEpoch ?? 'unknown'}), so nothing was sent`,
    })
  }

  /** The local refusal for a call that needs the lease, or a failure when there is no live program to write to. */
  private unfit(): Outcome<never> | undefined {
    const { phase, lease } = this.current
    if (phase !== 'attached') {
      return this.answer({
        outcome: 'failed',
        reason: `the terminal is ${phase}`,
      })
    }
    if (lease.role !== 'controller') {
      const reason: LeaseRefusalReason =
        lease.role === 'observer' ? 'observer' : 'unknown_attachment'
      return this.answer({
        outcome: 'refused',
        code: 'terminal_control_refused',
        reason,
      })
    }
    return undefined
  }

  /** Run a host call for the bound terminal and file its error as an outcome. */
  private async write<T>(
    call: (terminalId: string) => Promise<T>,
  ): Promise<Outcome<T>> {
    const id = this.current.terminalId
    if (!id) {
      return this.answer({ outcome: 'failed', reason: 'no terminal is bound' })
    }
    try {
      return this.accepted(await call(id))
    } catch (error) {
      const failure = classify(error)
      if (
        failure.outcome === 'refused' &&
        failure.code === 'terminal_session_not_found'
      ) {
        this.lose('session_gone')
      }
      return this.answer(failure)
    }
  }

  private async send(inputId: string, sent: Sent) {
    this.ledger.set(inputId, sent)
    const oldest = this.ledger.keys().next().value
    if (this.ledger.size > LEDGER_SIZE && oldest !== undefined) {
      this.ledger.delete(oldest)
    }
    sent.uncertain = true
    const result = await this.write(async (id) => {
      const reply = await this.host.input({
        session: id,
        ...sent.body,
        input_id: inputId,
        kind: sent.kind,
        ...sent.claim,
      })
      return {
        inputId,
        duplicate: reply.duplicate === true,
        discarded: reply.discarded === true,
      }
    })
    // Only a call with no reply may still have been written; every other answer settles it.
    if (result.outcome !== 'uncertain') {
      sent.uncertain = false
      sent.body = { bytes: '' }
    }
    return result
  }

  private emit(event: TerminalEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  private lose(cause: 'program_lost' | 'session_gone' | 'stream_closed'): void {
    if (this.current.phase === 'lost') {
      return
    }
    this.current.phase = 'lost'
    this.current.lease = {
      role: 'unleased',
      generation: undefined,
      held: false,
      attachment: undefined,
    }
    this.emit({ type: 'lost', cause })
  }

  /**
   * Read what this session has not applied. Without a role it keeps the attachment and so never
   * moves the lease. Plain catch-ups share one request.
   */
  private catchUp(options: {
    role?: 'controller' | 'observer'
    from?: number
  }): Promise<Outcome<Bound>> {
    if (!options.role && this.catchingUp) {
      return this.catchingUp
    }
    const request = this.readFrom(
      options.from ?? this.current.offset,
      options.role,
    ).finally(() => {
      if (this.catchingUp === request) {
        this.catchingUp = undefined
      }
    })
    if (!options.role) {
      this.catchingUp = request
    }
    return request
  }

  private async readFrom(
    from: number,
    role: 'controller' | 'observer' | undefined,
  ): Promise<Outcome<Bound>> {
    const id = this.current.terminalId
    if (!id) {
      return this.answer({ outcome: 'failed', reason: 'no terminal is bound' })
    }
    let reply: AttachReply
    try {
      const { attachment } = this.current.lease
      reply = await this.host.attach({
        session: id,
        from_offset: from,
        ...(attachment ? { attachment } : {}),
        ...(role ? { role } : {}),
      })
    } catch (error) {
      const failure = classify(error)
      if (
        failure.outcome === 'refused' &&
        failure.code === 'terminal_session_not_found'
      ) {
        this.lose('session_gone')
      } else if (failure.outcome === 'uncertain') {
        // A read changes nothing on the host.
        return this.answer({ outcome: 'failed', reason: failure.reason })
      }
      return this.answer(failure)
    }
    const wanted = this.current.profile?.backend
    const problem =
      attachProblem(reply) ??
      (wanted ? backendMismatch(wanted, reply) : undefined)
    if (problem) {
      // No bytes of this answer reach the screen, and it is not asked for again in another encoding.
      return this.answer({
        outcome: 'refused',
        code: 'terminal_reply_mismatch',
        reason: `The host's attach reply was not read (${problem}); none of it was applied`,
      })
    }
    this.apply(reply)
    return this.accepted({
      terminalId: id,
      bindingEpoch: this.current.bindingEpoch,
      program: this.current.program,
    })
  }

  /** Fold an attach reply in: the lease it reports, then either a reset or the bytes after our offset. */
  private apply(reply: AttachReply): void {
    const state = this.current
    const epoch = reply.epoch ?? reply.binding?.epoch
    const rebound =
      epoch !== undefined &&
      state.bindingEpoch !== undefined &&
      epoch !== state.bindingEpoch
    const before = state.lease.attachment
    // The lease control names the attachment the host holds; a bare `attachment` is only an echo.
    if (reply.control) {
      const { control } = reply
      state.lease = {
        role: control.controlling ? 'controller' : 'observer',
        generation: control.generation,
        held: control.controlled === true,
        // Older hosts omit it from the control; the bare field is then the host's name.
        attachment:
          (control as { attachment?: string }).attachment ?? reply.attachment,
      }
    } else if (reply.attachment) {
      state.lease.attachment = reply.attachment
    }
    const named = state.lease.attachment
    if (before && named && before !== named) {
      // The host minted its own name: ours is not one it knows from now on.
      this.superseded.set(
        before,
        rebound ? state.bindingEpoch : (state.bindingEpoch ?? epoch),
      )
      this.superseded.delete(named)
    }
    const { program, origin } = programOf(reply.binding)
    if (program !== undefined) {
      state.program = program
    }
    if (origin) {
      state.origin = origin
    }
    if (state.phase === 'opening') {
      state.phase = 'attached'
    }
    if (rebound || reply.truncated) {
      if (rebound) {
        this.ledger.clear()
      }
      state.bindingEpoch = epoch ?? state.bindingEpoch
      state.offset = reply.offset_end
      this.emit({
        type: 'reset',
        formatted: reply.formatted,
        epoch: state.bindingEpoch,
      })
    } else {
      state.bindingEpoch ??= epoch
      this.output(
        reply.offset_start,
        reply.data ? decode(reply.data) : new Uint8Array(),
        state.bindingEpoch,
      )
    }
    this.emit({ type: 'lease', lease: { ...state.lease } })
  }

  /** Bytes in order, each once: drop what is already applied, and catch up when there is a gap. */
  private output(
    offset: number,
    bytes: Uint8Array,
    epoch: number | undefined,
  ): void {
    const end = offset + bytes.length
    if (end <= this.current.offset) {
      return
    }
    if (offset > this.current.offset) {
      void this.catchUp({})
      return
    }
    const fresh = bytes.subarray(this.current.offset - offset)
    this.current.offset = end
    this.emit({
      type: 'output',
      offset: end - fresh.length,
      bytes: fresh,
      epoch,
    })
  }

  private listen(): void {
    this.stops.push(
      this.host.onEvent((event) => this.onLive(event)),
      this.host.onResync((resync) => {
        this.current.streamEpoch = resync.epoch
        return this.catchUp({}).then(() => undefined)
      }),
      this.host.onState((state) => this.onLink(state)),
    )
  }

  private stopListening(): void {
    for (const stop of this.stops.splice(0)) {
      stop()
    }
  }

  private onLink(link: string): void {
    if (link === 'reconnecting' || link === 'resyncing') {
      this.linkWasDown = true
      this.current.connection = 'reconnecting'
    } else if (link === 'open') {
      this.current.connection = 'connected'
      if (this.linkWasDown && this.current.phase === 'attached') {
        this.linkWasDown = false
        void this.catchUp({}).then(
          (result) =>
            result.outcome === 'accepted' && this.emit({ type: 'reconnected' }),
        )
      }
    } else if (
      link === 'closed' &&
      (this.current.phase === 'attached' || this.current.phase === 'opening')
    ) {
      this.lose('stream_closed')
    }
  }

  private onLive(event: TerminalLiveEvent): void {
    const state = this.current
    // Adoption is the workspace's, not one terminal's: the adapter's session list reads it.
    if (event.kind === 'terminal.adoption') {
      return
    }
    if (event.data.session !== state.terminalId || state.phase === 'detached') {
      return
    }
    // An epoch older than the binding's belongs to a log that is gone.
    const epoch = 'epoch' in event.data ? event.data.epoch : undefined
    if (
      epoch !== undefined &&
      state.bindingEpoch !== undefined &&
      epoch < state.bindingEpoch
    ) {
      return
    }
    const newer =
      epoch !== undefined &&
      state.bindingEpoch !== undefined &&
      epoch > state.bindingEpoch
    switch (event.kind) {
      case 'terminal.opened': {
        const { program, origin } = event.data
        const replaced =
          program !== undefined &&
          state.program !== undefined &&
          program !== state.program
        state.program ??= program
        state.origin ??= origin
        if (!newer && !replaced) {
          return
        }
        state.program = program ?? state.program
        state.origin = origin ?? state.origin
        if (origin === 'adopted') {
          this.emit({
            type: 'adopted',
            terminalId: event.data.session,
            bindingEpoch: epoch,
            program,
          })
        } else {
          this.emit({
            type: 'opened',
            terminalId: event.data.session,
            origin: origin ?? 'reattached',
            bindingEpoch: epoch,
            program,
          })
        }
        // The new epoch's repaint comes only from an attach, which names the epoch.
        void this.catchUp({ from: 0 })
        return
      }
      case 'terminal.output':
        if (newer) {
          void this.catchUp({ from: 0 })
          return
        }
        {
          const bytes = frameBytes(event.data.data)
          // A frame that is not base64 is dropped, not guessed at; the gap it leaves is caught up by an attach.
          if (bytes) this.output(event.data.offset, bytes, state.bindingEpoch)
        }
        return
      case 'terminal.resized':
        state.cols = event.data.cols
        state.rows = event.data.rows
        this.emit({
          type: 'resized',
          cols: event.data.cols,
          rows: event.data.rows,
        })
        return
      case 'terminal.exited': {
        const reason = event.data.reason ?? 'exited'
        if (reason === 'lost') {
          this.lose('program_lost')
          return
        }
        state.phase = 'exited'
        state.exit = {
          reason,
          code: event.data.exit_code,
          signal: event.data.signal,
        }
        this.emit({
          type: 'exited',
          reason,
          code: event.data.exit_code,
          signal: event.data.signal,
        })
        return
      }
      case 'terminal.control': {
        const generation = event.data.generation
        // The event names no attachment: a generation that is not ours means someone else holds the lease.
        if (generation < (state.lease.generation ?? 0)) {
          return
        }
        const displaced =
          state.lease.role === 'controller' &&
          generation !== state.lease.generation
        state.lease = {
          ...state.lease,
          generation,
          held: event.data.controlled,
          role: displaced ? 'observer' : state.lease.role,
        }
        this.emit({ type: 'lease', lease: { ...state.lease } })
        return
      }
    }
  }
}

/**
 * Terminals the host announces with `terminal.opened`, once per binding and program. Adoption of a
 * program this client did not start arrives here with origin `adopted`. The host has no list or
 * adopt operation, so this is the only discovery.
 */
export function watchAnnouncements(
  host: Pick<TerminalHost, 'onEvent'>,
  listener: (announcement: {
    terminalId: string
    origin: ProgramOrigin | undefined
    backend: string | undefined
    bindingEpoch: number | undefined
    program: number | undefined
    cols?: number
    rows?: number
  }) => void,
): () => void {
  const seen = new Set<string>()
  return host.onEvent((event) => {
    if (event.kind !== 'terminal.opened') {
      return
    }
    const { session, epoch, program, origin, backend, cols, rows } = event.data
    const key = `${session}:${epoch}:${program}`
    if (seen.has(key)) {
      return
    }
    seen.add(key)
    listener({
      terminalId: session,
      origin,
      backend,
      bindingEpoch: epoch,
      program,
      cols,
      rows,
    })
  })
}
