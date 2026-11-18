// SOURCING: bun:test over app-dossier.ts, with an App document from test/blocks/.
import { expect, test } from 'bun:test'
import { appDocumentFixture } from '../../../test/blocks/app-documents'
import { AppDocument } from './apps'
import {
  DOSSIER_METADATA,
  MAX_REFERENCE_BYTES,
  dossierReference,
  dossierState,
  sourceOf,
} from './app-dossier'
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
