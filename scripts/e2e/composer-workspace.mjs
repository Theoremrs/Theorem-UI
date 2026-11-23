// Run against scripts/e2e/stack.mjs with E2E_SCRIPTED_MODEL=1 and the IDE host.
// Uses the real conversation and workspace layout endpoints with a test account.
import assert from 'node:assert/strict'
import { SCRIPTED_MODEL, UI } from './config.mjs'
import { finish, open } from './lib.mjs'
import { setPrincipals } from './ide-host.mjs'
import { turns } from './turns.mjs'

const session = await open('/', { browser: 'firefox' })
const { page, context, browser } = session
const { ended, json, setPreferences, writing } = turns(session)
const composer = page.getByRole('textbox', {
  name: 'Message input',
  exact: true,
})
const workspace = page.getByRole('navigation', { name: 'Workspace controls' })
const grid = page.locator('[id^="workbench-"]').first()
const status = (name) => page.getByText(name, { exact: true }).first()
const visible = async (locator) =>
  locator.waitFor({ state: 'visible', timeout: 30_000 })
const choose = (name) =>
  workspace.getByRole('button', { name, exact: true }).click()
const info = (message) => console.log(`PASS ${message}`)

try {
  await visible(composer)
  const identity = await (
    await context.request.get(`${UI}/api/environment/v1/bootstrap`)
  ).json()
  assert.ok(identity.principalId)
  setPrincipals([identity.principalId])
  await setPreferences([], `${SCRIPTED_MODEL.provider}/${SCRIPTED_MODEL.model}`)
  await composer.click()
  await page.keyboard.type('```ts')
  await page.keyboard.press('Enter')
  const code = page.locator('.cm-content')
  await visible(code)
  await page.keyboard.insertText('const composerRepair = `a / b`')
  await page.keyboard.press('ControlOrMeta+Enter')
  await page.waitForURL(/\/c\//)
  await ended()
  const threadId = decodeURIComponent(
    new URL(page.url()).pathname.split('/').at(-1),
  )
  const expected = '```ts\nconst composerRepair = `a / b`\n```'
  const snapshot = () => json(`/threads/${encodeURIComponent(threadId)}`)
  const stored = (data) =>
    data.messages
      .find((message) => message.role === 'user')
      ?.parts.find((part) => part.type === 'text')?.payload?.text
  assert.equal(stored(await snapshot()), expected)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await visible(composer)
  await visible(
    page.locator('pre').filter({ hasText: 'composerRepair' }).first(),
  )
  info('typed code reaches durable history and renders after reopening')

  await page
    .locator('pre')
    .filter({ hasText: 'composerRepair' })
    .first()
    .hover()
  await page.locator('.aui-user-action-edit').last().click()
  const edit = page.getByRole('textbox', { name: 'Edit message', exact: true })
  await visible(edit)
  const editCode = edit.locator('.cm-content')
  await editCode.fill('const composerRepair = `a / b` // edited')
  await page.keyboard.press('ControlOrMeta+Enter')
  const edited = expected.replace('`a / b`', '`a / b` // edited')
  await page.waitForFunction(
    () => !document.querySelector('[aria-label="Edit message"]'),
  )
  let actual = stored(await snapshot())
  for (let attempt = 0; actual !== edited && attempt < 30; attempt++) {
    await page.waitForTimeout(200)
    actual = stored(await snapshot())
  }
  if (actual !== edited) console.error('Stored edit', JSON.stringify(actual))
  assert.equal(actual, edited)
  await ended()
  info('editing the sent code creates durable Markdown on the selected branch')

  await composer.fill('Workspace placement draft')
  await page.getByRole('button', { name: 'Workspace', exact: true }).click()
  await visible(workspace)
  await visible(
    status('Using the default layout')
      .or(status('Layout saved to account'))
      .first(),
  )
  await choose('Full')
  await visible(grid)
  const hostId = await grid.getAttribute('id')
  assert.equal(
    await page
      .locator('[data-active-surface]')
      .getAttribute('data-workbench-placement'),
    'full',
  )
  await choose('Back to chat')
  await visible(composer)
  assert.equal(await composer.textContent(), 'Workspace placement draft')
  assert.equal(await grid.getAttribute('id'), hostId)
  await choose('Right')
  await choose('Dock right')
  await choose('Bottom')
  const drawer = page.locator('[data-workbench-placement="bottom"]')
  await page.waitForFunction(() => {
    const drawer = document.querySelector('[data-workbench-placement="bottom"]')
    const form = document.querySelector(
      '[data-appearance-role="composer-form"]',
    )
    const rail = document.querySelector('[data-appearance-width-role="rail"]')
    if (!drawer || !form || !rail) return false
    const bounds = drawer.getBoundingClientRect()
    return (
      bounds.left <= rail.getBoundingClientRect().right + 8 &&
      form.getBoundingClientRect().bottom < bounds.top
    )
  })
  assert.equal(await drawer.getAttribute('data-workbench-attachment'), 'drawer')
  await choose('Right')
  await page.setViewportSize({ width: 740, height: 680 })
  await visible(drawer)
  await page.setViewportSize({ width: 1440, height: 900 })
  const right = page.locator('[data-workbench-placement="side"]')
  await visible(right)
  assert.equal(await right.getAttribute('data-workbench-attachment'), 'docked')
  info(
    'placement preserves the draft and host, and the bottom overlay clears the composer',
  )

  await choose('Full')
  const field = page.getByRole('textbox', { name: 'Workspace input' })
  await field.focus()
  await page.keyboard.press('ControlOrMeta+Alt+b')
  await page.keyboard.type('Repair layout')
  const [saved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().includes('/api/workbench/v1/') &&
        response.request().method() === 'PUT',
    ),
    page.keyboard.press('Enter'),
  ])
  assert.equal(saved.status(), 200)
  const savedLayout = await saved.json()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await visible(status('Layout saved to account'))
  const current = await context.request.get(saved.url())
  assert.equal(current.status(), 200)
  assert.equal((await current.json()).revision, savedLayout.revision)
  const conflict = await context.request.put(saved.url(), {
    headers: await writing({ 'If-Match': String(savedLayout.revision - 1) }),
    data: { ...savedLayout, revision: savedLayout.revision - 1 },
  })
  assert.equal(conflict.status(), 409)
  info(
    'fresh layout, save, reload, and stale revision use the real account endpoint',
  )

  const layoutPath = '**/api/workbench/v1/**'
  await page.route(layoutPath, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'text/plain',
      body: 'Not Found',
    }),
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await visible(status('Could not restore layout'))
  await page.getByText('Details', { exact: true }).click()
  await visible(page.getByText('404', { exact: true }))
  await page.unroute(layoutPath)
  await page.getByRole('button', { name: 'Retry restore' }).click()
  await visible(status('Layout saved to account'))
  info('a generic 404 is explained and retry restores the account layout')

  const resumedHost = await grid.getAttribute('id')
  await page.evaluate((id) => {
    const original = Element.prototype.getBoundingClientRect
    window.workspaceReads = 0
    Element.prototype.getBoundingClientRect = function () {
      if (this.id === id) window.workspaceReads += 1
      return original.call(this)
    }
  }, resumedHost)

  await choose('Close workspace')
  await grid.waitFor({ state: 'hidden' })
  assert.equal(await grid.count(), 1)
  const hiddenReads = await page.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
    window.workspaceReads = 0
    await new Promise((resolve) => setTimeout(resolve, 500))
    return window.workspaceReads
  })
  assert.equal(hiddenReads, 0)
  info('closed workspace made zero grid geometry reads over 500 ms')
  await page.getByRole('button', { name: 'Workspace', exact: true }).click()
  await visible(grid)
  info('close hides the mounted workspace and reopening shows it again')
  await finish(session)
} finally {
  await browser.close()
}
