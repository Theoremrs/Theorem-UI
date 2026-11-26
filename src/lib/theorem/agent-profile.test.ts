// SOURCING: none — bun:test over ./agent-profile's pure helpers with profiles built by hand
import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_PROFILE,
  PROFILE_LIMITS,
  entriesOf,
  profileProblem,
  shownProfile,
} from './agent-profile'
import type { AgentProfile } from './agent-profile'

const profile = (patch: Partial<AgentProfile> = {}): AgentProfile => ({
  name: 'Ada',
  representation: { kind: 'character', reference: 'owl' },
  ...patch,
})

describe('shownProfile', () => {
  test('shows Theo until a profile is saved or when the route is not served', () => {
    expect(shownProfile(undefined)).toBe(DEFAULT_PROFILE)
    expect(shownProfile({ served: false })).toBe(DEFAULT_PROFILE)
    expect(
      shownProfile({ served: true, agentId: 'a', revision: 1, profile: null }),
    ).toBe(DEFAULT_PROFILE)
  })

  test('shows the saved profile', () => {
    const saved = profile()
    expect(
      shownProfile({ served: true, agentId: 'a', revision: 2, profile: saved }),
    ).toBe(saved)
  })
})

describe('entriesOf', () => {
  test('keeps one trimmed entry per non-empty line', () => {
    expect(entriesOf('  careful \n\n\tterse\n ')).toEqual(['careful', 'terse'])
    expect(entriesOf('')).toEqual([])
  })
})

describe('profileProblem', () => {
  test('accepts a profile within the bounds', () => {
    expect(profileProblem(profile())).toBeUndefined()
  })

  test('names the field that is out of bounds', () => {
    expect(profileProblem(profile({ name: '   ' }))).toBe(
      'Give the agent a name.',
    )
    expect(
      profileProblem(profile({ name: 'x'.repeat(PROFILE_LIMITS.name + 1) })),
    ).toContain('name')
    expect(
      profileProblem(
        profile({ description: 'x'.repeat(PROFILE_LIMITS.description + 1) }),
      ),
    ).toContain('description')
    expect(
      profileProblem(
        profile({
          characteristics: Array.from(
            { length: PROFILE_LIMITS.entries + 1 },
            () => 'a',
          ),
        }),
      ),
    ).toContain('characteristics')
    expect(
      profileProblem(
        profile({ instruction_refs: ['x'.repeat(PROFILE_LIMITS.entry + 1)] }),
      ),
    ).toContain('instruction references')
    expect(
      profileProblem(
        profile({
          representation: {
            kind: 'mark',
            reference: 'x'.repeat(PROFILE_LIMITS.reference + 1),
          },
        }),
      ),
    ).toContain('representation')
  })
})
