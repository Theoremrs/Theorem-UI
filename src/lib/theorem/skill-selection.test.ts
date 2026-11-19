// SOURCING: bun:test over the pure draft-to-selection rule, with the same
// directive formatter the composer writes with.
import { expect, test } from 'bun:test'
import { defaultDirectiveFormatter } from '@assistant-ui/react'
import { skillTurnOptions } from './skill-selection'

const pick = (id: string, label: string) =>
  defaultDirectiveFormatter.serialize({ id, type: 'skill', label })

test('a draft with no skill pick sends no skills field', () => {
  expect(skillTurnOptions('Just a question.')).toEqual({})
  expect(skillTurnOptions('')).toEqual({})
})

test('a picked skill rides the turn as its catalog id', () => {
  const draft = `${pick('review', 'Review')} Look at this change.`
  expect(skillTurnOptions(draft)).toEqual({ skills: { ids: ['review'] } })
})

test("an MCP skill's id keeps its connection and uri", () => {
  const id = 'mcp:docs/skill://review/SKILL.md'
  const draft = `${pick(id, 'review')} Please review.`
  expect(skillTurnOptions(draft)).toEqual({ skills: { ids: [id] } })
})

test('several picks ride in order, once each', () => {
  const draft = `${pick('review', 'Review')} and ${pick('plan', 'Plan')} then ${pick('review', 'Review')} again`
  expect(skillTurnOptions(draft)).toEqual({
    skills: { ids: ['review', 'plan'] },
  })
})

test('a tool or command directive is not a skill pick', () => {
  const tool = defaultDirectiveFormatter.serialize({
    id: 'grep',
    type: 'tool',
    label: 'Grep',
  })
  expect(skillTurnOptions(`${tool} find it`)).toEqual({})
})
