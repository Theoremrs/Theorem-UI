// SOURCING: lib/theorem/passthrough (theoremJson, for routes the SDK has no client for yet) with the shared CSRF, idempotency and thread-revision helper (mutateThread) from lib/theorem/client; every call of /api/chat/v1/record-proposals is here
import { TheoremError } from '@theoremharness/sdk'
import { mutateThread } from '@/lib/theorem/client'
import { theoremJson } from '@/lib/theorem/passthrough'
import { decodeProposal } from './proposal'
import type { RecordProposal } from './proposal'

const PROPOSALS = '/api/chat/v1/record-proposals'

/** The proposal as it stands now; none where the server does not have it (404). */
export async function readProposal(
  proposalId: string,
): Promise<RecordProposal | undefined> {
  try {
    const body = await theoremJson<{ proposal?: unknown } | undefined>(
      `${PROPOSALS}/${encodeURIComponent(proposalId)}`,
    )
    return decodeProposal(body?.proposal)
  } catch (error) {
    if (error instanceof TheoremError && error.statusCode === 404)
      return undefined
    throw error
  }
}

/** A refusal's problem body: `record_revision_stale`, `record_proposal_decided`. */
export function problemCode(error: unknown): string | undefined {
  if (!(error instanceof TheoremError)) return undefined
  const body = error.body
  return body && typeof body === 'object' && 'code' in body
    ? String(body.code)
    : undefined
}

/**
 * Approve or dismiss. The decision is a revisioned write on the thread: the
 * If-Match is the thread's revision, quoted, with a fresh idempotency key.
 */
export async function decideProposal(
  proposal: Pick<RecordProposal, 'proposalId' | 'threadId'>,
  decision: 'approve' | 'dismiss',
): Promise<RecordProposal | undefined> {
  const body = await mutateThread(proposal.threadId, (headers) =>
    theoremJson<{ proposal?: unknown } | undefined>(
      `${PROPOSALS}/${encodeURIComponent(proposal.proposalId)}/decision`,
      {
        method: 'POST',
        body: { decision },
        headers: { ...headers, 'If-Match': `"${headers['If-Match']}"` },
      },
    ),
  )
  return decodeProposal(body?.proposal)
}
