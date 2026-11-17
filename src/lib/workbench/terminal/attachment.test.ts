// SOURCING: none — bun:test over ./session through the shared test rig; the host rule is that an unknown attachment name on terminal.attach is ignored and a minted `ta-<uuid>` is returned, which every later write must carry
import { describe, expect, test } from 'bun:test'
import {
  SUPPORTED_ATTACH_REPLY,
  SUPPORTED_OPEN_REPLY,
} from './fixtures/herdr-wire'
import { profileById } from './terminal-profile'
import { rig } from './test-rig'

const reply = (attachment: string, extra: Record<string, unknown> = {}) => ({
  ...SUPPORTED_ATTACH_REPLY,
  attachment,
  control: { ...SUPPORTED_ATTACH_REPLY.control, attachment },
  ...extra,
})

/** Opened under the caller's own name "pane-7"; the host answers with the name it minted. */
async function opened(minted = 'ta-minted-1') {
  const r = rig()
  r.handlers.open = () => SUPPORTED_OPEN_REPLY
  r.handlers.attach = () => reply(minted)
  r.handlers.input = () => ({ accepted: true })
  r.handlers.resize = () => ({})
  r.handlers.paste = () => ({ accepted: true })
  r.handlers.close = () => ({})
  const done = await r.session.open({
    profile: profileById('Herdr shell'),
    cols: 80,
    rows: 24,
    attachment: 'pane-7',
  })
  expect(done.outcome).toBe('accepted')
  return r
}

/** The body the host was sent. */
const body = (call: { request: Record<string, unknown> }) =>
  (call.request.body ?? call.request) as Record<string, unknown>

const claimOf = (name: string, epoch = 1) => ({ attachment: name, epoch })

describe('the attachment name the host minted', () => {
  test('the first attach carries the caller name, and the session adopts the one the host returned', async () => {
    const r = await opened()
    expect(body(r.of('attach')[0]!)).toMatchObject({ attachment: 'pane-7' })
    expect(r.session.state.attachment).toBe('ta-minted-1')
  })

  test('input, binary input, resize, paste and detach all carry the minted name', async () => {
    const r = await opened()
    await r.session.input('a')
    await r.session.inputBytes(btoa('b'))
    await r.session.resize(100, 30)
    await r.session.paste('c')
    await r.session.detach()
    for (const op of ['input', 'inputBytes', 'resize', 'paste', 'close'])
      for (const call of r.of(op))
        expect(body(call), op).toMatchObject({ attachment: 'ta-minted-1' })
    expect(r.of('input')).toHaveLength(1)
    expect(r.of('inputBytes')).toHaveLength(1)
  })

  test('a caller claim naming the superseded own name in the same epoch is translated to the host name', async () => {
    const r = await opened()
    const done = await r.session.input('x', 'human', {
      claim: claimOf('pane-7'),
    })
    expect(done.outcome).toBe('accepted')
    expect(body(r.of('input')[0]!)).toMatchObject({
      attachment: 'ta-minted-1',
    })
    expect(body(r.of('input')[0]!).attachment).not.toBe('pane-7')
    await r.session.resize(90, 20, { claim: claimOf('pane-7') })
    expect(body(r.of('resize')[0]!)).toMatchObject({
      attachment: 'ta-minted-1',
    })
  })

  test('a claim naming the superseded name for another epoch is refused locally and nothing is sent', async () => {
    const r = await opened()
    const done = await r.session.input('x', 'human', {
      claim: claimOf('pane-7', 2),
    })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'terminal_attachment_superseded',
      terminalId: 'hc-fixture-1',
      bindingEpoch: 1,
    })
    expect(done.outcome === 'refused' && done.reason).toContain('pane-7')
    expect(done.outcome === 'refused' && done.reason).toContain('ta-minted-1')
    const resized = await r.session.resize(90, 20, {
      claim: claimOf('pane-7', 2),
    })
    expect(resized).toMatchObject({ code: 'terminal_attachment_superseded' })
    expect(r.of('input')).toEqual([])
    expect(r.of('resize')).toEqual([])
  })

  test('a claim that already names the host name, or some other name, goes as it is', async () => {
    const r = await opened()
    await r.session.input('x', 'human', { claim: claimOf('ta-minted-1') })
    await r.session.input('y', 'human', { claim: claimOf('someone-else') })
    expect(r.of('input').map((c) => body(c).attachment)).toEqual([
      'ta-minted-1',
      'someone-else',
    ])
  })

  test('a re-attach that is minted another name moves every later write, and the earlier minted name is refused across epochs', async () => {
    const r = await opened()
    r.handlers.attach = () =>
      reply('ta-minted-2', {
        epoch: 2,
        binding: { ...SUPPORTED_OPEN_REPLY.binding, epoch: 2 },
        control: {
          ...SUPPORTED_ATTACH_REPLY.control,
          attachment: 'ta-minted-2',
          epoch: 2,
        },
        offset_start: 5,
        offset_end: 5,
        data: '',
        truncated: true,
      })
    // The host rebinds the terminal; the session attaches again to read the new epoch.
    r.emit('terminal.opened', {
      session: 'hc-fixture-1',
      epoch: 2,
      program: 1,
      origin: 'reattached',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(r.of('attach')).toHaveLength(2)
    // The re-attach asked with the name the host had given.
    expect(body(r.of('attach')[1]!)).toMatchObject({
      attachment: 'ta-minted-1',
    })
    expect(r.session.state.attachment).toBe('ta-minted-2')
    expect(r.session.state.bindingEpoch).toBe(2)
    await r.session.input('z')
    await r.session.resize(60, 10)
    for (const op of ['input', 'resize'])
      expect(body(r.of(op).at(-1)!), op).toMatchObject({
        attachment: 'ta-minted-2',
      })
    // Neither earlier name is guessed into the new epoch.
    for (const old of ['pane-7', 'ta-minted-1']) {
      const refused = await r.session.input('q', 'human', {
        claim: claimOf(old, 1),
      })
      expect(refused, old).toMatchObject({
        outcome: 'refused',
        code: 'terminal_attachment_superseded',
      })
    }
    expect(r.of('input')).toHaveLength(1)
    await r.session.detach()
    expect(body(r.of('close').at(-1)!)).toMatchObject({
      attachment: 'ta-minted-2',
    })
  })
})
