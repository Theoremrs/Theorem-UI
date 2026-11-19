// SOURCING: none — a record table's sort rules and how the address holds them: the first rule in `sort` and `desc` (as the address has always held one sort), further rules in `then` as `key1:desc,key2`
/** One sort rule: a field and the way it runs. */
export type Sort = { key: string; descending: boolean }

// A key that holds a comma or a colon cannot be written in `then`, so it is
// neither read from it nor written to it.
const writable = (key: string) =>
  key !== '' && !key.includes(',') && !key.includes(':')

/** The same rules with a field's later rule dropped, so no field sorts twice. */
export function distinctSorts(sorts: readonly Sort[]): Sort[] {
  const seen = new Set<string>()
  return sorts.filter((rule) => !seen.has(rule.key) && !!seen.add(rule.key))
}

/** Reads the address's `then`; an entry that is not `key` or `key:desc` is skipped. */
export function parseThen(then: string | undefined): Sort[] {
  if (!then) return []
  const rules: Sort[] = []
  for (const entry of then.split(',')) {
    const [key, direction, extra] = entry.split(':')
    if (extra !== undefined || !key || !writable(key)) continue
    if (direction !== undefined && direction !== 'desc') continue
    rules.push({ key, descending: direction === 'desc' })
  }
  return rules
}

/** The rules as the address holds them. */
export function sortsFromAddress(address: {
  sort?: string
  desc?: boolean
  then?: string
}): Sort[] {
  const first: Sort[] = address.sort
    ? [{ key: address.sort, descending: address.desc === true }]
    : []
  return distinctSorts([...first, ...parseThen(address.then)])
}

/** The address's `sort`, `desc` and `then` for the rules; unset ones are undefined. */
export function sortsToAddress(sorts: readonly Sort[]): {
  sort: string | undefined
  desc: true | undefined
  then: string | undefined
} {
  const [first, ...rest] = distinctSorts(sorts)
  const then = rest
    .filter((rule) => writable(rule.key))
    .map((rule) => (rule.descending ? `${rule.key}:desc` : rule.key))
    .join(',')
  return {
    sort: first?.key,
    desc: first?.descending ? true : undefined,
    then: then || undefined,
  }
}

/**
 * The rules as one string, to compare with what the address holds. The
 * separator is a character a field key cannot hold.
 */
export const sortsToText = (sorts: readonly Sort[]) =>
  sorts
    .map((rule) => `${rule.descending ? '-' : '+'}${rule.key}`)
    .join('\u0000')
export const sortsFromText = (text: string): Sort[] =>
  text
    ? text.split('\u0000').map((entry) => ({
        key: entry.slice(1),
        descending: entry.startsWith('-'),
      }))
    : []
