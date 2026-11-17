// SOURCING: @theoremharness/sdk — each call is the generated client.ide.run.* operation (configure, start, stop, subscribe), sent through ../ask with the request id as the idempotency key. `run.list` answers `{configurations, runs}`, each run `{handle, configuration, kind, argv, state, exit_code, started_at_ms}`; the SDK's `WorkspaceRuns` freezes one CSRF token, so the generated operation is called directly. the body and answer fields (name, argv, wait, handle, state, exit_code, stdout, stderr) are the ones the Theia extension's theorem-run.ts already uses.

import type { TheoremClient } from '@theoremharness/sdk'
import type { Environment, HostClient } from '../environment/environment'
import { refused } from '../environment/result'
import type { Completion } from '../environment/result'
import { createAsk, num, raw, str } from '../ask'
import type { ReadAt } from '../ask'

/** The calls the run owner makes of a Theorem client. */
export type RunClient = HostClient & {
  ide: {
    run: Pick<
      TheoremClient['ide']['run'],
      'configure' | 'start' | 'stop' | 'subscribe' | 'list'
    >
  }
}

export interface RunState {
  handle: string
  /** The host's word: `running` while it runs, another word once it has ended. */
  state: string
  exitCode?: number
  /** Everything the process wrote so far, not only what is new since the last poll. */
  stdout: string
  stderr: string
  /** The host and generation this was read from; a poll is not tied to a document revision. */
  readAt: ReadAt
}

/** One run the host lists, as it names it. */
export interface RunSummary {
  handle: string
  name?: string
  command?: string[]
  /** The host's word: `running` while it runs, another word once it has ended. */
  state: string
  startedAtMs?: number
  /** How it ended; absent while it runs or when the host sends none. */
  exitCode?: number
  /** The configuration's kind at start. */
  kind?: string
}

interface Request {
  requestId: string
}

export interface Runner {
  readonly workspaceId: string
  configure: (
    request: Request & { name: string; argv: string[] },
  ) => Promise<Completion<{ name: string }>>
  /** Starts without waiting for the process to end. A host that answers with no handle leaves a run nobody can stop: `uncertain`. */
  start: (
    request: Request & { name: string },
  ) => Promise<Completion<{ name: string; handle: string }>>
  /** A lost answer is `uncertain` and the stop is not repeated. */
  stop: (
    request: Request & { handle: string },
  ) => Promise<Completion<{ handle: string }>>
  poll: (request: Request & { handle: string }) => Promise<Completion<RunState>>
  /**
   * The runs the host holds, so one started elsewhere can be followed. Read from the answer's `runs`;
   * an answer with no `runs` list (a host that lists only configurations) is `failed`, never an empty list.
   */
  list: (request: Request) => Promise<Completion<RunSummary[]>>
  /** Answers withheld because the environment had moved on. */
  dropped: () => number
  dispose: () => void
}

export function createRunner(env: Environment<RunClient>): Runner {
  const { ask, workspaceId, dropped, dispose } = createAsk(env)
  const api = () => env.client.ide.run
  /** A write is sent once; the SDK's own retries are off, so the host sees it once. */
  const once = { maxRetries: 0 }

  const needs = (requestId: string, code: string, reason: string) =>
    Promise.resolve(refused({ workspaceId, requestId }, code, reason))

  return {
    workspaceId,
    dropped,
    dispose,

    configure({ requestId, name, argv }) {
      if (name.trim() === '') {
        return needs(requestId, 'empty_name', 'A configuration needs a name')
      }
      if (argv.length === 0 || argv[0] === '') {
        return needs(
          requestId,
          'empty_command',
          'A configuration needs a command',
        )
      }
      return ask(
        requestId,
        'run.configure',
        true,
        (headers) =>
          api().configure(
            { ...headers, body: { name: name.trim(), argv } },
            once,
          ),
        () => ({ name: name.trim() }),
      )
    },

    async start({ requestId, name }) {
      if (name.trim() === '') {
        return needs(
          requestId,
          'empty_name',
          'A run needs a configuration name',
        )
      }
      const done = await ask(
        requestId,
        'run.start',
        true,
        (headers) =>
          api().start({ ...headers, body: { name, wait: false } }, once),
        (answer) => str(raw(answer).handle),
      )
      if (done.outcome !== 'accepted') return done
      if (done.value === undefined || done.value === '') {
        return {
          workspaceId,
          requestId,
          outcome: 'uncertain',
          reason: 'The host started the run but returned no handle',
        }
      }
      return { ...done, value: { name, handle: done.value } }
    },

    stop({ requestId, handle }) {
      if (handle === '') {
        return needs(requestId, 'no_handle', 'A stop needs the run handle')
      }
      return ask(
        requestId,
        'run.stop',
        true,
        (headers) => api().stop({ ...headers, body: { handle } }, once),
        () => ({ handle }),
      )
    },

    async list({ requestId }) {
      const done = await ask(
        requestId,
        'run.list',
        false,
        (headers) => api().list({ ...headers, body: {} }),
        (answer) => raw(answer).runs,
      )
      if (done.outcome !== 'accepted') return done
      if (!Array.isArray(done.value))
        return {
          workspaceId,
          requestId,
          outcome: 'failed',
          reason: 'The host’s run.list names no runs',
        }
      const runs = done.value.flatMap((entry): RunSummary[] => {
        const body = raw(entry)
        const handle = str(body.handle)
        if (!handle) return []
        // A run row names its configuration and the argv actually launched (`run.list`'s `runs`).
        const { argv } = body
        const name = str(body.configuration)
        const startedAtMs = num(body.started_at_ms)
        const exitCode = num(body.exit_code)
        const kind = str(body.kind)
        return [
          {
            handle,
            ...(name ? { name } : {}),
            ...(Array.isArray(argv) && argv.every((a) => typeof a === 'string')
              ? { command: argv }
              : {}),
            state: str(body.state) ?? 'unknown',
            ...(startedAtMs !== undefined ? { startedAtMs } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            ...(kind ? { kind } : {}),
          },
        ]
      })
      return { ...done, value: runs }
    },

    poll({ requestId, handle }) {
      if (handle === '') {
        return needs(requestId, 'no_handle', 'A poll needs the run handle')
      }
      return ask(
        requestId,
        'run.subscribe',
        false,
        (headers) => api().subscribe({ ...headers, body: { handle } }),
        (answer, readAt): RunState => {
          const body = raw(answer)
          const exitCode = num(body.exit_code)
          return {
            handle,
            state: str(body.state) ?? 'unknown',
            ...(exitCode !== undefined ? { exitCode } : {}),
            stdout: str(body.stdout) ?? '',
            stderr: str(body.stderr) ?? '',
            readAt,
          }
        },
      )
    },
  }
}
