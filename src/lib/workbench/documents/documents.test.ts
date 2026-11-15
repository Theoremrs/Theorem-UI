// SOURCING: none — bun:test over ./documents with a stub client and the fake live stream in ../environment/test-host
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  HttpError,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import type { Revision } from '../wire/Revision'
import { createDocuments } from './documents'
import type { DocumentEvent } from './documents'

const ALL = [
  op('documents.open'),
  op('documents.edit'),
  op('documents.save'),
  op('documents.close'),
  op('documents.reconcile'),
]

const seq = (value: number): Revision => ({ scheme: 'seq', value })

interface Call {
  name: string
  request: Record<string, unknown>
}

/** A host whose documentSessions answer from `handlers`; the head starts at revision 1 with `text`. */
async function setup(operations = ALL, text = 'hello') {
  const host = stubHost(operations)
  const calls: Call[] = []
  const state = { revision: 1, text, disk: true }
  const handlers = new Map<
    string,
    (request: Record<string, unknown>) => unknown
  >()
  const method =
    (name: string, fallback: (request: Record<string, unknown>) => unknown) =>
    async (request: Record<string, unknown>) => {
      calls.push({ name, request })
      const handler = handlers.get(name)
      return handler ? handler(request) : fallback(request)
    }
  const head = () => ({
    document_id: 'd1',
    revision: state.revision,
    content_hash: 'c',
    disk_hash: state.disk ? 'c' : 'other',
    text: state.text,
  })
  const documentSessions = {
    open: method('open', head),
    head: method('head', head),
    edit: method('edit', (request) => {
      state.revision = (request.base_revision as number) + 1
      return head()
    }),
    save: method('save', () => ({})),
    close: method('close', () => ({})),
    reconcile: method('reconcile', () => ({})),
  }
  host.client = { ...host.client, documentSessions } as never
  const live = new FakeLive()
  const { environment } = testEnvironment(host, live)
  await environment.settled()
  const documents = createDocuments(environment)
  const count = (name: string) =>
    calls.filter((call) => call.name === name).length
  const on = (
    name: string,
    handler: (request: Record<string, unknown>) => unknown,
  ) => void handlers.set(name, handler)
  const open = async (path = 'a.txt') => {
    const done = await documents.open({ requestId: `open-${path}`, path })
    if (done.outcome !== 'accepted') throw new Error(`open ${done.outcome}`)
    return done.value
  }
  const record = (
    revision: number,
    edits: { start: number; end: number; insert: string; removed: string }[],
    extra = {},
  ) => ({
    document_id: 'd1',
    resource_id: 'a.txt',
    revision,
    operation_id: `remote-${revision}`,
    actor: 'someone',
    edits,
    ...extra,
  })
  return {
    host,
    live,
    documents,
    calls,
    count,
    on,
    open,
    state,
    record,
    environment,
  }
}

describe('open', () => {
  test('returns text, revision and the saved state', async () => {
    const { open } = await setup()
    const doc = await open()
    expect(doc.state.text).toBe('hello')
    expect(doc.state.revision).toEqual(seq(1))
    expect(doc.state.savedRevision).toEqual(seq(1))
    expect(doc.state.dirty).toBe(false)
  })

  test('a document the checkout lacks is dirty from the start', async () => {
    const { open, state } = await setup()
    state.disk = false
    const doc = await open()
    expect(doc.state.dirty).toBe(true)
    expect(doc.state.savedRevision).toBeUndefined()
  })

  test('refuses a path outside the workspace without a request', async () => {
    const { documents, count } = await setup()
    const done = await documents.open({ requestId: 'r', path: '../x' })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'outside_workspace',
    })
    expect(count('open')).toBe(0)
  })

  test('a binary document is refused and its host session closed', async () => {
    const { documents, on, count } = await setup()
    on('open', () => ({
      document_id: 'd1',
      revision: 1,
      binary: true,
      text: '',
    }))
    const done = await documents.open({ requestId: 'r', path: 'b.png' })
    expect(done).toMatchObject({ outcome: 'refused', code: 'binary_file' })
    await Promise.resolve()
    expect(count('close')).toBe(1)
  })

  test('an operation the host lists as unavailable is refused without a request', async () => {
    const { documents, count } = await setup([
      op('documents.open', { ready: false, reason: 'warming up' }),
    ])
    const done = await documents.open({ requestId: 'r', path: 'a.txt' })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
    })
    expect(count('open')).toBe(0)
  })
})

describe('reference counting', () => {
  test('two panes share one host session and it closes once, when the last releases', async () => {
    const { open, count, live } = await setup()
    const first = await open()
    const second = await open()
    expect(count('open')).toBe(1)
    expect(live.listenerCount('document.changed')).toBe(1)

    expect(await first.close({ requestId: 'c1' })).toMatchObject({
      outcome: 'accepted',
    })
    expect(count('close')).toBe(0)
    // Releasing the same holder again does nothing.
    await first.close({ requestId: 'c1b' })
    expect(count('close')).toBe(0)

    expect(await second.close({ requestId: 'c2' })).toMatchObject({
      outcome: 'accepted',
    })
    expect(count('close')).toBe(1)
    expect(live.listenerCount('document.changed')).toBe(0)
  })

  test('concurrent opens of one path make one host request', async () => {
    const { documents, count } = await setup()
    const [one, two] = await Promise.all([
      documents.open({ requestId: 'a', path: 'a.txt' }),
      documents.open({ requestId: 'b', path: 'a.txt' }),
    ])
    expect(one.outcome).toBe('accepted')
    expect(two.outcome).toBe('accepted')
    expect(count('open')).toBe(1)
  })

  test('a closed holder is refused, and a reopen after the last close seats again', async () => {
    const { open, count } = await setup()
    const doc = await open()
    await doc.close({ requestId: 'c' })
    expect(
      await doc.edit({
        requestId: 'e',
        operationId: 'o',
        baseRevision: seq(1),
        edits: [{ start: 0, end: 0, insert: 'x' }],
      }),
    ).toMatchObject({ outcome: 'refused', code: 'closed' })
    await open()
    expect(count('open')).toBe(2)
  })
})

describe('edit', () => {
  test('applies explicit UTF-16 ranges at the base revision and returns the new one', async () => {
    const { open, calls } = await setup(ALL, 'a😀b')
    const doc = await open()
    // UTF-16: 'a' is 0..1, the emoji 1..3, 'b' 3..4. The host counts scalars: 1..2.
    const done = await doc.edit({
      requestId: 'r1',
      operationId: 'op1',
      baseRevision: seq(1),
      edits: [{ start: 1, end: 3, insert: 'X' }],
    })
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { revision: seq(2) },
    })
    expect(doc.state.text).toBe('aXb')
    expect(doc.state.revision).toEqual(seq(2))
    expect(doc.state.dirty).toBe(true)
    const sent = calls.find((call) => call.name === 'edit')!.request
    expect(sent).toMatchObject({
      operation_id: 'op1',
      base_revision: 1,
      'Idempotency-Key': 'op1',
      edits: [{ start: 1, end: 2, insert: 'X' }],
    })
  })

  test('a range that splits a character or leaves the text is refused without a request', async () => {
    const { open, count } = await setup(ALL, 'a😀b')
    const doc = await open()
    const split = await doc.edit({
      requestId: 'r',
      operationId: 'o1',
      baseRevision: seq(1),
      edits: [{ start: 2, end: 2, insert: 'x' }],
    })
    const outside = await doc.edit({
      requestId: 'r',
      operationId: 'o2',
      baseRevision: seq(1),
      edits: [{ start: 0, end: 99, insert: '' }],
    })
    const overlap = await doc.edit({
      requestId: 'r',
      operationId: 'o3',
      baseRevision: seq(1),
      edits: [
        { start: 0, end: 2, insert: '' },
        { start: 1, end: 3, insert: '' },
      ],
    })
    for (const done of [split, outside, overlap])
      expect(done).toMatchObject({ outcome: 'refused', code: 'invalid_range' })
    expect(count('edit')).toBe(0)
  })

  test('an opaque base revision is refused', async () => {
    const { open } = await setup()
    const doc = await open()
    const done = await doc.edit({
      requestId: 'r',
      operationId: 'o',
      baseRevision: { scheme: 'opaque', value: 'etag' },
      edits: [{ start: 0, end: 0, insert: 'x' }],
    })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'unsupported_revision',
    })
  })

  test('CONFLICT: an edit against an old revision is refused with the current revision, never sent, and its text is kept', async () => {
    const { open, live, record, count } = await setup()
    const doc = await open()
    // Another writer commits revision 2 before the caller's edit (based on 1) arrives.
    live.emit(
      'document.changed',
      record(2, [{ start: 5, end: 5, insert: '!', removed: '' }]),
    )
    expect(doc.state.revision).toEqual(seq(2))

    const done = await doc.edit({
      requestId: 'r',
      operationId: 'typed-1',
      baseRevision: seq(1),
      edits: [{ start: 0, end: 0, insert: 'typed ' }],
    })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'conflict',
      baseRevision: seq(1),
      current: { revision: seq(2), text: 'hello!' },
    })
    expect(count('edit')).toBe(0)
    expect(doc.state.text).toBe('hello!')
    // Nothing typed is lost: the caller's ranges are held, with the revision they were made on.
    expect(doc.state.pending).toEqual([
      {
        operationId: 'typed-1',
        baseRevision: seq(1),
        edits: [{ start: 0, end: 0, insert: 'typed ' }],
        state: 'conflicted',
        reason: expect.any(String),
      },
    ])
    expect(doc.state.dirty).toBe(true)

    // The caller rebases and resends on the current revision; the held edit is then settled.
    const again = await doc.edit({
      requestId: 'r2',
      operationId: 'typed-2',
      baseRevision: seq(2),
      edits: [{ start: 0, end: 0, insert: 'typed ' }],
    })
    expect(again).toMatchObject({
      outcome: 'accepted',
      value: { revision: seq(3) },
    })
    expect(doc.state.pending.map((edit) => edit.operationId)).toEqual([
      'typed-1',
    ])
    doc.settle('typed-1')
    expect(doc.state.pending).toEqual([])
    expect(doc.state.text).toBe('typed hello!')
  })

  test('CONFLICT: a stale refusal from the host re-reads the head, returns it, and keeps the edit', async () => {
    const { open, on, state, calls, live } = await setup()
    const doc = await open()
    const events: DocumentEvent[] = []
    doc.on((event) => events.push(event))
    // The stream missed revision 2; the host knows.
    on('edit', () => {
      state.revision = 2
      state.text = 'hello world'
      throw new HttpError(409, { code: 'stale_revision' })
    })
    const done = await doc.edit({
      requestId: 'r',
      operationId: 'typed',
      baseRevision: seq(1),
      edits: [{ start: 0, end: 0, insert: 'oh ' }],
    })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'conflict',
      current: { revision: seq(2), text: 'hello world' },
    })
    expect(calls.filter((call) => call.name === 'edit')).toHaveLength(1)
    expect(doc.state.pending[0]).toMatchObject({
      operationId: 'typed',
      state: 'conflicted',
    })
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'resync', text: 'hello world' }),
    )
    void live
  })

  test('a lost answer is uncertain, kept, not resent, and a live event for it settles it', async () => {
    const { open, on, count, live, record } = await setup()
    const doc = await open()
    const events: DocumentEvent[] = []
    doc.on((event) => events.push(event))
    on('edit', () => {
      throw new Error('socket closed')
    })
    const done = await doc.edit({
      requestId: 'r',
      operationId: 'lost',
      baseRevision: seq(1),
      edits: [{ start: 0, end: 0, insert: 'x' }],
    })
    expect(done.outcome).toBe('uncertain')
    expect(count('edit')).toBe(1)
    expect(doc.state.pending[0]).toMatchObject({
      operationId: 'lost',
      state: 'uncertain',
    })

    // The host had applied it after all: the stream says so, under the same operation id.
    live.emit(
      'document.changed',
      record(2, [{ start: 0, end: 0, insert: 'x', removed: '' }], {
        operation_id: 'lost',
      }),
    )
    expect(doc.state.pending).toEqual([])
    expect(doc.state.text).toBe('xhello')
    expect(events).toContainEqual({
      kind: 'acknowledged',
      resource: doc.resource,
      revision: seq(2),
      operationId: 'lost',
    })
    expect(count('edit')).toBe(1)
  })

  test('the stream acknowledging an edit before its answer does not apply it twice', async () => {
    const { open, on, live, record } = await setup()
    const doc = await open()
    on('edit', (request) => {
      live.emit(
        'document.changed',
        record(2, [{ start: 0, end: 0, insert: 'x', removed: '' }], {
          operation_id: request.operation_id,
        }),
      )
      return { document_id: 'd1', revision: 2, text: 'xhello' }
    })
    const done = await doc.edit({
      requestId: 'r',
      operationId: 'op',
      baseRevision: seq(1),
      edits: [{ start: 0, end: 0, insert: 'x' }],
    })
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { revision: seq(2) },
    })
    expect(doc.state.text).toBe('xhello')
    expect(doc.state.pending).toEqual([])
  })

  test('another refusal keeps the edit and reports the host code', async () => {
    const { open, on } = await setup()
    const doc = await open()
    on('edit', () => {
      throw new HttpError(422, { code: 'read_only' })
    })
    const done = await doc.edit({
      requestId: 'r',
      operationId: 'o',
      baseRevision: seq(1),
      edits: [{ start: 0, end: 0, insert: 'x' }],
    })
    expect(done).toMatchObject({ outcome: 'refused', code: 'read_only' })
    expect(doc.state.pending[0]).toMatchObject({
      operationId: 'o',
      state: 'refused',
    })
  })

  test('edits are sent one after another, each checked against the revision it meets', async () => {
    const { open } = await setup()
    const doc = await open()
    const [a, b] = await Promise.all([
      doc.edit({
        requestId: 'a',
        operationId: 'oa',
        baseRevision: seq(1),
        edits: [{ start: 0, end: 0, insert: 'A' }],
      }),
      doc.edit({
        requestId: 'b',
        operationId: 'ob',
        baseRevision: seq(1),
        edits: [{ start: 0, end: 0, insert: 'B' }],
      }),
    ])
    expect(a.outcome).toBe('accepted')
    expect(b).toMatchObject({
      outcome: 'refused',
      code: 'conflict',
      current: { revision: seq(2) },
    })
    expect(doc.state.text).toBe('Ahello')
  })
})

describe('save', () => {
  test('saves the authority revision and reports it saved', async () => {
    const { open, calls } = await setup()
    const doc = await open()
    await doc.edit({
      requestId: 'e',
      operationId: 'o',
      baseRevision: seq(1),
      edits: [{ start: 0, end: 0, insert: 'x' }],
    })
    expect(doc.state.dirty).toBe(true)
    const done = await doc.save({ requestId: 's' })
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { revision: seq(2) },
    })
    expect(calls.find((call) => call.name === 'save')!.request).toMatchObject({
      body: { resource_id: 'a.txt', revision: 2 },
    })
    expect(doc.state.dirty).toBe(false)
    expect(doc.state.savedRevision).toEqual(seq(2))
  })

  test('a lost save answer is uncertain, is not repeated, and the document stays dirty', async () => {
    const { open, on, count } = await setup()
    const doc = await open()
    on('save', () => {
      throw new Error('connection reset')
    })
    const done = await doc.save({ requestId: 's' })
    expect(done.outcome).toBe('uncertain')
    expect(count('save')).toBe(1)
    expect(doc.state.saveUncertain).toBe(true)
    expect(doc.state.dirty).toBe(true)
    // Nothing retried it behind the caller's back.
    await Promise.resolve()
    expect(count('save')).toBe(1)
  })

  test('the host reporting the revision saved clears the uncertainty', async () => {
    const { open, on, live } = await setup()
    const doc = await open()
    on('save', () => {
      throw new Error('connection reset')
    })
    await doc.save({ requestId: 's' })
    live.emit('document.saved', {
      document_id: 'd1',
      resource_id: 'a.txt',
      revision: 1,
    })
    expect(doc.state.saveUncertain).toBe(false)
    expect(doc.state.dirty).toBe(false)
  })

  test('a refused save is refused, not uncertain', async () => {
    const { open, on } = await setup()
    const doc = await open()
    on('save', () => {
      throw new HttpError(409, { code: 'disk_changed' })
    })
    expect(await doc.save({ requestId: 's' })).toMatchObject({
      outcome: 'refused',
      code: 'disk_changed',
    })
    expect(doc.state.saveUncertain).toBe(false)
  })
})

describe('revert and reconcile', () => {
  test('revert keeps the disk, re-reads the head, announces it and discards pending edits', async () => {
    const { open, on, state } = await setup()
    const doc = await open()
    const events: DocumentEvent[] = []
    doc.on((event) => events.push(event))
    await doc.edit({
      requestId: 'e',
      operationId: 'o',
      baseRevision: seq(1),
      edits: [{ start: 0, end: 0, insert: 'x' }],
    })
    const seen: unknown[] = []
    on('reconcile', (request) => {
      seen.push(request.body)
      state.revision = 3
      state.text = 'hello'
      state.disk = true
      return {}
    })
    const done = await doc.revert({ requestId: 'v' })
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { revision: seq(3), text: 'hello' },
    })
    expect(seen).toEqual([
      { resource_id: 'a.txt', keep: 'disk', expected_revision: 2 },
    ])
    expect(events).toContainEqual(
      expect.objectContaining({ kind: 'resync', text: 'hello' }),
    )
    expect(doc.state.dirty).toBe(false)
  })
})

describe('remote changes', () => {
  test('arrive with revision and UTF-16 ranges against the text before them', async () => {
    const { open, live, record } = await setup(ALL, 'a😀b')
    const doc = await open()
    const events: DocumentEvent[] = []
    doc.on((event) => events.push(event))
    // Scalars: replace the emoji (1..2) with 'XY'.
    live.emit(
      'document.changed',
      record(2, [{ start: 1, end: 2, insert: 'XY', removed: '😀' }]),
    )
    expect(events).toEqual([
      {
        kind: 'changed',
        resource: doc.resource,
        revision: seq(2),
        actor: 'someone',
        operationId: 'remote-2',
        unit: 'utf16',
        edits: [{ start: 1, end: 3, insert: 'XY' }],
      },
    ])
    expect(doc.state.text).toBe('aXYb')
  })

  test('a replayed or older revision is ignored', async () => {
    const { open, live, record } = await setup()
    const doc = await open()
    const events: DocumentEvent[] = []
    doc.on((event) => events.push(event))
    const change = record(2, [{ start: 0, end: 0, insert: '>', removed: '' }])
    live.emit('document.changed', change)
    live.emit('document.changed', change)
    live.emit('document.changed', record(1, []))
    expect(events).toHaveLength(1)
    expect(doc.state.text).toBe('>hello')
  })

  test('another document is not this one', async () => {
    const { open, live, record } = await setup()
    const doc = await open()
    live.emit('document.changed', record(2, [], { document_id: 'other' }))
    expect(doc.state.revision).toEqual(seq(1))
  })

  test('GAP: a skipped revision produces a resync with the full text and revision', async () => {
    const { open, live, record, on } = await setup()
    const doc = await open()
    const events: DocumentEvent[] = []
    doc.on((event) => events.push(event))
    on('head', () => ({
      document_id: 'd1',
      revision: 4,
      content_hash: 'c',
      text: 'hello, world',
    }))
    // Revisions 2 and 3 never arrived.
    live.emit(
      'document.changed',
      record(4, [{ start: 5, end: 5, insert: ', world', removed: '' }]),
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual([
      {
        kind: 'resync',
        resource: doc.resource,
        revision: seq(4),
        text: 'hello, world',
      },
    ])
    expect(doc.state.revision).toEqual(seq(4))
    expect(doc.state.text).toBe('hello, world')
  })

  test('a reconnect re-reads the head and resyncs only if it differs', async () => {
    const { open, live, on, state } = await setup()
    const doc = await open()
    const events: DocumentEvent[] = []
    doc.on((event) => events.push(event))
    void on
    // First connection, then a gap and a return with nothing missed.
    live.state('open')
    live.state('reconnecting')
    live.state('open')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual([])
    // A second gap in which the document moved on.
    state.revision = 5
    state.text = 'elsewhere'
    live.state('reconnecting')
    live.state('open')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual([
      {
        kind: 'resync',
        resource: doc.resource,
        revision: seq(5),
        text: 'elsewhere',
      },
    ])
  })

  test('saved, conflict, moved and retired reach the holders', async () => {
    const { open, live } = await setup()
    const doc = await open()
    const events: DocumentEvent[] = []
    doc.on((event) => events.push(event))
    live.emit('document.conflict', {
      document_id: 'd1',
      resource_id: 'a.txt',
      revision: 1,
      content_hash: 'c',
      disk_hash: null,
      disk_deleted: true,
      resolve_with: 'documents.reconcile',
    })
    live.emit('document.moved', {
      document_id: 'd1',
      resource_id: 'b.txt',
      path_generation: 2,
    })
    expect(doc.path).toBe('b.txt')
    live.emit('document.retired', { document_id: 'd1', resource_id: 'b.txt' })
    expect(events.map((event) => event.kind)).toEqual([
      'conflict',
      'moved',
      'retired',
    ])
    expect(
      await doc.edit({
        requestId: 'r',
        operationId: 'o',
        baseRevision: seq(1),
        edits: [{ start: 0, end: 0, insert: 'x' }],
      }),
    ).toMatchObject({ outcome: 'refused', code: 'retired' })
  })

  test('a listener that was removed hears nothing', async () => {
    const { open, live, record } = await setup()
    const doc = await open()
    const events: DocumentEvent[] = []
    const off = doc.on((event) => events.push(event))
    off()
    live.emit(
      'document.changed',
      record(2, [{ start: 0, end: 0, insert: '>', removed: '' }]),
    )
    expect(events).toEqual([])
  })
})
