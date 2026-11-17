// SOURCING: none — bun:test over ./adapter with stub owners and the environment's stub host
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { AccountChange } from './account'
import { createAdapter } from './adapter'
import { createSessionWatch } from './agent/sessions'
import type { SessionNotice } from './agent/sessions'
import type {
  AdapterOptions,
  OwnerPort,
  OwnerReply,
  TerminalPort,
} from './adapter'
import type { TerminalListReply } from '@theoremharness/sdk'
import type { TerminalHost } from './terminal'
import type { Connectivity } from './terminal/wire'
import { rig as terminalRig } from './terminal/test-rig'
import {
  ADOPTION_UNAVAILABLE_EVENT,
  ATTACH_LOST_FRAGMENT,
  ATTACH_RUNNING_FRAGMENT,
  EXITED_EXITED,
  EXITED_GONE,
  EXITED_SCOPE_REMOVED,
  LOST_LIST_ROW,
  UPDATED_CORE_CLOSED,
  UPDATED_CORE_UNAVAILABLE,
  UPDATED_RUNNING,
} from './terminal/fixtures/core-loss'
import {
  FakeLive,
  HttpError,
  op,
  stubHost,
  testEnvironment,
} from './environment/test-host'
import { createCheckpoints, createLayout, WORKBENCH_SCHEMA } from './layout'
import { memoryDatabase } from './layout/test-storage'
import type {
  Completion,
  Effect,
  EffectKind,
  HostMessage,
  Inbound,
  ProgramReport,
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
  documentKeep: {
    edits: [
      {
        operationId: 'op',
        baseRevision: { scheme: 'seq', value: 1 },
        edits: [{ start: 0, end: 0, insert: 'x' }],
      },
    ],
  },
  documentHistoryList: undefined,
  documentHistoryPreview: { point: 'p1' },
  documentHistoryRestore: { point: 'p1' },
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
  scmConflict: { path: 'a' },
  scmResolve: { path: 'a', take: 'ours' },
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
  runList: undefined,
  searchQuery: {
    query: 'q',
    regex: false,
    caseSensitive: false,
    wholeWord: false,
    limit: 10,
  },
  searchCancel: { id: 's' },
  terminalOpen: { backend: 'native', cols: 80, rows: 24 },
  terminalAttach: { fromOffset: 0, attachment: 'a' },
  terminalInput: {
    bytes: 'ls\n',
    kind: 'human',
    inputId: 'i',
    claim: { attachment: 'a', epoch: 1 },
  },
  terminalInputBytes: {
    data: 'bHMK',
    kind: 'human',
    inputId: 'ib',
    claim: { attachment: 'a', epoch: 1 },
  },
  terminalAbandonOpen: { open: 0 },
  terminalAdmit: { session: 'hc-9' },
  terminalResize: {
    cols: 100,
    rows: 30,
    claim: { attachment: 'a', epoch: 1 },
  },
  terminalDetach: { attachment: 'a', epoch: 1 },
  terminalEnd: undefined,
  threadsList: undefined,
  threadsCreate: { projectId: 'p1' },
  threadsRename: { threadId: 'th', title: 'T' },
  threadsArchive: { threadId: 'th', archived: true },
  threadsDelete: { threadId: 'th' },
  threadsPin: { threadId: 'th', pinned: true },
  threadsTag: { threadId: 'th' },
  threadsUnread: { threadId: 'th', unread: true },
  threadsRetitle: { threadId: 'th' },
  threadsMarkdown: { threadId: 'th' },
  conversationCreate: undefined,
  conversationSend: { clientMessageId: 'c1', text: 't', attachments: [] },
  conversationInput: { runId: 'r1', clientMessageId: 'c1', text: 'x' },
  conversationDismissInput: { clientMessageId: 'c1' },
  conversationCancel: { runId: 'r' },
  conversationRetry: { messageId: 'm' },
  conversationEdit: { messageId: 'm', clientMessageId: 'c3', text: 't' },
  conversationSwitch: { threadId: 'th' },
  conversationApproval: { runId: 'r', approvalId: 'a', decision: 'allow' },
  conversationSideChat: {},
  conversationSideList: undefined,
  conversationSwitchBranch: { threadId: 't', branchId: 'b' },
  conversationAttachPick: undefined,
  conversationAttachRemove: { id: 'a' },
  conversationModels: undefined,
  conversationSetModel: { ref: 'p/m' },
  conversationSetEffort: { level: 'low' },
  conversationSideClose: undefined,
  layoutLoad: undefined,
  layoutSave: { current: '{"dock":1}', namedLayouts: '{"A":{"dock":2}}' },
  artifactsList: {},
  artifactRead: { key: 'k' },
  delegationChanges: { runId: 'r1', delegationId: 'd1' },
  delegationContent: {
    runId: 'r1',
    delegationId: 'd1',
    path: 'a.ts',
    side: 'after',
  },
  clipboardWrite: { text: 't' },
  clipboardRead: undefined,
  appearanceApply: { appearance: '{"preset":"calm","overrides":{}}' },
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
                      : kind.startsWith('appearance')
                        ? 'appearance'
                        : kind.startsWith('delegation')
                          ? 'delegations'
                          : kind.startsWith('threads')
                            ? 'threads'
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
    attachment: undefined as string | undefined,
    programReport: { kind: 'unavailable' } as ProgramReport,
    connectivity: { state: 'running' } as Connectivity,
  }
  seen: {
    input?: unknown[]
    inputBytes?: unknown[]
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
  inputBytes = (...args: unknown[]) => {
    this.seen.inputBytes = args
    return this.answer('terminalInputBytes', {
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
    'delegations',
    'clipboard',
    'appearance',
    'threads',
  ],
  fileOverrides: Record<string, unknown> = {},
  terminalList: Partial<Pick<TerminalHost, 'canList' | 'list'>> & {
    herdr?: boolean | Record<string, unknown>
  } = {},
) {
  const calls: Call[] = []
  const messages: Inbound[] = []
  const { herdr, ...hostList } = terminalList
  const host = stubHost(
    [
      'workspace.files.list',
      'documents.open',
      'scm.status',
      'terminal.open',
    ].map((name) => op(name)),
    herdr
      ? {
          backends: {
            herdr:
              typeof herdr === 'object'
                ? (herdr as { ready: boolean })
                : { ready: true, generation: 1, version: '0.1.17' },
          },
        }
      : {},
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
        value: {
          revision: 3,
          document: undefined,
          source: 'account' as const,
        },
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
        ...hostList,
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
    options,
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
    // An admission needs the terminal host's own call, so it has its own tests among the terminals.
    const kinds = KINDS.filter(
      (kind) => kind !== 'terminalAbandonOpen' && kind !== 'terminalAdmit',
    )
    await performAll(t, kinds, (kind, index) =>
      effectOf(
        index,
        kind,
        kind === 'layoutSave' ? { revision: { scheme: 'seq', value: 1 } } : {},
      ),
    )
    await t.settle()

    for (const kind of kinds) {
      const made = t.calls.filter((call) => call.kind === kind)
      const owners = new Set(made.map((call) => call.owner))
      expect({ kind, owners: [...owners] }).toEqual({
        kind,
        owners: [OWNER_OF(kind)],
      })
      expect({ kind, calls: made.length }).toEqual({
        kind,
        calls: 1,
      })
    }
  })

  test('a document keep goes to the documents owner with its kept edits, and only there', async () => {
    const t = await setup()
    await performAll(t, ['documentKeep'], (kind, index) =>
      effectOf(index, kind, {}),
    )
    await t.settle()
    const made = t.calls.filter((call) => call.kind === 'documentKeep')
    expect(made.map((call) => call.owner)).toEqual(['documents'])
    expect(t.calls.filter((call) => call.owner === 'documents')).toHaveLength(1)
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
        'delegations',
        'clipboard',
        'appearance',
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
            source: 'account' as const,
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
      source: 'account',
      revision: { scheme: 'seq', value: 3 },
      document: { current: '{"dock":1}', namedLayouts: '{"A":{"dock":2}}' },
    })
    const first = await setup()
    first.adapter.perform(effectOf(1, 'layoutLoad'))
    await first.settle()
    expect(first.completions()[0]!.payload).toEqual({
      type: 'layoutLoaded',
      source: 'account',
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
      checkpoints: createCheckpoints({
        directory: 'd',
        open: async () => memoryDatabase(),
      }),
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
      { claim: { attachment: 'a', epoch: 1 } },
    ])
  })

  test('an open with an attachment hands it to the session and the answer carries it', async () => {
    const t = await setup()
    Object.assign(t.port.state, { attachment: 'pane-1' })
    t.adapter.perform({
      ...effectOf(1, 'terminalOpen'),
      payload: { backend: 'native', cols: 80, rows: 24, attachment: 'pane-1' },
    } as never)
    await t.settle()
    expect(t.port.seen.open).toMatchObject({ attachment: 'pane-1' })
    const payload = t.completions()[0]!.payload
    expect(payload).toMatchObject({ attachment: 'pane-1' })
    expect(payload).not.toHaveProperty('controlling')
    expect(payload).not.toHaveProperty('leaseGeneration')
  })

  test('an attach answer carries the attachment and epoch the host returned, not the ones the pane asked with', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'terminalOpen'))
    await t.settle()
    const attach = t.port.attach
    t.port.attach = (...args: unknown[]) => {
      const done = attach(...args)
      Object.assign(t.port.state, {
        bindingEpoch: 3,
        attachment: 'ta-minted-by-host',
      })
      return done
    }
    t.adapter.perform({
      ...effectOf(2, 'terminalAttach'),
      payload: { fromOffset: 0, attachment: 'pane-asked' },
    } as never)
    await t.settle()
    expect(t.port.seen.attach).toEqual([
      expect.objectContaining({ attachment: 'pane-asked' }),
    ])
    const answer = t.completions().at(-1)!.payload
    expect(answer).toMatchObject({
      attachment: 'ta-minted-by-host',
      epoch: 3,
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

  test('input bytes go to the session as base64 with the panel id and claim, whatever the bytes are', async () => {
    const t = await setup()
    t.adapter.perform(effectOf(1, 'terminalOpen'))
    await t.settle()
    const raw = btoa(String.fromCharCode(0x1b, 0x5b, 0x4d, 0x20, 0xe0, 0xf0))
    t.adapter.perform({
      ...effectOf(2, 'terminalInputBytes'),
      payload: {
        data: raw,
        kind: 'human',
        inputId: 'ib',
        claim: { attachment: 'a', epoch: 1 },
      },
    } as never)
    await t.settle()
    expect(t.port.seen.inputBytes).toEqual([
      raw,
      'human',
      {
        inputId: 'ib',
        claim: { attachment: 'a', epoch: 1 },
      },
    ])
    expect(t.port.seen.input).toBeUndefined()
    expect(t.completions()[1]!.outcome).toEqual({ status: 'accepted' })
  })

  test('what the session did not report is left out of the binding, never filled in', async () => {
    const t = await setup()
    Object.assign(t.port.state, {
      streamEpoch: undefined,
      origin: undefined,
      processOwnedBy: undefined,
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
        claim: { attachment: 'a', epoch: 1 },
      },
    ])
    expect(t.port.seen.attach).toEqual([
      { terminalId: 't1', fromOffset: 0, attachment: 'a' },
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
    t.port.emit({ type: 'exited', reason: 'exited', code: 0, signal: null })
    expect(
      t
        .hostMessages()
        .filter(
          (m) =>
            m.type !== 'connectionChanged' &&
            m.type !== 'capabilitiesChanged' &&
            m.type !== 'terminalSessions',
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
        type: 'terminalExited',
        resource: TERMINAL,
        epoch: 2,
        exitCode: 0,
        reason: 'exited',
      },
    ])
  })

  describe('a program’s own status report', () => {
    const CASES: ProgramReport[] = [
      { kind: 'unavailable' },
      { kind: 'never_reported' },
      { kind: 'cleared', statusMs: 7, seq: 3 },
      {
        kind: 'current',
        status: {
          state: 'unknown',
          rawState: 'compiling',
          kind: 'build',
          msg: 'shell.end approval.allow \u001b[2J',
          app: 'cc',
          title: 'workbench.act {"a":1}',
          progress: 40,
        },
        statusMs: 9,
        seq: 4,
      },
    ]
    const bound = async () => {
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
      return t
    }
    const reports = (t: Awaited<ReturnType<typeof setup>>) =>
      t.hostMessages().flatMap((m) => (m.type === 'terminalReport' ? [m] : []))

    test('each of the four cases reaches the core unchanged, with the binding epoch of the event', async () => {
      const t = await bound()
      for (const report of CASES)
        t.port.emit({
          type: 'report',
          terminalId: 't1',
          bindingEpoch: 2,
          report,
        })
      expect(reports(t)).toEqual(
        CASES.map((report) => ({
          type: 'terminalReport',
          resource: TERMINAL,
          epoch: 2,
          report,
        })),
      )
      // Passed by reference to what the owner parsed, not re-shaped.
      expect(reports(t).map((m) => m.report)).toEqual(CASES)
    })

    test('a report for an older epoch, or for none, is not sent', async () => {
      const t = await bound()
      t.port.emit({
        type: 'report',
        terminalId: 't1',
        bindingEpoch: 1,
        report: CASES[1],
      })
      t.port.emit({
        type: 'report',
        terminalId: 't1',
        bindingEpoch: undefined,
        report: CASES[1],
      })
      expect(reports(t)).toEqual([])
    })

    test('a report changes nothing else the adapter says: no profile, list or state message', async () => {
      const t = await bound()
      await t.settle()
      const before = t.hostMessages().length
      const lists = t
        .hostMessages()
        .filter((m) => m.type === 'terminalSessions').length
      for (const report of CASES) {
        // The owner holds the report before it says so.
        t.port.state.programReport = report
        t.port.emit({
          type: 'report',
          terminalId: 't1',
          bindingEpoch: 2,
          report,
        })
      }
      const after = t.hostMessages().slice(before)
      expect(after.map((m) => m.type)).toEqual(
        CASES.map(() => 'terminalReport'),
      )
      expect(
        t.hostMessages().filter((m) => m.type === 'terminalSessions').length,
      ).toBe(lists)
    })

    test('a listed row’s report is carried on the session entry, and an unavailable one is left out', async () => {
      const listRow = (session: string, programReport?: ProgramReport) => ({
        session,
        backend: 'native' as const,
        epoch: 1,
        origin: 'adopted' as const,
        binding: {
          backend: 'native' as const,
          epoch: 1,
          program: 2,
          core_id: null,
          terminal: null,
        },
        cols: 80,
        rows: 24,
        state: 'running' as const,
        controlled: false,
        modes: {
          alternate_screen: false,
          application_cursor: false,
          application_keypad: false,
          bracketed_paste: false,
          hide_cursor: false,
          mouse_protocol: 'none' as const,
          mouse_encoding: 'default' as const,
        },
        ...(programReport ? { programReport } : {}),
      })
      const t = await setup(
        {},
        undefined,
        {},
        {
          canList: async () => true,
          list: async () => ({
            sessions: [
              listRow('a', CASES[3]),
              listRow('b', CASES[1]),
              listRow('c', CASES[2]),
              listRow('d', CASES[0]),
              listRow('e'),
            ],
            adoption: { state: 'settled' as const },
          }),
        },
      )
      await t.settle()
      const last = t
        .hostMessages()
        .flatMap((m) => (m.type === 'terminalSessions' ? [m] : []))
        .at(-1)!
      const by = Object.fromEntries(
        last.sessions.map((s) => [s.session, s.programReport]),
      )
      expect(by).toEqual({
        a: CASES[3],
        b: CASES[1],
        c: CASES[2],
        d: undefined,
        e: undefined,
      })
    })
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
          'workspace.files.list',
          'documents.open',
          'scm.status',
          'terminal.open',
          'terminal.native',
          'layout',
        ],
      },
    })
  })

  test('a threads owner grants what the account can do, and never pin, tags, unread, retitle or admission', async () => {
    const t = await setup({}, ['threads'])
    await t.settle()
    const granted = (
      t.hostMessages().find((m) => m.type === 'capabilitiesChanged') as {
        capabilities: { granted: string[] }
      }
    ).capabilities.granted
    expect(granted).toEqual(
      expect.arrayContaining([
        'threads',
        'threads.create',
        'threads.rename',
        'threads.archive',
        'threads.delete',
        'threads.markdown',
      ]),
    )
    for (const withheld of [
      'threads.pin',
      'threads.tags',
      'threads.unread',
      'threads.retitle',
      'terminal.admit',
    ])
      expect(granted).not.toContain(withheld)

    const none = await setup({}, [])
    await none.settle()
    expect(
      (
        none.hostMessages().find((m) => m.type === 'capabilitiesChanged') as {
          capabilities: { granted: string[] }
        }
      ).capabilities.granted,
    ).not.toContain('threads')
  })

  test('the threads owner’s listing reaches the core as the host message it pushed', async () => {
    const t = await setup()
    await t.settle()
    const listing = { projects: [], threads: [], asOfMs: 1 }
    t.pushed.get('threads')!({ type: 'threadsChanged', listing } as never)
    expect(t.hostMessages().at(-1)).toEqual({ type: 'threadsChanged', listing })
  })

  test('the terminal session list is sent when the environment is ready, when a shell opens, and on each change', async () => {
    const t = await setup()
    await t.settle()
    const lists = () =>
      t
        .hostMessages()
        .flatMap((m) => (m.type === 'terminalSessions' ? [m] : []))
    expect(lists()).toHaveLength(1)
    expect(lists()[0]).toMatchObject({
      workspace: 'w1',
      sessions: [],
      profiles: [
        { id: 'Shell', backend: 'native', available: true },
        {
          id: 'Herdr shell',
          backend: 'herdr',
          available: false,
          unavailableReason: expect.any(String),
        },
        { id: 'Claude Code (Herdr)', argv: ['claude'], available: false },
        { id: 'Codex (Herdr)', argv: ['codex'], available: false },
      ],
    })

    t.adapter.perform(effectOf(1, 'terminalOpen'))
    await t.settle()
    expect(lists()).toHaveLength(2)
    expect(lists()[1]!.sessions).toEqual([
      {
        session: 't1',
        profile: 'Shell',
        backend: 'native',
        workspace: 'w1',
        host: 'herdr-core',
        program: 1,
        state: 'running',
      },
    ])

    // A program the host announces joins the list; the same announcement twice does not repeat it.
    const announced = {
      kind: 'terminal.opened',
      data: { session: 't9', epoch: 1, program: 1, backend: 'herdr' },
    }
    t.announce(announced)
    t.announce(announced)
    expect(lists()).toHaveLength(3)
    expect(lists()[2]!.sessions.map((row) => row.session)).toEqual(['t1', 't9'])

    t.port.emit({ type: 'exited', reason: 'exited', code: 0, signal: null })
    expect(lists().at(-1)!.sessions[0]).not.toHaveProperty(
      'controlledElsewhere',
    )
  })

  describe('the host lists its terminals', () => {
    const row = (
      session: string,
      backend: 'native' | 'herdr',
      controlled = false,
    ) => ({
      session,
      backend,
      epoch: 1,
      origin: 'adopted' as const,
      binding: {
        backend,
        epoch: 1,
        program: 2,
        core_id: null,
        terminal: null,
      },
      cols: 80,
      rows: 24,
      state: 'running' as const,
      controlled,
      modes: {
        alternate_screen: false,
        application_cursor: false,
        application_keypad: false,
        bracketed_paste: false,
        hide_cursor: false,
        mouse_protocol: 'none' as const,
        mouse_encoding: 'default' as const,
      },
    })
    const PLAIN_MODES = {
      alternateScreen: false,
      applicationCursor: false,
      applicationKeypad: false,
      bracketedPaste: false,
      hideCursor: false,
      mouseProtocol: 'none' as const,
      mouseEncoding: 'default' as const,
    }
    const sessionLists = (t: Awaited<ReturnType<typeof setup>>) =>
      t
        .hostMessages()
        .flatMap((m) => (m.type === 'terminalSessions' ? [m] : []))

    test('a settled list is the host’s: its rows are the sessions, and what it no longer holds is dropped', async () => {
      let answer: TerminalListReply = {
        sessions: [row('hc-1', 'herdr', true), row('pty-1', 'native')],
        adoption: { state: 'settled' },
      }
      const t = await setup(
        {},
        undefined,
        {},
        {
          canList: async () => true,
          list: async () => answer,
        },
      )
      await t.settle()
      expect(sessionLists(t).at(-1)!.sessions).toEqual([
        {
          session: 'hc-1',
          profile: 'Herdr shell',
          backend: 'herdr',
          workspace: 'w1',
          program: 2,
          state: 'running',
          modes: PLAIN_MODES,
        },
        {
          session: 'pty-1',
          profile: 'Shell',
          backend: 'native',
          workspace: 'w1',
          program: 2,
          state: 'running',
          modes: PLAIN_MODES,
        },
      ])

      answer = {
        sessions: [row('pty-1', 'native')],
        adoption: { state: 'settled' },
      }
      t.announce({ kind: 'terminal.adoption', data: { state: 'settled' } })
      await t.settle()
      expect(
        sessionLists(t)
          .at(-1)!
          .sessions.map((s) => s.session),
      ).toEqual(['pty-1'])
    })

    test('a foreground coding program names the session’s profile, and the program now wins over an earlier list', async () => {
      let answer: TerminalListReply = {
        sessions: [
          { ...row('hc-1', 'herdr'), command: 'claude' },
          { ...row('hc-2', 'herdr'), command: '/usr/local/bin/codex' },
          { ...row('hc-3', 'herdr'), command: 'zsh' },
        ],
        adoption: { state: 'settled' },
      }
      const t = await setup(
        {},
        undefined,
        {},
        {
          canList: async () => true,
          list: async () => answer,
        },
      )
      await t.settle()
      expect(
        sessionLists(t)
          .at(-1)!
          .sessions.map((s) => [s.session, s.profile]),
      ).toEqual([
        ['hc-1', 'Claude Code (Herdr)'],
        ['hc-2', 'Codex (Herdr)'],
        ['hc-3', 'Herdr shell'],
      ])

      answer = {
        sessions: [{ ...row('hc-1', 'herdr'), command: 'zsh' }],
        adoption: { state: 'settled' },
      }
      t.announce({ kind: 'terminal.adoption', data: { state: 'settled' } })
      await t.settle()
      expect(
        sessionLists(t)
          .at(-1)!
          .sessions.map((s) => [s.session, s.profile]),
      ).toEqual([['hc-1', 'Herdr shell']])
    })

    test('a terminal the host offers to admit is listed with admitted: false, and the workspace’s own do not say', async () => {
      const t = await setup(
        {},
        undefined,
        {},
        {
          canList: async () => true,
          list: async () =>
            ({
              sessions: [
                { ...row('hc-1', 'herdr'), command: 'zsh', cwd: '/work' },
                row('pty-1', 'native'),
              ],
              adoption: { state: 'settled' },
              unadmitted: [
                {
                  session: 'hc-mine',
                  terminal: 't7',
                  backend: 'herdr',
                  state: 'running',
                  cols: 120,
                  rows: 40,
                  name: 'agent',
                  command: 'claude',
                  cwd: '/work/app',
                },
                {
                  session: 'hc-bare',
                  terminal: 't8',
                  backend: 'herdr',
                  state: 'running',
                  cols: 80,
                  rows: 24,
                  command: 'claude',
                },
              ],
            }) as unknown as TerminalListReply,
        },
      )
      await t.settle()
      const listed = sessionLists(t).at(-1)!.sessions
      const of = (id: string) => listed.find((s) => s.session === id)!
      // What its owner called it, and where its program works. Its foreground
      // program is claude, so it carries the coding profile, not the backend's.
      expect(of('hc-mine')).toEqual({
        session: 'hc-mine',
        profile: 'Claude Code (Herdr)',
        backend: 'herdr',
        workspace: of('hc-1').workspace,
        state: 'running',
        name: 'agent',
        cwd: '/work/app',
        admitted: false,
      })
      // Unnamed, it is called by the program in its foreground.
      expect(of('hc-bare')).toMatchObject({ name: 'claude', admitted: false })
      expect(of('hc-bare')).not.toHaveProperty('cwd')
      expect(of('hc-1')).toMatchObject({ name: 'zsh', cwd: '/work' })
      expect(of('hc-1')).not.toHaveProperty('admitted')
      expect(of('pty-1')).not.toHaveProperty('admitted')
      expect(of('pty-1')).not.toHaveProperty('name')
    })

    test('terminal.unadmitted: the list is read again, so a terminal its owner just started appears', async () => {
      let answer = {
        sessions: [] as unknown[],
        adoption: { state: 'settled' },
        unadmitted: [] as unknown[],
      }
      const t = await setup(
        {},
        undefined,
        {},
        {
          canList: async () => true,
          list: async () => answer as unknown as TerminalListReply,
        },
      )
      await t.settle()
      expect(sessionLists(t).at(-1)!.sessions).toEqual([])
      answer = {
        ...answer,
        unadmitted: [
          {
            session: 'hc-mine',
            terminal: 't7',
            backend: 'herdr',
            state: 'running',
            cols: 80,
            rows: 24,
            name: 'agent',
          },
        ],
      }
      t.announce({ kind: 'terminal.unadmitted', data: {} })
      await t.settle()
      expect(sessionLists(t).at(-1)!.sessions).toMatchObject([
        { session: 'hc-mine', name: 'agent', admitted: false },
      ])
      // And when it ends, the same event takes it off the list.
      answer = { ...answer, unadmitted: [] }
      t.announce({ kind: 'terminal.unadmitted', data: {} })
      await t.settle()
      expect(sessionLists(t).at(-1)!.sessions).toEqual([])
    })

    test('a session this workbench holds keeps the name and directory the host gave it', async () => {
      let answer: { sessions: unknown[]; adoption: { state: string } } = {
        sessions: [{ ...row('t1', 'herdr'), name: 'agent', cwd: '/work' }],
        adoption: { state: 'settled' },
      }
      const t = await setup(
        {},
        undefined,
        {},
        {
          canList: async () => true,
          list: async () => answer as unknown as TerminalListReply,
        },
      )
      await t.settle()
      const mine = () =>
        sessionLists(t)
          .at(-1)!
          .sessions.find((s) => s.session === 't1')!
      expect(mine()).toMatchObject({ name: 'agent', cwd: '/work' })
      // Bound here, the binding says its liveness and control; it knows no name.
      t.adapter.perform(effectOf(1, 'terminalOpen'))
      await t.settle()
      expect(mine()).toMatchObject({ name: 'agent', cwd: '/work' })
      // The host still says what it is called: a new word replaces the old, and none removes it.
      answer = {
        ...answer,
        sessions: [{ ...row('t1', 'herdr'), name: 'reviewer', cwd: '/work' }],
      }
      t.announce({ kind: 'terminal.unadmitted', data: {} })
      await t.settle()
      expect(mine()).toMatchObject({ name: 'reviewer', cwd: '/work' })
      answer = { ...answer, sessions: [row('t1', 'herdr')] }
      t.announce({ kind: 'terminal.unadmitted', data: {} })
      await t.settle()
      expect(mine()).not.toHaveProperty('name')
      expect(mine()).not.toHaveProperty('cwd')
    })

    test('once admitted the same id is a session of the workspace, and a settled list drops what is no longer offered', async () => {
      const offered = {
        session: 'hc-mine',
        terminal: 't7',
        backend: 'herdr',
        state: 'running',
        cols: 80,
        rows: 24,
        name: 'agent',
      }
      let answer = {
        sessions: [] as unknown[],
        adoption: { state: 'settled' },
        unadmitted: [
          offered,
          { ...offered, session: 'hc-gone', terminal: 't9' },
        ],
      }
      const t = await setup(
        {},
        undefined,
        {},
        {
          canList: async () => true,
          list: async () => answer as unknown as TerminalListReply,
        },
      )
      ;(
        t.options.terminal.host as {
          admit?: (session: string) => Promise<unknown>
        }
      ).admit = async () => {
        answer = {
          sessions: [{ ...row('hc-mine', 'herdr'), name: 'agent' }],
          adoption: { state: 'settled' },
          unadmitted: [],
        }
      }
      await t.settle()
      expect(
        sessionLists(t)
          .at(-1)!
          .sessions.map((s) => [s.session, s.admitted]),
      ).toEqual([
        ['hc-mine', false],
        ['hc-gone', false],
      ])
      t.adapter.perform({
        ...effectOf(903, 'terminalAdmit'),
        payload: { session: 'hc-mine' },
      } as Effect)
      await t.settle()
      await t.settle()
      const after = sessionLists(t).at(-1)!.sessions
      expect(after.map((s) => s.session)).toEqual(['hc-mine'])
      expect(after[0]).toMatchObject({ name: 'agent' })
      expect(after[0]).not.toHaveProperty('admitted')
    })

    test('a host that lists no terminal.admit is not asked: refused owner_unavailable', async () => {
      const t = await setup()
      const asked: string[] = []
      const host = t.options.terminal.host as {
        admit?: (session: string) => Promise<unknown>
        canAdmit?: () => Promise<boolean>
      }
      host.admit = async (session) => void asked.push(session)
      host.canAdmit = async () => false
      t.adapter.perform(effectOf(904, 'terminalAdmit'))
      await t.settle()
      expect(
        t.completions().find((c) => c.effect === 904)!.outcome,
      ).toMatchObject({ status: 'refused', code: 'owner_unavailable' })
      expect(asked).toEqual([])
    })

    test('admitting a session asks the host, then lists again so the row is an ordinary one', async () => {
      const admitted: string[] = []
      let listed = 0
      const t = await setup(
        {},
        undefined,
        {},
        {
          canList: async () => true,
          list: async () => {
            listed += 1
            return {
              sessions: [row('hc-1', 'herdr')],
              adoption: { state: 'settled' },
            } as unknown as TerminalListReply
          },
        },
      )
      ;(
        t.options.terminal.host as {
          admit?: (session: string) => Promise<unknown>
        }
      ).admit = async (session) => void admitted.push(session)
      await t.settle()
      const before = listed
      t.adapter.perform(effectOf(900, 'terminalAdmit'))
      await t.settle()
      await t.settle()
      expect(admitted).toEqual(['hc-9'])
      expect(listed).toBeGreaterThan(before)
      expect(t.completions().find((c) => c.effect === 900)!.outcome).toEqual({
        status: 'accepted',
      })
    })

    test('with no admit call the host is not connected for it: refused owner_unavailable, nothing asked', async () => {
      const t = await setup()
      t.adapter.perform(effectOf(901, 'terminalAdmit'))
      await t.settle()
      expect(
        t.completions().find((c) => c.effect === 901)!.outcome,
      ).toMatchObject({ status: 'refused', code: 'owner_unavailable' })
    })

    test('an admit that throws is uncertain, since the host may have taken the session', async () => {
      const t = await setup()
      ;(
        t.options.terminal.host as {
          admit?: (session: string) => Promise<unknown>
        }
      ).admit = async () => {
        throw new Error('connection dropped')
      }
      t.adapter.perform(effectOf(902, 'terminalAdmit'))
      await t.settle()
      expect(
        t.completions().find((c) => c.effect === 902)!.outcome,
      ).toMatchObject({ status: 'uncertain' })
    })

    test('a pending list proves nothing: a terminal it does not name stays in the list', async () => {
      let answer: TerminalListReply = {
        sessions: [row('hc-1', 'herdr'), row('pty-1', 'native')],
        adoption: { state: 'settled' },
      }
      const t = await setup(
        {},
        undefined,
        {},
        {
          canList: async () => true,
          list: async () => answer,
        },
      )
      await t.settle()
      answer = {
        sessions: [row('pty-1', 'native')],
        adoption: { state: 'pending' },
      }
      t.announce({ kind: 'terminal.adoption', data: { state: 'pending' } })
      await t.settle()
      expect(
        sessionLists(t)
          .at(-1)!
          .sessions.map((s) => s.session),
      ).toEqual(['hc-1', 'pty-1'])
    })

    test('a host that reports Herdr ready with a core this client is not pinned to is told so, not that Herdr is not ready', async () => {
      const t = await setup(
        {},
        undefined,
        {},
        {
          herdr: { ready: true, generation: 1, version: '9.9.9' },
          canList: async () => true,
          list: async () => ({
            sessions: [row('pty-1', 'native')],
            adoption: { state: 'settled' },
          }),
        },
      )
      await t.settle()
      const herdr = sessionLists(t)
        .at(-1)!
        .profiles.filter((p) => p.backend === 'herdr')
      expect(herdr.every((p) => !p.available)).toBe(true)
      for (const p of herdr) {
        expect(p.unavailableReason).toContain('herdr-core 9.9.9')
        expect(p.unavailableReason).not.toContain('terminals not ready')
      }
    })

    test('capabilities that change after the first listing republish the Herdr profiles with the reason that is true each time', async () => {
      const t = await setup(
        {},
        undefined,
        {},
        {
          herdr: { ready: false },
          canList: async () => true,
          list: async () => ({
            sessions: [row('pty-1', 'native')],
            adoption: { state: 'settled' },
          }),
        },
      )
      await t.settle()
      const herdrNow = () =>
        sessionLists(t)
          .at(-1)!
          .profiles.filter((p) => p.backend === 'herdr')
      const change = async (backend: Record<string, unknown>) => {
        t.host.on('capabilities', async () => ({
          schema: 'theorem-workspace-capabilities/1',
          workspace_id: 'w1',
          version: '1.2.3',
          epoch: 'e1',
          cursor: '0',
          granted_by: 'test-host',
          backends: { herdr: backend },
          operations: [
            'workspace.files.list',
            'documents.open',
            'scm.status',
            'terminal.open',
          ].map((name) => op(name)),
        }))
        t.live.emit('workspace.capabilities', {})
        await t.settle()
        await t.settle()
      }
      const before = sessionLists(t).length

      expect(herdrNow().every((p) => !p.available)).toBe(true)
      for (const p of herdrNow())
        expect(p.unavailableReason).toContain('Herdr not ready')

      await change({ ready: true, generation: 1, version: '0.1.17' })
      expect(herdrNow().every((p) => p.available)).toBe(true)
      for (const p of herdrNow()) expect(p.unavailableReason).toBeUndefined()

      await change({ ready: true, generation: 1, version: '9.9.9' })
      expect(herdrNow().every((p) => !p.available)).toBe(true)
      for (const p of herdrNow()) {
        expect(p.unavailableReason).toContain('herdr-core 9.9.9')
        expect(p.unavailableReason).not.toContain('terminals not ready')
      }

      await change({ ready: false })
      expect(herdrNow().every((p) => !p.available)).toBe(true)
      for (const p of herdrNow())
        expect(p.unavailableReason).toContain('Herdr not ready')
      expect(sessionLists(t).length).toBeGreaterThan(before)
    })

    test('an unavailable adoption is stated on the Herdr profiles with its reason, and no session is dropped', async () => {
      let answer: TerminalListReply = {
        sessions: [row('hc-1', 'herdr'), row('pty-1', 'native')],
        adoption: { state: 'settled' },
      }
      const t = await setup(
        {},
        undefined,
        {},
        {
          herdr: true,
          canList: async () => true,
          list: async () => answer,
        },
      )
      await t.settle()
      expect(
        sessionLists(t)
          .at(-1)!
          .profiles.filter((p) => p.backend === 'herdr')
          .map((p) => p.available),
      ).toEqual([true, true, true])

      answer = {
        sessions: [row('pty-1', 'native')],
        adoption: {
          state: 'unavailable',
          reason: 'core_closed',
          next_step: 'retry',
        },
      }
      t.announce({
        kind: 'terminal.adoption',
        data: {
          state: 'unavailable',
          reason: 'core_closed',
          next_step: 'retry',
        },
      })
      await t.settle()
      const last = sessionLists(t).at(-1)!
      expect(last.sessions.map((s) => s.session)).toEqual(['hc-1', 'pty-1'])
      expect(last.profiles.filter((p) => p.backend === 'herdr')).toEqual([
        expect.objectContaining({
          available: false,
          unavailableReason:
            'Herdr terminals cannot be reached: the core closed the connection. Retry to reconnect.',
        }),
        expect.objectContaining({
          available: false,
          unavailableReason:
            'Herdr terminals cannot be reached: the core closed the connection. Retry to reconnect.',
        }),
        expect.objectContaining({
          available: false,
          unavailableReason:
            'Herdr terminals cannot be reached: the core closed the connection. Retry to reconnect.',
        }),
      ])
    })

    test('the adoption state and each row’s modes are on the message; an unknown mode value leaves the modes out', async () => {
      const modes = {
        alternate_screen: true,
        application_cursor: true,
        application_keypad: false,
        bracketed_paste: true,
        hide_cursor: false,
        mouse_protocol: 'any_motion' as const,
        mouse_encoding: 'sgr' as const,
      }
      let answer: TerminalListReply = {
        sessions: [
          { ...row('pty-1', 'native'), modes },
          {
            ...row('pty-2', 'native'),
            modes: { ...modes, mouse_protocol: 'future' as never },
          },
        ],
        adoption: { state: 'pending' },
      }
      const t = await setup(
        {},
        undefined,
        {},
        {
          canList: async () => true,
          list: async () => answer,
        },
      )
      await t.settle()
      let last = sessionLists(t).at(-1)!
      expect(last.adoption).toEqual({ state: 'pending' })
      expect(last.sessions[0]!.modes).toEqual({
        alternateScreen: true,
        applicationCursor: true,
        applicationKeypad: false,
        bracketedPaste: true,
        hideCursor: false,
        mouseProtocol: 'any_motion',
        mouseEncoding: 'sgr',
      })
      expect(last.sessions[1]).not.toHaveProperty('modes')
      answer = { sessions: [], adoption: { state: 'settled' } }
      t.announce({ kind: 'terminal.adoption', data: { state: 'settled' } })
      await t.settle()
      expect(sessionLists(t).at(-1)!.adoption).toEqual({ state: 'settled' })
      answer = {
        sessions: [],
        adoption: {
          state: 'unavailable',
          reason: 'core_unavailable',
          next_step: 'retry',
        },
      }
      t.announce({
        kind: 'terminal.adoption',
        data: {
          state: 'unavailable',
          reason: 'core_unavailable',
          next_step: 'retry',
        },
      })
      await t.settle()
      last = sessionLists(t).at(-1)!
      expect(last.adoption).toEqual({
        state: 'unavailable',
        reason: 'core_unavailable',
        next_step: 'retry',
      })
    })

    test('a host with no terminal.list leaves adoption absent, never settled', async () => {
      const t = await setup({}, undefined, {}, { canList: async () => false })
      await t.settle()
      expect(sessionLists(t).at(-1)).not.toHaveProperty('adoption')
      expect(
        sessionLists(t)
          .at(-1)!
          .sessions.every((s) => !('modes' in s)),
      ).toBe(true)
    })

    test('a list that cannot be read, or a host that does not list terminals, leaves the known sessions as they were', async () => {
      const warn = console.warn
      console.warn = () => {}
      try {
        let fail = false
        const t = await setup(
          {},
          undefined,
          {},
          {
            canList: async () => true,
            list: async () => {
              if (fail) throw new Error('gateway timeout')
              return {
                sessions: [row('pty-1', 'native')],
                adoption: { state: 'settled' },
              }
            },
          },
        )
        await t.settle()
        fail = true
        t.announce({ kind: 'terminal.adoption', data: { state: 'pending' } })
        await t.settle()
        expect(
          sessionLists(t)
            .at(-1)!
            .sessions.map((s) => s.session),
        ).toEqual(['pty-1'])

        let asked = 0
        const old = await setup(
          {},
          undefined,
          {},
          {
            canList: async () => false,
            list: async () => {
              asked += 1
              return { sessions: [], adoption: { state: 'settled' } }
            },
          },
        )
        await old.settle()
        expect(asked).toBe(0)
      } finally {
        console.warn = warn
      }
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

  test('conversation.side is granted only with a conversation owner that can make side chats', async () => {
    const granted = async (conversation: unknown) => {
      const t = await setup({ conversation: conversation as never }, [])
      await t.settle()
      return t
        .hostMessages()
        .flatMap((m) =>
          m.type === 'capabilitiesChanged' ? m.capabilities.granted : [],
        )
    }
    const owner = { perform: async () => ({ outcome: 'accepted' as const }) }
    expect(await granted({ ...owner, canSideChat: true })).toContain(
      'conversation.side',
    )
    expect(await granted(owner)).not.toContain('conversation.side')
    expect(await granted({ ...owner, canSwitchBranch: true })).toContain(
      'conversation.branch',
    )
    expect(await granted({ ...owner, canAttach: true })).toContain(
      'conversation.attach',
    )
    expect(await granted({ ...owner, canPickModel: true })).toContain(
      'conversation.model',
    )
    const plain = await granted(owner)
    expect(plain).not.toContain('conversation.attach')
    expect(plain).not.toContain('conversation.model')
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

// ---- AC-50: account change and revoked access --------------------------------------------------

describe('account change and revoked access', () => {
  /** An owner whose answers the test releases by hand, so an effect is in flight when the account changes. */
  function held() {
    const releases: ((reply: OwnerReply) => void)[] = []
    const port: OwnerPort<never> = {
      perform: () =>
        new Promise<OwnerReply>((resolve) => void releases.push(resolve)),
      subscribe: () => () => {},
    }
    return { port, releases }
  }
  const watchOf = () => {
    const listeners = new Set<(change: AccountChange) => void>()
    const watch = {
      current: 't1:p1' as string | undefined,
      refresh: async () => ({ state: 'unknown', reason: 'test' }) as const,
      onChange: (listener: (change: AccountChange) => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      dispose: () => {},
    }
    return {
      watch,
      change: (change: AccountChange) => {
        for (const listener of [...listeners]) listener(change)
      },
    }
  }
  const SWITCHED: AccountChange = {
    account: 't2:p2',
    previous: 't1:p1',
    reason: 'Another account is signed in on this device',
  }

  test('a switch answers what is in flight uncertain, drops its late result, and tells the core the account', async () => {
    const { port, releases } = held()
    const { watch, change } = watchOf()
    const t = await setup({ documents: port as never, account: watch })
    const retired: unknown[] = []
    t.adapter.onRetired((why) => retired.push(why))
    t.adapter.perform(effectOf(1, 'documentSave'))
    await t.settle()
    expect(t.completions()).toHaveLength(0)

    change(SWITCHED)
    expect(retired).toEqual([
      {
        code: 'account_changed',
        reason: SWITCHED.reason,
        account: 't2:p2',
      },
    ])
    expect(t.hostMessages()).toContainEqual({
      type: 'accountChanged',
      account: 't2:p2',
    })
    expect(t.hostMessages()).toContainEqual({
      type: 'capabilitiesChanged',
      capabilities: { granted: [] },
    })
    const [answer] = t.completions()
    expect(answer).toMatchObject({
      effect: 1,
      outcome: { status: 'uncertain' },
    })
    expect(JSON.stringify(answer)).toContain('not applied')

    // The old account's owner answers late: nothing reaches the core, and there is no second completion.
    releases[0]!({ outcome: 'accepted' })
    await t.settle()
    expect(t.completions()).toHaveLength(1)
  })

  test('after a switch every effect is refused account_changed and no owner is reached', async () => {
    const { watch, change } = watchOf()
    const t = await setup({ account: watch })
    change(SWITCHED)
    const before = t.calls.length
    t.adapter.perform(effectOf(7, 'filesList'))
    t.adapter.perform(effectOf(8, 'layoutLoad'))
    await t.settle()
    expect(t.completions().map((c) => c.outcome)).toEqual([
      expect.objectContaining({ status: 'refused', code: 'account_changed' }),
      expect.objectContaining({ status: 'refused', code: 'account_changed' }),
    ])
    expect(t.calls.length).toBe(before)
  })

  test("an owner's pushed messages stop with the account", async () => {
    const { watch, change } = watchOf()
    const t = await setup({ account: watch })
    const push = t.pushed.get('documents')!
    change(SWITCHED)
    expect(t.pushed.has('documents')).toBe(false)
    const seen = t.messages.length
    push({ type: 'documentRetired', resource: WS })
    expect(t.messages.length).toBe(seen)
  })

  test('a sign-out is a stated state: signed_out, capabilities cleared, the holders let go', async () => {
    const { watch, change } = watchOf()
    const retiring: string[] = []
    const t = await setup({
      account: watch,
      retiring: [{ retire: (reason: string) => void retiring.push(reason) }],
    })
    const retired: unknown[] = []
    t.adapter.onRetired((why) => retired.push(why))
    change({
      account: undefined,
      previous: 't1:p1',
      reason: 'The session ended',
    })
    expect(retired).toEqual([
      { code: 'signed_out', reason: 'The session ended' },
    ])
    expect(retiring).toEqual(['The session ended'])
    expect(t.hostMessages()).toContainEqual({
      type: 'connectionChanged',
      workspace: 'w1',
      state: 'closed',
    })
    // No accountChanged is sent for a sign-out: there is no account to name.
    expect(t.hostMessages().some((m) => m.type === 'accountChanged')).toBe(
      false,
    )
  })

  test('a 401 from an owner asks the session who is signed in; with no watch it retires as signed_out', async () => {
    const answer401: OwnerPort<never> = {
      perform: async () => ({
        outcome: 'refused',
        code: 'signed_out',
        reason: 'Sign in again',
      }),
    }
    const asked: string[] = []
    const { watch } = watchOf()
    watch.refresh = async () => {
      asked.push('refresh')
      return { state: 'signed_out', reason: 'Sign in again' } as never
    }
    const withWatch = await setup({
      documents: answer401 as never,
      account: watch,
    })
    withWatch.adapter.perform(effectOf(1, 'documentSave'))
    await withWatch.settle()
    expect(asked).toEqual(['refresh'])
    expect(withWatch.completions()[0]!.outcome).toMatchObject({
      status: 'refused',
      code: 'signed_out',
    })

    const alone = await setup({ documents: answer401 as never })
    const retired: unknown[] = []
    alone.adapter.onRetired((why) => retired.push(why))
    alone.adapter.perform(effectOf(1, 'documentSave'))
    await alone.settle()
    expect(retired).toEqual([{ code: 'signed_out', reason: 'Sign in again' }])
    alone.adapter.perform(effectOf(2, 'filesList'))
    await alone.settle()
    expect(alone.completions()[1]!.outcome).toMatchObject({
      status: 'refused',
      code: 'signed_out',
    })
  })

  test('a workspace the host forbids retires the adapter as forbidden and clears its capabilities', async () => {
    const t = await setup()
    const retired: unknown[] = []
    t.adapter.onRetired((why) => retired.push(why))
    t.host.on('capabilities', () => {
      throw new HttpError(403, {
        detail: 'Access to this workspace was revoked',
      })
    })
    t.host.on('open', () => {
      throw new HttpError(403, {
        detail: 'Access to this workspace was revoked',
      })
    })
    await t.environment.reopen().catch(() => undefined)
    await t.settle()
    expect(retired).toEqual([
      { code: 'forbidden', reason: 'Access to this workspace was revoked' },
    ])
    expect(t.hostMessages().at(-1)).toEqual({
      type: 'connectionChanged',
      workspace: 'w1',
      state: 'closed',
    })
  })
})

describe('terminal core loss, through the real terminal owner', () => {
  const BINDING = { backend: 'herdr', epoch: 2, program: 1 }
  const attachReply = (extra: Record<string, unknown> = {}) => ({
    session: 'hc-example',
    attached: true,
    attachment: 'ta-1',
    control: {
      attachment: 'ta-1',
      role: 'controller',
      controlling: true,
      controlled: true,
      generation: 1,
      epoch: 2,
    },
    backend: 'herdr',
    epoch: 2,
    binding: BINDING,
    formatted: '',
    offset_start: 0,
    offset_end: 0,
    data: '',
    ...extra,
  })
  const wired = async (operation?: string) => {
    const r = terminalRig()
    r.handlers.open = () => ({
      session: 'hc-example',
      cols: 80,
      rows: 24,
      backend: 'herdr',
      binding: BINDING,
      process_owned_by: 'herdr-core',
    })
    r.handlers.attach = () => attachReply()
    const t = await setup({
      terminal: {
        create: () => r.session,
        host: { onEvent: () => () => undefined },
      },
    })
    t.adapter.perform({
      id: 1,
      resource: WS,
      kind: 'terminalOpen',
      payload: {
        backend: 'herdr',
        cols: 80,
        rows: 24,
        ...(operation ? { operation } : {}),
      },
    } as never)
    await t.settle()
    expect(t.completions()[0]!.outcome).toEqual({ status: 'accepted' })
    return { r, t }
  }
  const exits = (t: Awaited<ReturnType<typeof setup>>) =>
    t.hostMessages().flatMap((m) => (m.type === 'terminalExited' ? [m] : []))
  const lists = (t: Awaited<ReturnType<typeof setup>>) =>
    t.hostMessages().flatMap((m) => (m.type === 'terminalSessions' ? [m] : []))
  const links = (t: Awaited<ReturnType<typeof setup>>) =>
    t
      .hostMessages()
      .flatMap((m) => (m.type === 'terminalConnectivity' ? [m] : []))
  const frame = (r: Awaited<ReturnType<typeof wired>>['r'], f: unknown) =>
    r.emit(
      (f as { kind: string }).kind,
      (f as { data: Record<string, unknown> }).data,
    )

  test('a core loss reaches the pane as connectivity at the event epoch with the host’s cause and next step, never as an exit, and the list says lost with them', async () => {
    const { r, t } = await wired()
    frame(r, UPDATED_CORE_CLOSED)
    expect(links(t)).toEqual([
      {
        type: 'terminalConnectivity',
        resource: expect.anything(),
        epoch: 2,
        state: 'lost',
        reason: 'core_closed',
        nextStep: 'retry',
      },
    ])
    expect(exits(t)).toEqual([])
    expect(lists(t).at(-1)!.sessions[0]).toMatchObject({
      session: 'hc-example',
      state: 'lost',
      reason: 'core_closed',
      nextStep: 'retry',
    })
  })

  test('a recovery sends running connectivity in the same epoch and the list says running without the cause; the program report on each update still arrives', async () => {
    const { r, t } = await wired()
    frame(r, UPDATED_CORE_UNAVAILABLE)
    frame(r, UPDATED_RUNNING)
    expect(exits(t)).toEqual([])
    expect(links(t).map((m) => [m.epoch, m.state])).toEqual([
      [2, 'lost'],
      [2, 'running'],
    ])
    expect(links(t)[1]).not.toHaveProperty('reason')
    expect(links(t)[1]).not.toHaveProperty('nextStep')
    const row = lists(t).at(-1)!.sessions[0]
    expect(row).toMatchObject({ state: 'running' })
    expect(row).not.toHaveProperty('reason')
    expect(row).not.toHaveProperty('nextStep')
    const reports = t
      .hostMessages()
      .flatMap((m) => (m.type === 'terminalReport' ? [m] : []))
    expect(reports.map((m) => m.report)).toEqual([{ kind: 'never_reported' }])
  })

  test('a host that sends none of the new fields sends the pane no loss', async () => {
    const { r, t } = await wired()
    frame(r, {
      kind: 'terminal.updated',
      data: { session: 'hc-example', epoch: 2 },
    })
    expect(exits(t)).toEqual([])
    expect(links(t)).toEqual([])
    expect(lists(t).at(-1)!.sessions[0]).toMatchObject({ state: 'running' })
  })

  test('an attach answered attached:true with state:lost completes refused terminal_core_lost, not as a live terminal', async () => {
    const { r, t } = await wired()
    r.handlers.attach = () => attachReply(ATTACH_LOST_FRAGMENT)
    t.adapter.perform({
      ...effectOf(2, 'terminalAttach'),
      resource: { type: 'terminal', workspace: 'w1', session: 'hc-example' },
    } as never)
    await t.settle()
    const done = t.completions().at(-1)!
    expect(done.outcome).toMatchObject({
      status: 'refused',
      code: 'terminal_core_lost',
    })
    expect(done).not.toHaveProperty('payload')
    r.handlers.attach = () => attachReply(ATTACH_RUNNING_FRAGMENT)
    t.adapter.perform({
      ...effectOf(3, 'terminalAttach'),
      resource: { type: 'terminal', workspace: 'w1', session: 'hc-example' },
    } as never)
    await t.settle()
    expect(t.completions().at(-1)!.outcome).toEqual({ status: 'accepted' })
  })

  test('terminal.exited: gone and exited are exits with their word; scope_removed is lost', async () => {
    const gone = await wired()
    frame(gone.r, EXITED_GONE)
    expect(exits(gone.t)).toEqual([
      expect.objectContaining({ epoch: 2, reason: 'gone' }),
    ])
    expect(exits(gone.t)[0]).not.toHaveProperty('exitCode')
    const done = await wired()
    frame(done.r, EXITED_EXITED)
    expect(exits(done.t)).toEqual([
      expect.objectContaining({ reason: 'exited', exitCode: 0 }),
    ])
    const scope = await wired()
    frame(scope.r, EXITED_SCOPE_REMOVED)
    expect(exits(scope.t)).toEqual([
      expect.objectContaining({ epoch: 2, reason: 'lost' }),
    ])
  })

  test('the launch carries one operation id per intent: the pane’s own when it names one, else the effect’s', async () => {
    const named = await wired('intent-7')
    expect(
      (named.r.of('open')[0]!.request.body as { operation_id: string })
        .operation_id,
    ).toBe('intent-7')
    const bare = await wired()
    const sent = (
      bare.r.of('open')[0]!.request.body as { operation_id: string }
    ).operation_id
    expect(sent).toMatch(/:1$/)
    expect(bare.r.of('open')[0]!.request['Idempotency-Key']).toBe(sent)
  })

  test('a lost launch answer completes uncertain and the adapter launches nothing again', async () => {
    const r = terminalRig()
    r.handlers.open = () => {
      throw Object.assign(new Error('HTTP 409'), {
        statusCode: 409,
        body: {
          code: 'terminal_operation_uncertain',
          detail: { operation_id: 'i', next_step: 'reconcile' },
        },
      })
    }
    const t = await setup({
      terminal: {
        create: () => r.session,
        host: { onEvent: () => () => undefined },
      },
    })
    t.adapter.perform({
      id: 1,
      resource: WS,
      kind: 'terminalOpen',
      payload: { backend: 'herdr', cols: 80, rows: 24, operation: 'i' },
    } as never)
    await t.settle()
    expect(t.completions()[0]!.outcome).toMatchObject({ status: 'uncertain' })
    expect(r.of('open')).toHaveLength(1)
  })

  test('an unavailable adoption with the host’s stable code is stated on the Herdr profiles in plain words, with the advice', async () => {
    const t = await setup(
      {},
      undefined,
      {},
      {
        herdr: true,
        canList: async () => true,
        list: async () =>
          ({
            sessions: [LOST_LIST_ROW],
            adoption: {
              state: 'unavailable',
              reason: 'core_unavailable',
              next_step: 'retry',
            },
          }) as never,
      },
    )
    await t.settle()
    t.announce(ADOPTION_UNAVAILABLE_EVENT)
    await t.settle()
    const last = lists(t).at(-1)!
    expect(last.profiles.filter((p) => p.backend === 'herdr')[0]).toMatchObject(
      {
        available: false,
        unavailableReason:
          'Herdr terminals cannot be reached: the core cannot be reached. Retry to reconnect.',
      },
    )
    // The host's cause and next step travel on the adoption state too, as it sent them.
    expect(last.adoption).toEqual({
      state: 'unavailable',
      reason: 'core_unavailable',
      next_step: 'retry',
    })
    // The retained lost row is kept and says lost.
    expect(last.sessions.find((s) => s.session === 'hc-example')).toMatchObject(
      {
        state: 'lost',
      },
    )
  })
})

describe('telling the agent its terminal stopped working', () => {
  const agent = { type: 'agent', runId: 'front-run' } as const
  const claude = {
    ...effectOf(1, 'terminalOpen'),
    payload: {
      backend: 'herdr',
      argv: ['claude'],
      name: 'Claude Code (Herdr)',
      cols: 80,
      rows: 24,
    },
  } as Effect
  const report = (state: string) => ({
    type: 'report',
    terminalId: 't1',
    bindingEpoch: 2,
    report: { kind: 'current', status: { state } },
  })
  async function opened(effect: Effect) {
    const told: SessionNotice[] = []
    const t = await setup({
      sessions: createSessionWatch((notice) => told.push(notice)),
    })
    t.adapter.perform(effect)
    await t.settle()
    return { t, told }
  }

  test('a terminal the agent opened tells that run when its program goes from working to idle', async () => {
    const { t, told } = await opened({ ...claude, actor: agent } as Effect)
    t.port.emit(report('idle'))
    t.port.emit(report('working'))
    expect(told).toEqual([])
    t.port.emit(report('idle'))
    expect(told).toEqual([
      {
        runId: 'front-run',
        session: 't1',
        what: 'Claude Code (Herdr)',
        state: 'finished',
      },
    ])
  })

  test('blocked is waiting for a person, and an exit is news with its code', async () => {
    const { t, told } = await opened({ ...claude, actor: agent } as Effect)
    t.port.emit(report('working'))
    t.port.emit(report('blocked'))
    t.port.emit({ type: 'exited', reason: 'exited', code: 3, signal: null })
    expect(told.map((n) => [n.state, n.detail])).toEqual([
      ['waiting', undefined],
      ['ended', 'exit code 3'],
    ])
  })

  test('a terminal the person opened tells no run', async () => {
    const { t, told } = await opened(claude)
    t.port.emit(report('working'))
    t.port.emit(report('done'))
    t.port.emit({ type: 'exited', reason: 'exited', code: 0, signal: null })
    expect(told).toEqual([])
  })
})
