import { afterEach, expect, test } from 'bun:test'
import { cleanup, render } from '../../../test/blocks/render'
import { readSkillLoad, SkillLoadPart } from './skill-load-part'
import { drawsInStep, isStepDataPart } from '@/lib/theorem/run-parts'

afterEach(cleanup)

test('the same receipt renders for explicit and model-selected skills', async () => {
  for (const selection of ['explicit', 'model'] as const) {
    await render(
      <SkillLoadPart
        type="data"
        name="theorem-skill_load"
        status={{ type: 'complete' }}
        data={{
          id: 'review',
          name: 'Review',
          source: 'mcp',
          loaded: true,
          selection,
          contentHash: 'sha256:example',
          instructionBytes: 100,
        }}
      />,
    )
    expect(document.body.textContent).toContain('Loaded Review')
    expect(document.body.textContent).toContain(
      selection === 'explicit' ? 'You selected' : 'Theo selected',
    )
    await cleanup()
  }
})

test('a refused skill is visible without claiming it loaded', async () => {
  await render(
    <SkillLoadPart
      type="data"
      name="theorem-skill_load"
      status={{ type: 'complete' }}
      data={{
        id: 'review',
        loaded: false,
        selection: 'explicit',
        reason: 'The connection is off.',
      }}
    />,
  )
  expect(document.body.textContent).toContain('Could not load review')
  expect(document.body.textContent).toContain('The connection is off.')
  expect(readSkillLoad({ id: 'review', loaded: 'yes' })).toBeUndefined()
})

test('a skill receipt belongs to the activity and draws its own status', () => {
  const part = { type: 'data', name: 'theorem-skill_load' }
  expect(isStepDataPart(part)).toBe(true)
  expect(drawsInStep(part)).toBe(true)
})
