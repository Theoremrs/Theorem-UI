// SOURCING: none — typed reader for Theorem's Index workspace contract (SPEC-INDEX-WORKSPACE-1.0 in the Theorem repository) and the document filing and Atlas wire types it builds on; no library models them

export const WORKSPACE_SCHEMA = 'theorem.index.workspace/1'
export const DOCUMENT_SCHEMA = 'theorem-document/2'

export type Scope =
  { kind: 'home' } | { kind: 'collection'; collectionId: string }

export type Actor =
  | { kind: 'human'; actorId: string }
  | { kind: 'agent'; actorId: string }
  | { kind: 'engine' }
  | { kind: 'external' }

export type ItemQuery = {
  q?: string
  collectionId?: string
  kind?: string
  ids?: string[]
  sort?: 'updated' | 'title'
  limit?: number
}

export type Binding =
  | { kind: 'items'; query: ItemQuery }
  | { kind: 'collections' }
  | { kind: 'used_together'; anchorIds: string[]; limit?: number }
  | { kind: 'filing_history'; documentId: string }
  /** CRM records by Index item id (`record:<name>/<id>`), 1..50, answered in the order given. */
  | { kind: 'records'; ids: string[] }
  /** The documents filed to one record, by its Index item id; answered as items. */
  | { kind: 'record_documents'; recordItemId: string }
  | {
      kind: 'map'
      overlay?: AtlasOverlay
      cell?: number
    }

export type Operation =
  | 'open_item'
  | 'file_item'
  | 'correct_filing'
  | 'undo_correction'
  | 'ask_theorem'
  | 'pin_view'
  | 'set_preference'

export type ViewRevision = {
  revision: number
  createdAtMs: number
  author: Actor
  title: string
  purpose: string
  program: string
  bindings: Record<string, Binding>
  operations: Operation[]
  note: string
  restoredFrom?: number
  proposalId?: string
}

export type ViewOrigin = 'default' | 'user' | 'agent' | 'improver'

export type IndexView = {
  viewId: string
  scope: Scope
  origin: ViewOrigin
  pinned: boolean
  archived: boolean
  createdAtMs: number
  updatedAtMs: number
  current: ViewRevision
}

export type IndexItem = {
  documentId: string
  title: string
  documentKind: string
  revision: { position: number; contentDigest: string }
  collectionIds: string[]
  updatedPosition: number
  snippet: string
}

export type Collection = {
  collectionId: string
  name: string
  kind: 'manual' | 'auto'
  documentCount: number
}

export type FilingTier = 'precedent' | 'learned' | 'escalated'

export type FilingAttribution =
  | { kind: 'precedent'; referenceId: string }
  | { kind: 'rule'; ruleId: string }
  | { kind: 'features'; features: Record<string, number> }
  | { kind: 'model'; reason: string }
  | { kind: 'correction'; actor: Actor; correctionId?: string; undo?: boolean }

export type FilingReceipt = {
  schema: string
  receiptId: string
  documentId: string
  destinationCollectionId: string
  tier: FilingTier
  attribution: FilingAttribution
  confidence: number
  actor: Actor
  lowConfidence: boolean
  generation: number
  /** The records this filing also linked the document to; absent when it is about none. */
  recordFilings?: RecordFilingReceipt[]
}

export type CorrectionReceipt = {
  schema: string
  correctionId: string
  documentId: string
  fromCollectionId: string
  toCollectionId: string
  actor: Actor
  generation: number
  undo: boolean
}

/** Why a document is linked to a saved record. */
export type RecordFilingAttribution =
  | { kind: 'identifier'; field: string }
  | { kind: 'name_mention'; where: 'title' | 'text'; tokens: string[] }
  | { kind: 'correction'; actor: Actor }
  /** Theorem made the document (a message draft) for this record when the person approved `proposalId`. */
  | { kind: 'made'; proposalId: string }

/** A document's link to a record it is about, and why. Filing to records never changes the record. */
export type RecordFilingReceipt = {
  schema: string
  receiptId: string
  documentId: string
  /** `record:<name_singular>/<record_id>` */
  recordItemId: string
  recordId: string
  nameSingular: string
  /** The record's title when it was linked. */
  title: string
  tier: FilingTier
  attribution: RecordFilingAttribution
  confidence: number
  actor: Actor
  lowConfidence: boolean
  generation: number
}

/** A move or dismissal of a record link, or the undo of one. */
export type RecordFilingCorrection = {
  schema: string
  correctionId: string
  receiptId: string
  documentId: string
  /** Absent on the undo of a dismissal. */
  fromRecordItemId?: string | null
  /** Absent on a dismissal. */
  toRecordItemId?: string | null
  actor: Actor
  generation: number
  undo: boolean
  undone: boolean
  receipt?: RecordFilingReceipt
}

export type RecordFilingHistory = {
  schema: string
  documentId: string
  /** Every record receipt the document has carried. */
  receipts: RecordFilingReceipt[]
  /** The receipts of the links in force now. */
  links: RecordFilingReceipt[]
  corrections: RecordFilingCorrection[]
}

export type AtlasOverlay =
  'density' | 'boundary' | 'quantization_error' | 'activity'

export type AtlasState =
  | 'empty'
  | 'ready'
  | 'partial'
  | 'unavailable'
  | 'legacy_unverified'
  | 'migration_needed'

export type AtlasObject = {
  object_id: string
  kind: string
  title: string
  object_revision: string
  assignment:
    | {
        status: 'assigned'
        cell: number
        q: number
        r: number
        quantization_error: number
      }
    | { status: 'missing_embedding' }
    | { status: 'legacy_unverified' }
}

export type AtlasCell = {
  cell: number
  q: number
  r: number
  density: number
  boundary: number
  mean_quantization_error: number | null
  latest_activity_ms: number | null
  label: string | null
}

export type AtlasSnapshot = {
  schema: string
  geometry: string
  state: AtlasState
  map_id: string
  map_generation: string | null
  embedding_space_id: string | null
  record_revision: number
  total_objects: number
  assigned_objects: number
  objects: AtlasObject[]
  cells: AtlasCell[]
}

/** A CRM record as the Index names it: an item id of the form `record:<nameSingular>/<recordId>`. */
export type IndexRecord = {
  itemId: string
  recordId: string
  nameSingular: string
  /** Empty when the record has no name; show `recordId` then. */
  title: string
}

export type QueryResult =
  | { kind: 'items'; items: IndexItem[]; total: number }
  | { kind: 'collections'; collections: Collection[] }
  | {
      kind: 'used_together'
      items: (IndexItem & { sessions: number })[]
      /** Records opened alongside the anchors; absent from a server that predates records. */
      records?: (IndexRecord & { sessions: number })[]
    }
  | { kind: 'records'; records: IndexRecord[] }
  | { kind: 'filing_history'; receipts: FilingReceipt[] }
  | { kind: 'map'; snapshot: AtlasSnapshot }

export type ObservationKind =
  | 'item_opened'
  | 'search_run'
  | 'filter_applied'
  | 'presentation_changed'
  | 'view_opened'
  | 'view_left'
  | 'item_filed'
  | 'filing_corrected'
  | 'proposal_shown'
  | 'proposal_dismissed'

export type ObservationEvent = {
  kind: ObservationKind
  atMs: number
  scope: Scope
  viewId?: string
  subjects?: string[]
  detail?: Record<string, string | number | boolean>
}

export type PreferenceStatement =
  'keep_view' | 'prefer_presentation' | 'belong_together' | 'not_together'

export type Preference = {
  preferenceId: string
  scope: Scope
  statement: PreferenceStatement
  viewId?: string
  subjects?: string[]
  value?: string
  note?: string
  createdAtMs: number
}

export type Interpretation = {
  interpretationId: string
  key: string
  kind:
    | 'used_together'
    | 'recurring_query'
    | 'presentation_preference'
    | 'poorly_fit'
  scope: Scope
  subjects: string[]
  detail: Record<string, string | number>
  support: number
  observationIds: string[]
  createdAtMs: number
  updatedAtMs: number
}

export type ProposalStatus =
  'proposed' | 'applied' | 'accepted' | 'dismissed' | 'superseded' | 'invalid'

export type ViewCandidate = Omit<
  ViewRevision,
  'revision' | 'createdAtMs' | 'author'
>

export type Proposal = {
  proposalId: string
  scope: Scope
  interpretationId: string
  hypothesis: string
  kind: 'new_view' | 'revise_view'
  targetViewId?: string
  candidate: ViewCandidate
  composedBy: string
  validation: {
    bindings: { ok: boolean; detail: string; covered: number; expected: number }
    lint: { ok: boolean; detail: string }
    client?: { ok: boolean; detail: string; checkedAtMs: number }
  }
  admission: 'auto' | 'review'
  status: ProposalStatus
  resultViewId?: string
  createdAtMs: number
  resolvedAtMs?: number
}

export type IndexPolicy = {
  autoApply: { newViews: boolean; reviseImproverViews: boolean }
  budget: { passesPerHour: number; modelCallsPerDay: number }
}

export type PublishedLibrary = {
  libraryId: string
  version: string
  digest: string
  components: string[]
  callables: string[]
}

export const scopeKey = (scope: Scope) =>
  scope.kind === 'home' ? 'home' : `collection:${scope.collectionId}`

export const sameScope = (a: Scope, b: Scope) => scopeKey(a) === scopeKey(b)

/** Query-string form of a scope, as the list routes take it. */
export const scopeParams = (scope: Scope): Record<string, string> =>
  scope.kind === 'home'
    ? { scope: 'home' }
    : { collectionId: scope.collectionId }
