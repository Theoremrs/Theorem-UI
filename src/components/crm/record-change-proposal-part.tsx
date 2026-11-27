// SOURCING: assistant-ui data part renderer for Theorem's `record_change_proposal` part (see ./proposal for the decoding and the words); the inspector's document opener (./open-document), else a Link to the document in the Index, for a source and a saved message draft; @tanstack/react-query for the proposal's current state and the decision; ui/button for Approve and Dismiss; the manifest part's RecordLink to each record's page in the Index; @tanstack/react-router Link to the conversation; lucide-react marks
import type { DataMessagePartComponent } from '@assistant-ui/react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  CircleAlert,
  FilePen,
  FileText,
  ListTodo,
  Mail,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { describeError } from '@/lib/theorem/client'
import { useDataModel } from '@/components/records/queries'
import { RecordLink } from './context-manifest-part'
import { DocumentLink, WorkItemLink } from './made-links'
import { staleRecordEverywhere } from './queries'
import { decideProposal, problemCode, readProposal } from './proposal-api'
import {
  decodeProposalPart,
  outcomeWords,
  parseEvidence,
  valueWords,
} from './proposal'
import type { RecordProposal } from './proposal'

const SOURCE_LINK =
  'underline decoration-ink-faint underline-offset-2 hover:text-ink'

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
    onSuccess: (next, decision) => {
      if (next) client.setQueryData(key, next)
      // An approval saved the change: a record opened before it, in the CRM
      // or in Records, still holds the old values, revision and history.
      if (decision === 'approve')
        staleRecordEverywhere(
          client,
          proposal.recordId,
          proposal.objectTypeId,
          typeNamed(proposal.objectType),
        )
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
  const draft = proposal.draft
  const savedDraft = proposal.decision?.draft
  // A task or draft proposal's only field is the id of what it makes; that
  // itself is shown instead.
  const madeId = task?.workItemId ?? draft?.documentId
  const fields = madeId
    ? proposal.fields.filter((field) => field.to !== madeId)
    : proposal.fields
  const heading = task
    ? 'Proposed task for'
    : draft
      ? 'Proposed message draft for'
      : 'Proposed change to'

  return (
    <section
      aria-label={`${heading} ${proposal.objectType}`}
      data-part="theorem-record_change_proposal"
      data-status={proposal.status}
      className="my-2 flex flex-col gap-2.5 rounded-md border border-separator bg-raised px-3 py-2.5 text-[13px]"
    >
      <h4 className="flex items-center gap-1.5 text-xs font-medium text-ink">
        {task ? (
          <ListTodo aria-hidden className="size-3.5 text-ink-muted" />
        ) : draft ? (
          <Mail aria-hidden className="size-3.5 text-ink-muted" />
        ) : (
          <FilePen aria-hidden className="size-3.5 text-ink-muted" />
        )}
        <span>
          {heading}{' '}
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

      {draft && (
        <div
          aria-label="Message draft"
          className="flex flex-col gap-1 leading-5"
        >
          {draft.to && (
            <span className="text-xs text-ink-muted">
              To{' '}
              <RecordLink
                type={typeNamed('Person')}
                typeName="Person"
                recordId={draft.to.recordId}
                className="font-normal"
              >
                {draft.to.title}
              </RecordLink>
            </span>
          )}
          <span className="font-medium text-ink">{draft.subject}</span>
          <p className="whitespace-pre-wrap border-l-2 border-separator ps-2 text-xs text-ink">
            {draft.body}
          </p>
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

      {proposal.sources.length > 0 && (
        <ul aria-label="From documents" className="flex flex-col gap-1.5">
          {proposal.sources.map((source) => (
            <li
              key={`${source.documentId}:${source.quote}`}
              className="flex flex-col gap-0.5 text-xs leading-5"
            >
              <blockquote className="border-l-2 border-separator ps-2 text-ink">
                {source.quote}
              </blockquote>
              <span className="flex flex-wrap items-baseline gap-x-1 ps-2.5 text-ink-muted">
                <FileText aria-hidden className="size-3 self-center" />
                <DocumentLink
                  documentId={source.documentId}
                  className={SOURCE_LINK}
                >
                  {source.title}
                </DocumentLink>
                {source.revision !== null && (
                  <span>{`· revision ${source.revision}`}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
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
                  : draft
                    ? 'Waiting for you. Nothing is saved or sent until you approve.'
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
                <WorkItemLink
                  itemId={made.workItemId}
                  className="font-medium underline decoration-ink-faint underline-offset-2"
                >
                  Open {made.key || 'the task'}
                </WorkItemLink>
              </>
            )}
            {savedDraft && (
              <>
                {' '}
                <DocumentLink
                  documentId={savedDraft.documentId}
                  className="font-medium underline decoration-ink-faint underline-offset-2"
                >
                  Open the draft
                </DocumentLink>
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
