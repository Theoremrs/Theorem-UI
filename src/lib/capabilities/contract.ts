// SOURCING: none — wire types mirrored by hand from Theorem's contract owner
// (rustyredcore_THG/crates/theorem-surface-contracts/src/capabilities_api.rs), which pins them for
// /api/capabilities/v1, the `theorem-user-capabilities` crate and the native agent operations.
// The mirror follows how components/records/contract.ts mirrors the schema register: one file that
// names the wire, no library models it.
//
// The wire is camelCase throughout; enum discriminants are snake_case, as the Rust tags name them.
// Every input is strict server-side (`deny_unknown_fields`), so nothing here invents a field, and a
// field the Rust omits when absent is optional here and left out of the body rather than sent as
// null.

// / The schema id of a capability definition document.
export const CAPABILITY_SCHEMA = 'theorem.capability/1'

// / Default and maximum page size for a bounded query, matching the work tracker's bounds.
export const QUERY_LIMIT_DEFAULT = 50
export const QUERY_LIMIT_MAX = 200

// ── Field vocabulary ────────────────────────────────────────────────────────

/**
 * What a capability declares for action inputs and new fields. It maps onto the
 * schema register's vocabulary at execution; the register stays the storage authority.
 */
export type CapabilityFieldType =
  | { kind: 'text' }
  | { kind: 'number' }
  | { kind: 'integer' }
  | { kind: 'boolean' }
  | { kind: 'date' }
  | { kind: 'timestamp' }
  | { kind: 'enum'; variants: string[] }
  /** A reference to records of another collection in the same capability. */
  | { kind: 'reference'; collectionKey: string }

/**
 * One field of a collection as the schema register actually holds it. The same
 * kinds as the register's mirror in components/records/contract.ts, in the camelCase
 * this contract names them, so a describe answer never pretends a field is simpler.
 */
export type ResolvedFieldType =
  | { kind: 'text' }
  | { kind: 'long_text' }
  | { kind: 'integer' }
  | { kind: 'number' }
  | { kind: 'boolean' }
  | { kind: 'timestamp' }
  | { kind: 'date' }
  | { kind: 'uuid' }
  | { kind: 'json' }
  | { kind: 'enum'; variants: string[] }
  | { kind: 'enum_many'; variants: string[] }
  | { kind: 'vector'; dim: number }
  | { kind: 'geometry' }
  | {
      kind: 'relation'
      targetObjectTypeId: string
      cardinality: ResolvedCardinality
    }

export type ResolvedCardinality = 'one' | 'many'

// ── Filters ─────────────────────────────────────────────────────────────────

/**
 * A typed predicate tree over stable field keys. A view filter is a query shape,
 * never access control: grants are enforced separately.
 */
export type QueryFilter =
  | { op: 'and'; conditions: QueryFilter[] }
  | { op: 'or'; conditions: QueryFilter[] }
  | { op: 'not'; condition: QueryFilter }
  | { op: 'eq'; fieldKey: string; value: unknown }
  | { op: 'ne'; fieldKey: string; value: unknown }
  | { op: 'in'; fieldKey: string; values: unknown[] }
  | { op: 'lt'; fieldKey: string; value: unknown }
  | { op: 'lte'; fieldKey: string; value: unknown }
  | { op: 'gt'; fieldKey: string; value: unknown }
  | { op: 'gte'; fieldKey: string; value: unknown }
  | { op: 'contains'; fieldKey: string; value: string }
  | { op: 'is_empty'; fieldKey: string }
  | { op: 'is_not_empty'; fieldKey: string }

/** A filter that admits every record. */
export const matchAll = (): QueryFilter => ({ op: 'and', conditions: [] })

// ── Definition ──────────────────────────────────────────────────────────────

/** Optional semantic roles, so a general agent can work with a collection without standard names. */
export type SemanticRoles = {
  statusField?: string
  completionField?: string
  targetDateField?: string
}

/**
 * One allowed lifecycle transition. Every write path that changes the lifecycle
 * field enforces this rule, declared actions and generic updates alike.
 */
export type LifecycleTransition = { from: string[]; to: string }

export type CollectionLifecycle = {
  fieldKey: string
  /**
   * The values a create may write. Present means governed: a capability action
   * that creates a record must write this field to one of these values, and an
   * empty list means no create may write it. Absent means ungoverned: any value
   * the field's declared type holds is allowed, because there is no current
   * value to move from. An empty list is a declaration, not an omission — which
   * is why this is `string[] | undefined` and never a default of `[]`.
   */
  initial?: string[]
  transitions: LifecycleTransition[]
}

/** A collection references a schema-register ObjectType; it never copies its records. */
export type CollectionSpec = {
  key: string
  objectTypeId: string
  label: string
  semanticRoles?: SemanticRoles
  lifecycle?: CollectionLifecycle
}

export type ViewLayout = 'list' | 'table' | 'board'
export type SortDirection = 'asc' | 'desc'

export type OrderBy = { fieldKey: string; direction: SortDirection }

/** A saved query over one collection. Two views over one collection present the same records. */
export type ViewSpec = {
  key: string
  label: string
  collectionKey: string
  filter: QueryFilter
  orderBy?: OrderBy
  displayFields?: string[]
  layout: ViewLayout
}

export type InputField = {
  key: string
  fieldType: CapabilityFieldType
  required: boolean
}

/** Where an action's field effect takes its value. */
export type EffectSource =
  | { source: 'literal'; value: unknown }
  | { source: 'input'; key: string }
  | { source: 'now' }

export type FieldEffect = { fieldKey: string } & EffectSource

/**
 * A typed, validated operation. A UI click, an agent invocation and (later) a
 * rule all execute this same declaration through the same executor.
 */
export type ActionSpec = {
  key: string
  label: string
  collectionKey: string
  /** True creates a record; false updates the named record. */
  creates: boolean
  input: InputField[]
  /** Preconditions over the current record (update actions only). */
  preconditions: QueryFilter[]
  effects: FieldEffect[]
  /** Slice 2: a registered WASM module computes the effects; absent on every slice-1 action. */
  implementation?: ActionImplementation
}

export type AgentMetadata = { discoverable: boolean; description: string }

/** The reusable design: schemas by reference, views, actions, agent metadata. Content-addressed. */
export type CapabilityDefinition = {
  capabilityId: string
  name: string
  purpose: string
  collections: CollectionSpec[]
  views: ViewSpec[]
  actions: ActionSpec[]
  agent: AgentMetadata
  /** Slice 2: event and schedule rules; omitted when empty so slice-1 ids do not move. */
  rules?: RuleSpec[]
}

// ── Instance and grants ─────────────────────────────────────────────────────

/**
 * One principal's permissions on an instance. Use and authoring are separate:
 * `invoke` never implies `author`, and `author` is required to change grants.
 */
export type Grant = {
  principal: string
  read: boolean
  /** Action keys, or `["*"]` for every action. */
  invoke: string[]
  author: boolean
}

export type CapabilityInstance = {
  instanceId: string
  capabilityId: string
  /** The pinned definition content id this instance operates under. */
  definitionId: string
  workspaceId?: string
  config: Record<string, unknown>
  grants: Grant[]
  ownerPrincipal: string
  createdAtMs: number
  /** Slice 2: which rules are switched on, and whom each runs as; omitted when empty. */
  rules?: Record<string, RuleEnablement>
}

// ── Authoring ───────────────────────────────────────────────────────────────

/**
 * Create a capability: declare any missing collection types in the schema
 * register, store the definition, bind a fresh instance. `declareTypes` carries
 * schema-register ObjectTypeInput JSON, validated by the register itself.
 */
export type CreateInstanceRequest = {
  definition: CapabilityDefinition
  instanceId: string
  workspaceId?: string
  declareTypes?: unknown[]
}

export type AuthorResult = {
  definitionId: string
  instance: CapabilityInstance
}

/** Re-pin an instance to an earlier definition version: views and actions, never records. */
export type RepinRequest = { definitionId: string }

/** A new field declared through the authoring path. Additive only in slice 1. */
export type FieldSpecInput = {
  key: string
  label: string
  fieldType: CapabilityFieldType
  required: boolean
}

/**
 * One targeted change to a definition, tagged by `op`. The Rust names each op as
 * a newtype over its own strict struct; on the wire the struct's fields sit
 * beside the tag, so the TypeScript is flat.
 */
export type PatchOp =
  | { op: 'add_field'; collectionKey: string; field: FieldSpecInput }
  | {
      op: 'rename_field'
      collectionKey: string
      fieldKey: string
      label: string
    }
  | { op: 'set_view_filter'; viewKey: string; filter: QueryFilter }
  | { op: 'add_view'; view: ViewSpec }
  | { op: 'add_action'; action: ActionSpec }
  | { op: 'set_purpose'; purpose: string }
  /** Instance-level grant replacement; requires author authority. */
  | { op: 'set_grants'; grants: Grant[] }
  | RulePatchOp

export type DefinitionPatch = {
  /** The definition id the patch was authored against; a stale base is refused. */
  expectedDefinitionId: string
  ops: PatchOp[]
}

// ── Query ───────────────────────────────────────────────────────────────────

export type AdHocQuery = {
  collectionKey: string
  filter: QueryFilter
  orderBy?: OrderBy
  displayFields?: string[]
}

/** Exactly one of `viewKey` or `query` must be present. */
export type QueryRequest = {
  instanceId: string
  viewKey?: string
  query?: AdHocQuery
  cursor?: string
  limit?: number
}

/**
 * One authoritative record as the schema register holds it: values by stable
 * field key, outgoing relation ids by edge type, and the revision a write must
 * name to avoid a conflict.
 */
export type CapabilityRecordRow = {
  id: string
  fields: Record<string, unknown>
  revision: number
  links?: Record<string, string[]>
}

export type QueryResult = {
  records: CapabilityRecordRow[]
  nextCursor?: string
  total: number
  /** Whether a filter narrowed the collection: visible rows are not the whole collection. */
  filtered: boolean
  /** Whether the page cut the result short. */
  truncated: boolean
  definitionId: string
}

// ── Invocation ──────────────────────────────────────────────────────────────

export type InvokeRequest = {
  instanceId: string
  actionKey: string
  /** Caller-chosen idempotency key, unique per intended call. */
  invocationKey: string
  recordId?: string
  expectedRevision?: number
  inputs: Record<string, unknown>
}

export type AffectedRecord = { id: string; revision: number }

export type InvocationOutcome =
  | {
      outcome: 'completed'
      affected: AffectedRecord[]
      /** The resulting field values of the affected record. */
      fields: Record<string, unknown>
    }
  | { outcome: 'failed'; code: string; message: string }

/**
 * The journal record of one invocation: reserved before dispatch, finished
 * conditionally, replayed exactly, never silently redispatched.
 */
export type InvocationStatus =
  | { status: 'dispatched' }
  | { status: 'finished'; outcome: InvocationOutcome; finishedAtMs: number }

export type InvocationReceipt = {
  /** Journal id: `capop:{hash(instance, action, invocation_key)}`. */
  recordId: string
  invocationKey: string
  instanceId: string
  actionKey: string
  definitionId: string
  requestDigest: string
  startedAtMs: number
  /** Slice 2: the rule run that dispatched it; absent when a person or agent did. */
  cause?: InvocationCause
} & InvocationStatus

// ── Discovery and description ───────────────────────────────────────────────

export type DiscoverEntry = {
  instanceId: string
  capabilityId: string
  name: string
  purpose: string
  collectionLabels: string[]
  definitionId: string
}

export type DiscoverResult = { instances: DiscoverEntry[] }

/** A collection's fields as the register holds them, for describe answers. */
export type ResolvedField = {
  key: string
  label: string
  fieldType: ResolvedFieldType
  required: boolean
  description?: string
}

export type CollectionSchema = {
  collectionKey: string
  objectTypeId: string
  label: string
  fields: ResolvedField[]
}

export type DescribeResult = {
  definition: CapabilityDefinition
  /** The caller's own effective permissions; other principals' grants are never disclosed. */
  callerGrant: Grant
  collectionSchemas: CollectionSchema[]
  /** Slice 2: rule toggles by rule key; omitted when no rule was ever switched. */
  ruleStates?: Record<string, RuleState>
}

// ── Refusals ────────────────────────────────────────────────────────────────

/** Stable problem codes. The server renders them as `application/problem+json` with `code`. */
export const codes = {
  NOT_FOUND: 'capability_not_found',
  GRANT_DENIED: 'capability_grant_denied',
  AUTHOR_DENIED: 'capability_author_denied',
  DEFINITION_CONFLICT: 'capability_definition_conflict',
  SCHEMA_CHANGE_UNSUPPORTED: 'capability_schema_change_unsupported',
  ACTION_UNKNOWN: 'capability_action_unknown',
  INPUT_INVALID: 'capability_input_invalid',
  PRECONDITION_FAILED: 'capability_precondition_failed',
  TRANSITION_DENIED: 'capability_transition_denied',
  RECORD_NOT_FOUND: 'capability_record_not_found',
  REVISION_CONFLICT: 'capability_revision_conflict',
  KEY_REUSED: 'invocation_key_reused',
  EFFECT_UNKNOWN: 'invocation_effect_unknown',
  VIEW_UNKNOWN: 'capability_view_unknown',
  COLLECTION_UNKNOWN: 'capability_collection_unknown',
  DEFINITION_INVALID: 'capability_definition_invalid',
  INSTANCE_EXISTS: 'capability_instance_exists',
} as const

// ── slice 2: rules, runs, modules ───────────────────────────────────────────
//
// Mirrored from the plan's pinned design (docs/plans/user-authored-capabilities/README.md,
// "Slice 2: Phases 2-4 pinned design") as the contract owner lands it. Every field added to a
// hashed slice-1 type above is optional and omitted when empty, so a slice-1 definition hashes to
// the same content id.

/** The shortest interval a schedule rule may run at, in minutes. */
export const SCHEDULE_MINUTES_MIN = 5

/** What starts a rule, tagged by `kind`. Absent optional filters mean any. */
export type RuleTrigger =
  | { kind: 'record_created'; collectionKey: string }
  | { kind: 'record_updated'; collectionKey: string; fieldKeys?: string[] }
  | { kind: 'transition'; collectionKey: string; to: string; from?: string[] }
  | { kind: 'schedule'; intervalMinutes: number; startAtMs?: number }

/** Where one action input comes from when a rule dispatches it, tagged by `source`. */
export type RuleInputSource =
  | { source: 'literal'; value: unknown }
  | { source: 'trigger_field'; fieldKey: string }
  | { source: 'now' }

/** One rule: a trigger, the action it invokes, and that action's inputs by key. */
export type RuleSpec = {
  key: string
  label: string
  trigger: RuleTrigger
  actionKey: string
  inputs: Record<string, RuleInputSource>
}

/** An instance's record that a rule is switched on or off, and whose authority it runs under. */
export type RuleEnablement = {
  enabled: boolean
  runAs: string
  changedAtMs: number
}

/** What describe tells a caller about one rule; `runAs` only for an author or that principal. */
export type RuleState = {
  enabled: boolean
  changedAtMs: number
  runAs?: string
}

export type RulePatchOp =
  | { op: 'add_rule'; rule: RuleSpec }
  | { op: 'replace_rule'; rule: RuleSpec }
  | { op: 'remove_rule'; ruleKey: string }
  /** Instance-level; needs author authority, or the caller's own `background` grant. */
  | { op: 'set_rule_enabled'; ruleKey: string; enabled: boolean }

/** What put a run in the queue, tagged by `kind`. */
export type RunTrigger =
  | { kind: 'event'; journalId: string; recordId: string }
  | { kind: 'schedule'; slot: number; slotStartMs: number }
  | { kind: 'manual'; invocationKey: string }

/** The rule chain a run descends from; a repeat or a depth past the limit is a loop. */
export type RunCause = { depth: number; chain: string[] }

export type RunStatus =
  | { status: 'pending' }
  | { status: 'leased'; leaseExpiresAtMs: number }
  | { status: 'succeeded' }
  | { status: 'failed'; code: string; message: string }
  | { status: 'dead'; code: string; message: string }
  | { status: 'skipped'; code: string; message: string }

export type RunAttempt = {
  attempt: number
  invocationKey: string
  journalId: string
  startedAtMs: number
  finishedAtMs?: number
  outcomeCode?: string
}

/** One durable run of one rule. Its status sits flat beside its fields, as a receipt's does. */
export type RuleRun = {
  runId: string
  instanceId: string
  ruleKey: string
  definitionId: string
  trigger: RunTrigger
  runAs: string
  cause: RunCause
  attempts: RunAttempt[]
  nextAttemptAtMs: number
  createdAtMs: number
  finishedAtMs?: number
} & RunStatus

export type RuleRunListQuery = {
  ruleKey?: string
  cursor?: string
  limit?: number
}

export type RuleRunList = { runs: RuleRun[]; nextCursor?: string }

/** A manual run; a blank or absent key adopts the `Idempotency-Key` header, as invoke does. */
export type RunRuleRequest = { invocationKey?: string }

export type InvocationCause = { ruleKey: string; runId: string; depth: number }

export type ModuleSource =
  { kind: 'wat'; text: string } | { kind: 'wasm_base64'; bytes: string }

/** A content-addressed WASM module in the library (`capmod:`). */
export type CapabilityModule = {
  moduleId: string
  language: 'wasm'
  source: ModuleSource
  exports: string[]
}

export type RegisterModuleRequest = { source: ModuleSource; exports: string[] }

export type RegisterModuleResult = { moduleId: string }

/** Names the module export that computes an action's effects, and the fields it may write. */
export type ActionImplementation = {
  moduleId: string
  export: string
  writes: string[]
}

/** Slice-2 problem codes, beside `codes`. */
export const ruleCodes = {
  MODULE_NOT_FOUND: 'capability_module_not_found',
  MODULE_FAILED: 'capability_module_failed',
  RULE_UNKNOWN: 'capability_rule_unknown',
  RULE_LOOP: 'capability_rule_loop',
  BACKGROUND_DENIED: 'capability_background_denied',
  RUN_NOT_FOUND: 'capability_run_not_found',
  RUN_NOT_RETRYABLE: 'capability_run_not_retryable',
} as const
