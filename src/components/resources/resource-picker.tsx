// SOURCING: lib/resources search and searchMore (grouped by provider, each group with its own cursor and failure), the coss Input and the app's Button for the controls, and an AbortController per query for cancellation. REF-04/REF-05: a partial or failed group is said, never merged into a list that looks complete.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Input } from '@/components/coss/input'
import { Button } from '@/components/ui/button'
import type { SearchHit } from '@/lib/resources/provider'
import {
  coverageOf,
  groupComplete,
  search,
  searchMore,
} from '@/lib/resources/registry'
import type { Coverage, SearchGroup } from '@/lib/resources/registry'
import { refKey } from '@/lib/resources/types'

const DEBOUNCE_MS = 150

/** The notice a group's state needs under its rows; empty when it is complete. */
export function groupNotice(group: SearchGroup): string | undefined {
  switch (group.status) {
    case 'failed':
      return `${group.label} could not be searched.`
    case 'offline':
      return `${group.label} could not be searched while offline.`
    case 'unsupported':
      return `${group.label} cannot be searched yet.`
    case 'ok':
      if (group.error)
        return `More ${group.label.toLowerCase()} could not be loaded.`
      if (group.page?.truncated && !group.page.next)
        return `Showing the best matches in ${group.label.toLowerCase()}. More may exist.`
      return undefined
  }
}

export function coverageNotice(
  coverage: Coverage,
  groups: readonly SearchGroup[],
) {
  if (coverage === 'failed')
    return 'Nothing could be searched. This is not the same as no results.'
  if (coverage === 'partial' && groups.some((g) => g.status !== 'ok'))
    return 'Some places could not be searched, so these results are incomplete.'
  if (coverage === 'partial')
    return 'These are the best matches, not every match.'
  return undefined
}

export function ResourcePicker({
  onPick,
  providerIds,
  scope,
  label = 'Find a resource',
  autoFocus = true,
}: {
  onPick: (hit: SearchHit) => void
  providerIds?: readonly string[]
  scope?: Record<string, Record<string, string>>
  label?: string
  autoFocus?: boolean
}) {
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<SearchGroup[]>([])
  const [searching, setSearching] = useState(false)
  const [failed, setFailed] = useState(false)
  const controller = useRef<AbortController>(undefined)
  const list = useRef<HTMLDivElement>(null)

  const run = useCallback(
    (text: string) => {
      controller.current?.abort()
      const next = new AbortController()
      controller.current = next
      setSearching(true)
      setFailed(false)
      search({ query: text, providerIds, scope, signal: next.signal }).then(
        (result) => {
          if (next.signal.aborted) return
          setGroups(result.groups)
          setSearching(false)
        },
        () => {
          if (next.signal.aborted) return
          setFailed(true)
          setSearching(false)
        },
      )
    },
    [providerIds, scope],
  )

  // A new query cancels the one in flight; closing the picker cancels the last.
  useEffect(() => {
    const timer = setTimeout(() => run(query), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query, run])
  useEffect(() => () => controller.current?.abort(), [])

  const loadMore = async (group: SearchGroup) => {
    const more = await searchMore(group, { query, scope })
    setGroups((current) =>
      current.map((g) => (g.providerId === group.providerId ? more : g)),
    )
  }

  const move = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const options = [
      ...(list.current?.querySelectorAll<HTMLElement>('[data-option]') ?? []),
    ]
    const at = options.indexOf(document.activeElement as HTMLElement)
    const next = event.key === 'ArrowDown' ? at + 1 : at - 1
    if (next >= 0 && next < options.length) {
      event.preventDefault()
      options[next]!.focus()
    }
  }

  const coverage = coverageOf(groups)
  const notice =
    !searching && !failed ? coverageNotice(coverage, groups) : undefined
  const total = groups.reduce((n, g) => n + (g.page?.hits.length ?? 0), 0)
  return (
    <div className="flex w-80 max-w-full flex-col gap-2" onKeyDown={move}>
      <Input
        autoFocus={autoFocus}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={label}
        aria-label={label}
      />
      <div
        ref={list}
        className="flex max-h-80 flex-col gap-2 overflow-y-auto"
        aria-busy={searching}
      >
        {failed && (
          <p role="alert" className="text-xs text-ink-muted">
            The search failed.{' '}
            <Button size="xs" variant="outline" onClick={() => run(query)}>
              Try again
            </Button>
          </p>
        )}
        {groups.map((group) => {
          const hits = group.page?.hits ?? []
          const groupNote = groupNotice(group)
          if (
            group.status === 'ok' &&
            hits.length === 0 &&
            !groupNote &&
            !group.page?.next
          )
            return null
          return (
            <section
              key={group.providerId}
              aria-label={group.label}
              className="flex flex-col gap-0.5"
            >
              <h4 className="px-1 text-xs font-medium text-ink-muted">
                {group.label}
              </h4>
              <ul className="flex flex-col">
                {hits.map((hit) => (
                  <li key={refKey(hit.ref)}>
                    <button
                      type="button"
                      data-option
                      onClick={() => onPick(hit)}
                      className="flex w-full flex-col items-start rounded-sm px-2 py-1 text-start hover:bg-ink/4 focus-visible:bg-ink/4 focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <span className="max-w-full truncate text-sm text-ink">
                        {hit.title}
                      </span>
                      <span className="text-xs text-ink-muted">
                        {hit.typeLabel}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {groupNote && (
                <p role="status" className="px-1 text-xs text-ink-muted">
                  {groupNote}
                </p>
              )}
              {group.status === 'ok' &&
                group.page?.next &&
                !groupComplete(group) && (
                  <div className="px-1">
                    <Button
                      size="xs"
                      variant="ghost"
                      data-option
                      onClick={() => void loadMore(group)}
                    >
                      {group.error
                        ? 'Try again'
                        : `More ${group.label.toLowerCase()}`}
                    </Button>
                  </div>
                )}
            </section>
          )
        })}
        {!searching && !failed && total === 0 && coverage === 'complete' && (
          <p className="px-1 text-xs text-ink-muted">No matches.</p>
        )}
        {notice && (
          <p role="status" className="px-1 text-xs text-ink-muted">
            {notice}
          </p>
        )}
        {searching && (
          <p role="status" className="px-1 text-xs text-ink-muted">
            Searching…
          </p>
        )}
      </div>
    </div>
  )
}
