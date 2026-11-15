// SOURCING: none — bun:test over ./scm with a stub client in the shape of client.ide.scm
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  HttpError,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import type { Environment } from '../environment/environment'
import { createScm } from './scm'
import type { ScmClient } from './scm'

const METHODS = [
  'status',
  'diff',
  'show',
  'branches',
  'stage',
  'unstage',
  'discard',
  'restore',
  'commit',
  'branch',
  'merge',
  'fetch',
  'push',
  'log',
  'blame',
] as const

const ALL = [
  'scm.status',
  'scm.diff',
  'scm.show',
  'scm.branches',
  'scm.stage',
  'scm.unstage',
  'scm.discard',
  'scm.restore',
  'scm.commit',
  'scm.branch',
  'scm.merge',
  'scm.fetch',
  'scm.push',
  'scm.log',
  'scm.blame',
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
  const scm: Record<string, unknown> = {}
  for (const name of METHODS) {
    scm[name] = async (request: Record<string, unknown>, options?: unknown) => {
      calls.push({ name, request, options })
      const handler = handlers.get(name)
      return handler ? handler(request) : {}
    }
  }
  host.client = {
    ...host.client,
    ide: { workspace: (host.client as ScmClient).ide.workspace, scm },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  return {
    scm: createScm(environment as unknown as Environment<ScmClient>),
    calls,
    count: (name: string) => calls.filter((call) => call.name === name).length,
    on: (
      name: string,
      handler: (request: Record<string, unknown>) => unknown,
    ) => void handlers.set(name, handler),
  }
}

describe('status', () => {
  test('groups staged, unstaged, untracked and conflicted paths as workspace resources', async () => {
    const { scm, on } = await setup()
    on('status', () => ({
      branch: 'main',
      head: 'abc1234',
      changes: [
        {
          path: 'staged.rs',
          index: 'M',
          worktree: ' ',
          original_path: null,
          conflict: false,
        },
        {
          path: 'both.rs',
          index: 'M',
          worktree: 'M',
          original_path: null,
          conflict: false,
        },
        {
          path: 'edited.rs',
          index: ' ',
          worktree: 'M',
          original_path: null,
          conflict: false,
        },
        {
          path: 'new.rs',
          index: '?',
          worktree: '?',
          original_path: null,
          conflict: false,
        },
        {
          path: 'moved.rs',
          index: 'R',
          worktree: ' ',
          original_path: 'old.rs',
          conflict: false,
        },
        {
          path: 'clash.rs',
          index: 'U',
          worktree: 'U',
          original_path: null,
          conflict: true,
        },
      ],
    }))
    const done = await scm.status({ requestId: 'r' })
    expect(done.outcome).toBe('accepted')
    if (done.outcome !== 'accepted') return
    const paths = (rows: { path: string }[]) => rows.map((row) => row.path)
    expect(paths(done.value.staged)).toEqual([
      'staged.rs',
      'both.rs',
      'moved.rs',
    ])
    expect(paths(done.value.unstaged)).toEqual(['both.rs', 'edited.rs'])
    expect(paths(done.value.untracked)).toEqual(['new.rs'])
    expect(paths(done.value.conflicted)).toEqual(['clash.rs'])
    expect(done.value.staged[2]).toMatchObject({
      originalPath: 'old.rs',
      resource: { type: 'document', workspace: 'w1', resourceId: 'moved.rs' },
    })
    expect(done.value.branch).toBe('main')
    expect(done.value.state).toEqual({ head: 'abc1234', branch: 'main' })
  })

  test('a row without the two status letters is kept apart, not guessed into a group', async () => {
    const { scm, on } = await setup()
    on('status', () => ({
      branch: null,
      head: '',
      changes: [{ path: 'a', status: 'M', conflict: false }],
    }))
    const done = await scm.status({ requestId: 'r' })
    if (done.outcome !== 'accepted') throw new Error(done.outcome)
    expect(done.value.staged).toEqual([])
    expect(done.value.unstaged).toEqual([])
    expect(done.value.unclassified).toEqual([
      { resource: expect.anything(), path: 'a', status: 'M' },
    ])
  })

  test('the state carries what the host reports and nothing it does not', async () => {
    const { scm, on } = await setup()
    on('status', () => ({
      branch: 'main',
      head: 'abc',
      changes: [],
      index_generation: 7,
      worktree_generation: '9',
    }))
    const done = await scm.status({ requestId: 'r' })
    if (done.outcome !== 'accepted') throw new Error(done.outcome)
    expect(done.value.state).toEqual({
      head: 'abc',
      branch: 'main',
      indexGeneration: '7',
      worktreeGeneration: '9',
    })
    on('diff', () => ({ diff: '', hunks: [] }))
    const diff = await scm.diff({ requestId: 'd', staged: false })
    if (diff.outcome !== 'accepted') throw new Error(diff.outcome)
    // The host sent no state with a diff, so there is none to carry.
    expect(diff.value.state).toBeUndefined()
  })
})

describe('diff', () => {
  test('maps staged and unstaged diffs with the hunks the host parsed', async () => {
    const { scm, on, calls } = await setup()
    on('diff', () => ({
      diff: '@@ -1 +1 @@\n-a\n+b\n',
      hunks: [
        {
          path: 'a.rs',
          old_start: 1,
          old_count: 1,
          new_start: 1,
          new_count: 1,
          header: '@@ -1 +1 @@',
          patch: 'p',
        },
      ],
      staged: true,
    }))
    const done = await scm.diff({ requestId: 'r', path: 'a.rs', staged: true })
    expect(done).toMatchObject({
      outcome: 'accepted',
      value: {
        path: 'a.rs',
        staged: true,
        text: '@@ -1 +1 @@\n-a\n+b\n',
        hunks: [
          {
            path: 'a.rs',
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            patch: 'p',
          },
        ],
      },
    })
    expect(calls[0]?.request).toMatchObject({
      body: { path: 'a.rs', staged: true },
      'Idempotency-Key': 'r',
    })
  })

  test('a commit diff is accepted only when the host names that commit', async () => {
    const { scm, on } = await setup()
    // A host that ignores the argument answers with the working tree.
    on('diff', () => ({ diff: 'working tree', hunks: [], staged: false }))
    expect(
      await scm.diffCommit({ requestId: 'r', commit: 'abc123' }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
    })
    on('diff', () => ({ diff: 'the commit', hunks: [], commit: 'abc123def' }))
    expect(
      await scm.diffCommit({ requestId: 'r2', commit: 'abc123' }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { commit: 'abc123', text: 'the commit' },
    })
  })
})

describe('writes', () => {
  test('stage and unstage send the paths; a path outside the workspace is refused without a request', async () => {
    const { scm, count, calls } = await setup()
    expect(
      await scm.stage({ requestId: 'r', paths: ['a', 'b/c'] }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { paths: ['a', 'b/c'] },
    })
    expect(await scm.unstage({ requestId: 'r2', paths: ['a'] })).toMatchObject({
      outcome: 'accepted',
    })
    expect(calls[0]?.request).toMatchObject({ body: { paths: ['a', 'b/c'] } })
    expect(calls[0]?.options).toEqual({ maxRetries: 0 })
    expect(await scm.stage({ requestId: 'r3', paths: ['../x'] })).toMatchObject(
      {
        outcome: 'refused',
        code: 'outside_workspace',
      },
    )
    expect(await scm.stage({ requestId: 'r4', paths: [] })).toMatchObject({
      outcome: 'refused',
      code: 'no_paths',
    })
    expect(count('stage')).toBe(1)
  })

  test('discard is its own call and returns the restore id; restore sends it back', async () => {
    const { scm, on, calls } = await setup()
    on('discard', () => ({ restore_id: 'rid-1' }))
    expect(await scm.discard({ requestId: 'r', path: 'a.rs' })).toMatchObject({
      outcome: 'accepted',
      value: { path: 'a.rs', restoreId: 'rid-1' },
    })
    expect(
      await scm.restore({ requestId: 'r2', restoreId: 'rid-1' }),
    ).toMatchObject({ outcome: 'accepted' })
    expect(calls.map((call) => call.name)).toEqual(['discard', 'restore'])
    expect(calls[1]?.request).toMatchObject({ body: { restore_id: 'rid-1' } })
  })

  test('a discard whose answer has no restore id is reported uncertain, not done', async () => {
    const { scm } = await setup()
    expect((await scm.discard({ requestId: 'r', path: 'a.rs' })).outcome).toBe(
      'uncertain',
    )
  })

  test('no other call discards: stage, commit, branch, merge and push never send a discard', async () => {
    const { scm, count } = await setup()
    await scm.stage({ requestId: '1', paths: ['a'] })
    await scm.commit({ requestId: '2', message: 'm' })
    await scm.createBranch({ requestId: '3', name: 'b' })
    await scm.merge({ requestId: '4', branch: 'b' })
    await scm.push({ requestId: '5' })
    expect(count('discard')).toBe(0)
    expect(count('restore')).toBe(0)
  })

  test('commit sends the message; an empty one is refused without a request', async () => {
    const { scm, calls, count } = await setup()
    expect(await scm.commit({ requestId: 'r', message: '   ' })).toMatchObject({
      outcome: 'refused',
      code: 'empty_message',
    })
    expect(count('commit')).toBe(0)
    expect(
      await scm.commit({ requestId: 'r2', message: 'feat: x' }),
    ).toMatchObject({ outcome: 'accepted' })
    expect(calls[0]?.request).toMatchObject({ body: { message: 'feat: x' } })
  })

  test('amend is refused unless the host advertises it', async () => {
    const without = await setup()
    expect(
      await without.scm.commit({ requestId: 'r', message: 'm', amend: true }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
    })
    expect(without.count('commit')).toBe(0)
    const advertised = await setup([...ALL, op('scm.commit.amend')])
    expect(
      await advertised.scm.commit({
        requestId: 'r',
        message: 'm',
        amend: true,
      }),
    ).toMatchObject({
      outcome: 'accepted',
    })
    expect(advertised.calls[0]?.request).toMatchObject({
      body: { message: 'm', amend: true },
    })
  })

  test('switch and create send the branch name and the create flag', async () => {
    const { scm, calls } = await setup()
    await scm.switchBranch({ requestId: 'r', name: 'dev' })
    await scm.createBranch({ requestId: 'r2', name: 'feat' })
    expect(calls.map((call) => call.request.body)).toEqual([
      { name: 'dev', create: false },
      { name: 'feat', create: true },
    ])
    expect(
      await scm.switchBranch({ requestId: 'r3', name: ' ' }),
    ).toMatchObject({ outcome: 'refused', code: 'empty_branch' })
  })

  test('merge reports a conflict as an answer, not a failure', async () => {
    const { scm, on } = await setup()
    on('merge', () => ({ state: 'conflict', conflicts: ['a.rs'] }))
    expect(await scm.merge({ requestId: 'r', branch: 'dev' })).toMatchObject({
      outcome: 'accepted',
      value: { merged: false, conflicts: ['a.rs'] },
    })
  })

  test('fetch and push send the remote and ref the caller named, nothing else', async () => {
    const { scm, calls } = await setup()
    await scm.fetch({ requestId: 'r' })
    await scm.fetch({ requestId: 'r2', remote: 'up' })
    await scm.push({ requestId: 'r3', remote: 'up', reference: 'main' })
    expect(calls.map((call) => call.request.body)).toEqual([
      {},
      { remote: 'up' },
      { remote: 'up', ref: 'main' },
    ])
  })
})

describe('reads', () => {
  test('branches', async () => {
    const { scm, on } = await setup()
    on('branches', () => ({
      branches: [
        { name: 'main', remote: false, current: true, upstream: 'origin/main' },
        { name: 'origin/dev', remote: true, current: false, upstream: null },
      ],
    }))
    expect(await scm.branches({ requestId: 'r' })).toMatchObject({
      outcome: 'accepted',
      value: [
        { name: 'main', current: true, upstream: 'origin/main' },
        { name: 'origin/dev', remote: true, upstream: null },
      ],
    })
  })

  test('show maps head and index to the names git uses', async () => {
    const { scm, on, calls } = await setup()
    on('show', (request) => ({
      path: 'a',
      ref: (request.body as { ref: string }).ref,
      exists: true,
      text: 'x',
    }))
    expect(
      await scm.show({ requestId: 'r', path: 'a', reference: 'head' }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { reference: 'HEAD', exists: true, text: 'x' },
    })
    await scm.show({ requestId: 'r2', path: 'a', reference: 'index' })
    expect(calls[1]?.request).toMatchObject({
      body: { path: 'a', ref: 'index' },
    })
  })

  test('log sends max_count and maps commits', async () => {
    const { scm, on, calls } = await setup()
    on('log', () => ({
      commits: [
        {
          commit: 'c1',
          author: 'Ada',
          email: 'a@x',
          timestamp: '100',
          subject: 'first',
        },
      ],
    }))
    expect(
      await scm.log({ requestId: 'r', path: 'a.rs', maxCount: 20 }),
    ).toMatchObject({
      outcome: 'accepted',
      value: {
        commits: [
          {
            commit: 'c1',
            author: 'Ada',
            email: 'a@x',
            timestamp: '100',
            subject: 'first',
          },
        ],
      },
    })
    expect(calls[0]?.request).toMatchObject({
      body: { path: 'a.rs', max_count: 20 },
    })
  })

  test('blame returns the hunks and the line range it was asked for', async () => {
    const { scm, on, calls } = await setup()
    on('blame', () => ({
      hunks: [
        {
          author: 'Ada',
          commit: 'c1',
          line_count: 2,
          start_line: 1,
          summary: 's',
          timestamp: '1',
        },
      ],
    }))
    expect(
      await scm.blame({
        requestId: 'r',
        path: 'a.rs',
        startLine: 1,
        endLine: 2,
      }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { path: 'a.rs', hunks: [{ author: 'Ada', start_line: 1 }] },
    })
    expect(calls[0]?.request).toMatchObject({
      body: { path: 'a.rs', start_line: 1, end_line: 2 },
    })
  })
})

describe('outcomes', () => {
  test('a 4xx is refused with the host code and nothing is retried', async () => {
    const { scm, on, count } = await setup()
    on('commit', () => {
      throw new HttpError(409, { code: 'nothing_to_commit' })
    })
    expect(await scm.commit({ requestId: 'r', message: 'm' })).toMatchObject({
      outcome: 'refused',
      code: 'nothing_to_commit',
    })
    expect(count('commit')).toBe(1)
  })

  test('a write whose answer is lost is uncertain and sent once', async () => {
    const { scm, on, count } = await setup()
    on('push', () => {
      throw new Error('socket closed')
    })
    expect((await scm.push({ requestId: 'r' })).outcome).toBe('uncertain')
    expect(count('push')).toBe(1)
  })

  test('a read whose answer is lost is failed, not uncertain', async () => {
    const { scm, on } = await setup()
    on('status', () => {
      throw new HttpError(502)
    })
    expect((await scm.status({ requestId: 'r' })).outcome).toBe('failed')
  })

  test('every result is tagged with the workspace and the request it answers', async () => {
    const { scm } = await setup()
    expect(await scm.status({ requestId: 'req-9' })).toMatchObject({
      workspaceId: 'w1',
      requestId: 'req-9',
    })
  })
})

describe('capabilities', () => {
  test('an operation the host does not advertise is refused with missing_capability and no request', async () => {
    // The host lists scm.status and others but not the ones the SDK's typed layer never covered.
    const { scm, count } = await setup([op('scm.status'), op('scm.stage')])
    for (const done of [
      await scm.diff({ requestId: '1', staged: false }),
      await scm.log({ requestId: '2', maxCount: 5 }),
      await scm.blame({ requestId: '3', path: 'a' }),
      await scm.merge({ requestId: '4', branch: 'b' }),
      await scm.diffCommit({ requestId: '5', commit: 'abc' }),
    ]) {
      expect(done).toMatchObject({
        outcome: 'refused',
        code: 'missing_capability',
      })
    }
    expect(count('diff') + count('log') + count('blame') + count('merge')).toBe(
      0,
    )
  })

  test('an operation the host lists as not granted is refused without a request', async () => {
    const { scm, count } = await setup([
      op('scm.commit', { granted: false, reason: 'read only' }),
    ])
    const done = await scm.commit({ requestId: 'r', message: 'm' })
    expect(done).toMatchObject({
      outcome: 'refused',
      code: 'missing_capability',
    })
    expect(count('commit')).toBe(0)
  })
})
