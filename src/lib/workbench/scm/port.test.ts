// SOURCING: none — bun:test over ./port, with the real scm owner on the environment's test host
import { describe, expect, test } from 'bun:test'
import {
  FakeLive,
  op,
  stubHost,
  testEnvironment,
} from '../environment/test-host'
import type { Effect } from '../wire'
import { createScmPort } from './port'
import { createScm } from './scm'

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

async function setup() {
  const host = stubHost(METHODS.map((name) => op(`scm.${name}`)))
  const calls: { name: string; request: Record<string, unknown> }[] = []
  const handlers = new Map<
    string,
    (request: Record<string, unknown>) => unknown
  >()
  const scm: Record<string, unknown> = {}
  for (const name of METHODS) {
    scm[name] = async (request: Record<string, unknown>) => {
      calls.push({ name, request })
      return handlers.get(name)?.(request) ?? {}
    }
  }
  host.client = {
    ...host.client,
    ide: { workspace: host.client.ide.workspace, scm },
  } as never
  const { environment } = testEnvironment(host, new FakeLive())
  await environment.settled()
  const port = createScmPort(createScm(environment))
  let id = 0
  const perform = (kind: Effect['kind'], payload?: unknown) =>
    port.perform(
      {
        id: (id += 1),
        resource: { type: 'repository', workspace: 'w1', repository: 'r' },
        kind,
        ...(payload === undefined ? {} : { payload }),
      } as never,
      `req-${id}`,
    )
  return {
    perform,
    calls,
    on: (
      name: string,
      handler: (request: Record<string, unknown>) => unknown,
    ) => void handlers.set(name, handler),
  }
}

describe('status', () => {
  test('one wire row per path: both letters for a path changed on both sides, the conflict flag, the original path', async () => {
    const { perform, on, calls } = await setup()
    on('status', () => ({
      branch: 'main',
      head: 'abc1234',
      changes: [
        { path: 'staged.rs', index: 'M', worktree: ' ', conflict: false },
        { path: 'both.rs', index: 'M', worktree: 'M', conflict: false },
        { path: 'new.rs', index: '?', worktree: '?', conflict: false },
        {
          path: 'moved.rs',
          index: 'R',
          worktree: ' ',
          original_path: 'old.rs',
          conflict: false,
        },
        { path: 'clash.rs', index: 'U', worktree: 'U', conflict: true },
        { path: 'odd.rs', status: 'M', conflict: false },
      ],
    }))
    const done = await perform('scmStatus')
    expect(calls.map((call) => call.name)).toEqual(['status'])
    expect(done).toEqual({
      outcome: 'accepted',
      value: {
        type: 'scm',
        branch: 'main',
        head: 'abc1234',
        changes: [
          { path: 'clash.rs', index: 'U', worktree: 'U', conflict: true },
          { path: 'staged.rs', index: 'M', worktree: ' ', conflict: false },
          { path: 'both.rs', index: 'M', worktree: 'M', conflict: false },
          {
            path: 'moved.rs',
            index: 'R',
            worktree: ' ',
            originalPath: 'old.rs',
            conflict: false,
          },
          { path: 'new.rs', index: '?', worktree: '?', conflict: false },
          { path: 'odd.rs', index: '', worktree: '', conflict: false },
        ],
        state: { head: 'abc1234', branch: 'main' },
      },
    })
  })

  test('a detached head is a null branch and no head is null', async () => {
    const { perform, on } = await setup()
    on('status', () => ({ branch: null, head: '', changes: [] }))
    expect(await perform('scmStatus')).toMatchObject({
      value: { branch: null, head: null, changes: [] },
    })
  })
})

describe('reads', () => {
  test('diff and show carry the host text, the parsed hunks and the state', async () => {
    const { perform, on, calls } = await setup()
    on('diff', () => ({
      diff: 'd',
      staged: true,
      hunks: [
        {
          path: 'a',
          old_start: 1,
          old_count: 1,
          new_start: 1,
          new_count: 2,
          header: 'h',
          patch: 'p',
        },
      ],
    }))
    expect(await perform('scmDiff', { path: 'a', staged: true })).toEqual({
      outcome: 'accepted',
      value: {
        type: 'scmDiff',
        path: 'a',
        staged: true,
        text: 'd',
        hunks: [
          {
            path: 'a',
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 2,
            header: 'h',
            patch: 'p',
          },
        ],
      },
    })
    expect(calls[0]?.request).toMatchObject({
      body: { path: 'a', staged: true },
    })
    on('show', () => ({ exists: true, text: 'was' }))
    expect(
      await perform('scmShow', { path: 'a', reference: 'head' }),
    ).toMatchObject({
      outcome: 'accepted',
      value: { type: 'scmShow', path: 'a', exists: true, text: 'was' },
    })
  })

  test('log keeps the commits; blame is camelCase with the timestamp as text', async () => {
    const { perform, on } = await setup()
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
    expect(await perform('scmLog', { path: 'a', maxCount: 5 })).toEqual({
      outcome: 'accepted',
      value: {
        type: 'scmLog',
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
    on('blame', () => ({
      hunks: [
        {
          author: 'Ada',
          commit: 'c1',
          line_count: 2,
          start_line: 3,
          summary: 's',
          timestamp: 1700000000,
        },
      ],
    }))
    expect(await perform('scmBlame', { path: 'a' })).toEqual({
      outcome: 'accepted',
      value: {
        type: 'scmBlame',
        path: 'a',
        hunks: [
          {
            author: 'Ada',
            commit: 'c1',
            startLine: 3,
            lineCount: 2,
            summary: 's',
            timestamp: '1700000000',
          },
        ],
      },
    })
  })
})

describe('writes', () => {
  test('stage, unstage, restore, commit, fetch and push each make one owner call and carry the repository state when the host reports it', async () => {
    const { perform, on, calls } = await setup()
    on('stage', () => ({ head: 'h1', branch: 'main' }))
    expect(await perform('scmStage', { paths: ['a'] })).toEqual({
      outcome: 'accepted',
      value: { type: 'scmState', head: 'h1', branch: 'main' },
    })
    expect(await perform('scmUnstage', { paths: ['a'] })).toEqual({
      outcome: 'accepted',
    })
    await perform('scmRestore', { restoreId: 'rid' })
    await perform('scmCommit', { message: 'feat: x' })
    await perform('scmFetch', {})
    await perform('scmPush', { remote: 'up', reference: 'main' })
    expect(calls.map((call) => call.name)).toEqual([
      'stage',
      'unstage',
      'restore',
      'commit',
      'fetch',
      'push',
    ])
    expect(calls[5]?.request).toMatchObject({
      body: { remote: 'up', ref: 'main' },
    })
  })

  test('discard returns the restore id; it is the only effect that discards', async () => {
    const { perform, on, calls } = await setup()
    on('discard', () => ({ restore_id: 'rid-1' }))
    expect(await perform('scmDiscard', { path: 'a.rs' })).toEqual({
      outcome: 'accepted',
      value: { type: 'scmDiscarded', path: 'a.rs', restoreId: 'rid-1' },
    })
    await perform('scmStage', { paths: ['a'] })
    expect(calls.filter((call) => call.name === 'discard')).toHaveLength(1)
  })

  test('branch creates or switches by the flag', async () => {
    const { perform, calls } = await setup()
    await perform('scmBranch', { name: 'dev', create: false })
    await perform('scmBranch', { name: 'feat', create: true })
    expect(calls.map((call) => call.request.body)).toEqual([
      { name: 'dev', create: false },
      { name: 'feat', create: true },
    ])
  })

  test('a merge conflict is an accepted answer with merged false', async () => {
    const { perform, on } = await setup()
    on('merge', () => ({ state: 'conflict', conflicts: ['a.rs'] }))
    expect(await perform('scmMerge', { branch: 'dev' })).toEqual({
      outcome: 'accepted',
      value: { type: 'scmMerged', merged: false },
    })
  })
})

describe('outcomes', () => {
  test("the owner's refusals pass through with their code, and a path outside the workspace is not sent", async () => {
    const { perform, calls } = await setup()
    expect(await perform('scmStage', { paths: ['../x'] })).toMatchObject({
      outcome: 'refused',
      code: 'outside_workspace',
    })
    expect(await perform('scmCommit', { message: ' ' })).toMatchObject({
      outcome: 'refused',
      code: 'empty_message',
    })
    expect(calls).toEqual([])
  })
})
