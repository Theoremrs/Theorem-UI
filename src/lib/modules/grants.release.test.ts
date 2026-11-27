// SOURCING: bun:test over authorityFor and the permission diff in ./grants:
// EXEC-02, a digest-bound grant is never copied to another digest and
// unchanged authority does not prompt again.
import { describe, expect, test } from 'bun:test'
import { addedCapabilities, authorityFor, capabilitiesWithin } from './grants'

const caps = (
  over: Partial<Record<'read' | 'write' | 'state' | 'net', string[]>> = {},
) => ({
  read: [],
  write: [],
  state: [],
  net: [],
  ...over,
})

describe('authorityFor', () => {
  const grant = {
    digest: 'D1',
    capabilities: caps({ read: ['Notes'], write: ['Notes'] }),
    grantedAt: 1,
  }

  test('the same digest and the same ask is covered, with no new prompt', () => {
    expect(
      authorityFor({
        grant,
        policy: undefined,
        digest: 'D1',
        requested: caps({ read: ['Notes'] }),
      }),
    ).toEqual({ kind: 'granted', by: 'digest' })
  })

  test('a different digest never uses the old grant, even for the same or a smaller ask', () => {
    const out = authorityFor({
      grant,
      policy: undefined,
      digest: 'D2',
      requested: caps({ read: ['Notes'] }),
      previousRequested: caps({ read: ['Notes'] }),
    })
    expect(out).toMatchObject({ kind: 'needs-grant', reason: 'new-digest' })
  })

  test('an expansion says exactly what is new', () => {
    const out = authorityFor({
      grant: undefined,
      policy: undefined,
      digest: 'D2',
      requested: caps({ read: ['Notes'], net: ['api.x.com'] }),
      previousRequested: caps({ read: ['Notes'] }),
    })
    expect(out).toMatchObject({ kind: 'needs-grant', reason: 'expanded' })
    if (out.kind === 'needs-grant')
      expect(out.added).toEqual(caps({ net: ['api.x.com'] }))
  })

  test('a revision policy covers future digests only inside its declared scope', () => {
    const policy = { scope: caps({ read: ['Notes'] }), grantedAt: 1 }
    expect(
      authorityFor({
        grant: undefined,
        policy,
        digest: 'D3',
        requested: caps({ read: ['Notes'] }),
      }),
    ).toEqual({
      kind: 'granted',
      by: 'policy',
    })
    expect(
      authorityFor({
        grant: undefined,
        policy,
        digest: 'D3',
        requested: caps({ read: ['Notes'], write: ['Notes'] }),
      }).kind,
    ).toBe('needs-grant')
  })

  test('asking for nothing needs no grant', () => {
    expect(
      authorityFor({
        grant: undefined,
        policy: undefined,
        digest: 'D',
        requested: caps(),
      }),
    ).toEqual({
      kind: 'granted',
      by: 'nothing-requested',
    })
  })

  test('instances: invoke on a new action is an expansion', () => {
    const before = {
      ...caps(),
      instances: [
        { instanceId: 'crm', methods: ['query' as const], actions: [] },
      ],
    }
    const after = {
      ...caps(),
      instances: [
        {
          instanceId: 'crm',
          methods: ['query' as const, 'invoke' as const],
          actions: ['send'],
        },
      ],
    }
    expect(addedCapabilities(before, after).instances).toEqual([
      { instanceId: 'crm', methods: ['invoke'], actions: ['send'] },
    ])
    expect(capabilitiesWithin(after, before)).toBe(false)
    expect(capabilitiesWithin(before, after)).toBe(true)
  })
})
