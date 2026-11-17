// SOURCING: zustand for the notices waiting for their chat, as ./store keeps the mounted handle; the watch itself is pure logic over the states the terminal adapter and the conversation port already read (no upstream component models "tell the agent its session stopped").
import { create } from 'zustand'

/**
 * What a coding session is doing, as its owner reads it: a side chat's run
 * state, or a terminal program's exit and its own report.
 */
export type SessionState =
  'working' | 'waiting' | 'finished' | 'stopped' | 'failed' | 'ended'

/** A session the agent acted on stopped working: what its run is told. */
export interface SessionNotice {
  /** The agent run that last acted on the session. */
  runId: string
  /** The terminal session or side chat id, as `workbench.read` binds its panel. */
  session: string
  /** What the session is, in words: the terminal's profile, or "the side chat". */
  what: string
  state: Exclude<SessionState, 'working'>
  detail?: string
}

/**
 * Watches the sessions an agent run acted on (started, or sent words to) and
 * tells that run when one stops working: finished, waiting for a person,
 * stopped, failed, or its program ended. Finished or stopped before any work
 * tells nothing, and the same state twice tells once.
 */
export function createSessionWatch(tell: (notice: SessionNotice) => void) {
  const watched = new Map<
    string,
    { runId: string; what: string; last?: SessionState }
  >()
  return {
    /** An agent run acted on the session: it is watched, for that run. */
    acted(session: string, runId: string, what: string) {
      const known = watched.get(session)
      watched.set(session, { runId, what, last: known?.last })
    },
    observe(session: string, state: SessionState, detail?: string) {
      const known = watched.get(session)
      if (!known) return
      const last = known.last
      known.last = state
      if (state === 'working' || state === last) return
      // Finished or stopped before any work is a session at rest, not news;
      // one that needs a person, failed or ended is news at any time.
      if (last !== 'working' && (state === 'finished' || state === 'stopped'))
        return
      tell({
        runId: known.runId,
        session,
        what: known.what,
        state,
        ...(detail ? { detail } : {}),
      })
    },
    forget(session: string) {
      watched.delete(session)
    },
  }
}

export type SessionWatch = ReturnType<typeof createSessionWatch>

const WORDS: Record<SessionNotice['state'], string> = {
  finished: 'finished its work',
  waiting: 'is waiting for a person',
  stopped: 'was stopped',
  failed: 'failed',
  ended: 'ended',
}

/** The words a chat is told, for one or more of its sessions. */
export function noticeText(notices: readonly SessionNotice[]): string {
  const lines = notices.map(
    (n) =>
      `- ${n.what} (${n.session}) ${WORDS[n.state]}${n.detail ? `: ${n.detail}` : ''}.`,
  )
  return [
    'Workbench: a coding session you started has stopped working.',
    ...lines,
    'Read it with workbench.read, then give it feedback with code.send or tell the person what it did.',
  ].join('\n')
}

/** Notices waiting to reach the chat whose run they name. */
export const useSessionNotices = create<{ pending: readonly SessionNotice[] }>(
  () => ({ pending: [] }),
)

/** The page's one watch: the terminal adapter and the conversation port feed it. */
export const sessionWatch = createSessionWatch((notice) =>
  useSessionNotices.setState((s) => ({ pending: [...s.pending, notice] })),
)
