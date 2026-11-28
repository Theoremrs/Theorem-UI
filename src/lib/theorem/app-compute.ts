// SOURCING: the platform's fetch, through this origin's Theorem proxy
// (src/server/theorem-proxy.ts adds the bearer), against the backend's compute
// routes (rustyred-thg-server compute_rest.rs over theorem-compute's ops): the
// same calls the agent's `compute` operation takes, so an App reruns what the
// agent computed without a model. CSRF comes from the session bootstrap, as
// artifact-store.ts's writes do.

export const COMPUTE_ROUTE = '/api/compute/v1'

/** The actions the backend answers with read scope; every other call is a write. */
const READS = new Set([
  'status',
  'wait',
  'logs',
  'progress',
  'result',
  'output',
  'receipt',
  'compare',
  'jobs',
  'environments',
  'discover',
])

/** The backend refused or failed a computation call; `code` is its own. */
export class ComputeRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ComputeRefused'
  }
}

/** An output of a computation, as its bytes and the media type it was saved as. */
export interface ComputeOutput {
  bytes: Uint8Array
  mediaType: string
}

/** What an App reaches computations through. */
export interface AppCompute {
  call: (request: Record<string, unknown>) => Promise<unknown>
  output: (job: string, name: string) => Promise<ComputeOutput>
}

type Request = (input: string, init: RequestInit) => Promise<Response>

export interface AppComputeOptions {
  request?: Request
  /** The session's CSRF token; `fresh` asks for a new one after a 403. */
  csrf?: (fresh: boolean) => Promise<string>
}

async function sessionCsrf(fresh: boolean) {
  const { bootstrap } = await import('./client')
  return (await bootstrap(fresh)).csrfToken
}

async function refusal(response: Response): Promise<ComputeRefused> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string }
  } | null
  const code = body?.error?.code ?? `http_${response.status}`
  return new ComputeRefused(response.status, code, body?.error?.message ?? code)
}

export function appCompute(options: AppComputeOptions = {}): AppCompute {
  const request: Request =
    options.request ?? ((input, init) => window.fetch(input, init))
  const csrf = options.csrf ?? sessionCsrf

  return {
    async call(body) {
      const write = !READS.has(String(body.action))
      const key = crypto.randomUUID()
      const send = async (fresh: boolean) =>
        request(`${COMPUTE_ROUTE}/calls`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(write
              ? { 'X-CSRF-Token': await csrf(fresh), 'Idempotency-Key': key }
              : {}),
          },
          body: JSON.stringify(body),
        })
      const first = await send(false)
      const response = write && first.status === 403 ? await send(true) : first
      if (!response.ok) throw await refusal(response)
      return response.json()
    },
    async output(job, name) {
      const response = await request(
        `${COMPUTE_ROUTE}/jobs/${encodeURIComponent(job)}/outputs/${encodeURIComponent(name)}`,
        { method: 'GET' },
      )
      if (!response.ok) throw await refusal(response)
      return {
        bytes: new Uint8Array(await response.arrayBuffer()),
        mediaType:
          response.headers.get('content-type') ?? 'application/octet-stream',
      }
    },
  }
}
