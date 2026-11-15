// SOURCING: @theoremharness/sdk — `client.chat.threads.list/get/create/update/delete` and `client.chat.runs.delegations`, read and written through lib/theorem/client's `mutate` and `mutateThread` (CSRF, idempotency key, revisioned If-Match); the account's own list is lib/theorem/organization's `readOrganization`, whose `primaryProjectId`, `nestingSource` and `attentionLabel` give a thread's first project, its parent and its waiting word. `@theoremharness/sdk/assistant-ui` `toAssistantMessages` is the SDK's text mapping of a thread's messages, which the Markdown export reads. The SDK has no pin, tag, unread mark, title regeneration or Markdown export; this owner serves none of the first four (the panel is not granted them) and builds the last from the messages.
import type { Theorem } from '@theoremharness/sdk'
import { toAssistantMessages } from '@theoremharness/sdk/assistant-ui'
import {
  attentionLabel,
  nestingSource,
  primaryProjectId,
} from '../../theorem/organization'
import type { OrganizationRead, ThreadEntry } from '../../theorem/organization'
import { accepted, failure } from '../environment/result'
import type { Answers, Completion } from '../environment/result'
import type {
  ThreadCreated,
  ThreadDelegation,
  ThreadItem,
  ThreadListing,
  ThreadMarkdown,
} from '../wire'

/** The SDK calls this owner makes; `TheoremClient` satisfies it and a test can stub it. */
export interface ThreadsClient {
  chat: {
    threads: {
      list: (request: {
        projectId: string
        includeArchived?: boolean
        limit?: number
      }) => PromiseLike<{ items: Theorem.Thread[] }>
      get: (request: {
        threadId: string
      }) => PromiseLike<Theorem.ThreadSnapshot>
      create: (request: {
        projectId: string
        'X-CSRF-Token': string
        'Idempotency-Key': string
      }) => PromiseLike<{ record: { threadId: string } }>
      update: (request: {
        threadId: string
        title?: string
        archived?: boolean
        'X-CSRF-Token': string
        'Idempotency-Key': string
        'If-Match': string
      }) => PromiseLike<unknown>
      delete: (request: {
        threadId: string
        'X-CSRF-Token': string
        'Idempotency-Key': string
        'If-Match': string
      }) => PromiseLike<unknown>
    }
    runs: {
      delegations: (request: {
        runId: string
      }) => PromiseLike<Pick<Theorem.RunDelegations, 'delegations'>>
    }
  }
}

type Headers = { 'X-CSRF-Token': string; 'Idempotency-Key': string }

export interface ThreadsDeps {
  client: ThreadsClient
  /** The account's active threads and projects. */
  organization: () => Promise<OrganizationRead>
  mutate: <T>(run: (headers: Headers) => Promise<T>) => Promise<T>
  mutateThread: <T>(
    threadId: string,
    run: (headers: Headers & { 'If-Match': string }) => Promise<T>,
  ) => Promise<T>
  /** The conversation that is open now, when there is one. */
  open: () => { projectId: string; threadId: string } | undefined
  now?: () => number
}

export interface Threads {
  list: () => Promise<Completion<ThreadListing>>
  create: (projectId: string) => Promise<Completion<ThreadCreated>>
  rename: (threadId: string, title: string) => Promise<Completion<null>>
  archive: (threadId: string, archived: boolean) => Promise<Completion<null>>
  delete: (threadId: string) => Promise<Completion<null>>
  markdown: (threadId: string) => Promise<Completion<ThreadMarkdown>>
  /**
   * The listing now and whenever it changes: after each write, on `refresh`, and on a poll that runs
   * while anyone listens (quicker while a run is working, since a run ends without telling this tab).
   */
  subscribe: (listener: (listing: ThreadListing) => void) => () => void
  /** Reads again and tells the listeners; for a change this owner did not make (the open conversation moved). */
  refresh: () => void
}

const IDLE_POLL_MS = 15_000
const BUSY_POLL_MS = 4_000
const answers = (requestId: string): Answers => ({
  workspaceId: 'account',
  requestId,
})

/** The thread's placements, where it opens first. */
const projectIdsOf = (thread: ThreadEntry): string[] => {
  const first = primaryProjectId(thread)
  return [
    ...new Set([
      first,
      ...thread.memberships.map(({ projectId }) => projectId),
      thread.homeProjectId,
    ]),
  ]
}

export function createThreads(deps: ThreadsDeps): Threads {
  const { client } = deps
  const now = deps.now ?? Date.now
  const listeners = new Set<(listing: ThreadListing) => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading: Promise<ThreadListing> | undefined
  let counter = 0
  const id = (verb: string) => `threads-${verb}-${(counter += 1)}`

  /** The delegations of a thread's latest run; a read that fails leaves the thread without them. */
  async function delegationsOf(threadId: string): Promise<ThreadDelegation[]> {
    try {
      const { thread } = await client.chat.threads.get({ threadId })
      const runId = thread.activeRunId ?? thread.lastRun?.runId
      if (!runId) return []
      const { delegations } = await client.chat.runs.delegations({ runId })
      return delegations.map((part) => ({
        id: part.delegationId,
        label: part.roleLabel || part.objective,
        runId,
      }))
    } catch {
      return []
    }
  }

  async function read(): Promise<ThreadListing> {
    const organization = await deps.organization()
    const open = deps.open()
    const asOfMs = now()
    const items = new Map<string, ThreadItem>()
    for (const thread of organization.threads) {
      const reason = thread.attention.reasons[0]
      items.set(thread.threadId, {
        id: thread.threadId,
        title: thread.title,
        projectIds: projectIdsOf(thread),
        archived: false,
        pinned: false,
        unread: false,
        running: thread.attention.running,
        ...(reason ? { needsYou: attentionLabel(reason) } : {}),
        createdMs: thread.createdAtMs,
        ...(thread.lastMessageAtMs !== undefined
          ? { lastMessageMs: thread.lastMessageAtMs }
          : {}),
        revision: String(thread.revision),
        ...(nestingSource(thread) ? { origin: nestingSource(thread) } : {}),
        delegations: [],
      })
    }
    // The account's list leaves out what is archived; each project lists those on request.
    const pages = await Promise.all(
      organization.projects.map(({ projectId }) =>
        Promise.resolve(
          client.chat.threads.list({
            projectId,
            includeArchived: true,
            limit: 100,
          }),
        ).catch(() => ({ items: [] as Theorem.Thread[] })),
      ),
    )
    for (const thread of pages.flatMap((page) => page.items)) {
      if (thread.status !== 'archived' || items.has(thread.threadId)) continue
      items.set(thread.threadId, {
        id: thread.threadId,
        title: thread.title,
        projectIds: [thread.projectId],
        archived: true,
        pinned: false,
        unread: false,
        running: false,
        createdMs: thread.createdAtMs,
        ...(thread.lastMessageAtMs !== undefined
          ? { lastMessageMs: thread.lastMessageAtMs }
          : {}),
        revision: String(thread.revision),
        ...(thread.origin?.kind === 'forked'
          ? { origin: thread.origin.threadId }
          : {}),
        delegations: [],
      })
    }
    // Delegations are read for what is working and for the open thread: the rows a person is looking at.
    await Promise.all(
      [...items.values()]
        .filter(
          ({ running, id: threadId }) => running || threadId === open?.threadId,
        )
        .map(async (item) => {
          item.delegations = await delegationsOf(item.id)
        }),
    )
    return {
      projects: organization.projects.map(({ projectId, title }) => ({
        id: projectId,
        name: title,
      })),
      threads: [...items.values()],
      ...(open ? { open } : {}),
      asOfMs,
    }
  }

  /** One read at a time: a read asked for while one is out is the one in flight. */
  const readOnce = () => {
    reading ??= read().finally(() => {
      reading = undefined
    })
    return reading
  }

  const tell = (listing: ThreadListing) => {
    for (const listener of [...listeners]) listener(listing)
  }

  function refresh() {
    if (listeners.size === 0) return
    // A read already out may have been answered before the change: read again once it lands.
    const after = reading ? reading.then(readOnce, readOnce) : readOnce()
    void after.then(tell, () => {})
  }

  function schedule(busy: boolean) {
    clearTimeout(timer)
    if (listeners.size === 0) return
    timer = setTimeout(
      () => {
        void readOnce().then(
          (listing) => {
            tell(listing)
            schedule(listing.threads.some(({ running }) => running))
          },
          () => schedule(false),
        )
      },
      busy ? BUSY_POLL_MS : IDLE_POLL_MS,
    )
  }

  /** A write: its outcome, then the listing again so every panel sees it. */
  async function write<T>(
    verb: string,
    run: () => Promise<T>,
  ): Promise<Completion<T>> {
    const base = answers(id(verb))
    try {
      const value = await run()
      refresh()
      return accepted(base, value)
    } catch (error) {
      return failure(base, error, true)
    }
  }

  return {
    async list() {
      const base = answers(id('list'))
      try {
        return accepted(base, await readOnce())
      } catch (error) {
        return failure(base, error, false)
      }
    },
    create: (projectId) =>
      write('create', async () => {
        const created = await deps.mutate((headers) =>
          Promise.resolve(
            client.chat.threads.create({ projectId, ...headers }),
          ),
        )
        return { projectId, threadId: created.record.threadId }
      }),
    rename: (threadId, title) =>
      write('rename', async () => {
        await deps.mutateThread(threadId, (headers) =>
          Promise.resolve(
            client.chat.threads.update({ threadId, title, ...headers }),
          ),
        )
        return null
      }),
    archive: (threadId, archived) =>
      write('archive', async () => {
        await deps.mutateThread(threadId, (headers) =>
          Promise.resolve(
            client.chat.threads.update({ threadId, archived, ...headers }),
          ),
        )
        return null
      }),
    delete: (threadId) =>
      write('delete', async () => {
        await deps.mutateThread(threadId, (headers) =>
          Promise.resolve(client.chat.threads.delete({ threadId, ...headers })),
        )
        return null
      }),
    async markdown(threadId) {
      const base = answers(id('markdown'))
      try {
        const snapshot = await client.chat.threads.get({ threadId })
        const lines = [`# ${snapshot.thread.title}`]
        for (const message of toAssistantMessages(
          snapshot.messages,
          snapshot.thread,
        )) {
          const text =
            typeof message.content === 'string'
              ? message.content
              : message.content
                  .map((part) => (part.type === 'text' ? part.text : ''))
                  .filter(Boolean)
                  .join('\n\n')
          if (text.trim())
            lines.push(
              `## ${message.role === 'user' ? 'You' : 'Assistant'}\n\n${text.trim()}`,
            )
        }
        return accepted(base, { text: `${lines.join('\n\n')}\n` })
      } catch (error) {
        return failure(base, error, false)
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      void readOnce().then(
        (listing) => {
          if (listeners.has(listener)) listener(listing)
          schedule(listing.threads.some(({ running }) => running))
        },
        () => schedule(false),
      )
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) clearTimeout(timer)
      }
    },
    refresh,
  }
}
