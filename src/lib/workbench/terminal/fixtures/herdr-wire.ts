// SOURCING: none — recorded and synthetic fixtures for AC-62, data only.
//
// PROVENANCE. SUPPORTED_* are the shapes the host's terminal path records for the pinned pair
// (docs/plans/theo-workbench/gate-0/terminal-path.md section 2.1 for the open, attach and
// capabilities fields, section 3 for herdr-core 0.1.17, protocol generation 1); the values are made
// up, the field names and the pin are recorded. LEGACY_* are SYNTHETIC. The older Herdr/Remux wire
// is named in the plan (herdr-integration.md, SOURCES.md: "the prior Remux generation-one protocol",
// "the older Herdr/Remux binary protocol") but no source in this repository or in the installed
// packages records its bytes or fields, and the browser never speaks the core's wire (the host
// does, in Rust). So each LEGACY_* below is a labelled mismatch of the kinds a browser could
// meet in the host's JSON answers: a wrong protocol name, an older version that also calls itself
// generation one, a different generation, a launch answered by another backend, and binary or
// non-JSON bodies where the JSON reply is expected.

/** The capabilities `backends.herdr` of the pinned core. */
export const SUPPORTED_HERDR_BACKEND = {
  ready: true,
  generation: 1,
  version: '0.1.17',
  core_id: 'herdr-core-fixture',
  session: 'theorem',
  binary: '/usr/local/bin/hc',
  binary_present: true,
} as const

export const SUPPORTED_OPEN_REPLY = {
  session: 'hc-fixture-1',
  cols: 80,
  rows: 24,
  backend: 'herdr',
  binding: {
    backend: 'herdr',
    epoch: 1,
    core_id: 'herdr-core-fixture',
    terminal: 'term-1',
    program: 1,
  },
  process_owned_by: 'herdr-core',
} as const

/** `terminal.attach` answers `data` as base64 of the bytes from `offset_start`. */
export const SUPPORTED_ATTACH_REPLY = {
  session: 'hc-fixture-1',
  attached: true,
  attachment: 'ta-1',
  control: {
    attachment: 'ta-1',
    role: 'controller',
    controlling: true,
    controlled: true,
    generation: 1,
    epoch: 1,
  },
  backend: 'herdr',
  epoch: 1,
  binding: SUPPORTED_OPEN_REPLY.binding,
  formatted: '',
  offset_start: 0,
  offset_end: 5,
  data: btoa('ready'),
} as const

/** SYNTHETIC. What a host with an older or different Herdr core could report as `backends.herdr`. */
export const LEGACY_HERDR_BACKENDS: Record<
  string,
  { backend: unknown; offered: string }
> = {
  'no backends at all (a host older than Herdr)': {
    backend: undefined,
    offered: 'no Herdr backend',
  },
  'ready with no core version': {
    backend: { ready: true, generation: 1 },
    offered: 'without a core version',
  },
  'an older core that also says generation one': {
    backend: { ready: true, generation: 1, version: '0.0.9' },
    offered: 'herdr-core 0.0.9 (protocol generation 1)',
  },
  'the Remux core by name': {
    backend: { ready: true, generation: 1, version: 'remux-1.0' },
    offered: 'herdr-core remux-1.0 (protocol generation 1)',
  },
  'a newer protocol generation on the pinned version': {
    backend: { ready: true, generation: 2, version: '0.1.17' },
    offered: 'herdr-core 0.1.17 (protocol generation 2)',
  },
  'a core the host cannot reach': {
    backend: { ready: false, reason: 'hc not found' },
    offered: 'not ready: hc not found',
  },
}

/** SYNTHETIC. A Herdr launch an older host answers as its own native shell. */
export const LEGACY_OPEN_NATIVE = {
  session: 'pty-legacy-1',
  cols: 80,
  rows: 24,
  backend: 'native',
  binding: { backend: 'native', epoch: 1, program: 1 },
  process_owned_by: 'host',
} as const

/** SYNTHETIC. Bodies where the JSON attach reply is expected, in the shapes a different wire would produce. */
export const LEGACY_ATTACH_BODIES: Record<string, unknown> = {
  'a binary frame with an unknown magic':
    '\u0089RMX\r\n\u001a\n\u0000\u0000\u0000\u0005ready',
  'raw bytes as a typed array': new Uint8Array([0x89, 0x52, 0x4d, 0x58, 0x00]),
  'JSON bytes as a number array where base64 is expected': {
    ...SUPPORTED_ATTACH_REPLY,
    data: [114, 101, 97, 100, 121],
  },
  'a data field that is not base64': {
    ...SUPPORTED_ATTACH_REPLY,
    data: '\u0089RMX not base64 *** \u0000',
  },
  'a reply with no byte offsets': {
    session: 'hc-fixture-1',
    attached: true,
    data: btoa('ready'),
  },
  'an attach answered as another backend': {
    ...SUPPORTED_ATTACH_REPLY,
    backend: 'native',
  },
}
