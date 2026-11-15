// SOURCING: none — bun:test over ./port, with the real language owner on the environment's test host
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import type { Effect } from '../wire'
import { createLanguage } from './language'
import { createLanguagePort } from './port'

async function setup(operations: string[]) {
  const host = stubHost(operations.map((name) => op(name)))
  const calls: { name: string; request: Record<string, unknown> }[] = []
  const handlers = new Map<string, () => unknown>()
  const method = (name: string) => async (request: Record<string, unknown>) => {
    calls.push({ name, request })
    return handlers.get(name)?.() ?? {}
  }
  host.client = {
    ...host.client,
    ide: {
      workspace: host.client.ide.workspace,
      language: {
        hover: method('hover'),
        complete: method('complete'),
        format: method('format'),
      },
      navigation: {
        definition: method('definition'),
        declaration: method('declaration'),
        typeDefinition: method('typeDefinition'),
        implementation: method('implementation'),
        references: method('references'),
      },
      refactor: { prepare: method('prepare'), apply: method('apply') },
      diagnostics: { subscribe: method('subscribe') },
    },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const port = createLanguagePort(createLanguage(environment as never))
  let id = 0
  return {
    calls,
    on: (name: string, handler: () => unknown) =>
      void handlers.set(name, handler),
    perform: (
      kind: Effect['kind'],
      payload?: unknown,
      over: Record<string, unknown> = {},
    ) =>
      port.perform(
        {
          id: (id += 1),
          resource: { type: 'document', workspace: 'w1', resourceId: 'a.ts' },
          revision: { scheme: 'seq', value: 5 },
          kind,
          ...(payload === undefined ? {} : { payload }),
          ...over,
        } as never,
        `req-${id}`,
      ),
  }
}

const position = { line: 1, character: 2 }

describe('the language port', () => {
  test('asks at the revision the effect names and tags the answer', async () => {
    const { perform, on, calls } = await setup(['language.hover'])
    on('hover', () => ({ contents: 'doc' }))
    expect(await perform('languageHover', position)).toEqual({
      outcome: 'accepted',
      value: { type: 'languageHover', contents: 'doc' },
    } as never)
    expect(calls[0]?.request).toMatchObject({
      'Idempotency-Key': 'req-1',
      body: { resource_id: 'a.ts', revision: 5, line: 1, character: 2 },
    })
  })

  test('a diagnostics answer carries the host revision so a stale one can be dropped', async () => {
    const { perform, on } = await setup(['diagnostics.subscribe'])
    on('subscribe', () => ({ revision: 4, full: true, diagnostics: [] }))
    expect(await perform('languageDiagnostics')).toMatchObject({
      outcome: 'accepted',
      revision: { scheme: 'seq', value: 4 },
      value: { type: 'languageDiagnostics', full: true, findings: [] },
    })
  })

  test('rename answers the wire languagePlan, and applying a plan needs no document', async () => {
    const { perform, on } = await setup(['refactor.prepare', 'refactor.apply'])
    on('prepare', () => ({ plan_id: 'p9' }))
    expect(await perform('languageRename', { position, newName: 'x' })).toEqual(
      {
        outcome: 'accepted',
        value: { type: 'languagePlan', planId: 'p9' },
      },
    )
    expect(
      await perform(
        'languageApplyPlan',
        { planId: 'p9' },
        { resource: { type: 'none' } },
      ),
    ).toEqual({ outcome: 'accepted' })
  })

  test('navigation with an unknown kind and a resource of another kind are refused', async () => {
    const { perform } = await setup(['navigation.definition'])
    expect(
      await perform('languageNavigate', { kind: 'moniker', position }),
    ).toMatchObject({ outcome: 'refused', code: 'unsupported_navigation' })
    expect(
      await perform('languageHover', position, { resource: { type: 'none' } }),
    ).toMatchObject({ outcome: 'refused', code: 'wrong_resource' })
  })

  test('an effect without a numbered revision is refused before sending', async () => {
    const { perform, calls } = await setup(['language.hover'])
    expect(
      await perform('languageHover', position, {
        revision: { scheme: 'opaque', value: 'etag' },
      }),
    ).toMatchObject({ outcome: 'refused', code: 'no_revision' })
    expect(calls).toHaveLength(0)
  })

  test('a capability the host did not list is a refusal naming it', async () => {
    const { perform } = await setup([])
    expect(await perform('languageFormat')).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
      reason: expect.stringContaining('language.format'),
    })
  })

  test('a hover leaves the revision to the adapter, which echoes the effect, so the core compares it', async () => {
    const { perform } = await setup(['language.hover'])
    const done = await perform('languageHover', position)
    expect(done.outcome === 'accepted' && done.revision).toBeUndefined()
  })
})

describe('diagnostics feed', () => {
  test('a port given the open documents sends their diagnostics, and one without them sends none', async () => {
    const language = {
      workspaceId: 'w1',
      diagnostics: async ({ requestId }: { requestId: string }) => ({
        workspaceId: 'w1',
        requestId,
        outcome: 'accepted' as const,
        value: { revision: 1, full: true, findings: [] },
      }),
    } as never
    const documents = {
      list: () => [
        { path: 'a.ts', text: 'x', revision: { scheme: 'seq', value: 1 } },
      ],
      on: () => () => {},
    } as never
    const heard: unknown[] = []
    const stop = createLanguagePort(language, { documents }).subscribe!((m) =>
      heard.push(m),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    stop()
    expect(heard).toMatchObject([{ type: 'diagnosticsSet', path: 'a.ts' }])
    expect(createLanguagePort(language).subscribe!(() => {})).toBeInstanceOf(
      Function,
    )
  })
})
