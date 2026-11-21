import { codeOf, statusOf } from '../environment/result'

export type LayoutOperation = 'restore' | 'save'

export type LayoutDiagnostic = {
  route: string
  workspaceId: string
  requestId: string
  httpStatus?: number
  contentType?: string
  problemCode?: string
  correlationId?: string
}

export type LayoutStatus =
  | { kind: 'pending'; operation: LayoutOperation }
  | { kind: 'account'; revision: number }
  | { kind: 'device'; diagnostic: LayoutDiagnostic }
  | {
      kind: 'failed'
      operation: LayoutOperation
      recovery: 'restore' | 'save' | 'check'
      diagnostic: LayoutDiagnostic
    }

/** Only retain bounded, non-secret fields from an SDK response. */
export function layoutDiagnostic(
  workspaceId: string,
  requestId: string,
  error?: unknown,
): LayoutDiagnostic {
  const info = error as
    | {
        rawResponse?: { headers?: Headers }
        body?: { correlationId?: unknown }
        requestId?: unknown
      }
    | undefined
  const token = (value: unknown) =>
    typeof value === 'string' && /^[\w./+;= -]{1,120}$/u.test(value)
      ? value
      : undefined
  return {
    route: `/api/workbench/v1/${encodeURIComponent(workspaceId)}`,
    workspaceId,
    requestId,
    httpStatus: statusOf(error),
    contentType: token(info?.rawResponse?.headers?.get('content-type')),
    problemCode: token(codeOf(error)),
    correlationId: token(info?.body?.correlationId) ?? token(info?.requestId),
  }
}
