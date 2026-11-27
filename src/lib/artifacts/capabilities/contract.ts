// SOURCING: none. These wire types are mirrored by hand from Theorem's
// contract owner (rustyredcore_THG/crates/theorem-surface-contracts/src/
// artifact_capability.rs), as lib/capabilities/contract.ts mirrors
// capabilities_api.rs: one file that names the wire, and no library models it.
//
// The wire is camelCase. The Rust side reads records with
// `deny_unknown_fields`, so nothing here invents a field.

import type { ExecuteEnvironment } from '@/lib/theorem/artifact-host'

/** The contract's version, as the server names it. */
export const CAPABILITY_CONTRACT = 'theorem-artifact-capability/1'

/** The server's bounds (artifact_capability.rs), checked here before publishing. */
export const MAX_CAPABILITY_RECORDS = 128
export const MAX_RECORD_BYTES = 96 * 1024
export const MAX_SUMMARY_BYTES = 600
export const MAX_AFFORDANCES = 32
export const MAX_SECTION_BYTES = 32 * 1024
export const MAX_EXAMPLES = 8

export type LifecycleAction = 'present' | 'revise' | 'inspect' | 'retain' | 'publish'

export interface LifecycleStep {
  action: LifecycleAction
  /** The operation as the agent calls it, such as `ui.present`. */
  operation: string
}

export interface FormatContract {
  kind: 'format'
  accepts: string
  language: string
  runsIn: string
  provides?: Array<string>
  imports: string
  dataIn: string
  resultsOut: string
  lifecycle?: Array<LifecycleStep>
}

export interface LibraryContract {
  kind: 'library'
  /** The name code reads it by, or the import specifier. The record's `version` is the one the host provides. */
  import: string
  formats: Array<string>
  reference?: string
}

export interface ComponentContract {
  kind: 'component'
  formats: Array<string>
  /** JSON Schema. */
  props: unknown
  events?: Array<string>
  /** Whether a renderer draws it as itself. */
  implemented: boolean
  /** How it is drawn when it is not drawn as itself. */
  fallback?: string
  source?: string
}

export interface CapabilityRequirements {
  executor?: ExecuteEnvironment
  packages?: Array<string>
}

export interface DocSection {
  id: string
  title: string
  /** Markdown. */
  body: string
}

export interface CapabilityExample {
  title: string
  operation: string
  arguments: unknown
}

interface RecordBase {
  /** `<kind>:<name>`. */
  id: string
  version: string
  title: string
  summary: string
  /** Behaviours it supports, in the words a task would use. Searched. */
  affordances?: Array<string>
  related?: Array<string>
  requires?: CapabilityRequirements
  /** State an instance keeps when it is retained. */
  retains?: Array<string>
  sections?: Array<DocSection>
  examples?: Array<CapabilityExample>
}

export type CapabilityRecord = RecordBase & (FormatContract | LibraryContract | ComponentContract)

/** What the server answers a publication or a read with. */
export interface PublishedCapabilities {
  digest: string
  ids: Array<string>
}

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

/**
 * The first rule a set of records breaks, in the server's words, so a build
 * that would be refused fails its own test instead.
 */
export function recordProblems(records: ReadonlyArray<CapabilityRecord>): Array<string> {
  const problems: Array<string> = []
  if (records.length > MAX_CAPABILITY_RECORDS)
    problems.push(`${records.length} records; publish at most ${MAX_CAPABILITY_RECORDS}`)
  const seen = new Set<string>()
  for (const record of records) {
    const name = record.id.startsWith(`${record.kind}:`) ? record.id.slice(record.kind.length + 1) : ''
    if (!/^[A-Za-z0-9\-_./@]{1,64}$/.test(name)) problems.push(`${record.id}: id is \`${record.kind}:<name>\``)
    if (seen.has(record.id)) problems.push(`${record.id} is published twice`)
    seen.add(record.id)
    if (new TextEncoder().encode(record.summary).length > MAX_SUMMARY_BYTES)
      problems.push(`${record.id}: summary over ${MAX_SUMMARY_BYTES} bytes`)
    if ((record.affordances?.length ?? 0) > MAX_AFFORDANCES)
      problems.push(`${record.id}: over ${MAX_AFFORDANCES} affordances`)
    if ((record.examples?.length ?? 0) > MAX_EXAMPLES) problems.push(`${record.id}: over ${MAX_EXAMPLES} examples`)
    for (const section of record.sections ?? [])
      if (new TextEncoder().encode(section.body).length > MAX_SECTION_BYTES)
        problems.push(`${record.id}: section ${section.id} over ${MAX_SECTION_BYTES} bytes`)
    if (bytes(record) > MAX_RECORD_BYTES) problems.push(`${record.id}: over ${MAX_RECORD_BYTES} bytes`)
  }
  return problems
}
