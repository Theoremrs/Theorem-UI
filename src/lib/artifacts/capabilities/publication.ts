// SOURCING: @tanstack/react-query (read once, publish when stale), the Index's
// GET helper and the shared Theorem response reader over platform fetch, the
// CSRF/idempotency helper from lib/theorem/client, Web Crypto's SHA-256 via
// blocks/last-run; the same publication the OpenUI library record makes
// (components/artifacts/openui/publication.ts).
//
// Theorem indexes the records of what this build renders, so the agent's
// search finds them and describe loads their contracts. A build publishes
// only when Theorem holds a different digest.
import { useQuery } from '@tanstack/react-query'
import { get } from '@/components/index/api'
import { sha256Hex } from '@/lib/blocks/last-run'
import { hasStatus, isSignedOut, mutate } from '@/lib/theorem/client'
import { readTheoremJson } from '@/lib/theorem/passthrough'
import type { CapabilityRecord, PublishedCapabilities } from './contract'
import { INTERFACE_RECORDS } from './records'

export const CAPABILITIES_PATH = '/api/artifacts/v1/capabilities'

/** What Theorem holds, or undefined before anything was published. */
export async function readPublished(): Promise<PublishedCapabilities | undefined> {
  try {
    return await get<PublishedCapabilities>(CAPABILITIES_PATH)
  } catch (error) {
    if (hasStatus(error, 404)) return undefined
    throw error
  }
}

export const publish = (digest: string, records: ReadonlyArray<CapabilityRecord>) =>
  mutate(async (headers) =>
    readTheoremJson<PublishedCapabilities>(
      await fetch(CAPABILITIES_PATH, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ digest, records }),
      }),
    ),
  )

/** Publishes this build's records when Theorem's digest differs; answers what Theorem holds. */
export async function syncCapabilityRecords(records: ReadonlyArray<CapabilityRecord> = INTERFACE_RECORDS) {
  const [published, digest] = await Promise.all([readPublished(), sha256Hex(JSON.stringify(records))])
  if (published?.digest === digest) return published
  return publish(digest, records)
}

/** Syncs the records once per session. */
export function CapabilityRecordsPublication() {
  useQuery({
    queryKey: ['artifact-capabilities'],
    queryFn: () => syncCapabilityRecords(),
    staleTime: Infinity,
    retry: (failures, error) => !isSignedOut(error) && failures < 1,
  })
  return null
}
