// SOURCING: none — the host's advertised operations (./environment) read as the wire's capability words, which the Rust registry gates panels and actions on
import type { Environment } from './environment/environment'
import type { Capability } from './wire'

type Advertised = Pick<
  Environment,
  'availability' | 'availabilityFor' | 'operations' | 'backends'
>

/**
 * The operations that stand for each host capability: one available operation with that name, or
 * with that prefix, grants it. The names are the host's own (`workspace.files.list`, `scm.status`).
 */
const HOST: readonly (readonly [Capability, string])[] = [
  ['files', 'workspace.files.list'],
  ['documents', 'documents.open'],
  ['scm', 'scm.status'],
  ['terminal', 'terminal.open'],
  ['search', 'search.query'],
  ['run', 'run.'],
  ['language', 'language.'],
]

/**
 * What the host can serve right now: the environment itself, each capability one of whose
 * operations the host lists as available, each such operation by its own name, and `terminal.herdr` when it reports that backend ready.
 * `local` are the capabilities that are not host operations (the saved layout, the conversation,
 * artifacts, the clipboard); their owners are the workbench's own.
 */
export function grantedCapabilities(
  env: Advertised,
  local: readonly Capability[],
): Capability[] {
  const granted: Capability[] = []
  if (env.availability.status === 'available') {
    granted.push('environment')
    const available = env
      .operations()
      .filter(({ state }) => state.state === 'available')
      .map(({ name }) => name)
    for (const [capability, operation] of HOST) {
      const served = operation.endsWith('.')
        ? available.some((name) => name.startsWith(operation))
        : available.includes(operation)
      if (served) granted.push(capability)
    }
    // Panels and actions are also gated on operation words themselves (`diagnostics.subscribe`,
    // `run.start`, `scm.commit.amend`): an operation the host lists as available is granted as it is named.
    for (const name of available)
      if (!granted.includes(name)) granted.push(name)
    if (granted.includes('terminal')) granted.push('terminal.native')
    if (granted.includes('terminal') && env.backends().includes('herdr'))
      granted.push('terminal.herdr')
  }
  granted.push(...local)
  return granted
}
