// SOURCING: hand-roll — the binding state machine (three separate versions, reset, input ledger) is Theorem's own host contract; the SDK's TerminalChannel (0.6.0-alpha.8) tracks epochs and kill, but answers a bare boolean, reports a refused claim to a listener, mints its own input ids and has no `uncertain`, while this workbench needs the panel's `input_id` and claim and four outcomes. Transport is the SDK (host.ts); profiles are terminal-profile.ts.
import { terminalHost } from './host'
import type { InputBody, TerminalDeps, TerminalHost } from './host'
import { readable } from '../environment/redact'
import { openBody } from './terminal-profile'
import type { TheoremTerminalProfile } from './terminal-profile'
import { reason as readableReason } from '../environment/workspace-recovery'
import type { HerdrIdentity } from './protocol'
import { classify, lostWords, readConnectivity } from './wire'
import { parseProgramReport, replaces, UNAVAILABLE } from './program-report'
import type { ProgramReport } from './program-report'
import type {
  AttachReply,
  Connectivity,
  Failure,
  InputKind,
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
 * Everything this session knows. The three versions are three fields and are never compared with
 * one another: `streamEpoch` (the host's live stream), `bindingEpoch` (one byte log and screen) and
 * `program` (which process incarnation). Every view of a terminal may type, paste and resize.
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
  /**
   * What the program says about itself (R32). Plain data about the program's own word: it is never read by the
   * lifecycle, the attachment or the input check, and it is never a command, approval or task.
   */
  programReport: ProgramReport
  /**
   * Whether the host can reach the terminal's core. `lost` means the process outcome is unknown, not that it
   * exited, and it is not `phase: 'lost'` (a program that cannot be resumed): it clears when the host says
   * `running`.
   */
  connectivity: Connectivity
  /** The host's name for this view's attachment: what every write claims and a detach closes. */
  attachment: string | undefined
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
  | { type: 'resized'; cols: number; rows: number }
  | {
      type: 'exited'
      reason: string
      code: number | null | undefined
      signal: number | null | undefined
    }
  /** The program or its session is gone and cannot be resumed. A new program is a new `open`. `reason` is the host's own word when it gave one beyond `lost` (`scope_removed`). */
  | {
      type: 'lost'
      cause: 'program_lost' | 'session_gone' | 'stream_closed'
      reason?: string
    }
  /** The host can no longer reach (or can again reach) the terminal's core. Loss is not exit; `words` is what a person reads. */
  | {
      type: 'connectivity'
      terminalId: string
      bindingEpoch: number | undefined
      connectivity: Connectivity
      words: string | undefined
    }
  | { type: 'reconnected' }
  /** The program's report for this binding changed. Informational only. */
  | {
      type: 'report'
      terminalId: string
      bindingEpoch: number | undefined
      report: ProgramReport
    }

export interface OpenOptions {
  profile: TheoremTerminalProfile | undefined
  cols: number
  rows: number
  name?: string
  /** The caller's own attachment name for the attach that follows the launch, sent to the host unchanged. */
  attachment?: string
  /**
   * One value per launch intent, reused on a retry of the same intent. It is sent as the launch's
   * `operation_id` (the host returns the first reply for a repeat and never launches twice) and as
   * the gateway's idempotency key. Minted once here when the caller names none; nonempty, at most 256 bytes.
   */
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

/** A claim a caller drew its write against: the attachment and binding epoch it believes current. */
interface SuppliedClaim {
  attachment: string
  epoch: number
}

interface Sent {
  /** Text or exact bytes, as the first send chose; a resend uses the same one. */
  body: InputBody
  kind: InputKind
  claim: WriteClaim
  /** No reply was seen (or the host said it cannot tell), so the host may or may not have written it. */
  uncertain: boolean
  /** The binding epoch it was sent in; a repeat in another epoch is never sent. */
  epoch: number | undefined
  /** Set when the host itself reported the outcome unknown: the input is never sent again. */
  blocked?: string
}

/** One terminal binding: its open, attach, input and end, as the host's contract defines them. */
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
    programReport: UNAVAILABLE,
    connectivity: { state: 'running' },
    attachment: undefined,
    exit: undefined,
  }
  private readonly listeners = new Set<(event: TerminalEvent) => void>()
  private readonly stops: (() => void)[] = []
  private readonly ledger = new Map<string, Sent>()
  /** The last input sent: the next waits for its answer, so keys reach the host in typed order. */
  private inputTail: Promise<unknown> = Promise.resolve()
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
    // One id per launch intent: a retry of the same intent names the same one, so the host never launches twice.
    const operationId = options.idempotencyKey ?? crypto.randomUUID()
    if (
      operationId === '' ||
      new TextEncoder().encode(operationId).length > 256
    ) {
      this.current.phase = 'idle'
      return this.answer({
        outcome: 'refused',
        code: 'terminal_argument_refused',
        field: 'operation_id',
        reason:
          'The launch id must be nonempty and at most 256 bytes; nothing was sent',
      })
    }
    const body = {
      ...openBody(options.profile, options.cols, options.rows),
      ...(options.name ? { name: options.name } : {}),
      operation_id: operationId,
    }
    let reply
    try {
      reply = await this.host.open(body, operationId)
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
      programReport: parseProgramReport(reply.program_report),
      connectivity: { state: 'running' },
      offset: 0,
    })
    if (options.attachment) this.current.attachment = options.attachment
    this.listen()
    this.emit({
      type: 'opened',
      terminalId: reply.session,
      origin: 'launched',
      bindingEpoch: this.current.bindingEpoch,
      program,
    })
    // The program is running now; if this attach fails the caller still holds its id and can attach again.
    this.catchingUp = undefined
    return this.catchUp(0)
  }

  /**
   * Reach a program that already exists, for example after a reload. `attachment` is the caller's
   * own, sent to the host unchanged; the session mints none.
   */
  async attach(options: {
    terminalId: string
    fromOffset: number
    attachment?: string
  }): Promise<Outcome<Bound>> {
    this.stopListening()
    this.superseded.clear()
    Object.assign(this.current, {
      terminalId: options.terminalId,
      offset: options.fromOffset,
      phase: 'opening',
      exit: undefined,
      connectivity: { state: 'running' },
    })
    if (options.attachment) this.current.attachment = options.attachment
    this.listen()
    this.catchingUp = undefined
    return this.catchUp(options.fromOffset)
  }

  /**
   * Type. Any view may. The caller mints `inputId` (the terminal panel does, once per logical input) and may
   * name the `claim` it believes current; neither is rewritten. The id is fresh only when the caller
   * names none. A repeat of an id whose acknowledgement was lost resends the original body, claim
   * included, so the host writes it once; a repeat of an id already answered sends nothing. An input
   * whose outcome is unknown is sent again only by that explicit repeat, and only when the repeat is still
   * the same input: the same binding epoch, an attachment name the host has not replaced, a reachable
   * core and an outcome the host did not itself call uncertain. Otherwise nothing is sent and it stays
   * `uncertain`; this module never repeats an input on its own.
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
      const stale = this.notResendable(known)
      if (stale) {
        return this.answer<never>({ outcome: 'uncertain', reason: stale })
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
      epoch: this.current.bindingEpoch,
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

  /** Close this view. The program keeps running for its other attachments and for a later attach. */
  async detach(): Promise<Outcome<{ detached: true }>> {
    this.stopListening()
    const result = await this.write(async (id) => {
      await this.host.close({
        session: id,
        ...(this.current.attachment
          ? { attachment: this.current.attachment }
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
    const { attachment, bindingEpoch } = this.current
    if (!supplied) {
      return { attachment, epoch: bindingEpoch }
    }
    const name = supplied.attachment
    if (!this.superseded.has(name) || name === attachment) {
      return { attachment: name, epoch: supplied.epoch }
    }
    const replacedIn = this.superseded.get(name)
    if (
      attachment &&
      replacedIn !== undefined &&
      replacedIn === supplied.epoch &&
      supplied.epoch === bindingEpoch
    ) {
      return { attachment, epoch: supplied.epoch }
    }
    return this.answer({
      outcome: 'refused',
      code: 'terminal_attachment_superseded',
      reason: `The write named attachment "${name}" at binding epoch ${supplied.epoch}; the host replaced it with "${attachment ?? 'none'}" (replaced in epoch ${replacedIn ?? 'unknown'}, binding is now epoch ${bindingEpoch ?? 'unknown'}), so nothing was sent`,
    })
  }

  /** A failure when there is no live program to write to, or the refusal when its core cannot be reached. */
  private unfit(): Outcome<never> | undefined {
    const { phase } = this.current
    if (phase !== 'attached') {
      return this.answer({
        outcome: 'failed',
        reason: `the terminal is ${phase}`,
      })
    }
    const { connectivity } = this.current
    if (connectivity.state === 'lost') {
      return this.answer({
        outcome: 'refused',
        code: 'terminal_core_lost',
        reason: `${lostWords(connectivity.reason, connectivity.nextStep)} Nothing was sent.`,
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
    const receipt = { uncertain: false }
    const turn = this.inputTail.then(() =>
      this.write(async (id) => {
        const reply = await this.host.input({
          session: id,
          ...sent.body,
          input_id: inputId,
          kind: sent.kind,
          ...sent.claim,
        })
        // The receipt itself can say the bytes may or may not have been delivered.
        receipt.uncertain =
          reply.uncertain === true || reply.code === 'terminal_input_uncertain'
        return {
          inputId,
          duplicate: reply.duplicate === true,
          discarded: reply.discarded === true,
        }
      }),
    )
    this.inputTail = turn.catch(() => undefined)
    const result = await turn
    if (receipt.uncertain && result.outcome === 'accepted') {
      sent.blocked =
        'The host cannot say whether these keystrokes reached the program (terminal_input_uncertain). They were not sent again; look at the screen and type them again only if they are missing'
      sent.body = { bytes: '' }
      return this.answer<never>({
        outcome: 'uncertain',
        reason: sent.blocked,
      })
    }
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

  private lose(
    cause: 'program_lost' | 'session_gone' | 'stream_closed',
    reason?: string,
  ): void {
    if (this.current.phase === 'lost') {
      return
    }
    this.current.phase = 'lost'
    this.current.attachment = undefined
    this.emit({ type: 'lost', cause, ...(reason ? { reason } : {}) })
  }

  /** Sets what the host says about reaching the core, and says so when it changed. Never touches the phase, the attachment or the report. */
  private connect(next: Connectivity): void {
    const state = this.current
    if (JSON.stringify(next) === JSON.stringify(state.connectivity)) return
    state.connectivity = next
    if (state.terminalId)
      this.emit({
        type: 'connectivity',
        terminalId: state.terminalId,
        bindingEpoch: state.bindingEpoch,
        connectivity: next,
        words:
          next.state === 'lost'
            ? lostWords(next.reason, next.nextStep)
            : undefined,
      })
  }

  /** Why an input whose outcome is unknown must not be sent again now, or undefined when the same input may be repeated. */
  private notResendable(sent: Sent): string | undefined {
    const { attachment, bindingEpoch, connectivity } = this.current
    if (sent.blocked) return sent.blocked
    if (sent.epoch !== bindingEpoch) {
      return `The terminal was rebound (binding epoch ${sent.epoch ?? 'unknown'} to ${bindingEpoch ?? 'unknown'}) after this input was sent, so whether it arrived is unknown; it was not sent again`
    }
    const named = sent.claim.attachment
    if (
      named !== undefined &&
      named !== attachment &&
      this.superseded.has(named)
    ) {
      return `The host replaced the attachment name "${named}" this input was sent under, so a repeat would not be the same input; it was not sent again`
    }
    if (connectivity.state === 'lost') {
      return `${lostWords(connectivity.reason, connectivity.nextStep)} Whether this input arrived is unknown; it was not sent again`
    }
    return undefined
  }

  /** Read what this session has not applied. Catch-ups share one request; open and attach start a fresh one. */
  private catchUp(from?: number): Promise<Outcome<Bound>> {
    if (this.catchingUp) {
      return this.catchingUp
    }
    const request = this.readFrom(from ?? this.current.offset).finally(() => {
      if (this.catchingUp === request) {
        this.catchingUp = undefined
      }
    })
    this.catchingUp = request
    return request
  }

  private async readFrom(from: number): Promise<Outcome<Bound>> {
    const id = this.current.terminalId
    if (!id) {
      return this.answer({ outcome: 'failed', reason: 'no terminal is bound' })
    }
    let reply: AttachReply
    try {
      const { attachment } = this.current
      reply = await this.host.attach({
        session: id,
        from_offset: from,
        ...(attachment ? { attachment } : {}),
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
    const { connectivity } = this.current
    if (connectivity.state === 'lost') {
      // Attached to the host's record, not to a live stream, and it launched nothing: not a live terminal.
      return this.answer({
        outcome: 'refused',
        code: 'terminal_core_lost',
        reason: lostWords(connectivity.reason, connectivity.nextStep),
      })
    }
    return this.accepted({
      terminalId: id,
      bindingEpoch: this.current.bindingEpoch,
      program: this.current.program,
    })
  }

  /** Fold an attach reply in: the attachment name it reports, then either a reset or the bytes after our offset. */
  private apply(reply: AttachReply): void {
    const state = this.current
    const epoch = reply.epoch ?? reply.binding?.epoch
    const rebound =
      epoch !== undefined &&
      state.bindingEpoch !== undefined &&
      epoch !== state.bindingEpoch
    // A new binding epoch takes its whole report from this reply, absence included; within one epoch only a reply that carries a report replaces it.
    if (
      (reply as { program_report?: unknown }).program_report !== undefined ||
      rebound
    ) {
      this.report(
        parseProgramReport(
          (reply as { program_report?: unknown }).program_report,
        ),
      )
    }
    // The host states connectivity under the same lock as the screen; an answer that says none (an older
    // host) claims no loss.
    this.connect(readConnectivity(reply) ?? { state: 'running' })
    const before = state.attachment
    // An older host names its attachment inside `control`; the bare field is otherwise the host's name.
    const named =
      (reply.control as { attachment?: string } | undefined)?.attachment ??
      reply.attachment ??
      before
    state.attachment = named
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
      // An input sent in an older epoch stays in the ledger: a repeat of it is never sent into this one.
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
      void this.catchUp()
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
        return this.catchUp().then(() => undefined)
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
        void this.catchUp().then(
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

  /** Sets the report and says so when it changed. Nothing else is read or written. */
  private report(next: ProgramReport): void {
    const state = this.current
    if (JSON.stringify(next) === JSON.stringify(state.programReport)) return
    state.programReport = next
    if (state.terminalId)
      this.emit({
        type: 'report',
        terminalId: state.terminalId,
        bindingEpoch: state.bindingEpoch,
        report: next,
      })
  }

  /** `terminal.updated`: replaces the report for the current binding epoch and no other (omission clears it). */
  private onUpdated(data: {
    epoch?: unknown
    program_report?: unknown
    state?: unknown
    reason?: unknown
    next_step?: unknown
  }): void {
    const { bindingEpoch } = this.current
    if (bindingEpoch === undefined || data.epoch !== bindingEpoch) return
    // Connectivity first, and only when the update states it: an update without `state` changes none.
    const stated = readConnectivity(data)
    if (stated) this.connect(stated)
    const update = parseProgramReport(data.program_report)
    // An update with no report clears what was held; the host then says nothing, which is `unavailable`, not any word.
    if (replaces(this.current.programReport, update)) this.report(update)
  }

  private onLive(event: TerminalLiveEvent): void {
    const state = this.current
    // Adoption and what is on offer are the workspace's, not one terminal's: the adapter's session
    // list reads them.
    if (
      event.kind === 'terminal.adoption' ||
      event.kind === 'terminal.unadmitted'
    ) {
      return
    }
    if (event.data.session !== state.terminalId || state.phase === 'detached') {
      return
    }
    if (event.kind === 'terminal.updated') {
      this.onUpdated(event.data)
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
        // A full recovery arrives as a new epoch and says `running`; so does an announcement that names none.
        this.connect(readConnectivity(event.data) ?? { state: 'running' })
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
        void this.catchUp(0)
        return
      }
      case 'terminal.output':
        if (newer) {
          void this.catchUp(0)
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
        const word = (event.data as { state?: unknown }).state
        // `state: lost` is a retired binding whose outcome is unknown (also `scope_removed`); `gone` and `exited` are ends.
        // An older host names no state and says `lost` in the reason.
        if (
          word === 'lost' ||
          (word === undefined &&
            (reason === 'lost' || reason === 'scope_removed'))
        ) {
          this.lose('program_lost', reason === 'lost' ? undefined : reason)
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
