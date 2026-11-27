// SOURCING: bun:test over ./lifecycle with the real command and contribution
// registries: EXEC-05 and acceptance A08 (disable/uninstall removes what runs,
// keeps data, history and settings, leaves a placeholder and another opener).
import { beforeEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  commandById,
  registerCommand,
  useCommandRegistry,
} from '@/lib/commands/registry'
import {
  registerContribution,
  useContributions,
} from '@/lib/contributions/registry'
import {
  disableModule,
  enableModule,
  placeholderFor,
  uninstallModule,
} from './lifecycle'
import { emptyRecord } from './state'
import { releaseRecords, useReleases } from './store'

beforeEach(() => {
  useCommandRegistry.setState({ commands: new Map(), conflicts: [] })
  useContributions.setState({ contributions: new Map(), conflicts: [] })
  useReleases.setState({ modules: {} })
})

const command = (id: string) => ({
  id,
  label: id,
  effect: 'read' as const,
  target: 'none' as never,
  keys: ['mod+shift+y'],
  args: z.undefined(),
  run: () => 1,
})

describe('A08: disable and uninstall', () => {
  const setup = () => {
    registerCommand(command('acme.crm.open') as never, {
      kind: 'module',
      moduleId: 'acme.crm',
    })
    registerCommand(command('other.mod.open') as never, {
      kind: 'module',
      moduleId: 'other.mod',
    })
    registerContribution(
      {
        kind: 'open-handler',
        id: 'acme.crm.workbench',
        label: 'CRM',
        serves: ['record:company'],
      },
      { kind: 'module', moduleId: 'acme.crm' },
    )
    registerContribution(
      {
        kind: 'open-handler',
        id: 'theorem.table',
        label: 'Table',
        serves: ['record:company'],
      },
      { kind: 'builtin' },
    )
    releaseRecords.update('acme.crm', (r) => ({ ...r, dataVersion: 3 }))
  }

  test('executable contributions and default bindings go; others and the data record stay', () => {
    setup()
    const out = disableModule('acme.crm')
    expect(out.removed.commands).toEqual(['acme.crm.open'])
    expect(out.removed.contributions).toEqual([
      'open-handler:acme.crm.workbench',
    ])
    expect(commandById('acme.crm.open')).toBeUndefined()
    expect(commandById('other.mod.open')).toBeDefined()
    const record = releaseRecords.get('acme.crm')!
    expect(record.disabled).toBe(true)
    expect(record.uninstalled).toBe(false)
    expect(record.dataVersion).toBe(3)
    expect(out.note).toContain('execution provider')
  })

  test('uninstall keeps history and data; enable brings it back to runnable', () => {
    setup()
    uninstallModule('acme.crm')
    const record = releaseRecords.get('acme.crm')!
    expect(record.uninstalled).toBe(true)
    expect(record.dataVersion).toBe(3)
    expect(record.history.at(-1)!.summary).toContain('data and history kept')
    enableModule('acme.crm')
    expect(releaseRecords.get('acme.crm')).toMatchObject({
      disabled: false,
      uninstalled: false,
    })
  })

  test('the placeholder keeps settings and resource identity and offers another opener', () => {
    setup()
    disableModule('acme.crm')
    const p = placeholderFor({
      identity: 'acme.crm',
      serves: 'record:company',
      resourceKey: 'record:company:42',
      settings: { view: 'board', future: { x: 1 } },
    })
    expect(p.reason).toBe('disabled')
    expect(p.settings).toEqual({ view: 'board', future: { x: 1 } })
    expect(p.resourceKey).toBe('record:company:42')
    expect(p.openers.map((o) => o.id)).toEqual(['theorem.table'])
    expect(p.exportable).toBe(true)
  })

  test('a module that was never installed reads as missing, not as an error', () => {
    expect(placeholderFor({ identity: 'gone.mod' }).reason).toBe('missing')
    expect(releaseRecords.get('gone.mod')).toBeUndefined()
  })
})

test('emptyRecord has nothing disabled', () => {
  expect(emptyRecord('x')).toMatchObject({
    disabled: false,
    uninstalled: false,
  })
})
