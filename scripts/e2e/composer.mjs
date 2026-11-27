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
  // Chromium lets the page write the clipboard a real paste then reads.
  const context = await browser.newContext(
    engine === chromium
      ? { permissions: ['clipboard-read', 'clipboard-write'] }
      : {},
  )
  const page = await context.newPage()
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
  const attachments = () => page.getByTestId('attachments').textContent()
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
  await input.click()
  await page.keyboard.type('```')
  await page.keyboard.press('Enter')
  await code.waitFor()
  const python = [
    'from pathlib import Path',
    '',
    'def read_lines(path: Path) -> list[str]:',
    '    with path.open("r", encoding="utf-8") as stream:',
    '        return [line.strip() for line in stream if line.strip()]',
    '',
    'if __name__ == "__main__":',
    '    for line in read_lines(Path("notes.txt")):',
    '        print(line)',
  ].join('\n')
  await page.keyboard.insertText(python)
  const detected = await page
    .waitForFunction(() =>
      document
        .querySelector('[data-testid="draft"]')
        .textContent.startsWith('```python\n'),
    )
    .then(
      () => true,
      () => false,
    )
  check(
    'a bare fence loads the detector and adds the inferred language',
    detected && (await draft()) === `\`\`\`python\n${python}\n\`\`\``,
    await draft(),
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
  // A real paste: the text goes on the system clipboard and the paste key
  // reads it back, so the browser builds the paste event itself.
  const realPaste = async (text) => {
    await page.evaluate((value) => navigator.clipboard.writeText(value), text)
    await page.keyboard.press('ControlOrMeta+V')
  }
  const until = (testId, test, timeout = 3000) =>
    page
      .waitForFunction(
        ([id, source]) =>
          new Function('text', `return ${source}`)(
            document.querySelector(`[data-testid="${id}"]`).textContent,
          ),
        [testId, test],
        { timeout },
      )
      .catch(() => undefined)
  const LONG = Array.from(
    { length: 120 },
    (_, line) => `Log line ${line + 1}: request served`,
  ).join('\n')
  const tile = page.locator('.aui-attachment-tile')

  await load('Empty')
  await input.click()
  await realPaste(LONG)
  await until('attachments', "text === 'Pasted text.txt'")
  check(
    'a long paste becomes a Pasted text attachment and leaves the draft empty',
    (await attachments()) === 'Pasted text.txt' && (await draft()) === '',
    { attachments: await attachments(), draft: (await draft()).slice(0, 40) },
  )
  await page
    .locator('.aui-attachment-tile[role="button"]')
    .waitFor({ state: 'visible', timeout: 3000 })
    .catch(() => undefined)
  check(
    "the tray shows the attachment element's tile, previewing the text",
    (await tile.count()) === 1 &&
      (await tile.getAttribute('aria-label')) === 'Preview Pasted text.txt',
    await tile.getAttribute('aria-label'),
  )
  await realPaste(LONG.toUpperCase())
  await until('attachments', "text.split('\\n').length === 2")
  check(
    'a second long paste is numbered apart from the first',
    (await attachments()) === 'Pasted text.txt\nPasted text 2.txt',
    await attachments(),
  )
  await page.getByRole('button', { name: 'Send message' }).click()
  await until('sent-count', "text === '1'")
  check(
    'a draft of pasted texts alone can be sent',
    (await sent()) === '1' && (await attachments()) === '',
    { sent: await sent(), attachments: await attachments() },
  )

  await load('Empty')
  await input.click()
  await realPaste(LONG)
  await page
    .locator('.aui-attachment-tile[role="button"]')
    .waitFor({ state: 'visible', timeout: 3000 })
  await tile.click()
  const body = page.locator('.aui-pasted-text-body')
  await body.waitFor({ state: 'visible' })
  check(
    'the tile opens the whole pasted text with its length',
    (await body.textContent()) === LONG &&
      (await page.locator('.aui-pasted-text-dialog').textContent()).includes(
        `120 lines · ${LONG.length.toLocaleString('en-US')} characters`,
      ),
  )
  // This page carries none of the app's styles, so the dialog is not laid
  // over the modal's inert layer; the button is pressed from the keyboard.
  await page.getByRole('button', { name: 'Paste inline' }).press('Enter')
  await until('attachments', "text === ''")
  await until('draft', "text.includes('Log line 120')")
  // The editor takes the cursor once the dialog has let go of the page, and
  // the caret is where the paste would have left it: after the text.
  await page
    .waitForFunction(
      () => document.activeElement?.closest('.ProseMirror') !== null,
      undefined,
      { timeout: 3000 },
    )
    .catch(() => undefined)
  await page.keyboard.type(' (end)')
  await until('draft', "text.endsWith('(end)')")
  check(
    'Paste inline puts the text in the draft, drops the tile and keeps the cursor there',
    (await attachments()) === '' &&
      (await draft()).startsWith('Log line 1: request served') &&
      (await draft()).endsWith('Log line 120: request served (end)') &&
      (await tile.count()) === 0 &&
      (await input.evaluate((el) => el.contains(document.activeElement))),
    {
      attachments: await attachments(),
      tail: (await draft()).slice(-40),
      tiles: await tile.count(),
      focused: await page.evaluate(() => document.activeElement?.className),
    },
  )

  await load('Empty')
  await input.click()
  await realPaste('A short note')
  await until('draft', "text === 'A short note'")
  check(
    'a short paste goes in the draft',
    (await draft()) === 'A short note' && (await attachments()) === '',
    { draft: await draft(), attachments: await attachments() },
  )

  await load('Code')
  await code.waitFor({ state: 'visible' })
  await code.click()
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await realPaste(LONG)
  await until('draft', "text.includes('Log line 120')")
  check(
    'a long paste into a code block stays in the code',
    (await attachments()) === '' &&
      (await draft()).startsWith('```ts\nconst first = 1\nLog line 1:') &&
      (await draft()).includes('Log line 120: request served\n```'),
    { attachments: await attachments(), draft: (await draft()).slice(0, 60) },
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
