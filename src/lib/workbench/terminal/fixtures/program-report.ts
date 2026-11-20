// SOURCING: none — documented examples copied verbatim from the backend worktree's docs/plans/2026-11-15-ide-host-program-report.md (section "Wire contract"), plus synthetic malformed inputs labelled as such

/** The documented field fragments, in the document's order, with what each must read as. */
export const DOCUMENTED = [
  { name: 'field absent', fragment: {}, expect: { kind: 'unavailable' } },
  {
    name: 'never reported',
    fragment: { program_report: { reported: false } },
    expect: { kind: 'never_reported' },
  },
  {
    name: 'cleared with a timestamp',
    fragment: { program_report: { reported: true, status_ms: 123 } },
    expect: { kind: 'cleared', statusMs: 123 },
  },
  {
    name: 'idle',
    fragment: {
      program_report: {
        reported: true,
        status: { state: 'idle' },
        status_ms: 123,
      },
    },
    expect: { kind: 'current', status: { state: 'idle' }, statusMs: 123 },
  },
  {
    name: 'working with progress and a message',
    fragment: {
      program_report: {
        reported: true,
        status: { state: 'working', progress: 40, msg: 'probe one' },
        seq: 7,
      },
    },
    expect: {
      kind: 'current',
      status: { state: 'working', progress: 40, msg: 'probe one' },
      seq: 7,
    },
  },
  {
    name: 'done saying finished',
    fragment: {
      program_report: {
        reported: true,
        status: { state: 'done', msg: 'finished' },
        seq: 11,
      },
    },
    expect: {
      kind: 'current',
      status: { state: 'done', msg: 'finished' },
      seq: 11,
    },
  },
  {
    name: 'blocked on permission',
    fragment: {
      program_report: {
        reported: true,
        status: {
          state: 'blocked',
          kind: 'permission',
          msg: 'needs a yes',
          app: 'probe',
          title: 'root',
        },
        seq: 8,
      },
    },
    expect: {
      kind: 'current',
      status: {
        state: 'blocked',
        kind: 'permission',
        msg: 'needs a yes',
        app: 'probe',
        title: 'root',
      },
      seq: 8,
    },
  },
  {
    name: 'error',
    fragment: {
      program_report: {
        reported: true,
        status: { state: 'error' },
        status_ms: 123,
      },
    },
    expect: { kind: 'current', status: { state: 'error' }, statusMs: 123 },
  },
  {
    name: 'an unfamiliar word the host mapped to unknown',
    fragment: {
      program_report: {
        reported: true,
        status: { state: 'unknown', raw_state: 'future-word' },
        seq: 21,
      },
    },
    expect: {
      kind: 'current',
      status: { state: 'unknown', rawState: 'future-word' },
      seq: 21,
    },
  },
  {
    name: 'cleared with a sequence',
    fragment: { program_report: { reported: true, seq: 12 } },
    expect: { kind: 'cleared', seq: 12 },
  },
] as const

/** SYNTHETIC. A host that breaks its own contract; each says what the owner must make of it. */
export const MALFORMED: Record<string, { value: unknown; expect: unknown }> = {
  'a string where the report object should be': {
    value: 'working',
    expect: { kind: 'unavailable' },
  },
  'a report with no reported flag': {
    value: { status: { state: 'working' } },
    expect: { kind: 'unavailable' },
  },
  'reported as the string "true"': {
    value: { reported: 'true', status: { state: 'working' } },
    expect: { kind: 'unavailable' },
  },
  'a status beside reported false': {
    value: { reported: false, status: { state: 'working' } },
    expect: { kind: 'unavailable' },
  },
  'a status that is a string': {
    value: { reported: true, status: 'working' },
    expect: { kind: 'unavailable' },
  },
  'a status with no state': {
    value: { reported: true, status: { msg: 'hello' } },
    expect: { kind: 'unavailable' },
  },
  'a state that is a number': {
    value: { reported: true, status: { state: 1 } },
    expect: { kind: 'unavailable' },
  },
  'a state outside the list with no raw_state': {
    value: { reported: true, status: { state: 'finished' } },
    expect: {
      kind: 'current',
      status: { state: 'unknown', rawState: 'finished' },
    },
  },
  'unknown with no raw_state': {
    value: { reported: true, status: { state: 'unknown' } },
    expect: { kind: 'current', status: { state: 'unknown' } },
  },
  'a raw_state beside a known state is ignored': {
    value: { reported: true, status: { state: 'idle', raw_state: 'busy' } },
    expect: { kind: 'current', status: { state: 'idle' } },
  },
  'progress that is a fraction': {
    value: { reported: true, status: { state: 'working', progress: 40.5 } },
    expect: { kind: 'current', status: { state: 'working' } },
  },
  'progress above 255': {
    value: { reported: true, status: { state: 'working', progress: 256 } },
    expect: { kind: 'current', status: { state: 'working' } },
  },
  'progress that is negative': {
    value: { reported: true, status: { state: 'working', progress: -1 } },
    expect: { kind: 'current', status: { state: 'working' } },
  },
  'progress as a string': {
    value: { reported: true, status: { state: 'working', progress: '40' } },
    expect: { kind: 'current', status: { state: 'working' } },
  },
  'progress 255 as sent': {
    value: { reported: true, status: { state: 'working', progress: 255 } },
    expect: { kind: 'current', status: { state: 'working', progress: 255 } },
  },
  'text fields that are not strings': {
    value: {
      reported: true,
      status: { state: 'done', msg: 5, title: {}, app: null, kind: ['x'] },
    },
    expect: { kind: 'current', status: { state: 'done' } },
  },
  'a sequence that is negative or fractional': {
    value: {
      reported: true,
      status: { state: 'idle' },
      seq: -3,
      status_ms: 1.5,
    },
    expect: { kind: 'current', status: { state: 'idle' } },
  },
}
