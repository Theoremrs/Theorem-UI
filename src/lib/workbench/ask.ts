// SOURCING: none — the one request wrapper the language, run and search owners share: ./environment/run's createRun plus the identity stamp and the stale-generation guard (an answer read under an environment generation the owner has since left is dropped and counted); no upstream models "the environment reopened while this was in flight".

import type { Environment, OperationHeaders } from './environment/environment'
import { createRun } from './environment/run'
import { accepted, refused } from './environment/result'
import type { Answers, Completion } from './environment/result'

/** Which host a result was read from: the workspace, the host's version and epoch, and how many times this owner has seen the workspace reopened. */
export interface ReadAt {
  workspaceId: string
  version?: string
  epoch?: string
  generation: number
}

export type Raw = Record<string, unknown>

export const raw = (value: unknown): Raw =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : {}
export const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
export const num = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined

/** A path that stays inside the workspace: relative, with no `..` segment. */
export const outsideWorkspace = (path: string): boolean =>
  path === '' ||
  path.startsWith('/') ||
  path.includes('\0') ||
  path.split('/').some((segment) => segment === '..')

type Source = Pick<
  Environment,
  | 'workspaceId'
  | 'identity'
  | 'settled'
  | 'availabilityFor'
  | 'headers'
  | 'subscribe'
>

export function createAsk(env: Source) {
  const { workspaceId } = env
  const run = createRun(env)
  let generation = 0
  let dropped = 0
  const off = env.subscribe((event) => {
    if (event.type === 'reopened') generation += 1
  })

  const readAt = (): ReadAt => {
    const { version, epoch } = env.identity
    return {
      workspaceId,
      generation,
      ...(version ? { version } : {}),
      ...(epoch ? { epoch } : {}),
    }
  }

  /**
   * One host operation, which must be listed: unlisted is `missing_capability`. A write is sent
   * once. An accepted answer read under another generation or epoch than the request started in
   * is not delivered: it is refused `stale_generation` and counted.
   */
  async function ask<TOut>(
    requestId: string,
    operation: string,
    write: boolean,
    call: (headers: OperationHeaders) => PromiseLike<unknown>,
    shape: (answer: unknown, readAt: ReadAt) => TOut,
  ): Promise<Completion<TOut>> {
    await env.settled()
    const started = readAt()
    const done = await run(requestId, operation, write, call, {
      advertised: true,
    })
    if (done.outcome !== 'accepted') return done
    const answers: Answers = { workspaceId, requestId }
    const now = readAt()
    if (now.generation !== started.generation || now.epoch !== started.epoch) {
      dropped += 1
      return refused(
        answers,
        'stale_generation',
        `${operation}: the workspace was reopened while this was in flight`,
      )
    }
    return accepted(answers, shape(done.value, now))
  }

  return {
    workspaceId,
    ask,
    readAt,
    /** Accepted answers withheld because the environment had moved on. */
    dropped: () => dropped,
    dispose: off,
  }
}

export type Ask = ReturnType<typeof createAsk>
