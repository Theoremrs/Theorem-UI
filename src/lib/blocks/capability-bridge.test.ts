// SOURCING: bun:test, a MessageChannel standing in for a frame's port (as sandbox.test.ts does), the
// block protocol's call. The frame calls capability.describe, capability.query and
// capability.invoke the way a module's code does; the host's calls are recorded, so a refused call
// is seen to reach nothing.
import { describe, expect, test } from 'bun:test'
import { memoryWorkspace } from '../../../test/blocks/memory-workspace'
import { serveBridge } from './bridge'
import type { AppCapabilities, BridgeHost } from './bridge'
import { noCapabilities } from './declarations'
import { call, rpcOver } from './sandbox/protocol'
import type { PageMethods } from './sandbox/protocol'

const state: BridgeHost['state'] = {
  snapshot: () => ({}),
  set: () => {},
  delete: () => {},
  subscribe: () => () => {},
}

function connected(capability?: Omit<AppCapabilities, 'scope'>) {
  const channel = new MessageChannel()
  const page = rpcOver(channel.port1)
  const frame = rpcOver(channel.port2)
  const reached: Array<[string, unknown]> = []
  const host: BridgeHost = {
    client: memoryWorkspace({}),
    capabilities: noCapabilities(),
    state,
    run: () => {
      throw new Error('no runs')
    },
    capability: capability && {
      scope: [
        {
          instanceId: 'tracker/main',
          methods: ['describe', 'query', 'invoke'],
          actions: ['complete'],
        },
        { instanceId: 'notes/main', methods: ['describe'], actions: [] },
      ],
      describe: async (instanceId) => {
        reached.push(['describe', instanceId])
        return capability.describe(instanceId)
      },
      query: async (request) => {
        reached.push(['query', request])
        return capability.query(request)
      },
      invoke: async (request) => {
        reached.push(['invoke', request])
        return capability.invoke(request)
      },
    },
  }
  serveBridge(page, host)
  const close = () => {
    channel.port1.close()
    channel.port2.close()
  }
  return { frame, reached, close }
}

const api: Omit<AppCapabilities, 'scope'> = {
  describe: async (instanceId) => ({ instanceId, name: 'Tracker' }),
  query: async () => ({ records: [{ id: 'rec-1' }], total: 1 }),
  invoke: async (request) => ({ recordId: 'capop:1', ...request }),
}

const denial = (promise: Promise<unknown>) =>
  promise.then(
    () => 'allowed',
    (error: unknown) => (error instanceof Error ? error.message : 'refused'),
  )

describe('the scoped capability methods', () => {
  test('a declared and granted call reaches the host and comes back as a value', async () => {
    const { frame, reached, close } = connected(api)
    try {
      expect(
        await call<PageMethods, 'capability.describe'>(
          frame,
          'capability.describe',
          { instanceId: 'tracker/main' },
        ),
      ).toEqual({
        ok: true,
        value: { instanceId: 'tracker/main', name: 'Tracker' },
      })
      expect(
        await call<PageMethods, 'capability.query'>(frame, 'capability.query', {
          instanceId: 'tracker/main',
          viewKey: 'open',
          limit: 20,
        }),
      ).toEqual({ ok: true, value: { records: [{ id: 'rec-1' }], total: 1 } })
      const invoked = await call<PageMethods, 'capability.invoke'>(
        frame,
        'capability.invoke',
        {
          instanceId: 'tracker/main',
          actionKey: 'complete',
          recordId: 'rec-1',
          expectedRevision: 2,
          inputs: {},
        },
      )
      expect(invoked.ok).toBe(true)
      expect(reached).toEqual([
        ['describe', 'tracker/main'],
        ['query', { instanceId: 'tracker/main', viewKey: 'open', limit: 20 }],
        [
          'invoke',
          {
            instanceId: 'tracker/main',
            actionKey: 'complete',
            recordId: 'rec-1',
            expectedRevision: 2,
            inputs: {},
          },
        ],
      ])
    } finally {
      close()
    }
  })

  test('an instance, method or action the module was not allowed is denied at the bridge', async () => {
    const { frame, reached, close } = connected(api)
    try {
      expect(
        await denial(
          call<PageMethods, 'capability.describe'>(
            frame,
            'capability.describe',
            { instanceId: 'payroll/main' },
          ),
        ),
      ).toContain(
        'capability("payroll/main") is not among the capability instances this module was allowed',
      )
      expect(
        await denial(
          call<PageMethods, 'capability.query'>(frame, 'capability.query', {
            instanceId: 'notes/main',
          }),
        ),
      ).toContain('capability.query on "notes/main" was not allowed')
      expect(
        await denial(
          call<PageMethods, 'capability.invoke'>(frame, 'capability.invoke', {
            instanceId: 'tracker/main',
            actionKey: 'delete',
            inputs: {},
          }),
        ),
      ).toContain(
        'the action "delete" of "tracker/main" is not among the actions this module was allowed',
      )
      expect(
        await denial(
          call<PageMethods, 'capability.invoke'>(frame, 'capability.invoke', {
            instanceId: 'notes/main',
            actionKey: 'complete',
            inputs: {},
          }),
        ),
      ).toContain('capability.invoke on "notes/main" was not allowed')
      expect(reached).toEqual([])
    } finally {
      close()
    }
  })

  test('a host that lends no capabilities denies every capability call', async () => {
    const { frame, close } = connected()
    try {
      const calls: Array<[string, Record<string, unknown>]> = [
        ['capability.describe', { instanceId: 'tracker/main' }],
        ['capability.query', { instanceId: 'tracker/main' }],
        [
          'capability.invoke',
          { instanceId: 'tracker/main', actionKey: 'complete', inputs: {} },
        ],
      ]
      for (const [method, params] of calls)
        expect(
          await denial(
            frame.request(method, params, undefined) as Promise<unknown>,
          ),
        ).toContain('is not among the capability instances')
    } finally {
      close()
    }
  })

  test('a malformed call is refused before any scope check reaches the host', async () => {
    const { frame, reached, close } = connected(api)
    try {
      expect(
        await denial(
          frame.request(
            'capability.invoke',
            { instanceId: 'tracker/main', actionKey: 'complete', inputs: 'x' },
            undefined,
          ) as Promise<unknown>,
        ),
      ).not.toMatch(/^allowed$|Method not found/)
      expect(reached).toEqual([])
    } finally {
      close()
    }
  })

  test('a refusal from the capability itself crosses as a value with its code', async () => {
    const refusing: Omit<AppCapabilities, 'scope'> = {
      ...api,
      invoke: async () => {
        throw Object.assign(new Error('403 Forbidden'), {
          body: {
            code: 'capability_precondition_failed',
            detail: 'The task is already done.',
          },
        })
      },
    }
    const { frame, close } = connected(refusing)
    try {
      expect(
        await call<PageMethods, 'capability.invoke'>(
          frame,
          'capability.invoke',
          {
            instanceId: 'tracker/main',
            actionKey: 'complete',
            recordId: 'rec-1',
            inputs: {},
          },
        ),
      ).toEqual({
        ok: false,
        error: {
          code: 'capability_precondition_failed',
          message: 'The task is already done.',
        },
      })
    } finally {
      close()
    }
  })
})
