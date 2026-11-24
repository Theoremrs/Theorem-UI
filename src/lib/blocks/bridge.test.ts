// SOURCING: bun:test over the capability bridge (bridge.ts), with a
// compiled cell and an in-memory workspace from test/blocks/.
import { afterEach, describe, expect, test } from 'bun:test'
import { loadCell } from '../../../test/blocks/load-cell'
import { memoryWorkspace } from '../../../test/blocks/memory-workspace'
import { checkPath, serveBridge } from './bridge'
import type { BridgeHost, StateCollections } from './bridge'
import { compileCell } from './compile'
import { noCapabilities } from './declarations'
import { inProcessExecutor } from './executor'
import type { CellExecutor } from './executor'
import { recordedAgentRuns, requestAgentRun } from './runs'
import { MAX_SNAPSHOT, call, rpcOver, serve } from './sandbox/protocol'
import type { DossierState, PageMethods, SandboxMethods } from './sandbox/protocol'
import { StateReplica } from './state'

const executors: Array<CellExecutor> = []
afterEach(() => {
  for (const executor of executors.splice(0)) executor.dispose()
})

function memoryState(): StateCollections {
  return new StateReplica({
    load: async () => null,
    push: async () => {},
    subscribe: () => () => {},
  })
}

const client = memoryWorkspace({
  'Data/habits.csv': 'date,habit,done\n2026-10-20,run,1\n2026-10-21,run,0\n',
  'Data/secret.txt': 'do not read',
  '.theorem/workspace.json': '{}',
})

/** Runs a block; `limited` serves it under a person's limit of its own declarations. */
async function run(
  source: string,
  inputs: Record<string, unknown> = {},
  limited = false,
) {
  const cell = await compileCell(source)
  const host: BridgeHost = {
    client,
    capabilities: limited ? cell.capabilities : undefined,
    state: memoryState(),
    run: (target) =>
      requestAgentRun({
        target,
        documentPath: 'Today.md',
        requestedBy: '#test',
        requestedAt: new Date().toISOString(),
      }),
  }
  const executor = inProcessExecutor(await loadCell(cell), host)
  executors.push(executor)
  return executor.run(inputs)
}

const limited = (source: string) => run(source, {}, true)

describe('the capability bridge', () => {
  test('a block reads the folder\'s files, as CSV rows', async () => {
    const outcome = await run(`const rows = await files.csv("Data/habits.csv")
const done = rows.filter((row) => row.done === 1).length`)
    expect(outcome.status).toBe('ok')
    expect(outcome.value).toEqual({
      rows: [
        { date: new Date('2026-10-20'), habit: 'run', done: 1 },
        { date: new Date('2026-10-21'), habit: 'run', done: 0 },
      ],
      done: 1,
    })
  })

  test('a block needs no declaration to read, list, write, keep state or start a run', async () => {
    const outcome = await run(`const text = await files.text("Data/secret.txt")
const listed = (await files.list("**")).map((file) => file.path)
await files.write("Data/open.txt", "written")
const habits = await state("habits")
await habits.set("run", { streak: 2 })
const streak = habits.get("run").streak
const result = await run("agent:#open")`)
    expect(outcome.status).toBe('ok')
    expect(outcome.value).toMatchObject({
      text: 'do not read',
      listed: expect.arrayContaining(['Data/habits.csv', 'Data/secret.txt']),
      streak: 2,
      result: { status: 'not-wired', target: 'agent:#open' },
    })
    expect(new TextDecoder().decode(client.files.get('Data/open.txt'))).toBe(
      'written',
    )
  })

  test('a person\'s limit keeps a module to the files it allows', async () => {
    const before = client.reads.length
    const outcome = await limited(
      `const text = await files.text("Data/secret.txt")`,
    )
    expect(outcome.status).toBe('error')
    expect(outcome.error?.message).toContain(
      'files.read("Data/secret.txt") is not among the files this module was allowed',
    )
    expect(client.reads.length).toBe(before)
  })

  test('a limit does not reach past its glob', async () => {
    const outcome = await limited(`// uses: files.read("Data/*.csv")
const text = await files.text("Data/secret.txt")`)
    expect(outcome.status).toBe('error')
    expect(outcome.error?.message).toContain('is not among the files')
  })

  test('paths outside the folder and hidden files are refused, limited or not', async () => {
    for (const target of [
      '../outside.txt',
      '/etc/passwd',
      '.theorem/workspace.json',
      'Data/../Data/secret.txt',
    ]) {
      const outcome = await run(
        `const text = await files.text(${JSON.stringify(target)})`,
      )
      expect(outcome.status).toBe('error')
      expect(outcome.error?.message).toMatch(/not a path inside the folder/)
    }
    expect(() => checkPath('a//b')).toThrow()
    expect(checkPath('Data/habits.csv')).toBe('Data/habits.csv')
  })

  test('under a limit, files.list returns only the allowed files', async () => {
    const outcome = await limited(`// uses: files.read("Data/*.csv")
const listed = (await files.list("**")).map((file) => file.path)`)
    expect(outcome.value).toEqual({ listed: ['Data/habits.csv'] })
  })

  test('under a limit, writes need their own allowance', async () => {
    const denied = await limited(`// uses: files.read("Data/*.csv")
await files.write("Data/out.txt", "hello")`)
    expect(denied.status).toBe('error')
    expect(client.files.has('Data/out.txt')).toBe(false)

    const allowed = await limited(`// uses: files.write("Data/out.txt")
await files.write("Data/out.txt", "hello")`)
    expect(allowed.status).toBe('ok')
    expect(new TextDecoder().decode(client.files.get('Data/out.txt'))).toBe(
      'hello',
    )
  })

  test('under a limit, state needs an allowance; it keeps JSON values', async () => {
    const denied = await limited(`const habits = await state("habits")`)
    expect(denied.error?.message).toContain(
      'state("habits") is not among the collections this module was allowed',
    )

    const outcome = await limited(`// uses: state("habits")
const habits = await state("habits")
await habits.set("run", { streak: 3 })
const streak = habits.get("run").streak`)
    expect(outcome.value).toMatchObject({ streak: 3 })
  })

  test('run() records the request and says agents are not wired; a limit can refuse it', async () => {
    const denied = await limited(`const result = await run("agent:#nightly")`)
    expect(denied.status).toBe('error')

    const outcome = await run(`const result = await run("agent:#nightly")`)
    expect(outcome.value).toMatchObject({
      result: { status: 'not-wired', target: 'agent:#nightly' },
    })
    expect(recordedAgentRuns().at(-1)?.target).toBe('agent:#nightly')
  })

  test('values that cannot be cloned stay in the block or are described', async () => {
    const outcome = await run(`const count = 2
const helper = () => count
const element = <b>hi</b>
const _private = 5
display({ helper, nested: { fn: Math.max } })`)
    expect(outcome.status).toBe('ok')
    // Functions and elements stay inside; underscore names are private.
    expect(outcome.value).toEqual({ count: 2 })
    expect(outcome.displayed).toBe(1)
  })

  test('an expression block is its value, described when it cannot be cloned', async () => {
    const outcome = await run(`(() => 1)`)
    expect(outcome.value).toEqual({
      $described: 'function',
      text: 'function (anonymous)',
    })
  })

  test('each line records its values for last-run display', async () => {
    const outcome = await run(`const a = 1
const b = a + 1
b * 10`)
    expect(outcome.traces).toEqual([
      { line: 1, variables: { a: 1 } },
      { line: 2, variables: { b: 2 } },
      { line: 3, variables: null, value: 20 },
    ])
    // A program block's value is its declarations, as in Observable; only an
    // expression block is its expression's value.
    expect(outcome.value).toEqual({ a: 1, b: 2 })
  })

  test('a block reads another block by name', async () => {
    const outcome = await run(`const total = habits.length * 2`, {
      habits: [1, 2, 3],
    })
    expect(outcome.value).toEqual({ total: 6 })
  })

  test('a frame sends its snapshot, up to the size limit', async () => {
    const snapshots: Array<string> = []
    const channel = new MessageChannel()
    const stop = serveBridge(rpcOver(channel.port1), {
      client,
      capabilities: noCapabilities(),
      state: memoryState(),
      run: () => Promise.reject(new Error('unused')),
      onSnapshot: (html) => snapshots.push(html),
    })
    const frame = rpcOver(channel.port2)
    await call<PageMethods, 'frame.snapshot'>(frame, 'frame.snapshot', {
      html: '<p>kept</p>',
    })
    const tooLarge = call<PageMethods, 'frame.snapshot'>(
      frame,
      'frame.snapshot',
      {
        html: 'x'.repeat(MAX_SNAPSHOT + 1),
      },
    )
    expect(
      await tooLarge.then(
        () => 'sent',
        () => 'refused',
      ),
    ).toBe('refused')
    expect(snapshots).toEqual(['<p>kept</p>'])
    stop()
    channel.port1.close()
    channel.port2.close()
  })
})

test('App selection stays bounded and is delivered as context without executing an action', async () => {
  const selections: unknown[] = []
  const channel = new MessageChannel()
  const host = {client,capabilities:noCapabilities(),state:memoryState(),
    run:()=>Promise.reject(new Error('must not execute')),onSelection:(value:unknown)=>selections.push(value)}
  const stop = serveBridge(rpcOver(channel.port1),host)
  const frame = rpcOver(channel.port2)
  try {
    await call<PageMethods,'frame.selection'>(frame,'frame.selection',{text:'Firefox',rowId:'firefox',field:'privacy'})
    expect(selections).toEqual([{text:'Firefox',rowId:'firefox',field:'privacy'}])
    const refused = await call<PageMethods,'frame.selection'>(frame,'frame.selection',{text:'x'.repeat(4097)}).then(()=>false,()=>true)
    expect(refused).toBe(true)
    expect(selections).toHaveLength(1)
    await call<PageMethods,'frame.selection'>(frame,'frame.selection',{text:'',entityId:'gpu-lane-7',entityLabel:'GPU lane 7'})
    expect(selections[1]).toEqual({text:'',entityId:'gpu-lane-7',entityLabel:'GPU lane 7'})
    // A view's selection carries the records' ids and its state.
    const view={text:'',entityLabel:'Alpha and 2 neighbours',ids:['a','b','c'],state:{graph1:'a',params:{k:7}}}
    await call<PageMethods,'frame.selection'>(frame,'frame.selection',view)
    expect(selections[2]).toEqual(view)
    const heavy = await call<PageMethods,'frame.selection'>(frame,'frame.selection',{text:'',state:{big:'x'.repeat(5000)}}).then(()=>false,()=>true)
    expect(heavy).toBe(true)
    expect(selections).toHaveLength(3)
  } finally { stop();channel.port1.close();channel.port2.close() }
})

test('a rejected App state save reaches the sandbox as a failure',async()=>{
  const channel=new MessageChannel()
  const state=memoryState()
  state.set=()=>Promise.reject(new Error('Document store unavailable'))
  const stop=serveBridge(rpcOver(channel.port1),{client,state,capabilities:{...noCapabilities(),state:['rows']},run:async()=>{throw new Error('unused')}})
  const frame=rpcOver(channel.port2)
  try {
    const result=await call<PageMethods,'state.set'>(frame,'state.set',{name:'rows',key:'one',value:'edit'}).then(()=> 'saved',error=>error.message)
    expect(result).toContain('Document store unavailable')
  } finally {stop();channel.port1.close();channel.port2.close()}
})

test('an App asks the page conversation through its dossier, and is told the replies', async () => {
  const channel = new MessageChannel()
  const asked: Array<{ text: string; context: unknown }> = []
  let listener: ((state: DossierState) => void) | undefined
  const now: DossierState = { available: true, running: false, messages: [] }
  const opened: Array<string> = []
  const host = {
    client, capabilities: noCapabilities(), state: memoryState(),
    run: () => Promise.reject(new Error('must not execute')),
    dossier: {
      ask: async (text: string, context: Record<string, unknown>) => void asked.push({ text, context }),
      state: () => now,
      subscribe: (next: (state: DossierState) => void) => { listener = next; return () => { listener = undefined } },
      source: (name: string) => { opened.push(name); return name === 'alu' },
    },
  }
  const stop = serveBridge(rpcOver(channel.port1), host)
  const frame = rpcOver(channel.port2)
  const told: Array<DossierState> = []
  serve<SandboxMethods, 'dossier.changed'>(frame, 'dossier.changed', (state) => { told.push(state); return null })
  try {
    expect(await call<PageMethods, 'dossier.watch'>(frame, 'dossier.watch', {})).toEqual(now)
    await call<PageMethods, 'dossier.ask'>(frame, 'dossier.ask', { text: 'Why is the result 12?', context: { selected: { id: 'alu' } } })
    expect(asked).toEqual([{ text: 'Why is the result 12?', context: { selected: { id: 'alu' } } }])
    const empty = await call<PageMethods, 'dossier.ask'>(frame, 'dossier.ask', { text: '   ', context: {} }).then(() => false, () => true)
    expect(empty).toBe(true)
    const replied: DossierState = { available: true, running: true, messages: [{ id: 'a', role: 'assistant', text: 'Because', status: 'running' }] }
    listener!(replied)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(told).toEqual([replied])
    expect(await call<PageMethods, 'dossier.source'>(frame, 'dossier.source', { name: 'alu' })).toEqual({ found: true })
    expect(opened).toEqual(['alu'])
  } finally { stop(); channel.port1.close(); channel.port2.close() }
  expect(listener).toBeUndefined()
})

test('outside a conversation an App is told there is none, and its questions are refused', async () => {
  const channel = new MessageChannel()
  const stop = serveBridge(rpcOver(channel.port1), { client, capabilities: noCapabilities(), state: memoryState(), run: () => Promise.reject(new Error('unused')) })
  const frame = rpcOver(channel.port2)
  try {
    expect(await call<PageMethods, 'dossier.watch'>(frame, 'dossier.watch', {})).toEqual({ available: false, running: false, messages: [] })
    const refused = await call<PageMethods, 'dossier.ask'>(frame, 'dossier.ask', { text: 'hello', context: {} }).then(() => '', (error: Error) => error.message)
    expect(refused).toContain('not shown in a conversation')
  } finally { stop(); channel.port1.close(); channel.port2.close() }
})

test('an App has its model trace written as a recording, and a malformed trace is refused', async () => {
  const channel = new MessageChannel()
  const written: Array<unknown> = []
  const host = {
    client, capabilities: noCapabilities(), state: memoryState(),
    run: () => Promise.reject(new Error('unused')),
    recording: async (trace: unknown) => {
      written.push(trace)
      return new Uint8Array([82, 82, 70, 50])
    },
  }
  const stop = serveBridge(rpcOver(channel.port1), host)
  const frame = rpcOver(channel.port2)
  const trace = { recordingId: 'spatial-a:0', frames: [{ cycle: 0, cause: 'start', values: { adder: { carry: 1, op: 'add' } } }] }
  try {
    const bytes = await call<PageMethods, 'trace.recording'>(frame, 'trace.recording', trace)
    expect([...bytes]).toEqual([82, 82, 70, 50])
    expect(written).toEqual([trace])
    const nested = { ...trace, frames: [{ ...trace.frames[0]!, values: { adder: { carry: { deep: 1 } } } }] }
    const refused = await call<PageMethods, 'trace.recording'>(frame, 'trace.recording', nested as never).then(() => false, () => true)
    expect(refused).toBe(true)
    expect(written).toHaveLength(1)
    // A recording that opens says how the viewer lays it out.
    const laidOut = { ...trace, layout: { plots: [{ title: 'Carry', ports: [{ part: 'adder', port: 'carry' }] }] } }
    await call<PageMethods, 'trace.recording'>(frame, 'trace.recording', laidOut)
    expect(written.at(-1)).toEqual(laidOut)
    const loose = { ...trace, layout: { plots: [{ title: 'Carry', ports: ['adder.carry'] }] } }
    const looseRefused = await call<PageMethods, 'trace.recording'>(frame, 'trace.recording', loose as never).then(() => false, () => true)
    expect(looseRefused).toBe(true)
  } finally { stop(); channel.port1.close(); channel.port2.close() }
})

test('where no backend writes recordings, a trace is refused in words', async () => {
  const channel = new MessageChannel()
  const stop = serveBridge(rpcOver(channel.port1), { client, capabilities: noCapabilities(), state: memoryState(), run: () => Promise.reject(new Error('unused')) })
  const frame = rpcOver(channel.port2)
  try {
    const refused = await call<PageMethods, 'trace.recording'>(frame, 'trace.recording', { recordingId: 'r', frames: [] }).then(() => '', (error: Error) => error.message)
    expect(refused).toContain('no Theorem backend writes recordings')
  } finally { stop(); channel.port1.close(); channel.port2.close() }
})
