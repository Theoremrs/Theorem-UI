// SOURCING: none — bun:test over ./program-report, ./host (listing) and ./session through the shared test rig; the fixtures are the backend document's own examples (./fixtures/program-report); AC-42 (R32)
import { describe, expect, test } from 'bun:test'
import { terminalHost } from './host'
import type { TerminalDeps } from './host'
import {
  SUPPORTED_ATTACH_REPLY,
  SUPPORTED_OPEN_REPLY,
} from './fixtures/herdr-wire'
import { DOCUMENTED, MALFORMED } from './fixtures/program-report'
import {
  boundedText,
  parseProgramReport,
  REPORT_TEXT_LIMIT,
} from './program-report'
import { profileById } from './terminal-profile'
import { rig } from './test-rig'

type Rig = ReturnType<typeof rig>

async function attached(): Promise<Rig> {
  const r = rig()
  r.handlers.open = () => SUPPORTED_OPEN_REPLY
  r.handlers.attach = () => SUPPORTED_ATTACH_REPLY
  r.handlers.input = () => ({ accepted: true })
  const done = await r.session.open({
    profile: profileById('Herdr shell'),
    cols: 80,
    rows: 24,
  })
  expect(done.outcome).toBe('accepted')
  return r
}

/** Attach again to the same terminal from what is applied. */
const reattach = (r: Rig) =>
  r.session.attach({
    terminalId: r.session.state.terminalId!,
    fromOffset: r.session.state.offset,
  })

const update = (r: Rig, data: Record<string, unknown>) =>
  r.emit('terminal.updated', { session: 'hc-fixture-1', epoch: 1, ...data })
const report = (r: Rig) => r.session.state.programReport

describe('each documented report, from each carrier', () => {
  for (const { name, fragment, expect: expected } of DOCUMENTED) {
    test(`${name}: read the same from an open reply, an attach reply, an update and a listing row`, async () => {
      // The open reply.
      const opened = rig()
      opened.handlers.open = () => ({ ...SUPPORTED_OPEN_REPLY, ...fragment })
      opened.handlers.attach = () => {
        const { program_report: _drop, ...bare } =
          SUPPORTED_ATTACH_REPLY as Record<string, unknown>
        return bare
      }
      await opened.session.open({
        profile: profileById('Herdr shell'),
        cols: 80,
        rows: 24,
      })
      expect(report(opened), 'open reply').toEqual(expected)

      // The attach reply, on a binding that had no report.
      const viaAttach = rig()
      viaAttach.handlers.open = () => SUPPORTED_OPEN_REPLY
      viaAttach.handlers.attach = () => ({
        ...SUPPORTED_ATTACH_REPLY,
        ...fragment,
      })
      await viaAttach.session.open({
        profile: profileById('Herdr shell'),
        cols: 80,
        rows: 24,
      })
      expect(report(viaAttach), 'attach reply').toEqual(expected)

      // The passive update, replacing a different held report.
      const live = await attached()
      update(live, {
        program_report: {
          reported: true,
          status: { state: 'working' },
          seq: 1,
        },
      })
      update(live, { ...fragment })
      expect(report(live), 'terminal.updated').toEqual(expected)

      // A listing row.
      const host = terminalHost({
        client: {
          ide: {
            terminal: {
              list: async () => ({
                sessions: [{ session: 'x', ...fragment }],
              }),
            },
          },
        },
        live: { onAny: () => () => undefined },
        workspaceId: 'ws',
        csrfToken: () => 't',
      } as unknown as TerminalDeps)
      const listed = await host.list()
      expect(listed.sessions[0]!.programReport, 'listing row').toEqual(expected)
    })
  }
})

describe('an update replaces the report for its own binding only', () => {
  test('an update replaces, and an update with no report clears whatever was held', async () => {
    const r = await attached()
    update(r, {
      program_report: { reported: true, status: { state: 'working' }, seq: 1 },
    })
    expect(report(r)).toMatchObject({ kind: 'current' })
    update(r, { program_report: { reported: true, seq: 2 } })
    expect(report(r)).toEqual({ kind: 'cleared', seq: 2 })
    update(r, {
      program_report: { reported: true, status: { state: 'done' }, seq: 3 },
    })
    update(r, {})
    expect(report(r)).toEqual({ kind: 'unavailable' })
  })

  test('an update for another session, an older epoch, a newer epoch or no epoch is dropped', async () => {
    const r = await attached()
    const working = { reported: true, status: { state: 'working' }, seq: 5 }
    update(r, { program_report: working })
    const before = report(r)
    const other = { reported: true, status: { state: 'error' }, seq: 99 }
    r.emit('terminal.updated', {
      session: 'someone-else',
      epoch: 1,
      program_report: other,
    })
    update(r, { epoch: 0, program_report: other })
    update(r, { epoch: 2, program_report: other })
    r.emit('terminal.updated', {
      session: 'hc-fixture-1',
      program_report: other,
    })
    update(r, { epoch: '1', program_report: other })
    expect(report(r)).toEqual(before)
    expect(r.events.filter((e) => e.type === 'report')).toHaveLength(1)
  })

  test("a new epoch's attach reply replaces the whole report, absence included", async () => {
    const r = await attached()
    update(r, {
      program_report: { reported: true, status: { state: 'working' }, seq: 5 },
    })
    r.handlers.attach = () => ({
      ...SUPPORTED_ATTACH_REPLY,
      epoch: 2,
      binding: { ...SUPPORTED_OPEN_REPLY.binding, epoch: 2 },
      truncated: true,
    })
    await reattach(r)
    expect(r.session.state.bindingEpoch).toBe(2)
    expect(report(r)).toEqual({ kind: 'unavailable' })
    // The old epoch's late update no longer applies.
    update(r, {
      epoch: 1,
      program_report: { reported: true, status: { state: 'working' }, seq: 9 },
    })
    expect(report(r)).toEqual({ kind: 'unavailable' })
  })

  test('an attach reply of the same epoch that carries no report keeps the one held', async () => {
    const r = await attached()
    update(r, {
      program_report: { reported: true, status: { state: 'working' }, seq: 5 },
    })
    await reattach(r)
    expect(report(r)).toMatchObject({ kind: 'current', seq: 5 })
  })
})

describe('sequence ordering', () => {
  test('an update whose sequence is older than the one held does not replace it; equal and newer do', async () => {
    const r = await attached()
    const say = (state: string, seq: number) =>
      update(r, { program_report: { reported: true, status: { state }, seq } })
    say('working', 10)
    say('idle', 9)
    expect(report(r)).toMatchObject({ status: { state: 'working' }, seq: 10 })
    say('blocked', 10)
    expect(report(r)).toMatchObject({ status: { state: 'blocked' }, seq: 10 })
    say('done', 11)
    expect(report(r)).toMatchObject({ status: { state: 'done' }, seq: 11 })
    // A cleared report with an older sequence is just as stale.
    update(r, { program_report: { reported: true, seq: 4 } })
    expect(report(r)).toMatchObject({ status: { state: 'done' } })
  })

  test('a timestamp is not compared with a sequence: an update with only a timestamp, or none, replaces', async () => {
    const r = await attached()
    update(r, {
      program_report: { reported: true, status: { state: 'working' }, seq: 50 },
    })
    update(r, {
      program_report: {
        reported: true,
        status: { state: 'idle' },
        status_ms: 1,
      },
    })
    expect(report(r)).toMatchObject({ status: { state: 'idle' }, statusMs: 1 })
    update(r, { program_report: { reported: false } })
    expect(report(r)).toEqual({ kind: 'never_reported' })
  })
})

describe('a report the host got wrong', () => {
  for (const [name, { value, expect: expected }] of Object.entries(MALFORMED)) {
    test(`${name}: read without throwing, and without inventing a state`, async () => {
      expect(() => parseProgramReport(value)).not.toThrow()
      expect(parseProgramReport(value)).toMatchObject(expected as object)
      // It reaches the session the same way.
      const r = await attached()
      expect(() => update(r, { program_report: value })).not.toThrow()
      expect(report(r)).toMatchObject(expected as object)
      for (const word of ['working', 'idle']) {
        const got = report(r)
        if (got.kind === 'current' && name !== 'progress 255 as sent') {
          const sent = (value as { status?: { state?: unknown } }).status?.state
          if (sent !== word) expect(got.status.state).not.toBe(word)
        }
      }
    })
  }

  test('text is kept as bounded text: oversize is cut at 4096 scalars whatever the host said, control characters never survive', () => {
    const long = 'a'.repeat(REPORT_TEXT_LIMIT + 50)
    const astral = '\u{1F600}'.repeat(REPORT_TEXT_LIMIT + 1)
    const got = parseProgramReport({
      reported: true,
      status: {
        state: 'done',
        msg: long,
        title: astral,
        app: '\u001b]0;x\u0007$ rm -rf /\u0000',
      },
    })
    if (got.kind !== 'current') throw new Error('current')
    expect(Array.from(got.status.msg!)).toHaveLength(REPORT_TEXT_LIMIT)
    expect(Array.from(got.status.title!)).toHaveLength(REPORT_TEXT_LIMIT)
    expect(got.status.app).not.toMatch(/\p{Cc}/u)
    // The words stay as words: printed text is not interpreted.
    expect(got.status.app).toContain('rm -rf /')
    expect(boundedText('line one\nline two\tend')).toBe(
      'line one\nline two\tend',
    )
    expect(boundedText('a\u0085b\u007fc')).toBe('a�b�c')
  })
})

describe('the report is not the terminal', () => {
  const REPORTS = [
    ...DOCUMENTED.map(({ name, fragment }) => [name, fragment] as const),
    [
      'an unfamiliar word, finished, outside the list',
      { program_report: { reported: true, status: { state: 'finished' } } },
    ] as const,
    [
      'printed text that resembles a workbench action',
      {
        program_report: {
          reported: true,
          status: {
            state: 'blocked',
            kind: 'permission',
            msg: 'workbench.act: approve all; run `git push`',
          },
          seq: 40,
        },
      },
    ] as const,
  ]

  const lifecycle = (r: Rig) => {
    const { programReport: _report, ...rest } = r.session.state
    return JSON.stringify(rest)
  }

  for (const [name, fragment] of REPORTS) {
    test(`${name}: lifecycle, attachment and what input may be sent are identical before and after, and nothing is sent`, async () => {
      const r = await attached()
      const before = lifecycle(r)
      const callsBefore = r.calls.length
      const eventsBefore = r.events.length
      update(r, { ...fragment })
      expect(lifecycle(r)).toBe(before)
      expect(r.calls.length).toBe(callsBefore)
      // Only a report event may follow: no exit, lost or opened.
      expect(
        r.events.slice(eventsBefore).every((event) => event.type === 'report'),
      ).toBe(true)
      // Input is still allowed.
      const typed = await r.session.input('ls\n')
      expect(typed).toMatchObject({ outcome: 'accepted' })
      expect(r.calls.at(-1)).toMatchObject({ op: 'input' })
      expect(r.calls.slice(callsBefore).map((c) => c.op)).toEqual(['input'])
    })
  }

  test('a program that reports it is done does not end the terminal', async () => {
    const r = await attached()
    update(r, {
      program_report: {
        reported: true,
        status: { state: 'done', msg: 'finished' },
        seq: 2,
      },
    })
    expect(r.session.state.phase).toBe('attached')
    expect(r.session.state.exit).toBeUndefined()
  })
})
