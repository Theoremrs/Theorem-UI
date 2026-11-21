// SOURCING: none — the model catalog's own search and order rules, kept pure: contiguous matching per field (the shared engine's fuzzy rankItem accepts subsequence letters across a canonical ref), natural name order with vendor/ref tie-breakers, and deliberate page resets.

/** The fields a query reads, each matched on its own. */
export type ModelSearchFields = {
  name: string
  ref: string
  vendor: string
}

/**
 * Whether the query occurs as contiguous text in the display name, the
 * canonical ref, or the vendor, case-insensitively, with outer whitespace
 * trimmed. An empty query keeps every model. No character-subsequence
 * matching: "muse" must not find its letters scattered across a long ref.
 */
export function matchesModelQuery(
  model: ModelSearchFields,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [model.name, model.ref, model.vendor].some((field) =>
    field.toLowerCase().includes(needle),
  )
}

const natural = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/**
 * Natural A-Z on the visible display name alone ("Model 2" before "Model 10",
 * "Muse Spark 1.3" before "Muse Spark 1.3 Contributor"). Vendor, then the
 * canonical ref, break ties only between identical names, so duplicate names
 * keep a stable, distinguishable order.
 */
export function compareModelNames(
  first: ModelSearchFields,
  second: ModelSearchFields,
): number {
  return (
    natural.compare(first.name, second.name) ||
    natural.compare(first.vendor, second.vendor) ||
    natural.compare(first.ref, second.ref)
  )
}

/** A query or column-filter change always returns to the first page. */
export function pageIndexAfterFilters(): number {
  return 0
}

/**
 * The Model column's own filter. The shared dynamic filter hands the raw
 * filter value to case-folding comparators that expect a resolved
 * (lowercased) one, so a mixed-case column value never matches; this reads
 * the column's filters with the same operators and joins, comparing both
 * sides case-insensitively.
 */
export function matchesModelTextFilter(
  value: string,
  filters: ReadonlyArray<{
    value: unknown
    operator?: string
    joinOperator?: string
  }>,
): boolean {
  const text = value.toLowerCase()
  const join = filters[0]?.joinOperator ?? 'and'
  const matched = filters.reduce<boolean | undefined>((pass, filter) => {
    const needle = String(filter.value ?? '').toLowerCase()
    if (
      !needle &&
      filter.operator !== 'isEmpty' &&
      filter.operator !== 'isNotEmpty'
    )
      return pass
    let result: boolean
    switch (filter.operator ?? 'includesString') {
      case 'notIncludesString':
        result = !text.includes(needle)
        break
      case 'equalsString':
        result = text === needle
        break
      case 'notEqualsString':
        result = text !== needle
        break
      case 'startsWith':
        result = text.startsWith(needle)
        break
      case 'endsWith':
        result = text.endsWith(needle)
        break
      case 'isEmpty':
        result = text === ''
        break
      case 'isNotEmpty':
        result = text !== ''
        break
      default:
        result = text.includes(needle)
        break
    }
    if (pass === undefined) return result
    return join === 'and' ? pass && result : pass || result
  }, undefined)
  return matched ?? true
}

/**
 * The page to hold after the catalog itself changes: the same page while it
 * still exists, the last page when the list shrank under it, page one when
 * nothing is left.
 */
export function pageIndexForRows(
  pageIndex: number,
  rowCount: number,
  pageSize: number,
): number {
  const pageCount = Math.ceil(rowCount / pageSize)
  return Math.max(0, Math.min(pageIndex, pageCount - 1))
}
