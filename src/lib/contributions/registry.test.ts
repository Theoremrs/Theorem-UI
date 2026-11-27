// SOURCING: bun:test over the contribution registry and the default-handler order.
import { afterEach, describe, expect, test } from 'bun:test'
import {
  ContributionError,
  registerContribution,
  resolveHandler,
  useContributions,
  useHandlerPreferences,
} from './registry'
import type { Contribution, HandlerPreferences } from './registry'

const handler = (
  id: string,
  extra: Partial<Contribution> = {},
): Contribution => ({
  kind: 'application',
  id,
  label: id,
  serves: ['crm'],
  ...extra,
})

const none: HandlerPreferences = {
  byResource: {},
  byServes: {},
  workspace: {},
  hidden: [],
}
const acme = { kind: 'extension', extensionId: 'acme' } as const

afterEach(() => {
  useContributions.setState({ contributions: new Map(), conflicts: [] })
  useHandlerPreferences.getState().resetAll()
})

describe('registering', () => {
  test('kinds and ids are checked, theorem.* is the host’s', () => {
    expect(() =>
      registerContribution({ ...handler('acme.x'), kind: 'nope' as never }),
    ).toThrow(ContributionError)
    expect(() => registerContribution(handler('theorem.crm'), acme)).toThrow(
      'built in',
    )
    expect(() =>
      registerContribution(handler('other.crm'), {
        kind: 'module',
        moduleId: 'acme.crm',
      }),
    ).toThrow('acme.crm.*')
  })

  test('the same id under another kind is a different contribution', () => {
    registerContribution(handler('acme.crm'), acme)
    registerContribution({ ...handler('acme.crm'), kind: 'panel' }, acme)
    expect(useContributions.getState().contributions.size).toBe(2)
  })

  test('a held id is refused to another source and recorded', () => {
    registerContribution(handler('acme.crm', { label: 'one' }), acme)
    const undo = registerContribution(handler('acme.crm', { label: 'two' }), {
      kind: 'extension',
      extensionId: 'other',
    })
    const { contributions, conflicts } = useContributions.getState()
    expect(contributions.get('application:acme.crm')?.label).toBe('one')
    expect(conflicts).toHaveLength(1)
    undo()
    expect(useContributions.getState().conflicts).toHaveLength(0)
  })
})

describe('resolving the default handler (EXT-03)', () => {
  test('an installed handler never takes over the shipped default, but the tie is shown', () => {
    registerContribution(handler('theorem.crm'))
    registerContribution(handler('acme.crm', { priority: 100 }), acme)
    const resolved = resolveHandler('application', 'crm', {}, none)
    expect(resolved.handler?.id).toBe('theorem.crm')
    expect(resolved.reason).toBe('shipped-default')
    expect(resolved.ambiguous.map((one) => one.id)).toEqual([
      'theorem.crm',
      'acme.crm',
    ])
  })

  test('explicit, then resource, then person, then workspace', () => {
    registerContribution(handler('theorem.crm'))
    registerContribution(handler('acme.crm'), acme)
    registerContribution(handler('beta.crm'), {
      kind: 'extension',
      extensionId: 'beta',
    })
    const preferences: HandlerPreferences = {
      ...none,
      byResource: { 'record:42': 'beta.crm' },
      byServes: { crm: 'acme.crm' },
      workspace: { crm: 'theorem.crm' },
    }
    const at = (options: { explicit?: string; resourceKey?: string }) =>
      resolveHandler('application', 'crm', options, preferences)
    expect(
      at({ explicit: 'theorem.crm', resourceKey: 'record:42' }),
    ).toMatchObject({
      reason: 'explicit',
      handler: { id: 'theorem.crm' },
    })
    expect(at({ resourceKey: 'record:42' })).toMatchObject({
      reason: 'resource-preference',
      handler: { id: 'beta.crm' },
    })
    expect(at({})).toMatchObject({
      reason: 'person-preference',
      handler: { id: 'acme.crm' },
    })
    expect(
      resolveHandler(
        'application',
        'crm',
        {},
        { ...preferences, byServes: {} },
      ),
    ).toMatchObject({
      reason: 'workspace-default',
      handler: { id: 'theorem.crm' },
    })
  })

  test('a preference for an uninstalled handler falls back and says so', () => {
    registerContribution(handler('theorem.crm'))
    const resolved = resolveHandler(
      'application',
      'crm',
      {},
      {
        ...none,
        byServes: { crm: 'gone.crm' },
      },
    )
    expect(resolved.handler?.id).toBe('theorem.crm')
    expect(resolved.missingPreference).toBe('gone.crm')
  })

  test('a hidden built-in gives way to the installed handler; restoring brings it back', () => {
    registerContribution(handler('theorem.crm'))
    registerContribution(handler('acme.crm'), acme)
    const hidden = resolveHandler(
      'application',
      'crm',
      {},
      { ...none, hidden: ['theorem.crm'] },
    )
    expect(hidden.handler?.id).toBe('acme.crm')
    expect(resolveHandler('application', 'crm', {}, none).handler?.id).toBe(
      'theorem.crm',
    )
  })

  test('nothing serves: no handler, no reason', () => {
    expect(resolveHandler('application', 'research', {}, none)).toMatchObject({
      handler: undefined,
      reason: undefined,
      candidates: [],
    })
  })

  test('preferences persist apart from contributions and reset without touching them', () => {
    registerContribution(handler('acme.crm'), acme)
    useHandlerPreferences.getState().prefer('byServes', 'crm', 'acme.crm')
    expect(useHandlerPreferences.getState().byServes).toEqual({
      crm: 'acme.crm',
    })
    useHandlerPreferences.getState().resetAll()
    expect(useHandlerPreferences.getState().byServes).toEqual({})
    expect(useContributions.getState().contributions.size).toBe(1)
  })
})
