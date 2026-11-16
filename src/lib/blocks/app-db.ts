// SOURCING: @rustyreddb/browser (the graph database, in a dedicated worker, on
// the origin private file system). Which App reaches which database, and that
// a saved revision may only read, is this app's capability model.
import type { Database, OpenOptions } from '@rustyreddb/browser'
import type { AppDatabases } from './bridge'
import type { DbMethod, DbRead } from './sandbox/protocol'

/**
 * What this module needs of an open database. `@rustyreddb/browser`'s
 * `Database` is one.
 */
export type OpenDatabase = Pick<
  Database,
  | 'inspect'
  | 'mutate'
  | 'getNode'
  | 'getEdge'
  | 'queryNodes'
  | 'neighbors'
  | 'query'
  | 'subscribe'
  | 'compact'
  | 'close'
>

export type OpenDatabaseAt = (directory: string) => Promise<OpenDatabase>

/**
 * Days of past versions an App database keeps unless its declaration says
 * otherwise. Its current records are always kept; versions older than this
 * are dropped when the database is compacted.
 */
export const APP_HISTORY_DAYS = 90

const DAY_MS = 86_400_000

/**
 * Compact `database`, keeping `historyDays` of past versions, when it holds
 * versions more than a day older than that, so a database opened daily is
 * rewritten about once a day at most, and one with nothing to drop is left
 * alone. Compaction always keeps the current version, so a database holding
 * only that one has nothing to drop however old it is. A failure leaves the
 * database's records as they were, so it is reported and otherwise ignored.
 *
 * The window is given here, not taken from the handle: every view of an App
 * shares one handle, and the open App's current source says what it keeps.
 */
export async function compactWhenHistoryIsOld(
  database: Pick<Database, 'inspect' | 'compact'>,
  historyDays: number,
  now: number = Date.now(),
): Promise<boolean> {
  try {
    const { history } = await database.inspect()
    if (
      !history ||
      history.commits <= 1 ||
      history.oldestMs >= now - (historyDays + 1) * DAY_MS
    )
      return false
    await database.compact({ historyDays })
    return true
  } catch (failure) {
    console.warn('An App database could not be compacted', failure)
    return false
  }
}

/**
 * What an App's records are, however the engine is stood up: the same for the
 * database on screen and for the memory one a check runs against, so a check
 * refuses nothing the App it is checking would accept. One source, because the
 * engine defaults `controlEvents` and `ownershipMarkers` to true.
 */
const appDatabaseRules = {
  // Nothing reads control events for an App's data, so none are written.
  controlEvents: false,
  // A compaction without a window of its own keeps this many days.
  historyDays: APP_HISTORY_DAYS,
  // No subsystem keeps records in an App's database, so `ownership` is
  // one of the App's own properties. Every other owner rule still holds.
  ownershipMarkers: false,
} satisfies OpenOptions

/**
 * Open an App's database in this origin's private file system. The view that
 * may change it compacts it (see `documentAppDatabases`), with the window its
 * App declares.
 */
export async function openAppDatabase(directory: string): Promise<Database> {
  const [{ open }, { default: wasm }] = await Promise.all([
    import('@rustyreddb/browser'),
    import('@rustyreddb/browser/rustyred.wasm?url'),
  ])
  return open(directory, {
    ...appDatabaseRules,
    // Another tab showing this App uses the same database: one tab holds its
    // file and the rest reach it through that tab.
    shared: true,
    wasm,
    worker: () =>
      new Worker(new URL('./app-db.worker.ts', import.meta.url), {
        type: 'module',
      }),
  })
}

/**
 * A database that is nothing but memory, for a run that must not touch an
 * App's records: the hidden run a check makes of an App. It is opened under
 * `appDatabaseRules` like the one on screen.
 */
export const openInMemory: OpenDatabaseAt = async () => {
  const [{ inMemory }, { default: wasm }] = await Promise.all([
    import('@rustyreddb/browser'),
    import('@rustyreddb/browser/rustyred.wasm?url'),
  ])
  return inMemory({
    ...appDatabaseRules,
    wasm,
    worker: () =>
      new Worker(new URL('./app-db.worker.ts', import.meta.url), {
        type: 'module',
      }),
  })
}

/** How long a database stays open after its last frame left, in milliseconds. */
const LINGER_MS = 5_000

interface Held {
  database: Promise<OpenDatabase>
  users: number
  closing?: ReturnType<typeof setTimeout>
}

/**
 * The databases this page has open, by directory: every frame showing an App
 * shares one client. Between tabs, the database itself is shared.
 */
const held = new Map<string, Held>()

/**
 * The directory of an App's database in the origin private file system. It is
 * named by the App's document, not by a revision, so every revision of an App
 * reads the same records.
 */
export function appDatabaseDirectory(documentId: string, name: string): string {
  return `theorem-app.${documentId.replace(/[^A-Za-z0-9_-]/g, '_')}.${name}`
}

function acquire(
  directory: string,
  open: OpenDatabaseAt,
): Promise<OpenDatabase> {
  let entry = held.get(directory)
  if (!entry) {
    entry = { database: open(directory), users: 0 }
    held.set(directory, entry)
    // A failed open is not kept: the next frame tries again.
    entry.database.catch(() => {
      if (held.get(directory) === entry) held.delete(directory)
    })
  }
  clearTimeout(entry.closing)
  entry.closing = undefined
  entry.users += 1
  return entry.database
}

function release(directory: string): void {
  const entry = held.get(directory)
  if (!entry) return
  entry.users -= 1
  if (entry.users > 0) return
  // A new revision replaces the frame at once; lingering spares it a reopen.
  entry.closing = setTimeout(() => {
    if (held.get(directory) !== entry || entry.users > 0) return
    held.delete(directory)
    void entry.database.then((database) => database.close()).catch(() => {})
  }, LINGER_MS)
}

/** `inspect`'s answer, with the window this view's App declares. */
const withWindow = (report: unknown, historyDays: number): unknown => ({
  ...(report as object),
  historyDays,
})

function run(
  database: OpenDatabase,
  method: DbMethod,
  args: unknown,
  historyDays: number,
): Promise<unknown> {
  // The database checks each argument's shape itself and names what is wrong.
  const value = (args ?? {}) as never
  switch (method) {
    case 'inspect':
      return database
        .inspect()
        .then((report) => withWindow(report, historyDays))
    case 'mutate':
      return database.mutate(value)
    case 'getNode':
      return database.getNode((value as { id: string }).id)
    case 'getEdge':
      return database.getEdge((value as { id: string }).id)
    case 'queryNodes':
      return database.queryNodes(value)
    case 'neighbors':
      return database.neighbors(value)
    case 'query': {
      const { cypher, params, rowCap } = value as {
        cypher: string
        params?: Record<string, unknown>
        rowCap?: number
      }
      return database.query(cypher, params, rowCap)
    }
  }
}

export interface DocumentDatabases extends AppDatabases {
  /**
   * Replaces the windows the view's source declares, by database name, when
   * the source changes under a view that stays.
   */
  setHistoryDays: (windows: Record<string, number>) => void
  /** Lets go of every database this view opened. */
  dispose: () => void
}

/**
 * The databases of one App document, for one view of it. `writable` false is
 * a saved revision: it reads the App's records and changes none.
 * `historyDays` holds the windows the view's source declares, by database
 * name; others keep `APP_HISTORY_DAYS`. Each writable view compacts each
 * database to its own window once, when it first reaches it; a saved revision
 * never compacts, and leaves a database it keeps open for others alone.
 */
export function documentAppDatabases(
  documentId: string,
  options: {
    writable?: boolean
    open?: OpenDatabaseAt
    historyDays?: Record<string, number>
  } = {},
): DocumentDatabases {
  const { writable = true, open = openAppDatabase } = options
  let windows = options.historyDays ?? {}
  // A database may be named `constructor`: only the record's own keys count.
  const historyDaysFor = (name: string): number =>
    Object.hasOwn(windows, name) ? windows[name]! : APP_HISTORY_DAYS
  const opened = new Map<string, Promise<OpenDatabase>>()
  let disposed = false
  const database = (name: string): Promise<OpenDatabase> => {
    if (disposed)
      return Promise.reject(
        Object.assign(new Error('This view of the App has closed.'), {
          code: 'database_closed',
        }),
      )
    let mine = opened.get(name)
    if (!mine) {
      mine = acquire(appDatabaseDirectory(documentId, name), open)
      opened.set(name, mine)
      if (writable) {
        // Calls made meanwhile wait behind it in the database's worker.
        void mine.then(
          (db) => compactWhenHistoryIsOld(db, historyDaysFor(name)),
          () => {},
        )
      }
    }
    return mine
  }
  return {
    async call(name, method, args) {
      if (method === 'mutate' && !writable)
        throw Object.assign(
          new Error(
            'This is a saved revision of the App. Open the App to change its data.',
          ),
          { code: 'read_only' },
        )
      return run(await database(name), method, args, historyDaysFor(name))
    },
    subscribe(name, read: { method: DbRead; args: unknown }, next, error) {
      let stop: (() => void) | undefined
      let stopped = false
      database(name).then(
        (db) => {
          if (stopped) return
          stop = db.subscribe(
            { method: read.method, args: read.args ?? undefined } as never,
            read.method === 'inspect'
              ? (report) => next(withWindow(report, historyDaysFor(name)))
              : next,
            (failure) =>
              error({ code: failure.code, message: failure.message }),
          )
        },
        (failure: unknown) => {
          if (stopped) return
          const code = (failure as { code?: unknown } | null)?.code
          error({
            code: typeof code === 'string' ? code : 'database_failure',
            message:
              failure instanceof Error ? failure.message : String(failure),
          })
        },
      )
      return () => {
        stopped = true
        stop?.()
      }
    },
    setHistoryDays(next) {
      windows = next
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const name of opened.keys())
        release(appDatabaseDirectory(documentId, name))
      opened.clear()
    },
  }
}
