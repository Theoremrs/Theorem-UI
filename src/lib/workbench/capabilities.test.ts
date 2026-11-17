// SOURCING: none — bun:test over ./capabilities with an environment that lists what the host advertised
import { describe, expect, test } from 'bun:test'
import { grantedCapabilities } from './capabilities'
import type { Environment } from './environment/environment'

function env(
  operations: [string, 'available' | 'unavailable' | 'unlisted'][],
  options: { up?: boolean; backends?: string[] } = {},
) {
  return {
    availability:
      options.up === false
        ? { status: 'unavailable', cause: 'opening', reason: 'x' }
        : { status: 'available' },
    availabilityFor: () => ({ status: 'available' }),
    operations: () =>
      operations.map(([name, state]) => ({
        name,
        state:
          state === 'unavailable'
            ? { state, reason: 'no checkout' }
            : ({ state } as never),
      })),
    backends: () => options.backends ?? [],
  } as unknown as Pick<
    Environment,
    'availability' | 'availabilityFor' | 'operations' | 'backends'
  >
}

describe('grantedCapabilities', () => {
  test('each capability follows the operations the host lists as available', () => {
    expect(
      grantedCapabilities(
        env([
          ['workspace.files.list', 'available'],
          ['documents.open', 'available'],
          ['scm.status', 'available'],
          ['terminal.open', 'available'],
        ]),
        ['layout'],
      ),
    ).toEqual([
      'environment',
      'files',
      'documents',
      'scm',
      'terminal',
      'workspace.files.list',
      'documents.open',
      'scm.status',
      'terminal.open',
      'terminal.native',
      'layout',
    ])
  })

  test('an operation the host lists as not ready grants nothing, and one it never listed grants nothing', () => {
    expect(
      grantedCapabilities(
        env([
          ['scm.status', 'unavailable'],
          ['workspace.files.list', 'unlisted'],
          ['run.start', 'available'],
        ]),
        [],
      ),
    ).toEqual(['environment', 'run', 'run.start'])
  })

  test('the operation words panels and actions are gated on are granted as the host names them', () => {
    const granted = grantedCapabilities(
      env([
        ['diagnostics.subscribe', 'available'],
        ['run.start', 'available'],
        ['run.subscribe', 'available'],
        ['search.query', 'available'],
        ['scm.commit.amend', 'available'],
        ['scm.status', 'available'],
      ]),
      [],
    )
    for (const word of [
      'diagnostics.subscribe',
      'run.start',
      'run.subscribe',
      'search.query',
      'scm.commit.amend',
      'search',
      'run',
      'scm',
    ])
      expect(granted).toContain(word)
    const without = grantedCapabilities(
      env([['scm.commit.amend', 'unavailable']]),
      [],
    )
    expect(without).not.toContain('scm.commit.amend')
  })

  test('herdr needs the terminal and the host reporting the backend ready', () => {
    expect(
      grantedCapabilities(
        env([['terminal.open', 'available']], { backends: ['herdr'] }),
        [],
      ),
    ).toContain('terminal.herdr')
    expect(
      grantedCapabilities(env([['terminal.open', 'available']]), []),
    ).not.toContain('terminal.herdr')
    expect(
      grantedCapabilities(env([], { backends: ['herdr'] }), []),
    ).not.toContain('terminal.herdr')
  })

  test('a host that is not available grants only what the workbench owns itself', () => {
    expect(
      grantedCapabilities(env([['scm.status', 'available']], { up: false }), [
        'layout',
        'conversation',
      ]),
    ).toEqual(['layout', 'conversation'])
  })
})
