// SOURCING: @tanstack/react-router Link to the Index's open item; the inspector's document opener (./open-document); the work tracker's item id (components/work/route). What a commitment's `task` and `draft` fields name, drawn as the work item and the document they are, not their raw ids
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import type { FieldSpec, ObjectType } from '@/components/records/contract'
import { workItemId } from '@/components/work/route'
import { builtInName } from './model'
import { useOpenDocumentHandler } from './open-document'

/** A saved document, opened where the surrounding inspector opens documents, else in the Index. */
export function DocumentLink({
  documentId,
  className,
  children,
}: {
  documentId: string
  className: string
  children: ReactNode
}) {
  const openDocument = useOpenDocumentHandler()
  return openDocument ? (
    <button
      type="button"
      className={className}
      onClick={(event) => {
        event.stopPropagation()
        openDocument(documentId)
      }}
    >
      {children}
    </button>
  ) : (
    <Link
      to="/index"
      search={{ item: documentId }}
      className={className}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </Link>
  )
}

/** A work item in the tracker, opened as the Index's item. */
export function WorkItemLink({
  itemId,
  className,
  children,
}: {
  itemId: string
  className: string
  children: ReactNode
}) {
  return (
    <Link
      to="/index"
      search={{ item: workItemId(itemId) }}
      className={className}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </Link>
  )
}

/** What a built-in field holds the id of: the task made, or the draft saved, for a commitment. */
export type MadeKind = 'task' | 'draft'

/**
 * Whether `field` of `type` names something Theorem made: a Commitment
 * installed as a built-in type keeps the id of its approved task in `task` and
 * of its saved message draft in `draft`. A type declared by hand never does.
 */
export function madeKind(
  type: ObjectType,
  field: FieldSpec,
): MadeKind | undefined {
  const crm = type.extensions?.['theorem.crm']
  const installed =
    typeof crm === 'object' &&
    crm !== null &&
    (crm as { built_in?: unknown }).built_in === true
  if (!installed || builtInName(type) !== 'commitment') return undefined
  return field.key === 'task' || field.key === 'draft' ? field.key : undefined
}

const MADE_LINK =
  'truncate font-medium underline decoration-ink-faint underline-offset-2 hover:text-ink'

/** The task or draft a commitment names, as a link to it. */
export function MadeValue({ kind, id }: { kind: MadeKind; id: string }) {
  return kind === 'task' ? (
    <WorkItemLink itemId={id} className={MADE_LINK}>
      Open the task
    </WorkItemLink>
  ) : (
    <DocumentLink documentId={id} className={MADE_LINK}>
      Open the draft
    </DocumentLink>
  )
}
