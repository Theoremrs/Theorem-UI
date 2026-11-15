import { describe, expect, test } from 'bun:test'
import { terminalHost } from './host'
import type { TerminalDeps } from './host'
import { TerminalSession, watchAnnouncements } from './session'
import type { TerminalEvent } from './session'
import { profileById } from './terminal-profile'

class HostError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly body?: unknown,
  ) {
    super(`HTTP ${statusCode}`)
  }
}

const b64 = (text: string) => btoa(text)
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

type Call = Record<string, unknown> & { op: string }

/** A client with the SDK's method shapes and a live stream we can drive, with no network. */
const OFFERED = ['terminal.kill', 'terminal.input.bytes', 'terminal.list']

function rig(options: { offers?: boolean | string[] } = {}) {
  const calls: Call[] = []
  const handlers: Record<
    string,
    (request: Record<string, unknown>) => unknown
  > = {}
  const call = (op: string) => async (request: Record<string, unknown>) => {
    calls.push({ op, ...request })
    const handler = handlers[op]
    if (!handler) {
      throw new Error(`no stub for ${op}`)
    }
    return handler(request)
  }
  const any = new Set<
    (event: { cursor: string; kind: string; data: unknown }) => void
  >()
  const resync = new Set<
    (resync: {
      reason: string
      epoch: string
      cursor: string
    }) => void | Promise<void>
  >()
  const state = new Set<(state: string) => void>()
  const deps = {
    client: {
      ide: {
        terminal: {
          open: call('open'),
          attach: call('attach'),
          input: call('input'),
          inputBytes: call('inputBytes'),
          resize: call('resize'),
          paste: call('paste'),
          close: call('close'),
          kill: call('kill'),
          list: call('list'),
        },
      },
    },
    live: {
      onAny: (listener: never) => (
        any.add(listener),
        () => any.delete(listener)
      ),
      onResync: (listener: never) => (
        resync.add(listener),
        () => resync.delete(listener)
      ),
      onState: (listener: never) => (
        state.add(listener),
        () => state.delete(listener)
      ),
    },
    workspaceId: 'ws-1',
    csrfToken: () => 'csrf-1',
    backend: async () => ({
      ready: true,
      generation: 1,
      version: '0.1.17',
    }),
    offers: async (operation: string) =>
      options.offers === false
        ? false
        : (Array.isArray(options.offers) ? options.offers : OFFERED).includes(
            operation,
          ),
  } as unknown as TerminalDeps
  const host = terminalHost(deps)
  const session = new TerminalSession(host)
  const events: TerminalEvent[] = []
  session.subscribe((event) => events.push(event))
  return {
    calls,
    handlers,
    host,
    session,
    events,
    live: (kind: string, data: Record<string, unknown>) =>
      any.forEach((listener) => listener({ cursor: '1:1', kind, data })),
    resync: async (epoch: string) => {
      for (const listener of resync) {
        await listener({ reason: 'epoch_changed', epoch, cursor: `${epoch}:0` })
      }
    },
    link: (next: string) => state.forEach((listener) => listener(next)),
    of: (op: string) => calls.filter((entry) => entry.op === op),
  }
}

const control = (
  generation: number,
  controlling = true,
  controlled = true,
  epoch = 1,
) => ({
  attachment: 'ta-1',
  role: controlling ? 'controller' : 'observer',
  controlling,
  controlled,
  generation,
  epoch,
})

const attachReply = (extra: Record<string, unknown> = {}) => ({
  session: 'pty-1',
  attachment: 'ta-1',
  control: control(1),
  epoch: 1,
  binding: { epoch: 1, program: 1 },
  formatted: '',
  offset_start: 0,
  offset_end: 0,
  data: '',
  ...extra,
})

/** An opened, attached controller on binding epoch 1, program 1. */
async function opened(
  r: ReturnType<typeof rig>,
  profile = 'Herdr shell',
  role?: 'controller' | 'observer',
) {
  r.handlers.open = () => ({
    session: 'pty-1',
    cols: 80,
    rows: 24,
    binding: { epoch: 1, program: 1 },
  })
  r.handlers.attach = () =>
    attachReply({
      control: control(
        role === 'observer' ? 0 : 1,
        role !== 'observer',
        role !== 'observer',
      ),
    })
  const result = await r.session.open({
    profile: profileById(profile),
    cols: 80,
    rows: 24,
    ...(role ? { role } : {}),
  })
  expect(result.outcome).toBe('accepted')
  return result
}

describe('open', () => {
  test('sends the launch body each profile defines, with the workspace, token and an idempotency key', async () => {
    const bodies: Record<string, unknown>[] = []
    for (const [id, name] of [
      ['Shell', undefined],
      ['Herdr shell', 'build'],
      ['Claude Code (Herdr)', undefined],
      ['Codex (Herdr)', undefined],
    ] as const) {
      const r = rig()
      r.handlers.open = () => ({
        session: 'pty-1',
        binding: { epoch: 1, program: 1 },
      })
      r.handlers.attach = () => attachReply()
      await r.session.open({
        profile: profileById(id),
        cols: 100,
        rows: 30,
        ...(name ? { name } : {}),
      })
      const sent = r.of('open')[0]!
      expect(sent.workspaceId).toBe('ws-1')
      expect(sent['X-CSRF-Token']).toBe('csrf-1')
      expect(typeof sent['Idempotency-Key']).toBe('string')
      // The launch's operation id is the idempotency key: one value per launch intent.
      const { operation_id, ...rest } = sent.body as Record<string, unknown>
      expect(operation_id).toBe(sent['Idempotency-Key'])
      bodies.push(rest)
    }
    expect(bodies).toEqual([
      { cols: 100, rows: 30 },
      { cols: 100, rows: 30, backend: 'herdr', name: 'build' },
      { cols: 100, rows: 30, backend: 'herdr', argv: ['claude'] },
      { cols: 100, rows: 30, backend: 'herdr', argv: ['codex'] },
    ])
  })

  test('an attachment named on open goes to the host with the first attach, unchanged', async () => {
    const r = rig()
    r.handlers.open = () => ({
      session: 'pty-1',
      cols: 80,
      rows: 24,
      binding: { epoch: 1, program: 1 },
    })
    r.handlers.attach = () => attachReply({ control: control(1, true, true) })
    await r.session.open({
      profile: profileById('Herdr shell'),
      cols: 80,
      rows: 24,
      attachment: 'pane-7',
    })
    expect(r.of('attach')[0]).toMatchObject({ attachment: 'pane-7' })
  })

  test('attaches as controller from offset 0 and reports what it answers', async () => {
    const r = rig()
    const result = await opened(r)
    expect(r.of('attach')[0]).toMatchObject({
      session: 'pty-1',
      from_offset: 0,
      role: 'controller',
    })
    expect(result).toMatchObject({
      terminalId: 'pty-1',
      bindingEpoch: 1,
      value: { program: 1 },
    })
    expect(r.session.state).toMatchObject({
      phase: 'attached',
      origin: 'launched',
      lease: { role: 'controller', generation: 1, attachment: 'ta-1' },
    })
    expect(r.events[0]).toMatchObject({ type: 'opened', origin: 'launched' })
  })

  test('an unavailable backend is a typed refusal and starts nothing else', async () => {
    const r = rig()
    r.handlers.open = () => {
      throw new HostError(503, {
        code: 'terminal_backend_unavailable',
        backend: 'herdr',
        cause: 'hc not found',
      })
    }
    const result = await r.session.open({
      profile: profileById('Herdr shell'),
      cols: 80,
      rows: 24,
    })
    expect(result).toMatchObject({
      outcome: 'refused',
      code: 'terminal_backend_unavailable',
      backend: 'herdr',
      reason: 'hc not found',
      terminalId: undefined,
    })
    expect(r.of('open')).toHaveLength(1)
    expect(r.session.state.phase).toBe('idle')
  })

  test('a launch with no reply is uncertain and is not repeated', async () => {
    const r = rig()
    r.handlers.open = () => {
      throw new HostError(undefined)
    }
    const result = await r.session.open({
      profile: profileById('Codex (Herdr)'),
      cols: 80,
      rows: 24,
    })
    expect(result.outcome).toBe('uncertain')
    expect(r.of('open')).toHaveLength(1)
  })
})

describe('four versions', () => {
  test('a reset and a reattach move only the field each one owns', async () => {
    const r = rig()
    await opened(r)
    r.link('reconnecting')
    await r.resync('stream-b')
    expect(r.session.state).toMatchObject({
      streamEpoch: 'stream-b',
      bindingEpoch: 1,
      program: 1,
      lease: { generation: 1 },
    })

    // The host rebinds: a replacement program under epoch 2. The lease generation stays what it was.
    r.handlers.attach = () =>
      attachReply({
        epoch: 2,
        binding: { epoch: 2, program: 2 },
        control: control(1, true, true, 2),
        formatted: 'REPAINT',
        offset_start: 0,
        offset_end: 7,
      })
    r.live('terminal.opened', {
      session: 'pty-1',
      epoch: 2,
      program: 2,
      origin: 'replacement',
    })
    await flush()
    expect(r.session.state).toMatchObject({
      streamEpoch: 'stream-b',
      bindingEpoch: 2,
      program: 2,
      origin: 'replacement',
      offset: 7,
      lease: { generation: 1 },
    })
    expect(r.events).toContainEqual({
      type: 'reset',
      formatted: 'REPAINT',
      epoch: 2,
    })
    expect(r.of('attach').at(-1)).toMatchObject({ from_offset: 0 })

    // A takeover changes the lease generation and nothing else.
    r.live('terminal.control', {
      session: 'pty-1',
      epoch: 2,
      generation: 2,
      controlled: true,
    })
    expect(r.session.state).toMatchObject({
      streamEpoch: 'stream-b',
      bindingEpoch: 2,
      program: 2,
      lease: { generation: 2, role: 'observer' },
    })
  })

  test('output from an older binding epoch is dropped and one from a newer epoch asks for a repaint', async () => {
    const r = rig()
    await opened(r)
    r.live('terminal.output', {
      session: 'pty-1',
      epoch: 1,
      offset: 0,
      data: b64('hi'),
    })
    expect(
      r.events
        .filter((e) => e.type === 'output')
        .map((e) => text((e as { bytes: Uint8Array }).bytes)),
    ).toEqual(['hi'])

    r.handlers.attach = () =>
      attachReply({
        epoch: 2,
        binding: { epoch: 2, program: 1 },
        formatted: 'NEW',
        offset_end: 3,
      })
    r.live('terminal.output', {
      session: 'pty-1',
      epoch: 2,
      offset: 0,
      data: b64('new'),
    })
    await flush()
    expect(r.events.filter((e) => e.type === 'output')).toHaveLength(1)
    expect(r.events).toContainEqual({
      type: 'reset',
      formatted: 'NEW',
      epoch: 2,
    })

    r.live('terminal.output', {
      session: 'pty-1',
      epoch: 1,
      offset: 2,
      data: b64('old'),
    })
    expect(r.events.filter((e) => e.type === 'output')).toHaveLength(1)
  })
})

describe('output and reconnect', () => {
  test('bytes arrive in order and once', async () => {
    const r = rig()
    await opened(r)
    r.live('terminal.output', {
      session: 'pty-1',
      epoch: 1,
      offset: 0,
      data: b64('abc'),
    })
    r.live('terminal.output', {
      session: 'pty-1',
      epoch: 1,
      offset: 0,
      data: b64('abc'),
    })
    r.live('terminal.output', {
      session: 'pty-1',
      epoch: 1,
      offset: 2,
      data: b64('cde'),
    })
    expect(
      r.events
        .filter((e) => e.type === 'output')
        .map((e) => text((e as { bytes: Uint8Array }).bytes)),
    ).toEqual(['abc', 'de'])
    expect(r.session.state.offset).toBe(5)
  })

  test('after a dropped connection it reattaches from the last applied offset and says so', async () => {
    const r = rig()
    await opened(r)
    r.live('terminal.output', {
      session: 'pty-1',
      epoch: 1,
      offset: 0,
      data: b64('abc'),
    })
    r.link('reconnecting')
    expect(r.session.state.connection).toBe('reconnecting')
    r.handlers.attach = () =>
      attachReply({ offset_start: 3, offset_end: 5, data: b64('de') })
    r.link('open')
    await flush()
    expect(r.of('attach').at(-1)).toMatchObject({
      from_offset: 3,
      attachment: 'ta-1',
    })
    expect(r.of('attach').at(-1)).not.toHaveProperty('role')
    expect(
      r.events
        .filter((e) => e.type === 'output')
        .map((e) => text((e as { bytes: Uint8Array }).bytes)),
    ).toEqual(['abc', 'de'])
    expect(r.events.at(-1)).toEqual({ type: 'reconnected' })
    expect(r.session.state.connection).toBe('connected')
  })

  test('an offset the host no longer holds becomes a reset, not a silent jump', async () => {
    const r = rig()
    await opened(r)
    r.live('terminal.output', {
      session: 'pty-1',
      epoch: 1,
      offset: 0,
      data: b64('abc'),
    })
    r.handlers.attach = () =>
      attachReply({
        truncated: true,
        formatted: 'SCREEN',
        offset_start: 9000,
        offset_end: 9100,
        data: b64('x'),
      })
    r.link('reconnecting')
    r.link('open')
    await flush()
    expect(r.events).toContainEqual({
      type: 'reset',
      formatted: 'SCREEN',
      epoch: 1,
    })
    expect(r.events.filter((e) => e.type === 'output')).toHaveLength(1)
    expect(r.session.state.offset).toBe(9100)
  })

  test('a gap in the live bytes is closed by an attach from the applied offset', async () => {
    const r = rig()
    await opened(r)
    r.handlers.attach = () =>
      attachReply({ offset_start: 0, offset_end: 6, data: b64('abcdef') })
    r.live('terminal.output', {
      session: 'pty-1',
      epoch: 1,
      offset: 4,
      data: b64('ef'),
    })
    await flush()
    expect(r.of('attach').at(-1)).toMatchObject({ from_offset: 0 })
    expect(
      text(
        (
          r.events.filter((e) => e.type === 'output').at(-1) as {
            bytes: Uint8Array
          }
        ).bytes,
      ),
    ).toBe('abcdef')
  })
})

describe('lease and input', () => {
  test('input carries the claim and a fresh id', async () => {
    const r = rig()
    await opened(r)
    r.handlers.input = () => ({ accepted: true })
    const first = await r.session.input('ls\r')
    const second = await r.session.input('pwd\r')
    expect(first).toMatchObject({
      outcome: 'accepted',
      terminalId: 'pty-1',
      bindingEpoch: 1,
      value: { duplicate: false },
    })
    const [a, b] = r.of('input')
    expect(a).toMatchObject({
      session: 'pty-1',
      bytes: 'ls\r',
      kind: 'human',
      attachment: 'ta-1',
      generation: 1,
      epoch: 1,
    })
    expect(a!.input_id).not.toBe(b!.input_id)
    expect(second.outcome).toBe('accepted')
  })

  test('an observer cannot type, paste or resize; nothing is sent', async () => {
    const r = rig()
    await opened(r, 'Herdr shell', 'observer')
    expect(r.session.state.lease.role).toBe('observer')
    for (const result of [
      await r.session.input('x'),
      await r.session.paste('x'),
      await r.session.resize(10, 10),
    ]) {
      expect(result).toMatchObject({
        outcome: 'refused',
        code: 'terminal_control_refused',
        reason: 'observer',
      })
    }
    expect(r.of('input')).toHaveLength(0)
    expect(r.of('paste')).toHaveLength(0)
    expect(r.of('resize')).toHaveLength(0)
  })

  test.each([
    'observer',
    'held',
    'stale_generation',
    'stale_epoch',
    'unknown_attachment',
  ] as const)('the host refusing for %s is a typed refusal', async (reason) => {
    const r = rig()
    await opened(r)
    r.handlers.input = () => {
      throw new HostError(409, { code: 'terminal_control_refused', reason })
    }
    expect(await r.session.input('x')).toMatchObject({
      outcome: 'refused',
      code: 'terminal_control_refused',
      reason,
      terminalId: 'pty-1',
      bindingEpoch: 1,
    })
  })

  test('requestControl takes the lease with a role and the new generation shows', async () => {
    const r = rig()
    await opened(r, 'Herdr shell', 'observer')
    r.handlers.attach = () => attachReply({ control: control(4) })
    const result = await r.session.requestControl()
    expect(result.outcome).toBe('accepted')
    expect(r.of('attach').at(-1)).toMatchObject({
      role: 'controller',
      attachment: 'ta-1',
    })
    expect(r.session.state.lease).toMatchObject({
      role: 'controller',
      generation: 4,
    })
    r.handlers.attach = () => attachReply({ control: control(4, false, false) })
    await r.session.releaseControl()
    expect(r.of('attach').at(-1)).toMatchObject({ role: 'observer' })
    expect(r.session.state.lease.role).toBe('observer')
  })

  test('a takeover elsewhere turns this controller into an observer and typing stops locally', async () => {
    const r = rig()
    await opened(r)
    r.live('terminal.control', {
      session: 'pty-1',
      epoch: 1,
      generation: 2,
      controlled: true,
    })
    expect(r.events.at(-1)).toMatchObject({
      type: 'lease',
      lease: { role: 'observer', generation: 2, held: true },
    })
    expect(await r.session.input('x')).toMatchObject({
      outcome: 'refused',
      reason: 'observer',
    })
    // A late event for an older generation changes nothing.
    r.live('terminal.control', {
      session: 'pty-1',
      epoch: 1,
      generation: 1,
      controlled: false,
    })
    expect(r.session.state.lease.generation).toBe(2)
  })

  test('a retry after a lost acknowledgement reuses the id and the host acknowledges a duplicate', async () => {
    const r = rig()
    await opened(r)
    r.handlers.input = () => {
      throw new HostError(undefined)
    }
    const lost = await r.session.input('rm -i x\r')
    expect(lost.outcome).toBe('uncertain')
    r.handlers.input = () => ({ accepted: false, duplicate: true })
    const retried = await r.session.input('rm -i x\r', 'human', {
      inputId: r.of('input')[0]!.input_id as string,
    })
    expect(retried).toMatchObject({
      outcome: 'accepted',
      value: { duplicate: true },
    })
    const [first, second] = r.of('input')
    expect(second).toMatchObject({
      input_id: first!.input_id,
      bytes: 'rm -i x\r',
      generation: 1,
      epoch: 1,
    })
    // Answered now: a second retry sends nothing.
    expect(
      (
        await r.session.input('rm -i x\r', 'human', {
          inputId: first!.input_id as string,
        })
      ).outcome,
    ).toBe('uncertain')
    expect(r.of('input')).toHaveLength(2)
  })

  test('a resize carries the claim the caller names, and the session own claim when it names none', async () => {
    const r = rig()
    await opened(r)
    const claim = { attachment: 'ta-9', leaseGeneration: 4, epoch: 1 }
    await r.session.resize(90, 20, { claim })
    await r.session.resize(91, 21)
    const [named, own] = r.of('resize')
    expect(named!.body).toMatchObject({
      cols: 90,
      rows: 20,
      attachment: 'ta-9',
      generation: 4,
      epoch: 1,
    })
    expect(own!.body).toMatchObject({ cols: 91, rows: 21 })
    expect((own!.body as { attachment: string }).attachment).not.toBe('ta-9')
  })

  test('the caller names the id and the claim, and a repeat resends the original body', async () => {
    const r = rig()
    await opened(r)
    r.handlers.input = () => {
      throw new HostError(undefined)
    }
    const claim = { attachment: 'ta-9', leaseGeneration: 4, epoch: 1 }
    await r.session.input('first', 'human', { inputId: 'panel-1', claim })
    r.handlers.input = () => ({ accepted: true })
    await r.session.input('changed', 'human', { inputId: 'panel-1' })
    const [a, b] = r.of('input')
    expect(a).toMatchObject({
      input_id: 'panel-1',
      attachment: 'ta-9',
      generation: 4,
      epoch: 1,
    })
    expect(b).toMatchObject({
      input_id: 'panel-1',
      bytes: 'first',
      attachment: 'ta-9',
      generation: 4,
    })
  })

  describe('bytes that are not text', () => {
    // 1b 5b 4d 20 e0 f0: an X10 mouse report, which is not valid UTF-8.
    const raw = btoa(String.fromCharCode(0x1b, 0x5b, 0x4d, 0x20, 0xe0, 0xf0))

    test('go as bytes_base64 on the bytes input, under the panel id and claim', async () => {
      const r = rig()
      await opened(r)
      r.handlers.inputBytes = () => ({ accepted: true })
      const claim = { attachment: 'ta-9', leaseGeneration: 4, epoch: 1 }
      expect(
        await r.session.inputBytes(raw, 'human', { inputId: 'panel-7', claim }),
      ).toMatchObject({ outcome: 'accepted', value: { inputId: 'panel-7' } })
      expect(r.of('input')).toHaveLength(0)
      const [sent] = r.of('inputBytes')
      expect(sent).toMatchObject({
        session: 'pty-1',
        bytes_base64: raw,
        input_id: 'panel-7',
        'Idempotency-Key': 'panel-7',
        kind: 'human',
        attachment: 'ta-9',
        generation: 4,
        epoch: 1,
      })
      expect(sent).not.toHaveProperty('bytes')
    })

    test('a lost answer is uncertain and a repeat of the id resends the same bytes once', async () => {
      const r = rig()
      await opened(r)
      r.handlers.inputBytes = () => {
        throw new HostError(undefined)
      }
      expect(
        (await r.session.inputBytes(raw, 'human', { inputId: 'panel-8' }))
          .outcome,
      ).toBe('uncertain')
      r.handlers.inputBytes = () => ({ accepted: false, duplicate: true })
      expect(
        await r.session.inputBytes('AAAA', 'human', { inputId: 'panel-8' }),
      ).toMatchObject({ outcome: 'accepted', value: { duplicate: true } })
      const [first, second] = r.of('inputBytes')
      expect(second).toMatchObject({
        input_id: 'panel-8',
        bytes_base64: first!.bytes_base64,
      })
      expect(r.of('inputBytes')).toHaveLength(2)
    })

    test('an observer is refused locally and nothing is sent', async () => {
      const r = rig()
      await opened(r, 'Herdr shell', 'observer')
      expect(await r.session.inputBytes(raw)).toMatchObject({
        outcome: 'refused',
        code: 'terminal_control_refused',
        reason: 'observer',
      })
      expect(r.of('inputBytes')).toHaveLength(0)
    })

    test('a host that does not list terminal.input.bytes gets UTF-8 text as text and refuses the rest', async () => {
      const r = rig({ offers: ['terminal.kill'] })
      await opened(r)
      r.handlers.input = () => ({ accepted: true })
      expect(
        (await r.session.inputBytes(btoa('ls\n'), 'human', { inputId: 'a' }))
          .outcome,
      ).toBe('accepted')
      expect(r.of('input')[0]).toMatchObject({ bytes: 'ls\n', input_id: 'a' })
      expect(
        await r.session.inputBytes(raw, 'human', { inputId: 'b' }),
      ).toMatchObject({
        outcome: 'refused',
        code: 'missing_capability',
      })
      expect(r.of('inputBytes')).toHaveLength(0)
      expect(r.of('input')).toHaveLength(1)
    })
  })

  test('an observer query reply the host discards is an acknowledgement, not an error', async () => {
    const r = rig()
    await opened(r)
    r.handlers.input = () => ({ accepted: false, discarded: true })
    expect(await r.session.input('\x1b[0n', 'reply')).toMatchObject({
      outcome: 'accepted',
      value: { discarded: true },
    })
    expect(r.of('input')[0]).toMatchObject({ kind: 'reply' })
  })
})

describe('detach and kill', () => {
  test('detach closes the attachment and never kills', async () => {
    const r = rig()
    await opened(r)
    r.handlers.close = () => ({
      attachment_closed: true,
      process_killed: false,
      session_live: true,
    })
    const result = await r.session.detach()
    expect(result.outcome).toBe('accepted')
    expect(r.of('close')[0]).toMatchObject({
      body: { session: 'pty-1', attachment: 'ta-1' },
    })
    expect(r.of('kill')).toHaveLength(0)
    expect(r.session.state.phase).toBe('detached')
    // Live events after a detach are not applied.
    r.live('terminal.output', {
      session: 'pty-1',
      epoch: 1,
      offset: 0,
      data: b64('late'),
    })
    expect(r.events.filter((e) => e.type === 'output')).toHaveLength(0)
  })

  test('kill is the host’s typed terminal.kill, and only when the host advertises it', async () => {
    const r = rig()
    await opened(r)
    r.handlers.kill = () => ({ process_killed: true, session_live: false })
    const result = await r.session.kill()
    expect(result).toMatchObject({
      outcome: 'accepted',
      value: { processKilled: true, sessionLive: false },
    })
    expect(r.of('kill')).toHaveLength(1)
    expect(r.of('kill')[0]).toMatchObject({
      workspaceId: 'ws-1',
      body: { session: 'pty-1' },
    })
    expect(r.of('close')).toHaveLength(0)
  })

  test('kill is refused with a typed reason when the host does not advertise terminal.kill', async () => {
    const r = rig({ offers: false })
    await opened(r)
    expect(await r.session.kill()).toMatchObject({
      outcome: 'refused',
      code: 'kill_unavailable',
      terminalId: 'pty-1',
    })
    expect(r.of('kill')).toHaveLength(0)
    expect(r.of('close')).toHaveLength(0)
  })
})

describe('exit, loss and adoption', () => {
  test('a program exit reports its reason and code', async () => {
    const r = rig()
    await opened(r)
    r.live('terminal.exited', {
      session: 'pty-1',
      epoch: 1,
      exit_code: 2,
      signal: null,
      reason: 'exited',
    })
    expect(r.events.at(-1)).toEqual({
      type: 'exited',
      reason: 'exited',
      code: 2,
      signal: null,
    })
    expect(r.session.state).toMatchObject({
      phase: 'exited',
      exit: { reason: 'exited', code: 2 },
    })
    expect(await r.session.input('x')).toMatchObject({ outcome: 'failed' })
  })

  test('a lost program is reported as lost and no shell is opened for it', async () => {
    const r = rig()
    await opened(r, 'Claude Code (Herdr)')
    r.live('terminal.exited', { session: 'pty-1', epoch: 1, reason: 'lost' })
    expect(r.events.at(-1)).toEqual({ type: 'lost', cause: 'program_lost' })
    expect(r.session.state).toMatchObject({
      phase: 'lost',
      profile: { id: 'Claude Code (Herdr)' },
    })
    await flush()
    expect(r.of('open')).toHaveLength(1)
    // Starting a new program is a separate call that takes the same profile and a new session object.
    const again = rig()
    again.handlers.open = () => ({
      session: 'pty-2',
      binding: { epoch: 1, program: 1 },
    })
    again.handlers.attach = () => attachReply()
    await again.session.open({
      profile: r.session.state.profile,
      cols: 80,
      rows: 24,
    })
    expect(again.of('open')[0]!.body).toMatchObject({
      backend: 'herdr',
      argv: ['claude'],
    })
  })

  test('a session the host no longer has ends the stream as lost', async () => {
    const r = rig()
    await opened(r)
    r.handlers.attach = () => {
      throw new HostError(404, { code: 'terminal_session_not_found' })
    }
    r.link('reconnecting')
    r.link('open')
    await flush()
    expect(r.events.at(-1)).toEqual({ type: 'lost', cause: 'session_gone' })
    expect(r.session.state.phase).toBe('lost')
    expect(r.of('open')).toHaveLength(1)
    expect(await r.session.resize(10, 10)).toMatchObject({ outcome: 'failed' })
  })

  test('a live stream that closes for good is lost', async () => {
    const r = rig()
    await opened(r)
    r.link('closed')
    expect(r.events.at(-1)).toEqual({ type: 'lost', cause: 'stream_closed' })
  })

  test('a terminal the host announces as adopted is surfaced once per binding and program', () => {
    const r = rig()
    const seen: unknown[] = []
    watchAnnouncements(r.host, (announcement) => seen.push(announcement))
    const adopted = {
      session: 'hc-9',
      epoch: 3,
      program: 1,
      origin: 'adopted',
      backend: 'herdr',
      cols: 120,
      rows: 40,
    }
    r.live('terminal.opened', adopted)
    r.live('terminal.opened', adopted)
    r.live('terminal.opened', { ...adopted, epoch: 4 })
    r.live('terminal.output', {
      session: 'hc-9',
      epoch: 3,
      offset: 0,
      data: '',
    })
    expect(seen).toEqual([
      {
        terminalId: 'hc-9',
        origin: 'adopted',
        backend: 'herdr',
        bindingEpoch: 3,
        program: 1,
        cols: 120,
        rows: 40,
      },
      {
        terminalId: 'hc-9',
        origin: 'adopted',
        backend: 'herdr',
        bindingEpoch: 4,
        program: 1,
        cols: 120,
        rows: 40,
      },
    ])
  })

  test('attaching to an adopted terminal reports adoption when the host announces it', async () => {
    const r = rig()
    r.handlers.attach = () =>
      attachReply({
        session: 'hc-9',
        epoch: 3,
        binding: { epoch: 3, program: 1 },
        control: control(0, false, false, 3),
      })
    const result = await r.session.attach({ terminalId: 'hc-9', fromOffset: 0 })
    expect(result).toMatchObject({
      outcome: 'accepted',
      terminalId: 'hc-9',
      bindingEpoch: 3,
    })
    expect(r.of('attach')[0]).toMatchObject({
      role: 'observer',
      from_offset: 0,
    })
    r.live('terminal.opened', {
      session: 'hc-9',
      epoch: 4,
      program: 2,
      origin: 'adopted',
    })
    expect(r.events).toContainEqual({
      type: 'adopted',
      terminalId: 'hc-9',
      bindingEpoch: 4,
      program: 2,
    })
  })

  test("an attach names the caller's attachment and sends it unchanged", async () => {
    const r = rig()
    r.handlers.attach = () =>
      attachReply({
        session: 'hc-9',
        epoch: 3,
        binding: { epoch: 3, program: 1 },
        control: control(0, false, false, 3),
      })
    await r.session.attach({
      terminalId: 'hc-9',
      fromOffset: 0,
      attachment: 'att-mine',
    })
    expect(r.of('attach')[0]).toMatchObject({ attachment: 'att-mine' })
  })
})

describe('the host’s terminal list', () => {
  test('is read with the workspace headers and a free body, and only offered when the host lists it', async () => {
    const r = rig()
    const answer = {
      sessions: [],
      adoption: { state: 'unavailable' as const, reason: 'the core is down' },
    }
    r.handlers.list = () => answer
    expect(await r.host.canList()).toBe(true)
    expect(await r.host.list()).toEqual(answer)
    expect(r.of('list')[0]).toMatchObject({
      workspaceId: 'ws-1',
      'X-CSRF-Token': 'csrf-1',
      body: {},
    })
    expect(await rig({ offers: ['terminal.kill'] }).host.canList()).toBe(false)
  })

  test('the adoption event is the workspace’s, so no terminal binding reacts to it', async () => {
    const r = rig()
    await opened(r)
    const before = r.events.length
    r.live('terminal.adoption', { state: 'pending' })
    expect(r.events).toHaveLength(before)
    expect(r.session.state.phase).toBe('attached')
  })
})
