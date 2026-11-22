// SOURCING: none — the pin is this workbench's own record of the one Herdr core it has been verified against (docs/plans/theo-workbench/gate-0/terminal-path.md section 3: herdr-core 0.1.17, protocol generation 1, framed JSON-RPC behind the host); no library models which core a host may start. The core's own wire (hello, frame codec) is spoken by the host, never by the browser, so what can be negotiated here is the identity the host reports in its capabilities and in each open and attach answer.
import { readable } from '../environment/redact'

/**
 * The Herdr core this client is pinned to. `generation` alone cannot identify it: the older Remux
 * protocol also calls itself generation one and is not wire compatible (R24), so the core's version
 * decides and the generation is a second check.
 */
export const SUPPORTED_HERDR_CORE = {
  generation: 1,
  versions: ['0.1.17'],
} as const

/** What the host's `backends.herdr` says, read against the pin. */
export type HerdrIdentity =
  | { supported: true; version: string; generation: number | undefined }
  | { supported: false; reason: string }

const pinned = () =>
  `this client supports herdr-core ${SUPPORTED_HERDR_CORE.versions.join(', ')} (protocol generation ${SUPPORTED_HERDR_CORE.generation})`

/**
 * Whether the host reports a Herdr core this client can use, and if not, in one readable sentence
 * what was offered and what is supported. Absent, not ready, unidentified and unsupported are all
 * unsupported: a host that cannot be identified is never assumed to speak the current protocol, and
 * a Herdr request is never answered with a native shell.
 */
export function herdrIdentity(backend: unknown): HerdrIdentity {
  if (!backend || typeof backend !== 'object') {
    return {
      supported: false,
      reason: `The host reports no Herdr backend, so no core was offered; ${pinned()}`,
    }
  }
  const { ready, generation, version, reason } = backend as Record<
    string,
    unknown
  >
  if (ready !== true) {
    const why =
      typeof reason === 'string' && reason ? `: ${readable(reason)}` : ''
    return {
      supported: false,
      reason: `The host reports Herdr not ready${why}; ${pinned()}`,
    }
  }
  if (typeof version !== 'string' || version === '') {
    return {
      supported: false,
      reason: `The host reports Herdr ready without a core version, so its protocol cannot be identified; ${pinned()}`,
    }
  }
  const offered = `herdr-core ${readable(version)}${
    generation === undefined
      ? ''
      : ` (protocol generation ${readable(String(generation))})`
  }`
  if (!(SUPPORTED_HERDR_CORE.versions as readonly string[]).includes(version)) {
    return {
      supported: false,
      reason: `The host offers ${offered}; ${pinned()}`,
    }
  }
  if (
    generation !== undefined &&
    generation !== SUPPORTED_HERDR_CORE.generation
  ) {
    return {
      supported: false,
      reason: `The host offers ${offered}; ${pinned()}`,
    }
  }
  return {
    supported: true,
    version,
    generation: typeof generation === 'number' ? generation : undefined,
  }
}
