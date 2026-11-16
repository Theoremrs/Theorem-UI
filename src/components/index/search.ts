// SOURCING: none — the Index's place as /index search params, validated without the router so the route file stays light
export type IndexSearch = {
  view?: string
  item?: string
  collection?: string
  /**
   * A record table's search text, its first sort rule (`sort`, and `desc`
   * when descending) and any further rules in `then`, as `key1:desc,key2`.
   */
  q?: string
  sort?: string
  desc?: boolean
  then?: string
}

/** A record table's view, kept with the place so Back and reload return to it. */
export type TableSearch = Pick<IndexSearch, 'q' | 'sort' | 'desc' | 'then'>

/**
 * Reads the Index's place out of a location's search, ignoring anything
 * else. The router reads an all-digit value back as a number.
 */
export function indexSearch(
  search: Readonly<Record<string, unknown>>,
): IndexSearch {
  const out: IndexSearch = {}
  for (const key of [
    'view',
    'item',
    'collection',
    'q',
    'sort',
    'then',
  ] as const) {
    const value = search[key]
    if (typeof value === 'string' && value) out[key] = value
    else if (typeof value === 'number') out[key] = String(value)
  }
  if (search.desc === true || search.desc === 'true') out.desc = true
  return out
}
