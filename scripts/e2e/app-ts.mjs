import { writeFileSync } from 'node:fs'
// An App written in TypeScript, in a browser: its source is built in the
// page and runs in a sandboxed frame, tsrs checks it in a worker, a failure
// in it is traced to the file and line that threw, and a revision that does
// not build leaves the last one running.
//
//   bun run e2e:app-ts            the page as the dev server serves it
//   bun run e2e:app-ts --built    the page built as for production
//
// It serves scripts/e2e/app-ts/ with Vite and drives it in headless Chromium.
// No Theorem server is needed: the App's document is held in memory.
import { chromium } from 'playwright-core'
import { servePage } from './harness.mjs'

const BLOCK_SANDBOX = [
  'allow-scripts',
  'allow-forms',
  'allow-modals',
  'allow-popups',
  'allow-popups-to-escape-sandbox',
  'allow-downloads',
  'allow-pointer-lock',
  'allow-presentation',
  'allow-orientation-lock',
  'allow-top-navigation-by-user-activation',
].join(' ')

const source = (files) =>
  Object.entries(files)
    .map(
      ([path, text]) =>
        `<script type="text/theorem-source" data-path="${path}">${text}</script>`,
    )
    .join('\n')
const app = (files) => `<!doctype html>
<meta name="theorem:uses" content='db("records")'>
<style>table { border-collapse: collapse }</style>
<div id="root"></div>
${source(files)}`

const TYPES = `export interface Org { id: string; name: string; area: string }`
const TABLE = `import { useEffect, useState } from 'react'
import type { Org } from './types'

export function Table({ title }: { title: string }) {
  const [orgs, setOrgs] = useState<Array<Org>>([])
  useEffect(() => {
    let stop = () => {}
    void theorem.db('records').then((db) => {
      stop = db.subscribe<Array<{ id: string; properties: Record<string, unknown> }>>(
        { method: 'queryNodes', args: { label: 'Org' } },
        (nodes) =>
          setOrgs(
            nodes
              .map((node) => ({ id: node.id, name: String(node.properties.name), area: String(node.properties.area) }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          ),
      )
    })
    return () => stop()
  }, [])
  return (
    <table data-title={title} data-count={orgs.length}>
      <tbody>
        {orgs.map((org) => (
          <tr key={org.id} data-row-id={org.id}>
            <td>{org.name}</td>
            <td>{org.area}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}`
const MAIN = `import { createRoot } from 'react-dom/client'
import { Table } from './Table'

await window.theorem.ready
const db = await window.theorem.db('records')
if ((await db.queryNodes({ label: 'Org', limit: 1 })).length === 0)
  await db.mutate({
    upsertNodes: [
      { id: 'org:a', labels: ['Org'], properties: { name: 'Alder', area: 'housing' } },
      { id: 'org:b', labels: ['Org'], properties: { name: 'Birch', area: 'transit' } },
    ],
  })
createRoot(document.getElementById('root')!).render(<Table title="Organizations" />)`

const GOOD = app({ 'main.tsx': MAIN, 'Table.tsx': TABLE, 'types.ts': TYPES })
/** The same App with a field that does not exist, and a prop of the wrong type. */
const MISTYPED = app({
  'main.tsx': MAIN.replace('title="Organizations"', 'title={3}'),
  'Table.tsx': TABLE.replace('<td>{org.area}</td>', '<td>{org.region}</td>'),
  'types.ts': TYPES,
})
/** A revision that does not parse. */
const BROKEN = app({
  'main.tsx': MAIN,
  'Table.tsx': TABLE.replace('return () => stop()', 'return () => stop('),
  'types.ts': TYPES,
})
/** The App with a heading whose text and class are written as plain text. */
const HEADED = app({
  'main.tsx': MAIN.replace(
    "import { Table } from './Table'",
    "import { Table } from './Table'\nimport { Heading } from './Heading'",
  ).replace(
    '<Table title="Organizations" />',
    '<><Heading /><Table title="Organizations" /></>',
  ),
  'Table.tsx': TABLE,
  'types.ts': TYPES,
  'Heading.tsx': `export function Heading() {
  return <h2 className="title">Organizations</h2>
}`,
})

/** A revision that throws, two calls down, after it has rendered. */
const THROWS = app({
  'main.tsx': `${MAIN}
import { summarize } from './summary'
setTimeout(() => summarize(undefined as never), 0)`,
  'Table.tsx': TABLE,
  'types.ts': TYPES,
  'summary.ts': `import type { Org } from './types'

export function summarize(orgs: Array<Org>): string {
  return count(orgs)
}

function count(orgs: Array<Org>): string {
  return orgs.length + ' organizations'
}`,
})

/**
 * The example Theorem's builder is given for this form (builder_app.md in the
 * Theorem repo), as it is written there.
 */
const AS_TOLD = String.raw`<!doctype html>
<meta name="theorem:uses" content='db("records")'>
<style>table { border-collapse: collapse }</style>
<div id="root"></div>
<script type="text/theorem-source" data-path="main.tsx">
import { createRoot } from 'react-dom/client'
import { Table } from './Table'

await window.theorem.ready
createRoot(document.getElementById('root')!).render(<Table title="Organizations" />)
</script>
<script type="text/theorem-source" data-path="Table.tsx">
import { useEffect, useState } from 'react'

interface Org { id: string; name: string }

export function Table({ title }: { title: string }) {
  const [orgs, setOrgs] = useState<Array<Org>>([])
  useEffect(() => {
    let stop = () => {}
    void window.theorem.db('records').then((db) => {
      stop = db.subscribe<Array<{ id: string; properties: Record<string, unknown> }>>(
        { method: 'queryNodes', args: { label: 'Org' } },
        (nodes) => setOrgs(nodes.map((node) => ({ id: node.id, name: String(node.properties.name) }))),
      )
    })
    return () => stop()
  }, [])
  return <table aria-label={title}><tbody>{orgs.map((org) => <tr key={org.id} data-row-id={org.id}><td>{org.name}</td></tr>)}</tbody></table>
}
</script>`

const served = await servePage('app-ts')
const { url } = served
console.log(
  served.built ? 'Serving a production build.' : 'Serving with the dev server.',
)

const checks = []
const check = (name, pass, detail) => {
  checks.push(pass)
  console.log(
    `${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`,
  )
}

// E2E_CHROMIUM names a Chromium to run when the one playwright-core expects
// is not installed.
const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM || undefined,
})
const page = await browser.newPage()
page.on('pageerror', (error) => console.log(`  [page error] ${error.message}`))

const frame = () =>
  page.frames().find((candidate) => candidate !== page.mainFrame())
const table = async (count) => {
  await page.waitForFunction(() => document.querySelector('iframe'), null, {
    timeout: 30_000,
  })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const app = frame()
    const rows = await app
      ?.$$eval(`table[data-count="${count}"] tr`, (trs) =>
        trs.map((tr) =>
          [...tr.children].map((cell) => cell.textContent).join(' '),
        ),
      )
      .catch(() => undefined)
    if (rows?.length === count) return rows
    await page.waitForTimeout(100)
  }
  throw new Error(`no table of ${count} rows`)
}
const problems = () =>
  page.$$eval('[data-slot="app-problems"] li', (items) =>
    items.map((item) => item.textContent),
  )
const settled = async (wanted) => {
  await page.waitForFunction(
    (count) =>
      document.querySelectorAll('[data-slot="app-problems"] li').length ===
        count && !document.body.textContent.includes('Checking types'),
    wanted,
    { timeout: 60_000 },
  )
  return problems()
}
const revise = (html) =>
  page.evaluate((text) => window.oracle.revise(text), html)

try {
  await page.goto(url)
  await page.waitForFunction(() => 'oracle' in window)
  await page.evaluate(() => window.oracle.clear())

  // What the agent's app.check does: the same build, check and run, with
  // nothing on screen, reported instead of shown.
  const inspect = (html, options) =>
    page.evaluate(
      ([text, o]) => window.oracle.inspect(text, o),
      [html, options],
    )
  const before = await page.evaluate(() => window.oracle.traces())
  let started = Date.now()
  const cleanCheck = await inspect(GOOD)
  check(
    'a check of a correct App finds nothing and says what it showed',
    cleanCheck.built &&
      cleanCheck.typesChecked &&
      cleanCheck.problems.length === 0 &&
      cleanCheck.files.join() === 'main.tsx,Table.tsx,types.ts' &&
      cleanCheck.rendered?.text === 'Alder housing\nBirch transit' &&
      // The same page as assistive technology reads it, each cell with the
      // place in the source that made it.
      /^- table/m.test(cleanCheck.rendered?.outline ?? '') &&
      /- cell "Alder" \[source=Table\.tsx:\d+:\d+\]/.test(
        cleanCheck.rendered?.outline ?? '',
      ),
    {
      ms: Date.now() - started,
      ranMs: cleanCheck.ranMs,
      outline: cleanCheck.rendered?.outline,
      rendered: cleanCheck.rendered,
    },
  )
  const mistypedCheck = await inspect(MISTYPED, { runMs: 0 })
  check(
    'it reports type errors at their file and line, without running the App',
    mistypedCheck.built &&
      mistypedCheck.ranMs === 0 &&
      mistypedCheck.problems
        .map((p) => `${p.kind} ${p.file}:${p.line} ${p.code}`)
        .sort()
        .join() === 'type Table.tsx:27 TS2339,type main.tsx:13 TS2322',
    mistypedCheck.problems,
  )
  const brokenCheck = await inspect(BROKEN)
  check(
    'an App that does not build is reported as not built, and is not run',
    !brokenCheck.built &&
      brokenCheck.ranMs === 0 &&
      brokenCheck.problems.length === 1 &&
      brokenCheck.problems[0].kind === 'build' &&
      brokenCheck.problems[0].file === 'Table.tsx' &&
      brokenCheck.problems[0].line === 20,
    brokenCheck.problems,
  )
  const thrownCheck = await inspect(THROWS)
  check(
    'what the App throws while it runs is reported at its source line',
    thrownCheck.built &&
      thrownCheck.problems.some(
        (p) => p.kind === 'runtime' && p.file === 'summary.ts' && p.line === 8,
      ),
    thrownCheck.problems,
  )
  // A page that never stops changing never settles into a snapshot of its own.
  const tickingCheck = await inspect(
    '<!doctype html><h1>Clock</h1><p id="t"></p><script>let n = 0; setInterval(() => { document.getElementById("t").textContent = "tick " + n++ }, 50)</script>',
  )
  check(
    'an App that keeps changing is still seen, as it was at the end of its run',
    /^- heading "Clock" \[level=1\]/m.test(
      tickingCheck.rendered?.outline ?? '',
    ) && /tick \d+/.test(tickingCheck.rendered?.text ?? ''),
    tickingCheck.rendered,
  )
  // E2E_PICTURE=path writes the fixture App's picture there, to look at.
  if (process.env.E2E_PICTURE) {
    const seen = await inspect(GOOD, { picture: true })
    if (seen.picture)
      writeFileSync(
        process.env.E2E_PICTURE,
        Buffer.from(seen.picture.data, 'base64'),
      )
  }
  // A picture of the App, drawn in the page from its snapshot: what it laid out
  // with CSS and what it drew on a canvas.
  const pictured = await inspect(
    `<!doctype html><html class="night"><style>body { margin: 0 } #box { width: 200px; height: 100px; background: rgb(255, 0, 0) } .night:root #under { height: 50px; background: rgb(255, 255, 0) }</style>
     <body style="background: rgba(0, 128, 0, 0.5)"><div id="box"></div><canvas id="c" width="200" height="100"></canvas><div id="under"></div>
     <script>const g = document.getElementById("c").getContext("2d"); g.fillStyle = "rgb(0, 0, 255)"; g.fillRect(0, 0, 200, 100)</script>`,
    { picture: true },
  )
  const pixels = pictured.picture
    ? await page.evaluate(async (picture) => {
        const image = new Image()
        image.src = `data:${picture.mediaType};base64,${picture.data}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = image.width
        canvas.height = image.height
        const context = canvas.getContext('2d')
        context.drawImage(image, 0, 0)
        const at = (x, y) => [...context.getImageData(x, y, 1, 1).data].join()
        return {
          box: at(100, 50),
          canvas: at(100, 150),
          // Styled by a class on the root, and by a style on the body.
          under: at(100, 225),
          body: at(600, 600),
          // Inside the body's own box, beside the box and the canvas.
          margin: at(600, 50),
          size: [image.width, image.height],
        }
      }, pictured.picture)
    : null
  check(
    'a check can picture the App: its layout, what it drew on a canvas, and what its root and body style',
    pixels?.box === '255,0,0,255' &&
      pixels.canvas === '0,0,255,255' &&
      pixels.under === '255,255,0,255' &&
      // Half green over the white base, once: twice would be 64,160,64.
      pixels.body === '127,191,127,255' &&
      pixels.margin === pixels.body &&
      pixels.size[0] === 1024,
    { pixels, bytes: pictured.picture?.data.length },
  )
  const plainCheck = await inspect(
    '<!doctype html><p id="x">Plain</p><script>document.getElementById("x").textContent = "Ran"</script>',
  )
  check(
    'a plain HTML App is run too, and has no types to check',
    plainCheck.built &&
      !plainCheck.typesChecked &&
      plainCheck.rendered?.text === 'Ran' &&
      plainCheck.problems.length === 0,
    plainCheck,
  )
  const receipt = await page.evaluate(
    (html) => window.oracle.ask({ html, runMs: 0 }),
    MISTYPED,
  )
  check(
    'the app.check operation answers its run with those findings',
    receipt?.outcome === 'applied' &&
      receipt.revision === 5 &&
      receipt.result.problems.length === 2,
    { outcome: receipt?.outcome, revision: receipt?.revision },
  )
  const after = await page.evaluate(() => window.oracle.traces())
  check(
    'a check leaves nothing behind: no frame, and nothing in storage',
    after.frames === before.frames &&
      after.names.join() === before.names.join(),
    after,
  )

  started = Date.now()
  await revise(GOOD)
  await page.evaluate(() => window.oracle.show())
  const rows = await table(2)
  check(
    'an App written in TypeScript and React builds in the page and runs',
    rows.join() === 'Alder housing,Birch transit',
    {
      ms: Date.now() - started,
    },
  )
  // Every App frame gets BLOCK_SANDBOX (src/lib/blocks/executor.ts): every
  // allow token but allow-same-origin, so it is an origin of its own and is
  // never signed in as the person.
  const sandbox = (await page.$eval('iframe', (el) => el.getAttribute('sandbox'))) ?? ''
  check(
    'its frame is the same sandbox as any App, with no origin of the site',
    sandbox === BLOCK_SANDBOX && !sandbox.split(' ').includes('allow-same-origin'),
    sandbox,
  )
  check(
    'the type check of a correct App finds nothing',
    (await settled(0)).length === 0,
  )
  // Enlarging the answer keeps its actual browser frame, not a second
  // instance restored from saved state. Unsaved inputs survive as well.
  const inlineFrame = await page.$('iframe')
  const continuity = await frame().evaluate(() => {
    window.continuity = crypto.randomUUID()
    const input = document.createElement('input')
    input.setAttribute('aria-label', 'Unsaved artifact input')
    document.body.append(input)
    return window.continuity
  })
  await frame().getByLabel('Unsaved artifact input').fill('Keep my work')
  await page.getByRole('button', { name: 'Expand', exact: true }).click()
  check(
    'an answer expands the same running App with its unsaved state',
    await page.$eval('iframe', (el, before) => el === before, inlineFrame) &&
      await frame().evaluate(() => window.continuity) === continuity &&
      await frame().getByLabel('Unsaved artifact input').inputValue() === 'Keep my work' &&
      await page.$eval('[data-slot="inline-artifact"]', (el) => el.matches(':modal')),
  )
  await page.keyboard.press('Escape')
  check(
    'Escape returns that App to the answer without restarting it',
    await page.$eval('iframe', (el, before) => el === before, inlineFrame) &&
      await frame().evaluate(() => window.continuity) === continuity &&
      await frame().getByLabel('Unsaved artifact input').inputValue() === 'Keep my work' &&
      await page.$eval('[data-slot="inline-artifact"]', (el) => el.open && !el.matches(':modal')),
  )
  await frame().getByLabel('Unsaved artifact input').evaluate((el) => el.remove())
  // Pointing at something in the App names the place in its source.
  const stamp = await frame().$eval('tr[data-row-id="org:b"] td', (cell) =>
    cell.getAttribute('data-theorem-source'),
  )
  const beforeAsk = await page.$('iframe')
  await page.getByRole('button', { name: 'Expand', exact: true }).click()
  await frame().click('tr[data-row-id="org:b"] td')
  await page.click('button:has-text("Ask about selection")')
  const [pointed] = await page.evaluate(() => window.oracle.references())
  const selection = JSON.parse(pointed?.excerpt ?? '{}').selection
  check(
    'an element says where it was written, and pointing at it tells the agent',
    stamp === 'Table.tsx:26:13' &&
      selection?.source === stamp &&
      selection.rowId === 'org:b',
    { stamp, label: pointed?.label, selection },
  )
  check(
    'Ask in an expanded App returns to the composer and keeps the frame',
    await page.$eval('[data-slot="inline-artifact"]', (el) => el.open && !el.matches(':modal')) &&
      await page.$eval('iframe', (el, before) => el === before, beforeAsk) &&
      await page.evaluate(() => document.activeElement?.matches('.aui-composer-input .ProseMirror')),
  )
  // What a check costs here, once the checker is loaded: its own clock and
  // the compiler's peak memory.
  const cost = await page.evaluate((text) => window.oracle.check(text), GOOD)
  check('a check of this App is measured', cost.problems === 0 && cost.ms > 0, {
    ms: Math.round(cost.ms),
    MiB: Math.round(cost.memoryBytes / 2 ** 20),
  })

  started = Date.now()
  await revise(MISTYPED)
  const typed = await settled(2)
  check(
    'a wrong field and a wrong prop are listed at their file and line, and the App still runs',
    typed.some(
      (text) =>
        text.includes('Table.tsx:27') &&
        text.includes('TS2339') &&
        text.includes("'region'"),
    ) &&
      typed.some(
        (text) => text.includes('main.tsx:13') && text.includes('TS2322'),
      ) &&
      (await table(2)).length === 2,
    { ms: Date.now() - started, problems: typed },
  )

  await revise(GOOD)
  await settled(0)
  const running = await page.$('iframe')
  await revise(BROKEN)
  const broken = await settled(1)
  check(
    'a revision that does not build is listed, and the last one keeps running',
    broken[0].includes('Build') &&
      broken[0].includes('Table.tsx:20') &&
      (await page.$eval('iframe', (el, before) => el === before, running)) &&
      (await table(2)).length === 2 &&
      (await page.textContent('[data-slot="app-problems"]')).includes(
        'Showing the last revision that built',
      ),
    broken,
  )
  await page.click('button:has-text("Ask to fix")')
  const [reference] = await page.evaluate(() => window.oracle.references())
  const repair = JSON.parse(reference?.excerpt ?? '{}').repair
  check(
    'Ask to fix hands the agent that revision and its problem',
    reference?.location.revision === '5' &&
      repair?.problems.length === 1 &&
      repair.problems[0].file === 'Table.tsx' &&
      repair.problems[0].line === 20,
    {
      label: reference?.label,
      revision: reference?.location.revision,
      problems: repair?.problems,
    },
  )

  await revise(THROWS)
  const thrown = await settled(1)
  check(
    'what the App throws is traced to the file and line that threw it',
    thrown[0].includes('Running') &&
      thrown[0].includes('summary.ts:8') &&
      thrown[0].includes('TypeError'),
    thrown,
  )

  await revise(AS_TOLD)
  // The frame is replaced when the revision has built: ask whichever is there.
  let told = []
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    told = await frame()
      .$$eval('table[aria-label="Organizations"] tr', (trs) =>
        trs.map((tr) => tr.textContent),
      )
      .catch(() => [])
    if (told.length === 2) break
    await page.waitForTimeout(100)
  }
  await settled(0)
  check(
    "the example Theorem's builder is given builds, runs and passes its check",
    told.join() === 'Alder,Birch' && (await problems()).length === 0,
    told,
  )

  // Pointing at an element and changing what its source writes as plain text.
  const heading = async (wanted) => {
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      const text = await frame()
        ?.$eval('h2', (h2) => `${h2.className}|${h2.textContent}`)
        .catch(() => undefined)
      if (text === wanted) return true
      await page.waitForTimeout(100)
    }
    return false
  }
  await revise(HEADED)
  await heading('title|Organizations')
  await settled(0)
  await frame().click('h2')
  await page.fill('[data-slot="app-element"] input[name="Text"]', 'Funders')
  await page.fill(
    '[data-slot="app-element"] input[name="className"]',
    'title wide',
  )
  await page.click('button:has-text("Apply to source")')
  check(
    'changing an element in the panel rewrites its source, and the App shows it',
    (await heading('title wide|Funders')) &&
      (await table(2)).length === 2 &&
      (await settled(0)).length === 0,
  )

  // The host's quiet defaults in a real cascade: a plain control takes them,
  // and any rule the App brings wins, whether unlayered or in a component
  // library's own layer. This page loads no palette, so the defaults read
  // here are the ones that use no token: padding, background and cursor.
  await revise(`<!doctype html>
<style>button.own { background-color: rgb(250, 250, 249); padding: 0 }</style>
<style>@layer lib-base { button.lib { background-color: rgb(1, 2, 3); padding: 2px } }</style>
<button class="plain">Plain</button><button class="own">Own</button><button class="lib">Lib</button><input>`)
  let cascade
  for (const deadline = Date.now() + 30_000; Date.now() < deadline; ) {
    cascade = await frame()
      ?.evaluate(() => {
        if (!document.querySelector('button.lib')) return undefined
        const of = (selector) => {
          const style = getComputedStyle(document.querySelector(selector))
          return `${style.backgroundColor} ${style.paddingLeft} ${style.cursor}`
        }
        return {
          plain: of('.plain'),
          input: of('input'),
          own: of('.own'),
          lib: of('.lib'),
        }
      })
      .catch(() => undefined)
    if (cascade) break
    await page.waitForTimeout(100)
  }
  check(
    'plain controls take the host look, and the App’s rules win over it, layered or not',
    cascade?.plain === 'rgba(0, 0, 0, 0) 10px pointer' &&
      cascade.input.startsWith('rgba(0, 0, 0, 0) 8px') &&
      cascade.own === 'rgb(250, 250, 249) 0px pointer' &&
      cascade.lib === 'rgb(1, 2, 3) 2px pointer',
    cascade,
  )

  await revise(GOOD)
  check(
    'a repaired revision clears the problems and finds the same records',
    (await settled(0)).length === 0 && (await table(2)).length === 2,
  )
} finally {
  await browser.close()
  await served.close()
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed} of ${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
