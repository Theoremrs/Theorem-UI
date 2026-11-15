// SOURCING: none — bun:test over the documents, SCM and terminal owners (through their ports where they have one and the adapter's completionFor) with the SDK's own error classes and a captured console; AC-53 (R42, R47)
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { inspect } from 'node:util'
import { TheoremError, TheoremTimeoutError } from '@theoremharness/sdk-ide'
import { completionFor } from './adapter'
import { createDocuments } from './documents/documents'
import { createDocumentsPort } from './documents/port'
import { accepted } from './environment/result'
import {
  FakeLive,
  op,
  stubHost,
  testEnvironment,
} from './environment/test-host'
import { createScm } from './scm/scm'
import { createScmPort } from './scm/port'
import {
  SUPPORTED_ATTACH_REPLY,
  SUPPORTED_OPEN_REPLY,
} from './terminal/fixtures/herdr-wire'
import { profileById } from './terminal/terminal-profile'
import { rig } from './terminal/test-rig'
import type { Effect, Revision } from './wire'

const KEY = 'sk-live-Zx9Qw8Er7Ty6Ui5Op4As3Df2'
const BEARER = 'Bearer 9f8e7d6c5b4a39281706deadbeefcafe'
const TOKEN = '9f8e7d6c5b4a39281706deadbeefcafe'
const MARKER = 'UNIQUE-CONTENT-LINE-7731'
/** What a file, a diff or a typed line holds in these tests: a key, a bearer token and a line only the content has. */
const CONTENT = `API_KEY=${KEY}\nAuthorization: ${BEARER}\n${MARKER}`

const seq = (value: number): Revision => ({ scheme: 'seq', value })

/** Every console method, captured as the full inspected text of its arguments (message, body and stack of an error included). */
let logged: string[] = []
let restores: (() => void)[] = []
beforeEach(() => {
  logged = []
  restores = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
    (method) => {
      const spy = spyOn(console, method).mockImplementation((...args) => {
        logged.push(args.map((arg) => inspect(arg, { depth: 8 })).join(' '))
      })
      return () => spy.mockRestore()
    },
  )
})
afterEach(() => restores.forEach((restore) => restore()))

/** Nothing the outcome carries as words, and nothing logged, holds a credential or the content. */
function expectNoLeak(...texts: unknown[]) {
  for (const text of [...texts, ...logged]) {
    const flat = typeof text === 'string' ? text : JSON.stringify(text)
    for (const secret of [KEY, TOKEN, MARKER])
      expect(flat, `leaked ${secret}`).not.toContain(secret)
  }
}

/** The host's refusal as the SDK throws it: its message dumps the status and the body, which echoes what was sent. */
const echoing = (statusCode: number, code: string) =>
  new TheoremError({
    message: 'The host could not apply the request',
    statusCode,
    body: {
      code,
      title: 'Request failed',
      echo: CONTENT,
      request: { text: CONTENT },
    },
  })

const reasonOf = (answer: unknown) =>
  String((answer as { reason?: unknown }).reason)

// ---------------------------------------------------------------- documents

const DOCS = [
  'documents.open',
  'documents.edit',
  'documents.save',
  'documents.close',
  'documents.reconcile',
].map((name) => op(name))

async function documentsRig() {
  const host = stubHost(DOCS)
  const state = { revision: 1, text: 'hello' }
  const handlers = new Map<
    string,
    (request: Record<string, unknown>) => unknown
  >()
  const calls: { name: string; request: Record<string, unknown> }[] = []
  const head = () => ({
    document_id: 'd1',
    revision: state.revision,
    content_hash: 'c',
    disk_hash: 'c',
    text: state.text,
  })
  const method =
    (name: string, fallback: (request: Record<string, unknown>) => unknown) =>
    async (request: Record<string, unknown>) => {
      calls.push({ name, request })
      return (handlers.get(name) ?? fallback)(request)
    }
  host.client = {
    ...host.client,
    documentSessions: {
      open: method('open', head),
      head: method('head', head),
      edit: method('edit', (request) => {
        state.revision = (request.base_revision as number) + 1
        return head()
      }),
      save: method('save', () => ({})),
      close: method('close', () => ({})),
      reconcile: method('reconcile', () => ({})),
    },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const documents = createDocuments(environment)
  const port = createDocumentsPort({
    documents,
    files: {
      create: async (request) =>
        accepted(
          { workspaceId: 'w1', requestId: request.requestId },
          { path: request.path },
        ),
      delete: async (request) =>
        accepted(
          { workspaceId: 'w1', requestId: request.requestId },
          { path: request.path },
        ),
    },
  })
  const resource = {
    type: 'document' as const,
    workspace: 'w1',
    resourceId: 'a.txt',
  }
  let id = 0
  const effect = (kind: string, extra: Record<string, unknown> = {}) =>
    ({ id: (id += 1), resource, kind, ...extra }) as unknown as Effect
  const perform = async (e: Effect) => {
    const answer = await port.perform(e as never, `req-${e.id}`)
    return { answer, completion: completionFor(e, answer) }
  }
  await perform(effect('documentOpen', { payload: {} }))
  const edit = (operationId: string, revision: number) =>
    effect('documentEdit', {
      revision: seq(revision),
      payload: {
        operationId,
        unit: 'utf16',
        edits: [{ start: 5, end: 5, insert: CONTENT }],
      },
    })
  return {
    on: (
      name: string,
      handler: (request: Record<string, unknown>) => unknown,
    ) => void handlers.set(name, handler),
    calls,
    count: (name: string) => calls.filter((call) => call.name === name).length,
    documents,
    perform,
    effect,
    edit,
    resource,
    state,
  }
}

describe('a document effect that carries a secret', () => {
  test('accepted: the outcome names the document, the operation and the new revision, and nothing is logged', async () => {
    const r = await documentsRig()
    const e = r.edit('op-1', 1)
    const { answer, completion } = await r.perform(e)
    expect(answer).toMatchObject({
      outcome: 'accepted',
      revision: seq(2),
      value: { type: 'documentEdited', operationId: 'op-1', revision: seq(2) },
    })
    expect(completion).toMatchObject({
      effect: e.id,
      resource: r.resource,
      revision: seq(2),
      outcome: { status: 'accepted' },
    })
    // The text is what the host was asked to apply: that is the edit itself, not a diagnostic.
    expect(r.calls.find((call) => call.name === 'edit')!.request).toMatchObject(
      {
        base_revision: 1,
        operation_id: 'op-1',
      },
    )
    expect(JSON.stringify(completion)).not.toContain(KEY)
    expectNoLeak(completion)
  })

  test('refused: the code and a readable reason come back against the revision the edit was computed on, without the echo', async () => {
    const r = await documentsRig()
    r.on('edit', () => {
      throw echoing(422, 'invalid_edit')
    })
    const e = r.edit('op-2', 1)
    const { answer, completion } = await r.perform(e)
    expect(answer).toMatchObject({ outcome: 'refused', code: 'invalid_edit' })
    expect(reasonOf(answer)).toBe('Request failed')
    expect(completion).toMatchObject({
      effect: e.id,
      resource: r.resource,
      revision: seq(1),
      outcome: { status: 'refused', code: 'invalid_edit' },
    })
    expect(r.documents).toBeDefined()
    expectNoLeak(answer, completion)
  })

  test('refused with a host that echoes the content in its detail: the credentials are masked', async () => {
    const r = await documentsRig()
    r.on('edit', () => {
      throw new TheoremError({
        statusCode: 422,
        body: { code: 'invalid_edit', detail: `cannot apply: ${CONTENT}` },
      })
    })
    const { answer } = await r.perform(r.edit('op-3', 1))
    expect(answer.outcome).toBe('refused')
    expect(reasonOf(answer)).not.toContain(KEY)
    expect(reasonOf(answer)).not.toContain(TOKEN)
    expectNoLeak(
      answer.outcome === 'refused' ? answer.reason.replaceAll(MARKER, '') : '',
    )
  })

  test('uncertain: a timeout after the request was sent is uncertain, never accepted, never resent, and the document does not move', async () => {
    const r = await documentsRig()
    r.on('edit', () => {
      throw new TheoremTimeoutError(
        'Timeout exceeded when calling POST /documents/edit',
      )
    })
    const e = r.edit('op-4', 1)
    const { answer, completion } = await r.perform(e)
    expect(answer).toMatchObject({ outcome: 'uncertain' })
    expect(completion.outcome.status).toBe('uncertain')
    expect(completion).toMatchObject({
      effect: e.id,
      resource: r.resource,
      revision: seq(1),
    })
    expect(r.count('edit')).toBe(1)
    const handle = await r.documents.open({ requestId: 'again', path: 'a.txt' })
    if (handle.outcome !== 'accepted') throw new Error('open')
    expect(handle.value.state.revision).toEqual(seq(1))
    expect(handle.value.state.pending).toMatchObject([
      { operationId: 'op-4', state: 'uncertain' },
    ])
    expectNoLeak(
      answer,
      completion,
      handle.value.state.pending.map((p) => p.reason ?? ''),
    )
  })

  test('uncertain: a dropped connection is the same, and the host sees the edit once', async () => {
    const r = await documentsRig()
    r.on('edit', () => {
      throw new TypeError('fetch failed')
    })
    const { answer } = await r.perform(r.edit('op-5', 1))
    expect(answer.outcome).toBe('uncertain')
    expectNoLeak(answer)
    expect(r.count('edit')).toBe(1)
  })

  test('uncertain save: a lost answer leaves the document marked unsaved, not saved', async () => {
    const r = await documentsRig()
    r.on('save', () => {
      throw new TheoremTimeoutError('Timeout exceeded')
    })
    const e = r.effect('documentSave', { revision: seq(1) })
    const { answer, completion } = await r.perform(e)
    expect(answer.outcome).toBe('uncertain')
    expect(completion).toMatchObject({
      effect: e.id,
      resource: r.resource,
      revision: seq(1),
      outcome: { status: 'uncertain' },
    })
    const handle = await r.documents.open({ requestId: 'again', path: 'a.txt' })
    if (handle.outcome !== 'accepted') throw new Error('open')
    expect(handle.value.state.saveUncertain).toBe(true)
    expect(handle.value.state.dirty).toBe(true)
  })

  test('a stale refusal that cannot re-read the head logs one readable line, not the error with the echoed body', async () => {
    const r = await documentsRig()
    r.on('edit', () => {
      throw new TheoremError({
        statusCode: 409,
        body: { code: 'stale_revision', title: 'The document moved' },
      })
    })
    r.on('head', () => {
      throw echoing(500, 'internal')
    })
    const { answer } = await r.perform(r.edit('op-6', 1))
    expect(answer).toMatchObject({
      outcome: 'refused',
      code: 'conflict',
      value: { type: 'documentConflicted', operationId: 'op-6' },
    })
    const warned = logged.filter((line) =>
      line.includes('The document head could not be read'),
    )
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('Request failed')
    expect(warned[0]).not.toContain('Body:')
    expectNoLeak()
  })
})

// ---------------------------------------------------------------------- scm

const SCM_METHODS = [
  'status',
  'diff',
  'stage',
  'unstage',
  'commit',
  'show',
] as const

async function scmRig() {
  const host = stubHost(
    [
      'scm.status',
      'scm.diff',
      'scm.stage',
      'scm.unstage',
      'scm.commit',
      'scm.show',
    ].map((n) => op(n)),
  )
  const calls: {
    name: string
    request: Record<string, unknown>
    options?: unknown
  }[] = []
  const handlers = new Map<
    string,
    (request: Record<string, unknown>) => unknown
  >()
  const scm: Record<string, unknown> = {}
  for (const name of SCM_METHODS)
    scm[name] = async (request: Record<string, unknown>, options?: unknown) => {
      calls.push({ name, request, options })
      return handlers.get(name)?.(request) ?? {}
    }
  host.client = {
    ...host.client,
    ide: { workspace: host.client.ide.workspace, scm },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const port = createScmPort(createScm(environment))
  const resource = {
    type: 'repository' as const,
    workspace: 'w1',
    repository: 'repo',
  }
  let id = 0
  const perform = async (
    kind: string,
    payload?: unknown,
    revision?: Revision,
  ) => {
    const e = {
      id: (id += 1),
      resource,
      kind,
      ...(payload ? { payload } : {}),
      ...(revision ? { revision } : {}),
    } as unknown as Effect
    const answer = await port.perform(e as never, `req-${e.id}`)
    return { e, answer, completion: completionFor(e, answer) }
  }
  return {
    perform,
    resource,
    calls,
    count: (name: string) => calls.filter((call) => call.name === name).length,
    on: (
      name: string,
      handler: (request: Record<string, unknown>) => unknown,
    ) => void handlers.set(name, handler),
  }
}

describe('a Git effect that carries a secret', () => {
  test('accepted stage: the outcome carries the paths staged and the state the host named, once, and no content', async () => {
    const r = await scmRig()
    r.on('stage', () => ({ head: 'abc1234', index_generation: 7 }))
    const { e, answer, completion } = await r.perform('scmStage', {
      paths: ['.env'],
    })
    expect(answer).toMatchObject({
      outcome: 'accepted',
      value: { type: 'scmState', head: 'abc1234', indexGeneration: '7' },
    })
    expect(completion).toMatchObject({
      effect: e.id,
      resource: r.resource,
      outcome: { status: 'accepted' },
    })
    expect(r.calls[0]!.request).toMatchObject({ body: { paths: ['.env'] } })
    expect(r.calls[0]!.options).toEqual({ maxRetries: 0 })
    expectNoLeak(completion)
  })

  test('accepted commit with a secret in the message: the host is sent the message once, and it appears in no outcome or log', async () => {
    const r = await scmRig()
    r.on('commit', () => ({
      repository: 'repo',
      message: CONTENT,
      state: 'committed',
      output: `[main abc1234] ${CONTENT}`,
      head: 'abc1234',
    }))
    const { answer, completion } = await r.perform('scmCommit', {
      message: CONTENT,
    })
    expect(answer).toMatchObject({
      outcome: 'accepted',
      value: { type: 'scmState', head: 'abc1234' },
    })
    expect(r.calls[0]!.request).toMatchObject({ body: { message: CONTENT } })
    expectNoLeak(completion)
  })

  test('refused commit: the host code and a readable reason, nothing of the echoed diff or message', async () => {
    const r = await scmRig()
    r.on('commit', () => {
      throw echoing(409, 'nothing_to_commit')
    })
    const { e, answer, completion } = await r.perform('scmCommit', {
      message: CONTENT,
    })
    expect(answer).toMatchObject({
      outcome: 'refused',
      code: 'nothing_to_commit',
    })
    expect(reasonOf(answer)).toBe('Request failed')
    expect(completion).toMatchObject({
      effect: e.id,
      resource: r.resource,
      outcome: { status: 'refused', code: 'nothing_to_commit' },
    })
    expectNoLeak(answer, completion)
  })

  test('uncertain commit: a timeout is uncertain, not failed and not accepted, and the commit is not sent twice', async () => {
    const r = await scmRig()
    r.on('commit', () => {
      throw new TheoremTimeoutError(
        'Timeout exceeded when calling POST /scm/commit',
      )
    })
    const { answer, completion } = await r.perform('scmCommit', {
      message: CONTENT,
    })
    expect(answer.outcome).toBe('uncertain')
    expect(completion.outcome.status).toBe('uncertain')
    expect(completion).not.toHaveProperty('payload')
    expect(r.count('commit')).toBe(1)
    expect(r.calls[0]!.options).toEqual({ maxRetries: 0 })
    expectNoLeak(answer, completion)
  })

  test('uncertain stage after a 502 whose body echoes the diff: uncertain, and the reason is the host title only', async () => {
    const r = await scmRig()
    r.on('stage', () => {
      throw echoing(502, 'bad_gateway')
    })
    const { answer } = await r.perform('scmStage', { paths: ['.env'] })
    expect(answer).toMatchObject({
      outcome: 'uncertain',
      reason: 'Request failed',
    })
    expectNoLeak(answer)
  })

  test('a diff that holds a secret is delivered to the panel and not to the log', async () => {
    const r = await scmRig()
    r.on('diff', () => ({ diff: `+${CONTENT}`, hunks: [] }))
    const { answer } = await r.perform('scmDiff', {
      path: '.env',
      staged: false,
    })
    expect(answer).toMatchObject({
      outcome: 'accepted',
      value: { type: 'scmDiff' },
    })
    expect(JSON.stringify(answer)).toContain(KEY)
    expectNoLeak()
  })
})

// ----------------------------------------------------------------- terminal

async function openedTerminal() {
  const r = rig()
  r.handlers.open = () => SUPPORTED_OPEN_REPLY
  r.handlers.attach = () => SUPPORTED_ATTACH_REPLY
  const opened = await r.session.open({
    profile: profileById('Herdr shell'),
    cols: 80,
    rows: 24,
  })
  expect(opened.outcome).toBe('accepted')
  return r
}

describe('terminal input that carries a secret', () => {
  test('accepted: the outcome names the terminal and the binding epoch and not the input', async () => {
    const r = await openedTerminal()
    r.handlers.input = () => ({ accepted: true })
    const done = await r.session.input(CONTENT, 'human', { inputId: 'in-1' })
    expect(done).toMatchObject({
      outcome: 'accepted',
      terminalId: 'hc-fixture-1',
      bindingEpoch: 1,
      value: { inputId: 'in-1', duplicate: false, discarded: false },
    })
    expect(r.of('input')[0]!.request).toMatchObject({
      bytes: CONTENT,
      input_id: 'in-1',
    })
    expectNoLeak(done)
  })

  test('refused: a stale claim is a typed refusal with the terminal and epoch it was against, without the echoed input', async () => {
    const r = await openedTerminal()
    r.handlers.input = () => {
      throw new TheoremError({
        statusCode: 409,
        body: {
          code: 'terminal_control_refused',
          reason: 'stale_epoch',
          echo: CONTENT,
        },
      })
    }
    const done = await r.session.input(CONTENT, 'human', { inputId: 'in-2' })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'terminal_control_refused',
      reason: 'stale_epoch',
      terminalId: 'hc-fixture-1',
      bindingEpoch: 1,
    })
    expectNoLeak(done)
  })

  test('uncertain: a timeout is uncertain with the terminal and epoch, never accepted, and a repeat of the id resends the one original input', async () => {
    const r = await openedTerminal()
    let attempt = 0
    r.handlers.input = () => {
      attempt += 1
      if (attempt === 1) throw new TheoremTimeoutError('Timeout exceeded')
      return { accepted: true, duplicate: true }
    }
    const first = await r.session.input(CONTENT, 'human', { inputId: 'in-3' })
    expect(first).toMatchObject({
      outcome: 'uncertain',
      terminalId: 'hc-fixture-1',
      bindingEpoch: 1,
    })
    expect(first.outcome).not.toBe('accepted')
    expectNoLeak(first)
    const again = await r.session.input('something else', 'human', {
      inputId: 'in-3',
    })
    expect(again).toMatchObject({
      outcome: 'accepted',
      value: { inputId: 'in-3', duplicate: true },
    })
    expect(r.of('input').map((call) => call.request.bytes)).toEqual([
      CONTENT,
      CONTENT,
    ])
    expect(r.of('input').map((call) => call.request.input_id)).toEqual([
      'in-3',
      'in-3',
    ])
  })

  test('failed: a host error that echoes the input is a readable reason without it', async () => {
    const r = await openedTerminal()
    r.handlers.input = () => {
      throw echoing(500, 'host_operation_failed')
    }
    const done = await r.session.input(CONTENT, 'human', { inputId: 'in-4' })
    expect(done).toMatchObject({
      outcome: 'failed',
      reason: 'Request failed',
      terminalId: 'hc-fixture-1',
      bindingEpoch: 1,
    })
    expectNoLeak(done)
  })

  test('paste with a secret: an uncertain paste is uncertain', async () => {
    const r = await openedTerminal()
    r.handlers.paste = () => {
      throw new TypeError('network error while sending')
    }
    const done = await r.session.paste(CONTENT)
    expect(done).toMatchObject({
      outcome: 'uncertain',
      terminalId: 'hc-fixture-1',
      bindingEpoch: 1,
    })
    expectNoLeak(done)
  })
})
