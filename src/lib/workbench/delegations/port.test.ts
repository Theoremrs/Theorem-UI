// SOURCING: none — bun:test over ./port with the real delegations owner over a stub of the two SDK calls, and a real account watch for the account switch
import { describe, expect, test } from 'bun:test'
import { createAccountWatch } from '../account'
import { createDelegations } from './delegations'
import type { DelegationsClient } from './delegations'
import { createDelegationsPort } from './port'

const resource = {
  type: 'delegation',
  runId: 'r1',
  delegationId: 'd1',
  path: '',
} as const

function setup() {
  const calls: string[] = []
  let gate: Promise<void> | undefined
  const client: DelegationsClient = {
    chat: {
      runs: {
        delegations: async () => {
          calls.push('list')
          return {
            delegations: [
              {
                delegationId: 'd1',
                state: 'reviewed',
                receipt: {
                  changes: [
                    {
                      path: 'a.ts',
                      change: 'modify',
                      binary: false,
                      beforeRef: 'b',
                      afterRef: 'a',
                    },
                    {
                      path: 'n.ts',
                      change: 'add',
                      binary: false,
                      afterRef: 'n',
                    },
                  ],
                },
              },
            ],
          } as never
        },
        delegationContent: async ({ ref }) => {
          calls.push(`blob:${ref}`)
          await gate
          return {
            arrayBuffer: async () =>
              new TextEncoder().encode(`text of ${ref}`).buffer,
          }
        },
      },
    },
  }
  let who = { tenantId: 't1', principalId: 'p1' }
  const watch = createAccountWatch({
    identify: async () => who,
    initial: who,
    channel: null,
  })
  const delegations = createDelegations({
    workspaceId: 'w1',
    client,
    onAccountChange: (listener) => watch.onChange(() => listener()),
  })
  const port = createDelegationsPort(delegations)
  let id = 0
  const perform = (kind: string, payload: unknown, at: object = resource) =>
    port.perform(
      { id: (id += 1), resource: at, kind, payload } as never,
      `req-${id}`,
    )
  return {
    perform,
    calls,
    hold: (promise: Promise<void>) => (gate = promise),
    switchAccount: async () => {
      who = { tenantId: 't1', principalId: 'p2' }
      await watch.refresh()
    },
  }
}

const ref = { runId: 'r1', delegationId: 'd1' }

describe('delegations through the port', () => {
  test("changes answer the list with the owner's change words, unmapped", async () => {
    const t = setup()
    expect(await t.perform('delegationChanges', ref)).toEqual({
      outcome: 'accepted',
      value: {
        type: 'delegationChanges',
        changes: [
          {
            path: 'a.ts',
            change: 'modify',
            binary: false,
            hasBefore: true,
            hasAfter: true,
          },
          {
            path: 'n.ts',
            change: 'add',
            binary: false,
            hasBefore: false,
            hasAfter: true,
          },
        ],
      },
    })
  })

  test('content answers the text of one side, and refusal codes pass through as data', async () => {
    const t = setup()
    expect(
      await t.perform('delegationContent', {
        ...ref,
        path: 'a.ts',
        side: 'after',
      }),
    ).toEqual({
      outcome: 'accepted',
      value: { type: 'delegationText', text: 'text of a' },
    })
    expect(
      await t.perform('delegationContent', {
        ...ref,
        path: 'n.ts',
        side: 'before',
      }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'no_such_side',
    })
    expect(
      await t.perform('delegationContent', {
        ...ref,
        path: 'x.ts',
        side: 'after',
      }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'no_such_change',
    })
  })

  test('an effect whose resource is another delegation is refused wrong_resource without a call', async () => {
    const t = setup()
    expect(
      await t.perform('delegationChanges', ref, {
        ...resource,
        delegationId: 'other',
      }),
    ).toMatchObject({
      outcome: 'refused',
      code: 'wrong_resource',
    })
    expect(
      await t.perform('delegationChanges', ref, {
        type: 'workspace',
        workspace: 'w1',
      }),
    ).toMatchObject({
      code: 'wrong_resource',
    })
    expect(t.calls).toEqual([])
  })

  test('content read when the account switches is refused stale_account, and nothing of the old account is kept', async () => {
    const t = setup()
    await t.perform('delegationChanges', ref)
    let open!: () => void
    t.hold(new Promise<void>((resolve) => (open = resolve)))
    const inFlight = t.perform('delegationContent', {
      ...ref,
      path: 'a.ts',
      side: 'after',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    await t.switchAccount()
    open()
    expect(await inFlight).toMatchObject({
      outcome: 'refused',
      code: 'stale_account',
    })
    // The next read starts over: the list is read again.
    t.hold(Promise.resolve())
    await t.perform('delegationContent', {
      ...ref,
      path: 'a.ts',
      side: 'after',
    })
    expect(t.calls.filter((c) => c === 'list')).toHaveLength(2)
  })
})
