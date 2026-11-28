// SOURCING: lib/resources references (via ./use-resource useReferences), the grouping and counts of lib/resources/references, the relationship kinds of lib/resources/relationships, the contribution registry's `reference-row` kind for a context-specific row renderer, the app's Button and the coss Badge. LINK-03/LINK-04: grouped by canonical source, each occurrence's own destination, counts naming their unit, a failed later page keeping its rows, a failed query never read as empty, and relationship kinds labeled and filtered, never merged.
import { useMemo, useState } from 'react'
import { Badge } from '@/components/coss/badge'
import { Button } from '@/components/ui/button'
import type { ReferencesRequest } from '@/lib/resources/provider'
import { countLabel, groupOccurrences } from '@/lib/resources/references'
import type { ReferenceGroup } from '@/lib/resources/references'
import {
  RELATIONSHIP_DESCRIPTION,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_LABEL,
  filterByRelationship,
} from '@/lib/resources/relationships'
import type { RelationshipKind } from '@/lib/resources/relationships'
import type { ResourceRef } from '@/lib/resources/types'
import { openResource } from './open-resource'
import { ResourceChip } from './resource-chip'
import { useReferences } from './use-resource'

/** One source with every occurrence in it: a row, its meanings, and a destination for each occurrence. */
export function ReferenceRow({ group }: { group: ReferenceGroup }) {
  const [expanded, setExpanded] = useState(false)
  const [refusal, setRefusal] = useState<string>()
  const many = group.occurrences.length > 1
  return (
    <li className="flex flex-col gap-1 rounded-md border border-separator bg-raised px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <ResourceChip resourceRef={group.source} />
        {group.relationships.map((kind) => (
          <Badge
            key={kind}
            variant="outline"
            title={RELATIONSHIP_DESCRIPTION[kind]}
          >
            {RELATIONSHIP_LABEL[kind]}
          </Badge>
        ))}
        {many && (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            {group.occurrences.length} places
          </Button>
        )}
        {!many && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void openResource(group.occurrences[0]!.destination).then(
                setRefusal,
              )
            }
          >
            Go to
          </Button>
        )}
      </div>
      {group.occurrences[0]?.snippet && !many && (
        <p className="line-clamp-2 text-xs text-ink-muted">
          {group.occurrences[0].snippet}
        </p>
      )}
      {many && expanded && (
        <ul className="flex flex-col gap-0.5 ps-2">
          {group.occurrences.map((occurrence) => (
            <li key={occurrence.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-ink-muted">
                {occurrence.snippet ??
                  RELATIONSHIP_LABEL[occurrence.relationship]}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  void openResource(occurrence.destination).then(setRefusal)
                }
              >
                Go to
              </Button>
            </li>
          ))}
        </ul>
      )}
      {refusal && (
        <p role="alert" className="text-xs text-ink-muted">
          {refusal}
        </p>
      )}
    </li>
  )
}

/**
 * Incoming (or outgoing) references to a resource, with a filter for each
 * meaning. The count says what it counts; more pages load on request.
 */
export function ReferencesPanel({
  target,
  direction = 'incoming',
}: {
  target: ResourceRef
  direction?: ReferencesRequest['direction']
}) {
  const [selected, setSelected] = useState<ReadonlySet<RelationshipKind>>(
    new Set(),
  )
  const state = useReferences(target, { direction })
  const rows = useMemo(
    () => filterByRelationship(state.rows, selected),
    [state.rows, selected],
  )
  const groups = useMemo(() => groupOccurrences(rows), [rows])
  const present = useMemo(
    () => new Set(state.rows.map((row) => row.relationship)),
    [state.rows],
  )
  const toggle = (kind: RelationshipKind) =>
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })

  if (state.status === 'loading')
    return (
      <p role="status" className="text-sm text-ink-muted">
        Loading references…
      </p>
    )
  if (state.status === 'unsupported')
    return (
      <p role="status" className="text-sm text-ink-muted">
        References for this kind of resource are not available here yet.
      </p>
    )
  if (state.status === 'failed')
    return (
      <div role="alert" className="flex items-center gap-2 text-sm">
        <span>
          References could not be loaded. This is not the same as having none.
        </span>
        <Button size="sm" variant="outline" onClick={state.retry}>
          Try again
        </Button>
      </div>
    )
  return (
    <section aria-label="References" className="flex flex-col gap-2">
      <header className="flex flex-col gap-1">
        <p className="text-xs text-ink-muted">{countLabel(state)}</p>
        <div
          role="group"
          aria-label="Show meanings"
          className="flex flex-wrap gap-1"
        >
          {RELATIONSHIP_KINDS.filter((kind) => present.has(kind)).map(
            (kind) => (
              <Button
                key={kind}
                size="xs"
                variant={selected.has(kind) ? 'secondary' : 'outline'}
                aria-pressed={selected.has(kind)}
                title={RELATIONSHIP_DESCRIPTION[kind]}
                onClick={() => toggle(kind)}
              >
                {RELATIONSHIP_LABEL[kind]}
              </Button>
            ),
          )}
        </div>
      </header>
      {groups.length === 0 ? (
        <p className="text-sm text-ink-muted">
          {state.next
            ? 'None of the loaded references match. Load more to look further.'
            : 'Nothing references this that you can see.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {groups.map((group) => (
            <ReferenceRow key={group.sourceKey} group={group} />
          ))}
        </ul>
      )}
      {state.status === 'failed-more' && (
        <div role="alert" className="flex items-center gap-2 text-xs">
          <span>
            The next page could not be loaded. What was loaded is still here.
          </span>
          <Button size="xs" variant="outline" onClick={state.retry}>
            Try again
          </Button>
        </div>
      )}
      {state.next && state.status !== 'failed-more' && (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={state.status === 'loading-more'}
            onClick={state.more}
          >
            {state.status === 'loading-more' ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </section>
  )
}
