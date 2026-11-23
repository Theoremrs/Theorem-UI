// SOURCING: bun:test over happy-dom with the repo's render helpers (test/blocks/render); assistant-ui's external-store runtime and SimpleTextAttachmentAdapter stand in for Theorem
import { act, useEffect } from 'react'
import { afterEach, expect, test } from 'bun:test'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  SimpleImageAttachmentAdapter,
  SimpleTextAttachmentAdapter,
  useAui,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type {
  AppendMessage,
  AttachmentAdapter,
  ThreadMessageLike,
} from '@assistant-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { Thread } from '../assistant-ui/elements/thread.aui'
import { ComposerEditor } from './composer-editor'
import { PASTED_TEXT_MIN_LINES } from './pasted-text'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../../test/blocks/render'

const DRAFT = `## Release notes

Ship the **composer** with *Markdown* and \`inline code\`, as the [Milkdown docs](https://milkdown.dev) describe.

- Lists stay lists
- with a second item

> A quote reads as a quote.

\`\`\`ts
const sent = composer.text
\`\`\``

const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})
afterEach(cleanup)

let composer: ReturnType<typeof useAui>['composer']
function Draft({ text }: { text?: string }) {
  const aui = useAui()
  useEffect(() => {
    composer = aui.composer
    if (text !== undefined) aui.composer.setText(text)
  }, [aui, text])
  return null
}

function Harness({
  text,
  sent = [],
  edited = [],
  messages = [],
  isRunning = false,
  bare = false,
  attachments = new SimpleTextAttachmentAdapter(),
}: {
  text?: string
  sent?: AppendMessage[]
  edited?: AppendMessage[]
  messages?: ThreadMessageLike[]
  isRunning?: boolean
  bare?: boolean
  attachments?: AttachmentAdapter
}) {
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning,
    onNew: async (message) => {
      sent.push(message)
    },
    onEdit: async (message) => {
      edited.push(message)
    },
    adapters: { attachments },
  })
  return (
    <QueryClientProvider client={client}>
      <AssistantRuntimeProvider runtime={runtime}>
        <Draft text={text} />
        {bare ? (
          <ComposerPrimitive.Root>
            <ComposerEditor label="Message input" />
            <ComposerPrimitive.Send aria-label="Send message">
              Send
            </ComposerPrimitive.Send>
          </ComposerPrimitive.Root>
        ) : (
          <Thread autoFocus={false} />
        )}
      </AssistantRuntimeProvider>
    </QueryClientProvider>
  )
}

const textOf = (message: AppendMessage) =>
  message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('\n')

const editorOf = (container: HTMLElement, label = 'Message input') =>
  waitFor(() =>
    container.querySelector<HTMLElement>(`.ProseMirror[aria-label="${label}"]`),
  )

/** What a person's typing leaves on the page, read by the editor a moment later. */
async function typed(editor: HTMLElement, change: () => void) {
  await act(async () => {
    change()
    editor.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: 'insertText' }),
    )
    await Bun.sleep(10)
  })
}

const sendButton = (container: HTMLElement) =>
  container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!

test('a Markdown draft shows formatted, and goes out as the Markdown it was', async () => {
  const sent: AppendMessage[] = []
  const { container } = await render(<Harness text={DRAFT} sent={sent} />)
  const editor = await editorOf(container)
  await waitFor(() => editor.querySelector('h2'))
  expect(editor.querySelector('h2')!.textContent).toBe('Release notes')
  expect(editor.querySelector('strong')!.textContent).toBe('composer')
  expect(editor.querySelector('em')!.textContent).toBe('Markdown')
  expect(editor.querySelector('p code')!.textContent).toBe('inline code')
  expect(editor.querySelector('p a')!.getAttribute('href')).toBe(
    'https://milkdown.dev',
  )
  expect(editor.querySelectorAll('li')).toHaveLength(2)
  expect(editor.querySelector('blockquote')!.textContent).toBe(
    'A quote reads as a quote.',
  )
  // Showing it formatted is not an edit: the draft is still the text it was given.
  expect(composer.getState().text).toBe(DRAFT)
  await waitFor(() => !sendButton(container).disabled)
  await click(sendButton(container))
  await waitFor(() => sent.length)
  expect(textOf(sent[0]!)).toBe(DRAFT)
  expect(composer.getState().text).toBe('')
  expect(editor.textContent).toBe('')
})

test('an edit to a formatted draft keeps literal text literal in its Markdown payload', async () => {
  const { container } = await render(
    <Harness text="Ship the **composer** in *one* go" />,
  )
  const editor = await editorOf(container)
  await waitFor(() => editor.querySelector('strong'))
  await typed(editor, () =>
    editor.querySelector('p')!.append(', snake_case * 2 < 3 [x] #1'),
  )
  const paragraph = fromMarkdown(composer.getState().text).children[0]
  expect(paragraph?.type).toBe('paragraph')
  if (paragraph?.type !== 'paragraph') return
  expect(paragraph.children).toMatchObject([
    { type: 'text', value: 'Ship the ' },
    { type: 'strong', children: [{ type: 'text', value: 'composer' }] },
    { type: 'text', value: ' in ' },
    { type: 'emphasis', children: [{ type: 'text', value: 'one' }] },
    { type: 'text', value: ' go, snake_case * 2 < 3 [x] #1' },
  ])
})

test('a typed address keeps its text without adding a link mark', async () => {
  const { container } = await render(<Harness text="" />)
  const editor = await editorOf(container)
  await typed(editor, () => {
    editor.querySelector('p')!.textContent =
      'Read https://milkdown.dev/docs first'
  })
  const paragraph = fromMarkdown(composer.getState().text).children[0]
  expect(paragraph?.type).toBe('paragraph')
  if (paragraph?.type !== 'paragraph') return
  expect(paragraph.children).toMatchObject([
    { type: 'text', value: 'Read https://milkdown.dev/docs first' },
  ])
})

test('the input has a name, a role and its placeholder for assistive technology', async () => {
  const { container } = await render(<Harness text="" />)
  const editor = await editorOf(container)
  expect(editor.getAttribute('role')).toBe('textbox')
  expect(editor.getAttribute('aria-multiline')).toBe('true')
  expect(editor.getAttribute('contenteditable')).toBe('true')
  expect(editor.getAttribute('aria-placeholder')).toBe(
    'Write a message…',
  )
  // Crepe's block handle, slash menu and top bar are switched off, not hidden.
  expect(container.querySelector('.milkdown-block-handle')).toBeNull()
  expect(container.querySelector('.milkdown-slash-menu')).toBeNull()
  expect(container.querySelector('.milkdown-top-bar')).toBeNull()
})

test('editing an earlier message opens it in the editor and resends the changed Markdown', async () => {
  const edited: AppendMessage[] = []
  const { container } = await render(
    <Harness
      edited={edited}
      messages={[
        {
          id: 'u1',
          role: 'user',
          content: [{ type: 'text', text: 'Compare **Chrome** and Firefox' }],
        },
      ]}
    />,
  )
  await click(
    await waitFor(() => container.querySelector('.aui-user-action-edit')),
  )
  const editor = await editorOf(container, 'Edit message')
  await waitFor(() => editor.querySelector('strong'))
  expect(editor.textContent).toBe('Compare Chrome and Firefox')
  await typed(editor, () => editor.querySelector('p')!.append(' on Linux'))
  await click(buttonNamed(container, 'Send')!)
  await waitFor(() => edited.length)
  expect(textOf(edited[0]!)).toBe('Compare **Chrome** and Firefox on Linux')
  expect(edited[0]!.parentId).toBeNull()
})

test('a file pasted into the editor becomes an attachment, and its text stays out', async () => {
  const { container } = await render(<Harness text="" />)
  const editor = await editorOf(container)
  const paste = Object.assign(new Event('paste', { bubbles: true }), {
    clipboardData: {
      files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })],
    },
  })
  await act(async () => {
    editor.dispatchEvent(paste)
  })
  await waitFor(() => composer.getState().attachments.length)
  expect(composer.getState().attachments[0]!.name).toBe('notes.txt')
  expect(composer.getState().text).toBe('')
})

const LONG = Array.from(
  { length: PASTED_TEXT_MIN_LINES },
  (_, line) => `Log line ${line + 1}: request served`,
).join('\n')

/** A paste of plain text, as the browser hands it to the editor. */
async function pasteText(target: Element, text: string) {
  const data = new DataTransfer()
  data.setData('text/plain', text)
  const paste = Object.assign(
    new Event('paste', { bubbles: true, cancelable: true }),
    { clipboardData: data },
  )
  await act(async () => {
    target.dispatchEvent(paste)
    await Bun.sleep(10)
  })
  return paste
}

test('a long pasted text becomes an attachment, and the draft stays as it was', async () => {
  const { container } = await render(<Harness text="Summarise this log" />)
  const editor = await editorOf(container)
  await waitFor(() => editor.textContent === 'Summarise this log')
  const paste = await pasteText(editor, LONG)
  expect(paste.defaultPrevented).toBe(true)
  await waitFor(() => composer.getState().attachments.length)
  const [attachment] = composer.getState().attachments
  expect(attachment!.name).toBe('Pasted text.txt')
  expect(await attachment!.file!.text()).toBe(LONG)
  expect(composer.getState().text).toBe('Summarise this log')
  // The tray shows the attachment element's tile, which previews the text.
  await waitFor(
    () =>
      container
        .querySelector('.aui-attachment-tile')
        ?.getAttribute('aria-label') === 'Preview Pasted text.txt',
  )

  await pasteText(editor, LONG.toUpperCase())
  await waitFor(() => composer.getState().attachments.length === 2)
  expect(composer.getState().attachments[1]!.name).toBe('Pasted text 2.txt')
})

test('a short pasted text goes in the draft', async () => {
  const { container } = await render(<Harness text="" />)
  const editor = await editorOf(container)
  await pasteText(editor, 'A short note')
  await waitFor(() => composer.getState().text.includes('A short note'))
  expect(composer.getState().attachments).toHaveLength(0)
})

test('a long paste stays in the draft when the attachments take no plain text', async () => {
  const { container } = await render(
    <Harness text="" attachments={new SimpleImageAttachmentAdapter()} />,
  )
  const editor = await editorOf(container)
  await pasteText(editor, LONG)
  await waitFor(() => composer.getState().text.includes('Log line 80'))
  expect(composer.getState().attachments).toHaveLength(0)
})

test('Paste inline puts a pasted text back in the draft and drops its attachment', async () => {
  const { container } = await render(<Harness text="" />)
  const editor = await editorOf(container)
  await pasteText(editor, LONG)
  const tile = await waitFor(() =>
    container.querySelector<HTMLElement>('.aui-attachment-tile[role="button"]'),
  )
  await click(tile)
  const body = await waitFor(() =>
    document.querySelector('.aui-pasted-text-body'),
  )
  expect(body.textContent).toBe(LONG)
  expect(document.querySelector('.aui-pasted-text-dialog')?.textContent).toContain(
    `${PASTED_TEXT_MIN_LINES} lines · ${LONG.length.toLocaleString()} characters`,
  )
  await click(await waitFor(() => buttonNamed(document, 'Paste inline')))
  await waitFor(() => composer.getState().attachments.length === 0)
  await waitFor(() => composer.getState().text.includes('Log line 80'))
  expect(composer.getState().text).toContain('Log line 1: request served')
  expect(container.querySelector('.aui-attachment-tile')).toBeNull()
})

test('Ctrl+Enter in an empty editor reaches the form, and a writer can clear the text', async () => {
  const sent: AppendMessage[] = []
  const { container } = await render(<Harness text="" sent={sent} />)
  const editor = await editorOf(container)
  let submits = 0
  const form = editor.closest('form')!
  form.addEventListener('submit', () => submits++)
  await act(async () => {
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        bubbles: true,
      }),
    )
  })
  // The form hears the submit, so a handler of its own can answer it; with
  // nothing to send, assistant-ui sends nothing.
  expect(submits).toBe(1)
  expect(sent).toHaveLength(0)

  await typed(editor, () => {
    editor.querySelector('p')!.textContent = 'A reply to the review'
  })
  expect(composer.getState().text).toBe('A reply to the review')
  await act(async () => composer.setText(''))
  await waitFor(() => editor.textContent === '')
  expect(composer.getState().text).toBe('')
})

test.each([true, false])('Shift+Enter inserts a break with isRunning=%s', async (isRunning) => {
  const sent: AppendMessage[] = []
  const { container } = await render(
    <Harness text="Keep writing" sent={sent} isRunning={isRunning} bare />,
  )
  const editor = await editorOf(container)
  await waitFor(() => editor.textContent === 'Keep writing')
  let submits = 0
  editor.closest('form')!.addEventListener('submit', () => submits++)
  await act(async () => {
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  expect(submits).toBe(0)
  expect(sent).toHaveLength(0)
  expect(editor.querySelectorAll('br:not(.ProseMirror-trailingBreak)')).toHaveLength(1)
  expect(composer.getState().text).toContain('Keep writing')
})

for (const modifiers of [
  { ctrlKey: true },
  { metaKey: true, shiftKey: true },
]) {
  test(`explicit send uses form admission with ${JSON.stringify(modifiers)}`, async () => {
    const sent: AppendMessage[] = []
    const { container } = await render(
      <Harness text="Keep this draft" sent={sent} />,
    )
    const editor = await editorOf(container)
    await waitFor(() => editor.textContent === 'Keep this draft')
    let submits = 0
    editor.closest('form')!.addEventListener('submit', (event) => {
      submits++
      event.preventDefault()
    })
    await act(async () => {
      editor.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          ...modifiers,
        }),
      )
    })
    expect(submits).toBe(1)
    expect(sent).toHaveLength(0)
    expect(composer.getState().text).toBe('Keep this draft')
  })
}

test('Enter in an auxiliary editor field cannot implicitly submit the document', async () => {
  const sent: AppendMessage[] = []
  const { container } = await render(
    <Harness text="Keep this document" sent={sent} bare />,
  )
  const editor = await editorOf(container)
  // The wrapper must protect native fields supplied by Crepe (link URL and
  // language search). Native implicit submission itself is checked in Chromium.
  const field = document.createElement('input')
  editor.closest('.theorem-composer')!.append(field)
  let fieldKeys = 0
  field.addEventListener('keydown', () => fieldKeys++)
  let submits = 0
  field.closest('form')!.addEventListener('submit', () => submits++)
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  })
  await act(async () => {
    field.dispatchEvent(event)
  })
  expect(event.defaultPrevented).toBe(true)
  expect(fieldKeys).toBe(1)
  expect(submits).toBe(0)
  expect(sent).toHaveLength(0)
  expect(composer.getState().text).toBe('Keep this document')
})

test('an IME composition confirmation never submits the document', async () => {
  const sent: AppendMessage[] = []
  const { container } = await render(<Harness text="入力" sent={sent} />)
  const editor = await editorOf(container)
  let submits = 0
  editor.closest('form')!.addEventListener('submit', () => submits++)
  await act(async () => {
    editor.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  expect(submits).toBe(0)
  expect(sent).toHaveLength(0)
  expect(composer.getState().text).toBe('入力')
})
