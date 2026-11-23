// SOURCING: a bench for CommandTerminal (command-terminal.tsx) as it runs once Theorem streams a command's output: the component the reply's tool-call slot draws, fed what a command prints a line at a time and then how it ended, round after round. No library models a replayed run; it is a timer over the component's own props.
'use client'

import { useCallback, useEffect, useState } from 'react'
import type { CallState } from '@/components/chat/theorem-parts'
import { CommandTerminal } from './command-terminal'

interface Script {
  command: string
  stdout: readonly string[]
  stderr: readonly string[]
  exitCode: number
}

const PASSES: Script = {
  command: 'bun test src/tiles',
  stdout: [
    'bun test v1.3.3',
    '',
    'src/tiles/cache.test.ts:',
    '✓ caches a tile once [0.42ms]',
    '✓ evicts the oldest past the budget [0.31ms]',
    '✓ keeps a tile the map still shows [0.27ms]',
    '',
    'src/tiles/loader.test.ts:',
    '✓ loads through the cache [1.08ms]',
    '✓ retries a tile that failed once [12.40ms]',
    '✓ gives up after three tries [36.11ms]',
    '',
    ' 14 pass',
    ' 0 fail',
    'Ran 14 tests across 3 files. [212.00ms]',
  ],
  stderr: [],
  exitCode: 0,
}

const FAILS: Script = {
  command: 'cargo build -p tiles-cache',
  stdout: [],
  stderr: [
    '   Compiling tiles v0.3.0',
    '   Compiling tiles-cache v0.1.0',
    'error[E0308]: mismatched types',
    '  --> src/cache.rs:42:16',
    '   |',
    '42 |     return url;',
    '   |            ^^^ expected `Tile`, found `&str`',
    '',
    'error: could not compile `tiles-cache` due to 1 previous error',
  ],
  exitCode: 101,
}

const QUIET: Script = {
  command: 'mkdir -p dist/tiles',
  stdout: [],
  stderr: [],
  exitCode: 0,
}

/** One round: the lines arrive one by one, the command ends, and the round hands on. */
function Round({ script, onEnd }: { script: Script; onEnd: () => void }) {
  const [shown, setShown] = useState(0)
  const total = script.stdout.length + script.stderr.length
  const ended = shown > total
  useEffect(() => {
    const timer = setTimeout(
      ended ? onEnd : () => setShown((count) => count + 1),
      ended ? 5000 : shown === 0 ? 1400 : 320,
    )
    return () => clearTimeout(timer)
  }, [shown, ended, onEnd])
  const state: CallState = ended
    ? script.exitCode === 0
      ? 'done'
      : 'failed'
    : 'running'
  return (
    <CommandTerminal
      command={script.command}
      state={state}
      stdout={script.stdout.slice(0, shown).join('\n')}
      stderr={script.stderr
        .slice(0, Math.max(0, shown - script.stdout.length))
        .join('\n')}
      exitCode={ended ? script.exitCode : undefined}
    />
  )
}

function Replay({ script }: { script: Script }) {
  const [round, setRound] = useState(0)
  const next = useCallback(() => setRound((count) => count + 1), [])
  return <Round key={round} script={script} onEnd={next} />
}

/** Three commands running over and over: one ends well and closes, one fails and stays open, one prints nothing. */
export function CommandTerminalLiveStory() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-start gap-6 p-8">
      <Replay script={PASSES} />
      <Replay script={FAILS} />
      <Replay script={QUIET} />
    </div>
  )
}
