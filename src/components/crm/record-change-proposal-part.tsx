// SOURCING: assistant-ui data part renderer for Theorem's `record_change_proposal` part (see ./proposal for the decoding and the words); @tanstack/react-query for the proposal's current state and the decision; ui/button for Approve and Dismiss; the manifest part's RecordLink to each record's page in the Index; @tanstack/react-router Link to the conversation; lucide-react marks
import type { DataMessagePartComponent } from '@assistant-ui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowRight, CircleAlert, FilePen, ListTodo } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/theorem/client'
import { useDataModel } from '@/components/records/queries'
import { workItemId } from '@/components/work/route'
import { RecordLink } from './context-manifest-part'
import { decideProposal, problemCode, readProposal } from './proposal-api'
import {
  decodeProposalPart,
  outcomeWords,
  parseEvidence,
  valueWords,
} from './proposal'
import type { RecordProposal } from './proposal'

/** The change the assistant proposes, and the two ways to answer it. */
export function RecordChangeProposalView({
  snapshot,
}: {
  snapshot: RecordProposal
}) {
  const client = useQueryClient()
  const model = useDataModel().data
  const key = ['record-proposal', snapshot.proposalId] as const
  // The part is a snapshot from when it was proposed; the server knows now.
  const current = useQuery({
    queryKey: key,
    queryFn: async () => (await readProposal(snapshot.proposalId)) ?? snapshot,
    initialData: snapshot,
    retry: false,
  })
  const proposal = current.data
  const typeNamed = (name: string) =>
    model?.objectTypes.find(
      (type) => type.name_singular.toLowerCase() === name.toLowerCase(),
    )
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'dismiss') =>
      decideProposal(proposal, decision),
    onSuccess: (next) => {
      if (next) client.setQueryData(key, next)
    },
    onError: async (error) => {
      // The proposal is now refused, or was decided elsewhere: show what it is.
      const code = problemCode(error)
      if (
        code === 'record_revision_stale' ||
        code === 'record_proposal_decided'
      )
        await client.invalidateQueries({ queryKey: key })
    },
  })
  const pending = proposal.status === 'pending_approval'
  const outcome = outcomeWords(proposal)
  const failure =
    decide.isError &&
    pending &&
    (problemCode(decide.error) === 'record_proposal_decided'
      ? 'This was already decided. Reload to see what happened.'
      : describeError(decide.error))
  const type = typeNamed(proposal.objectType)
  const task = proposal.task
  const made = proposal.decision?.task
  // A task proposal's only field is the task's id; the task itself is shown.
  const fields = task
    ? proposal.fields.filter((field) => field.to !== task.workItemId)
    : proposal.fields

  return (
    <section
      aria-label={
        task
          ? `Proposed task for ${proposal.objectType}`
          : `Proposed change to ${proposal.objectType}`
      }
      data-part="theorem-record_change_proposal"
      data-status={proposal.status}
      className="my-2 flex flex-col gap-2.5 rounded-md border border-separator bg-raised px-3 py-2.5 text-[13px]"
    >
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-ink">
        {task ? (
          <ListTodo aria-hidden className="size-3.5 text-ink-muted" />
        ) : (
          <FilePen aria-hidden className="size-3.5 text-ink-muted" />
        )}
        <span>
          {task ? 'Proposed task for' : 'Proposed change to'}{' '}
          <RecordLink
            type={type}
            typeName={proposal.objectType}
            recordId={proposal.recordId}
          >
            {type?.label_singular ?? proposal.objectType}
          </RecordLink>
        </span>
      </h4>

      {task && (
        <div aria-label="Task" className="flex flex-col gap-0.5 leading-5">
          <span className="font-medium text-ink">{task.title}</span>
          {task.details && (
            <span className="text-xs text-ink-muted">{task.details}</span>
          )}
        </div>
      )}

      {fields.length > 0 && (
        <ul aria-label="Fields to change" className="flex flex-col gap-1.5">
          {fields.map((field) => (
            <li
              key={field.key}
              className="flex flex-wrap items-baseline gap-x-2 leading-5"
            >
              <span className="font-medium text-ink">{field.label}</span>
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="text-ink-muted line-through decoration-ink-faint">
                  {valueWords(field.from)}
                </span>
                <ArrowRight
                  aria-hidden
                  className="size-3 shrink-0 self-center text-ink-faint"
                />
                <span className="text-ink">{valueWords(field.to)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {proposal.reason && (
        <p className="text-xs leading-5 text-ink-muted">{proposal.reason}</p>
      )}

      {proposal.evidence.length > 0 && (
        <p
          aria-label="Evidence"
          className="flex flex-wrap gap-x-2 text-xs leading-5 text-ink-muted"
        >
          <span>Based on</span>
          {proposal.evidence.map((reference) => {
            const parsed = parseEvidence(reference)
            if (!parsed) return null
            const evidenceType = typeNamed(parsed.objectType)
            return (
              <RecordLink
                key={reference}
                type={evidenceType}
                typeName={parsed.objectType}
                recordId={parsed.recordId}
                className="font-normal"
              >
                {`${evidenceType?.label_singular ?? parsed.objectType}${
                  parsed.revision === undefined
                    ? ''
                    : ` · revision ${parsed.revision}`
                }`}
              </RecordLink>
            )
          })}
        </p>
      )}

      {pending ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={decide.isPending}
              onClick={() => decide.mutate('approve')}
            >
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={decide.isPending}
              onClick={() => decide.mutate('dismiss')}
            >
              Dismiss
            </Button>
            <span role="status" className="text-xs text-ink-muted">
              {decide.isPending
                ? 'Sending your answer'
                : task
                  ? 'Waiting for you. No task is made until you approve.'
                  : 'Waiting for you. Nothing is saved until you approve.'}
            </span>
          </div>
          {failure && (
            <p
              role="alert"
              className="flex gap-1.5 text-xs leading-5 text-error-ink"
            >
              <CircleAlert aria-hidden className="mt-1 size-3 shrink-0" />
              {failure}
            </p>
          )}
        </div>
      ) : (
        outcome && (
          <p role="status" className="text-xs leading-5 text-ink">
            {outcome}
            {made && (
              <>
                {' '}
                <Link
                  to="/index"
                  search={{ item: workItemId(made.workItemId) }}
                  className="font-medium underline decoration-ink-faint underline-offset-2"
                >
                  Open {made.key || 'the task'}
                </Link>
              </>
            )}
          </p>
        )
      )}
    </section>
  )
}

/** The `record_change_proposal` part: drawn only for a payload that is one. */
export const RecordChangeProposalPart: DataMessagePartComponent = ({
  data,
}) => {
  const proposal = decodeProposalPart(data)
  return proposal ? <RecordChangeProposalView snapshot={proposal} /> : null
}

/** The `record_change_outcome` part: the reply's text says what happened, so this draws nothing. */
export const RecordChangeOutcomePart: DataMessagePartComponent = () => null
