// SOURCING: bun:test over happy-dom with the repo's render helpers
// (test/blocks/render); the real ComposerEditor and assistant-ui's trigger
// primitives (TriggerPopoverRoot/TriggerPopover/Directive/Items) with the
// composer-tools slash matcher shape. The serializer is counted by wrapping
// SerializerState.create's remark.stringify, which every full-document
// Markdown serialization calls exactly once.
//
// This harness deliberately avoids Thread: Thread pulls in run-input.tsx,
// whose `@assistant-ui/core/react` import resolves a second copy of
// @assistant-ui/store beside the one @assistant-ui/react uses, so the Aui
// context is not shared and every Thread test crashes in this checkout. The
// composer plugin path exercised here is the same one Thread renders.
import { act, useEffect } from 'react'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  defaultDirectiveFormatter,
  useAui,
  useExternalStoreRuntime,
} from '@assistant-ui/react'
import type {
  TriggerAdapter,
  TriggerItem,
  TriggerMatcher,
  ThreadMessageLike,
} from '@assistant-ui/react'
import { SerializerState } from '@milkdown/transformer'
import type { RemarkParser } from '@milkdown/transformer'
import { TextSelection } from '@milkdown/kit/prose/state'
import { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model'
import { ComposerEditor } from './composer-editor'
import { cleanup, render, waitFor } from '../../../test/blocks/render'

/** Full-document Markdown serializations since the last reset. */
let serializations = 0
const realCreate = SerializerState.create
beforeEach(() => {
  serializations = 0
  SerializerState.create = (schema, remark: RemarkParser) =>
    realCreate(schema, {
      ...remark,
      stringify: (ast) => {
        serializations++
        return remark.stringify(ast)
      },
    } as RemarkParser)
})
afterEach(() => {
  SerializerState.create = realCreate
})

// The plugin's EditorView, captured as ProseMirror hands each state update to
// the view, so caret moves and edits go through the real dispatch path.
const realUpdateState = EditorView.prototype.updateState
EditorView.prototype.updateState = function (state) {
  ;(globalThis as { __composerView?: EditorView }).__composerView = this
  return realUpdateState.call(this, state)
}
const view = () =>
  (globalThis as { __composerView?: EditorView }).__composerView!

// happy-dom never reports an intersection; report every observed target as in
// view so Crepe's code block mounts its CodeMirror (as plan-graph.test.tsx does).
const RealIntersectionObserver = globalThis.IntersectionObserver
beforeEach(() => {
  globalThis.IntersectionObserver = class {
    private callback: IntersectionObserverCallback
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback
    }
    observe(target: Element) {
      this.callback(
        [{ target, isIntersecting: true } as IntersectionObserverEntry],
        this as unknown as IntersectionObserver,
      )
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver
})
afterEach(() => {
  globalThis.IntersectionObserver = RealIntersectionObserver
})

const TOOLS: TriggerItem[] = [
  { id: 'recall', type: 'tool', label: 'recall' },
  { id: 'remember', type: 'tool', label: 'remember' },
]
/** The composer-tools slash shape: a slash that starts the text or follows a space. */
const SLASH = /(?:^|\s)\/(\S*)$/u
const slashMatcher: TriggerMatcher = (text, _char, cursor) => {
  const query = SLASH.exec(text.slice(0, cursor))?.[1]
  if (query === undefined) return null
  return { query, offset: cursor - query.length - 1, endOffset: cursor }
}
const adapter: TriggerAdapter = {
  categories: () => [],
  categoryItems: () => [],
  search: (query) =>
    TOOLS.filter((tool) => tool.label.startsWith(query.toLowerCase())),
}

let composer: ReturnType<typeof useAui>['composer']
function Draft({ initial }: { initial: string }) {
  const aui = useAui()
  useEffect(() => {
    composer = aui.composer
    aui.composer.setText(initial)
  }, [aui, initial])
  return null
}
function Harness({ initial }: { initial: string }) {
  const runtime = useExternalStoreRuntime({
    messages: [],
    convertMessage: (message: ThreadMessageLike) => message,
    onNew: async () => {},
  })
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Draft initial={initial} />
      <ComposerPrimitive.TriggerPopoverRoot>
        <ComposerPrimitive.Root>
          <ComposerPrimitive.TriggerPopover
            char="/"
            adapter={adapter}
            matcher={slashMatcher}
          >
            <ComposerPrimitive.TriggerPopover.Directive
              formatter={defaultDirectiveFormatter}
            />
            <ComposerPrimitive.TriggerPopoverItems>
              {(items) => (
                <div>
                  {items.map((item, index) => (
                    <ComposerPrimitive.TriggerPopoverItem
                      key={item.id}
                      item={item}
                      index={index}
                    >
                      {item.label}
                    </ComposerPrimitive.TriggerPopoverItem>
                  ))}
                </div>
              )}
            </ComposerPrimitive.TriggerPopoverItems>
          </ComposerPrimitive.TriggerPopover>
          <ComposerEditor label="Message input" />
          <ComposerPrimitive.Send aria-label="Send message">
            Send
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ComposerPrimitive.TriggerPopoverRoot>
    </AssistantRuntimeProvider>
  )
}
afterEach(cleanup)

const options = () => [...document.querySelectorAll('[role="option"]')]
async function mount(initial: string) {
  const { container } = await render(<Harness initial={initial} />)
  const editor = await waitFor(() =>
    container.querySelector<HTMLElement>(
      '.ProseMirror[aria-label="Message input"]',
    ),
  )
  await waitFor(() => editor.textContent.length > 0)
  // Let Milkdown's debounced markdownUpdated listener settle so it does not
  // add a serialization to the window under test.
  await act(async () => {
    editor.focus()
    await Bun.sleep(250)
  })
  return editor
}
const caret = (pos: number) =>
  act(async () => {
    const current = view()
    current.dispatch(
      current.state.tr.setSelection(
        TextSelection.create(current.state.doc, pos),
      ),
    )
    await Bun.sleep(20)
  })
const insert = (text: string) =>
  act(async () => {
    const current = view()
    current.dispatch(
      current.state.tr.insertText(text, current.state.selection.head),
    )
    await Bun.sleep(20)
  })
const backspace = () =>
  act(async () => {
    const current = view()
    current.dispatch(
      current.state.tr.delete(
        current.state.selection.head - 1,
        current.state.selection.head,
      ),
    )
    await Bun.sleep(20)
  })
/** The position just after the given text node's content, found in the doc. */
function endOf(text: string) {
  let end = -1
  view().state.doc.descendants((node: ProseMirrorNode, pos: number) => {
    if (node.isText && node.text === text) end = pos + node.nodeSize
  })
  if (end < 0) throw new Error(`no text node ${JSON.stringify(text)}`)
  return end
}
const pickFirst = () =>
  act(async () => {
    options()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Bun.sleep(30)
  })

// Caret placement is skipped when neither the doc nor the selection head
// changed, and skipped entirely while the serialized text carries no trigger
// character. An ordinary edit therefore costs one full-document write.

test('a selection change with a fixed head does not serialize the document', async () => {
  await mount('Hello world')
  const head = endOf('Hello world')
  await caret(head)
  serializations = 0
  // Extend the selection leftward while the head stays put (shift+arrow / drag).
  await act(async () => {
    const current = view()
    current.dispatch(
      current.state.tr.setSelection(
        TextSelection.create(current.state.doc, 1, head),
      ),
    )
    await Bun.sleep(20)
  })
  expect(composer.getState().text).toBe('Hello world')
  expect(serializations).toBe(0)
  // Move the anchor again with the same head: still no serialization.
  serializations = 0
  await act(async () => {
    const current = view()
    current.dispatch(
      current.state.tr.setSelection(
        TextSelection.create(current.state.doc, 5, head),
      ),
    )
    await Bun.sleep(20)
  })
  expect(serializations).toBe(0)
})

test('caret moves between edits add no serialization', async () => {
  await mount('Hello world')
  await caret(endOf('Hello world'))
  // Each edit writes its new document once. The caret moves between them read
  // no document at all, because the text carries no trigger character.
  serializations = 0
  await insert('a')
  const afterFirst = serializations
  await caret(5)
  await caret(endOf('Hello worlda'))
  await insert('b')
  // Each edit serializes the new doc once for the authoritative text and once
  // for the caret mark; the caret moves between them add only the marked one.
  expect(composer.getState().text).toBe('Hello worldab')
  expect(afterFirst).toBe(1)
  expect(serializations).toBe(2)
})

test('a plain keystroke serializes the document once', async () => {
  await mount('Hello world')
  await caret(endOf('Hello world'))
  serializations = 0
  await insert('x')
  expect(composer.getState().text).toBe('Hello worldx')
  // The authoritative text is the only full-document write. The caret offset
  // is derived from that same string, not from a second marked pass.
  expect(serializations).toBe(1)
})

test('a keystroke in a long draft still serializes once', async () => {
  const draft = 'lorem ipsum dolor sit amet '.repeat(40).trimEnd()
  await mount(draft)
  await caret(view().state.doc.content.size - 1)
  serializations = 0
  await insert('x')
  expect(composer.getState().text).toBe(`${draft}x`)
  expect(serializations).toBe(1)
})

test('the authoritative text is current synchronously after an edit', async () => {
  await mount('Hello')
  await caret(endOf('Hello'))
  await act(async () => {
    const current = view()
    current.dispatch(
      current.state.tr.insertText(' world', current.state.selection.head),
    )
    expect(composer.getState().text).toBe('Hello world')
  })
  await act(async () => {
    const current = view()
    current.dispatch(
      current.state.tr.insertText('!', current.state.selection.head),
    )
    expect(composer.getState().text).toBe('Hello world!')
  })
})

test('a slash at the end of a paragraph opens the menu and picks', async () => {
  await mount('Hello world')
  await caret(endOf('Hello world'))
  await insert(' /')
  await waitFor(() => options().length > 0)
  expect(options().map((option) => option.textContent)).toEqual([
    'recall',
    'remember',
  ])
  await pickFirst()
  expect(composer.getState().text).toBe('Hello world :tool[recall] ')
})

test('a slash at the very start of a block opens the menu and picks', async () => {
  await mount('word')
  await caret(1)
  await insert('/')
  await waitFor(() => options().length > 0)
  expect(options().length).toBe(2)
  await pickFirst()
  expect(composer.getState().text).toBe(':tool[recall] word')
})

test('a slash typed after a parked space opens the menu', async () => {
  await mount('Hello')
  await caret(endOf('Hello'))
  await insert(' ')
  serializations = 0
  await insert('/')
  expect(composer.getState().text).toBe('Hello /')
  await waitFor(() => options().length > 0)
  expect(options().length).toBe(2)
})

test('a slash at the end of bold text opens the menu inside the mark', async () => {
  const editor = await mount('**hello**')
  await waitFor(() => editor.querySelector('strong'))
  await caret(endOf('hello'))
  await insert(' /rec')
  expect(composer.getState().text).toBe('**hello /rec**')
  await waitFor(() => options().length > 0)
  expect(options()[0]!.textContent).toBe('recall')
  await pickFirst()
  expect(composer.getState().text).toBe('**hello :tool[recall]** ')
})

test('a slash in a list item opens the menu and picks', async () => {
  const editor = await mount('- one\n- two')
  await waitFor(() => editor.querySelectorAll('li').length === 2)
  await caret(endOf('two'))
  await insert(' /')
  await waitFor(() => options().length > 0)
  expect(options().length).toBe(2)
  await pickFirst()
  expect(composer.getState().text).toBe('* one\n* two :tool[recall] ')
})

test('a slash in a block quote opens the menu and picks', async () => {
  const editor = await mount('> quote')
  await waitFor(() => editor.querySelector('blockquote'))
  await caret(endOf('quote'))
  await insert(' /')
  await waitFor(() => options().length > 0)
  expect(options().length).toBe(2)
  await pickFirst()
  expect(composer.getState().text).toBe('> quote :tool[recall] ')
})

test('a slash in a code block stays literal and leaves the tool picker closed', async () => {
  const editor = await mount('```ts\nconst x = 1\n```')
  const code = await waitFor(() =>
    editor.querySelector<HTMLElement>('.cm-content'),
  )
  await act(async () => {
    code.focus()
    await Bun.sleep(250)
  })
  const line = code.querySelector('.cm-line')!
  await act(async () => {
    line.textContent = 'const x = 1 /'
    window
      .getSelection()!
      .collapse(line.firstChild ?? line, line.textContent.length)
    code.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: '/',
      }),
    )
    await Bun.sleep(50)
  })
  expect(composer.getState().text).toBe('```ts\nconst x = 1 /\n```')
  expect(options().length).toBe(0)
})

test('a caret move closes the menu and moving back reopens it', async () => {
  await mount('Hello world')
  await caret(endOf('Hello world'))
  await insert(' /')
  await waitFor(() => options().length > 0)
  const lineEnd = endOf('Hello world /')
  await caret(5)
  expect(options().length).toBe(0)
  await caret(lineEnd)
  await waitFor(() => options().length > 0)
  expect(options().length).toBe(2)
})

test('a caret move within the query narrows the menu without an edit', async () => {
  await mount('a /rec b')
  await caret(endOf('a /rec b') - 2)
  await waitFor(() => options().length > 0)
  expect(options().length).toBe(1)
  serializations = 0
  await caret(endOf('a /rec b') - 3)
  expect(composer.getState().text).toBe('a /rec b')
  await waitFor(() => options().length === 2)
})

test('typing a query after the slash keeps the menu and the text', async () => {
  await mount('Hello')
  await caret(endOf('Hello'))
  await insert(' /')
  await waitFor(() => options().length > 0)
  serializations = 0
  await insert('r')
  await insert('e')
  await insert('c')
  expect(composer.getState().text).toBe('Hello /rec')
  // Each keystroke serializes the new doc for the authoritative text and for
  // the caret mark; the menu narrows as the query grows.
  expect(serializations).toBe(6)
  await waitFor(() => options().length === 1)
})

test('backspacing the query keeps the menu and the text', async () => {
  await mount('Hello')
  await caret(endOf('Hello'))
  await insert(' /rec')
  await waitFor(() => options().length > 0)
  serializations = 0
  await backspace()
  await backspace()
  await backspace()
  expect(composer.getState().text).toBe('Hello /')
  // A slash is present, so each of the three edits also places the caret.
  expect(serializations).toBe(6)
  await waitFor(() => options().length === 2)
})

test('a paste-sized insert then a slash opens the menu at the right offset', async () => {
  await mount('start')
  await caret(endOf('start'))
  serializations = 0
  await insert(' and a long pasted tail')
  expect(composer.getState().text).toBe('start and a long pasted tail')
  // No trigger character in the pasted prose: one write, not two.
  expect(serializations).toBe(1)
  await insert(' /')
  await waitFor(() => options().length > 0)
  expect(options().length).toBe(2)
  await pickFirst()
  expect(composer.getState().text).toBe(
    'start and a long pasted tail :tool[recall] ',
  )
})

test('a fixed-head selection change in a code block does not serialize', async () => {
  const editor = await mount('```ts\nconst x = 1\n```')
  const code = await waitFor(() =>
    editor.querySelector<HTMLElement>('.cm-content'),
  )
  await act(async () => {
    code.focus()
    await Bun.sleep(250)
  })
  serializations = 0
  await act(async () => {
    const current = view()
    current.dispatch(
      current.state.tr.setSelection(
        TextSelection.create(
          current.state.doc,
          2,
          current.state.selection.head,
        ),
      ),
    )
    await Bun.sleep(50)
  })
  expect(composer.getState().text).toBe('```ts\nconst x = 1\n```')
  expect(serializations).toBe(0)
})

test('a slash carried only by a link address still opens the menu', async () => {
  // The document's own text content has no slash here; the serialized Markdown
  // does. A guard reading text content would wrongly skip caret placement, so
  // the guard reads the serialized text instead.
  const editor = await mount('[docs](https://x.com/a/b)')
  await waitFor(() => editor.querySelector('a'))
  expect(editor.textContent).toBe('docs')
  expect(editor.textContent.includes('/')).toBe(false)
  expect(composer.getState().text.includes('/')).toBe(true)
  // A second paragraph, so the caret is outside the link's mark.
  await act(async () => {
    const current = view()
    current.dispatch(
      current.state.tr.insert(
        current.state.doc.content.size,
        current.state.schema.nodes.paragraph!.create(),
      ),
    )
    await Bun.sleep(20)
  })
  await caret(view().state.doc.content.size - 1)
  serializations = 0
  await insert('/')
  await waitFor(() => options().length > 0)
  expect(options().length).toBe(2)
  await pickFirst()
  expect(composer.getState().text).toBe(
    '[docs](https://x.com/a/b)\n\n:tool[recall] ',
  )
})

test('a caret move in prose without a trigger character serializes nothing', async () => {
  await mount('Hello world')
  await caret(endOf('Hello world'))
  serializations = 0
  await caret(3)
  await caret(7)
  await caret(endOf('Hello world'))
  expect(serializations).toBe(0)
  expect(composer.getState().text).toBe('Hello world')
})
