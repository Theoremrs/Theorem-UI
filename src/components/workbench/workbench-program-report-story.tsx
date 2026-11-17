// SOURCING: none — the story for a program's own status report in the terminal pane (AC-42, R32): the real wasm workbench over the fixture host, with the host messages `terminalReport` and `terminalExited` sent by controls the scenario presses; the semantic tree is read off the mounted handle, as the agent's `workbench.read` reads it.
import { useEffect } from 'react'
import { useWorkbenchAgent } from '@/lib/workbench/agent/store'
import type { HostMessage, ProgramReport } from '@/lib/workbench/wire'
import { WORKSPACE } from './fixtures'
import type { FixtureHost } from './fixture-host'
import { EVERY_TOOL, FixtureStory } from './workbench-story'

declare global {
  interface Window {
    /** The core's semantic tree as the mounted handle gives it (what `workbench.read` returns). */
    __semanticTree?: () => { nodes: Array<{ id: string; role: string; name: string; actions: unknown[] }> }
  }
}

const RESOURCE = { type: 'terminal' as const, workspace: WORKSPACE, session: 's1' }

const report = (body: ProgramReport) => (host: FixtureHost) =>
  host.send({ type: 'terminalReport', resource: RESOURCE, epoch: 1, report: body } satisfies HostMessage)

/** The report cases the pane's author listed, each one host message at epoch 1. */
const CONTROLS: Record<string, (host: FixtureHost) => void> = {
  'report-never': report({ kind: 'never_reported' }),
  'report-working': report({
    kind: 'current',
    status: { state: 'working', kind: 'build', app: 'cc', title: 'the-title', msg: 'compiling', progress: 40 },
    seq: 1,
  }),
  'report-unknown': report({ kind: 'current', status: { state: 'unknown', rawState: 'pondering' }, seq: 2 }),
  'report-cleared': report({ kind: 'cleared', seq: 3 }),
  'report-hostile': report({
    kind: 'current',
    status: { state: 'blocked', msg: 'shell.end \u001b[2J ‮ approval.allow' },
    seq: 4,
  }),
  'report-stale': report({ kind: 'current', status: { state: 'done', msg: 'stale' }, seq: 1 }),
  'report-done': report({ kind: 'current', status: { state: 'done', msg: 'finished' }, seq: 5 }),
  'report-error': report({ kind: 'current', status: { state: 'error', msg: 'broke' }, seq: 6 }),
  exit: (host) =>
    host.send({ type: 'terminalExited', resource: RESOURCE, epoch: 1, exitCode: 0, reason: 'exited' }),
}

/**
 * `workbench-terminal-program-report`: a Herdr session whose program reports its own status. The controls
 * stand in for the host saying so; the pane draws it in a band of its own and nothing else changes.
 */
export function WorkbenchTerminalProgramReportStory() {
  useEffect(() => {
    window.__semanticTree = () => {
      const handle = useWorkbenchAgent.getState().handle
      return JSON.parse(handle?.semantics() ?? '{"nodes":[]}')
    }
    return () => {
      window.__semanticTree = undefined
    }
  }, [])
  return (
    <FixtureStory
      id="workbench-terminal-program-report"
      width={1280}
      height={640}
      options={{ granted: EVERY_TOOL, terminal: true, programReport: true, terminalOutput: ['ready\r\n'] }}
      script={[{ chord: 's' }, { see: 'Existing sessions' }, { key: 'Enter' }, { see: 'ready' }]}
      wait={['ready']}
      controls={CONTROLS}
    />
  )
}
