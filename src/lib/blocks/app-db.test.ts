// SOURCING: bun:test over an App's databases (app-db.ts) and the bridge that
// checks each call on them (bridge.ts), with the real engine in memory from
// test/blocks/memory-database.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import { memoryDatabase } from '../../../test/blocks/memory-database'
import type { MemoryDatabase } from '../../../test/blocks/memory-database'
import { memoryWorkspace } from '../../../test/blocks/memory-workspace'
import {
  APP_HISTORY_DAYS,
  appDatabaseDirectory,
  compactWhenHistoryIsOld,
  documentAppDatabases,
} from './app-db'
import type { DocumentDatabases } from './app-db'
import { serveBridge } from './bridge'
import { noCapabilities, parseHtmlDeclarations } from './declarations'
import { DbError, Databases } from './sandbox/db'
import type { DbNode } from './sandbox/db'
import { rpcOver, serve } from './sandbox/protocol'
import type { SandboxMethods } from './sandbox/protocol'
import { StateReplica } from './state'

/** The directories "the browser" has, each opened at most once at a time. */
function storage() {
  const directories = new Map<string, MemoryDatabase>()
  const opens: Array<string> = []
  return {
    directories,
    opens,
    open: async (directory: string) => {
      const existing = directories.get(directory)
      if (existing && !existing.closed)
        throw Object.assign(new Error('already has a writer'), {
          code: 'chunk_store_browser_storage',
        })
      opens.push(directory)
      const database = memoryDatabase()
      directories.set(directory, database)
      return database
    },
  }
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

/** One frame of an App: the page's bridge on one port, the frame's handle on the other. */
function frame(
  databases: DocumentDatabases | undefined,
  /** A person's limit: the databases it allows. Absent, the App reaches any. */
  declared?: Array<string>,
) {
  const channel = new MessageChannel()
  const stop = serveBridge(rpcOver(channel.port1), {
    client: memoryWorkspace({}),
    capabilities: declared && { ...noCapabilities(), db: declared },
    state: new StateReplica({
      load: async () => null,
      push: async () => {},
      subscribe: () => () => {},
    }),
    db: databases,
    run: () => Promise.reject(new Error('unused')),
  })
  const rpc = rpcOver(channel.port2)
  const inFrame = new Databases(rpc)
  serve<SandboxMethods, 'db.changed'>(rpc, 'db.changed', ({ id, outcome }) => {
    inFrame.changed(id, outcome)
    return null
  })
  cleanups.push(() => {
    stop()
    databases?.dispose()
    channel.port1.close()
    channel.port2.close()
  })
  return { db: (name: string) => inFrame.open(name), stop }
}

// The page keeps a database open for a moment after its last view goes, so
// each test names an App of its own.
let apps = 0
const nextApp = () => `doc-${++apps}`

const org = (id: string, name: string): DbNode => ({
  id,
  labels: ['Org'],
  properties: { name },
})
const names = (nodes: Array<DbNode>) =>
  nodes.map((node) => node.properties.name).sort()
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))
const failure = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    (error: unknown) => error,
  )

describe('declaring a database', () => {
  test('an App declares it like any other capability', () => {
    const { capabilities, errors } = parseHtmlDeclarations([
      'db("records"), state("view")',
    ])
    expect(errors).toEqual([])
    expect(capabilities.db).toEqual(['records'])
    expect(capabilities.state).toEqual(['view'])
  })

  test('its name must be safe as a file name', () => {
    for (const name of ['../other', 'Has Space', '', 'a/b', 'UPPER'])
      expect(parseHtmlDeclarations([`db("${name}")`]).errors).toHaveLength(1)
  })

  test('it may say how many days of history it keeps', () => {
    const { capabilities, dbHistoryDays, errors } = parseHtmlDeclarations([
      'db("crm", { historyDays: 365 }), db("log"), db("scratch", { "historyDays": 0.5 })',
      'db("crm", { historyDays: 365 })',
    ])
    expect(errors).toEqual([])
    expect(capabilities.db).toEqual(['crm', 'log', 'scratch'])
    // Every declared database carries a window, so a reader never has to know
    // what the default is: `log` keeps ninety days because nothing said other.
    expect(dbHistoryDays).toEqual({
      crm: 365,
      log: APP_HISTORY_DAYS,
      scratch: 0.5,
    })
  })

  test('a database declared twice must be asked for the same window', () => {
    // A bare declaration is the default window, and the default is a window:
    // mixing one with a stated window leaves a database no one can compact.
    for (const [declaration, windows] of [
      ['db("crm"), db("crm", { historyDays: 365 })', '90 and 365'],
      ['db("crm", { historyDays: 365 }), db("crm")', '365 and 90'],
      [
        'db("crm", { historyDays: 365 }), state("view"), db("crm", { historyDays: 7 })',
        '365 and 7',
      ],
    ] as Array<[string, string]>) {
      const { errors } = parseHtmlDeclarations([declaration])
      expect(errors).toEqual([
        `db("crm") is declared with two windows, ${windows} days`,
      ])
    }
    // The same window twice is one window, however it is arrived at.
    for (const declaration of [
      'db("crm"), db("crm")',
      'db("crm", { historyDays: 90 }), db("crm")',
      'db("crm"), db("crm", { historyDays: 90 })',
      'db("crm", { historyDays: 365 }), db("crm", { historyDays: 365 })',
    ]) {
      const { capabilities, dbHistoryDays, errors } = parseHtmlDeclarations([
        declaration,
      ])
      expect(errors).toEqual([])
      expect(capabilities.db).toEqual(['crm'])
      expect(dbHistoryDays).toEqual({
        crm: declaration.includes('365') ? 365 : APP_HISTORY_DAYS,
      })
    }
  })

  test('a database may be named constructor', () => {
    // `dbHistoryDays` carries a `constructor` of its own, so the record's
    // prototype is not a window it was declared with.
    const bare = parseHtmlDeclarations(['db("constructor"), db("constructor")'])
    expect(bare.errors).toEqual([])
    expect(bare.capabilities.db).toEqual(['constructor'])
    expect(bare.dbHistoryDays).toEqual({ constructor: APP_HISTORY_DAYS })
    const windowed = parseHtmlDeclarations([
      'db("constructor", { historyDays: 5 })',
    ])
    expect(windowed.errors).toEqual([])
    expect(windowed.dbHistoryDays).toEqual({ constructor: 5 })
    const mixed = parseHtmlDeclarations([
      'db("constructor"), db("constructor", { historyDays: 5 })',
    ])
    expect(mixed.errors).toEqual([
      `db("constructor") is declared with two windows, ${APP_HISTORY_DAYS} and 5 days`,
    ])
  })

  test('a window that is not a number of days is refused', () => {
    for (const declaration of [
      'db("crm", { historyDays: -1 })',
      'db("crm", { historyDays: "90" })',
      'db("crm", { history: 90 })',
      'db("crm", { historyDays: 90, other: 1 })',
      'db("crm", { [key]: 90 })',
      'db("crm", 90)',
      'state("view", { historyDays: 90 })',
    ]) {
      const { capabilities, errors } = parseHtmlDeclarations([declaration])
      expect(errors).toHaveLength(1)
      expect(capabilities.db).toEqual([])
    }
    const twice = parseHtmlDeclarations([
      'db("crm", { historyDays: 90 }), db("crm", { historyDays: 30 })',
    ])
    expect(twice.errors).toEqual([
      'db("crm") is declared with two windows, 90 and 30 days',
    ])
  })

  test('it is stored under the document, not a revision', () => {
    expect(appDatabaseDirectory('doc:app/7', 'records')).toBe(
      'theorem-app.doc_app_7.records',
    )
  })
})

describe("an App's database over the bridge", () => {
  test('a declared database commits, reads back and answers Cypher', async () => {
    const app1 = nextApp()
    const store = storage()
    const records = frame(documentAppDatabases(app1, { open: store.open }), [
      'records',
    ]).db('records')
    const commit = await records.mutate({
      upsertNodes: [org('org:a', 'Alder'), org('org:b', 'Birch')],
      upsertEdges: [
        {
          id: 'e:1',
          from: 'org:a',
          to: 'org:b',
          type: 'FUNDS',
          properties: {},
        },
      ],
    })
    expect(commit.graphVersion).toBeGreaterThan(0)
    expect(names(await records.queryNodes({ label: 'Org' }))).toEqual([
      'Alder',
      'Birch',
    ])
    expect((await records.getNode('org:a'))?.properties.name).toBe('Alder')
    expect(
      (await records.neighbors({ nodeId: 'org:a', direction: 'out' }))[0]
        ?.nodeId,
    ).toBe('org:b')
    const result = await records.query(
      'MATCH (o:Org) WHERE o.name = $name RETURN o.name AS name',
      { name: 'Birch' },
    )
    expect(result.rows).toEqual([['Birch']])
  })

  test('under a person\'s limit, a database it does not allow is not reached', async () => {
    const app1 = nextApp()
    const store = storage()
    const app = frame(documentAppDatabases(app1, { open: store.open }), [
      'records',
    ])
    const refused = await failure(app.db('other').queryNodes())
    expect((refused as Error).message).toContain(
      'db("other") is not among the databases this module was allowed',
    )
    expect(store.opens).toEqual([])
  })

  test('without a limit, an App reaches a database it never declared', async () => {
    const app1 = nextApp()
    const store = storage()
    const app = frame(documentAppDatabases(app1, { open: store.open }))
    await app.db('other').queryNodes()
    expect(store.opens.length).toBeGreaterThan(0)
  })

  test('a block with no databases is told so', async () => {
    const refused = await failure(
      frame(undefined, ['records']).db('records').inspect(),
    )
    expect((refused as Error).message).toContain('not available')
  })

  test("the database's own error code reaches the App", async () => {
    const app1 = nextApp()
    const store = storage()
    const records = frame(documentAppDatabases(app1, { open: store.open }), [
      'records',
    ]).db('records')
    const refused = await failure(records.query("CREATE (o:Org {name: 'x'})"))
    expect(refused).toBeInstanceOf(DbError)
    expect((refused as DbError).code).toBe('cypher_write_unsupported')
  })

  test('a method that is not a database call is refused before the database', async () => {
    const app1 = nextApp()
    const store = storage()
    const app = frame(documentAppDatabases(app1, { open: store.open }), [
      'records',
    ])
    const records = app.db('records') as unknown as {
      mutate: (batch: unknown) => Promise<unknown>
    }
    // A batch is checked by the database, which names the mistake.
    const misspelt = await failure(records.mutate({ upsertNode: [] }))
    expect(misspelt).toBeInstanceOf(DbError)
  })

  test('two views of one App share its records, and a subscription follows the other', async () => {
    const app1 = nextApp()
    const store = storage()
    const first = frame(documentAppDatabases(app1, { open: store.open }), [
      'records',
    ]).db('records')
    const second = frame(documentAppDatabases(app1, { open: store.open }), [
      'records',
    ]).db('records')
    const seen: Array<Array<unknown>> = []
    const stop = second.subscribe<Array<DbNode>>(
      { method: 'queryNodes', args: { label: 'Org' } },
      (nodes) => seen.push(names(nodes)),
    )
    await settled()
    await first.mutate({ upsertNodes: [org('org:a', 'Alder')] })
    await first.mutate({
      upsertNodes: [{ id: 'note:1', labels: ['Note'], properties: {} }],
    })
    await settled()
    expect(seen).toEqual([[], ['Alder']])
    expect(store.opens).toEqual([appDatabaseDirectory(app1, 'records')])
    stop()
    await first.mutate({ upsertNodes: [org('org:b', 'Birch')] })
    await settled()
    expect(seen).toHaveLength(2)
  })

  test('the next revision of an App finds the records the last one wrote', async () => {
    const app1 = nextApp()
    const store = storage()
    const before = frame(documentAppDatabases(app1, { open: store.open }), [
      'records',
    ])
    await before.db('records').mutate({ upsertNodes: [org('org:a', 'Alder')] })
    // A new revision replaces the frame: the old view goes, a new one comes.
    cleanups.splice(0).forEach((cleanup) => cleanup())
    const after = frame(documentAppDatabases(app1, { open: store.open }), [
      'records',
    ])
    expect(
      names(await after.db('records').queryNodes({ label: 'Org' })),
    ).toEqual(['Alder'])
    expect(store.opens).toHaveLength(1)
  })

  test('another App does not see them', async () => {
    const app1 = nextApp()
    const app2 = nextApp()
    const store = storage()
    await frame(documentAppDatabases(app1, { open: store.open }), ['records'])
      .db('records')
      .mutate({ upsertNodes: [org('org:a', 'Alder')] })
    const other = frame(documentAppDatabases(app2, { open: store.open }), [
      'records',
    ])
    expect(await other.db('records').queryNodes({ label: 'Org' })).toEqual([])
  })

  test('a saved revision reads the records and changes none', async () => {
    const app1 = nextApp()
    const store = storage()
    await frame(documentAppDatabases(app1, { open: store.open }), ['records'])
      .db('records')
      .mutate({ upsertNodes: [org('org:a', 'Alder')] })
    const pinned = frame(
      documentAppDatabases(app1, { open: store.open, writable: false }),
      ['records'],
    ).db('records')
    expect(names(await pinned.queryNodes({ label: 'Org' }))).toEqual(['Alder'])
    const refused = await failure(
      pinned.mutate({ upsertNodes: [org('org:b', 'Birch')] }),
    )
    expect((refused as DbError).code).toBe('read_only')
    expect(names(await pinned.queryNodes({ label: 'Org' }))).toEqual(['Alder'])
  })

  test('a frame that goes away stops its subscriptions', async () => {
    const app1 = nextApp()
    const store = storage()
    const databases = documentAppDatabases(app1, { open: store.open })
    const app = frame(databases, ['records'])
    const seen: Array<unknown> = []
    app
      .db('records')
      .subscribe({ method: 'queryNodes', args: { label: 'Org' } }, (nodes) =>
        seen.push(nodes),
      )
    await settled()
    app.stop()
    await databases.call('records', 'mutate', {
      upsertNodes: [org('org:a', 'Alder')],
    })
    await settled()
    expect(seen).toHaveLength(1)
  })
})

describe('the history window', () => {
  const DAY = 86_400_000
  const now = 1_800_000_000_000
  const database = (oldestMs: number | null, compactFails = false, commits = 3) => {
    const calls: string[] = []
    return {
      calls,
      inspect: async () => {
        calls.push('inspect')
        return {
          writable: true,
          version: 3,
          nodes: 1,
          edges: 0,
          history: oldestMs === null ? null : { commits, oldestMs },
          historyDays: APP_HISTORY_DAYS,
        }
      },
      compact: async (options?: { historyDays?: number }) => {
        calls.push(`compact ${options?.historyDays}`)
        if (compactFails) throw Object.assign(new Error('full'), { code: 'quota_exhausted' })
        return { generation: 2, chunksRemoved: 4, bytesRemoved: 400, commitsRemoved: 2 }
      },
    }
  }

  test('an App keeps ninety days unless it says otherwise', () => {
    expect(APP_HISTORY_DAYS).toBe(90)
  })

  test('a database is compacted once it holds versions a day past the window', async () => {
    const old = database(now - (APP_HISTORY_DAYS + 2) * DAY)
    expect(await compactWhenHistoryIsOld(old, APP_HISTORY_DAYS, now)).toBe(true)
    expect(old.calls).toEqual(['inspect', `compact ${APP_HISTORY_DAYS}`])
  })

  test('nothing is rewritten while every version is inside the window and its slack', async () => {
    for (const oldestMs of [now - APP_HISTORY_DAYS * DAY, now - (APP_HISTORY_DAYS + 1) * DAY, null]) {
      const recent = database(oldestMs)
      expect(await compactWhenHistoryIsOld(recent, APP_HISTORY_DAYS, now)).toBe(false)
      expect(recent.calls).toEqual(['inspect'])
    }
  })

  test('a lone old version is not rewritten, because compaction keeps the current one', async () => {
    const unchanged = database(now - 400 * DAY, false, 1)
    expect(await compactWhenHistoryIsOld(unchanged, APP_HISTORY_DAYS, now)).toBe(false)
    expect(unchanged.calls).toEqual(['inspect'])
  })

  test('the window is the one given, not the one the database was opened with', async () => {
    const weekly = database(now - 9 * DAY)
    expect(await compactWhenHistoryIsOld(weekly, 7, now)).toBe(true)
    expect(weekly.calls).toEqual(['inspect', 'compact 7'])
    const yearly = database(now - 200 * DAY)
    expect(await compactWhenHistoryIsOld(yearly, 365, now)).toBe(false)
    expect(yearly.calls).toEqual(['inspect'])
  })

  test('a compaction that fails leaves the database usable', async () => {
    const failing = database(now - 400 * DAY, true)
    const warn = console.warn
    console.warn = () => {}
    try {
      expect(await compactWhenHistoryIsOld(failing, APP_HISTORY_DAYS, now)).toBe(false)
    } finally {
      console.warn = warn
    }
    expect(failing.calls).toEqual(['inspect', `compact ${APP_HISTORY_DAYS}`])
  })

  /** Storage whose databases all hold a version from 400 days ago. */
  function oldStorage() {
    const compactions: Array<[string, number | undefined]> = []
    const opens: Array<string> = []
    return {
      compactions,
      opens,
      open: async (directory: string) => {
        opens.push(directory)
        const database = memoryDatabase()
        return {
          ...database,
          inspect: async () => ({
            ...(await database.inspect()),
            history: { commits: 2, oldestMs: Date.now() - 400 * DAY },
            // A handle that remembers no window of its own: what an App is
            // told is the one its own source declares, never this.
            historyDays: null,
          }),
          compact: async (options?: { historyDays?: number }) => {
            compactions.push([directory, options?.historyDays])
            return { generation: 2, chunksRemoved: 0, bytesRemoved: 0, commitsRemoved: 1 }
          },
        }
      },
    }
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

  test('a view compacts each database once, with the window it declares', async () => {
    const browser = oldStorage()
    const one = documentAppDatabases('doc-window', {
      open: browser.open,
      historyDays: { crm: 7 },
    })
    // The source changed before the App reached its databases.
    one.setHistoryDays({ crm: 365 })
    cleanups.push(one.dispose)
    await one.call('crm', 'inspect', undefined)
    await one.call('log', 'inspect', undefined)
    // Reached again: the view has looked for history to drop once already.
    await one.call('crm', 'inspect', undefined)
    await settle()
    expect(browser.compactions).toEqual([
      [appDatabaseDirectory('doc-window', 'crm'), 365],
      [appDatabaseDirectory('doc-window', 'log'), APP_HISTORY_DAYS],
    ])
  })

  test('opening the App again compacts, while a saved revision holds the database open', async () => {
    const browser = oldStorage()
    const directory = appDatabaseDirectory('doc-reopened', 'crm')
    const first = documentAppDatabases('doc-reopened', {
      open: browser.open,
      historyDays: { crm: 365 },
    })
    await first.call('crm', 'inspect', undefined)
    await settle()
    // A saved revision of the same App reaches the same database, and keeps it
    // open after the first view of the App goes away.
    const pinned = documentAppDatabases('doc-reopened', {
      open: browser.open,
      writable: false,
    })
    await pinned.call('crm', 'inspect', undefined)
    await settle()
    first.dispose()
    // The App is opened again, this time asking for a week.
    const again = documentAppDatabases('doc-reopened', {
      open: browser.open,
      historyDays: { crm: 7 },
    })
    cleanups.push(pinned.dispose, again.dispose)
    await again.call('crm', 'inspect', undefined)
    await settle()
    // One handle throughout, and each writable view of it compacted once.
    expect(browser.opens).toEqual([directory])
    expect(browser.compactions).toEqual([
      [directory, 365],
      [directory, 7],
    ])
  })

  test('a saved revision never compacts, and reports the window it declares', async () => {
    const browser = oldStorage()
    const revision = documentAppDatabases('doc-revision-window', {
      open: browser.open,
      writable: false,
      historyDays: { crm: 7 },
    })
    cleanups.push(revision.dispose)
    const plain = (await revision.call('constructor', 'inspect', undefined)) as { historyDays: number }
    expect(plain.historyDays).toBe(APP_HISTORY_DAYS)
    const crm = (await revision.call('crm', 'inspect', undefined)) as { historyDays: number }
    const log = (await revision.call('log', 'inspect', undefined)) as { historyDays: number }
    await settle()
    expect(browser.compactions).toEqual([])
    expect(crm.historyDays).toBe(7)
    expect(log.historyDays).toBe(APP_HISTORY_DAYS)
    const seen = await new Promise<{ historyDays: number }>((resolve) =>
      revision.subscribe('crm', { method: 'inspect', args: undefined }, resolve as never, () => {}),
    )
    expect(seen.historyDays).toBe(7)
  })
})
