// SOURCING: bun:test over the composer's directive chips (./composer-directives): which directives a run of text holds, read with assistant-ui's own default formatter as the oracle for the syntax it writes
import { defaultDirectiveFormatter } from '@assistant-ui/react'
import { describe, expect, test } from 'bun:test'
import { findDirectives } from './composer-directives'

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
