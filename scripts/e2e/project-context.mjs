// A project's context, whole, as the test account against the real server:
// a link and an uploaded file are added on the project page and Theorem keeps
// them, a session started in the project is given both, the session adds a
// link itself, and a file later deleted from the Library is marked on the page
// without blocking another edit.
//
// The turn runs on a model that follows a rule, so what it does is known:
//
//   E2E_SCRIPTED_MODEL=1 E2E_SERVER_BIN=<rustyred-thg-server> bun run e2e:stack
//   bun run e2e:project-context
//
// Each run makes a new project. Screenshots go to the stack's data directory.
import { join } from 'node:path'
import { SCRIPTED, SCRIPTED_MODEL, UI } from './config.mjs'
import { READ, SHOTS, check, finish, log, open } from './lib.mjs'
import { turns } from './turns.mjs'

const RUN = Date.now().toString(36)
const PROJECT = `Context ${RUN}`
const SPEC = { url: 'https://example.com/spec', title: 'Spec' }
const RUNBOOK = { url: 'https://example.com/runbook', title: 'Runbook' }
const GLOSSARY = { url: 'https://example.com/glossary', title: 'Glossary' }
// Said nowhere but in the file, so finding it in a model call proves the file was given.
const CODE_WORD = `heliotrope-${RUN}`
const FILE = {
  name: `launch-notes-${RUN}.md`,
  mimeType: 'text/markdown',
  buffer: Buffer.from(
    `# Launch notes\n\nThe launch code word is ${CODE_WORD}.\n`,
  ),
}
const MODEL_REF = `${SCRIPTED_MODEL.provider}/${SCRIPTED_MODEL.model}`

const session = await open('/')
const { context, page } = session
const shot = (name) =>
  page.screenshot({ path: join(SHOTS, `project-context-${name}.png`) })
const { api, ended, json, send, setPreferences, writing } = turns(session)

const refs = (await json('/models')).models.map((model) => model.ref)
check(
  'Theorem lists the scripted model',
  refs.includes(MODEL_REF),
  refs.join(', '),
)
await setPreferences([], MODEL_REF)

// A new project, made the way a person makes one.
const sidebar = page.getByRole('navigation', { name: 'Threads' })
await sidebar
  .getByText('Projects', { exact: true })
  .waitFor({ timeout: 120_000 })
await sidebar.getByRole('button', { name: 'New project' }).click()
await page.getByLabel('Project name').fill(PROJECT)
await page.keyboard.press('Enter')
await sidebar.getByRole('link', { name: PROJECT, exact: true }).click()
await page.waitForURL(/\/projects\/[^/]+$/)
const projectId = decodeURIComponent(
  new URL(page.url()).pathname.split('/').pop(),
)
const home = page.url()
log('project', projectId)

const column = page.getByRole('complementary', { name: 'Project context' })
const dialog = page.getByRole('dialog')
const record = () => json(`/projects/${encodeURIComponent(projectId)}/context`)
const availability = () =>
  json(`/projects/${encodeURIComponent(projectId)}/context/availability`)
const linksOf = (held) => held.links.map((link) => link.title)
/** Save the open editor and wait for Theorem to have taken it. */
async function save() {
  const [put] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/context') &&
        response.request().method() === 'PUT',
    ),
    dialog.getByRole('button', { name: 'Save' }).click(),
  ])
  await dialog.waitFor({ state: 'hidden' })
  return put
}
/**
 * Load the project page afresh and wait for the column to show `shows`.
 *
 * The development server sends the app as thousands of separate modules. On a
 * small machine Chromium now and then refuses part of that burst
 * (ERR_INSUFFICIENT_RESOURCES) and the page never starts, so a load that
 * shows nothing is made again.
 */
async function load(shows = column.getByRole('link', { name: SPEC.title })) {
  for (let attempt = 1; ; attempt += 1) {
    await page.goto(home, { waitUntil: 'domcontentloaded', timeout: 120_000 })
    try {
      await shows.waitFor({ timeout: 45_000 })
      return
    } catch (error) {
      if (attempt === 3) throw error
      log('the page did not start; loading it again')
    }
  }
}
async function addLink({ url, title }) {
  await column.getByRole('button', { name: /^(Add|Edit) links$/ }).click()
  await dialog.getByLabel('Address').fill(url)
  await dialog.getByLabel('Title (optional)').fill(title)
  await dialog.getByRole('button', { name: 'Add link' }).click()
  return save()
}

await column
  .getByRole('button', { name: 'Add links' })
  .waitFor({ timeout: 120_000 })
const untouched = await record()
check(
  'a new project has no context yet',
  untouched.revision === 0,
  JSON.stringify(untouched),
)
await shot('1-empty')

// A link.
check('Theorem took the link', (await addLink(SPEC)).ok())
await column.getByRole('link', { name: SPEC.title }).waitFor()
let held = await record()
check(
  'the record holds the link',
  held.revision === 1 && held.links[0]?.url === SPEC.url,
  JSON.stringify(held.links),
)

// A file, straight from this machine.
await column.getByRole('button', { name: 'Add documents' }).click()
await shot('2-documents-editor')
await dialog.locator('input[aria-label="Upload files"]').setInputFiles(FILE)
const uploaded = dialog
  .getByRole('group', { name: 'Library' })
  .getByText(FILE.name)
await uploaded.waitFor({ timeout: 120_000 })
await shot('3-uploaded')
check('Theorem took the file', (await save()).ok())
await column.getByText(FILE.name).waitFor()
held = await record()
const document = held.documents[0]
check(
  'the record names the upload',
  held.revision === 2 &&
    document?.reference.kind === 'upload' &&
    document.title === FILE.name,
  JSON.stringify(held.documents),
)
const library = await json(`/library?${new URLSearchParams({ projectId })}`)
const kept = library.items.find((item) => item.id === document?.reference.id)
check(
  'the file is in the Library and readable',
  kept?.usable === true,
  JSON.stringify(kept),
)
check(
  'nothing is marked unavailable',
  (await availability()).unavailable.length === 0,
)

// What the person does not hold is refused, and says which entry.
const refused = await api(
  `/projects/${encodeURIComponent(projectId)}/context`,
  {
    method: 'PUT',
    headers: await writing({
      'Content-Type': 'application/json',
      'If-Match': String(held.revision),
    }),
    data: {
      documents: held.documents,
      repositories: [{ fullName: 'acme/never-tracked' }],
      links: held.links,
      connections: held.connections,
    },
  },
)
const why = await refused.text()
check(
  'a repository the person does not track is refused',
  refused.status() >= 400 && refused.status() < 500,
  `${refused.status()} ${why.slice(0, 200)}`,
)
check(
  'the refusal names the entry',
  why.includes('acme/never-tracked'),
  why.slice(0, 200),
)
check('and nothing was written', (await record()).revision === held.revision)

// The page shows what Theorem holds after a reload.
await load()
check(
  'the file is still listed after a reload',
  await column.getByText(FILE.name).isVisible(),
)
await shot('4-saved')

// A session in the project: given the file and the link, and able to add one.
const before = (
  await (await context.request.get(`${SCRIPTED}/__calls`, READ)).json()
).length
const composer = page
  .getByRole('region', { name: `Start a session in ${PROJECT}` })
  .getByRole('textbox')
  .first()
// The composer is an editor: Enter is a new line there, and Ctrl+Enter sends.
const sent = await send(
  `Add ${RUNBOOK.url} to this project as ${RUNBOOK.title}.`,
  { box: composer, keys: 'Control+Enter' },
)
check(
  'the turn ran on the scripted model',
  sent.acting.model === SCRIPTED_MODEL.model,
  `${sent.acting.provider}/${sent.acting.model}`,
)
const run = await ended()
check('the turn ended well', run?.outcome === 'completed', JSON.stringify(run))
const calls = (
  await (await context.request.get(`${SCRIPTED}/__calls`, READ)).json()
).slice(before)
const turn = calls.filter((call) => call.tools.includes('read_project_context'))
const given = (turn[0]?.messages ?? [])
  .map((message) => message.text)
  .join('\n')
check(
  'the session was offered both operations',
  turn[0]?.tools.includes('write_project_context') === true,
  String(turn[0]?.tools),
)
check("the session was given the file's text", given.includes(CODE_WORD))
check(
  'the session was given the link',
  given.includes(`${SPEC.title}: ${SPEC.url}`),
)
check(
  'the session read, wrote, then answered',
  turn.length === 3 &&
    turn[0].reply.tool_calls?.[0].function.name === 'read_project_context' &&
    turn[1].reply.tool_calls?.[0].function.name === 'write_project_context' &&
    turn[2].reply.content === `I added ${RUNBOOK.title} to this project.`,
  JSON.stringify(turn.map((call) => call.reply)).slice(0, 400),
)
held = await record()
check(
  'the record holds what the session added, beside what was there',
  held.revision === 3 &&
    String(linksOf(held)) === String([SPEC.title, RUNBOOK.title]) &&
    held.documents.length === 1,
  JSON.stringify(held),
)
await page
  .getByText(`I added ${RUNBOOK.title} to this project.`)
  .first()
  .waitFor({ timeout: 120_000 })
await shot('5-session')

await load(column.getByRole('link', { name: RUNBOOK.title }))
check('the page lists the link the session added', true)
await shot('6-after-session')

// The file is deleted from the Library afterwards. The project still names it,
// the page says sessions no longer get it, and another edit is not blocked.
const deleted = await api(
  `/library/uploads/${encodeURIComponent(document.reference.id)}`,
  {
    method: 'DELETE',
    headers: await writing({ 'If-Match': String(kept?.revision ?? 0) }),
  },
)
check(
  'the Library deleted the file',
  deleted.ok(),
  `${deleted.status()} ${(await deleted.text()).slice(0, 200)}`,
)
const gone = await availability()
check(
  'Theorem reports the document as no longer held',
  gone.unavailable.length === 1 &&
    gone.unavailable[0].list === 'documents' &&
    gone.unavailable[0].reference.id === document.reference.id,
  JSON.stringify(gone),
)
await load()
const row = column.getByRole('listitem').filter({ hasText: FILE.name })
await row.getByText(/· (removed|not readable)/).waitFor({ timeout: 120_000 })
check('the page marks the document', true, await row.innerText())
check('another edit still saves', (await addLink(GLOSSARY)).ok())
await column.getByRole('link', { name: GLOSSARY.title }).waitFor()
held = await record()
check(
  'the record keeps the document and holds the new link',
  held.revision === 4 &&
    held.documents.length === 1 &&
    linksOf(held).includes(GLOSSARY.title),
  JSON.stringify(held),
)
await shot('7-document-removed')

await finish(session)
