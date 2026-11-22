// SOURCING: none — a test fixture. window.fetch stood in for Theorem's /api/pages/v1 over
// test/workspace's fake vault, keeping the owner's rules the UI depends on: the revision is the
// file's content hash, a write names the revision it read (absent creates only), a stale one is
// 409 page_revision_conflict naming the current one, a missing page is 404 page_not_found, ops go
// by stable component id, and restore writes an old document as a new revision. The owner's own
// behavior is proven by Theorem's theorem-pages and route tests; this only answers in its shape.
import { pageText, parsePage } from '#/lib/modules/contract'
import type { ComponentData, PageDocument } from '#/lib/modules/contract'
import { PAGES, codes } from '#/lib/pages/contract'
import type {
  PageOp,
  PageRevision,
  PageRevisionReason,
} from '#/lib/pages/contract'
import type { WorkspaceClient } from '#/lib/workspace/types'
import type { FakeWorkspace } from './workspace'

export interface PageOwnerStub {
  /** The fake vault's client, as the Theorem vault (which has the owner). */
  client: WorkspaceClient
  /** Each page route called, with what it was sent. */
  calls: Array<{ route: string; body?: Record<string, unknown> }>
  restore: () => void
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const problem = (status: number, code: string, extra = {}) =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      status,
      code,
      detail: code,
      ...extra,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  )

function eachComponent(
  list: ComponentData[],
  visit: (c: ComponentData) => void,
) {
  for (const component of list) {
    visit(component)
    for (const value of Object.values(component.props))
      if (Array.isArray(value) && value.every((v) => v?.props?.id))
        eachComponent(value as ComponentData[], visit)
  }
}

function apply(page: PageDocument, ops: PageOp[]): PageDocument | string {
  const next = structuredClone(page)
  for (const op of ops) {
    if (op.op === 'set_title') next.title = op.title
    else if (op.op === 'set_pinned') next.pinned = op.pinned
    else if (op.op === 'set_props') {
      let found = false
      const lists = [
        next.layout.content,
        ...Object.values(next.layout.zones ?? {}),
      ]
      for (const list of lists)
        eachComponent(list, (c) => {
          if (c.props.id !== op.componentId) return
          found = true
          Object.assign(c.props, op.props)
        })
      if (!found) return codes.COMPONENT_UNKNOWN
    } else return codes.PATCH_INVALID
  }
  return next
}

export function stubPageOwner(fake: FakeWorkspace): PageOwnerStub {
  const realFetch = window.fetch
  const calls: PageOwnerStub['calls'] = []
  const history = new Map<
    string,
    Array<PageRevision & { page: PageDocument }>
  >()
  const client: WorkspaceClient = {
    ...fake.client,
    workspace: { ...fake.client.workspace, id: 'theorem:test' },
  }

  const current = async (path: string) => {
    const text = fake.text(path)
    if (text === undefined) return undefined
    const { hash } = await fake.client.readText(path)
    return { hash, page: parsePage(path, text) }
  }

  async function write(
    path: string,
    page: PageDocument,
    expected: string | undefined,
    reason: PageRevisionReason,
  ) {
    const now = await current(path)
    if (expected === undefined && now)
      return problem(409, codes.REVISION_CONFLICT, {
        currentRevision: now.hash,
      })
    if (expected !== undefined && !now) return problem(404, codes.NOT_FOUND)
    if (expected !== undefined && now && now.hash !== expected)
      return problem(409, codes.REVISION_CONFLICT, {
        currentRevision: now.hash,
      })
    const { hash } = await fake.client.write(path, pageText(page), {
      expectedHash: expected ?? null,
    })
    const entries = history.get(path) ?? []
    const entry = {
      path,
      revision: hash,
      seq: entries.length + 1,
      savedAtMs: 1_700_000_000_000 + entries.length * 60_000,
      principal: 'user:owner',
      summary: reason,
      reason,
      page,
    }
    history.set(path, [...entries, entry])
    const { page: _page, ...revision } = entry
    const entryId = (await fake.client.tree()).find((e) => e.path === path)!.id
    return json({
      path,
      entryId,
      revision: hash,
      ...(now && { previousRevision: now.hash }),
      page,
      history: revision,
    })
  }

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    if (url.pathname === '/api/chat/v1/bootstrap')
      return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    if (!url.pathname.startsWith(PAGES)) return json({}, 404)
    const route = url.pathname.slice(PAGES.length)
    const raw =
      init?.body ?? (request ? await request.clone().text() : undefined)
    const body =
      typeof raw === 'string' && raw
        ? (JSON.parse(raw) as Record<string, unknown>)
        : undefined
    calls.push({ route, body })
    const path = String(body?.path ?? url.searchParams.get('path'))
    const entries = history.get(path) ?? []

    if (route === '/page') {
      const now = await current(path)
      if (!now) return problem(404, codes.NOT_FOUND)
      const entryId = (await fake.client.tree()).find(
        (e) => e.path === path,
      )!.id
      return json({ path, entryId, revision: now.hash, page: now.page })
    }
    if (route === '/save')
      return write(
        path,
        body!.page as PageDocument,
        body!.expectedRevision as string | undefined,
        'saved',
      )
    if (route === '/patch') {
      const now = await current(path)
      if (!now) return problem(404, codes.NOT_FOUND)
      const next = apply(now.page, body!.ops as PageOp[])
      if (typeof next === 'string') return problem(422, next)
      return write(path, next, body!.expectedRevision as string, 'patched')
    }
    if (route === '/history') {
      const newest = [...entries].reverse().map(({ page: _page, ...r }) => r)
      return json({ path, revisions: newest })
    }
    if (route === '/revision') {
      const found = entries.find(
        (e) => e.revision === url.searchParams.get('revision'),
      )
      if (!found) return problem(404, codes.REVISION_NOT_FOUND)
      const { page, ...revision } = found
      return json({ revision, page })
    }
    if (route === '/restore') {
      const found = entries.find((e) => e.revision === body!.revision)
      if (!found) return problem(404, codes.REVISION_NOT_FOUND)
      return write(
        path,
        found.page,
        body!.expectedRevision as string,
        'restored',
      )
    }
    return json({}, 404)
  }) as typeof fetch

  return {
    client,
    calls,
    restore: () => {
      window.fetch = realFetch
    },
  }
}
