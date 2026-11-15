// SOURCING: @theoremharness/sdk — each call is the generated client.ide.run.* operation (configure, start, stop, subscribe), sent through ../ask with the request id as the idempotency key. The SDK has no typed run class; the body and answer fields (name, argv, wait, handle, state, exit_code, stdout, stderr) are the ones the Theia extension's theorem-run.ts already uses.

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
      'configure' | 'start' | 'stop' | 'subscribe'
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
