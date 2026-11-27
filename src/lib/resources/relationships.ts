// SOURCING: none. The relationship kinds are the spec's LINK-04 table. Each kind keeps its own meaning: no function here turns one into another.

/**
 * What a connection means. A mention of a task is not a blocker; an embedded
 * result is not an execution dependency; a suggestion is not accepted until
 * the acceptance action makes it an accepted association.
 */
export const RELATIONSHIP_KINDS = [
  'authored-mention',
  'authored-link',
  'embed',
  'explicit-relation',
  'suggested',
  'accepted-association',
  'citation',
  'operational-dependency',
] as const
export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number]

export const RELATIONSHIP_LABEL: Record<RelationshipKind, string> = {
  'authored-mention': 'Mentioned',
  'authored-link': 'Linked',
  embed: 'Embedded',
  'explicit-relation': 'Related by field',
  suggested: 'Suggested',
  'accepted-association': 'Accepted association',
  citation: 'Cited',
  'operational-dependency': 'Depends on',
}

export const RELATIONSHIP_DESCRIPTION: Record<RelationshipKind, string> = {
  'authored-mention': 'Someone wrote a mention of it in content.',
  'authored-link': 'Someone wrote a link to it in content.',
  embed: 'Content embeds it as a view.',
  'explicit-relation': 'A schema field records the relation.',
  suggested:
    'An inference with evidence. It stays a suggestion until accepted.',
  'accepted-association': 'A person or rule accepted the association.',
  citation: 'Evidence for a claim, extraction, result or revision.',
  'operational-dependency':
    'Execution or work ordering, blocking or production.',
}

export const isRelationshipKind = (value: unknown): value is RelationshipKind =>
  (RELATIONSHIP_KINDS as readonly unknown[]).includes(value)

/** The Files API's link kinds, each mapped to the meaning it already has. */
export function relationshipOfFileLink(
  kind: 'wikilink' | 'markdown' | 'embed' | 'related',
): RelationshipKind {
  switch (kind) {
    case 'wikilink':
    case 'markdown':
      return 'authored-link'
    case 'embed':
      return 'embed'
    case 'related':
      // An accepted Theorem link suggestion that is not in the text.
      return 'accepted-association'
  }
}

/** The kinds a filter keeps; no selection keeps every kind. */
export const filterByRelationship = <
  T extends { relationship: RelationshipKind },
>(
  items: readonly T[],
  selected: ReadonlySet<RelationshipKind>,
): T[] =>
  selected.size === 0
    ? [...items]
    : items.filter((one) => selected.has(one.relationship))
