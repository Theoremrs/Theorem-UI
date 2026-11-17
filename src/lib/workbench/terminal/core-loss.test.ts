// SOURCING: none — bun:test over ./wire, ./host and ./session through the shared test rig; the fixtures are the backend document's own examples (./fixtures/core-loss).
import { describe, expect, test } from 'bun:test'
import { terminalHost } from './host'
import type { TerminalDeps } from './host'
import {
  ADOPTION_UNAVAILABLE_EVENT,
  ARGUMENT_REFUSED_CWD,
  ATTACH_LOST_FRAGMENT,
  ATTACH_RUNNING_FRAGMENT,
  BACKEND_UNAVAILABLE,
  CONTROL_REFUSED_HELD,
  EXITED_EXITED,
  EXITED_GONE,
  EXITED_SCOPE_REMOVED,
  HOST_OWNED_FIELDS,
  INPUT_UNCERTAIN_RECEIPT,
  LAUNCH_BODY,
  LOST_LIST_ROW,
  OPENED_REATTACHED_FRAGMENT,
  OPERATION_UNCERTAIN,
  UPDATED_CORE_CLOSED,
  UPDATED_CORE_UNAVAILABLE,
  UPDATED_RUNNING,
  UPDATED_SUBSCRIBE_TIMED_OUT,
} from './fixtures/core-loss'
import { classify, lostWords, readConnectivity } from './wire'
import { profileById } from './terminal-profile'
import { rig } from './test-rig'

class HostError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly body?: unknown,
  ) {
    super(`HTTP ${statusCode}`)
  }
}

type Rig = ReturnType<typeof rig>

const BINDING = {
  backend: 'herdr',
  epoch: 2,
  program: 1,
  core_id: 'core-example',
  terminal: 't1',
}
const OPEN_REPLY = {
  session: 'hc-example',
  cols: 80,
  rows: 24,
  backend: 'herdr',
  binding: BINDING,
  process_owned_by: 'herdr-core',
}
const attachReply = (extra: Record<string, unknown> = {}) => ({
  session: 'hc-example',
  attached: true,
  attachment: 'ta-1',
  control: {
    attachment: 'ta-1',
    role: 'controller',
    controlling: true,
    controlled: true,
    generation: 1,
    epoch: 2,
  },
  backend: 'herdr',
  epoch: 2,
  binding: BINDING,
  formatted: '',
  offset_start: 0,
  offset_end: 5,
  data: btoa('ready'),
  ...extra,
})

/** An opened, attached Herdr view on `hc-example`, binding epoch 2. */
async function attached(): Promise<Rig> {
  const r = rig()
  r.handlers.open = () => OPEN_REPLY
  r.handlers.attach = () => attachReply()
  r.handlers.input = () => ({ accepted: true })
  const done = await r.session.open({
    profile: profileById('Herdr shell'),
    cols: 80,
    rows: 24,
  })
  expect(done.outcome).toBe('accepted')
  r.events.length = 0
  return r
}

/** Attach again to the same terminal from what is applied, as the pane does to recover. */
const reattach = (r: Rig) =>
  r.session.attach({
    terminalId: 'hc-example',
    fromOffset: r.session.state.offset,
  })

const emit = (r: Rig, frame: { kind: string; data: unknown }) =>
  r.emit(frame.kind, frame.data as Record<string, unknown>)

const CAUSES = [
  [UPDATED_CORE_CLOSED, 'core_closed', 'the core closed the connection'],
  [UPDATED_CORE_UNAVAILABLE, 'core_unavailable', 'the core cannot be reached'],
  [
    UPDATED_SUBSCRIBE_TIMED_OUT,
    'subscribe_timed_out',
    'the core did not answer the subscription in time',
  ],
] as const

describe('1. terminal.updated connectivity', () => {
  for (const [frame, reason, words] of CAUSES) {
    test(`${reason}: lost, not exited, with the cause in plain words and retry as the next step`, async () => {
      const r = await attached()
      emit(r, frame)
      expect(r.session.state.connectivity).toEqual({
        state: 'lost',
        reason,
        nextStep: 'retry',
      })
      // Loss is not an end: the phase, the attachment and the binding are untouched.
      expect(r.session.state.phase).toBe('attached')
      expect(r.session.state.bindingEpoch).toBe(2)
      expect(r.session.state.attachment).toBe('ta-1')
      expect(r.events.map((event) => event.type)).not.toContain('exited')
      expect(r.events.map((event) => event.type)).not.toContain('lost')
      const event = r.events.find((entry) => entry.type === 'connectivity')
      expect(event).toMatchObject({
        terminalId: 'hc-example',
        bindingEpoch: 2,
        connectivity: { state: 'lost', reason, nextStep: 'retry' },
      })
      expect((event as { words: string }).words).toBe(
        `Connection to the terminal lost: ${words}. The program may still be running; its outcome is not known. Retry to reconnect.`,
      )
    })
  }

  test('the program report on the same update is kept, whatever it says', async () => {
    const r = await attached()
    emit(r, {
      kind: 'terminal.updated',
      data: {
        ...UPDATED_CORE_CLOSED.data,
        program_report: {
          reported: true,
          status: { state: 'working', msg: 'building' },
          seq: 3,
        },
      },
    })
    expect(r.session.state.connectivity.state).toBe('lost')
    expect(r.session.state.programReport).toMatchObject({
      kind: 'current',
      status: { state: 'working', msg: 'building' },
    })
    // The documented update carries `reported: false`, which is read the same way as before.
    emit(r, UPDATED_CORE_UNAVAILABLE)
    expect(r.session.state.programReport).toEqual({ kind: 'never_reported' })
    expect(r.events.map((event) => event.type)).toContain('report')
  })

  test('running clears it, and an update that names no state leaves it as it is', async () => {
    const r = await attached()
    emit(r, UPDATED_CORE_CLOSED)
    emit(r, {
      kind: 'terminal.updated',
      data: {
        session: 'hc-example',
        epoch: 2,
        program_report: { reported: false },
      },
    })
    expect(r.session.state.connectivity.state).toBe('lost')
    emit(r, UPDATED_RUNNING)
    expect(r.session.state.connectivity).toEqual({ state: 'running' })
    expect(r.events.at(-1)).toMatchObject({
      type: 'connectivity',
      connectivity: { state: 'running' },
      words: undefined,
    })
  })

  test('an update for another epoch or another terminal changes nothing', async () => {
    const r = await attached()
    emit(r, {
      kind: 'terminal.updated',
      data: { ...UPDATED_CORE_CLOSED.data, epoch: 1 },
    })
    emit(r, {
      kind: 'terminal.updated',
      data: { ...UPDATED_CORE_CLOSED.data, session: 'other' },
    })
    expect(r.session.state.connectivity).toEqual({ state: 'running' })
  })

  test('typing, resizing and pasting into a lost terminal are refused here, and nothing is sent', async () => {
    const r = await attached()
    emit(r, UPDATED_CORE_CLOSED)
    const refused = await r.session.input('ls\n')
    expect(refused).toMatchObject({
      outcome: 'refused',
      code: 'terminal_core_lost',
    })
    expect((refused as { reason: string }).reason).toContain(
      'the core closed the connection',
    )
    expect(await r.session.resize(90, 30)).toMatchObject({
      outcome: 'refused',
      code: 'terminal_core_lost',
    })
    expect(await r.session.paste('x')).toMatchObject({
      outcome: 'refused',
      code: 'terminal_core_lost',
    })
    expect(r.of('input')).toHaveLength(0)
    expect(r.of('resize')).toHaveLength(0)
    expect(r.of('paste')).toHaveLength(0)
    // After recovery the same input is sent.
    emit(r, UPDATED_RUNNING)
    expect((await r.session.input('ls\n')).outcome).toBe('accepted')
  })

  test('a full recovery arrives as terminal.opened under a new epoch and clears the loss', async () => {
    const r = await attached()
    emit(r, UPDATED_CORE_CLOSED)
    r.handlers.attach = () => attachReply(ATTACH_RUNNING_FRAGMENT)
    emit(r, OPENED_REATTACHED_FRAGMENT)
    expect(r.session.state.connectivity).toEqual({ state: 'running' })
    expect(r.events.map((event) => event.type)).toContain('opened')
    expect(r.of('open')).toHaveLength(1)
  })

  test('a host that sends none of the new fields reads as before', async () => {
    const r = await attached()
    emit(r, {
      kind: 'terminal.updated',
      data: { session: 'hc-example', epoch: 2 },
    })
    emit(r, {
      kind: 'terminal.opened',
      data: {
        session: 'hc-example',
        epoch: 3,
        program: 1,
        origin: 'reattached',
      },
    })
    expect(r.session.state.connectivity).toEqual({ state: 'running' })
    expect(r.events.map((event) => event.type)).not.toContain('connectivity')
    expect(readConnectivity({ session: 'x' })).toBeUndefined()
    expect(readConnectivity({ state: 'exited' })).toBeUndefined()
    expect(readConnectivity('lost')).toBeUndefined()
  })

  test('a cause this client does not know is shown as sent', () => {
    expect(lostWords('quota_exceeded', 'retry')).toContain('quota_exceeded')
    expect(lostWords(undefined, undefined)).toContain('not known')
  })
})

describe('2. list rows, the attach reply and terminal.exited', () => {
  test('a lost list row keeps its state, reason and next step', async () => {
    const host = terminalHost({
      client: {
        ide: {
          terminal: {
            list: async () => ({
              sessions: [LOST_LIST_ROW, { ...LOST_LIST_ROW, session: 'old' }],
            }),
          },
        },
      },
      live: { onAny: () => () => undefined },
      workspaceId: 'ws',
      csrfToken: () => 't',
    } as unknown as TerminalDeps)
    const listed = await host.list()
    expect(listed.sessions[0]).toMatchObject({
      state: 'lost',
      connectivity: {
        state: 'lost',
        reason: 'core_closed',
        nextStep: 'retry',
      },
    })
  })

  test('a row from a host that says nothing carries no connectivity', async () => {
    const { reason: _r, next_step: _n, state: _s, ...bare } = LOST_LIST_ROW
    const host = terminalHost({
      client: {
        ide: { terminal: { list: async () => ({ sessions: [bare] }) } },
      },
      live: { onAny: () => () => undefined },
      workspaceId: 'ws',
      csrfToken: () => 't',
    } as unknown as TerminalDeps)
    const listed = await host.list()
    expect(listed.sessions[0]).not.toHaveProperty('connectivity')
  })

  test('attached:true with state:lost is attached to the record, not a live terminal, and launches nothing', async () => {
    const r = await attached()
    r.handlers.attach = () => attachReply(ATTACH_LOST_FRAGMENT)
    const result = await reattach(r)
    expect(result).toMatchObject({
      outcome: 'refused',
      code: 'terminal_core_lost',
    })
    expect((result as { reason: string }).reason).toContain(
      'the core closed the connection',
    )
    expect(r.session.state.connectivity).toMatchObject({ state: 'lost' })
    expect(r.of('open')).toHaveLength(1)
    // Running again at the next attach.
    r.handlers.attach = () => attachReply(ATTACH_RUNNING_FRAGMENT)
    expect((await reattach(r)).outcome).toBe('accepted')
    expect(r.session.state.connectivity).toEqual({ state: 'running' })
  })

  test('an attach reply that names no state claims no loss', async () => {
    const r = await attached()
    emit(r, UPDATED_CORE_CLOSED)
    expect((await reattach(r)).outcome).toBe('accepted')
    expect(r.session.state.connectivity).toEqual({ state: 'running' })
  })

  test('gone and exited are ends; a lost or scope_removed retirement is a lost program, not an exit', async () => {
    const gone = await attached()
    emit(gone, EXITED_GONE)
    expect(gone.session.state).toMatchObject({
      phase: 'exited',
      exit: { reason: 'gone', code: null },
    })
    const exited = await attached()
    emit(exited, EXITED_EXITED)
    expect(exited.session.state).toMatchObject({
      phase: 'exited',
      exit: { reason: 'exited', code: 0 },
    })
    const scope = await attached()
    emit(scope, EXITED_SCOPE_REMOVED)
    expect(scope.session.state.phase).toBe('lost')
    expect(scope.session.state.exit).toBeUndefined()
    expect(scope.events.at(-1)).toEqual({
      type: 'lost',
      cause: 'program_lost',
      reason: 'scope_removed',
    })
  })

  test('an older host that says reason lost with no state is still a lost program', async () => {
    const r = await attached()
    emit(r, {
      kind: 'terminal.exited',
      data: { session: 'hc-example', epoch: 2, reason: 'lost' },
    })
    expect(r.session.state.phase).toBe('lost')
    expect(r.events.at(-1)).toEqual({ type: 'lost', cause: 'program_lost' })
  })

  test('the unavailable adoption fixtures are the shapes the adapter reads', () => {
    expect(ADOPTION_UNAVAILABLE_EVENT.data).toEqual({
      state: 'unavailable',
      reason: 'core_unavailable',
      next_step: 'retry',
    })
  })
})

describe('3. control refusals', () => {
  test('terminal_control_refused with detail.reason held is a failed send in the host word, and typing goes on', async () => {
    const r = await attached()
    r.handlers.input = () => {
      throw new HostError(409, CONTROL_REFUSED_HELD)
    }
    const refused = await r.session.input('x')
    expect(refused.outcome).toBe('failed')
    expect((refused as { reason: string }).reason).toContain('held')
    r.handlers.input = () => ({ accepted: true })
    expect((await r.session.input('y')).outcome).toBe('accepted')
  })

  test('the older flat body still reads: stale_epoch is a refusal and any other word a failed send', () => {
    expect(
      classify(
        new HostError(409, {
          code: 'terminal_control_refused',
          reason: 'stale_epoch',
        }),
      ),
    ).toMatchObject({ outcome: 'refused', reason: 'stale_epoch' })
    const held = classify(
      new HostError(409, {
        code: 'terminal_control_refused',
        reason: 'held',
      }),
    )
    expect(held.outcome).toBe('failed')
    expect(held.reason).toContain('held')
  })
})

describe('4. launch', () => {
  const launch = (r: Rig, key?: string) =>
    r.session.open({
      profile: profileById('Herdr shell'),
      cols: 80,
      rows: 24,
      ...(key ? { idempotencyKey: key } : {}),
    })

  test('an operation_id is minted once and a retry of the same intent reuses it', async () => {
    const r = rig()
    r.handlers.open = () => {
      throw new HostError(undefined)
    }
    const first = await launch(r)
    expect(first.outcome).toBe('uncertain')
    const id = (r.of('open')[0]!.request.body as { operation_id: string })
      .operation_id
    expect(id).toBeTruthy()
    expect(r.of('open')[0]!.request['Idempotency-Key']).toBe(id)
    // Nothing repeats on its own.
    expect(r.of('open')).toHaveLength(1)
    // The caller retries the same intent.
    await launch(r, id)
    expect(
      (r.of('open')[1]!.request.body as { operation_id: string }).operation_id,
    ).toBe(id)
    // A different intent is a different id.
    await launch(r)
    expect(
      (r.of('open')[2]!.request.body as { operation_id: string }).operation_id,
    ).not.toBe(id)
  })

  test('the launch body has the documented shape and carries no host-owned field', async () => {
    const r = rig()
    r.handlers.open = () => OPEN_REPLY
    r.handlers.attach = () => attachReply()
    await r.session.open({
      profile: profileById('Claude Code (Herdr)'),
      cols: 80,
      rows: 24,
      idempotencyKey: LAUNCH_BODY.operation_id,
    })
    const body = r.of('open')[0]!.request.body as Record<string, unknown>
    // The documented example's keys (its argv is the program the profile names).
    expect(Object.keys(body).sort()).toEqual(Object.keys(LAUNCH_BODY).sort())
    expect(body).toMatchObject({
      backend: LAUNCH_BODY.backend,
      operation_id: LAUNCH_BODY.operation_id,
      cols: LAUNCH_BODY.cols,
      rows: LAUNCH_BODY.rows,
    })
    for (const field of HOST_OWNED_FIELDS)
      expect(body).not.toHaveProperty(field)
  })

  test('an id the host cannot accept is refused here and nothing is sent', async () => {
    const r = rig()
    expect(await launch(r, 'x'.repeat(257))).toMatchObject({
      outcome: 'refused',
      code: 'terminal_argument_refused',
    })
    expect(r.of('open')).toHaveLength(0)
  })

  test('terminal_operation_uncertain is uncertain and the launch is not repeated', async () => {
    const r = rig()
    r.handlers.open = () => {
      throw new HostError(409, OPERATION_UNCERTAIN)
    }
    const result = await launch(r, 'launch-1')
    expect(result).toMatchObject({ outcome: 'uncertain' })
    expect((result as { reason: string }).reason).toContain('launch-1')
    expect(r.of('open')).toHaveLength(1)
    expect(r.of('attach')).toHaveLength(0)
  })

  test('terminal_argument_refused names the field in plain words', async () => {
    const r = rig()
    r.handlers.open = () => {
      throw new HostError(400, ARGUMENT_REFUSED_CWD)
    }
    expect(await launch(r)).toMatchObject({
      outcome: 'refused',
      code: 'terminal_argument_refused',
      field: 'cwd',
      reason:
        'The host refused the terminal argument "cwd": it is set by the host, not the client; nothing started.',
    })
  })

  test('terminal_backend_unavailable carries its cause and next step in plain words', async () => {
    const r = rig()
    r.handlers.open = () => {
      throw new HostError(503, BACKEND_UNAVAILABLE)
    }
    expect(await launch(r)).toMatchObject({
      outcome: 'refused',
      code: 'terminal_backend_unavailable',
      backend: 'herdr',
      nextStep: 'retry',
      reason:
        'The terminal backend cannot be used: the core cannot be reached. Retry to reconnect.',
    })
  })

  test('an older host body (flat cause text) reads as before', () => {
    expect(
      classify(
        new HostError(503, {
          code: 'terminal_backend_unavailable',
          backend: 'herdr',
          cause: 'hc not found',
        }),
      ),
    ).toMatchObject({ reason: 'hc not found', backend: 'herdr' })
  })
})

describe('5. input', () => {
  test('an uncertain receipt is the uncertain outcome and the same id is never sent again', async () => {
    const r = await attached()
    r.handlers.input = () => INPUT_UNCERTAIN_RECEIPT
    const result = await r.session.input('rm -i x\r', 'human', {
      inputId: 'panel-1',
    })
    expect(result).toMatchObject({ outcome: 'uncertain' })
    expect((result as { reason: string }).reason).toContain(
      'terminal_input_uncertain',
    )
    // Even the person's own repeat of the id sends nothing: the host has said it cannot tell.
    r.handlers.input = () => ({ accepted: true })
    const again = await r.session.input('rm -i x\r', 'human', {
      inputId: 'panel-1',
    })
    expect(again.outcome).toBe('uncertain')
    expect(r.of('input')).toHaveLength(1)
  })

  test('bytes input reads the same receipt', async () => {
    const r = await attached()
    r.handlers.inputBytes = () => INPUT_UNCERTAIN_RECEIPT
    const raw = btoa(String.fromCharCode(0x1b, 0x5b, 0x4d, 0x20, 0xe0, 0xf0))
    expect(
      (await r.session.inputBytes(raw, 'human', { inputId: 'b-1' })).outcome,
    ).toBe('uncertain')
    expect(
      (await r.session.inputBytes(raw, 'human', { inputId: 'b-1' })).outcome,
    ).toBe('uncertain')
    expect(r.of('inputBytes')).toHaveLength(1)
  })

  test('a receipt that says nothing of uncertainty reads as before', async () => {
    const r = await attached()
    r.handlers.input = () => ({
      session: 'hc-example',
      accepted: true,
      duplicate: false,
      discarded: false,
    })
    expect(await r.session.input('a')).toMatchObject({ outcome: 'accepted' })
  })

  describe('the known open issue: a repeat after a re-attach carried the old attachment name', () => {
    const lostAnswer = () => {
      throw new HostError(undefined)
    }

    test('after the host replaced the attachment name, a repeat of an unanswered input sends nothing', async () => {
      const r = await attached()
      const claim = { attachment: 'ta-1', epoch: 2 }
      r.handlers.input = lostAnswer
      expect(
        (await r.session.input('x', 'human', { inputId: 'p-1', claim }))
          .outcome,
      ).toBe('uncertain')
      // A re-attach: the host answers under a name of its own.
      r.handlers.attach = () =>
        attachReply({
          attachment: 'ta-9',
          control: { ...attachReply().control, attachment: 'ta-9' },
        })
      await reattach(r)
      r.handlers.input = () => ({ accepted: true })
      const repeat = await r.session.input('x', 'human', {
        inputId: 'p-1',
        claim,
      })
      expect(repeat.outcome).toBe('uncertain')
      expect((repeat as { reason: string }).reason).toContain('ta-1')
      expect(r.of('input')).toHaveLength(1)
    })

    test('after the binding moved to a new epoch, a repeat sends nothing into it', async () => {
      const r = await attached()
      r.handlers.input = lostAnswer
      await r.session.input('x', 'human', { inputId: 'p-2' })
      r.handlers.attach = () => attachReply(ATTACH_RUNNING_FRAGMENT)
      emit(r, OPENED_REATTACHED_FRAGMENT)
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(r.session.state.bindingEpoch).toBe(3)
      r.handlers.input = () => ({ accepted: true })
      const repeat = await r.session.input('x', 'human', { inputId: 'p-2' })
      expect(repeat.outcome).toBe('uncertain')
      expect(r.of('input')).toHaveLength(1)
    })

    test('while the core is lost, a repeat sends nothing', async () => {
      const r = await attached()
      r.handlers.input = lostAnswer
      await r.session.input('x', 'human', { inputId: 'p-3' })
      emit(r, UPDATED_CORE_CLOSED)
      r.handlers.input = () => ({ accepted: true })
      expect(
        (await r.session.input('x', 'human', { inputId: 'p-3' })).outcome,
      ).toBe('uncertain')
      expect(r.of('input')).toHaveLength(1)
    })

    test('the person-initiated repeat of the same unanswered input in the same binding still reaches the host once, so it can answer duplicate', async () => {
      const r = await attached()
      r.handlers.input = lostAnswer
      await r.session.input('x', 'human', { inputId: 'p-4' })
      r.handlers.input = () => ({ accepted: false, duplicate: true })
      expect(
        await r.session.input('x', 'human', { inputId: 'p-4' }),
      ).toMatchObject({ outcome: 'accepted', value: { duplicate: true } })
      expect(r.of('input')).toHaveLength(2)
    })

    test('nothing sends an input by itself: a lost answer, a loss, a recovery and a new epoch send no second input', async () => {
      const r = await attached()
      r.handlers.input = lostAnswer
      await r.session.input('x', 'human', { inputId: 'p-5' })
      emit(r, UPDATED_CORE_CLOSED)
      emit(r, UPDATED_RUNNING)
      r.handlers.attach = () => attachReply(ATTACH_RUNNING_FRAGMENT)
      emit(r, OPENED_REATTACHED_FRAGMENT)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(r.of('input')).toHaveLength(1)
    })
  })
})
