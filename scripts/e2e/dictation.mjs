// Live acceptance: the browser's microphone is the licensed LibriSpeech
// fixture (Chromium's fake device), the person dictates through the composer's
// mic, and the transcript must land in the composer via Theorem's burn engine.
import { chromium } from 'playwright-core'
import { ACCOUNT, DATA_DIR, UI } from './config.mjs'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const BROWSER_STATE = join(DATA_DIR, 'browser-state.json')
const WAV = process.env.E2E_DICTATION_WAV ?? '/tmp/eou-fixture.wav'
const failed = []
const check = (name, passed, detail = '') => {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!passed) failed.push(name)
}

const browser = await chromium.launch({
  channel: 'chromium',
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    `--use-file-for-fake-audio-capture=${WAV}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
})
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  colorScheme: 'dark',
  permissions: ['microphone'],
  storageState: existsSync(BROWSER_STATE) ? BROWSER_STATE : undefined,
})
const page = await context.newPage()
page.setDefaultTimeout(60_000)
const problems = []
page.on('pageerror', (e) => problems.push(String(e).slice(0, 200)))

// Sign in if needed.
const asked = await context.request.get(`${UI}/api/chat/v1/bootstrap`).catch(() => undefined)
if (!asked || asked.status() === 401) {
  const door = await context.newPage()
  await door.goto(`${UI}/login`, { waitUntil: 'domcontentloaded', timeout: 120_000 })
  await door.getByRole('button', { name: /sign in|continue/i }).first().click()
  await door.locator('input[name="login"]').waitFor()
  await door.locator('input[name="login"]').fill(ACCOUNT)
  await door.locator('input[name="password"]').fill(randomBytes(12).toString('hex'))
  await door.getByRole('button', { name: 'Sign-in' }).click()
  await door.getByRole('button', { name: 'Continue' }).click()
  await door.waitForURL((u) => u.href.startsWith(UI) && !u.pathname.startsWith('/login'))
  mkdirSync(DATA_DIR, { recursive: true })
  await context.storageState({ path: BROWSER_STATE })
  await door.close()
  console.log('signed in as', ACCOUNT)
}

await page.goto(UI + '/', { waitUntil: 'domcontentloaded', timeout: 120_000 })

// The dictation status must be served with the model installed.
const status = await page.evaluate(async () => {
  const r = await fetch('/api/chat/v1/dictation/status', { headers: { Accept: 'application/json' } })
  return r.ok ? r.json() : { served: false, http: r.status }
})
check('dictation served', status.served === true, JSON.stringify(status))
check('model files present', status.model_files_present === true)

// Start dictation through the composer's mic button.
const mic = page.locator('.aui-composer-dictate').first()
await mic.waitFor({ timeout: 60_000 })
await mic.click()
console.log('dictation started; speaking the fixture…')

// The fixture is ~8.3s; the engine needs ~1s to fill its buffer, then decodes
// faster than real time. Wait for interim text, then stop.
await page.waitForTimeout(11_000)
const stop = page.locator('.aui-composer-stop-dictation').first()
if (await stop.count()) await stop.click()
await page.waitForTimeout(3_000)

// The transcript must be in the composer (interim or committed).
const draft = await page.evaluate(() => {
  const el = document.querySelector('.aui-composer-input .ProseMirror')
  return el ? el.textContent : ''
})
console.log('composer draft:', JSON.stringify(draft))
const words = (draft ?? '').toLowerCase()
check('transcript landed in composer', /tent|opening|glance|amiss|master/.test(words), draft?.slice(0, 120))
check('no sentencepiece markers', !(draft ?? '').includes('▁'))

console.log(problems.length ? `Page errors:\n${problems.join('\n')}` : 'No page errors')
await browser.close()
console.log(failed.length ? `FAILED: ${failed.join('; ')}` : 'All dictation checks passed')
process.exit(failed.length ? 1 : 0)
