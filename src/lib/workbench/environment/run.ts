// SOURCING: none — the one request wrapper the files, documents and scm owners shared three copies of; it only sequences ./environment's settled, availabilityFor and headers with ./result's outcome mapping.

import type { Environment, OperationHeaders } from './environment'
import { accepted, failure, refused } from './result'
import type { Answers, Completion } from './result'

export interface RunOptions {
  /** Makes an operation the host does not list unavailable (the ones the SDK's typed layer never covered). */
  advertised?: boolean
  /** Sent as the host's idempotency key instead of the request id (a document edit's operation id). */
  idempotencyKey?: string
}

/**
 * One request: wait for the first open attempt, refuse without sending when the environment or the
 * operation is unavailable, then map what the host answers. A write is sent once; a lost answer is
 * `uncertain`, never retried here.
 */
export function createRun(
  env: Pick<
    Environment,
    'workspaceId' | 'settled' | 'availabilityFor' | 'headers'
  >,
) {
  return async function run<T>(
    requestId: string,
    operation: string,
    write: boolean,
    call: (headers: OperationHeaders) => PromiseLike<T> | T,
    options: RunOptions = {},
  ): Promise<Completion<T>> {
    const answers: Answers = { workspaceId: env.workspaceId, requestId }
    await env.settled()
    const availability = env.availabilityFor(operation, options.advertised)
    if (availability.status === 'unavailable') {
      return refused(
        answers,
        availability.cause === 'missing_capability'
          ? 'missing_capability'
          : 'environment_unavailable',
        availability.reason,
      )
    }
    try {
      return accepted(
        answers,
        await call(env.headers(options.idempotencyKey ?? requestId)),
      )
    } catch (error) {
      return failure(answers, error, write)
    }
  }
}
