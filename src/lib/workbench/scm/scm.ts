// SOURCING: @theoremharness/sdk — each call is the generated client.ide.scm.* operation, sent through
// ../environment with the request id as the idempotency key. The SDK's WorkspaceScm class is not used:
// it freezes one CSRF token at construction, mints its own idempotency key per call (so the workbench's
// request id cannot be the host's), returns bare results with no state revision, and has no diff, log,
// blame, merge or amend. ./blame-hunks is copied from the Theia extension. A diff is read as the
// unified text plus the hunks the host already parses, so jsdiff (installed) is not needed here.

import type {
  Environment,
  HostClient,
  OperationHeaders,
} from '../environment/environment'
import { createRun } from '../environment/run'
import { accepted, refused } from '../environment/result'
import type { Answers, Completion } from '../environment/result'
import type { ResourceRef } from '../wire/ResourceRef'
import type { ScmRef } from '../wire/ScmRef'
import type { BlameHunk } from './blame-hunks'

/** The calls the SCM owner makes of a Theorem client are `HostClient`'s. */
export type ScmClient = HostClient

/**
 * What the host says about the repository when it answers: the state a result
 * was read at, so a late status or diff can be told from the current one
 * (AC-43). Every field is the host's own; nothing is filled in. The current
 * host reports `head` (a short oid) on `scm.status` only, and no index or
 * worktree generation anywhere.
 */
export interface RepoState {
  head?: string
  branch?: string | null
  indexGeneration?: string
  worktreeGeneration?: string
}

/** `state` is absent when the host reported none. */
export interface Stated {
  state?: RepoState
}

export interface ChangeEntry {
  /** The path as a workspace resource, so it opens like any other document. */
  resource: ResourceRef
  path: string
  /** Git's two porcelain letters: the staged side and the unstaged side. */
  index: string
  worktree: string
  originalPath?: string
}

export interface ScmStatusResult extends Stated {
  branch: string | null
  head: string
  /** A path changed on both sides is in `staged` and in `unstaged`. */
  staged: ChangeEntry[]
  unstaged: ChangeEntry[]
  untracked: ChangeEntry[]
  conflicted: ChangeEntry[]
  /** Rows the host sent without the two status letters; kept as sent, not guessed into a group. */
  unclassified: { resource: ResourceRef; path: string; status?: string }[]
}

export interface DiffHunk {
  path: string
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  header: string
  patch: string
}

export interface DiffResult extends Stated {
  path?: string
  staged: boolean
  commit?: string
  /** Unified diff text. */
  text: string
  hunks: DiffHunk[]
}

export interface ShowResult extends Stated {
  path: string
  reference: string
  exists: boolean
  text: string
}

export interface BranchInfo {
  name: string
  remote: boolean
  current: boolean
  upstream: string | null
}

export interface LogEntry {
  commit: string
  author: string
  email?: string
  /** Seconds since the epoch, as the host sends it. */
  timestamp: string
  subject: string
}

interface Request {
  requestId: string
}

export interface Scm {
  status: (request: Request) => Promise<Completion<ScmStatusResult>>
  /** The working tree against the index, or (`staged`) the index against HEAD. */
  diff: (
    request: Request & { path?: string; staged: boolean },
  ) => Promise<Completion<DiffResult>>
  /**
   * One commit's diff. The host's `scm.diff` takes no commit today, so the
   * answer is accepted only when it names the commit asked for; otherwise it
   * is refused as `missing_capability` rather than showing another diff.
   */
  diffCommit: (
    request: Request & { commit: string; path?: string },
  ) => Promise<Completion<DiffResult>>
  /** `head` or `index`, or any git revision the host resolves. */
  show: (
    request: Request & { path: string; reference: ScmRef | string },
  ) => Promise<Completion<ShowResult>>
  stage: (
    request: Request & { paths: string[] },
  ) => Promise<Completion<Stated & { paths: string[] }>>
  unstage: (
    request: Request & { paths: string[] },
  ) => Promise<Completion<Stated & { paths: string[] }>>
  /** Destructive: returns the working-tree change to the index. Its own call; the result's `restoreId` brings it back through `restore`. */
  discard: (
    request: Request & { path: string },
  ) => Promise<Completion<Stated & { path: string; restoreId: string }>>
  restore: (
    request: Request & { restoreId: string },
  ) => Promise<Completion<Stated & { restoreId: string }>>
  /** `amend` is refused unless the host advertises `scm.commit.amend`. */
  commit: (
    request: Request & { message: string; amend?: boolean },
  ) => Promise<Completion<Stated>>
  branches: (request: Request) => Promise<Completion<BranchInfo[]>>
  switchBranch: (
    request: Request & { name: string },
  ) => Promise<Completion<Stated & { name: string }>>
  createBranch: (
    request: Request & { name: string },
  ) => Promise<Completion<Stated & { name: string }>>
  /** Merges `branch` into the current branch; a conflict is an accepted answer with `merged: false`. */
  merge: (
    request: Request & { branch: string },
  ) => Promise<Completion<Stated & { merged: boolean; conflicts: unknown[] }>>
  fetch: (
    request: Request & { remote?: string },
  ) => Promise<Completion<Stated & { remote?: string }>>
  push: (
    request: Request & { remote?: string; reference?: string },
  ) => Promise<Completion<Stated & { remote?: string; reference?: string }>>
  log: (
    request: Request & { path?: string; maxCount: number },
  ) => Promise<Completion<Stated & { commits: LogEntry[] }>>
  blame: (
    request: Request & { path: string; startLine?: number; endLine?: number },
  ) => Promise<Completion<Stated & { path: string; hunks: BlameHunk[] }>>
}

type Raw = Record<string, unknown>

const raw = (value: unknown): Raw =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : {}
const str = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined
const num = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined
const label = (value: unknown): string | undefined =>
  typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined

/** The state a host answer reports, or undefined when it reports none. */
export function stateOf(answer: unknown): RepoState | undefined {
  const body = raw(answer)
  const state: RepoState = {}
  const head = str(body.head)
  if (head !== undefined) state.head = head
  if (body.branch === null || typeof body.branch === 'string') {
    state.branch = body.branch
  }
  const index = label(body.index_generation)
  if (index !== undefined) state.indexGeneration = index
  const worktree = label(body.worktree_generation)
  if (worktree !== undefined) state.worktreeGeneration = worktree
  return Object.keys(state).length > 0 ? state : undefined
}

const stated = <T extends object>(answer: unknown, value: T): T & Stated => {
  const state = stateOf(answer)
  return state ? { ...value, state } : value
}

/** A path that stays inside the workspace: relative, with no `..` segment. */
function outsideWorkspace(path: string): boolean {
  return (
    path === '' ||
    path.startsWith('/') ||
    path.includes('\0') ||
    path.split('/').some((segment) => segment === '..')
  )
}

function hunksOf(value: unknown): DiffHunk[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    const hunk = raw(item)
    return {
      path: str(hunk.path) ?? '',
      oldStart: num(hunk.old_start) ?? 0,
      oldCount: num(hunk.old_count) ?? 0,
      newStart: num(hunk.new_start) ?? 0,
      newCount: num(hunk.new_count) ?? 0,
      header: str(hunk.header) ?? '',
      patch: str(hunk.patch) ?? '',
    }
  })
}

export function createScm(env: Environment<ScmClient>): Scm {
  const { workspaceId } = env
  const scm = () => env.client.ide.scm
  /** A write is sent once; the SDK's own retries are off, so the host sees it once. */
  const once = { maxRetries: 0 }

  const resourceOf = (path: string): ResourceRef => ({
    type: 'document',
    workspace: workspaceId,
    resourceId: path,
  })

  const run = createRun(env)

  const outside = (requestId: string, path: string) =>
    refused(
      { workspaceId, requestId },
      'outside_workspace',
      `${path} is outside the workspace`,
    )

  /** `run`, then `shape` on the host's answer. */
  async function ask<T>(
    requestId: string,
    operation: string,
    write: boolean,
    call: (headers: OperationHeaders) => PromiseLike<unknown>,
    shape: (answer: unknown) => T,
    advertised = false,
  ): Promise<Completion<T>> {
    const done = await run(requestId, operation, write, call, { advertised })
    return done.outcome === 'accepted'
      ? accepted({ workspaceId, requestId }, shape(done.value))
      : done
  }

  function statusOfAnswer(answer: unknown): ScmStatusResult {
    const body = raw(answer)
    const result: ScmStatusResult = {
      branch: typeof body.branch === 'string' ? body.branch : null,
      head: str(body.head) ?? '',
      staged: [],
      unstaged: [],
      untracked: [],
      conflicted: [],
      unclassified: [],
    }
    const state = stateOf(body)
    if (state) result.state = state
    for (const item of Array.isArray(body.changes) ? body.changes : []) {
      const row = raw(item)
      const path = str(row.path)
      if (path === undefined) continue
      const index = str(row.index)
      const worktree = str(row.worktree)
      if (index === undefined || worktree === undefined) {
        result.unclassified.push({
          resource: resourceOf(path),
          path,
          status: str(row.status),
        })
        continue
      }
      const entry: ChangeEntry = {
        resource: resourceOf(path),
        path,
        index,
        worktree,
      }
      const original = str(row.original_path)
      if (original) entry.originalPath = original
      if (row.conflict === true) {
        result.conflicted.push(entry)
      } else if (index === '?' && worktree === '?') {
        result.untracked.push(entry)
      } else {
        if (index !== ' ' && index !== '?') result.staged.push(entry)
        if (worktree !== ' ' && worktree !== '?') result.unstaged.push(entry)
      }
    }
    return result
  }

  function diffOfAnswer(
    answer: unknown,
    base: { path?: string; staged: boolean; commit?: string },
  ): DiffResult {
    const body = raw(answer)
    return stated(body, {
      ...base,
      text: str(body.diff) ?? '',
      hunks: hunksOf(body.hunks),
    })
  }

  /** Stage and unstage take the same body. */
  const pathsCall = (
    requestId: string,
    operation: 'scm.stage' | 'scm.unstage',
    paths: string[],
  ) => {
    const bad = paths.find(outsideWorkspace)
    if (paths.length === 0 || bad !== undefined) {
      return Promise.resolve(
        paths.length === 0
          ? refused({ workspaceId, requestId }, 'no_paths', 'No path was given')
          : outside(requestId, bad!),
      )
    }
    return ask(
      requestId,
      operation,
      true,
      (headers) =>
        operation === 'scm.stage'
          ? scm().stage({ ...headers, body: { paths } }, once)
          : scm().unstage({ ...headers, body: { paths } }, once),
      (answer) => stated(answer, { paths }),
    )
  }

  const switchTo = (requestId: string, name: string, create: boolean) =>
    name.trim() === ''
      ? Promise.resolve(
          refused(
            { workspaceId, requestId },
            'empty_branch',
            'A branch needs a name',
          ),
        )
      : ask(
          requestId,
          'scm.branch',
          true,
          (headers) =>
            scm().branch({ ...headers, body: { name, create } }, once),
          (answer) => stated(answer, { name }),
        )

  return {
    status: ({ requestId }) =>
      ask(
        requestId,
        'scm.status',
        false,
        (headers) => scm().status({ ...headers, body: {} }),
        statusOfAnswer,
      ),

    async diff({ requestId, path, staged }) {
      if (path !== undefined && outsideWorkspace(path)) {
        return outside(requestId, path)
      }
      return ask(
        requestId,
        'scm.diff',
        false,
        (headers) =>
          scm().diff({
            ...headers,
            body: path === undefined ? { staged } : { path, staged },
          }),
        (answer) => diffOfAnswer(answer, { path, staged }),
        true,
      )
    },

    async diffCommit({ requestId, commit, path }) {
      if (commit.trim() === '') {
        return refused(
          { workspaceId, requestId },
          'empty_commit',
          'A commit diff needs a commit',
        )
      }
      if (path !== undefined && outsideWorkspace(path)) {
        return outside(requestId, path)
      }
      const done = await run(
        requestId,
        'scm.diff',
        false,
        (headers) =>
          scm().diff({
            ...headers,
            body:
              path === undefined
                ? { commit, staged: false }
                : { commit, path, staged: false },
          }),
        { advertised: true },
      )
      if (done.outcome !== 'accepted') return done
      const answers: Answers = { workspaceId, requestId }
      const named = str(raw(done.value).commit)
      if (named === undefined || !named.startsWith(commit)) {
        // A host that ignores the argument answers with the working tree; that is not this commit.
        return refused(
          answers,
          'missing_capability',
          'scm.diff: this host does not diff a commit',
        )
      }
      return accepted(
        answers,
        diffOfAnswer(done.value, { path, staged: false, commit }),
      )
    },

    async show({ requestId, path, reference }) {
      if (outsideWorkspace(path)) return outside(requestId, path)
      const ref =
        reference === 'head'
          ? 'HEAD'
          : reference === 'index'
            ? 'index'
            : reference
      return ask(
        requestId,
        'scm.show',
        false,
        (headers) => scm().show({ ...headers, body: { path, ref } }),
        (answer) => {
          const body = raw(answer)
          return stated(body, {
            path,
            reference: str(body.ref) ?? ref,
            exists: body.exists !== false,
            text: str(body.text) ?? '',
          })
        },
      )
    },

    stage: ({ requestId, paths }) => pathsCall(requestId, 'scm.stage', paths),
    unstage: ({ requestId, paths }) =>
      pathsCall(requestId, 'scm.unstage', paths),

    async discard({ requestId, path }) {
      if (outsideWorkspace(path)) return outside(requestId, path)
      const done = await ask(
        requestId,
        'scm.discard',
        true,
        (headers) => scm().discard({ ...headers, body: { path } }, once),
        (answer) => ({ answer, restoreId: str(raw(answer).restore_id) }),
      )
      if (done.outcome !== 'accepted') return done
      const { answer, restoreId } = done.value
      if (restoreId === undefined) {
        // The change is gone and the host did not say how to bring it back: the caller must hear that.
        return {
          workspaceId,
          requestId,
          outcome: 'uncertain',
          reason: 'The host discarded the change but returned no restore id',
        }
      }
      return accepted(
        { workspaceId, requestId },
        stated(answer, { path, restoreId }),
      )
    },

    restore: ({ requestId, restoreId }) =>
      restoreId === ''
        ? Promise.resolve(
            refused(
              { workspaceId, requestId },
              'no_restore_id',
              'A restore needs the id a discard returned',
            ),
          )
        : ask(
            requestId,
            'scm.restore',
            true,
            (headers) =>
              scm().restore(
                { ...headers, body: { restore_id: restoreId } },
                once,
              ),
            (answer) => stated(answer, { restoreId }),
          ),

    async commit({ requestId, message, amend }) {
      if (message.trim() === '') {
        return refused(
          { workspaceId, requestId },
          'empty_message',
          'A commit needs a message',
        )
      }
      if (amend) {
        await env.settled()
        const availability = env.availabilityFor('scm.commit.amend', true)
        if (availability.status === 'unavailable') {
          return refused(
            { workspaceId, requestId },
            'missing_capability',
            availability.reason,
          )
        }
      }
      return ask(
        requestId,
        'scm.commit',
        true,
        (headers) =>
          scm().commit(
            {
              ...headers,
              body: amend ? { message, amend: true } : { message },
            },
            once,
          ),
        (answer) => stated(answer, {}),
      )
    },

    branches: ({ requestId }) =>
      ask(
        requestId,
        'scm.branches',
        false,
        (headers) => scm().branches({ ...headers, body: {} }),
        (answer) => {
          const list = raw(answer).branches
          return (Array.isArray(list) ? list : []).flatMap((item) => {
            const branch = raw(item)
            const name = str(branch.name)
            return name === undefined
              ? []
              : [
                  {
                    name,
                    remote: branch.remote === true,
                    current: branch.current === true,
                    upstream: str(branch.upstream) ?? null,
                  },
                ]
          })
        },
      ),

    switchBranch: ({ requestId, name }) => switchTo(requestId, name, false),
    createBranch: ({ requestId, name }) => switchTo(requestId, name, true),

    merge: ({ requestId, branch }) =>
      branch.trim() === ''
        ? Promise.resolve(
            refused(
              { workspaceId, requestId },
              'empty_branch',
              'A merge needs a branch',
            ),
          )
        : ask(
            requestId,
            'scm.merge',
            true,
            (headers) =>
              scm().merge({ ...headers, body: { ref: branch } }, once),
            (answer) => {
              const body = raw(answer)
              return stated(body, {
                merged: body.state === 'merged',
                conflicts: Array.isArray(body.conflicts) ? body.conflicts : [],
              })
            },
            true,
          ),

    fetch: ({ requestId, remote }) =>
      ask(
        requestId,
        'scm.fetch',
        true,
        (headers) =>
          scm().fetch(
            { ...headers, body: remote === undefined ? {} : { remote } },
            once,
          ),
        (answer) =>
          stated(answer, { remote: str(raw(answer).remote) ?? remote }),
      ),

    push: ({ requestId, remote, reference }) =>
      ask(
        requestId,
        'scm.push',
        true,
        (headers) =>
          scm().push(
            {
              ...headers,
              body: {
                ...(remote === undefined ? {} : { remote }),
                ...(reference === undefined ? {} : { ref: reference }),
              },
            },
            once,
          ),
        (answer) =>
          stated(answer, {
            remote: str(raw(answer).remote) ?? remote,
            reference,
          }),
      ),

    async log({ requestId, path, maxCount }) {
      if (path !== undefined && outsideWorkspace(path)) {
        return outside(requestId, path)
      }
      return ask(
        requestId,
        'scm.log',
        false,
        (headers) =>
          scm().log({
            ...headers,
            body:
              path === undefined
                ? { max_count: maxCount }
                : { path, max_count: maxCount },
          }),
        (answer) => {
          const list = raw(answer).commits
          return stated(answer, {
            commits: (Array.isArray(list) ? list : []).flatMap((item) => {
              const entry = raw(item)
              const commit = str(entry.commit)
              if (commit === undefined) return []
              const row: LogEntry = {
                commit,
                author: str(entry.author) ?? '',
                timestamp: label(entry.timestamp) ?? '',
                subject: str(entry.subject) ?? '',
              }
              const email = str(entry.email)
              if (email) row.email = email
              return [row]
            }),
          })
        },
        true,
      )
    },

    async blame({ requestId, path, startLine, endLine }) {
      if (outsideWorkspace(path)) return outside(requestId, path)
      return ask(
        requestId,
        'scm.blame',
        false,
        (headers) =>
          scm().blame({
            ...headers,
            body: {
              path,
              ...(startLine === undefined ? {} : { start_line: startLine }),
              ...(endLine === undefined ? {} : { end_line: endLine }),
            },
          }),
        (answer) => {
          const list = raw(answer).hunks
          return stated(answer, {
            path,
            hunks: (Array.isArray(list) ? list : []) as BlameHunk[],
          })
        },
        true,
      )
    },
  }
}
