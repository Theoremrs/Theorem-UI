// SOURCING: none — the JSON examples copied verbatim from the backend worktree's docs/plans/2026-11-15-ide-host-core-loss.md ("Behavior and wire contract" and "Lease claims, host-owned arguments and uncertain operations"), as data. Only the TypeScript wrapping (names, `as const`) is added; no field or value is changed.

/** The complete live envelopes: three alternative loss causes, then recovery. Same session and epoch. */
export const UPDATED_CORE_CLOSED = {
  cursor: 'host:21',
  kind: 'terminal.updated',
  data: {
    session: 'hc-example',
    epoch: 2,
    state: 'lost',
    reason: 'core_closed',
    next_step: 'retry',
    program_report: { reported: false },
  },
} as const
export const UPDATED_CORE_UNAVAILABLE = {
  cursor: 'host:22',
  kind: 'terminal.updated',
  data: {
    session: 'hc-example',
    epoch: 2,
    state: 'lost',
    reason: 'core_unavailable',
    next_step: 'retry',
    program_report: { reported: false },
  },
} as const
export const UPDATED_SUBSCRIBE_TIMED_OUT = {
  cursor: 'host:23',
  kind: 'terminal.updated',
  data: {
    session: 'hc-example',
    epoch: 2,
    state: 'lost',
    reason: 'subscribe_timed_out',
    next_step: 'retry',
    program_report: { reported: false },
  },
} as const
export const UPDATED_RUNNING = {
  cursor: 'host:24',
  kind: 'terminal.updated',
  data: {
    session: 'hc-example',
    epoch: 2,
    state: 'running',
    program_report: { reported: false },
  },
} as const

/** A complete representative lost list row. */
export const LOST_LIST_ROW = {
  session: 'hc-example',
  backend: 'herdr',
  epoch: 2,
  origin: 'launched',
  binding: {
    backend: 'herdr',
    epoch: 2,
    program: 1,
    core_id: 'core-example',
    terminal: 't1',
  },
  cols: 80,
  rows: 24,
  state: 'lost',
  controlled: false,
  modes: {
    alternate_screen: false,
    application_cursor: false,
    application_keypad: false,
    bracketed_paste: false,
    hide_cursor: false,
    mouse_protocol: 'none',
    mouse_encoding: 'default',
  },
  reason: 'core_closed',
  next_step: 'retry',
  program_report: { reported: false },
} as const

/** The field fragments for existing, larger frames and replies. */
export const OPENED_REATTACHED_FRAGMENT = {
  kind: 'terminal.opened',
  data: {
    session: 'hc-example',
    epoch: 3,
    origin: 'reattached',
    state: 'running',
  },
} as const
export const ATTACH_LOST_FRAGMENT = {
  session: 'hc-example',
  attached: true,
  epoch: 2,
  state: 'lost',
  reason: 'core_closed',
  next_step: 'retry',
} as const
export const ATTACH_RUNNING_FRAGMENT = {
  session: 'hc-example',
  attached: true,
  epoch: 3,
  state: 'running',
} as const

/** Retired-binding frames with an explicit state. */
export const EXITED_GONE = {
  cursor: 'host:25',
  kind: 'terminal.exited',
  data: {
    session: 'hc-example',
    epoch: 2,
    exit_code: null,
    signal: null,
    reason: 'gone',
    state: 'gone',
  },
} as const
export const EXITED_EXITED = {
  cursor: 'host:26',
  kind: 'terminal.exited',
  data: {
    session: 'hc-example',
    epoch: 2,
    exit_code: 0,
    signal: null,
    reason: 'exited',
    state: 'exited',
  },
} as const
export const EXITED_SCOPE_REMOVED = {
  cursor: 'host:27',
  kind: 'terminal.exited',
  data: {
    session: 'hc-example',
    epoch: 2,
    exit_code: null,
    signal: null,
    reason: 'scope_removed',
    state: 'lost',
  },
} as const

/** Unavailable adoption and the sanitized backend refusal. */
export const ADOPTION_UNAVAILABLE_EVENT = {
  cursor: 'host:28',
  kind: 'terminal.adoption',
  data: {
    state: 'unavailable',
    reason: 'core_unavailable',
    next_step: 'retry',
  },
} as const
export const LIST_ADOPTION_UNAVAILABLE = {
  sessions: [],
  adoption: {
    state: 'unavailable',
    reason: 'subscribe_timed_out',
    next_step: 'retry',
  },
} as const
export const BACKEND_UNAVAILABLE = {
  code: 'terminal_backend_unavailable',
  message: 'Terminal backend unavailable',
  detail: { backend: 'herdr', cause: 'core_unavailable', next_step: 'retry' },
} as const

/** A control refusal the host still sends, and a host-owned argument. */
export const CONTROL_REFUSED_HELD = {
  code: 'terminal_control_refused',
  message: 'another attachment holds control at generation 1',
  detail: { reason: 'held', generation: 1, session: 'hc-example' },
} as const
export const ARGUMENT_REFUSED_CWD = {
  code: 'terminal_argument_refused',
  message: 'Terminal argument is host-owned or invalid',
  detail: { field: 'cwd' },
} as const

/** Launch with an operation id, its uncertain refusal, and the uncertain input receipt. */
export const LAUNCH_BODY = {
  backend: 'herdr',
  operation_id: 'launch-1',
  argv: ['/bin/sh'],
  cols: 80,
  rows: 24,
} as const
export const OPERATION_UNCERTAIN = {
  code: 'terminal_operation_uncertain',
  message: 'Terminal operation outcome uncertain',
  detail: { operation_id: 'launch-1', next_step: 'reconcile' },
} as const
export const INPUT_UNCERTAIN_RECEIPT = {
  session: 'hc-example',
  accepted: false,
  duplicate: false,
  discarded: false,
  uncertain: true,
  code: 'terminal_input_uncertain',
  next_step: 'reconcile',
} as const

/** The host-owned open fields the host refuses with `terminal_argument_refused`. */
export const HOST_OWNED_FIELDS = [
  'env',
  'cwd',
  'labels',
  'hc',
  'socket',
  'core_socket',
  'core_id',
  'session',
] as const
