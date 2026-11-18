// SOURCING: bun:test over app-dossier.ts, with an App document from test/blocks/.
import { expect, test } from 'bun:test'
import { appDocumentFixture } from '../../../test/blocks/app-documents'
import { AppDocument } from './apps'
import {
  discoveredOperations,
  markUndelivered,
  withHeld,
  DOSSIER_METADATA,
  MAX_REFERENCE_BYTES,
  dossierReference,
  dossierState,
  questionBinding,
  sourceOf,
} from './app-dossier'
import { ARTIFACT_RUNTIME_SCHEMA, digestOf, resultRef } from '../blocks/artifact-runtime'
import type { ObservationRef } from '../blocks/artifact-runtime'
import type { ConversationMessage } from './app-dossier'
import { CONTEXT_REFERENCES_METADATA } from './message-history'

async function loaded() {
  const store = await appDocumentFixture()
  return new AppDocument('app-document', store.api, store.change).load()
}

test('a question names the App revision, the part the App says is selected, and its account of where the person is', async () => {
  const snapshot = await loaded()
  const context = { selected: { id: 'cpu/alu', label: 'ALU' }, outputs: [{ name: 'result', text: '12' }], step: { stage: 3 } }
  const reference = dossierReference(snapshot, context)
  expect(reference.location).toEqual({
    resource: { kind: 'graph-object', objectId: snapshot.documentId, objectType: 'theorem.app' },
    revision: String(snapshot.revision.position),
  })
  expect(reference.label).toContain('ALU')
  expect(JSON.parse(reference.excerpt!)).toEqual({
    selection: { text: '', entityId: 'cpu/alu', entityLabel: 'ALU' },
    dossier: context,
  })
})

test('what does not fit the backend limit is left out, largest first, and named', async () => {
  const snapshot = await loaded()
  const context = { selected: { id: 'alu' }, history: 'x'.repeat(12_000), outputs: [{ name: 'carry', text: '1' }] }
  const reference = dossierReference(snapshot, context)
  expect(new TextEncoder().encode(JSON.stringify(reference)).length).toBeLessThanOrEqual(MAX_REFERENCE_BYTES)
  const { dossier } = JSON.parse(reference.excerpt!)
  expect(dossier.history).toBeUndefined()
  expect(dossier.omitted).toEqual(['history'])
  expect(dossier.outputs).toEqual(context.outputs)
})

const user = (id: string, text: string, documentId?: string): ConversationMessage => ({
  id, role: 'user', content: [{ type: 'text', text }],
  metadata: { custom: documentId ? { [DOSSIER_METADATA]: { documentId } } : {} },
})
const reply = (id: string, text: string, status = 'complete'): ConversationMessage => ({
  id, role: 'assistant', content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text }], status: { type: status },
})

test("an App is shown its own questions and the replies to them, and nothing else of the conversation", () => {
  const messages = [
    user('1', 'Plan my week'),
    reply('2', 'Here is a plan'),
    user('3', 'Why did carry turn on?', 'doc-a'),
    reply('4', 'Because A plus B overflowed'),
    user('5', 'What about this chart?', 'doc-b'),
    reply('6', 'It shows'),
    user('7', 'Change register B to 3', 'doc-a'),
    reply('8', 'Revising', 'running'),
  ]
  const state = dossierState(messages, 'doc-a')
  expect(state.messages.map(({ id }) => id)).toEqual(['3', '4', '7', '8'])
  expect(state.messages[1]).toEqual({ id: '4', role: 'assistant', text: 'Because A plus B overflowed', status: 'complete' })
  expect(state.running).toBe(true)
  expect(state.available).toBe(true)
  expect(dossierState([], 'doc-a', false)).toEqual({ available: false, running: false, messages: [] })
})

test("a part's implementation is found where its name is written as a string", () => {
  const files = {
    'README.md': "'alu'",
    'main.tsx': "import { parts } from '@theorem/spatial'\n\nconst model = {\n  id: 'alu',\n}",
    'other.ts': '"alu"',
  }
  expect(sourceOf(files, 'alu')).toEqual({ file: 'main.tsx', line: 4 })
  expect(sourceOf(files, 'decoder')).toBeUndefined()
})

test('loaded again, a question is found by the dossier reference it was sent with, and a repair or a plain ask is not', async () => {
  const snapshot = await loaded()
  const sent = (id: string, text: string, reference: unknown): ConversationMessage => ({
    id, role: 'user', content: [{ type: 'text', text }],
    metadata: { custom: { [CONTEXT_REFERENCES_METADATA]: [reference] } },
  })
  const asked = dossierReference(snapshot, { selected: { id: 'adder', label: 'Adder' } })
  const repair = { ...asked, excerpt: JSON.stringify({ repair: { error: 'boom' } }) }
  const plain = { ...asked, excerpt: JSON.stringify({ selection: { text: '', entityId: 'adder' } }) }
  const state = dossierState([
    sent('1', 'Why did carry turn on?', asked),
    reply('2', 'Bit 0 generated it'),
    sent('3', 'Fix it', repair),
    reply('4', 'Fixed'),
    sent('5', 'What is this?', plain),
    reply('6', 'An adder'),
  ], snapshot.documentId)
  expect(state.messages.map((message) => message.text)).toEqual(['Why did carry turn on?', 'Bit 0 generated it'])
  expect(dossierState([sent('1', 'Why?', asked)], 'another-app').messages).toEqual([])
})

test('a dossier reference cut down to its selection is still marked as the dossier\'s', async () => {
  const snapshot = await loaded()
  const reference = dossierReference(snapshot, { selected: { id: 'alu', label: 'x'.repeat(9_000) }, huge: 'y'.repeat(9_000) })
  expect(JSON.parse(reference.excerpt!).dossier).toBeDefined()
})

const moment = async (index: string): Promise<ObservationRef> => ({
  schema: ARTIFACT_RUNTIME_SCHEMA,
  runId: 'spatial-x:0',
  index,
  domain: 'settlement',
  time: index,
  stateDigest: await digestOf({ index }),
})

test('a question about a revision that failed to build names the revision running, and says a newer one failed', async () => {
  const running = await loaded()
  const failed = {
    ...running,
    html: `${running.html}<!-- broken -->`,
    revision: { ...running.revision, position: Number(running.revision.position) + 1, contentDigest: 'newer' },
  }
  const observation = await moment('3')
  const { running: named, binding } = questionBinding(
    { snapshot: running, status: 'failed' },
    failed,
    { observation, run: { id: 'spatial-x:0', engine: { kind: 'theorem.spatial-settle' } } },
  )
  expect(named).toBe(running)
  expect(binding.presentation.source).toEqual({
    kind: 'document',
    documentId: running.documentId,
    position: String(running.revision.position),
    contentDigest: running.revision.contentDigest,
  })
  // The run was computed by the revision running, whatever was saved since.
  expect(binding.subject?.kind === 'moment' && binding.subject.run?.source).toEqual(binding.presentation.source)
  expect(binding.latest).toEqual({
    source: { kind: 'document', documentId: running.documentId, position: String(failed.revision.position), contentDigest: 'newer' },
    status: 'failed',
  })
  expect(binding.subject).toMatchObject({ kind: 'moment', observation })
  // A reference built from it names the running revision too.
  expect(dossierReference(named, {}, binding).location.revision).toBe(String(running.revision.position))
})

test('a state-only save names the newest revision, since its page is the one running', async () => {
  const running = await loaded()
  const saved = { ...running, revision: { ...running.revision, position: Number(running.revision.position) + 1 } }
  const { running: named, binding } = questionBinding({ snapshot: running }, saved, {})
  expect(named).toBe(saved)
  expect(binding.latest).toBeUndefined()
})

test('a question cannot be asked before any revision has built', async () => {
  expect(() => questionBinding({}, null, {})).toThrow('has not built')
})

test('the moment and run a question names are kept whole when its account is cut down to fit', async () => {
  const snapshot = await loaded()
  const observation = await moment('7')
  const facts = Array.from({ length: 96 }, (_, index) => ({ entity: `add/fa${index}`, key: 'cout', value: { type: 'integer', text: '1' }, text: '1' }))
  const context = { selected: { id: 'add' }, observation, run: { id: 'spatial-x:0' }, facts, history: 'h'.repeat(6_000) }
  const binding = questionBinding({ snapshot }, snapshot, context).binding
  const reference = dossierReference(snapshot, context, binding)
  expect(new TextEncoder().encode(JSON.stringify(reference)).length).toBeLessThanOrEqual(MAX_REFERENCE_BYTES)
  const excerpt = JSON.parse(reference.excerpt!)
  expect(excerpt.binding.subject.observation).toEqual(observation)
  expect(excerpt.binding.selection).toEqual({ schema: 'theorem.entity-id', version: '1', value: 'add' })
  expect(excerpt.dossier.observation).toEqual(observation)
  expect(excerpt.dossier.omitted).toEqual(['history'])
  // Facts are shortened from the end, never all dropped, and say how many went.
  expect(excerpt.dossier.facts.length).toBeGreaterThan(0)
  expect(excerpt.dossier.facts.length + excerpt.dossier.factsOmitted).toBe(96)
  expect(excerpt.dossier.facts[0].entity).toBe('add/fa0')
})

test('loaded again, a question and its reply keep the moment it was asked about', async () => {
  const snapshot = await loaded()
  const observation = await moment('2')
  const context = { selected: { id: 'add' }, observation }
  const reference = dossierReference(snapshot, context, questionBinding({ snapshot }, snapshot, context).binding)
  const asked: ConversationMessage = {
    id: '1', role: 'user', content: [{ type: 'text', text: 'Why?' }],
    metadata: { custom: { [CONTEXT_REFERENCES_METADATA]: [reference] } },
  }
  const state = dossierState([asked, reply('2', 'Because')], snapshot.documentId)
  expect(state.messages.map((message) => message.subject)).toEqual([
    { kind: 'moment', observation },
    { kind: 'moment', observation },
  ])
})

test('an App with no simulator asks about its own data, at the version it showed, with its own selection', async () => {
  const snapshot = await loaded()
  const rows = [{ id: 'r2', resource: 'scope', start: '2026-11-18T10:00:00Z', end: '2026-11-18T11:00:00Z' }]
  const result = await resultRef({
    content: await digestOf(rows),
    mediaType: 'application/json',
    provenance: { kind: 'captured', capturedAt: '2026-11-18T19:30:00Z', from: { system: 'reservations', version: '412' }, unknowns: [] },
  })
  const context = {
    subject: { kind: 'result', result },
    selection: { schema: 'reservations.row', version: '1', value: { id: 'r2' }, label: 'Scope 10:00' },
  }
  const { binding } = questionBinding({ snapshot }, snapshot, context)
  expect(binding.subject).toEqual({ kind: 'result', result })
  expect(binding.selection).toEqual(context.selection)
  expect(JSON.stringify(binding)).not.toMatch(/"(runId|observation|checkpoint|time)"/)

  // Loaded again after the data moved on, the question and its reply keep version 412.
  const reference = dossierReference(snapshot, context, binding)
  const asked: ConversationMessage = {
    id: '1', role: 'user', content: [{ type: 'text', text: 'Why does this conflict?' }],
    metadata: { custom: { [CONTEXT_REFERENCES_METADATA]: [reference] } },
  }
  const state = dossierState([asked, reply('2', 'It overlaps r1')], snapshot.documentId)
  expect(state.messages.map((message) => message.subject)).toEqual([
    { kind: 'result', result },
    { kind: 'result', result },
  ])
})

test('an App that names an unreadable subject is asked about its revision, not a guessed one', async () => {
  const snapshot = await loaded()
  const { binding } = questionBinding({ snapshot }, snapshot, { subject: { kind: 'result', result: { id: 'x' } } })
  expect(binding.subject).toBeUndefined()
})

test('operations an App defines are discovered with where they are written', () => {
  const files = { 'solver.ts': "import x from 'y'\n\nexport const solve = define({ name: 'solve', version: '2' })\n" }
  const operations = discoveredOperations(
    { operations: [{ name: 'solve', version: '2', summary: 'Solve', recovery: ['rerun'] }, { name: 42 }] },
    files,
  )
  expect(operations as Array<unknown>).toEqual([
    { name: 'solve', version: '2', summary: 'Solve', recovery: ['rerun'], source: { file: 'solver.ts', line: 3 } },
  ])
})

test('a run another revision executed keeps its own source when a newer presentation shows it', async () => {
  const snapshot = await loaded()
  const solver = { kind: 'commit' as const, repository: 'travis-gilbert/heat-solver', commit: 'a1b2c3d4e5f6' }
  const observation = await moment('4')
  const { binding } = questionBinding({ snapshot }, snapshot, {
    observation,
    run: { id: 'spatial-x:0', source: solver, engine: { kind: 'heat.fd' } },
  })
  expect(binding.subject?.kind === 'moment' && binding.subject.run?.source).toEqual(solver)
  expect(binding.presentation.source).toMatchObject({ kind: 'document', documentId: snapshot.documentId })
})

test('a long list of parts that never settled is shortened, never dropped, and the binding stays', async () => {
  const snapshot = await loaded()
  const observation = await moment('5')
  const unsettled = Array.from({ length: 700 }, (_, index) => `cpu/loop${index}/inverter`)
  const context = {
    selected: { id: 'cpu' },
    observation,
    run: { id: 'spatial-x:0' },
    settled: false,
    unsettled,
    facts: [{ entity: 'cpu', key: 'a', value: { type: 'integer', text: '1' }, text: '1' }],
  }
  const { binding } = questionBinding({ snapshot }, snapshot, context)
  const reference = dossierReference(snapshot, context, binding)
  expect(new TextEncoder().encode(JSON.stringify(reference)).length).toBeLessThanOrEqual(MAX_REFERENCE_BYTES)
  const excerpt = JSON.parse(reference.excerpt!)
  expect(excerpt.binding.subject.observation).toEqual(observation)
  expect(excerpt.dossier.settled).toBe(false)
  expect(excerpt.dossier.unsettled.length).toBeGreaterThan(0)
  expect(excerpt.dossier.unsettled.length + excerpt.dossier.unsettledOmitted).toBe(700)
  expect(excerpt.dossier.facts.length + (excerpt.dossier.factsOmitted ?? 0)).toBe(1)
})

test('a reference whose required part cannot fit fails loudly instead of losing it', async () => {
  const snapshot = await loaded()
  const context = { selection: { schema: 'x', version: '1', value: 'v' }, subject: { kind: 'source', source: { kind: 'commit', repository: 'r', commit: 'c'.repeat(9000) } } }
  expect(() => dossierReference(snapshot, context, questionBinding({ snapshot }, snapshot, context).binding)).toThrow('more than the 8192')
})

test('a held question that could not be sent stays shown with why, keeping its subject', async () => {
  const observation = await moment('3')
  const held = [
    { id: 'q1', text: 'First', context: { observation } },
    { id: 'q2', text: 'Second', context: {} },
  ]
  const base = { available: true, running: false, messages: [] }
  const failed = markUndelivered(held, 'q1', 'This App is not shown in a conversation.')
  const state = withHeld(base, failed)
  expect(state.messages).toEqual([
    { id: 'q1', role: 'user', text: 'First', status: 'incomplete', undelivered: 'This App is not shown in a conversation.', subject: { kind: 'moment', observation } },
    { id: 'q2', role: 'user', text: 'Second', status: 'complete', queued: true },
  ])
  expect(state.running).toBe(true)
  expect(withHeld(base, markUndelivered(failed, 'q2', 'gone')).running).toBe(false)
  expect(withHeld(base, [])).toBe(base)
})
