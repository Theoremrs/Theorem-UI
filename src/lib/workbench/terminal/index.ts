// SOURCING: none — re-exports of this folder's modules.
export { terminalHost, type TerminalDeps, type TerminalHost } from './host'
export {
  TerminalSession,
  watchAnnouncements,
  type Bound,
  type OpenOptions,
  type TerminalEvent,
  type TerminalPhase,
  type TerminalState,
} from './session'
export {
  DEFAULT_PROFILE_ID,
  herdrReady,
  openBody,
  partitionProfiles,
  profileById,
  TERMINAL_PROFILES,
  type TerminalBackend,
  type TheoremTerminalProfile,
} from './terminal-profile'
export type {
  InputKind,
  LeaseRefusalReason,
  LeaseRole,
  Outcome,
  ProgramOrigin,
  Refusal,
  TerminalLiveEvent,
} from './wire'
