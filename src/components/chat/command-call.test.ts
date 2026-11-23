import { describe, expect, test } from 'bun:test'
import {
  outputShows,
  printedAnything,
  readCommand,
  readHostCommand,
  terminalColumns,
} from '@/components/terminal/command-terminal'
import {
  isStandaloneToolCall,
  toolCallEntries,
  toolCallState,
} from './theorem-parts'

describe('a call that runs a command', () => {
  test('keeps the command, what it printed and how it ended', () => {
    expect(
      readCommand(
        { command: 'bun test src/tiles' },
        { exitCode: 0, stdout: '14 pass, 0 fail' },
      ),
    ).toEqual({
      command: 'bun test src/tiles',
      stdout: '14 pass, 0 fail',
      stderr: '',
      exitCode: 0,
    })
  })

  test('keeps stderr apart and its exit code when it fails', () => {
    expect(
      readCommand(
        { command: 'bun test' },
        { stdout: '1 pass, 1 fail', stderr: 'expected 0', exit_code: 1 },
      ),
    ).toEqual({
      command: 'bun test',
      stdout: '1 pass, 1 fail',
      stderr: 'expected 0',
      exitCode: 1,
    })
  })

  test('reads a command given as words and a result given as text', () => {
    expect(readCommand({ cmd: ['cargo', 'build'] }, 'Finished')).toEqual({
      command: 'cargo build',
      stdout: 'Finished',
      stderr: '',
      exitCode: undefined,
    })
  })

  test('has nothing printed while it runs', () => {
    expect(readCommand({ command: 'cargo build' }, undefined)).toEqual({
      command: 'cargo build',
      stdout: '',
      stderr: '',
      exitCode: undefined,
    })
  })

  test('reads what it printed from the text entries of the content a result carries', () => {
    expect(
      readCommand(
        { command: 'echo hello' },
        {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'image', data: '' },
          ],
        },
      )?.stdout,
    ).toBe('hello')
  })

  test('keeps only an exit code a terminal could end with', () => {
    const exit = (code: unknown) =>
      readCommand({ command: 'x' }, { stdout: 'ok', exitCode: code })?.exitCode
    expect(exit(2)).toBe(2)
    expect(exit(-1)).toBe(-1)
    expect(exit(0.5)).toBeUndefined()
    expect(exit(3e10)).toBeUndefined()
    expect(exit(Number.NaN)).toBeUndefined()
  })

  test('a call without a command is not one', () => {
    expect(readCommand({ query: 'tile cache' }, { hits: 3 })).toBeUndefined()
    expect(readCommand({ command: '' }, undefined)).toBeUndefined()
  })
})

describe('in the conversation', () => {
  test('a command stands in the reply rather than in the folded tool row', () => {
    expect(
      isStandaloneToolCall({
        type: 'tool-call',
        toolName: 'run_command',
        args: { command: 'bun test src/tiles' },
      }),
    ).toBe(true)
    expect(
      isStandaloneToolCall({
        type: 'tool-call',
        toolName: 'web_search',
        args: { query: 'tile cache' },
      }),
    ).toBe(false)
  })

  test('its terminal follows the call from running to how it ended', () => {
    expect(toolCallState({ type: 'running' })).toBe('running')
    expect(toolCallState({ type: 'requires-action' })).toBe('awaiting')
    expect(toolCallState({ type: 'complete' })).toBe('done')
    expect(toolCallState({ type: 'complete' }, true)).toBe('failed')
    expect(toolCallState({ type: 'incomplete', reason: 'cancelled' })).toBe(
      'interrupted',
    )
    expect(toolCallState({ type: 'incomplete', reason: 'error' })).toBe(
      'failed',
    )
  })
})

describe('the terminal a command is drawn in', () => {
  const run = {
    command: 'bun test src/tiles',
    stdout: '',
    stderr: '',
    exitCode: 0,
  }

  test('is as wide as its prompt line, not the reply', () => {
    // ❯ + space, the command, a space, the ✓, and a column of margin each side.
    expect(
      terminalColumns({
        ...run,
        command: 'bun test src/tiles --coverage',
        state: 'done',
      }),
    ).toBe(2 + 29 + 1 + 1 + 2)
  })

  test('keeps a short command a terminal of the narrowest width', () => {
    expect(terminalColumns({ ...run, command: 'ls', state: 'done' })).toBe(
      20 + 2,
    )
  })

  test('widens for a printed line, counting what shows and not its escapes', () => {
    const line = 'x'.repeat(40)
    expect(
      terminalColumns({
        ...run,
        stdout: `ok\n\x1b[31m${line}\x1b[0m\n`,
        state: 'done',
      }),
    ).toBe(40 + 2)
    expect(
      terminalColumns({
        ...run,
        stdout: `progress 10%\r${'y'.repeat(30)}`,
        state: 'done',
      }),
    ).toBe(30 + 2)
  })

  test('makes room for the exit code a failure names', () => {
    expect(
      terminalColumns({
        ...run,
        command: 'bun test src/tiles --bail',
        exitCode: 1,
        state: 'failed',
      }),
    ).toBe(2 + 25 + 1 + 8 + 2)
  })
})

describe('the output under a command', () => {
  test('is something only when the command printed what a terminal shows', () => {
    expect(printedAnything({ stdout: 'ok', stderr: '' })).toBe(true)
    expect(printedAnything({ stdout: '', stderr: 'bad' })).toBe(true)
    expect(printedAnything({ stdout: '\r\n\n', stderr: '' })).toBe(false)
  })

  const printed = { printed: true }

  test('shows while the command works and when it went wrong, and closes once it ended well', () => {
    expect(outputShows('running', printed)).toBe(true)
    expect(outputShows('awaiting', printed)).toBe(true)
    expect(outputShows('failed', printed)).toBe(true)
    expect(outputShows('interrupted', printed)).toBe(true)
    expect(outputShows('done', printed)).toBe(false)
    expect(outputShows('done', { printed: true, exitCode: 0 })).toBe(false)
  })

  test('stays open for a command that ended with an exit code other than 0', () => {
    expect(outputShows('done', { printed: true, exitCode: 1 })).toBe(true)
    expect(outputShows('done', { printed: true, exitCode: 1 }, false)).toBe(
      false,
    )
  })

  test('keeps to what the reader chose', () => {
    expect(outputShows('done', printed, true)).toBe(true)
    expect(outputShows('running', printed, false)).toBe(false)
  })

  test('opens a command too long for its line only when the reader opens it', () => {
    expect(outputShows('running', { printed: false, cut: true })).toBe(false)
    expect(outputShows('done', { printed: false, cut: true }, true)).toBe(true)
  })

  test('is never open with nothing to show', () => {
    expect(outputShows('failed', { printed: false })).toBe(false)
    expect(outputShows('done', { printed: false }, true)).toBe(false)
  })

  test('makes room for its line, and for the time once it has run', () => {
    const run = {
      command: 'bun test src/tiles --coverage',
      stdout: '14 pass',
      stderr: '',
      exitCode: 0,
      state: 'done' as const,
    }
    // The prompt, the command, a space and the ending, inside the margins.
    expect(terminalColumns(run)).toBe(2 + 29 + 1 + 1 + 2)
    // And "10m 10s " before the ending, so the terminal does not widen as it counts.
    expect(terminalColumns(run, true)).toBe(2 + 29 + 1 + 8 + 1 + 2)
  })
})

describe('a command the agent runs on the host', () => {
  const hostCall = (data: Record<string, unknown>) => ({
    type: 'data',
    name: 'theorem-host_call',
    data: { name: 'terminal', effect: 'Write', ...data },
  })

  test('shows what it has printed while it runs', () => {
    expect(
      readHostCommand({
        name: 'terminal',
        state: 'pending',
        terminal: {
          command: 'for i in 1 2 3; do echo tick $i; sleep 1; done',
          stdout: 'tick 1\n',
          stderr: '',
          exitCode: null,
        },
      }),
    ).toEqual({
      command: 'for i in 1 2 3; do echo tick $i; sleep 1; done',
      stdout: 'tick 1\n',
      stderr: '',
      exitCode: undefined,
    })
  })

  test('keeps how it ended once it has', () => {
    expect(
      readHostCommand({
        state: 'resolved',
        terminal: { command: 'false', stdout: '', stderr: 'no', exitCode: 1 },
      }),
    ).toEqual({ command: 'false', stdout: '', stderr: 'no', exitCode: 1 })
  })

  test('a host call without a terminal is not one', () => {
    expect(readHostCommand({ name: 'search_memory' })).toBeUndefined()
    expect(readHostCommand({ terminal: { command: '' } })).toBeUndefined()
  })

  test('stands in the reply in its terminal rather than as a row of the tool calls', () => {
    const content = [
      hostCall({ state: 'pending', terminal: { command: 'ls', stdout: '' } }),
      hostCall({ name: 'search_memory', state: 'resolved' }),
    ]
    expect(
      toolCallEntries(content, true).map(({ message }) => message),
    ).toEqual(['Searched memory'])
  })

  test('a host call that ran a command before calls carried it keeps its row', () => {
    expect(
      toolCallEntries([hostCall({ state: 'resolved' })], false).map(
        ({ message }) => message,
      ),
    ).toEqual(['Terminal'])
  })
})
