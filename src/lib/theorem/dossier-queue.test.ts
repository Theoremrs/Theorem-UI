// SOURCING: bun:test over dossier-queue.ts, with a real question binding from
// app-dossier over an App document in test/blocks/.
import { expect, test } from 'bun:test'
import { appDocumentFixture } from '../../../test/blocks/app-documents'
import { AppDocument } from './apps'
import { questionBinding } from './app-dossier'
import { hold, queued, sent, undelivered, useDossierQueue } from './dossier-queue'
import type { Queued } from './dossier-queue'

const reset = () => useDossierQueue.setState({ buckets: {} })

/** The revision a question was asked about, resolved the way asking resolves it. */
async function asked() {
  const store = await appDocumentFixture()
  const snapshot = await new AppDocument('app-document', store.api, store.change).load()
  return questionBinding({ snapshot }, snapshot, {})
}

/** A question asked from one App in one conversation. What it was asked about is
 * the same for all of them: the store holds it with the conversation and App it
 * belongs to, which is what these read back. */
const askedIn = async (
  conversation: string | undefined,
  documentId: string,
  text: string,
): Promise<Queued> => ({
  id: `queued:${text}`,
  text,
  context: {},
  asked: await asked(),
  conversation,
  documentId,
})

test('questions are held with the conversation and the App they were asked from', async () => {
  reset()
  const [first, second] = [
    await askedIn('thread-a', 'doc-1', 'Why is the top row red?'),
    await askedIn('thread-a', 'doc-1', 'Add a column for price'),
  ]
  const elsewhere = await askedIn('thread-b', 'doc-1', 'Asked in another conversation')
  const otherApp = await askedIn('thread-a', 'doc-2', 'Asked of another App')
  const unopened = await askedIn(undefined, 'doc-1', 'Asked where no conversation is open')
  for (const question of [first, elsewhere, second, otherApp, unopened])
    hold(question)
  // Asked first, held first: one App's questions keep the order they were asked.
  expect(queued('thread-a', 'doc-1')).toEqual([first, second])
  expect(queued('thread-b', 'doc-1')).toEqual([elsewhere])
  expect(queued('thread-a', 'doc-2')).toEqual([otherApp])
  expect(queued(undefined, 'doc-1')).toEqual([unopened])
  // A conversation or an App with nothing waiting has nothing waiting.
  expect(queued('thread-c', 'doc-1')).toEqual([])
  expect(queued('thread-b', 'doc-2')).toEqual([])
})

test('a question that has gone leaves the queue, and an emptied place is forgotten', async () => {
  reset()
  const [first, second] = [
    await askedIn('thread-a', 'doc-1', 'first'),
    await askedIn('thread-a', 'doc-1', 'second'),
  ]
  hold(first)
  hold(second)
  sent(first)
  expect(queued('thread-a', 'doc-1')).toEqual([second])
  sent(second)
  // Nothing is kept for a conversation whose questions have all gone, so the
  // store does not grow with every question a page ever asked.
  expect(queued('thread-a', 'doc-1')).toEqual([])
  expect(useDossierQueue.getState().buckets).toEqual({})
  // Recording a send of what is not held brings nothing back.
  sent(first)
  expect(useDossierQueue.getState().buckets).toEqual({})
})

test('one that could not be sent stays, marked with why, where it was', async () => {
  reset()
  const [first, second, third] = [
    await askedIn('thread-a', 'doc-1', 'first'),
    await askedIn('thread-a', 'doc-1', 'second'),
    await askedIn('thread-a', 'doc-1', 'third'),
  ]
  hold(first)
  hold(second)
  undelivered(first, 'This App is not shown in a conversation.')
  expect(queued('thread-a', 'doc-1')).toEqual([
    { ...first, failed: 'This App is not shown in a conversation.' },
    second,
  ])
  // A question asked after it is held behind it, and the marked one is not lost.
  hold(third)
  expect(queued('thread-a', 'doc-1').map((question) => question.text)).toEqual([
    'first',
    'second',
    'third',
  ])
  // Marking one that is not held changes nothing.
  const unheld = await askedIn('thread-z', 'doc-9', 'unheld')
  undelivered(unheld, 'gone')
  expect(queued('thread-z', 'doc-9')).toEqual([])
})

test('a held question outlives every view of the App that asked it', async () => {
  reset()
  const question = await askedIn('thread-a', 'doc-1', 'Why is the top row red?')
  hold(question)
  // Views come and go — a revision flip unmounts one and mounts the next, which
  // is only subscribing to this store and unsubscribing — and none of them takes
  // the question with it.
  for (let view = 0; view < 3; view += 1) {
    const unsubscribe = useDossierQueue.subscribe(() => {})
    unsubscribe()
    expect(queued('thread-a', 'doc-1')).toEqual([question])
  }
})