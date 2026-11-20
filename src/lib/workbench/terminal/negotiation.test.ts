// SOURCING: none — bun:test over ./protocol, ./host and ./session with the committed fixtures in ./fixtures/herdr-wire; AC-62 (R24, R25, R27)
import { describe, expect, test } from 'bun:test'
import { grantedCapabilities } from '../capabilities'
import {
  FakeLive,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import {
  LEGACY_ATTACH_BODIES,
  LEGACY_HERDR_BACKENDS,
  LEGACY_OPEN_NATIVE,
  SUPPORTED_ATTACH_REPLY,
  SUPPORTED_HERDR_BACKEND,
  SUPPORTED_OPEN_REPLY,
} from './fixtures/herdr-wire'
import { terminalHost } from './host'
import type { TerminalDeps } from './host'
import { herdrIdentity, SUPPORTED_HERDR_CORE } from './protocol'
import type { TerminalEvent } from './session'
import { TerminalSession } from './session'
import { rig } from './test-rig'
import { herdrReady, profileById } from './terminal-profile'

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const outputs = (events: TerminalEvent[]) =>
  events.flatMap((event) =>
    event.type === 'output' ? [text(event.bytes)] : [],
  )

describe('which Herdr core the host offers', () => {
  test('the pinned core is identified, with the generation it reported', () => {
    expect(herdrIdentity(SUPPORTED_HERDR_BACKEND)).toEqual({
      supported: true,
      version: '0.1.17',
      generation: 1,
    })
  })

  for (const [name, { backend, offered }] of Object.entries(
    LEGACY_HERDR_BACKENDS,
  )) {
    test(`${name} is rejected, saying what it offered and what is supported`, () => {
      const identity = herdrIdentity(backend)
      expect(identity.supported).toBe(false)
      const reason = identity.supported ? '' : identity.reason
      expect(reason).toContain(offered)
      expect(reason).toContain(
        `herdr-core ${SUPPORTED_HERDR_CORE.versions[0]} (protocol generation ${SUPPORTED_HERDR_CORE.generation})`,
      )
    })
  }

  test('the generation label alone never identifies a core: version one of another line is rejected', () => {
    // The older Remux protocol also calls itself generation one (R24).
    expect(
      herdrIdentity({ ready: true, generation: 1, version: '0.0.9' }).supported,
    ).toBe(false)
  })

  test('every reader of the host capabilities agrees: a mismatched core is not ready, grants no Herdr capability and keeps native', async () => {
    for (const [name, { backend }] of Object.entries(LEGACY_HERDR_BACKENDS)) {
      const host = stubHost([op('terminal.open')], {
        backends: backend ? { herdr: backend as { ready: boolean } } : {},
      })
      const { environment } = testEnvironment(host, new FakeLive())
      await environment.settled()
      expect(environment.backends(), name).not.toContain('herdr')
      expect(herdrReady({ backends: { herdr: backend } }), name).toBe(false)
      const granted = grantedCapabilities(environment, [])
      expect(granted, name).not.toContain('terminal.herdr')
      expect(granted, name).toContain('terminal.native')
    }
    const host = stubHost([op('terminal.open')], {
      backends: { herdr: { ...SUPPORTED_HERDR_BACKEND } },
    })
    const { environment } = testEnvironment(host, new FakeLive())
    await environment.settled()
    expect(environment.backends()).toContain('herdr')
    expect(grantedCapabilities(environment, [])).toContain('terminal.herdr')
  })
})

describe('a Herdr terminal on a host that does not offer the pinned core', () => {
  for (const [name, { backend, offered }] of Object.entries(
    LEGACY_HERDR_BACKENDS,
  )) {
    test(`${name}: refused before anything is sent, with no retry and no native shell`, async () => {
      const r = rig(backend)
      const done = await r.session.open({
        profile: profileById('Herdr shell'),
        cols: 80,
        rows: 24,
      })
      expect(done).toMatchObject({
        outcome: 'refused',
        code: 'terminal_protocol_unsupported',
      })
      expect(done.outcome === 'refused' && done.reason).toContain(offered)
      // Asking again is not a way round it: the same answer, and still nothing on the wire.
      const again = await r.session.open({
        profile: profileById('Claude Code (Herdr)'),
        cols: 80,
        rows: 24,
      })
      expect(again).toMatchObject({ code: 'terminal_protocol_unsupported' })
      expect(r.calls).toEqual([])
      // And nothing can be sent to it afterwards.
      expect((await r.session.input('x')).outcome).toBe('failed')
      expect((await r.session.resize(10, 10)).outcome).toBe('failed')
      expect((await r.session.paste('x')).outcome).toBe('failed')
      expect(r.calls).toEqual([])
      expect(r.events).toEqual([])
      expect(r.session.state.phase).toBe('idle')
    })
  }

  test('a host that cannot name its backends at all is not assumed to speak the pinned core', async () => {
    const host = terminalHost({
      client: { ide: { terminal: {} } },
      live: { onAny: () => () => undefined },
      workspaceId: 'ws',
      csrfToken: () => 't',
    } as unknown as TerminalDeps)
    expect(await host.herdr()).toMatchObject({ supported: false })
  })

  test('a failure to read the identity is a refusal, not a launch', async () => {
    const r = rig()
    r.session = new TerminalSession({
      ...terminalHost({
        client: { ide: { terminal: {} } },
        live: { onAny: () => () => undefined },
        workspaceId: 'ws',
        csrfToken: () => 't',
      } as unknown as TerminalDeps),
      herdr: async () => {
        throw new Error('capabilities unreadable')
      },
    })
    const done = await r.session.open({
      profile: profileById('Herdr shell'),
      cols: 80,
      rows: 24,
    })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'terminal_protocol_unsupported',
    })
    expect(r.calls).toEqual([])
  })

  test('a native shell is not held back by what the host says about Herdr', async () => {
    const r = rig(
      LEGACY_HERDR_BACKENDS['no backends at all (a host older than Herdr)']!
        .backend,
    )
    r.handlers.open = () => ({
      session: 'pty-1',
      binding: { epoch: 1, program: 1 },
    })
    r.handlers.attach = () => ({
      ...SUPPORTED_ATTACH_REPLY,
      backend: undefined,
      binding: { epoch: 1, program: 1 },
    })
    const done = await r.session.open({
      profile: profileById('Shell'),
      cols: 80,
      rows: 24,
    })
    expect(done.outcome).toBe('accepted')
  })
})

describe('the answers a host gives to a launch and an attach', () => {
  test('a Herdr launch answered as a native shell is refused: not attached, not typed to, none of its frames delivered', async () => {
    const r = rig()
    r.handlers.open = () => LEGACY_OPEN_NATIVE
    r.handlers.attach = () => SUPPORTED_ATTACH_REPLY
    const done = await r.session.open({
      profile: profileById('Herdr shell'),
      cols: 80,
      rows: 24,
    })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'terminal_reply_mismatch',
      terminalId: undefined,
    })
    expect(done.outcome === 'refused' && done.reason).toContain(
      'backend is "native", not "herdr"',
    )
    expect(done.outcome === 'refused' && done.reason).toContain('pty-legacy-1')
    expect(r.of('attach')).toEqual([])
    expect((await r.session.input('x')).outcome).toBe('failed')
    r.emit('terminal.output', {
      session: 'pty-legacy-1',
      epoch: 1,
      offset: 0,
      data: btoa('stray'),
    })
    expect(outputs(r.events)).toEqual([])
    expect(r.of('input')).toEqual([])
    expect(r.of('open')).toHaveLength(1)
  })

  test('a native launch answered as Herdr is refused as well', async () => {
    const r = rig()
    r.handlers.open = () => SUPPORTED_OPEN_REPLY
    const done = await r.session.open({
      profile: profileById('Shell'),
      cols: 80,
      rows: 24,
    })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'terminal_reply_mismatch',
    })
    expect(r.of('attach')).toEqual([])
  })

  for (const [name, body] of Object.entries(LEGACY_ATTACH_BODIES)) {
    test(`an attach answered with ${name} is refused, applies nothing and is not asked for again in another form`, async () => {
      const r = rig()
      r.handlers.open = () => SUPPORTED_OPEN_REPLY
      r.handlers.attach = () => body
      const done = await r.session.open({
        profile: profileById('Herdr shell'),
        cols: 80,
        rows: 24,
      })
      expect(done).toMatchObject({
        outcome: 'refused',
        code: 'terminal_reply_mismatch',
        terminalId: 'hc-fixture-1',
      })
      expect(done.outcome === 'refused' && done.reason).toContain(
        'was not read',
      )
      // One attach, one open: no second request in a guessed format, no input.
      expect(r.calls.map((entry) => entry.op)).toEqual(['open', 'attach'])
      expect(outputs(r.events)).toEqual([])
      expect(r.events.some((event) => event.type === 'reset')).toBe(false)
      expect(r.session.state.offset).toBe(0)
      expect(r.session.state.phase).not.toBe('attached')
    })
  }

  test('a live frame that is not base64 is dropped, not decoded another way, and the next good frame still lands', async () => {
    const r = rig()
    r.handlers.open = () => SUPPORTED_OPEN_REPLY
    r.handlers.attach = () => SUPPORTED_ATTACH_REPLY
    await r.session.open({
      profile: profileById('Herdr shell'),
      cols: 80,
      rows: 24,
    })
    expect(outputs(r.events)).toEqual(['ready'])
    const frame = (offset: number, data: unknown) =>
      r.emit('terminal.output', {
        session: 'hc-fixture-1',
        epoch: 1,
        offset,
        data,
      })
    expect(() => frame(5, '\u0089RMX not base64 *** ')).not.toThrow()
    expect(() => frame(5, [104, 105])).not.toThrow()
    expect(outputs(r.events)).toEqual(['ready'])
    expect(r.session.state.offset).toBe(5)
    frame(5, btoa('!'))
    expect(outputs(r.events)).toEqual(['ready', '!'])
  })
})

describe('the supported pair', () => {
  test('negotiates once, and only then do commands and frames flow, in order', async () => {
    const r = rig()
    r.handlers.open = () => SUPPORTED_OPEN_REPLY
    r.handlers.attach = () => SUPPORTED_ATTACH_REPLY
    r.handlers.input = () => ({ accepted: true })
    const opened = await r.session.open({
      profile: profileById('Herdr shell'),
      cols: 80,
      rows: 24,
    })
    expect(opened).toMatchObject({
      outcome: 'accepted',
      terminalId: 'hc-fixture-1',
      bindingEpoch: 1,
      value: { terminalId: 'hc-fixture-1', bindingEpoch: 1, program: 1 },
    })
    expect(r.session.state).toMatchObject({
      phase: 'attached',
      processOwnedBy: 'herdr-core',
    })
    expect(outputs(r.events)).toEqual(['ready'])
    expect(r.of('open')[0]!.request.body).toMatchObject({ backend: 'herdr' })
    const typed = await r.session.input('ls\n')
    expect(typed).toMatchObject({
      outcome: 'accepted',
      terminalId: 'hc-fixture-1',
      bindingEpoch: 1,
    })
    r.emit('terminal.output', {
      session: 'hc-fixture-1',
      epoch: 1,
      offset: 5,
      data: btoa(' $ '),
    })
    expect(outputs(r.events)).toEqual(['ready', ' $ '])
    expect(r.calls.map((entry) => entry.op)).toEqual([
      'open',
      'attach',
      'input',
    ])
  })
})
