// SOURCING: the existing frontend clients, wrapped and not replaced: the workspace Files client (lib/workspace/types WorkspaceClient: tree, readText, search, links, backlinks, subscribe), the CRM's record verbs (components/crm/api findRecord, searchRecords) with the schema register's data model, the Index's items binding (components/index/api runBinding) for documents, the Work tracker (components/work/api readItem, queryItems, readProject), the chat SDK (threads.get, runs.get) and the organization read (lib/theorem/organization) for thread titles. Each provider takes its client as a dependency so the real wiring (./builtin) and a test fake differ only there. REF-03's first slice: documents/files, records, conversations/messages, Work items/projects, agent runs, artifacts.
import type { ObjectType, RecordRow } from '@/components/records/contract'
import type { IndexItem } from '@/components/index/contract'
import type {
  WorkItem,
  WorkItemDetail,
  WorkItemsPage,
  WorkProjectDetail,
  WorkQuery,
} from '@/components/work/contract'
import type { WorkspaceClient, WorkspaceLink } from '@/lib/workspace/types'
import type {
  PreviewData,
  ReferenceOccurrence,
  ResourceMeta,
  ResourceProvider,
  SearchHit,
} from './provider'
import { relationshipOfFileLink } from './relationships'
import type { ResourceIdentity, ResourceRef } from './types'

const ALL_ACTIONS: ResourceMeta['actions'] = [
  'open',
  'preview',
  'references',
  'copy-link',
]
const OPEN_PREVIEW: ResourceMeta['actions'] = ['open', 'preview', 'copy-link']

const ref = (resource: ResourceIdentity, title: string): ResourceRef => ({
  resource,
  revision: { mode: 'live' },
  hint: { label: title },
})

/** Matches the one kind of resource a provider serves; anything else is unavailable, never another resource. */
function only<TKind extends ResourceIdentity['kind']>(
  kind: TKind,
  resource: ResourceIdentity,
): Extract<ResourceIdentity, { kind: TKind }> | undefined {
  return resource.kind === kind
    ? (resource as Extract<ResourceIdentity, { kind: TKind }>)
    : undefined
}

const basename = (path: string) =>
  path.split('/').filter(Boolean).at(-1) ?? path

// Files

export interface FilesDeps {
  /** The client for a workspace, or none when this window cannot reach it. */
  client: (workspaceId: string) => WorkspaceClient | undefined
  /** The workspace a search covers when it is not given one. */
  defaultWorkspaceId: () => Promise<string | undefined>
}

const PREVIEW_CHARS = 600

export function filesProvider(deps: FilesDeps): ResourceProvider {
  const linkOccurrence = (
    workspaceId: string,
    target: string,
    link: WorkspaceLink,
    incoming: boolean,
  ): ReferenceOccurrence => {
    const at = incoming ? link.from : (link.resolved ?? link.target)
    const place = (path: string): ResourceRef =>
      ref({ kind: 'file', workspaceId, path }, basename(path))
    const source = incoming ? place(link.from) : place(target)
    const to = incoming ? place(target) : place(at)
    return {
      id: `${link.from}:${link.line}:${link.kind}:${link.target}${link.heading ? `#${link.heading}` : ''}${link.block ? `^${link.block}` : ''}`,
      source,
      target: to,
      relationship: relationshipOfFileLink(link.kind),
      destination: {
        ...source,
        location: {
          anchor: link.block ?? link.heading,
          range: {
            start: { line: Math.max(0, link.line - 1), character: 0 },
            end: { line: Math.max(0, link.line - 1), character: 0 },
            unit: 'utf16',
          },
        },
      },
    }
  }
  return {
    id: 'theorem.files',
    label: 'Files and documents',
    serves: ['file'],
    support: {
      resolve: true,
      search: true,
      preview: true,
      references: true,
      open: true,
      changes: true,
    },
    validate: (resource) =>
      resource.kind === 'file' && !resource.path.startsWith('/'),
    async resolve(r) {
      const file = only('file', r.resource)
      if (!file) return { state: 'unavailable' }
      const client = deps.client(file.workspaceId)
      if (!client) return { state: 'unavailable' }
      const entries = await client.tree()
      const entry = entries.find((e) => e.path === file.path)
      if (!entry) return { state: 'unavailable' }
      return {
        state: 'ready',
        meta: {
          title: basename(entry.path),
          typeLabel: entry.kind === 'directory' ? 'Folder' : 'File',
          subtitle: entry.path,
          updatedAtMs: entry.mtimeMs,
          actions: ALL_ACTIONS,
        },
      }
    },
    async preview(r) {
      const file = only('file', r.resource)
      const client = file && deps.client(file.workspaceId)
      if (!file || !client) return { state: 'unavailable' }
      const { text } = await client.readText(file.path)
      return {
        state: 'ready',
        preview: {
          title: basename(file.path),
          typeLabel: 'File',
          excerpt:
            text.length > PREVIEW_CHARS
              ? `${text.slice(0, PREVIEW_CHARS)}…`
              : text,
        },
      }
    },
    async search({ query, limit = 10, scope }) {
      const workspaceId =
        scope?.workspaceId ?? (await deps.defaultWorkspaceId())
      const client = workspaceId ? deps.client(workspaceId) : undefined
      if (!workspaceId || !client)
        throw Object.assign(new Error('No workspace to search.'), {
          status: 404,
        })
      const hits = await client.search(query, { limit })
      return {
        hits: hits.map((hit): SearchHit => ({
          ref: ref(
            { kind: 'file', workspaceId, path: hit.path },
            hit.title || basename(hit.path),
          ),
          title: hit.title || basename(hit.path),
          typeLabel: 'File',
          snippet: hit.snippet,
        })),
        // The Files search returns its best matches up to the limit and has no
        // cursor: a full page may stop short of what exists.
        truncated: hits.length >= limit,
      }
    },
    async references(r, { direction, relationships }) {
      const file = only('file', r.resource)
      const client = file && deps.client(file.workspaceId)
      if (!file || !client)
        throw Object.assign(new Error('Not reachable.'), { status: 404 })
      const links =
        direction === 'incoming'
          ? await client.backlinks(file.path)
          : await client.links(file.path)
      const occurrences = links
        .map((link) =>
          linkOccurrence(
            file.workspaceId,
            file.path,
            link,
            direction === 'incoming',
          ),
        )
        .filter(
          (o) =>
            !relationships?.length || relationships.includes(o.relationship),
        )
      // The authored-link projection returns every link of the file at once.
      return {
        occurrences,
        total: {
          count: new Set(
            occurrences.map((o) =>
              o.source.resource.kind === 'file' ? o.source.resource.path : '',
            ),
          ).size,
          unit: 'sources',
          exact: true,
        },
      }
    },
    subscribe(r, onChange) {
      const file = only('file', r.resource)
      const client = file && deps.client(file.workspaceId)
      if (!file || !client) return () => {}
      return client.subscribe((event) => {
        // A resync may have missed anything, so it counts as a change.
        if (event.type === 'resync') return onChange()
        if (event.type === 'indexed') return
        const path =
          event.type === 'renamed'
            ? event.from
            : event.type === 'deleted'
              ? event.path
              : event.entry.path
        if (path === file.path) onChange()
      })
    },
  }
}

// Documents (the Index's documents)

export interface DocumentsDeps {
  items: (query: {
    q?: string
    ids?: string[]
    limit: number
  }) => Promise<{ items: IndexItem[]; total: number }>
}

const documentRef = (item: IndexItem): ResourceRef => ({
  resource: { kind: 'document', documentId: item.documentId },
  revision: { mode: 'live' },
  hint: { label: item.title || item.documentId, type: item.documentKind },
})

export function documentsProvider(deps: DocumentsDeps): ResourceProvider {
  const one = async (id: string) =>
    (await deps.items({ ids: [id], limit: 1 })).items[0]
  return {
    id: 'theorem.documents',
    label: 'Documents',
    serves: ['document', 'graph-object'],
    support: { resolve: true, search: true, preview: true, open: true },
    validate: (r) => r.kind === 'document' || r.kind === 'graph-object',
    canonicalize: (r) =>
      // An Index document named as a graph object is the same document.
      r.kind === 'graph-object'
        ? `document:${r.objectId}`
        : r.kind === 'document'
          ? `document:${r.documentId}`
          : undefined,
    async resolve(r) {
      const id =
        r.resource.kind === 'document'
          ? r.resource.documentId
          : r.resource.kind === 'graph-object'
            ? r.resource.objectId
            : undefined
      const item = id && (await one(id))
      if (!item) return { state: 'unavailable' }
      return {
        state: 'ready',
        meta: {
          title: item.title || item.documentId,
          typeLabel: 'Document',
          subtitle: item.documentKind,
          revision: item.revision.position,
          actions: OPEN_PREVIEW,
        },
      }
    },
    async preview(r) {
      const id =
        r.resource.kind === 'document'
          ? r.resource.documentId
          : r.resource.kind === 'graph-object'
            ? r.resource.objectId
            : undefined
      const item = id && (await one(id))
      if (!item) return { state: 'unavailable' }
      return {
        state: 'ready',
        preview: {
          title: item.title || item.documentId,
          typeLabel: 'Document',
          excerpt: item.snippet,
        },
      }
    },
    async search({ query, limit = 8 }) {
      const { items, total } = await deps.items({
        q: query || undefined,
        limit,
      })
      return {
        hits: items.map((item) => ({
          ref: documentRef(item),
          title: item.title || item.documentId,
          typeLabel: 'Document',
          snippet: item.snippet,
        })),
        total,
        truncated: total > items.length,
      }
    },
  }
}

// Records

export interface RecordsDeps {
  types: () => Promise<ObjectType[]>
  find: (
    objectTypeId: string,
    id: string,
  ) => Promise<RecordRow & { version: number }>
  search: (
    type: ObjectType,
    query: string,
    limit: number,
  ) => Promise<Array<RecordRow & { version?: number }>>
  /** Whether this sign-in may read the type. */
  canRead: (type: ObjectType) => Promise<boolean>
  title: (type: ObjectType, row: RecordRow) => string
}

export function recordsProvider(deps: RecordsDeps): ResourceProvider {
  const typeOf = async (name: string) =>
    (await deps.types()).find((t) => t.name_singular === name && !t.retired)
  const fieldsOf = (type: ObjectType, row: RecordRow) =>
    type.fields
      .filter(
        (f) =>
          f.key !== type.label_identifier_field &&
          row.values[f.key] !== undefined &&
          row.values[f.key] !== null &&
          row.values[f.key] !== '',
      )
      .slice(0, 6)
      .map((f) => ({
        key: f.key,
        label: f.label,
        value: row.values[f.key],
      }))
  return {
    id: 'theorem.records',
    label: 'Records',
    serves: ['record'],
    // Records carry their revision (`version`), so a pinned reference can name one; reading an older one is not served.
    support: { resolve: true, search: true, preview: true, open: true },
    validate: (r) => r.kind === 'record',
    async resolve(r) {
      const record = only('record', r.resource)
      const type = record && (await typeOf(record.objectType))
      if (!record || !type) return { state: 'unavailable' }
      if (!(await deps.canRead(type))) return { state: 'inaccessible' }
      const row = await deps.find(type.object_type_id, record.objectId)
      return {
        state: 'ready',
        meta: {
          title: deps.title(type, row) || row.id,
          typeLabel: type.label_singular,
          revision: row.version,
          actions: OPEN_PREVIEW,
        },
      }
    },
    async preview(r) {
      const record = only('record', r.resource)
      const type = record && (await typeOf(record.objectType))
      if (!record || !type) return { state: 'unavailable' }
      if (!(await deps.canRead(type))) return { state: 'inaccessible' }
      const row = await deps.find(type.object_type_id, record.objectId)
      const data: PreviewData = {
        title: deps.title(type, row) || row.id,
        typeLabel: type.label_singular,
        fields: fieldsOf(type, row),
        detail: { type, row },
      }
      return { state: 'ready', preview: data }
    },
    async search({ query, limit = 5, scope }) {
      const declared = (await deps.types()).filter(
        (t) =>
          !t.retired &&
          (!scope?.objectType || t.name_singular === scope.objectType),
      )
      const readable = await Promise.all(declared.map((t) => deps.canRead(t)))
      const types = declared.filter((_, i) => readable[i])
      const found = await Promise.all(
        types.map(async (type) => ({
          type,
          rows: await deps.search(type, query, limit),
        })),
      )
      const hits = found.flatMap(({ type, rows }) =>
        rows.map((row): SearchHit => {
          const title = deps.title(type, row) || row.id
          return {
            ref: {
              resource: {
                kind: 'record',
                objectType: type.name_singular,
                objectId: row.id,
              },
              revision: { mode: 'live' },
              hint: { label: title, type: type.label_singular },
            },
            title,
            typeLabel: type.label_singular,
          }
        }),
      )
      // The register has no text search: each type is a bounded title lookup,
      // so a hit list is never every matching record.
      return { hits, truncated: true }
    },
  }
}

// Work items and projects

export interface WorkDeps {
  item: (id: string) => Promise<WorkItemDetail>
  project: (id: string) => Promise<WorkProjectDetail>
  query: (query: WorkQuery) => Promise<WorkItemsPage>
}

const itemPreview = (item: WorkItem): PreviewData => ({
  title: item.title,
  typeLabel: 'Work item',
  excerpt: item.bodyMarkdown?.slice(0, PREVIEW_CHARS),
  fields: [
    { key: 'status', label: 'Status', value: item.status.name },
    { key: 'priority', label: 'Priority', value: item.priority },
  ],
})

export function workProvider(deps: WorkDeps): ResourceProvider {
  const itemHit = (item: WorkItem): SearchHit => ({
    ref: {
      resource: { kind: 'work-item', itemId: item.id },
      revision: { mode: 'live' },
      hint: { label: item.title, type: 'Work item' },
    },
    title: item.title,
    typeLabel: 'Work item',
    snippet: item.key,
  })
  return {
    id: 'theorem.work',
    label: 'Work',
    serves: ['work-item', 'work-project'],
    support: { resolve: true, search: true, preview: true, open: true },
    validate: (r) => r.kind === 'work-item' || r.kind === 'work-project',
    async resolve(r) {
      if (r.resource.kind === 'work-project') {
        const { project } = await deps.project(r.resource.projectId)
        return {
          state: 'ready',
          meta: {
            title: project.name,
            typeLabel: 'Work project',
            revision: project.revision,
            actions: OPEN_PREVIEW,
          },
        }
      }
      const item = only('work-item', r.resource)
      if (!item) return { state: 'unavailable' }
      const { item: found } = await deps.item(item.itemId)
      return {
        state: 'ready',
        meta: {
          title: found.title,
          typeLabel: 'Work item',
          subtitle: found.key,
          updatedAtMs: Date.parse(found.updatedAt) || undefined,
          actions: OPEN_PREVIEW,
        },
      }
    },
    async preview(r) {
      if (r.resource.kind === 'work-project') {
        const { project } = await deps.project(r.resource.projectId)
        return {
          state: 'ready',
          preview: {
            title: project.name,
            typeLabel: 'Work project',
            excerpt: project.description,
          },
        }
      }
      const item = only('work-item', r.resource)
      if (!item) return { state: 'unavailable' }
      return {
        state: 'ready',
        preview: itemPreview((await deps.item(item.itemId)).item),
      }
    },
    async search({ query, limit = 8, cursor }) {
      const page = await deps.query({
        filter: {
          op: 'and',
          conditions: query
            ? [{ field: 'text', operator: 'contains', value: query }]
            : [],
        },
        orderBy: { field: 'updatedAt', direction: 'desc' },
        limit,
        cursor,
      })
      return {
        hits: page.items.map(itemHit),
        next: page.nextCursor,
        total: page.total,
      }
    },
  }
}

// Threads and messages

export interface ThreadsDeps {
  thread: (threadId: string) => Promise<{
    title: string
    deletedAtMs?: number
    revision: number
    messages: Array<{ messageId: string; role: string; text?: string }>
  }>
  /** Threads whose title matches; `complete` is false when the listing was one page. */
  list: (query: string) => Promise<{
    threads: Array<{ threadId: string; title: string }>
    complete: boolean
  }>
}

export function threadsProvider(deps: ThreadsDeps): ResourceProvider {
  return {
    id: 'theorem.threads',
    label: 'Conversations',
    serves: ['thread', 'message'],
    support: { resolve: true, search: true, preview: true, open: true },
    validate: (r) => r.kind === 'thread' || r.kind === 'message',
    async resolve(r) {
      const threadId =
        r.resource.kind === 'thread'
          ? r.resource.threadId
          : r.resource.kind === 'message'
            ? r.resource.threadId
            : undefined
      if (!threadId) return { state: 'unavailable' }
      const thread = await deps.thread(threadId)
      if (thread.deletedAtMs)
        return {
          state: 'deleted',
          tombstone: { kindLabel: 'Conversation', atMs: thread.deletedAtMs },
        }
      if (r.resource.kind === 'message') {
        const id = r.resource.messageId
        const message = thread.messages.find((m) => m.messageId === id)
        if (!message) return { state: 'unavailable' }
        return {
          state: 'ready',
          meta: {
            title: message.text?.slice(0, 80) || 'Message',
            typeLabel: 'Message',
            subtitle: thread.title,
            actions: OPEN_PREVIEW,
          },
        }
      }
      return {
        state: 'ready',
        meta: {
          title: thread.title,
          typeLabel: 'Conversation',
          revision: thread.revision,
          actions: OPEN_PREVIEW,
        },
      }
    },
    async preview(r) {
      const threadId =
        r.resource.kind === 'thread'
          ? r.resource.threadId
          : r.resource.kind === 'message'
            ? r.resource.threadId
            : undefined
      if (!threadId) return { state: 'unavailable' }
      const thread = await deps.thread(threadId)
      if (thread.deletedAtMs)
        return {
          state: 'deleted',
          tombstone: { kindLabel: 'Conversation', atMs: thread.deletedAtMs },
        }
      if (r.resource.kind === 'message') {
        const id = r.resource.messageId
        const message = thread.messages.find((m) => m.messageId === id)
        if (!message) return { state: 'unavailable' }
        return {
          state: 'ready',
          preview: {
            title: thread.title,
            typeLabel: 'Message',
            excerpt: message.text?.slice(0, PREVIEW_CHARS),
          },
        }
      }
      const last = thread.messages.at(-1)
      return {
        state: 'ready',
        preview: {
          title: thread.title,
          typeLabel: 'Conversation',
          excerpt: last?.text?.slice(0, PREVIEW_CHARS),
        },
      }
    },
    async search({ query }) {
      const { threads, complete } = await deps.list(query)
      const q = query.trim().toLowerCase()
      const matched = threads.filter(
        (t) => !q || t.title.toLowerCase().includes(q),
      )
      return {
        hits: matched.map((t) => ({
          ref: {
            resource: { kind: 'thread' as const, threadId: t.threadId },
            revision: { mode: 'live' as const },
            hint: { label: t.title, type: 'Conversation' },
          },
          title: t.title || 'Untitled conversation',
          typeLabel: 'Conversation',
        })),
        truncated: !complete,
      }
    },
  }
}

// Runs

export interface RunsDeps {
  run: (runId: string) => Promise<{
    runId: string
    threadId: string | null
    status: string
    terminal: boolean
    actor: string | null
  }>
}

export function runsProvider(deps: RunsDeps): ResourceProvider {
  return {
    id: 'theorem.runs',
    label: 'Runs',
    serves: ['run'],
    // Runs are found from the conversation that holds them; the SDK has no run search.
    support: { resolve: true, preview: true, open: true },
    validate: (r) => r.kind === 'run',
    async resolve(r) {
      const run = only('run', r.resource)
      if (!run) return { state: 'unavailable' }
      const snap = await deps.run(run.runId)
      return {
        state: 'ready',
        meta: {
          title: `Run ${snap.runId.slice(0, 8)}`,
          typeLabel: 'Run',
          subtitle: snap.terminal ? snap.status : `${snap.status} (running)`,
          actions: OPEN_PREVIEW,
        },
      }
    },
    async preview(r) {
      const run = only('run', r.resource)
      if (!run) return { state: 'unavailable' }
      const snap = await deps.run(run.runId)
      return {
        state: 'ready',
        preview: {
          title: `Run ${snap.runId.slice(0, 8)}`,
          typeLabel: 'Run',
          fields: [
            { key: 'status', label: 'Status', value: snap.status },
            ...(snap.actor
              ? [{ key: 'actor', label: 'Actor', value: snap.actor }]
              : []),
          ],
          detail: snap,
        },
      }
    },
  }
}

// Artifacts

export interface ArtifactsDeps {
  /** Reads an artifact (at a revision, when pinned). Absent until Theorem serves a route that finds one by id. */
  read?: (
    artifactId: string,
    revision?: number | string,
  ) => Promise<{
    title: string
    kind?: string
    revision?: number | string
    threadId?: string
  }>
}

export function artifactsProvider(deps: ArtifactsDeps): ResourceProvider {
  const read = deps.read
  return {
    id: 'theorem.artifacts',
    label: 'Artifacts',
    serves: ['artifact'],
    support: read
      ? { resolve: true, preview: true, open: true }
      : { open: true },
    validate: (r) => r.kind === 'artifact',
    ...(read && {
      revisions: { pinned: true as const },
      async resolve(r) {
        const artifact = only('artifact', r.resource)
        if (!artifact) return { state: 'unavailable' as const }
        const found = await read(
          artifact.artifactId,
          r.revision?.mode === 'pinned'
            ? r.revision.revision
            : artifact.revision,
        )
        return {
          state: 'ready' as const,
          meta: {
            title: found.title,
            typeLabel: found.kind ?? 'Artifact',
            revision: found.revision,
            actions: OPEN_PREVIEW,
          },
        }
      },
      async preview(r) {
        const artifact = only('artifact', r.resource)
        if (!artifact) return { state: 'unavailable' as const }
        const found = await read(
          artifact.artifactId,
          r.revision?.mode === 'pinned'
            ? r.revision.revision
            : artifact.revision,
        )
        return {
          state: 'ready' as const,
          preview: { title: found.title, typeLabel: found.kind ?? 'Artifact' },
        }
      },
    }),
  }
}
