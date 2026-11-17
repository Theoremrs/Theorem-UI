// SOURCING: none — the deterministic account the Threads panel's stories and scenarios read: three projects, the threads in them (a pinned one, one in two projects, one with two children and two delegations, a running one, a needs-you one, an unread one, an archived one, a hostile title and a very long one) and four Herdr sessions. Writes change this state and the story host tells the panel the listing again, as the real owner does.
import type {
  ThreadItem,
  ThreadListing,
  ThreadTag,
  TerminalSessionInfo,
} from '@/lib/workbench/wire'
import { WORKSPACE } from './fixtures'

/** The owner's clock: what every relative time is counted from. */
export const THREADS_AS_OF = 1_800_000_000_000
const ago = (minutes: number) => THREADS_AS_OF - minutes * 60_000

export const THREAD_PROJECTS = [
  { id: 'p-atlas', name: 'Atlas' },
  { id: 'p-harbor', name: 'Harbor' },
  { id: 'p-lantern', name: 'Lantern' },
]

/** A bidi override, a control character and a ZWJ family: text the panel must spell out, not draw. */
export const HOSTILE_TITLE =
  'Plan ‮txt.exe‬ bell\u0007 team \u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}'
export const LONG_TITLE =
  'A very long thread title that keeps going well past any sidebar the panel could be given so that it has to be cut with an ellipsis and never wraps onto a second line'

const thread = (
  id: string,
  title: string,
  projectIds: string[],
  minutes: number,
  extra: Partial<ThreadItem> = {},
): ThreadItem => ({
  id,
  title,
  projectIds,
  archived: false,
  pinned: false,
  unread: false,
  running: false,
  createdMs: ago(minutes + 600),
  lastMessageMs: ago(minutes),
  revision: '1',
  delegations: [],
  ...extra,
})

const seedThreads = (): ThreadItem[] => [
  thread('t-pinned', 'Reading list for the week', ['p-atlas'], 120, {
    pinned: true,
  }),
  thread('t-parent', 'Release planning', ['p-atlas'], 5, {
    delegations: [
      { id: 'd-review', label: 'Reviewer', runId: 'r-parent' },
      { id: 'd-build', label: 'Builder', runId: 'r-parent' },
    ],
  }),
  thread('t-child-a', 'Draft the changelog', ['p-atlas'], 30, {
    origin: 't-parent',
  }),
  thread('t-child-b', 'Check the migrations', ['p-atlas'], 45, {
    origin: 't-parent',
  }),
  thread('t-running', 'Indexing the archive', ['p-atlas'], 1, {
    running: true,
  }),
  thread('t-needs', 'Waiting on a decision', ['p-harbor'], 15, {
    needsYou: 'Approve',
  }),
  thread('t-unread', 'A reply came in', ['p-harbor'], 90, { unread: true }),
  thread(
    't-shared',
    'Shared between two projects',
    ['p-harbor', 'p-lantern'],
    200,
  ),
  thread('t-hostile', HOSTILE_TITLE, ['p-lantern'], 300),
  thread('t-long', LONG_TITLE, ['p-lantern'], 400),
  thread('t-archived', 'An old experiment', ['p-lantern'], 5000, {
    archived: true,
  }),
]

const seedSessions = (): TerminalSessionInfo[] => [
  {
    session: 'herdr-build',
    profile: 'zsh',
    name: 'build server',
    cwd: '/work/atlas/server',
    backend: 'herdr',
    workspace: WORKSPACE,
    host: 'studio',
    program: 1,
    state: 'running',
    admitted: true,
    programReport: {
      kind: 'current',
      status: { state: 'working' },
      seq: 1,
    },
  },
  {
    session: 'herdr-review',
    profile: 'zsh',
    name: 'review',
    cwd: '/work/harbor/docs',
    backend: 'herdr',
    workspace: WORKSPACE,
    host: 'studio',
    program: 1,
    state: 'running',
    admitted: true,
    programReport: {
      kind: 'current',
      status: { state: 'blocked', msg: 'waiting to run a command' },
      seq: 1,
    },
  },
  {
    session: 'herdr-agent',
    profile: 'claude',
    name: 'agent session',
    cwd: '/work/lantern/app',
    backend: 'herdr',
    workspace: WORKSPACE,
    host: 'laptop',
    program: 1,
    state: 'running',
    admitted: false,
    programReport: { kind: 'never_reported' },
  },
  {
    session: 'herdr-shell',
    profile: 'zsh',
    cwd: '/home/guest',
    backend: 'herdr',
    workspace: WORKSPACE,
    host: 'laptop',
    program: 1,
    state: 'running',
    admitted: false,
    programReport: { kind: 'never_reported' },
  },
]

/** An account other than the default: its projects, threads (as `thread()` builds them) and the one open. */
export interface ThreadsSeed {
  projects: Array<{ id: string; name: string }>
  threads: ThreadItem[]
  open: { projectId: string; threadId: string }
  /** The Herdr sessions beside the threads; none when absent. */
  sessions?: TerminalSessionInfo[]
}

/** A thread as the listing carries it, for a seed of one's own. */
export const seedThread = thread

/** The account's mutable state. */
export function createThreadsFixture(seed?: ThreadsSeed) {
  let threads = seed ? seed.threads : seedThreads()
  let sessions = seed ? (seed.sessions ?? []) : seedSessions()
  let open = seed ? seed.open : { projectId: 'p-atlas', threadId: 't-parent' }
  let created = 0
  const tags = new Map<string, ThreadTag>()

  const listing = (): ThreadListing => ({
    projects: seed ? seed.projects : THREAD_PROJECTS,
    threads: threads.map((item) => ({
      ...item,
      ...(tags.has(item.id) ? { tag: tags.get(item.id) } : {}),
    })),
    open,
    asOfMs: THREADS_AS_OF,
  })
  const edit = (id: string, change: Partial<ThreadItem>) => {
    threads = threads.map((item) =>
      item.id === id ? { ...item, ...change } : item,
    )
  }
  return {
    listing,
    sessions: () => sessions.map((row) => ({ ...row })),
    open(threadId: string, projectId?: string) {
      const found = threads.find(({ id }) => id === threadId)
      open = {
        threadId,
        projectId: projectId ?? found?.projectIds[0] ?? open.projectId,
      }
    },
    create(projectId: string) {
      created += 1
      const id = `t-new-${created}`
      threads = [
        thread(id, 'New thread', [projectId], 0, { createdMs: THREADS_AS_OF }),
        ...threads,
      ]
      return { projectId, threadId: id }
    },
    rename: (id: string, title: string) => edit(id, { title }),
    archive: (id: string, archived: boolean) => edit(id, { archived }),
    remove(id: string) {
      threads = threads.filter((item) => item.id !== id)
    },
    pin: (id: string, pinned: boolean) => edit(id, { pinned }),
    tag(id: string, tag?: ThreadTag) {
      if (tag) tags.set(id, tag)
      else tags.delete(id)
    },
    unread: (id: string, unread: boolean) => edit(id, { unread }),
    retitle: (id: string) => edit(id, { title: 'Regenerated title' }),
    markdown(id: string) {
      const found = threads.find((item) => item.id === id)
      return `# ${found?.title ?? ''}\n\n## You\n\nHello\n`
    },
    admit(session: string) {
      sessions = sessions.map((row) =>
        row.session === session ? { ...row, admitted: true } : row,
      )
    },
  }
}
