// SOURCING: none — bun:test over ./run and ./port with a stub client in the shape of client.ide.run
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  HttpError,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import type { Effect } from '../wire'
import { createRunPort } from './port'
import { createRunner } from './run'

const METHODS = ['configure', 'start', 'stop', 'subscribe', 'list'] as const
const ALL = METHODS.map((name) => op(`run.${name}`))

async function setup(operations = ALL) {
  const host = stubHost(operations)
  const calls: {
    name: string
    request: Record<string, unknown>
    options?: unknown
  }[] = []
  const handlers = new Map<
    string,
    (request: Record<string, unknown>) => unknown
  >()
  const run: Record<string, unknown> = {}
  for (const name of METHODS) {
    run[name] = async (request: Record<string, unknown>, options?: unknown) => {
      calls.push({ name, request, options })
      return handlers.get(name)?.(request) ?? {}
    }
  }
  host.client = {
    ...host.client,
    ide: { workspace: host.client.ide.workspace, run },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const runner = createRunner(environment as never)
  return {
    host,
    environment,
    runner,
    port: createRunPort(runner),
    calls,
    count: (name: string) => calls.filter((call) => call.name === name).length,
    on: (
      name: string,
      handler: (request: Record<string, unknown>) => unknown,
    ) => void handlers.set(name, handler),
  }
}

describe('configure and start', () => {
  test('configure sends the name and argv once, under the request id', async () => {
    const { runner, calls } = await setup()
    const done = await runner.configure({
      requestId: 'r1',
      name: ' build ',
      argv: ['sh', '-c', 'make'],
    })
    expect(done).toMatchObject({
      outcome: 'accepted',
      requestId: 'r1',
      value: { name: 'build' },
    })
    expect(calls[0]).toMatchObject({
      name: 'configure',
      request: {
        'Idempotency-Key': 'r1',
        body: { name: 'build', argv: ['sh', '-c', 'make'] },
      },
      options: { maxRetries: 0 },
    })
  })

  test('start does not wait for the process and answers the handle', async () => {
    const { runner, calls, on } = await setup()
    on('start', () => ({ handle: 'h1' }))
    expect(await runner.start({ requestId: 'r', name: 'build' })).toMatchObject(
      {
        outcome: 'accepted',
        value: { name: 'build', handle: 'h1' },
      },
    )
    expect(calls[0]?.request).toMatchObject({
      body: { name: 'build', wait: false },
    })
  })

  test('a start the host answers without a handle is uncertain, not accepted', async () => {
    const { runner } = await setup()
    expect(await runner.start({ requestId: 'r', name: 'build' })).toMatchObject(
      {
        outcome: 'uncertain',
      },
    )
  })

  test('an empty name or command is refused before sending', async () => {
    const { runner, calls } = await setup()
    expect(
      await runner.configure({ requestId: 'r', name: '', argv: ['ls'] }),
    ).toMatchObject({ outcome: 'refused', code: 'empty_name' })
    expect(
      await runner.configure({ requestId: 'r', name: 'x', argv: [] }),
    ).toMatchObject({ outcome: 'refused', code: 'empty_command' })
    expect(calls).toHaveLength(0)
  })
})

describe('poll', () => {
  test('answers the cumulative output, the state and where it was read', async () => {
    const { runner, on } = await setup()
    on('subscribe', () => ({
      state: 'exited',
      exit_code: 2,
      stdout: 'out',
      stderr: 'err',
    }))
    const done = await runner.poll({ requestId: 'r', handle: 'h1' })
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: {
        handle: 'h1',
        state: 'exited',
        exitCode: 2,
        stdout: 'out',
        stderr: 'err',
        readAt: {
          workspaceId: 'w1',
          epoch: 'e1',
          version: '1.2.3',
          generation: 0,
        },
      },
    })
  })

  test('a running process has no exit code', async () => {
    const { runner, on } = await setup()
    on('subscribe', () => ({ state: 'running', exit_code: null }))
    const done = await runner.poll({ requestId: 'r', handle: 'h1' })
    expect(done.outcome === 'accepted' && 'exitCode' in done.value).toBe(false)
  })

  test('a poll answered after the workspace was reopened is dropped and counted', async () => {
    const { runner, environment, host, on } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    on('subscribe', () => gate.then(() => ({ state: 'running' })))
    const pending = runner.poll({ requestId: 'r', handle: 'h1' })
    host.on('capabilities', () => ({
      schema: 'theorem-workspace-capabilities/1',
      workspace_id: 'w1',
      version: '1.2.3',
      epoch: 'e2',
      cursor: '0',
      granted_by: 'test-host',
      operations: ALL,
    }))
    await environment.reopen()
    release()
    expect(await pending).toMatchObject({
      outcome: 'refused',
      code: 'stale_generation',
    })
    expect(runner.dropped()).toBe(1)
  })
})

describe('stop', () => {
  test('a stop with no answer is uncertain and is not sent again', async () => {
    const { runner, count, on } = await setup()
    on('stop', () => {
      throw new HttpError(undefined)
    })
    expect(await runner.stop({ requestId: 'r', handle: 'h1' })).toMatchObject({
      outcome: 'uncertain',
    })
    expect(count('stop')).toBe(1)
  })

  test('a stop the host refuses is a refusal with its code', async () => {
    const { runner, on } = await setup()
    on('stop', () => {
      throw new HttpError(404, { code: 'run_not_found' })
    })
    expect(await runner.stop({ requestId: 'r', handle: 'h1' })).toMatchObject({
      outcome: 'refused',
      code: 'run_not_found',
    })
  })
})

describe('what the host did not list', () => {
  test('each operation is refused as missing_capability, naming it, with no call', async () => {
    const { runner, calls } = await setup([])
    const answers = await Promise.all([
      runner.configure({ requestId: 'r', name: 'n', argv: ['ls'] }),
      runner.start({ requestId: 'r', name: 'n' }),
      runner.stop({ requestId: 'r', handle: 'h' }),
      runner.poll({ requestId: 'r', handle: 'h' }),
    ])
    expect(answers).toEqual([
      expect.objectContaining({
        outcome: 'refused',
        code: 'missing_capability',
        reason: expect.stringContaining('run.configure'),
      }),
      expect.objectContaining({
        code: 'missing_capability',
        reason: expect.stringContaining('run.start'),
      }),
      expect.objectContaining({
        code: 'missing_capability',
        reason: expect.stringContaining('run.stop'),
      }),
      expect.objectContaining({
        code: 'missing_capability',
        reason: expect.stringContaining('run.subscribe'),
      }),
    ])
    expect(calls).toHaveLength(0)
  })
})

describe('the run port', () => {
  let id = 0
  const effect = (kind: Effect['kind'], payload: unknown) =>
    ({
      id: (id += 1),
      resource: { type: 'workspace', workspace: 'w1' },
      kind,
      payload,
    }) as never

  test('start answers the wire runStarted and poll a tagged runState', async () => {
    const { port, on } = await setup()
    on('start', () => ({ handle: 'h7' }))
    on('subscribe', () => ({ state: 'running', stdout: 'x' }))
    expect(
      await port.perform(effect('runStart', { name: 'dev' }), 'q1'),
    ).toEqual({
      outcome: 'accepted',
      value: { type: 'runStarted', handle: 'h7' },
    })
    expect(
      await port.perform(effect('runPoll', { handle: 'h7' }), 'q2'),
    ).toMatchObject({
      outcome: 'accepted',
      value: { type: 'runState', handle: 'h7', state: 'running', stdout: 'x' },
    })
  })

  test('configure and stop answer with no payload, and a lost stop stays uncertain', async () => {
    const { port, on } = await setup()
    expect(
      await port.perform(
        effect('runConfigure', { name: 'a', argv: ['ls'] }),
        'q',
      ),
    ).toEqual({ outcome: 'accepted' })
    on('stop', () => {
      throw new HttpError(undefined)
    })
    expect(
      await port.perform(effect('runStop', { handle: 'h' }), 'q'),
    ).toMatchObject({ outcome: 'uncertain' })
  })
})

describe('list', () => {
  test('reads the host’s runs into the wire’s summaries and answers runList', async () => {
    const { port, on, calls } = await setup()
    on('list', () => ({
      runs: [
        {
          handle: 'h1',
          configuration: 'build',
          kind: 'run',
          argv: ['make', 'all'],
          state: 'running',
          exit_code: null,
          started_at_ms: 1700,
        },
        { handle: 'h2', state: 'passed', exit_code: 0 },
        { configuration: 'no handle' },
      ],
    }))
    const done = await port.perform(
      {
        id: 1,
        resource: { type: 'workspace', workspace: 'w1' },
        kind: 'runList',
      },
      'l1',
    )
    expect(done).toEqual({
      outcome: 'accepted',
      value: {
        type: 'runList',
        runs: [
          {
            handle: 'h1',
            name: 'build',
            command: ['make', 'all'],
            state: 'running',
            startedAtMs: 1700,
          },
          { handle: 'h2', state: 'passed' },
        ],
      },
    })
    expect(calls[0]).toMatchObject({ name: 'list', request: { body: {} } })
  })

  test('an answer that lists only configurations is a failure, not an empty list of runs', async () => {
    const { runner, on } = await setup()
    on('list', () => ({ configurations: [{ name: 'build', argv: ['make'] }] }))
    expect(await runner.list({ requestId: 'l1' })).toMatchObject({
      outcome: 'failed',
    })
  })

  test('a host without run.list refuses as missing', async () => {
    const { runner } = await setup(
      METHODS.filter((name) => name !== 'list').map((name) =>
        op(`run.${name}`),
      ),
    )
    expect(await runner.list({ requestId: 'l1' })).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
    })
  })
})
