// SOURCING: scripts/e2e/harness.mjs (isolated Vite) and lib.mjs
// (playwright-core, full Chromium on macOS). Synthetic fixture; no backend.
// Run: node scripts/e2e/index-record-links.mjs
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'
import svgr from 'vite-plugin-svgr'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '../..')
const output = resolve(root, 'docs/plans/evidence/index-record-links')
mkdirSync(output, { recursive: true })
const baselineRef =
  process.env.E2E_BASELINE_REF ?? 'f7c31043feaef8e0c3f321924c998dd7258a120d'
const baselinePath = resolve(
  root,
  'scripts/e2e/index-record-links/baseline.generated.tsx',
)
const baseline = execFileSync(
  'git',
  ['show', baselineRef + ':src/components/index/record-links.tsx'],
  { cwd: root, encoding: 'utf8' },
)
writeFileSync(
  baselinePath,
  baseline.replaceAll("from './", "from '@/components/index/"),
)
const report = {
  fixture: true,
  liveBackendVerified: false,
  command: 'node scripts/e2e/index-record-links.mjs',
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  sourceHashes: Object.fromEntries(
    ['record-links.tsx', 'record-link-picker.tsx'].map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(resolve(root, 'src/components/index', name)))
        .digest('hex'),
    ]),
  ),
  baselineCommit: execFileSync('git', ['rev-parse', baselineRef], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  viewport: { width: 1280, height: 800 },
  runs: [],
  errors: [],
}
const cacheDir = mkdtempSync(resolve(tmpdir(), 'theorem-record-links-'))
const server = await createServer({
  root,
  configFile: false,
  logLevel: 'error',
  cacheDir,
  resolve: {
    tsconfigPaths: true,
    alias: {
      '@tanstack/start-storage-context': resolve(
        root,
        'scripts/e2e/start-storage.ts',
      ),
    },
  },
  plugins: [
    {
      // Index queries imports the unrelated OpenUI library publisher. This page
      // never publishes a library; keep that server-containing graph out.
      name: 'record-links-fixture-unused-library',
      enforce: 'pre',
      resolveId(id, importer) {
        if (
          id === '@/components/crm/navigation' ||
          id === resolve(root, 'src/components/crm/navigation.ts')
        )
          return '\0record-links-unused-navigation'
        if (
          (id === './library' ||
            id === resolve(root, 'src/components/index/library.tsx')) &&
          importer?.endsWith('/components/index/queries.ts')
        )
          return '\0record-links-unused-library'
      },
      load(id) {
        if (id === '\0record-links-unused-navigation')
          return 'export const useCrmNavigate = () => ({ openRecordNamed() { throw new Error("Record-page navigation is outside this fixture") } })'
        if (id === '\0record-links-unused-library')
          return 'export const libraryRecord = () => { throw new Error("Library publication is outside this fixture") }'
      },
    },
    react(),
    tailwind(),
    svgr(),
  ],
  optimizeDeps: { entries: ['scripts/e2e/index-record-links/index.html'] },
  server: { host: '127.0.0.1', port: 0 },
})
let browser
let activePage
try {
  await server.listen()
  const { port } = server.httpServer.address()
  const url =
    'http://127.0.0.1:' + port + '/scripts/e2e/index-record-links/index.html'
  browser = await chromium.launch(
    process.env.E2E_CHROMIUM
      ? { executablePath: process.env.E2E_CHROMIUM }
      : { channel: 'chromium' },
  )
  report.browser = 'Chromium ' + browser.version()
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({
      viewport: report.viewport,
      colorScheme: theme,
    })
    await context.route('**/*', (route) => {
      const target = new URL(route.request().url())
      return target.hostname === '127.0.0.1' && target.port === String(port)
        ? route.continue()
        : route.abort('blockedbyclient')
    })
    const page = await context.newPage()
    activePage = page
    page.on('requestfailed', (request) =>
      report.errors.push(
        'Request failed: ' + request.url() + ' ' + request.failure()?.errorText,
      ),
    )
    page.on('response', (response) => {
      if (response.status() >= 400)
        report.errors.push('HTTP ' + response.status() + ' ' + response.url())
    })
    page.setDefaultTimeout(20_000)
    page.on('pageerror', (error) => report.errors.push(error.message))
    const run = { theme, checks: [], screenshots: [] }
    report.runs.push(run)
    const check = (name, passed, detail) => {
      run.checks.push({ name, passed, ...(!passed ? { detail } : {}) })
      console.log((passed ? 'PASS ' : 'FAIL ') + theme + ': ' + name)
      if (!passed) throw new Error(name + ': ' + JSON.stringify(detail))
    }
    const capture = async (name) => {
      const filename = theme + '-' + name + '.png'
      await page.screenshot({
        path: resolve(output, filename),
        fullPage: true,
        animations: 'disabled',
      })
      run.screenshots.push(filename)
    }
    await page.goto(url + '?theme=' + theme + '&baseline=1', {
      waitUntil: 'networkidle',
    })
    await page.getByRole('combobox').filter({ hasText: 'Change…' }).click()
    await page.getByRole('combobox').first().waitFor()
    await capture('baseline-picker')
    check(
      'baseline has no record-type selector',
      (await page
        .getByRole('combobox', { name: 'Record type', exact: true })
        .count()) === 0,
    )
    await page.goto(url + '?theme=' + theme, { waitUntil: 'networkidle' })
    const about = page.getByRole('region', { name: 'About' })
    await about.getByRole('button', { name: 'Noor', exact: true }).waitFor()
    const change = about.getByRole('combobox', {
      name: 'Change linked record',
      exact: true,
    })
    await change.focus()
    await page.keyboard.press('Enter')
    const type = page.getByRole('combobox', {
      name: 'Record type',
      exact: true,
    })
    await type.waitFor()
    check('Change opens the real picker', await type.isVisible())
    await type.click()
    await page
      .getByRole('option', { name: 'Research questions', exact: true })
      .waitFor()
    await capture('record-types')
    if (theme === 'dark') {
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
    } else {
      await page
        .getByRole('option', { name: 'Research questions', exact: true })
        .click()
    }
    const search = page.getByRole('combobox', {
      name: 'Find a research question',
      exact: true,
    })
    await search.waitFor()
    check(
      'custom ResearchQuestion type remains inside the About picker',
      await search.isVisible(),
    )
    if (theme === 'dark') {
      await page.keyboard.press('Tab')
      const focused = await page.evaluate(() =>
        document.activeElement?.getAttribute('aria-label'),
      )
      check(
        'Tab from type selector focuses record search',
        focused === 'Find a research question',
        focused,
      )
    }
    await search.fill('throughput')
    const choice = page.getByRole('option', {
      name: 'When does this method improve throughput?',
      exact: true,
    })
    await choice.waitFor()
    await capture('research-choice')
    if (theme === 'dark') {
      await search.press('ArrowDown')
      await page.keyboard.press('Enter')
    } else {
      await choice.click()
    }
    const target = about.getByRole('button', {
      name: 'When does this method improve throughput?',
      exact: true,
    })
    await target.waitFor()
    await about.getByText('Linked here by a person.', { exact: true }).waitFor()
    const undo = about.getByRole('button', {
      name: 'Undo change to When does this method improve throughput?',
      exact: true,
    })
    await undo.click({ trial: true })
    await capture('corrected')
    let state = await page.evaluate(() => window.recordLinksEvidence())
    check(
      'existing correction endpoint carries typed research item id',
      state.writes.length === 1 &&
        state.writes[0].path ===
          '/api/documents/v2/record-filings/r1/corrections' &&
        state.writes[0].body.recordItemId ===
          'record:ResearchQuestion/question:throughput',
      state.writes,
    )
    check(
      'record search only asks the chosen type with a bounded page',
      state.reads.every((read) =>
        ['objtype:demo:person', 'objtype:demo:researchquestion'].includes(
          read.objectTypeId,
        ),
      ) &&
        state.reads.some(
          (read) =>
            read.objectTypeId === 'objtype:demo:researchquestion' &&
            read.input.limit === 20,
        ),
      state.reads,
    )
    await undo.click()
    await about.getByRole('button', { name: 'Noor', exact: true }).waitFor()
    state = await page.evaluate(() => window.recordLinksEvidence())
    check(
      'Undo uses existing receipt endpoint and restores the original link',
      state.writes.length === 2 &&
        state.writes[1].path ===
          '/api/documents/v2/record-filing-corrections/c1/undo' &&
        state.history.links[0].recordItemId === 'record:Person/person:noor',
      state.writes,
    )
    check(
      'record itself is unchanged',
      state.record.version === 1 &&
        state.record.properties.question ===
          'When does this method improve throughput?',
    )
    run.receipts = state
    run.outline = await page.locator('body').ariaSnapshot()
    await context.close()
  }
  if (report.errors.length)
    throw new Error('Page errors: ' + report.errors.join('; '))
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = String(error?.stack ?? error)
  if (activePage && !activePage.isClosed()) {
    report.failureBody = await activePage
      .locator('body')
      .innerText()
      .catch(() => '')
    report.failureState = await activePage
      .evaluate(() => window.recordLinksEvidence?.())
      .catch(() => null)
    report.failureOutline = await activePage
      .locator('body')
      .ariaSnapshot()
      .catch(() => '')
  }
  console.error(report.failure)
  console.error(
    JSON.stringify({
      body: report.failureBody,
      state: report.failureState,
      errors: report.errors,
    }),
  )
  process.exitCode = 1
} finally {
  await browser?.close()
  await server.close()
  rmSync(baselinePath, { force: true })
  rmSync(cacheDir, { recursive: true, force: true })
  writeFileSync(
    resolve(output, 'browser-report.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
}
