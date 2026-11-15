// SOURCING: none — thin mapping from the wire's scm effects to ./scm (the owner): one owner call per effect, the owner's answer reshaped to the wire's payload and nothing else
import { reply } from '../port'
import type { Of, OwnerPort } from '../port'
import type { CompletionPayload, ScmChange } from '../wire'
import type { ChangeEntry, Scm, ScmStatusResult, Stated } from './scm'

/** `{type:'scmState'}` when the host reported the repository's state, else nothing to carry. */
const stateOnly = (value: Stated) =>
  value.state ? { value: { type: 'scmState', ...value.state } as const } : {}

/**
 * The owner groups a path by where it changed; the wire lists one row per path. A path changed on
 * both sides is one row with both letters, and a row the host sent without letters keeps both empty.
 */
function changesOf(status: ScmStatusResult): ScmChange[] {
  const rows = new Map<string, ScmChange>()
  const add = (entry: ChangeEntry, conflict: boolean) => {
    if (rows.has(entry.path)) return
    rows.set(entry.path, {
      path: entry.path,
      index: entry.index,
      worktree: entry.worktree,
      ...(entry.originalPath ? { originalPath: entry.originalPath } : {}),
      conflict,
    })
  }
  for (const entry of status.conflicted) add(entry, true)
  for (const entry of status.staged) add(entry, false)
  for (const entry of status.unstaged) add(entry, false)
  for (const entry of status.untracked) add(entry, false)
  for (const { path } of status.unclassified)
    if (!rows.has(path))
      rows.set(path, { path, index: '', worktree: '', conflict: false })
  return [...rows.values()]
}

export function createScmPort(scm: Scm): OwnerPort<Of<'scm'>> {
  return {
    async perform(effect, requestId) {
      switch (effect.kind) {
        case 'scmStatus':
          return reply(await scm.status({ requestId }), (status) => ({
            value: {
              type: 'scm',
              branch: status.branch,
              head: status.head === '' ? null : status.head,
              changes: changesOf(status),
              ...(status.state ? { state: status.state } : {}),
            },
          }))
        case 'scmDiff':
          return reply(
            await scm.diff({ requestId, ...effect.payload }),
            (diff) => ({ value: { type: 'scmDiff', ...diff } }),
          )
        case 'scmShow':
          return reply(
            await scm.show({ requestId, ...effect.payload }),
            (shown) => ({ value: { type: 'scmShow', ...shown } }),
          )
        case 'scmStage':
          return reply(
            await scm.stage({ requestId, paths: effect.payload.paths }),
            stateOnly,
          )
        case 'scmUnstage':
          return reply(
            await scm.unstage({ requestId, paths: effect.payload.paths }),
            stateOnly,
          )
        case 'scmDiscard':
          return reply(
            await scm.discard({ requestId, path: effect.payload.path }),
            ({ path, restoreId, state }) => ({
              value: {
                type: 'scmDiscarded',
                path,
                restoreId,
                ...(state ? { state } : {}),
              },
            }),
          )
        case 'scmRestore':
          return reply(
            await scm.restore({
              requestId,
              restoreId: effect.payload.restoreId,
            }),
            stateOnly,
          )
        case 'scmCommit':
          return reply(
            await scm.commit({ requestId, message: effect.payload.message }),
            stateOnly,
          )
        case 'scmAmend':
          return reply(
            await scm.commit({
              requestId,
              message: effect.payload.message,
              amend: true,
            }),
            stateOnly,
          )
        case 'scmBranches':
          return reply(await scm.branches({ requestId }), (branches) => ({
            value: {
              type: 'scmBranches',
              branches: branches.map(({ upstream, ...branch }) => ({
                ...branch,
                ...(upstream ? { upstream } : {}),
              })),
            },
          }))
        case 'scmDiffCommit':
          return reply(
            await scm.diffCommit({ requestId, ...effect.payload }),
            (diff) => ({ value: { type: 'scmDiff', ...diff } }),
          )
        case 'scmShowRevision':
          return reply(
            await scm.show({
              requestId,
              path: effect.payload.path,
              reference: effect.payload.revision,
            }),
            (shown) => ({ value: { type: 'scmShow', ...shown } }),
          )
        case 'scmBranch': {
          const { name, create } = effect.payload
          return reply(
            await (create ? scm.createBranch : scm.switchBranch)({
              requestId,
              name,
            }),
            stateOnly,
          )
        }
        case 'scmFetch':
          return reply(
            await scm.fetch({ requestId, ...effect.payload }),
            stateOnly,
          )
        case 'scmPush':
          return reply(
            await scm.push({ requestId, ...effect.payload }),
            stateOnly,
          )
        case 'scmMerge':
          return reply(
            await scm.merge({ requestId, branch: effect.payload.branch }),
            ({ merged, state }) => ({
              value: {
                type: 'scmMerged',
                merged,
                ...(state ? { state } : {}),
              },
            }),
          )
        case 'scmBlame':
          return reply(
            await scm.blame({ requestId, path: effect.payload.path }),
            ({ path, hunks, state }): { value: CompletionPayload } => ({
              value: {
                type: 'scmBlame',
                path,
                hunks: hunks.map((hunk) => ({
                  author: hunk.author,
                  commit: hunk.commit,
                  startLine: hunk.start_line,
                  lineCount: hunk.line_count,
                  summary: hunk.summary,
                  timestamp: String(hunk.timestamp),
                })),
                ...(state ? { state } : {}),
              },
            }),
          )
        case 'scmLog':
          return reply(
            await scm.log({ requestId, ...effect.payload }),
            ({ commits, state }) => ({
              value: {
                type: 'scmLog',
                commits,
                ...(state ? { state } : {}),
              },
            }),
          )
      }
    },
  }
}
