// SOURCING: lib/theorem/passthrough (theoremJson, the SDK's passthrough for routes its generated
// clients do not cover yet) with the shared CSRF and idempotency helper from lib/theorem/client,
// as lib/capabilities/api.ts uses them; every fetch of /api/pages/v1 is here, so SDK methods
// replace these callers when the SDK is regenerated. The routes and bodies are the ones Theorem's
// pages_api pins (docs/plans/user-authored-capabilities/CONTRACT.md "D. Pages").
import { refusalCode } from '@/lib/capabilities/api'
import {
  ModuleFileError,
  describeIssues,
  pageDocument,
} from '@/lib/modules/contract'
import { mutate } from '@/lib/theorem/client'
import { theoremJson } from '@/lib/theorem/passthrough'
import { isTheoremWorkspace, ownClientId } from '@/lib/workspace/theorem-client'
import type { WorkspaceClient } from '@/lib/workspace/types'
import { PAGES, codes } from './contract'
import type {
  PageHistory,
  PagePatch,
  PageRevisionDocument,
  PageView,
  PageWriteReceipt,
  RestorePageRequest,
  SavePageRequest,
} from './contract'

const query = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  ).toString()

const read = <T>(
  route: string,
  params: Record<string, string | number | undefined>,
) => theoremJson<T>(`${PAGES}${route}?${query(params)}`)

/**
 * A write: CSRF and an idempotency key, retried once on a stale session, and
 * this page's client id so the vault event the write causes reads as its own.
 */
const write = <T>(route: string, body: unknown) =>
  mutate((headers) =>
    theoremJson<T>(`${PAGES}${route}`, {
      method: 'POST',
      body,
      headers: { ...headers, 'X-Theorem-Client-Id': ownClientId() },
    }),
  )

/**
 * The answer with its page parsed as the page store parses a page file:
 * defaults filled, and a document that does not parse refused the same way.
 */
function parsed<T extends { page: unknown }>(path: string, answer: T) {
  const result = pageDocument.safeParse(answer.page)
  if (!result.success)
    throw new ModuleFileError(path, describeIssues(result.error))
  return { ...answer, page: result.data }
}

/** The page as the vault holds it now, with the revision a write names. */
export const readPage = async (path: string) =>
  parsed(path, await read<PageView>('/page', { path }))

/** A whole document; without `expectedRevision` it only creates. */
export const savePage = async (request: SavePageRequest) =>
  parsed(request.path, await write<PageWriteReceipt>('/save', request))

/** Ops by stable component id, applied all or none. */
export const patchPage = async (request: PagePatch) =>
  parsed(request.path, await write<PageWriteReceipt>('/patch', request))

/** An earlier revision's document, written as a new revision. */
export const restorePage = async (request: RestorePageRequest) =>
  parsed(request.path, await write<PageWriteReceipt>('/restore', request))

/** Newest first; `cursor` is the `nextCursor` of the page before. */
export const pageHistory = (path: string, cursor?: number, limit?: number) =>
  read<PageHistory>('/history', { path, cursor, limit })

/** One revision's document, for a preview. */
export const pageRevision = async (path: string, revision: string) =>
  parsed(
    path,
    await read<PageRevisionDocument>('/revision', { path, revision }),
  )

/** The page operations, as a store calls them. */
export interface PageOwner {
  read: typeof readPage
  save: typeof savePage
  patch: typeof patchPage
  restore: typeof restorePage
  history: typeof pageHistory
  revision: typeof pageRevision
}

const HTTP_OWNER: PageOwner = {
  read: readPage,
  save: savePage,
  patch: patchPage,
  restore: restorePage,
  history: pageHistory,
  revision: pageRevision,
}

/**
 * The page owner of a vault: Theorem's /api/pages/v1 for the Theorem vault,
 * which is the one it serves. Any other vault (the desktop workspace, a test's
 * fake) has none, and its page files are written through the Files contract.
 */
export const pageOwner = (client: WorkspaceClient): PageOwner | undefined =>
  isTheoremWorkspace(client.workspace) ? HTTP_OWNER : undefined

/**
 * A write refused because the page is not at the revision it named: the
 * revision it holds now, or `null` when no page is there.
 */
export function conflictRevision(error: unknown): string | null | undefined {
  const code = refusalCode(error)
  if (code === codes.NOT_FOUND) return null
  if (code !== codes.REVISION_CONFLICT) return undefined
  const current = (error as { body: Record<string, unknown> }).body
    .currentRevision
  return typeof current === 'string' ? current : null
}
