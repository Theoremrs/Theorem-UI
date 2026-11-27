// SOURCING: bun:test over ./contract (EXT-07 codec, EXT-02 contributes),
// ./registry + ./contribute (registration into lib/commands and
// lib/contributions), ./runtime (module command dispatch, EXT-06 causal
// diagnostics), ./describe and ./grants (EXEC-01/02), ./dependencies (EXT-05).
import { afterEach, describe, expect, test } from 'bun:test'
import { executeCommand, commandById } from '@/lib/commands/registry'
import { contributionById } from '@/lib/contributions/registry'
import {
  NewerFormatError,
  guardedWrite,
  manifestText,
  pageText,
  parseManifest,
  parsePage,
} from './contract'
import { describeModules } from './describe'
import { grantFor, useModuleGrants } from './grants'
import { fromManifest, setInstalled, builtin } from './registry'
import {
  clearLoopDiagnostics,
  createPageRuntime,
  listLoopDiagnostics,
} from './runtime'

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema: 'theorem.module/1',
    id: 'acme.notes',
    label: 'Notes',
    actions: [{ name: 'pin', label: 'Pin', type: 'text', futurePort: 1 }],
    capabilities: { read: ['files'] },
    implementation: { kind: 'sandboxed-html', entry: 'index.html' },
    ...extra,
  })

afterEach(() => {
  setInstalled([])
  clearLoopDiagnostics()
})

describe('EXT-07 codec', () => {
  test('unknown manifest fields survive parse and write', () => {
    const text = manifest({
      futureTop: { a: 1 },
      settings: [
        { name: 'heading', label: 'T', kind: 'text', futureSetting: 'keep' },
      ],
    })
    const written = JSON.parse(manifestText(parseManifest('m.json', text)))
    expect(written.futureTop).toEqual({ a: 1 })
    expect(written.settings[0].futureSetting).toBe('keep')
    expect(written.actions[0].futurePort).toBe(1)
    expect(written.implementation.kind).toBe('sandboxed-html')
  })

  test('unknown page fields survive, top-level and nested in the layout', () => {
    const text = JSON.stringify({
      schema: 'theorem.page/1',
      title: 'Desk',
      futurePage: true,
      layout: {
        root: { props: {}, rootExtra: 1 },
        layoutExtra: 'x',
        content: [
          {
            type: 'acme.notes',
            props: {
              id: 'n1',
              on: {
                saved: [
                  {
                    to: { instance: 'n2', action: 'pin', toExtra: 1 },
                    routeExtra: 2,
                  },
                ],
              },
            },
            componentExtra: 3,
          },
        ],
      },
    })
    const written = JSON.parse(pageText(parsePage('p.page.json', text)))
    expect(written.futurePage).toBe(true)
    expect(written.layout.layoutExtra).toBe('x')
    expect(written.layout.root.rootExtra).toBe(1)
    expect(written.layout.content[0].componentExtra).toBe(3)
    const route = written.layout.content[0].props.on.saved[0]
    expect(route.routeExtra).toBe(2)
    expect(route.to.toExtra).toBe(1)
  })

  test('a newer schema or format is refused for writing and shown limited', () => {
    const newer = JSON.stringify({
      schema: 'theorem.page/2',
      title: 'Future',
      layout: 'something new',
    })
    try {
      parsePage('p.page.json', newer)
      throw new Error('should have refused')
    } catch (error) {
      expect(error).toBeInstanceOf(NewerFormatError)
      expect((error as NewerFormatError).limited.title).toBe('Future')
      expect((error as NewerFormatError).raw).toEqual(JSON.parse(newer))
    }
    expect(() => parseManifest('m.json', manifest({ format: 9 }))).toThrow(
      NewerFormatError,
    )
    // The stored text is never replaced by an older client's write.
    expect(() => guardedWrite('p.page.json', newer, '{}')).toThrow(
      NewerFormatError,
    )
    expect(guardedWrite('p.page.json', undefined, 'ok')).toBe('ok')
    expect(
      guardedWrite('p.page.json', '{"schema":"theorem.page/1"}', 'ok'),
    ).toBe('ok')
  })

  test('older files without the new sections still parse', () => {
    const parsed = parseManifest('m.json', manifest())
    expect(parsed.contributes).toBeUndefined()
    expect(parsed.dependencies).toBeUndefined()
  })
})

describe('EXT-02 contributes', () => {
  const contributes = {
    commands: [
      {
        id: 'acme.notes.pin',
        label: 'Pin note',
        effect: 'mutation',
        action: 'pin',
        keys: ['mod+shift+p'],
        args: {
          type: 'object',
          properties: { note: { type: 'string' } },
          required: ['note'],
        },
      },
    ],
    contributions: [
      {
        kind: 'open-handler',
        id: 'acme.notes.open',
        label: 'Notes',
        serves: ['file:md'],
      },
      {
        kind: 'theme',
        id: 'acme.notes.theme',
        label: 'Warm',
        meta: { tokens: { '--a': '#fff' } },
      },
    ],
  }

  test('validates namespaces, actions, serves and theme tokens', () => {
    const bad = (c: unknown) =>
      expect(() =>
        parseManifest('m.json', manifest({ contributes: c })),
      ).toThrow()
    bad({ commands: [{ ...contributes.commands[0], id: 'other.notes.pin' }] })
    bad({ commands: [{ ...contributes.commands[0], action: 'missing' }] })
    bad({
      contributions: [{ kind: 'open-handler', id: 'acme.notes.o', label: 'x' }],
    })
    bad({ contributions: [{ kind: 'theme', id: 'acme.notes.t', label: 'x' }] })
    bad({
      contributions: [{ kind: 'toolbar-item', id: 'acme.notes.t', label: 'x' }],
    })
    bad({ commands: [{ ...contributes.commands[0], target: 'host' }] })
  })

  test('registers on entering the catalog, unregisters on removal and update', async () => {
    const definition = fromManifest(
      parseManifest('Modules/n/module.json', manifest({ contributes })),
      'Modules/n/module.json',
    )
    setInstalled([definition])
    expect(commandById('acme.notes.pin')?.source).toEqual({
      kind: 'module',
      moduleId: 'acme.notes',
    })
    expect(contributionById('open-handler', 'acme.notes.open')?.serves).toEqual(
      ['file:md'],
    )
    expect(contributionById('theme', 'acme.notes.theme')?.meta?.tokens).toEqual(
      {
        '--a': '#fff',
      },
    )
    // Update: a command dropped from the file leaves the registry.
    setInstalled([
      fromManifest(
        parseManifest(
          'Modules/n/module.json',
          manifest({ contributes: { commands: [] } }),
        ),
        'Modules/n/module.json',
      ),
    ])
    expect(commandById('acme.notes.pin')).toBeUndefined()
    expect(contributionById('theme', 'acme.notes.theme')).toBeUndefined()
    setInstalled([definition])
    expect(commandById('acme.notes.pin')).toBeDefined()
    setInstalled([])
    expect(commandById('acme.notes.pin')).toBeUndefined()
  })

  test('installing grants nothing', () => {
    const before = useModuleGrants.getState().grants
    setInstalled([
      fromManifest(
        parseManifest('Modules/n/module.json', manifest({ contributes })),
        'Modules/n/module.json',
      ),
    ])
    expect(useModuleGrants.getState().grants).toBe(before)
    expect(Object.keys(before).some((key) => key.endsWith('|acme.notes'))).toBe(
      false,
    )
  })

  test('the command fails clearly when the module is not placed, and dispatches when it is', async () => {
    const definition = fromManifest(
      parseManifest('Modules/n/module.json', manifest({ contributes })),
      'Modules/n/module.json',
    )
    setInstalled([definition])
    const context = { focus: 'none', path: '/' } as const
    const missing = await executeCommand(
      'acme.notes.pin',
      { note: 'a' },
      context,
      'code',
    )
    expect(missing.ok).toBe(false)
    expect(!missing.ok && missing.message).toContain('not placed')

    const invalid = await executeCommand('acme.notes.pin', {}, context, 'code')
    expect(!invalid.ok && invalid.reason).toBe('invalid-args')

    const runtime = createPageRuntime(
      (t) => (t === 'acme.notes' ? definition : undefined),
      {
        attach: () => undefined,
        ask: () => undefined,
      },
    )
    runtime.wire('n1', { type: 'acme.notes', on: {} })
    const handled: unknown[] = []
    runtime.handle('n1', 'pin', (v) => handled.push(v))
    const ok = await executeCommand(
      'acme.notes.pin',
      { note: 'a' },
      context,
      'code',
    )
    expect(ok.ok).toBe(true)
    expect(handled).toEqual([{ note: 'a' }])
    runtime.dispose()
    const gone = await executeCommand(
      'acme.notes.pin',
      { note: 'a' },
      context,
      'code',
    )
    expect(gone.ok).toBe(false)
  })
})

describe('EXT-06 causal identity', () => {
  test('a stopped source stays stopped until restarted, and the trip is listed', () => {
    const notices: string[] = []
    const runtime = createPageRuntime(
      () =>
        fromManifest(
          parseManifest(
            'm.json',
            manifest({ events: [{ name: 'go', label: 'g', type: 'text' }] }),
          ),
          'Modules/n/module.json',
        ),
      {
        attach: () => undefined,
        ask: () => undefined,
        notice: (_, m) => notices.push(m),
      },
    )
    let calls = 0
    for (const [a, b] of [
      ['a', 'b'],
      ['b', 'a'],
    ] as const) {
      runtime.wire(a, {
        type: 'acme.notes',
        on: { go: [{ to: { instance: b, action: 'pin' } }] },
      })
      runtime.handle(a, 'pin', (v) => {
        calls++
        runtime.emit(a, 'go', v)
      })
    }
    runtime.emit('a', 'go', 'x')
    const [trip] = listLoopDiagnostics()
    expect(trip?.kind).toBe('loop')
    expect(trip?.hops).toEqual(['a.go', 'b.go'])
    expect(calls).toBe(2)
    runtime.stop('a')
    const before = calls
    runtime.emit('a', 'go', 'x')
    expect(calls).toBe(before)
    runtime.restart('a')
    runtime.emit('a', 'go', 'x')
    expect(calls).toBeGreaterThan(before)
    runtime.dispose()
  })

  test('selection routes attach, never ask, unless routed to ask', () => {
    const seen: string[] = []
    const runtime = createPageRuntime(
      () =>
        fromManifest(
          parseManifest(
            'm.json',
            manifest({
              events: [{ name: 'picked', label: 'p', type: 'reference' }],
            }),
          ),
          'Modules/n/module.json',
        ),
      { attach: () => seen.push('attach'), ask: () => seen.push('ask') },
    )
    runtime.wire('s', {
      type: 'acme.notes',
      on: { picked: [{ to: { host: 'composer.attach' } }] },
    })
    runtime.emit('s', 'picked', { kind: 'document', id: 'd', label: 'D' })
    expect(seen.includes('ask')).toBe(false)
    runtime.dispose()
  })
})

describe('EXEC-01/02', () => {
  test('trust tiers: isolated, composition, builtin trusted; a file cannot claim trusted', () => {
    const html = fromManifest(
      parseManifest('m.json', manifest()),
      'Modules/n/module.json',
    )
    expect(html.trust).toBe('isolated')
    const composite = fromManifest(
      parseManifest(
        'm.json',
        manifest({
          implementation: { kind: 'composite', content: [] },
          capabilities: undefined,
        }),
      ),
      'Modules/c/module.json',
    )
    expect(composite.trust).toBe('composition')
    expect(
      builtin({ id: 'theorem.x', label: 'X', Component: () => null }).trust,
    ).toBe('trusted')
    expect(() =>
      parseManifest('m.json', manifest({ trust: 'trusted' })),
    ).toThrow(/built-in/)
    expect(() =>
      parseManifest('m.json', manifest({ trust: 'composition' })),
    ).toThrow()
  })

  test('describeModules is JSON with trust, ports, capabilities and contributions', () => {
    const html = fromManifest(
      parseManifest(
        'm.json',
        manifest({ dependencies: { 'left-pad': '1.3.0' } }),
      ),
      'Modules/n/module.json',
    )
    const described = JSON.parse(JSON.stringify(describeModules([html])))
    const [one] = described.modules
    expect(described.schema).toBe('theorem.modules/1')
    expect(one.trust).toBe('isolated')
    expect(one.sandboxed).toBe(true)
    expect(one.ports.actions[0].name).toBe('pin')
    expect(one.requestedCapabilities.read).toEqual(['files'])
    expect(one.dependencies[0].name).toBe('left-pad')
  })

  test('a grant does not transfer to a different digest', () => {
    const grants = {
      'ws|acme.notes': {
        digest: 'aaa',
        capabilities: { read: ['files'], write: [], state: [], net: [] },
        grantedAt: 1,
      },
    }
    expect(grantFor(grants, 'ws|acme.notes', 'aaa')).toBeDefined()
    expect(grantFor(grants, 'ws|acme.notes', 'bbb')).toBeUndefined()
  })
})

describe('EXT-05 dependencies', () => {
  test('go through the App resolver and record the resolved pin', () => {
    const definition = fromManifest(
      parseManifest(
        'm.json',
        manifest({ dependencies: { 'left-pad': '1.3.0', 'x y': '1' } }),
      ),
      'Modules/n/module.json',
    )
    const [pad, bad] = definition.dependencies!
    expect(pad?.resolved?.kind).toBe('url')
    expect(pad?.resolved?.path).toContain('left-pad@1.3.0')
    expect(pad?.exact).toBe(true)
    expect(bad?.error).toBeDefined()
  })
})
