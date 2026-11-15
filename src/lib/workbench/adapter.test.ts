// SOURCING: none — bun:test over ./adapter with stub owners and the environment's stub host
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createAdapter } from './adapter'
import type {
  AdapterOptions,
  OwnerPort,
  OwnerReply,
  TerminalPort,
} from './adapter'
import {
  FakeLive,
  HttpError,
  op,
  stubHost,
  testEnvironment,
} from './environment/test-host'
import { createLayout, WORKBENCH_SCHEMA } from './layout'
import type { Checkpoints } from './layout'
import type {
  Completion,
  Effect,
  EffectKind,
  HostMessage,
  Inbound,
} from './wire'

// ---- one sample payload per kind; a kind added in Rust fails to compile here -------------------

type PayloadOf<TKind extends EffectKind> =
  Extract<Effect, { kind: TKind }> extends { payload: infer P } ? P : undefined

const at = { line: 1, character: 2 }
const SAMPLES: { [TKind in EffectKind]: PayloadOf<TKind> } = {
  filesList: { path: 'src' },
  filesStat: { path: 'a.txt' },
  filesSearch: { query: 'a', limit: 50, offset: 0 },
  filesCreate: { path: 'new.txt', directory: false },
  filesRename: { from: 'a', to: 'b' },
  filesCopy: { from: 'a', to: 'b', overwrite: false },
  filesDelete: { path: 'a' },
  documentCreate: { path: 'a.md' },
  documentOpen: {},
  documentEdit: {
    operationId: 'op',
    unit: 'utf16',
    edits: [{ start: 0, end: 0, insert: 'x' }],
  },
  documentSave: undefined,
  documentClose: undefined,
  documentReconcile: { keep: 'disk' },
  documentRevert: undefined,
  documentSettle: { operationId: 'op' },
  scmStatus: undefined,
  scmDiff: { staged: false },
  scmShow: { path: 'a', reference: 'head' },
  scmStage: { paths: ['a'] },
  scmUnstage: { paths: ['a'] },
  scmDiscard: { path: 'a' },
  scmRestore: { restoreId: 'r' },
  scmCommit: { message: 'm' },
  scmAmend: { message: 'm' },
  scmBranches: undefined,
  scmDiffCommit: { commit: 'abc' },
  scmShowRevision: { path: 'a', revision: 'abc' },
  scmBranch: { name: 'b', create: true },
  scmFetch: {},
  scmPush: {},
  scmMerge: { branch: 'b' },
  scmBlame: { path: 'a' },
  scmLog: { maxCount: 10 },
  languageHover: at,
  languageComplete: at,
  languageNavigate: { kind: 'definition', position: at },
  languageReferences: at,
  languageDiagnostics: undefined,
  languageFormat: undefined,
  languageRename: { position: at, newName: 'n' },
  languageApplyPlan: { planId: 'p' },
  runConfigure: { name: 'n', argv: ['a'] },
  runStart: { name: 'n' },
  runStop: { handle: 'h' },
  runPoll: { handle: 'h' },
  searchQuery: {
    query: 'q',
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    limit: 10,
  },
  searchCancel: { id: 's' },
  terminalOpen: { backend: 'native', cols: 80, rows: 24 },
  terminalAttach: { fromOffset: 0, role: 'observer', attachment: 'a' },
  terminalInput: {
    bytes: 'ls\n',
    kind: 'human',
    inputId: 'i',
    claim: { attachment: 'a', leaseGeneration: 1, epoch: 1 },
  },
  terminalInputBytes: {
    data: 'bHMK',
    kind: 'human',
    inputId: 'ib',
    claim: { attachment: 'a', leaseGeneration: 1, epoch: 1 },
  },
  terminalAbandonOpen: { open: 0 },
  terminalResize: {
    cols: 100,
    rows: 30,
    claim: { attachment: 'a', leaseGeneration: 1, epoch: 1 },
  },
  terminalDetach: { attachment: 'a', leaseGeneration: 1, epoch: 1 },
  terminalEnd: undefined,
  conversationCreate: undefined,
  conversationSend: { clientMessageId: 'c1', text: 't', attachments: [] },
  conversationInput: { runId: 'r', clientMessageId: 'c2', text: 't' },
  conversationCancel: { runId: 'r' },
  conversationRetry: { messageId: 'm' },
  conversationEdit: { messageId: 'm', clientMessageId: 'c3', text: 't' },
  conversationSwitch: { threadId: 'th' },
  conversationApproval: { runId: 'r', approvalId: 'a', decision: 'allow' },
  conversationSideChat: undefined,
  conversationSideClose: undefined,
  layoutLoad: undefined,
  layoutSave: { current: '{"dock":1}', namedLayouts: '{"A":{"dock":2}}' },
  artifactsList: {},
  artifactRead: { key: 'k' },
  clipboardWrite: { text: 't' },
  clipboardRead: undefined,
} as never

const KINDS = Object.keys(SAMPLES) as EffectKind[]

/** A terminal is opened before anything is asked of it and detached after everything else. */
async function performAll(
  t: {
    adapter: { perform: (effect: Effect) => void }
    settle: () => Promise<unknown>
  },
  kinds: EffectKind[],
  make: (kind: EffectKind, index: number) => Effect,
) {
  const [first, ...rest] = kinds.includes('terminalOpen')
    ? [
        'terminalOpen' as EffectKind,
        ...kinds.filter(
          (kind) => kind !== 'terminalOpen' && kind !== 'terminalDetach',
        ),
      ]
    : kinds
  t.adapter.perform(make(first!, 0))
  await t.settle()
  rest.forEach((kind, index) => t.adapter.perform(make(kind, index + 1)))
  if (kinds.includes('terminalDetach')) {
    await t.settle()
    t.adapter.perform(make('terminalDetach', kinds.length))
  }
}

/** The owner that holds each kind: the one table the router must agree with. */
const OWNER_OF = (kind: EffectKind) =>
  kind.startsWith('files')
    ? 'files'
    : kind.startsWith('document')
      ? 'documents'
      : kind.startsWith('scm')
        ? 'scm'
        : kind.startsWith('language')
          ? 'language'
          : kind.startsWith('run')
            ? 'run'
            : kind.startsWith('search')
              ? 'search'
              : kind.startsWith('terminal')
                ? 'terminal'
                : kind.startsWith('conversation')
                  ? 'conversation'
                  : kind.startsWith('layout')
                    ? 'layout'
                    : kind.startsWith('artifact')
                      ? 'artifacts'
                      : 'clipboard'

const WS = { type: 'workspace', workspace: 'w1' } as const
const TERMINAL = { type: 'terminal', workspace: 'w1', session: 't1' } as const

function effectOf(
  id: number,
  kind: EffectKind,
  extra: Partial<Pick<Effect, 'resource' | 'revision' | 'generation'>> = {},
): Effect {
  const payload = SAMPLES[kind]
  return {
    id,
    resource:
      kind.startsWith('terminal') && kind !== 'terminalOpen' ? TERMINAL : WS,
    kind,
    ...(payload === undefined ? {} : { payload }),
    ...extra,
  } as Effect
}

// ---- stub owners -------------------------------------------------------------------------------

const accepted = { outcome: 'accepted' } as const
type Call = { owner: string; kind: string; requestId?: string }

class FakePort {
  listeners = new Set<(event: never) => void>()
  state = {
    profile: { id: 'Shell', backend: 'native' as const },
    terminalId: 't1' as string | undefined,
    bindingEpoch: 2 as number | undefined,
    program: 1 as number | undefined,
    cols: 80 as number | undefined,
    rows: 24 as number | undefined,
    offset: 0,
    streamEpoch: 's-1' as string | undefined,
    origin: 'launched' as string | undefined,
    processOwnedBy: 'herdr-core' as string | undefined,
    lease: { generation: 4 as number | undefined },
  }
  seen: {
    input?: unknown[]
    attach?: unknown[]
    resize?: unknown[]
    open?: unknown
  } = {}
  constructor(private readonly calls: Call[]) {}
  subscribe = (listener: (event: never) => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  emit(event: unknown) {
    for (const listener of [...this.listeners]) listener(event as never)
  }
  private answer = <T>(kind: string, value: T) => {
    this.calls.push({ owner: 'terminal', kind })
    return Promise.resolve({
      terminalId: 't1',
      bindingEpoch: 2,
      outcome: 'accepted' as const,
      value,
    })
  }
  open = (options?: unknown) => {
    this.seen.open = options
    return this.answer('terminalOpen', {
      terminalId: 't1',
      bindingEpoch: 2,
      program: 1,
    })
  }
  attach = (...args: unknown[]) => {
    this.seen.attach = args
    return this.answer('terminalAttach', {
      terminalId: 't1',
      bindingEpoch: 2,
      program: 1,
    })
  }
  input = (...args: unknown[]) => {
    this.seen.input = args
    return this.answer('terminalInput', {
      inputId: 'x',
      duplicate: false,
      discarded: false,
    })
  }
  resize = (...args: unknown[]) => {
    this.seen.resize = args
    return this.answer('terminalResize', { cols: 100, rows: 30 })
  }
  detach = () => this.answer('terminalDetach', { detached: true as const })
  kill = () =>
    this.answer('terminalEnd', { processKilled: true, sessionLive: false })
}

async function setup(
  overrides: Partial<AdapterOptions> = {},
  present: string[] = [
    'documents',
    'scm',
    'language',
    'run',
    'search',
    'conversation',
    'artifacts',
    'clipboard',
  ],
  fileOverrides: Record<string, unknown> = {},
) {
  const calls: Call[] = []
  const messages: Inbound[] = []
  const host = stubHost(
    [
      'workspace.files.list',
      'documents.open',
      'scm.status',
      'terminal.open',
    ].map((name) => op(name)),
  )
  const live = new FakeLive()
  const { environment } = testEnvironment(host, live)
  await environment.settled()

  const port = new FakePort(calls)
  const terminalHostListeners = new Set<(event: never) => void>()
  const owner = (name: string): OwnerPort<never> => ({
    perform: async (effect, requestId) => {
      calls.push({ owner: name, kind: (effect as Effect).kind, requestId })
      return accepted satisfies OwnerReply
    },
    subscribe: (listener) => {
      pushed.set(name, listener)
      return () => void pushed.delete(name)
    },
  })
  const pushed = new Map<string, (message: HostMessage) => void>()
  const watchers = new Map<string, (event: never) => void>()
  const filesCall = (kind: string) => (request: { requestId: string }) => {
    calls.push({ owner: 'files', kind, requestId: request.requestId })
    return Promise.resolve({
      workspaceId: 'w1',
      requestId: request.requestId,
      outcome: 'accepted' as const,
      value: {
        path: 'src',
        rows: [{ name: 'a.txt', path: 'src/a.txt', kind: 'file' as const }],
        from: '',
        to: '',
      },
    })
  }
  const layoutCall =
    (kind: string) =>
    (...args: unknown[]) => {
      calls.push({ owner: 'layout', kind })
      void args
      return Promise.resolve({
        workspaceId: 'w1',
        requestId: 'r',
        outcome: 'accepted' as const,
        value: { revision: 3, document: undefined },
      })
    }

  const options = {
    environment,
    files: {
      list: filesCall('filesList'),
      stat: filesCall('filesStat'),
      search: filesCall('filesSearch'),
      create: filesCall('filesCreate'),
      rename: filesCall('filesRename'),
      copy: filesCall('filesCopy'),
      delete: filesCall('filesDelete'),
      watch: (directory: string, listener: (event: never) => void) => {
        watchers.set(directory, listener)
        return () => void watchers.delete(directory)
      },
      ...fileOverrides,
    } as never,
    terminal: {
      create: () => port as unknown as TerminalPort,
      host: {
        onEvent: (listener: (event: never) => void) => {
          terminalHostListeners.add(listener)
          return () => void terminalHostListeners.delete(listener)
        },
      },
    },
    layout: { load: layoutCall('layoutLoad'), save: layoutCall('layoutSave') },
    ...Object.fromEntries(present.map((name) => [name, owner(name)])),
    dispatch: (message: Inbound) => messages.push(message),
    ...overrides,
  }
  const adapter = createAdapter(options)
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    adapter,
    calls,
    messages,
    host,
    live,
    environment,
    port,
    pushed,
    watchers,
    settle,
    announce: (event: unknown) => {
      for (const listener of [...terminalHostListeners])
        listener(event as never)
    },
    completions: () =>
      messages.flatMap((m) => {
        if (m.channel !== 'completion') return []
        const { channel, ...completion } = m
        void channel
        return [completion satisfies Completion]
      }),
    hostMessages: () =>
      messages.flatMap((m) => {
        if (m.channel !== 'host') return []
        const { channel, ...message } = m
        void channel
        return [message satisfies HostMessage]
      }),
  }
}

// ---- routing -----------------------------------------------------------------------------------

describe('routing', () => {
  test('the sample table has every kind the wire declares', () => {
    const declared = readFileSync(
      new URL('./wire/EffectKind.ts', import.meta.url),
      'utf8',
    )
      .match(/"[a-zA-Z]+"/g)!
      .map((name) => name.slice(1, -1))
    const sorted: string[] = [...KINDS].sort()
    expect(sorted).toEqual(declared.sort())
  })

  test('every kind goes to exactly one owner, once (R02, AC-02)', async () => {
    const t = await setup()
    // Abandoning an open unbinds the terminal, so it has its own tests among the terminals.
    const kinds = KINDS.filter((kind) => kind !== 'terminalAbandonOpen')
    await performAll(t, kinds, (kind, index) =>
      effectOf(
        index,
        kind,
        kind === 'layoutSave' ? { revision: { scheme: 'seq', value: 1 } } : {},
      ),
    )
    await t.settle()

    // Bytes go through the session's input.
    const recordedAs = (kind: EffectKind) =>
      kind === 'terminalInputBytes' ? 'terminalInput' : kind
    for (const kind of kinds) {
      const recorded = recordedAs(kind)
      const made = t.calls.filter((call) => call.kind === recorded)
      const owners = new Set(made.map((call) => call.owner))
      expect({ kind, owners: [...owners] }).toEqual({
        kind,
        owners: [OWNER_OF(kind)],
      })
      expect({ kind, calls: made.length }).toEqual({
        kind,
        calls: kinds.filter((other) => recordedAs(other) === recorded).length,
      })
    }
  })

  test('every effect completes exactly once, echoing its id, resource, revision and generation', async () => {
    const t = await setup()
    const revision = { scheme: 'seq', value: 9 } as const
    const ids = new Map<EffectKind, number>()
    await performAll(t, KINDS, (kind, index) => {
      ids.set(kind, 100 + index)
      return effectOf(100 + index, kind, {
        generation: 7,
        ...(kind === 'layoutSave' ? { revision } : {}),
      })
    })
    await t.settle()

    const done = t.completions()
    expect(done).toHaveLength(KINDS.length)
    for (const kind of KINDS) {
      const mine = done.filter((c) => c.effect === ids.get(kind))
      expect({ kind, count: mine.length }).toEqual({ kind, count: 1 })
      expect(mine[0]!.resource).toEqual(effectOf(0, kind).resource)
      expect(mine[0]!.generation).toBe(7)
    }
  })

  test('a unknown kind from a newer core is refused, not dropped', async () => {
    const t = await setup()
    t.adapter.perform({ id: 1, resource: WS, kind: 'somethingNew' } as never)
    await t.settle()
    expect(t.completions()[0]!.outcome).toMatchObject({
      status: 'refused',
      code: 'unrouted_effect',
    })
  })
})

describe('outcomes', () => {
  test('refused keeps its code and reason, uncertain stays uncertain, failed stays failed', async () => {
    const answers: OwnerReply[] = [
      { outcome: 'refused', code: 'conflict', reason: 'moved on' },
      { outcome: 'uncertain', reason: 'no reply' },
      { outcome: 'failed', reason: 'down' },
    ]
    const t = await setup({
      scm: { perform: async () => answers.shift()! },
    })
    for (const id of [1, 2, 3]) t.adapter.perform(effectOf(id, 'scmCommit'))
    await t.settle()
    expect(t.completions().map((c) => c.outcome)).toEqual([
      { status: 'refused', code: 'conflict', reason: 'moved on' },
      { status: 'uncertain', reason: 'no reply' },
      { status: 'failed', reason: 'down' },
    ])
  })

  test('a thrown error is failed with its reason and is not retried (R47)', async () => {
    let attempts = 0
    const t = await setup({
      scm: {
        perform: async () => {
          attempts += 1
          throw new Error('disk on fire')
        },
      },
    })
    t.adapter.perform(effectOf(1, 'scmCommit'))
    await t.settle()
    expect(attempts).toBe(1)
    expect(t.completions()).toHaveLength(1)
    expect(t.completions()[0]!.outcome).toEqual({
      status: 'failed',
      reason: 'disk on fire',
    })
  })

  test('a synchronous throw and an owner that answers nothing are failed too', async () => {
    const t = await setup({
      scm: {
        perform: () => {
          throw new Error('sync')
        },
      },
      run: { perform: async () => undefined } as never,
    })
    t.adapter.perform(effectOf(1, 'scmStatus'))
    t.adapter.perform(effectOf(2, 'runStart'))
    await t.settle()
    expect(t.completions().map((c) => c.outcome.status)).toEqual([
      'failed',
      'failed',
    ])
  })

  test('the request id is the same for the same effect and differs between effects', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(5, 'scmCommit'))
    t.adapter.perform(effectOf(5, 'scmCommit'))
    t.adapter.perform(effectOf(6, 'scmCommit'))
    await t.settle()
    const ids = t.calls.map((call) => call.requestId)
    expect(ids[0]).toBe(ids[1])
    expect(ids[0]).not.toBe(ids[2])
  })

  test('accepted data rides in the payload: a listing becomes wire entries', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'filesList'))
    await t.settle()
    expect(t.completions()[0]).toMatchObject({
      outcome: { status: 'accepted' },
      payload: {
        type: 'files',
        entries: [{ name: 'a.txt', kind: 'file' }],
        partial: false,
      },
    })
  })

  test('a listing passes the host verdicts on ignored and hidden entries, and only those', async () => {
    const t = await setup({}, undefined, {
      list: async (request: { requestId: string }) => ({
        workspaceId: 'w1',
        requestId: request.requestId,
        outcome: 'accepted' as const,
        value: {
          path: 'src',
          rows: [
            {
              name: 'a',
              path: 'src/a',
              kind: 'file' as const,
              ignored: true,
              hidden: false,
            },
            { name: 'b', path: 'src/b', kind: 'directory' as const },
          ],
        },
      }),
    })
    t.adapter.perform(effectOf(1, 'filesList'))
    await t.settle()
    expect(t.completions()[0]!.payload).toEqual({
      type: 'files',
      entries: [
        { name: 'a', kind: 'file', ignored: true, hidden: false },
        { name: 'b', kind: 'directory' },
      ],
      partial: false,
    })
  })

  test('stat answers fileStat with the milliseconds under mtimeMs, and a missing path is an answer', async () => {
    const answers = [
      { path: 'a', kind: 'file', size: 3, modified: 1700, readonly: false },
      { path: 'gone', kind: 'missing' },
    ]
    const t = await setup({}, undefined, {
      stat: async (request: { requestId: string }) => ({
        workspaceId: 'w1',
        requestId: request.requestId,
        outcome: 'accepted' as const,
        value: answers.shift()!,
      }),
    })
    t.adapter.perform(effectOf(1, 'filesStat'))
    t.adapter.perform(effectOf(2, 'filesStat'))
    await t.settle()
    expect(t.completions().map((c) => c.payload)).toEqual([
      {
        type: 'fileStat',
        kind: 'file',
        size: 3,
        mtimeMs: 1700,
        readonly: false,
      },
      { type: 'fileStat', kind: 'missing' },
    ])
  })

  test('search answers the matching paths as a partial listing, and a host that cannot search refuses naming the operation', async () => {
    const outcomes = [
      {
        outcome: 'accepted' as const,
        value: {
          rows: [{ name: 'a.ts', path: 'src/a.ts', kind: 'file' as const }],
          partial: true,
          next: 200,
        },
      },
      {
        outcome: 'refused' as const,
        code: 'missing_capability',
        reason: 'The host lists one directory; workspace.files.list is needed',
      },
    ]
    const t = await setup({}, undefined, {
      search: async (request: { requestId: string }) => ({
        workspaceId: 'w1',
        requestId: request.requestId,
        ...outcomes.shift()!,
      }),
    })
    t.adapter.perform(effectOf(1, 'filesSearch'))
    t.adapter.perform(effectOf(2, 'filesSearch'))
    await t.settle()
    const [found, refused] = t.completions()
    expect(found!.payload).toEqual({
      type: 'fileSearchPage',
      rows: [{ name: 'a.ts', path: 'src/a.ts', kind: 'file' }],
      partial: true,
      next: 200,
    })
    expect(refused!.outcome).toMatchObject({
      status: 'refused',
      code: 'missing_capability',
    })
    expect(refused!.payload).toBeUndefined()
  })

  test('search pages follow next: the offset and limit reach the owner and the next offset comes back', async () => {
    const asked: { query: string; limit?: number; offset?: number }[] = []
    const t = await setup({}, undefined, {
      search: async (request: {
        requestId: string
        query: string
        limit?: number
        offset?: number
      }) => {
        asked.push({
          query: request.query,
          limit: request.limit,
          offset: request.offset,
        })
        const first = request.offset === undefined
        return {
          workspaceId: 'w1',
          requestId: request.requestId,
          outcome: 'accepted' as const,
          value: {
            rows: [
              {
                name: first ? 'a.ts' : 'b.ts',
                path: first ? 'a.ts' : 'b.ts',
                kind: 'file' as const,
              },
            ],
            partial: true,
            ...(first ? { next: 1 } : {}),
          },
        }
      },
    })
    t.adapter.perform({
      ...effectOf(1, 'filesSearch'),
      payload: { query: 'ts', limit: 1 },
    } as never)
    await t.settle()
    const page = t.completions()[0]!.payload as { next?: number }
    expect(page.next).toBe(1)
    t.adapter.perform({
      ...effectOf(2, 'filesSearch'),
      payload: { query: 'ts', limit: 1, offset: page.next },
    } as never)
    await t.settle()
    expect(asked).toEqual([
      { query: 'ts', limit: 1, offset: undefined },
      { query: 'ts', limit: 1, offset: 1 },
    ])
    const last = t.completions()[1]!.payload as {
      rows: unknown[]
      next?: number
    }
    expect(last.rows).toHaveLength(1)
    expect(last.next).toBeUndefined()
  })

  test('copy is the files owner copy, with the overwrite flag', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'filesCopy'))
    await t.settle()
    expect(t.calls).toEqual([
      { owner: 'files', kind: 'filesCopy', requestId: expect.any(String) },
    ])
    expect(t.completions()[0]!.outcome).toEqual({ status: 'accepted' })
  })

  test('a refusal that carries owner state keeps it as the payload', async () => {
    const t = await setup({
      documents: {
        perform: async () => ({
          outcome: 'refused',
          code: 'conflict',
          reason: 'moved on',
          value: {
            type: 'documentConflicted',
            operationId: 'o',
            baseRevision: { scheme: 'seq', value: 1 },
            current: { revision: { scheme: 'seq', value: 2 }, text: 'x' },
            pending: [],
          },
        }),
      },
    })
    t.adapter.perform(effectOf(1, 'documentEdit'))
    await t.settle()
    expect(t.completions()[0]).toMatchObject({
      outcome: { status: 'refused', code: 'conflict' },
      payload: { type: 'documentConflicted', operationId: 'o' },
    })
  })
})

describe('owners that do not exist yet', () => {
  test('each completes as refused owner_unavailable, and no stub answers for it', async () => {
    const t = await setup({}, [])
    const missing = KINDS.filter((kind) =>
      [
        'documents',
        'scm',
        'language',
        'run',
        'search',
        'conversation',
        'artifacts',
        'clipboard',
      ].includes(OWNER_OF(kind)),
    )
    missing.forEach((kind, index) => t.adapter.perform(effectOf(index, kind)))
    await t.settle()
    const done = t.completions()
    expect(done).toHaveLength(missing.length)
    for (const completion of done) {
      expect(completion.outcome).toMatchObject({
        status: 'refused',
        code: 'owner_unavailable',
      })
    }
    expect(t.calls).toHaveLength(0)
  })
})

describe('inbound channels', () => {
  test('a completion is tagged completion and a host message is tagged host', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'scmStatus'))
    await t.settle()
    t.pushed.get('documents')!({ type: 'documentRetired', resource: WS })
    expect(t.messages.filter((m) => m.channel === 'completion')).toHaveLength(1)
    expect(t.messages.at(-1)).toEqual({
      channel: 'host',
      type: 'documentRetired',
      resource: WS,
    })
  })
})

describe('layout', () => {
  test('a load carries the record and its documents as layoutLoaded, and a first load carries none', async () => {
    const t = await setup({
      layout: {
        load: async () => ({
          workspaceId: 'w1',
          requestId: 'r',
          outcome: 'accepted' as const,
          value: {
            revision: 3,
            document: {
              current: { dock: 1 },
              namedLayouts: { A: { dock: 2 } },
            },
          },
        }),
        save: async () => {
          throw new Error('unused')
        },
      },
    })
    t.adapter.perform(effectOf(1, 'layoutLoad'))
    await t.settle()
    expect(t.completions()[0]!.payload).toEqual({
      type: 'layoutLoaded',
      revision: { scheme: 'seq', value: 3 },
      document: { current: '{"dock":1}', namedLayouts: '{"A":{"dock":2}}' },
    })
    const first = await setup()
    first.adapter.perform(effectOf(1, 'layoutLoad'))
    await first.settle()
    expect(first.completions()[0]!.payload).toEqual({
      type: 'layoutLoaded',
      revision: { scheme: 'seq', value: 3 },
    })
  })

  test('a load reports the record revision on the completion', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'layoutLoad'))
    await t.settle()
    expect(t.completions()[0]!.revision).toEqual({ scheme: 'seq', value: 3 })
  })

  test('a save needs a sequence revision and JSON documents, and is refused without sending otherwise', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'layoutSave'))
    t.adapter.perform(
      effectOf(2, 'layoutSave', { revision: { scheme: 'opaque', value: 'x' } }),
    )
    t.adapter.perform({
      ...effectOf(3, 'layoutSave', { revision: { scheme: 'seq', value: 1 } }),
      payload: { current: '{', namedLayouts: '{}' },
    } as Effect)
    t.adapter.perform({
      ...effectOf(4, 'layoutSave', { revision: { scheme: 'seq', value: 1 } }),
      payload: { current: '{}', namedLayouts: '[]' },
    } as Effect)
    await t.settle()
    expect(t.completions().map((c) => c.outcome)).toEqual([
      expect.objectContaining({ code: 'revision_required' }),
      expect.objectContaining({ code: 'revision_required' }),
      expect.objectContaining({ code: 'invalid_layout' }),
      expect.objectContaining({ code: 'invalid_layout' }),
    ])
    expect(t.calls.filter((c) => c.owner === 'layout')).toHaveLength(0)
  })

  test('a stale save through the real layout owner is refused as a conflict, and a good one moves the revision', async () => {
    let held = 5
    const host = stubHost([])
    ;(host.client as unknown as { workbench: unknown }).workbench = {
      get: async () => {
        throw new HttpError(404, { code: 'workbench_not_found' })
      },
      save: async (request: Record<string, unknown>) => {
        if (Number(request['If-Match']) !== held)
          throw new HttpError(409, { code: 'stale_workbench_revision' })
        held += 1
        return {
          workspaceId: 'w1',
          revision: held,
          schema: WORKBENCH_SCHEMA,
          current: {},
          namedLayouts: {},
        }
      },
    }
    const { environment } = testEnvironment(host)
    await environment.settled()
    const layout = createLayout({
      environment: environment as never,
      checkpoints: {} as Checkpoints,
    })
    const t = await setup({ layout })
    t.adapter.perform(
      effectOf(1, 'layoutSave', { revision: { scheme: 'seq', value: 4 } }),
    )
    t.adapter.perform(
      effectOf(2, 'layoutSave', { revision: { scheme: 'seq', value: 5 } }),
    )
    await t.settle()
    const [stale, good] = t.completions()
    expect(stale!.outcome).toMatchObject({
      status: 'refused',
      code: 'conflict',
    })
    expect(stale!.revision).toEqual({ scheme: 'seq', value: 4 })
    expect(good!.outcome).toEqual({ status: 'accepted' })
    expect(good!.revision).toEqual({ scheme: 'seq', value: 6 })
    expect(good!.payload).toEqual({
      type: 'layoutSaved',
      revision: { scheme: 'seq', value: 6 },
    })
  })
})

describe('terminals', () => {
  test('open answers with the binding and records the session for later effects', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'terminalOpen'))
    await t.settle()
    expect(t.completions()[0]).toMatchObject({
      outcome: { status: 'accepted' },
      payload: {
        type: 'terminal',
        session: 't1',
        cols: 80,
        rows: 24,
        backend: 'native',
        epoch: 2,
        program: 1,
        streamEpoch: 's-1',
        origin: 'launched',
        leaseGeneration: 4,
        processOwnedBy: 'herdr-core',
      },
    })
    t.adapter.perform(effectOf(2, 'terminalResize'))
    await t.settle()
    expect(t.completions()[1]!.outcome).toEqual({ status: 'accepted' })
    // The claim the pane drew the resize against goes to the session as it is.
    expect(t.port.seen.resize).toEqual([
      100,
      30,
      { claim: { attachment: 'a', leaseGeneration: 1, epoch: 1 } },
    ])
  })

  test('an open with an attachment hands it to the session and the answer carries it with who holds the lease', async () => {
    const t = await setup()
    Object.assign(t.port.state, {
      lease: {
        generation: 4,
        role: 'controller',
        held: true,
        attachment: 'pane-1',
      },
    })
    t.adapter.perform({
      ...effectOf(1, 'terminalOpen'),
      payload: { backend: 'native', cols: 80, rows: 24, attachment: 'pane-1' },
    } as never)
    await t.settle()
    expect(t.port.seen.open).toMatchObject({ attachment: 'pane-1' })
    expect(t.completions()[0]!.payload).toMatchObject({
      attachment: 'pane-1',
      controlling: true,
      controlled: true,
    })
  })

  test('abandoning an open ends the program it started and forgets the binding; an open that was refused has nothing to undo; an unknown open is refused', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(7, 'terminalOpen'))
    await t.settle()
    t.adapter.perform({
      ...effectOf(8, 'terminalAbandonOpen'),
      resource: TERMINAL,
      payload: { open: 7 },
    } as never)
    await t.settle()
    expect(t.completions()[1]!.outcome).toEqual({ status: 'accepted' })
    expect(t.calls.filter((call) => call.kind === 'terminalEnd')).toHaveLength(
      1,
    )
    t.adapter.perform(effectOf(9, 'terminalResize'))
    await t.settle()
    expect(t.completions()[2]!.outcome).toMatchObject({
      status: 'refused',
      code: 'terminal_session_not_found',
    })
    t.adapter.perform({
      ...effectOf(10, 'terminalAbandonOpen'),
      payload: { open: 99 },
    } as never)
    await t.settle()
    expect(t.completions()[3]!.outcome).toMatchObject({
      status: 'refused',
      code: 'unknown_open',
    })
  })

  test('input bytes that are UTF-8 go through the session input with the panel id and claim; other bytes are refused', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'terminalOpen'))
    await t.settle()
    t.adapter.perform(effectOf(2, 'terminalInputBytes'))
    t.adapter.perform({
      ...effectOf(3, 'terminalInputBytes'),
      payload: {
        data: btoa(String.fromCharCode(0xff, 0xfe)),
        kind: 'human',
        inputId: 'bad',
        claim: { attachment: 'a', leaseGeneration: 1, epoch: 1 },
      },
    } as never)
    await t.settle()
    expect(t.port.seen.input).toEqual([
      'ls\n',
      'human',
      {
        inputId: 'ib',
        claim: { attachment: 'a', leaseGeneration: 1, epoch: 1 },
      },
    ])
    expect(t.completions()[1]!.outcome).toEqual({ status: 'accepted' })
    expect(t.completions()[2]!.outcome).toMatchObject({
      status: 'refused',
      code: 'unsupported_binary_input',
    })
  })

  test('what the session did not report is left out of the binding, never filled in', async () => {
    const t = await setup()
    Object.assign(t.port.state, {
      streamEpoch: undefined,
      origin: undefined,
      processOwnedBy: undefined,
      lease: { generation: undefined },
    })
    t.adapter.perform(effectOf(1, 'terminalOpen'))
    await t.settle()
    expect(t.completions()[0]!.payload).toEqual({
      type: 'terminal',
      session: 't1',
      cols: 80,
      rows: 24,
      backend: 'native',
      epoch: 2,
      program: 1,
    })
  })

  test("input and attach hand the panel's input id, claim and attachment to the session as they are (AC-24)", async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'terminalOpen'))
    await t.settle()
    t.adapter.perform(effectOf(2, 'terminalInput'))
    t.adapter.perform(effectOf(3, 'terminalAttach'))
    await t.settle()
    expect(t.port.seen.input).toEqual([
      'ls\n',
      'human',
      {
        inputId: 'i',
        claim: { attachment: 'a', leaseGeneration: 1, epoch: 1 },
      },
    ])
    expect(t.port.seen.attach).toEqual([
      { terminalId: 't1', fromOffset: 0, role: 'observer', attachment: 'a' },
    ])
  })

  test('a reset replays the screen as terminalReset at the offset after it, and a resize is terminalResized', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'terminalOpen'))
    await t.settle()
    t.port.state.offset = 42
    t.port.emit({ type: 'reset', formatted: 'screen', epoch: 3 })
    t.port.emit({ type: 'resized', cols: 100, rows: 30 })
    const heard = t
      .hostMessages()
      .filter((m) => m.type === 'terminalReset' || m.type === 'terminalResized')
    expect(heard).toEqual([
      {
        type: 'terminalReset',
        resource: TERMINAL,
        epoch: 3,
        offset: 42,
        data: btoa('screen'),
      },
      {
        type: 'terminalResized',
        resource: TERMINAL,
        epoch: 2,
        cols: 100,
        rows: 30,
      },
    ])
    expect(t.hostMessages().some((m) => m.type === 'resync')).toBe(false)
  })

  test('an effect for a terminal this workbench never bound is refused, with no call', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'terminalInput'))
    await t.settle()
    expect(t.completions()[0]!.outcome).toMatchObject({
      status: 'refused',
      code: 'terminal_session_not_found',
    })
    expect(t.calls).toHaveLength(0)
  })

  test('session events become host messages; the opener is not told twice', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'terminalOpen'))
    await t.settle()
    t.port.emit({
      type: 'opened',
      terminalId: 't1',
      origin: 'launched',
      bindingEpoch: 2,
      program: 1,
    })
    t.port.emit({
      type: 'output',
      offset: 5,
      bytes: new TextEncoder().encode('hi'),
      epoch: 2,
    })
    t.port.emit({ type: 'lease', lease: { generation: 4, held: true } })
    t.port.emit({ type: 'exited', reason: 'exited', code: 0, signal: null })
    expect(
      t
        .hostMessages()
        .filter(
          (m) =>
            m.type !== 'connectionChanged' && m.type !== 'capabilitiesChanged',
        ),
    ).toEqual([
      {
        type: 'terminalOutput',
        resource: TERMINAL,
        epoch: 2,
        offset: 5,
        data: btoa('hi'),
      },
      {
        type: 'terminalControl',
        resource: TERMINAL,
        epoch: 2,
        generation: 4,
        controlled: true,
      },
      {
        type: 'terminalExited',
        resource: TERMINAL,
        epoch: 2,
        exitCode: 0,
        reason: 'exited',
      },
    ])
  })

  test('a terminal the host announces becomes terminalOpened once', async () => {
    const t = await setup()
    const event = {
      kind: 'terminal.opened',
      data: {
        session: 't9',
        epoch: 1,
        program: 1,
        backend: 'herdr',
        origin: 'adopted',
        cols: 100,
        rows: 40,
      },
    }
    t.announce(event)
    t.announce(event)
    t.announce({ kind: 'terminal.output', data: { session: 't9' } })
    const opened = t.hostMessages().filter((m) => m.type === 'terminalOpened')
    expect(opened).toEqual([
      {
        type: 'terminalOpened',
        resource: { type: 'terminal', workspace: 'w1', session: 't9' },
        epoch: 1,
        program: 1,
        backend: 'herdr',
        origin: 'adopted',
        cols: 100,
        rows: 40,
      },
    ])
  })
})

describe('host events', () => {
  test('files changes under a listed directory become fileChanged, and lost events become path "."', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'filesList'))
    await t.settle()
    const listener = t.watchers.get('src')!
    listener({ kind: 'changed', workspaceId: 'w1', path: 'src/a.txt' } as never)
    listener({
      kind: 'resync',
      workspaceId: 'w1',
      reason: 'events_lost',
    } as never)
    listener({
      kind: 'resync',
      workspaceId: 'w1',
      reason: 'reconnected',
    } as never)
    expect(t.hostMessages().filter((m) => m.type === 'fileChanged')).toEqual([
      { type: 'fileChanged', workspace: 'w1', path: 'src/a.txt' },
      { type: 'fileChanged', workspace: 'w1', path: '.' },
    ])
  })

  test('the connection state, a reconnect and capabilities are reported', async () => {
    const t = await setup()
    await t.settle()
    t.live.state('open')
    t.live.state('reconnecting')
    t.live.state('open')
    t.live.resync('cursor_expired')
    t.live.state('resyncing')
    t.live.state('open')
    const types = t.hostMessages().map((m) => m.type)
    expect(types).toContain('connectionChanged')
    expect(types).toContain('resync')
    expect(
      t.hostMessages().find((m) => m.type === 'capabilitiesChanged'),
    ).toMatchObject({
      capabilities: {
        granted: expect.arrayContaining([
          'environment',
          'files',
          'terminal',
          'documents',
        ]),
      },
    })
  })

  test('capabilities are what the host advertises, whichever owners were passed in', async () => {
    const t = await setup({}, [])
    await t.settle()
    const first = t.hostMessages().find((m) => m.type === 'capabilitiesChanged')
    expect(first).toEqual({
      type: 'capabilitiesChanged',
      capabilities: {
        granted: [
          'environment',
          'files',
          'documents',
          'scm',
          'terminal',
          'layout',
        ],
      },
    })
  })

  test('the owners that are not host operations are granted from the owners the workbench has', async () => {
    const t = await setup()
    await t.settle()
    const granted = t
      .hostMessages()
      .flatMap((m) =>
        m.type === 'capabilitiesChanged' ? m.capabilities.granted : [],
      )
    expect(granted).toEqual(
      expect.arrayContaining([
        'layout',
        'conversation',
        'artifacts',
        'clipboard',
      ]),
    )
    // Search, run and language are the host's to advertise, and this host lists none of them.
    expect(granted).not.toContain('search')
  })

  test('a pushed message from an owner is forwarded', async () => {
    const t = await setup()
    t.pushed.get('documents')!({
      type: 'documentSaved',
      resource: WS,
      revision: { scheme: 'seq', value: 2 },
    })
    expect(t.hostMessages().at(-1)).toMatchObject({ type: 'documentSaved' })
  })
})

describe('dispose', () => {
  test('stops every subscription and drops late results', async () => {
    let release!: (reply: OwnerReply) => void
    const t = await setup({
      scm: {
        perform: () =>
          new Promise<OwnerReply>((resolve) => (release = resolve)),
      },
    })
    t.adapter.perform(effectOf(1, 'scmStatus'))
    t.adapter.perform(effectOf(2, 'filesList'))
    await t.settle()
    const before = t.messages.length
    t.adapter.dispose()

    release({ outcome: 'accepted' })
    t.adapter.perform(effectOf(3, 'scmStatus'))
    t.watchers.get('src')?.({
      kind: 'changed',
      workspaceId: 'w1',
      path: 'src/b',
    } as never)
    t.pushed.get('documents')?.({ type: 'documentRetired', resource: WS })
    t.port.emit({
      type: 'output',
      offset: 1,
      bytes: new Uint8Array(1),
      epoch: 1,
    })
    t.live.state('closed')
    await t.settle()

    expect(t.messages).toHaveLength(before)
    expect(t.watchers.size).toBe(0)
    expect(t.pushed.size).toBe(0)
    expect(t.live.listenerCount('file.changed')).toBe(0)
    expect(t.live.closed).toBeGreaterThan(0)
    // Dispose twice is harmless.
    t.adapter.dispose()
  })
})
