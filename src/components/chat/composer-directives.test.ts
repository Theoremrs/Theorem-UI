// SOURCING: bun:test over the composer's directive chips (./composer-directives): which directives a run of text holds, read with assistant-ui's own default formatter as the oracle for the syntax it writes
import { defaultDirectiveFormatter } from '@assistant-ui/react'
import { describe, expect, test } from 'bun:test'
import { Schema } from '@milkdown/kit/prose/model'
import { EditorState } from '@milkdown/kit/prose/state'
import { documentDirectives, findDirectives } from './composer-directives'

describe('findDirectives', () => {
  test('finds every directive the composer writes, as assistant-ui writes it', () => {
    const picks = [
      { id: 'recall', type: 'tool', label: 'recall' },
      { id: 'pack:review', type: 'skill', label: 'Review' },
      { id: 'record:Person/person:noor', type: 'record', label: 'Noor' },
      { id: 'document:doc:kiln', type: 'document', label: 'Kiln [notes]' },
    ]
    const written = picks.map((pick) =>
      defaultDirectiveFormatter.serialize(pick),
    )
    const text = `ask ${written.join(' and ')}.`
    const found = findDirectives(text)
    expect(found.map(({ type, label }) => [type, label])).toEqual(
      picks.map(({ type, label }) => [type, label]),
    )
    expect(found.map(({ from, to }) => text.slice(from, to))).toEqual(written)
  })

  test('another type, or unfinished syntax, is ordinary text', () => {
    expect(findDirectives(':note[Noor]{name=x} :tool[] :record[Noor')).toEqual(
      [],
    )
  })
})

// The composer's node and mark shapes that matter here: inline code is a mark
// whose spec says `code`, a link is a mark, a hard break is an inline leaf.
const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    hardbreak: { inline: true, group: 'inline' },
  },
  marks: {
    emphasis: {},
    inlineCode: { code: true },
    link: { attrs: { href: {} } },
  },
})

function stateOf(
  children: (
    | string
    | { text: string; mark: 'emphasis' | 'inlineCode' | 'link' }
    | 'break'
  )[],
) {
  const inline = children.map((child) =>
    child === 'break'
      ? schema.node('hardbreak')
      : typeof child === 'string'
        ? schema.text(child)
        : schema.text(child.text, [
            schema.mark(child.mark, child.mark === 'link' ? { href: '#' } : {}),
          ]),
  )
  return EditorState.create({
    doc: schema.node('doc', null, [schema.node('paragraph', null, inline)]),
  })
}

const labels = (state: EditorState) =>
  documentDirectives(state).map(({ label }) => label)

describe('documentDirectives', () => {
  test('a directive can span ordinary marks', () => {
    expect(
      labels(
        stateOf(['ask :record[No', { text: 'or', mark: 'emphasis' }, ']']),
      ),
    ).toEqual(['Noor'])
  })

  test('inline code and a link label stay as written', () => {
    expect(
      labels(
        stateOf([
          'see ',
          { text: ':record[example]{name=x}', mark: 'inlineCode' },
          ' and ',
          { text: ':tool[recall]', mark: 'link' },
          ' then :tool[real]',
        ]),
      ),
    ).toEqual(['real'])
  })

  test('no directive reaches across inline code or a hard break', () => {
    expect(
      labels(stateOf([':record[No', { text: 'x', mark: 'inlineCode' }, 'or]'])),
    ).toEqual([])
    expect(labels(stateOf([':record[No', 'break', 'or]{name=x}']))).toEqual([])
  })
})
