// SOURCING: Theorem's client operations (theorem-surface-contracts
// client_operation), served with python.run's plumbing
// (lib/python/operations.ts reads the pending requests and posts the receipts);
// the call itself is theorem-compute's interface, which theorem-compute-serve
// on the person's machine answers (./machine.ts).
import { MachineError, callMachine, machinePairing } from './machine'
import type { MachinePairing } from './machine'

/** The operation that computes on the person's own machine, as the turn's tool `machine__compute`. */
export const MACHINE_COMPUTE = 'machine.compute'

/**
 * A turn waits two minutes for the page's answer and a specialist's run one,
 * so a call waits at most this long; a job still running answers with its id.
 */
export const MAX_WAIT_SECONDS = 50
const CALL_TIMEOUT_MS = (MAX_WAIT_SECONDS + 5) * 1000
const WAITING_ACTIONS = new Set(['run', 'wait', 'rerun'])
const CALL_ACTIONS = [
  'run',
  'submit',
  'status',
  'wait',
  'logs',
  'progress',
  'cancel',
  'result',
  'receipt',
  'output',
  'rerun',
  'compare',
  'jobs',
  'environments',
  'create_environment',
  'discover',
]

export const MACHINE_OPERATIONS = [
  {
    name: MACHINE_COMPUTE,
    description: `Computes on the person's own machine, through theorem-compute-serve there: its CPU, GPU, memory and files, in Theorem's scientific environment, with receipts. \`call\` is one call of the compute interface, the same actions and request as compute (run, submit, wait, progress, logs, cancel, result, output, receipt, rerun, compare, jobs, environments, discover), with the request nested as compute nests it: \`{action: "run", request: {source, outputs?, params?, ...}}\`; a request's inputs may name files on that machine by path. A call waits at most ${MAX_WAIT_SECONDS} s: a job still running answers with its id, so \`submit\` a long one and \`wait\` on it. Outputs are read with \`output\`, since only this page reaches the machine.`,
    effect: 'read',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['call'],
      properties: {
        // theorem-compute's ComputeCall, flattened: its full schema is over
        // the 8 KiB a client operation may declare, and a schema naming only
        // `action` left the model writing calls with nothing else.
        call: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { enum: CALL_ACTIONS },
            request: {
              type: 'object',
              description:
                'For run and submit: the computation, as compute takes it.',
              properties: {
                source: { type: 'string' },
                source_path: { type: 'string' },
                entry: { type: 'string' },
                params: { type: 'object' },
                seed: { type: 'integer' },
                inputs: { type: 'object' },
                outputs: { type: 'array', items: { type: 'string' } },
                environment: { type: 'object' },
                resources: { type: 'object' },
                permissions: { type: 'object' },
                budget: { type: 'object' },
                target: { type: 'string' },
                label: { type: 'string' },
              },
            },
            job: { type: 'string' },
            wait_seconds: { type: 'integer', minimum: 0 },
            name: { type: 'string', description: 'For output.' },
            stream: { type: 'string', description: 'For logs.' },
            offset: { type: 'integer', minimum: 0 },
            last: { type: 'integer', minimum: 0, description: 'For progress.' },
            params: { type: 'object', description: 'For rerun.' },
            seed: { type: 'integer', description: 'For rerun.' },
            a: { type: 'string', description: 'For compare.' },
            b: { type: 'string', description: 'For compare.' },
            limit: { type: 'integer', minimum: 1, description: 'For jobs.' },
            environment: {
              type: 'object',
              description: 'For create_environment.',
            },
          },
        },
      },
    },
  },
] as const

/** Declared only while this browser is paired with a machine. */
export const machineTurnOptions = () => ({
  clientOperations: machinePairing() ? MACHINE_OPERATIONS : [],
})

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/** The call as sent: a waiting action waits no longer than the page may. */
export function boundedCall(
  call: Record<string, unknown>,
): Record<string, unknown> {
  if (!WAITING_ACTIONS.has(String(call.action))) return call
  const asked = call.wait_seconds
  const wait =
    typeof asked === 'number' && asked >= 0
      ? Math.min(asked, MAX_WAIT_SECONDS)
      : MAX_WAIT_SECONDS
  return { ...call, wait_seconds: wait }
}

/** A job's outputs keep their reference; their store URLs mean nothing on the machine. */
function withoutStoreUrls(answer: unknown): unknown {
  const view = record(answer)
  if (!Array.isArray(view.outputs)) return answer
  return {
    ...view,
    outputs: view.outputs.map((output) => {
      const { url: _url, ...rest } = record(output)
      return rest
    }),
  }
}

export interface MachineAnswer {
  readonly outcome: 'applied' | 'rejected' | 'failed'
  readonly reason?: string
  readonly result?: { where: 'machine'; machine: string; answer: unknown }
}

/**
 * Answers one call. The machine refusing the call (a bad request, a missing
 * job) is `rejected` with its reason; not reaching the machine is `failed`.
 */
export async function answerMachineRequest(
  args: Record<string, unknown>,
  pairing: MachinePairing | undefined = machinePairing(),
  fetcher: typeof fetch = fetch,
): Promise<MachineAnswer> {
  if (!pairing)
    return {
      outcome: 'failed',
      reason:
        'This browser is no longer paired with a machine; compute elsewhere.',
    }
  const call = record(args.call)
  if (typeof call.action !== 'string')
    return { outcome: 'rejected', reason: 'Pass the compute call as call.' }
  try {
    const answer = await callMachine(
      pairing,
      boundedCall(call),
      CALL_TIMEOUT_MS,
      fetcher,
    )
    return {
      outcome: 'applied',
      result: {
        where: 'machine',
        machine: pairing.url,
        answer: withoutStoreUrls(answer),
      },
    }
  } catch (error) {
    if (
      error instanceof MachineError &&
      error.status &&
      error.status < 500 &&
      error.status !== 401
    )
      return { outcome: 'rejected', reason: error.message }
    return {
      outcome: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    }
  }
}
