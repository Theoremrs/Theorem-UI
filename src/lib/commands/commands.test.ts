// SOURCING: bun:test over the command registry and key binding resolution.
import { afterEach, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
  chordOfEvent,
  focusOf,
  isTypingChord,
  normalizeChord,
  resolveBindings,
} from './keybindings'
import {
  CommandRegistrationError,
  describeCommands,
  executeCommand,
  registerCommand,
  useCommandRegistry,
} from './registry'
import type { CommandDefinition, CommandSource } from './registry'

const here = { focus: 'none', path: '/' } as const

const command = (
  id: string,
  extra: Partial<CommandDefinition<any>> = {},
): CommandDefinition<any> => ({
  id,
  label: id,
  effect: 'presentation',
  target: 'host',
  run: () => id,
  ...extra,
})

afterEach(() =>
  useCommandRegistry.setState({ commands: new Map(), conflicts: [] }),
)

describe('registering', () => {
  test('ids are namespaced and theorem.* is the host’s', () => {
    expect(() => registerCommand(command('single'))).toThrow(
      CommandRegistrationError,
    )
    expect(() =>
      registerCommand(command('theorem.chat.new'), {
        kind: 'extension',
        extensionId: 'acme',
      }),
    ).toThrow('theorem.* ids are built in')
    expect(() =>
      registerCommand(command('other.thing'), {
        kind: 'module',
        moduleId: 'acme.crm',
      }),
    ).toThrow('acme.crm.*')
    registerCommand(command('acme.crm.brief'), {
      kind: 'module',
      moduleId: 'acme.crm',
    })
    expect(useCommandRegistry.getState().commands.has('acme.crm.brief')).toBe(
      true,
    )
  })

  test('another source cannot seize a held id; the refusal is recorded', () => {
    registerCommand(command('acme.open', { label: 'first' }), {
      kind: 'extension',
      extensionId: 'one',
    })
    const undo = registerCommand(command('acme.open', { label: 'second' }), {
      kind: 'extension',
      extensionId: 'two',
    })
    const state = useCommandRegistry.getState()
    expect(state.commands.get('acme.open')?.label).toBe('first')
    expect(state.conflicts).toHaveLength(1)
    undo()
    expect(useCommandRegistry.getState().conflicts).toHaveLength(0)
    expect(useCommandRegistry.getState().commands.get('acme.open')?.label).toBe(
      'first',
    )
  })

  test('the same source re-registering replaces in place, and a stale remover does nothing', () => {
    const source = { kind: 'module', moduleId: 'acme' } as const
    const first = registerCommand(command('acme.go', { label: 'v1' }), source)
    registerCommand(command('acme.go', { label: 'v2' }), source)
    first()
    expect(useCommandRegistry.getState().commands.get('acme.go')?.label).toBe(
      'v2',
    )
  })
})

describe('executing', () => {
  test('arguments are validated before the run, whoever invokes', async () => {
    let seen: unknown
    registerCommand(
      command('theorem.settings.open', {
        args: z.object({ path: z.string().startsWith('/settings') }),
        run: (args) => {
          seen = args
        },
      }),
    )
    const bad = await executeCommand(
      'theorem.settings.open',
      { path: '/x' },
      here,
      'agent',
    )
    expect(bad).toMatchObject({ ok: false, reason: 'invalid-args' })
    expect(seen).toBeUndefined()
    const good = await executeCommand(
      'theorem.settings.open',
      { path: '/settings/keys' },
      here,
      'palette',
    )
    expect(good.ok).toBe(true)
    expect(seen).toEqual({ path: '/settings/keys' })
  })

  test('unknown, not applicable and failing commands come back as results', async () => {
    expect(
      await executeCommand('acme.none', undefined, here, 'code'),
    ).toMatchObject({
      reason: 'unknown',
    })
    registerCommand(
      command('acme.chat-only', { when: (c) => c.path.startsWith('/c/') }),
    )
    expect(
      await executeCommand('acme.chat-only', undefined, here, 'code'),
    ).toMatchObject({
      reason: 'not-applicable',
    })
    registerCommand(
      command('acme.boom', {
        run: () => {
          throw new Error('owner refused')
        },
      }),
    )
    expect(await executeCommand('acme.boom', undefined, here, 'code')).toEqual({
      ok: false,
      reason: 'failed',
      message: 'owner refused',
    })
  })

  test('the run learns who invoked it', async () => {
    registerCommand(command('acme.who', { run: (_, c) => c.invoker }))
    expect(await executeCommand('acme.who', undefined, here, 'menu')).toEqual({
      ok: true,
      value: 'menu',
    })
  })
})

describe('the catalog', () => {
  test('is plain data with argument JSON Schema and conflicts', () => {
    registerCommand(
      command('theorem.settings.open', {
        effect: 'navigate',
        keys: ['mod+,'],
        args: z.object({ path: z.string() }),
      }),
    )
    registerCommand(command('acme.x', { label: 'taken' }), {
      kind: 'extension',
      extensionId: 'first',
    })
    registerCommand(
      command('acme.x', { when: () => false, capability: 'crm.write' }),
      {
        kind: 'extension',
        extensionId: 'acme',
      },
    )
    const catalog = describeCommands(here)
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog)
    expect(catalog.schema).toBe('theorem.commands/1')
    const settings = catalog.commands.find(
      (one) => one.id === 'theorem.settings.open',
    )
    expect(settings?.args).toMatchObject({ type: 'object', required: ['path'] })
    expect(catalog.conflicts).toEqual([
      { id: 'acme.x', holder: 'extension first', refused: 'extension acme' },
    ])
    registerCommand(
      command('acme.y', { when: () => false, capability: 'crm.write' }),
      {
        kind: 'extension',
        extensionId: 'acme',
      },
    )
    expect(
      describeCommands(here).commands.find((one) => one.id === 'acme.y'),
    ).toMatchObject({
      applies: false,
      capability: 'crm.write',
      source: 'extension acme',
    })
  })
})

describe('chords', () => {
  test('one spelling per chord, mod meaning the platform’s', () => {
    expect(normalizeChord('Mod+K', true)).toBe('mod+k')
    expect(normalizeChord('cmd+k', true)).toBe('mod+k')
    expect(normalizeChord('ctrl+k', false)).toBe('mod+k')
    expect(normalizeChord('ctrl+k', true)).toBe('ctrl+k')
    expect(normalizeChord('shift+mod+p', false)).toBe('mod+shift+p')
    expect(normalizeChord('mod++', false)).toBe('mod++')
    expect(normalizeChord('Esc', false)).toBe('escape')
    expect(() => normalizeChord('hyper+k', false)).toThrow('not a modifier')
  })

  test('a key press reads as the same chord', () => {
    const press = {
      key: 'K',
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: true,
    }
    expect(chordOfEvent(press, true)).toBe(normalizeChord('mod+shift+k', true))
    expect(
      chordOfEvent({ ...press, metaKey: false, ctrlKey: true }, false),
    ).toBe('mod+shift+k')
  })

  test('only bare and shifted keys count as typing', () => {
    expect(isTypingChord('k')).toBe(true)
    expect(isTypingChord('shift+k')).toBe(true)
    expect(isTypingChord('mod+k')).toBe(false)
    expect(isTypingChord('alt+k')).toBe(false)
  })

  test('focus is read from the element', () => {
    document.body.innerHTML =
      '<input id="i"><div class="cm-editor"><div id="e" tabindex="0"></div></div><div class="xterm"><textarea id="t"></textarea></div><div role="dialog"><button id="d"></button></div>'
    const at = (id: string) => document.getElementById(id)
    expect(focusOf(at('i'))).toBe('input')
    expect(focusOf(at('e'))).toBe('editor')
    expect(focusOf(at('t'))).toBe('terminal')
    expect(focusOf(at('d'))).toBe('dialog')
    expect(focusOf(document.body)).toBe('none')
    // The document is shared with every later test file.
    document.body.innerHTML = ''
  })
})

describe('resolving bindings', () => {
  const registered = (
    id: string,
    keys: string[],
    source: CommandSource = { kind: 'builtin' },
  ) => ({ ...command(id, { keys }), source })

  test('built-in defaults win over an extension’s, which is reported, not bound', () => {
    const resolved = resolveBindings(
      [
        registered('acme.palette', ['mod+k'], {
          kind: 'extension',
          extensionId: 'acme',
        }),
        registered('theorem.palette.toggle', ['mod+k', 'ctrl+k']),
      ],
      {},
      false,
    )
    expect(resolved.byChord.get('mod+k')).toBe('theorem.palette.toggle')
    expect(resolved.conflicts).toEqual([
      {
        chord: 'mod+k',
        holder: 'theorem.palette.toggle',
        refused: 'acme.palette',
      },
    ])
  })

  test('the person’s own binding comes first, and null unbinds', () => {
    const commands = [
      registered('theorem.palette.toggle', ['mod+k']),
      registered('acme.go', ['mod+g'], {
        kind: 'extension',
        extensionId: 'acme',
      }),
    ]
    const resolved = resolveBindings(
      commands,
      { 'Mod+G': 'theorem.palette.toggle', 'mod+k': null },
      false,
    )
    expect(resolved.byChord.get('mod+g')).toBe('theorem.palette.toggle')
    expect(resolved.byChord.has('mod+k')).toBe(false)
    expect(resolved.conflicts).toEqual([
      { chord: 'mod+g', holder: 'theorem.palette.toggle', refused: 'acme.go' },
    ])
  })
})
