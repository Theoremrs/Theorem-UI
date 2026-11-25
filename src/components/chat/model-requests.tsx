// SOURCING: the native chat capture endpoint (lib/theorem/model-requests),
// TanStack Query for lazy reads, and the existing conversation/settings tokens.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { describeError, hasStatus } from '@/lib/theorem/client'
import {
  captureBytes,
  capturedJson,
  modelRequestQuery,
  modelRequestsQuery,
  requestSections,
} from '@/lib/theorem/model-requests'
import type {
  ModelRequestDetail,
  RequestSection,
} from '@/lib/theorem/model-requests'

const disclosure =
  'cursor-pointer rounded-sm py-1 text-sm text-ink outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
const code =
  'max-h-96 overflow-auto rounded-md bg-surface-neutral/50 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words select-text'

/** Mounted only when the person opens Details; bodies are fetched on selection. */
export function ModelRequests({ runId }: { runId: string }) {
  const query = useInfiniteQuery(modelRequestsQuery(runId))
  const [selected, setSelected] = useState<string>()
  const pages = query.data?.pages ?? []
  const requests = [
    ...new Map(
      pages
        .flatMap((page) => page.requests)
        .map((request) => [request.requestId, request]),
    ).values(),
  ]
  const status = pages[0]
  return (
    <section
      aria-label="Model requests"
      className="mt-3 border-t border-separator pt-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-ink">Model requests</h3>
        <Button
          variant="ghost"
          size="xs"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh requests
        </Button>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        Captured before sending. Provider receipt is not recorded here.
      </p>
      {query.error && (
        <CaptureError error={query.error} retry={() => void query.refetch()} />
      )}
      {query.isPending && (
        <p role="status" className="py-2 text-sm text-ink-muted">
          Reading request captures…
        </p>
      )}
      {status && requests.length === 0 && (
        <p role="status" className="py-2 text-sm text-ink-muted">
          {status.notRecordedReason ??
            (status.terminal
              ? 'No model request capture was recorded for this turn. Earlier requests cannot be reconstructed from its tool summaries.'
              : 'No model request has been captured yet. This list updates while the turn runs.')}
        </p>
      )}
      {requests.length > 0 && (
        <ol className="mt-2 divide-y divide-separator">
          {requests.map((request, index) => {
            const open = selected === request.requestId
            return (
              <li key={request.requestId}>
                <button
                  type="button"
                  aria-expanded={open}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 rounded-sm px-1 py-2 text-start text-sm outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                  onClick={() =>
                    setSelected(open ? undefined : request.requestId)
                  }
                >
                  <span className="font-medium text-ink">
                    Request {index + 1}
                  </span>
                  <span className="min-w-0 break-words text-ink-muted">
                    {request.provider} · {request.model}
                  </span>
                  <span className="ms-auto text-xs text-ink-muted tabular-nums">
                    {captureBytes(request.bodyBytes)}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {request.completeness === 'redacted' ||
                    request.exclusions.length > 0
                      ? 'Exclusions recorded'
                      : 'Complete body'}
                  </span>
                </button>
                {open && (
                  <RequestDetail runId={runId} requestId={request.requestId} />
                )}
              </li>
            )
          })}
        </ol>
      )}
      {query.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage
            ? 'Reading more requests…'
            : 'Load more requests'}
        </Button>
      )}
    </section>
  )
}

function CaptureError({ error, retry }: { error: unknown; retry: () => void }) {
  const message = hasStatus(error, 401)
    ? 'Sign in to read this turn’s request captures.'
    : hasStatus(error, 403)
      ? 'This identity cannot read this turn’s request captures.'
      : hasStatus(error, 404)
        ? 'Request inspection is unavailable for this turn or this server version.'
        : describeError(error)
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 py-2 text-sm text-ink-muted"
    >
      <p>{message}</p>
      <Button variant="ghost" size="xs" onClick={retry}>
        Try again
      </Button>
    </div>
  )
}

function RequestDetail({
  runId,
  requestId,
}: {
  runId: string
  requestId: string
}) {
  const query = useQuery(modelRequestQuery(runId, requestId))
  if (query.error)
    return (
      <CaptureError error={query.error} retry={() => void query.refetch()} />
    )
  if (!query.data)
    return (
      <p role="status" className="py-2 text-sm text-ink-muted">
        Reading this request…
      </p>
    )
  return <CapturedRequest detail={query.data} />
}

/** The capture is rendered as text only, including content authored by tools. */
export function CapturedRequest({ detail }: { detail: ModelRequestDetail }) {
  const { request, body } = detail
  const [copyStatus, setCopyStatus] = useState<string>()
  const json = capturedJson(body)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json)
      setCopyStatus('Copied captured JSON')
    } catch {
      setCopyStatus('Copy was unavailable. You can download the captured JSON.')
    }
  }
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([json], { type: 'application/json' }),
    )
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `model-request-${request.requestId.replace(/[^a-zA-Z0-9._-]/g, '-')}.json`
    document.body.append(anchor)
    anchor.click()
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return (
    <div className="space-y-3 px-1 pb-3" data-slot="captured-model-request">
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-xs">
        <dt className="text-ink-muted">Captured</dt>
        <dd>{new Date(request.capturedAtMs).toLocaleString()}</dd>
        <dt className="text-ink-muted">Event position</dt>
        <dd className="tabular-nums">{request.sequence}</dd>
        <dt className="text-ink-muted">Request body</dt>
        <dd>
          {captureBytes(request.bodyBytes)} original ·{' '}
          {captureBytes(request.capturedBytes)} captured
        </dd>
        <dt className="text-ink-muted">Contents</dt>
        <dd>
          {request.messageCount} messages · {request.toolCount} tool
          declarations
        </dd>
        <dt className="text-ink-muted">Original body hash</dt>
        <dd className="min-w-0 break-all font-mono select-all">
          {request.bodyHash}
        </dd>
      </dl>
      {(request.completeness === 'redacted' ||
        request.exclusions.length > 0) && (
        <div className="text-xs text-ink-muted">
          <p className="font-medium">Excluded from this capture</p>
          {request.exclusions.length ? (
            <ul className="mt-1 space-y-1">
              {request.exclusions.map((item, index) => (
                <li key={`${item.path}:${index}`}>
                  <span className="break-all font-mono">{item.path}</span> —{' '}
                  {item.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p>
              The record marks this body as incomplete without listing its
              exclusions.
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="xs" onClick={() => void copy()}>
          Copy captured JSON
        </Button>
        <Button variant="outline" size="xs" onClick={download}>
          Download captured JSON
        </Button>
        {copyStatus && (
          <span role="status" className="text-xs text-ink-muted">
            {copyStatus}
          </span>
        )}
      </div>
      <div className="divide-y divide-separator/60">
        {requestSections(body).map((section) => (
          <Section key={section.name} section={section} />
        ))}
        <Disclosure title="Captured JSON">
          <pre className={code}>{json}</pre>
        </Disclosure>
      </div>
    </div>
  )
}

function Section({ section }: { section: RequestSection }) {
  const { value, kind } = section
  const items = Array.isArray(value) ? value : []
  return (
    <Disclosure
      title={`${section.name}${kind === 'messages' || kind === 'tools' ? ` (${items.length})` : ''}`}
    >
      {kind === 'messages' || kind === 'tools' ? (
        <ol className="space-y-1 ps-3">
          {items.map((item, index) => {
            const record =
              typeof item === 'object' && item !== null
                ? (item as Record<string, unknown>)
                : {}
            const fn =
              typeof record.function === 'object' && record.function !== null
                ? (record.function as Record<string, unknown>)
                : {}
            const label =
              kind === 'messages'
                ? typeof record.role === 'string'
                  ? record.role
                  : 'message'
                : typeof fn.name === 'string'
                  ? fn.name
                  : typeof record.name === 'string'
                    ? record.name
                    : 'tool'
            return (
              <li key={index}>
                <Disclosure title={`${index + 1}. ${label}`}>
                  {kind === 'messages' && typeof record.content === 'string' ? (
                    <>
                      <pre className={code}>{record.content}</pre>
                      <Disclosure title="Complete message fields">
                        <pre className={code}>{capturedJson(item)}</pre>
                      </Disclosure>
                    </>
                  ) : (
                    <pre className={code}>{capturedJson(item)}</pre>
                  )}
                </Disclosure>
              </li>
            )
          })}
        </ol>
      ) : (
        <pre className={code}>
          {kind === 'text' && typeof value === 'string'
            ? value
            : capturedJson(value)}
        </pre>
      )}
    </Disclosure>
  )
}

function Disclosure({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className={disclosure}>{title}</summary>
      {open && <div className="py-2">{children}</div>}
    </details>
  )
}
