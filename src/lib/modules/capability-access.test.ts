// SOURCING: bun:test over theorem.module/1's capability access, agent representation and fallback,
// as a module.json in the vault declares them: parsed by parseManifest, listed for the person by
// requestsOf, allowed by allowedFrom and intersected by granted, as sandboxed-module.tsx uses them.
import { describe, expect, test } from 'bun:test'
import { ModuleFileError, parseManifest } from './contract'
import type { InstanceRequest } from './contract'
import { granted } from './grants'
import { fromManifest } from './registry'
import { allowedFrom, describeRequest, requestId, requestsOf } from './sandbox'

const base = {
  schema: 'theorem.module/1',
  id: 'vault.focus',
  label: 'Focus',
  outputs: [{ name: 'summary', label: 'Summary', type: 'text' }],
  implementation: { kind: 'sandboxed-html' },
}

const manifest = (extra: Record<string, unknown> = {}) =>
  parseManifest(
    'Modules/focus/module.json',
    JSON.stringify({ ...base, ...extra }),
  )

const refusal = (extra: Record<string, unknown>) => {
  try {
    manifest(extra)
    return 'parsed'
  } catch (error) {
    if (error instanceof ModuleFileError) return error.message
    throw error
  }
}

const tracker: InstanceRequest = {
  instanceId: 'tracker/main',
  methods: ['describe', 'query', 'invoke'],
  actions: ['complete'],
}

describe('capability access in a module manifest', () => {
  test('a manifest declares the instances it reaches, how an agent reads it, and its fallback', () => {
    const parsed = manifest({
      capabilities: { instances: [tracker] },
      agent: {
        description: 'Shows open tasks that fit the minutes you have.',
        summaryOutput: 'summary',
      },
      fallback: {
        kind: 'capability-records',
        instanceId: 'tracker/main',
        viewKey: 'open',
        actions: ['complete'],
      },
    })
    expect(parsed.capabilities.instances).toEqual([tracker])
    expect(parsed.agent?.summaryOutput).toBe('summary')
    expect(parsed.fallback).toEqual({
      kind: 'capability-records',
      instanceId: 'tracker/main',
      viewKey: 'open',
      actions: ['complete'],
    })
    const definition = fromManifest(parsed, 'Modules/focus/module.json')
    expect(definition.agent).toEqual(parsed.agent)
    expect(definition.fallback).toEqual(parsed.fallback)
    expect(definition.capabilities.instances).toEqual([tracker])
  })

  test('a manifest written before any of this still parses, asking for nothing new', () => {
    const parsed = manifest()
    expect(parsed.capabilities.instances).toBeUndefined()
    expect(parsed.agent).toBeUndefined()
    expect(parsed.fallback).toBeUndefined()
  })

  test('invoke names its actions, actions need invoke, and a summary is a declared output', () => {
    expect(
      refusal({
        capabilities: {
          instances: [{ instanceId: 'tracker/main', methods: ['invoke'] }],
        },
      }),
    ).toContain('invoke names the actions it may run')
    expect(
      refusal({
        capabilities: {
          instances: [
            {
              instanceId: 'tracker/main',
              methods: ['query'],
              actions: ['complete'],
            },
          ],
        },
      }),
    ).toContain('invoke names the actions it may run')
    expect(
      refusal({ agent: { description: 'x', summaryOutput: 'missing' } }),
    ).toContain('agent.summaryOutput: "missing" is not one of the outputs')
    expect(
      refusal({ fallback: { kind: 'table', instanceId: 'tracker/main' } }),
    ).toContain('fallback.kind')
  })
})

describe('asking for and granting capability access', () => {
  const requested = {
    read: ['Notes/**'],
    write: [],
    state: [],
    net: [],
    instances: [
      tracker,
      { instanceId: 'notes/main', methods: ['describe' as const], actions: [] },
    ],
  } as ReturnType<typeof manifest>['capabilities']

  test('each method and each action is its own line to allow', () => {
    const requests = requestsOf(requested)
    expect(requests.map(describeRequest)).toEqual([
      'Read Notes/**',
      'Read how tracker/main is defined',
      'Read records in tracker/main',
      'Run “complete” in tracker/main',
      'Read how notes/main is defined',
    ])
    expect(new Set(requests.map(requestId)).size).toBe(requests.length)
  })

  test('only what is ticked is allowed, and only what was asked is granted', () => {
    const requests = requestsOf(requested)
    const ticked = requests.filter(
      (request) =>
        !(request.kind === 'instance' && request.method === 'invoke') &&
        !(request.kind === 'instance' && request.instanceId === 'notes/main'),
    )
    const allowed = allowedFrom(ticked)
    expect(allowed.instances).toEqual([
      {
        instanceId: 'tracker/main',
        methods: ['describe', 'query'],
        actions: [],
      },
    ])
    expect(granted(requested, allowed).instances).toEqual([
      {
        instanceId: 'tracker/main',
        methods: ['describe', 'query'],
        actions: [],
      },
    ])

    // Allowing an instance or an action that was not asked for grants nothing.
    expect(
      granted(requested, {
        ...allowed,
        instances: [
          { instanceId: 'payroll/main', methods: ['describe'], actions: [] },
          {
            instanceId: 'tracker/main',
            methods: ['invoke'],
            actions: ['delete'],
          },
        ],
      }).instances,
    ).toEqual([])
  })

  test('a grant given before capability access existed allows none of it', () => {
    const old = { read: ['Notes/**'], write: [], state: [], net: [] }
    expect(granted(requested, old)).toEqual({ ...old, instances: [] })
  })
})
