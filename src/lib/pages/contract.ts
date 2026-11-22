// SOURCING: none — the TypeScript mirror of Theorem's page wire contract
// (rustyredcore_THG/crates/theorem-surface-contracts/src/pages_api.rs, documented in
// docs/plans/user-authored-capabilities/CONTRACT.md "D. Pages"). The SDK has no client for
// /api/pages/v1 yet, so the shapes are typed here, as lib/capabilities/contract.ts types its own.
// The page document itself is lib/modules/contract.ts's PageDocument.
import type { ComponentData, PageDocument } from '@/lib/modules/contract'

export const PAGES = '/api/pages/v1'

/** One page as the vault holds it now; `revision` is the Files content hash. */
export interface PageView {
  path: string
  entryId: string
  revision: string
  page: PageDocument
}

export type PageOp =
  | { op: 'set_props'; componentId: string; props: Record<string, unknown> }
  | {
      op: 'insert'
      component: ComponentData
      parentId?: string
      zone?: string
      index: number
    }
  | { op: 'remove'; componentId: string }
  | {
      op: 'move'
      componentId: string
      parentId?: string
      zone?: string
      index: number
    }
  | { op: 'set_title'; title: string }
  | { op: 'set_pinned'; pinned: boolean }

export interface SavePageRequest {
  path: string
  /** Absent creates only: a page already at `path` is a conflict. */
  expectedRevision?: string
  page: PageDocument
}

export interface PagePatch {
  path: string
  expectedRevision: string
  ops: PageOp[]
}

export interface RestorePageRequest {
  path: string
  /** The revision to bring back. */
  revision: string
  /** The revision the page holds now. */
  expectedRevision: string
}

export type PageRevisionReason = 'saved' | 'patched' | 'restored' | 'captured'

export interface PageRevision {
  path: string
  revision: string
  /** Position in the page's history, from 1, never reused. */
  seq: number
  savedAtMs: number
  principal: string
  summary: string
  reason: PageRevisionReason
}

export interface PageHistory {
  path: string
  /** Newest first. */
  revisions: PageRevision[]
  nextCursor?: number
}

export interface PageRevisionDocument {
  revision: PageRevision
  page: PageDocument
}

export interface PageWriteReceipt {
  path: string
  entryId: string
  revision: string
  previousRevision?: string
  page: PageDocument
  history: PageRevision
}

/** Page refusal codes, as `pages_api::codes` names them. */
export const codes = {
  NOT_FOUND: 'page_not_found',
  PATH_INVALID: 'page_path_invalid',
  DOCUMENT_INVALID: 'page_document_invalid',
  TOO_LARGE: 'page_too_large',
  COMPONENT_UNKNOWN: 'page_component_unknown',
  COMPONENT_DUPLICATE: 'page_component_duplicate',
  COMPONENT_ID_IMMUTABLE: 'page_component_id_immutable',
  PATCH_INVALID: 'page_patch_invalid',
  REVISION_CONFLICT: 'page_revision_conflict',
  REVISION_NOT_FOUND: 'page_revision_not_found',
  KEY_REUSED: 'page_key_reused',
  OPERATION_FORBIDDEN: 'page_operation_forbidden',
  STORE_UNAVAILABLE: 'page_store_unavailable',
  REQUEST_INVALID: 'page_request_invalid',
} as const
