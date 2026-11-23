// SOURCING: bun:test; the bridge served over a MessageChannel as a module's frame reaches it (as
// lib/blocks/capability-bridge.test.ts does), with the host's capability methods from
// moduleCapabilities, and slice2-harness's stand-in for /api/capabilities/v1. What is asserted is
// the request each allowed call sends (the host's own CSRF and idempotency headers) and what the
// frame gets back (a value carrying none of them); a refused call reaches no route.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { memoryWorkspace } from '../../../test/blocks/memory-workspace'
import {
  install,
  sentTo,
  server,
  uninstall,
} from '@/components/capabilities/slice2-harness'
import { serveBridge } from '@/lib/blocks/bridge'
import type { BridgeHost, CapabilityScope } from '@/lib/blocks/bridge'
import { noCapabilities } from '@/lib/blocks/declarations'
import { call, rpcOver } from '@/lib/blocks/sandbox/protocol'
import { bootstrap } from '@/lib/theorem/client'
import type { PageMethods } from '@/lib/blocks/sandbox/protocol'
import { moduleCapabilities } from './capability-host'

const scope: CapabilityScope[] = [
  {
    instanceId: 'tracker/main',
    methods: ['describe', 'query', 'invoke'],
    actions: ['complete'],
  },
]

function frameOver(onInvoked: (instanceId: string) => void) {
  const channel = new MessageChannel()
  const host: BridgeHost = {
    client: memoryWorkspace({}),
    capabilities: noCapabilities(),
    state: {
      snapshot: () => ({}),
      set: () => {},
      delete: () => {},
      subscribe: () => () => {},
    },
    run: () => {
      throw new Error('no runs')
    },
    capability: moduleCapabilities(scope, { onInvoked }),
  }
  serveBridge(rpcOver(channel.port1), host)
  return {
    frame: rpcOver(channel.port2),
    close: () => {
      channel.port1.close()
      channel.port2.close()
    },
  }
}

const capabilityCalls = () =>
  server.calls.filter((one) => one.path.startsWith('/api/capabilities/v1'))

beforeEach(install)
afterEach(uninstall)

describe('the host behind a module’s capability calls', () => {
  test('an allowed call goes out with the host’s own CSRF, and the frame gets the answer without it', async () => {
    const invoked: string[] = []
    const { frame, close } = frameOver((id) => invoked.push(id))
    // The page's session, as the host's writes carry it.
    const { csrfToken } = await bootstrap()
    try {
      const described = await call<PageMethods, 'capability.describe'>(
        frame,
        'capability.describe',
        { instanceId: 'tracker/main' },
      )
      expect(described.ok).toBe(true)
      const [read] = capabilityCalls()
      expect(read?.method).toBe('GET')
      expect(read?.path).toBe('/api/capabilities/v1/instances/tracker%2Fmain')

      const queried = await call<PageMethods, 'capability.query'>(
        frame,
        'capability.query',
        { instanceId: 'tracker/main', viewKey: 'next', limit: 20 },
      )
      expect(queried).toMatchObject({
        ok: true,
        value: { records: [{ id: 'rec-1' }, { id: 'rec-2' }] },
      })
      const [asked] = sentTo('/query')
      expect(asked?.headers.get('X-CSRF-Token')).toBe(csrfToken)
      expect(asked?.body).toEqual({
        instanceId: 'tracker/main',
        viewKey: 'next',
        limit: 20,
      })

      const done = await call<PageMethods, 'capability.invoke'>(
        frame,
        'capability.invoke',
        {
          instanceId: 'tracker/main',
          actionKey: 'complete',
          recordId: 'rec-1',
          expectedRevision: 6,
          inputs: {},
        },
      )
      expect(done).toMatchObject({
        ok: true,
        value: {
          actionKey: 'complete',
          outcome: { affected: [{ id: 'rec-1', revision: 7 }] },
        },
      })
      const [sent] = sentTo('/invoke')
      expect(sent?.method).toBe('POST')
      expect(sent?.headers.get('X-CSRF-Token')).toBe(csrfToken)
      // One intended call is one key: the body's and the header's agree.
      expect(sent?.headers.get('Idempotency-Key')).toBe(
        String(sent?.body?.invocationKey),
      )
      expect(invoked).toEqual(['tracker/main'])

      // Nothing the frame received names the session's token.
      for (const answer of [described, queried, done])
        expect(JSON.stringify(answer)).not.toContain(csrfToken)
    } finally {
      close()
    }
  })

  test('a call outside the grant reaches no route', async () => {
    const invoked: string[] = []
    const { frame, close } = frameOver((id) => invoked.push(id))
    try {
      const refused = (promise: Promise<unknown>) =>
        promise.then(
          () => 'allowed',
          (error: unknown) => (error as Error).message,
        )
      expect(
        await refused(
          call<PageMethods, 'capability.query'>(frame, 'capability.query', {
            instanceId: 'payroll/main',
          }),
        ),
      ).toContain('is not among the capability instances')
      expect(
        await refused(
          call<PageMethods, 'capability.invoke'>(frame, 'capability.invoke', {
            instanceId: 'tracker/main',
            actionKey: 'assign',
            recordId: 'rec-1',
            inputs: { assignee: 'someone' },
          }),
        ),
      ).toContain('the action "assign" of "tracker/main" is not among')
      expect(capabilityCalls()).toEqual([])
      expect(invoked).toEqual([])
    } finally {
      close()
    }
  })

  test('a host told of no invoke listener still answers the call', async () => {
    const done = await moduleCapabilities(scope).invoke({
      instanceId: 'tracker/main',
      actionKey: 'complete',
      recordId: 'rec-1',
      expectedRevision: 6,
      inputs: {},
    })
    expect(done).toMatchObject({
      actionKey: 'complete',
      outcome: { affected: [{ id: 'rec-1', revision: 7 }] },
    })
  })
})
