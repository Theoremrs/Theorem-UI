// SOURCING: none — bun:test over the SCM owner (through its port) and the documents owner on one environment; AC-20 (R18) owner half
import { describe, expect, test } from 'bun:test'
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
import { createScmPort } from './scm/port'
import { createScm } from './scm/scm'
import type { Effect } from './wire'

const DRAFT = 'UNSAVED-DRAFT-TEXT-4410'

async function rig() {
  const host = stubHost(
    [
      'scm.stage',
      'scm.commit',
      'scm.status',
      'documents.open',
      'documents.edit',
      'documents.save',
      'documents.close',
      'documents.reconcile',
    ].map((n) => op(n)),
  )
  const scmCalls: { name: string; request: Record<string, unknown> }[] = []
  const docCalls: string[] = []
  const stateOf = { revision: 1, text: 'saved text' }
  const head = () => ({
    document_id: 'd1',
    revision: stateOf.revision,
    content_hash: 'c',
    disk_hash: 'c',
    text: stateOf.text,
  })
  const scm: Record<string, unknown> = {}
  let stageAnswer: unknown = {}
  for (const name of ['stage', 'commit', 'status'])
    scm[name] = async (request: Record<string, unknown>) => {
      scmCalls.push({ name, request })
      return name === 'commit'
        ? { repository: 'repo', message: 'm', state: 'committed', output: 'ok' }
        : name === 'stage'
          ? stageAnswer
          : {}
    }
  host.client = {
    ...host.client,
    documentSessions: {
      open: async () => (docCalls.push('open'), head()),
      head: async () => head(),
      edit: async (r: Record<string, unknown>) => (
        docCalls.push('edit'),
        (stateOf.revision = (r.base_revision as number) + 1),
        (stateOf.text += DRAFT),
        head()
      ),
      save: async () => (docCalls.push('save'), {}),
      close: async () => (docCalls.push('close'), {}),
      reconcile: async () => ({}),
    },
    ide: { workspace: host.client.ide.workspace, scm },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const documents = createDocuments(environment)
  const docs = createDocumentsPort({
    documents,
    files: {
      create: async (r) =>
        accepted(
          { workspaceId: 'w1', requestId: r.requestId },
          { path: r.path },
        ),
      delete: async (r) =>
        accepted(
          { workspaceId: 'w1', requestId: r.requestId },
          { path: r.path },
        ),
    },
  })
  const port = createScmPort(createScm(environment))
  const resource = {
    type: 'repository' as const,
    workspace: 'w1',
    repository: 'repo',
  }
  let id = 0
  const effect = (kind: string, payload: unknown) =>
    ({ id: (id += 1), resource, kind, payload }) as unknown as Effect
  // A document holding an unsaved edit: the draft exists in the document owner only.
  const docResource = {
    type: 'document' as const,
    workspace: 'w1',
    resourceId: 'a.txt',
  }
  await docs.perform(
    {
      id: 900,
      resource: docResource,
      kind: 'documentOpen',
      payload: {},
    } as never,
    'o',
  )
  await docs.perform(
    {
      id: 901,
      resource: docResource,
      kind: 'documentEdit',
      revision: { scheme: 'seq', value: 1 },
      payload: {
        operationId: 'op',
        unit: 'utf16',
        edits: [{ start: 0, end: 0, insert: DRAFT }],
      },
    } as never,
    'e',
  )
  return {
    setStageAnswer: (v: unknown) => void (stageAnswer = v),
    port,
    effect,
    scmCalls,
    docCalls,
    resource,
  }
}

describe('stage and commit act on what the host has saved', () => {
  test('a stage request carries the paths only, even when the effect also carries draft text', async () => {
    const r = await rig()
    const e = r.effect('scmStage', {
      paths: ['a.txt'],
      text: DRAFT,
      draft: DRAFT,
      content: DRAFT,
    })
    const answer = await r.port.perform(e as never, 'req-1')
    expect(answer.outcome).toBe('accepted')
    const sent = r.scmCalls.find((c) => c.name === 'stage')!
    expect(JSON.stringify(sent.request)).not.toContain(DRAFT)
    expect(sent.request).toMatchObject({ body: { paths: ['a.txt'] } })
    expect(Object.keys((sent.request as { body: object }).body)).toEqual([
      'paths',
    ])
  })

  test('a commit request carries the message only, and the owner never saves or edits a document to make one', async () => {
    const r = await rig()
    const editsBefore = r.docCalls.filter((c) => c === 'edit').length
    const answer = await r.port.perform(
      r.effect('scmCommit', {
        message: 'save it',
        draft: DRAFT,
        text: DRAFT,
      }) as never,
      'req-2',
    )
    expect(answer.outcome).toBe('accepted')
    const sent = r.scmCalls.find((c) => c.name === 'commit')!
    expect(Object.keys((sent.request as { body: object }).body)).toEqual([
      'message',
    ])
    expect(JSON.stringify(sent.request)).not.toContain(DRAFT)
    expect(r.docCalls.filter((c) => c === 'save')).toEqual([])
    expect(r.docCalls.filter((c) => c === 'edit')).toHaveLength(editsBefore)
  })

  test('with no state from the host the outcome names no content of its own, only the effect it answers, and invents no commit id', async () => {
    const r = await rig()
    const stage = r.effect('scmStage', { paths: ['a.txt', 'b.txt'] })
    const staged = await r.port.perform(stage as never, 'req-3')
    // The SDK's stage answer is an untyped result with no paths or index identity; the wire RepoState has no paths field.
    expect(staged).toEqual({ outcome: 'accepted' })
    expect(completionFor(stage as never, staged)).toMatchObject({
      effect: (stage as { id: number }).id,
      resource: r.resource,
      outcome: { status: 'accepted' },
    })
    const commit = r.effect('scmCommit', { message: 'm' })
    const committed = await r.port.perform(commit as never, 'req-4')
    // The SDK's commit result is {repository, message, state, output}: no oid, so none is invented.
    expect(committed).toEqual({ outcome: 'accepted' })
  })

  test('when the host does state the head and index generation they are carried as the identity', async () => {
    const r = await rig()
    r.setStageAnswer({ head: 'abc1234', index_generation: 9 })
    const done = await r.port.perform(
      r.effect('scmStage', { paths: ['a.txt'] }) as never,
      'req-5',
    )
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: { type: 'scmState', head: 'abc1234', indexGeneration: '9' },
    })
  })
})
