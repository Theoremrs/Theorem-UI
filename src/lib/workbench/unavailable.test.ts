// SOURCING: none — bun:test over every owner that lists or reads project data (files, scm, search, run, language, documents) with a client whose every operation fails; AC-51 (R40, R38). The SDK's own TheoremError and TheoremTimeoutError are the errors thrown.
import { describe, expect, test } from 'bun:test'
import { TheoremError, TheoremTimeoutError } from '@theoremharness/sdk-ide'
import { createDocuments } from './documents/documents'
import {
  op,
  stubHost,
  testEnvironment,
  FakeLive,
} from './environment/test-host'
import { createFiles } from './files/files'
import { createLanguage } from './language/language'
import { createRunner } from './run/run'
import { createScm } from './scm/scm'
import { createSearch } from './search/search'

const OPS = [
  'workspace.files.list',
  'workspace.files.stat',
  'workspace.files.read',
  'scm.status',
  'scm.branches',
  'scm.log',
  'scm.diff',
  'search.query',
  'run.list',
  'run.start',
  'language.hover',
  'diagnostics.subscribe',
  'documents.open',
  'documents.edit',
  'documents.save',
  'documents.close',
  'documents.reconcile',
].map((name) => op(name))

/** Every operation under `ide.<group>` and `documentSessions` answers by throwing `error`. */
function failing(error: () => unknown): unknown {
  const node = (): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => (key === 'then' ? undefined : node()),
      apply: () => Promise.reject(error()),
    })
  return node()
}

const ERRORS: Record<string, () => unknown> = {
  'a structured plain error with a body': () => ({
    statusCode: 500,
    body: { title: 'The project store is offline', code: 'store_offline' },
  }),
  'an SDK error whose message dumps the body': () =>
    new TheoremError({
      message: 'The host failed',
      statusCode: 500,
      body: { title: 'The project store is offline', detail: 'Retry later' },
    }),
  'an SDK timeout': () => new TheoremTimeoutError('Timeout exceeded'),
  'an object with nothing readable in it': () => ({ statusCode: 503 }),
}

async function rig(error: () => unknown) {
  const host = stubHost(OPS)
  const real = host.client.ide.workspace
  const broken = failing(error) as Record<string, unknown>
  const dead = () => async () => {
    throw error()
  }
  host.client = {
    ...host.client,
    documentSessions: broken,
    ide: new Proxy(
      { workspace: real },
      {
        get: (target, key) =>
          key in target ? (target as never)[key] : (broken as never)[key],
      },
    ),
  } as never
  host.on('filesList', dead())
  host.on('filesStat', dead())
  host.on('filesRead', dead())
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  return environment
}

/** A person can read it: words, no object or stack dump. */
function expectReadable(reason: unknown) {
  expect(typeof reason).toBe('string')
  const text = String(reason)
  expect(text.length).toBeGreaterThan(0)
  expect(text).not.toContain('[object Object]')
  expect(text).not.toContain('Body:')
  expect(text).not.toContain('Status code:')
  expect(text).not.toMatch(/\n\s+at /)
  expect(text).not.toContain('{')
}

type Answer = { outcome: string; reason?: unknown; value?: unknown }

const READS: [
  string,
  (env: Awaited<ReturnType<typeof rig>>) => Promise<Answer>,
][] = [
  ['files.list', (env) => createFiles(env).list({ requestId: 'r', path: '' })],
  ['files.stat', (env) => createFiles(env).stat({ requestId: 'r', path: 'a' })],
  ['files.read', (env) => createFiles(env).read({ requestId: 'r', path: 'a' })],
  [
    'files.search',
    (env) => createFiles(env).search({ requestId: 'r', query: 'a' }),
  ],
  ['scm.status', (env) => createScm(env).status({ requestId: 'r' })],
  ['scm.branches', (env) => createScm(env).branches({ requestId: 'r' })],
  ['scm.log', (env) => createScm(env).log({ requestId: 'r', maxCount: 5 })],
  ['scm.diff', (env) => createScm(env).diff({ requestId: 'r', staged: false })],
  ['run.list', (env) => createRunner(env as never).list({ requestId: 'r' })],
  [
    'run.poll',
    (env) => createRunner(env as never).poll({ requestId: 'r', handle: 'h' }),
  ],
  [
    'search.query',
    (env) =>
      createSearch(env as never).query({
        requestId: 'r',
        query: 'x',
        regex: false,
        caseSensitive: false,
        wholeWord: false,
        limit: 10,
      }),
  ],
  [
    'language.diagnostics',
    (env) =>
      createLanguage(env as never).diagnostics({
        requestId: 'r',
        resourceId: 'a',
        revision: 1,
      }),
  ],
  [
    'documents.open',
    (env) => createDocuments(env).open({ requestId: 'r', path: 'a.txt' }),
  ],
]

describe('project data the host cannot give', () => {
  for (const [errorName, error] of Object.entries(ERRORS)) {
    for (const [owner, read] of READS) {
      test(`${owner} answers ${errorName} as failed, refused or uncertain with a readable reason, never as an empty success`, async () => {
        const env = await rig(error)
        const done = await read(env)
        expect(['failed', 'refused', 'uncertain']).toContain(done.outcome)
        expect(done.value).toBeUndefined()
        expectReadable(done.reason ?? (done as { reason?: unknown }).reason)
      })
    }
  }

  test('the reason carries the host detail, not the status dump', async () => {
    const env = await rig(ERRORS['an SDK error whose message dumps the body']!)
    const done = await createScm(env).status({ requestId: 'r' })
    expect(done).toMatchObject({ outcome: 'failed' })
    expect(String((done as { reason?: unknown }).reason)).toContain(
      'Retry later',
    )
  })

  test('a project that cannot be reached at all is answered by every owner as not done, with a reason, and does not hang', async () => {
    const host = stubHost(OPS)
    host.client = {
      ...host.client,
      remoteWorkspaces: {
        open: async () => {
          throw new TheoremError({
            statusCode: 503,
            body: { title: 'The project is unreachable' },
          })
        },
        capabilities: async () => {
          throw new TheoremError({
            statusCode: 503,
            body: { title: 'The project is unreachable' },
          })
        },
      },
    } as never
    const { environment } = testEnvironment(host, new FakeLive())
    for (const [owner, read] of READS) {
      const done = await Promise.race([
        read(environment as never),
        new Promise<Answer>((resolve) =>
          setTimeout(() => resolve({ outcome: 'hung' }), 1500),
        ),
      ])
      expect(['failed', 'refused', 'uncertain'], owner).toContain(done.outcome)
      expect(done.value, owner).toBeUndefined()
      expectReadable(done.reason)
    }
    environment.dispose()
  })
})
