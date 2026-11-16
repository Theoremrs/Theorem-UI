// SOURCING: playwright-core through ./lib, the stack's own typed APIs through the signed-in browser, and scripts/e2e/context-standin.mjs as the model provider.
//
// The CRM's central claim, whole and mounted: an edit made in the CRM screen
// changes what an ordinary conversation sends to the model, at the exact saved
// revision, and what is kept from Theorem never leaves.
//
// Start the stack with E2E_CONTEXT_STANDIN=1. Every model call then goes to
// the stand-in, which keeps the request it was sent and answers only from the
// saved records in it. Nothing here is a real person's data and no real
// provider is called.
//
//   E2E_CONTEXT_STANDIN=1 E2E_SERVER_BIN=<rustyred-thg-server> node scripts/e2e/stack.mjs
//   node scripts/e2e/crm-context.mjs
//
// The requests the provider received are written, whole, to
// <E2E_DATA_DIR>/crm-context-requests.json.
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, OTHER_ACCOUNT, STANDIN, UI } from './config.mjs'
import { READ, SHOTS, check, finish, log, open } from './lib.mjs'
import { turns } from './turns.mjs'

const BUILT_IN = [
  'Person',
  'Organization',
  'Activity',
  'Commitment',
  'Interaction',
  'Goal',
  'Constraint',
]
const PHONE = '555-0100'
const PRIVATE_NOTE = 'Noor mentioned the studio may close'
const OTHER_WORKSPACE = "Blake's landlord"
const QUESTION = 'When is the materials list for Noor due?'
const FOLLOW_UP =
  'Has that changed? When is the materials list for Noor due now?'
const RECORD_SOURCE = 'life_context_record'

const RECORD_VERB = `mutation RecordVerb($objectTypeId: String!, $verb: String!, $input: JSON!) {
  invokeRecordVerb(objectTypeId: $objectTypeId, verb: $verb, input: $input)
}`

/** Theorem's typed record API, as the signed-in browser reaches it. */
function records(session) {
  const { writing } = turns(session)
  async function graphql(query, variables = {}) {
    const response = await session.context.request.fetch(`${UI}/graphql`, {
      ...READ,
      method: 'POST',
      headers: await writing({ 'Content-Type': 'application/json' }),
      data: { query, variables },
    })
    const body = await response.json().catch(() => ({}))
    if (body.errors?.length || !body.data)
      throw new Error(
        `GraphQL refused: ${JSON.stringify(body.errors ?? response.status())}`,
      )
    return body.data
  }
  const verb = async (objectTypeId, name, input) => {
    const out = (
      await graphql(RECORD_VERB, { objectTypeId, verb: name, input })
    ).invokeRecordVerb
    return out?.record ?? out
  }
  const types = async () =>
    (await graphql('{ dataModel(includeObserved: false) { objectTypes } }'))
      .dataModel.objectTypes
  return { graphql, types, verb }
}

/** Install the built-in types and remove every record of them, so a run starts clean. */
async function reset(api) {
  await api.graphql('mutation { installLifeContextTypes }')
  const byName = Object.fromEntries(
    (await api.types()).map((type) => [type.name_singular, type]),
  )
  for (const name of BUILT_IN) {
    const type = byName[name]
    const page = await api.verb(type.object_type_id, 'find_many', {
      limit: 1000,
      offset: 0,
    })
    for (const record of page.records ?? [])
      await api.verb(type.object_type_id, 'delete_one', {
        id: record.id,
        expected_revision: record.version,
      })
  }
  return byName
}

const requests = async () => (await fetch(`${STANDIN}/__requests`)).json()

/** The provider requests that carry this person's question, oldest first. */
const asked = (all, text) =>
  all.filter((request) =>
    (request.body?.messages ?? []).some(
      (message) =>
        message.role === 'user' &&
        JSON.stringify(message.content).includes(text),
    ),
  )

const spanOf = (request, recordId) =>
  request?.recordSpans.find((span) => span.provenance?.recordId === recordId)

// Another person's workspace holds a contact of the same name. It is created
// first, so it is there to be leaked for the whole run.
const other = await open('/crm', { account: OTHER_ACCOUNT })
const otherApi = records(other)
const otherTypes = await reset(otherApi)
const run = randomUUID().slice(0, 8)
await otherApi.verb(otherTypes.Person.object_type_id, 'create_one', {
  id: `person:noor-other-${run}`,
  name: 'Noor',
  role: OTHER_WORKSPACE,
})
check('another workspace holds a contact named Noor', true)
await other.browser.close()

const session = await open('/crm')
const { page, problems } = session
const api = records(session)
const chat = turns(session)

// The dev server serves the app as hundreds of separate modules, and now and
// then a full page load after a turn comes up blank because one of them did
// not arrive. That is a load to try again, not a result, so a record page is
// opened through `shows`, which says what failed and how many loads it took.
const dropped = []
page.on('requestfailed', (request) =>
  dropped.push(`${request.failure()?.errorText} ${request.url()}`),
)
async function arrives(load, text) {
  for (let loads = 1; ; loads++) {
    dropped.length = 0
    await load()
    const shown = await page
      .getByText(text)
      .first()
      .waitFor({ timeout: 45_000 })
      .then(
        () => true,
        () => false,
      )
    if (shown) return loads
    log('the page did not load; requests that failed:', dropped.slice(0, 5))
    if (loads === 4) {
      await shot('load-failed')
      throw new Error(`the page never showed "${text}"`)
    }
  }
}
const shows = (load, revision) => arrives(load, `Saved revision ${revision}`)
const shot = (name) =>
  page.screenshot({ path: join(SHOTS, `crm-context-${name}.png`) })

// The fixture: Avery, Noor, what Avery owes Noor, when Avery can be called,
// a source note, and one note Avery keeps private.
const types = await reset(api)
const id = (name) => `${name}-${run}`
const create = (type, input) =>
  api.verb(types[type].object_type_id, 'create_one', input)
const avery = id('person:avery')
const noor = id('person:noor')
const workshop = id('activity:workshop')
const commitment = id('commitment:materials')
await create('Person', { id: avery, name: 'Avery Quinn' })
await api.graphql(
  'mutation Me($id: String!) { bindSelfPerson(recordId: $id) }',
  { id: avery },
)
await create('Organization', { id: id('org:kiln'), name: 'Kiln Street Studio' })
await create('Person', {
  id: noor,
  name: 'Noor',
  phone: PHONE,
  organization: id('org:kiln'),
  role: 'Runs the glaze workshop with me',
})
await create('Activity', {
  id: workshop,
  name: 'Glaze workshop',
  status: 'planned',
  people: [noor, avery],
})
const saved = await create('Commitment', {
  id: commitment,
  title: 'Send Noor the materials list',
  owed_by: avery,
  owed_to: noor,
  activity: workshop,
  due: 'Wednesday',
  status: 'open',
})
await create('Constraint', {
  id: id('constraint:mornings'),
  statement: 'No calls before 10am',
  kind: 'availability',
  applies_to: avery,
})
await create('Interaction', {
  id: id('interaction:planning'),
  summary: 'Planning call for the workshop',
  kind: 'call',
  people: [noor],
  activity: workshop,
  notes: 'Noor asked for the materials list before she orders glaze.',
})
await create('Interaction', {
  id: id('interaction:private'),
  summary: PRIVATE_NOTE,
  people: [noor],
  context_use: 'private',
})
log('fixture saved; the commitment is at revision', saved.version)

// The screen shows the saved records.
await page.goto(`${UI}/crm/people`, {
  waitUntil: 'domcontentloaded',
  timeout: 120_000,
})
await page
  .getByRole('grid', { name: 'All People' })
  .waitFor({ timeout: 120_000 })
// The grid is there before its rows are; wait for the row, not the frame.
check(
  'the People table lists Noor',
  await page
    .getByRole('grid')
    .getByText('Noor', { exact: true })
    .first()
    .waitFor({ timeout: 60_000 })
    .then(
      () => true,
      () => false,
    ),
)
check(
  'and says which record is the person signed in',
  await page.getByText('You', { exact: true }).first().isVisible(),
)
await shot('1-people')

// Phone numbers are kept from Theorem, in the screen.
await page.getByRole('button', { name: 'Options' }).click()
const keepPhone = page.getByRole('menuitemcheckbox', {
  name: 'Theorem may read Phone',
})
await keepPhone.waitFor({ timeout: 30_000 })
// An earlier run against the same store may have left the phone kept back
// already; a click then would hand it over again.
if ((await keepPhone.getAttribute('aria-checked')) === 'true')
  await keepPhone.click()
const personType = async () =>
  (await api.types()).find((type) => type.name_singular === 'Person')
const keptBack = (type) =>
  (type.extensions?.['theorem.context']?.excluded_fields ?? []).includes(
    'phone',
  )
// What counts is the saved type, not the menu: wait for the store to hold it.
let personNow = await personType()
for (let look = 0; look < 30 && !keptBack(personNow); look++) {
  await page.waitForTimeout(1_000)
  personNow = await personType()
}
await page.waitForFunction(
  (item) => item?.getAttribute('aria-checked') === 'false',
  await keepPhone.elementHandle(),
  { timeout: 30_000 },
)
await shot('2-phone-kept-back')
await page.keyboard.press('Escape')
check(
  'the Person type now keeps phone from Theorem',
  keptBack(personNow),
  JSON.stringify(personNow.extensions?.['theorem.context']),
)

// Before the edit: an ordinary conversation is given Wednesday.
await fetch(`${STANDIN}/__requests`, { method: 'DELETE' })
// A full load of the dev server sometimes comes up blank; load it again.
async function home() {
  for (let loads = 1; ; loads++) {
    dropped.length = 0
    await page.goto(UI, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    const ready = await page
      .getByRole('textbox')
      .first()
      .waitFor({ timeout: 45_000 })
      .then(
        () => true,
        () => false,
      )
    if (ready) return
    log('Home did not load; requests that failed:', dropped.slice(0, 5))
    if (loads === 4) throw new Error('Home never showed the composer')
  }
}
await home()
await chat.send(QUESTION)
const before = await chat.ended()
check(
  'the first turn finishes',
  before?.outcome === 'completed',
  before?.outcome,
)
const firstAsk = asked(await requests(), QUESTION).at(-1)
const firstSpan = spanOf(firstAsk, commitment)
check(
  'the provider was sent the commitment',
  Boolean(firstSpan),
  `${firstAsk?.recordSpans.length ?? 0} record spans`,
)
check(
  'at the revision that was saved',
  firstSpan?.provenance?.revision === saved.version &&
    firstSpan?.id === `record:Commitment/${commitment}@${saved.version}`,
  firstSpan?.id,
)
check(
  'saying Wednesday',
  JSON.parse(firstSpan?.content ?? '{}').fields?.due === 'Wednesday',
)
await page.getByText('is due Wednesday').first().waitFor({ timeout: 60_000 })
check('and the answer on the page says Wednesday', true)
await shot('3-answer-wednesday')
const firstThread = page.url()

// The edit, in the CRM screen: the due day moves from Wednesday to Friday.
const opened = await shows(
  () =>
    page.goto(`${UI}/crm/commitments/${encodeURIComponent(commitment)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 120_000,
    }),
  saved.version,
)
await page.getByRole('button', { name: 'Edit Due' }).click()
const due = page
  .getByRole('list', { name: 'Properties' })
  .getByRole('textbox')
  .first()
await due.fill('Friday')
await due.press('Enter')
// A revision is the store's own counter, not the last one plus one: read the
// one the edit was saved at, then see the screen name the same one.
const findCommitment = () =>
  api.verb(types.Commitment.object_type_id, 'find_one', { id: commitment })
let reread = await findCommitment()
for (let i = 0; i < 60 && reread.version === saved.version; i++) {
  await page.waitForTimeout(500)
  reread = await findCommitment()
}
check(
  'the edit was saved at a new revision',
  reread.version !== saved.version && reread.properties.due === 'Friday',
  `revision ${saved.version} then ${reread.version}`,
)
await page
  .getByText(`Saved revision ${reread.version}`)
  .first()
  .waitFor({ timeout: 60_000 })
check('the screen shows the new saved revision', true)
await shot('4-edited')

// Reopened, the record is the edited one.
const reopened = await shows(
  () => page.reload({ waitUntil: 'domcontentloaded' }),
  reread.version,
)
log('page loads needed: to open', opened, 'and to reopen', reopened)
check(
  'reopened, the record still says Friday',
  await page
    .getByRole('list', { name: 'Properties' })
    .getByText('Friday')
    .first()
    .isVisible(),
)
const history = await page
  .getByRole('list', { name: 'Changes, newest first' })
  .innerText()
  .catch(() => '')
check(
  'and its history shows Wednesday becoming Friday',
  history.includes('Wednesday') && history.includes('Friday'),
  history.slice(0, 160),
)
check(
  'between the two saved revisions, as the change of the person signed in',
  history.includes(`revision ${saved.version} → ${reread.version}`) &&
    history.includes('You changed Due'),
  history.slice(0, 160),
)
await shot('5-reopened')

// After the edit, in the same conversation. The thread still holds the answer
// that said Wednesday; the turn is given Friday all the same.
const beforeEdit = await requests()
await fetch(`${STANDIN}/__requests`, { method: 'DELETE' })
await arrives(
  () =>
    page.goto(firstThread, { waitUntil: 'domcontentloaded', timeout: 120_000 }),
  'is due Wednesday',
)
await chat.send(FOLLOW_UP)
const followed = await chat.ended()
check(
  'a follow-up in the first conversation finishes',
  followed?.outcome === 'completed',
  followed?.outcome,
)
const inThread = await requests()
const followUp = asked(inThread, FOLLOW_UP).at(-1)
const followSpan = spanOf(followUp, commitment)
const followContent = JSON.parse(followSpan?.content ?? '{}')
check(
  'its request still carries the earlier answer that said Wednesday',
  (followUp?.body.messages ?? []).some(
    (message) =>
      message.role === 'assistant' &&
      JSON.stringify(message.content).includes('Wednesday'),
  ),
)
check(
  'and the commitment at the edited revision',
  followSpan?.id === `record:Commitment/${commitment}@${reread.version}`,
  followSpan?.id,
)
check(
  'saying Friday, with Wednesday marked as replaced',
  followContent.fields?.due === 'Friday' &&
    JSON.stringify(followContent.superseded ?? {}).includes('Wednesday'),
  JSON.stringify({
    due: followContent.fields?.due,
    superseded: followContent.superseded,
  }),
)
await page.getByText('is due Friday').first().waitFor({ timeout: 60_000 })
check('and the new answer in that conversation says Friday', true)
await shot('5b-same-conversation')

// And in a new conversation: an ordinary turn is given Friday, at the new revision.
await fetch(`${STANDIN}/__requests`, { method: 'DELETE' })
await home()
await chat.send(QUESTION)
const after = await chat.ended()
check(
  'the second turn finishes',
  after?.outcome === 'completed',
  after?.outcome,
)
const all = await requests()
const secondAsk = asked(all, QUESTION).at(-1)
const secondSpan = spanOf(secondAsk, commitment)
check(
  'the provider was sent the edited revision',
  secondSpan?.provenance?.revision === reread.version &&
    secondSpan?.id === `record:Commitment/${commitment}@${reread.version}`,
  secondSpan?.id,
)
const content = JSON.parse(secondSpan?.content ?? '{}')
check('saying Friday', content.fields?.due === 'Friday', content.fields?.due)
check(
  'with the day it replaced marked as replaced',
  JSON.stringify(content.superseded ?? {}).includes('Wednesday'),
  JSON.stringify(content.superseded),
)
check(
  'every saved-record span names its record and revision',
  secondAsk.recordSpans.length > 0 &&
    secondAsk.recordSpans.every(
      (span) =>
        span.source_type === RECORD_SOURCE &&
        span.id ===
          `record:${span.provenance.objectType}/${span.provenance.recordId}@${span.provenance.revision}`,
    ),
  `${secondAsk.recordSpans.length} spans`,
)
check('Noor is among them', Boolean(spanOf(secondAsk, noor)))
check(
  'and so is when Avery can be called',
  Boolean(spanOf(secondAsk, id('constraint:mornings'))),
)
await page.getByText('is due Friday').first().waitFor({ timeout: 60_000 })
check('and the answer on the page says Friday', true)

// What is kept from Theorem never left, in any request of the run: those of
// the first turn as much as those after the edit.
const everyRequest = [...beforeEdit, ...inThread, ...all]
const sent = JSON.stringify(everyRequest.map((request) => request.body))
check(
  'requests of all three turns were read',
  beforeEdit.length > 0 && inThread.length > 0 && all.length > 0,
  `${beforeEdit.length} before the edit, ${inThread.length} in the same conversation after it, ${all.length} in a new one`,
)
check(
  'no request holds the phone number kept from Theorem',
  !sent.includes(PHONE),
)
check('no request holds the private note', !sent.includes(PRIVATE_NOTE))
check(
  "no request holds the other workspace's contact",
  !sent.includes(OTHER_WORKSPACE) && !sent.includes(`person:noor-other-${run}`),
)
check(
  'the private record is in no span',
  !spanOf(secondAsk, id('interaction:private')),
)

// The person can see what the reply was given.
const used = page.locator('[data-part="theorem-context_manifest"]').last()
await used.waitFor({ timeout: 60_000 })
await used.getByRole('button').first().click()
const usedText = await used.innerText()
check(
  'the reply says which saved records it used',
  usedText.includes('Used in this response'),
)
check(
  'naming the commitment and its revision',
  usedText.includes('Send Noor the materials list') &&
    usedText.includes(`revision ${reread.version}`),
  usedText.slice(0, 200),
)
check(
  'and that something was held back, without saying what it holds',
  usedText.includes('Held back') &&
    !usedText.includes(PRIVATE_NOTE) &&
    !usedText.includes(PHONE),
)
await shot('6-used-in-this-response')

writeFileSync(
  join(DATA_DIR, 'crm-context-requests.json'),
  JSON.stringify(
    {
      run,
      commitment,
      savedRevision: saved.version,
      editedRevision: reread.version,
      requests: everyRequest,
    },
    null,
    2,
  ),
)
log('provider requests written to', join(DATA_DIR, 'crm-context-requests.json'))
if (problems.length) log('page problems', problems.length)
await finish(session)
