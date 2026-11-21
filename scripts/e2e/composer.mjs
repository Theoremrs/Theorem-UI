// Native browser behavior around the actual ComposerEditor and assistant-ui
// form. No Theorem server or model call is made. E2E_CHROMIUM may identify an
// installed browser; otherwise install playwright-core's expected Chromium.
//
//   node scripts/e2e/composer.mjs
//   node scripts/e2e/composer.mjs --built
import { chromium, firefox } from 'playwright-core'
import { servePage } from './harness.mjs'

const served = await servePage('composer')
const checks = []
const check = (name, pass, detail) => {
  checks.push(pass)
  console.log(
    `${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`,
  )
}
let browser

try {
  const engine = process.argv.includes('--firefox') ? firefox : chromium
  browser = await engine.launch({
    executablePath: engine === chromium ? process.env.E2E_CHROMIUM : undefined,
  })
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => {
    pageErrors.push(error.message)
    console.error(error.message)
  })
  await page.goto(served.url)
  const input = page.getByRole('textbox', { name: 'Message input' })
  await input.waitFor()
  const sent = () => page.getByTestId('sent-count').textContent()
  const submits = () => page.getByTestId('submit-count').textContent()
  const draft = () => page.getByTestId('draft').textContent()
  const load = async (name) => {
    await page
      .getByRole('button', { name: `Load ${name}`, exact: true })
      .click()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="sent-count"]').textContent ===
        '0',
    )
  }

  await load('Plain')
  await input.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('Second paragraph')
  check(
    'Shift+Enter writes a new line without submitting',
    (await sent()) === '0' &&
      (await submits()) === '0' &&
      (await draft()).includes('\nSecond paragraph'),
    await draft(),
  )
  const multiline = await draft()
  await page.keyboard.press('Enter')
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="sent-count"]').textContent === '1',
    undefined,
    { timeout: 2000 },
  )
  check(
    'Enter submits exactly the document shown',
    (await submits()) === '1' &&
      (await page.getByTestId('sent').textContent()) ===
        JSON.stringify([multiline]),
  )

  await load('Code')
  const code = page.locator('.cm-content')
  await code.waitFor({ state: 'visible' })
  await code.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('const second = 2')
  check(
    'Enter edits the real CodeMirror block without submitting',
    (await sent()) === '0' &&
      (await submits()) === '0' &&
      (await draft()).includes('const first = 1\nconst second = 2'),
    await draft(),
  )
  await page.keyboard.press('Control+Enter')
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="sent-count"]').textContent === '1',
  )
  check(
    'Control+Enter from CodeMirror submits once and keeps its code fence',
    (await submits()) === '1' &&
      (await page.getByTestId('sent').textContent()) ===
        JSON.stringify(['```ts\nconst first = 1\nconst second = 2\n```']),
  )

  await load('Empty')
  await input.click()
  await page.keyboard.type('```c++')
  await page.keyboard.press('Enter')
  await page.keyboard.type('a / b')
  await page.keyboard.press('Tab')
  check(
    'a punctuated fence enters code and Tab indents it',
    (await sent()) === '0' && (await draft()).includes('```c++\n  a / b\n'),
    await draft(),
  )

  await page.keyboard.press('Alt+ArrowDown')
  check(
    'Alt+Down leaves code in the composer',
    await input.evaluate((el) => document.activeElement === el),
  )
  await load('Empty')
  await page.getByRole('button', { name: 'Insert code block' }).click()
  await code.waitFor()
  check(
    'explicit insertion focuses code',
    await code.evaluate((el) => document.activeElement === el),
  )
  await page.keyboard.press('ControlOrMeta+z')
  check(
    'one undo removes the inserted block',
    (await code.count()) === 0 && (await draft()) === '',
  )
  await page.keyboard.press('ControlOrMeta+Shift+z')
  check('redo restores the inserted block', (await code.count()) === 1)

  const paste = (plain, html) =>
    input.evaluate(
      (el, clipboard) => {
        const data = new DataTransfer()
        if (clipboard.plain) data.setData('text/plain', clipboard.plain)
        if (clipboard.html) data.setData('text/html', clipboard.html)
        const event = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        })
        Object.defineProperty(event, 'clipboardData', { value: data })
        return !el.dispatchEvent(event)
      },
      { plain, html },
    )
  for (const [name, plain, html, expected] of [
    ['plain fence', '```ts\n  a / b\n```', '', '```ts\n  a / b\n```'],
    [
      'rich literal fence',
      '```abc9\n  a / `b`\n```',
      '<p>```abc9</p><p>  a / `b`</p><p>```</p>',
      '```abc9\n  a / `b`\n```',
    ],
    [
      'semantic code',
      '',
      '<pre><code class="language-c++">a / b<br>    c</code></pre>',
      '```c++\na / b\n    c\n```',
    ],
  ]) {
    await load('Empty')
    await input.click()
    await page.keyboard.press('ArrowRight')
    const handled = await paste(plain, html)
    await page
      .waitForFunction(
        (text) =>
          document.querySelector('[data-testid="draft"]').textContent === text,
        expected,
        { timeout: 2000 },
      )
      .catch(() => undefined)
    check(`${name} preserves code and language`, (await draft()) === expected, {
      draft: await draft(),
      handled,
      blocks: await code.count(),
    })
  }
  await page.getByRole('button', { name: 'Send message' }).click()
  check(
    'immediate button send uses the pasted code',
    (await page.getByTestId('sent').textContent()) ===
      JSON.stringify(['```c++\na / b\n    c\n```']),
  )

  await load('Plain')
  await input.focus()
  const compositionPrevented = await input.evaluate((el) => {
    el.dispatchEvent(
      new CompositionEvent('compositionstart', { bubbles: true }),
    )
    const key = new KeyboardEvent('keydown', {
      key: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    })
    el.dispatchEvent(key)
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    return key.defaultPrevented
  })
  check(
    'IME confirmation does not submit',
    !compositionPrevented && (await submits()) === '0',
  )

  await load('Code')
  await code.waitFor({ state: 'visible' })
  await page.locator('.language-button').click()
  const language = page.getByPlaceholder('Search language')
  await language.fill('typescript')
  await language.press('Enter')
  check(
    'Enter in the language search does not submit the surrounding form',
    (await sent()) === '0' && (await submits()) === '0',
    { sent: await sent(), submits: await submits() },
  )

  await load('Code')
  await code.waitFor({ state: 'visible' })
  const copy = page.locator('.copy-button')
  await copy.click()
  await copy.focus()
  await copy.press('Enter')
  check(
    'copy button click and keyboard activation do not submit',
    (await sent()) === '0' && (await submits()) === '0',
    { sent: await sent(), submits: await submits() },
  )

  await load('Markdown')
  await input.click()
  // Select a text range instead of ProseMirror's Select All.
  await input.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el.querySelector('p'))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.waitForFunction(
    () => window.getSelection()?.toString() === 'Select this text',
  )
  const bold = page.locator('[data-toolbar-item="bold"]')
  await bold.waitFor({ state: 'visible' })
  await bold.click()
  check(
    'selection toolbar formatting leaves the message in the composer',
    (await sent()) === '0' &&
      (await submits()) === '0' &&
      (await draft()) === '**Select this text**',
    await draft(),
  )

  await load('Markdown')
  await input.click()
  await input.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el.querySelector('p'))
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
  })
  await page.waitForFunction(
    () => window.getSelection()?.toString() === 'Select this text',
  )
  const link = page.locator('[data-toolbar-item="link"]')
  await link.waitFor({ state: 'visible' })
  await link.click()
  const address = page.locator('.milkdown-link-edit .input-area')
  await address.waitFor({ state: 'visible' })
  await address.fill('https://example.com/docs')
  await address.press('Enter')
  check(
    'Enter in the link address applies the link without sending the message',
    (await sent()) === '0' &&
      (await submits()) === '0' &&
      (await draft()) === '[Select this text](https://example.com/docs)',
    await draft(),
  )
  check(
    'the composer raised no browser errors',
    pageErrors.length === 0,
    pageErrors,
  )
} finally {
  await browser?.close()
  await served.close()
}

const passed = checks.filter(Boolean).length
console.log(`\n${passed} of ${checks.length} checks passed`)
process.exit(passed === checks.length ? 0 : 1)
