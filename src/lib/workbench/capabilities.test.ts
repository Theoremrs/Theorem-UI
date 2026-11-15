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
    ).toEqual(['environment', 'run'])
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
