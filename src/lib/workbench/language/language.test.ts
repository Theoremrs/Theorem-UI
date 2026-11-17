// SOURCING: none — bun:test over ./language with a stub client in the shape of client.ide.language, navigation, refactor and diagnostics
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  HttpError,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import { createLanguage } from './language'

const GROUPS = {
  language: ['hover', 'complete', 'format'],
  navigation: [
    'definition',
    'declaration',
    'typeDefinition',
    'implementation',
    'references',
  ],
  refactor: ['prepare', 'apply'],
  diagnostics: ['subscribe'],
} as const

const ALL = [
  'language.hover',
  'language.complete',
  'language.format',
  'navigation.definition',
  'navigation.declaration',
  'navigation.typeDefinition',
  'navigation.implementation',
  'navigation.references',
  'refactor.prepare',
  'refactor.apply',
  'diagnostics.subscribe',
].map((name) => op(name))

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
  const ide: Record<string, unknown> = { workspace: host.client.ide.workspace }
  for (const [group, methods] of Object.entries(GROUPS)) {
    const api: Record<string, unknown> = {}
    for (const method of methods) {
      const name = `${group}.${method}`
      api[method] = async (
        request: Record<string, unknown>,
        options?: unknown,
      ) => {
        calls.push({ name, request, options })
        return handlers.get(name)?.(request) ?? {}
      }
    }
    ide[group] = api
  }
  host.client = { ...host.client, ide } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  return {
    host,
    environment,
    language: createLanguage(environment as never),
    calls,
    count: (name: string) => calls.filter((call) => call.name === name).length,
    on: (
      name: string,
      handler: (request: Record<string, unknown>) => unknown,
    ) => void handlers.set(name, handler),
  }
}

const at = { requestId: 'r1', resourceId: 'src/a.ts', revision: 7 }
const here = { ...at, line: 3, character: 4 }

describe('hover', () => {
  test('sends the document, revision and position under the request id and answers the markdown and span', async () => {
    const { language, calls, on } = await setup()
    on('language.hover', () => ({
      contents: '**x**',
      location: {
        document: { workspace_id: 'w1', resource_id: 'src/a.ts' },
        version: { session_epoch: 1, revision: 7, content_hash: 'h' },
        start: 4,
        end: 6,
        coordinate_encoding: 'utf8_bytes',
      },
    }))
    const done = await language.hover({ ...here, language: 'typescript' })
    expect(done).toMatchObject({
      outcome: 'accepted',
      workspaceId: 'w1',
      requestId: 'r1',
      value: {
        contents: '**x**',
        span: { start: 4, end: 6, encoding: 'utf8_bytes' },
      },
    })
    expect(calls[0]?.request).toMatchObject({
      workspaceId: 'w1',
      'Idempotency-Key': 'r1',
      body: {
        resource_id: 'src/a.ts',
        language: 'typescript',
        revision: 7,
        line: 3,
        character: 4,
      },
    })
  })

  test('an empty answer is empty contents, not a failure', async () => {
    const { language } = await setup()
    const done = await language.hover(here)
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { contents: '' },
    })
  })
})

describe('complete', () => {
  test('reads the items and keeps the id that resolves them', async () => {
    const { language, on } = await setup()
    on('language.complete', () => ({
      items: [
        {
          label: 'log',
          kind: 2,
          detail: 'fn',
          insertText: 'log()',
          range: {
            inserting: {
              start: { line: 3, character: 1 },
              end: { line: 3, character: 4 },
            },
            replacing: {
              start: { line: 3, character: 1 },
              end: { line: 3, character: 6 },
            },
          },
          item_id: 'c1',
        },
        { nonsense: true },
      ],
    }))
    const done = await language.complete(here)
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: [{ label: 'log', kind: 2, itemId: 'c1', insertText: 'log()' }],
    })
    if (done.outcome === 'accepted') expect(done.value).toHaveLength(1)
  })
})

describe('navigate and references', () => {
  test('reads both location forms from the operation named by the kind', async () => {
    const { language, calls, on } = await setup()
    on('navigation.typeDefinition', () => ({
      locations: [
        {
          document: { workspace_id: 'w1', resource_id: 'src/b.ts' },
          version: { session_epoch: 1, revision: 2, content_hash: 'h' },
          start: 0,
          end: 3,
          coordinate_encoding: 'utf16_code_units',
        },
        {
          uri: 'file:///lib/c.d.ts',
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 2 },
          },
        },
      ],
    }))
    const done = await language.navigate({ ...here, kind: 'typeDefinition' })
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: [
        {
          resourceId: 'src/b.ts',
          revision: 2,
          span: { start: 0, end: 3, encoding: 'utf16_code_units' },
        },
        { uri: 'file:///lib/c.d.ts' },
      ],
    })
    expect(calls.map((call) => call.name)).toEqual([
      'navigation.typeDefinition',
    ])
  })

  test('a kind the owner does not send is refused without a call', async () => {
    const { language, calls } = await setup()
    expect(
      await language.navigate({ ...here, kind: 'callHierarchy' }),
    ).toMatchObject({ outcome: 'refused', code: 'unsupported_navigation' })
    expect(calls).toHaveLength(0)
  })

  test('references flatten the host groups and ask for declarations by default', async () => {
    const { language, calls, on } = await setup()
    const where = {
      uri: 'file:///a.ts',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    }
    on('navigation.references', () => ({
      groups: [{ locations: [where, where] }, where],
    }))
    const done = await language.references(here)
    expect(done.outcome === 'accepted' && done.value).toHaveLength(3)
    expect(calls[0]?.request).toMatchObject({
      body: { include_declaration: true },
    })
  })
})

describe('diagnostics', () => {
  test('answers the snapshot with the revision the host computed it against', async () => {
    const { language, on } = await setup()
    on('diagnostics.subscribe', () => ({
      session_epoch: 2,
      revision: 6,
      content_hash: 'h',
      full: true,
      diagnostics: [
        { id: 'd1', start: 0, end: 4, severity: 'error', message: 'no' },
        { id: 'd2', start: 1, end: 2, severity: 'loud', message: 'bad' },
      ],
    }))
    const done = await language.diagnostics(at)
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: {
        revision: 6,
        sessionEpoch: 2,
        full: true,
        findings: [{ id: 'd1', severity: 'error', start: 0, end: 4 }],
      },
    })
  })
})

describe('format, rename and applyPlan', () => {
  test('format and rename answer the plan id, sent once', async () => {
    const { language, calls, on } = await setup()
    on('language.format', () => ({ plan_id: 'p-format' }))
    on('refactor.prepare', () => ({ plan_id: 'p-rename' }))
    expect(await language.format(at)).toMatchObject({
      outcome: 'accepted',
      value: { planId: 'p-format' },
    })
    expect(
      await language.rename({ ...here, requestId: 'r2', newName: 'next' }),
    ).toMatchObject({ outcome: 'accepted', value: { planId: 'p-rename' } })
    expect(calls[1]?.request).toMatchObject({
      body: { operation: 'rename', new_name: 'next', line: 3 },
    })
    expect(
      calls.every(
        (call) =>
          (call.options as { maxRetries?: number } | undefined)?.maxRetries ===
          0,
      ),
    ).toBe(true)
  })

  test('a host that proposes nothing answers no plan', async () => {
    const { language } = await setup()
    expect(await language.format(at)).toMatchObject({
      outcome: 'accepted',
      value: {},
    })
  })

  test('applyPlan hands the plan id to the host authority', async () => {
    const { language, calls } = await setup()
    expect(
      await language.applyPlan({ requestId: 'r3', planId: 'p1' }),
    ).toMatchObject({ outcome: 'accepted', value: { planId: 'p1' } })
    expect(calls[0]).toMatchObject({
      name: 'refactor.apply',
      request: { body: { plan_id: 'p1' } },
    })
  })

  test('an empty new name is refused before sending', async () => {
    const { language, calls } = await setup()
    expect(await language.rename({ ...here, newName: ' ' })).toMatchObject({
      outcome: 'refused',
      code: 'empty_name',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('what the host did not list', () => {
  test('every operation is refused as missing_capability, naming it, and nothing is called', async () => {
    const { language, calls } = await setup([])
    const answers = await Promise.all([
      language.hover(here),
      language.complete(here),
      language.navigate({ ...here, kind: 'definition' }),
      language.references(here),
      language.diagnostics(at),
      language.format(at),
      language.rename({ ...here, newName: 'n' }),
      language.applyPlan({ requestId: 'r', planId: 'p' }),
    ])
    for (const done of answers) {
      expect(done).toMatchObject({
        outcome: 'refused',
        code: 'missing_capability',
      })
    }
    expect(
      answers.map((done) => (done.outcome === 'refused' ? done.reason : '')),
    ).toEqual([
      expect.stringContaining('language.hover'),
      expect.stringContaining('language.complete'),
      expect.stringContaining('navigation.definition'),
      expect.stringContaining('navigation.references'),
      expect.stringContaining('diagnostics.subscribe'),
      expect.stringContaining('language.format'),
      expect.stringContaining('refactor.prepare'),
      expect.stringContaining('refactor.apply'),
    ])
    expect(calls).toHaveLength(0)
  })

  test('an operation the host lists as not ready is missing too', async () => {
    const { language, calls } = await setup([
      op('language.hover', { ready: false, reason: 'warming up' }),
    ])
    expect(await language.hover(here)).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('refusals, lost answers and stale answers', () => {
  test('the host refusing is a refusal that carries its code', async () => {
    const { language, on } = await setup()
    on('language.hover', () => {
      throw new HttpError(409, { code: 'stale_revision' })
    })
    expect(await language.hover(here)).toMatchObject({
      outcome: 'refused',
      code: 'stale_revision',
    })
  })

  test('a request with no revision, or outside the workspace, is refused before sending', async () => {
    const { language, calls } = await setup()
    expect(
      await language.hover({ ...here, revision: Number.NaN }),
    ).toMatchObject({ outcome: 'refused', code: 'no_revision' })
    expect(
      await language.hover({ ...here, resourceId: '../secret' }),
    ).toMatchObject({ outcome: 'refused', code: 'outside_workspace' })
    expect(calls).toHaveLength(0)
  })

  test('a lost answer to a rename is uncertain and is never retried', async () => {
    const { language, count, on } = await setup()
    on('refactor.prepare', () => {
      throw new HttpError(undefined)
    })
    expect(await language.rename({ ...here, newName: 'n' })).toMatchObject({
      outcome: 'uncertain',
    })
    expect(count('refactor.prepare')).toBe(1)
  })

  test('a lost answer to a lookup is a failure', async () => {
    const { language, on } = await setup()
    on('language.complete', () => {
      throw new HttpError(503)
    })
    expect((await language.complete(here)).outcome).toBe('failed')
  })

  test('an answer read before the workspace was reopened is dropped and counted', async () => {
    const { language, environment, host, on } = await setup()
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    on('language.hover', () => gate.then(() => ({ contents: 'old' })))
    const pending = language.hover(here)
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
    expect(language.dropped()).toBe(1)
    expect(await language.hover(here)).toMatchObject({ outcome: 'accepted' })
    expect(language.dropped()).toBe(1)
  })
})
