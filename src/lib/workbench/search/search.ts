// SOURCING: @theoremharness/sdk — each call is the generated client.ide.search.query / cancel operation, sent through ../ask with the request id as the idempotency key; scalarToUtf16 is the SDK's own offset helper (the host counts match columns in Unicode scalars). Paging follows the host's contract as the Theia extension's theorem-search.ts uses it: the first query answers {id, results, complete, cancelled}, and a follow-up {id, limit} answers the next page. There is no typed search class in the SDK.

import { scalarToUtf16 } from '@theoremharness/sdk'
import type { TheoremClient } from '@theoremharness/sdk'
import type { Environment, HostClient } from '../environment/environment'
import { accepted, refused } from '../environment/result'
import type { Completion } from '../environment/result'
import { createAsk, num, raw, str } from '../ask'
import type { ReadAt } from '../ask'

/** The calls the search owner makes of a Theorem client. */
export type SearchClient = HostClient & {
  ide: {
    search: Pick<TheoremClient['ide']['search'], 'query' | 'cancel'>
  }
}

export interface SearchRow {
  path: string
  /** One-based, as the host counts lines. */
  line: number
  text: string
  /** UTF-16 offsets within `text`. */
  matches: { start: number; end: number }[]
  /** UTF-16 units the host cut from the start of the line before `text`. */
  textOffset?: number
}

export interface SearchEnd {
  outcome: 'refused' | 'uncertain' | 'failed'
  code?: string
  reason: string
}

/** One page of a search's results. `more` means the owner is reading the next page; every other state is the last page. */
export interface SearchPage {
  id: string
  rows: SearchRow[]
  /** Rows of a kind this owner does not read (the host's non-text rows). */
  skipped: number
  state: 'more' | 'complete' | 'cancelled' | 'ended'
  /** Why the search ended early; set only with state `ended`. */
  end?: SearchEnd
  /** The host and generation these rows were read from. */
  readAt: ReadAt
}

export interface SearchRequest {
  requestId: string
  query: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  /** Comma-separated globs. */
  include?: string
  exclude?: string
  /** Files the host scans per call. */
  limit: number
}

export interface Search {
  readonly workspaceId: string
  /** Answers with the id once the host has accepted the query; its pages follow through `onPage`, the first after this answer. */
  query: (request: SearchRequest) => Promise<Completion<{ id: string }>>
  /** From the moment this is called nothing more is delivered for `id`. A search that is not running is accepted as it is. */
  cancel: (request: {
    requestId: string
    id: string
  }) => Promise<Completion<{ id: string }>>
  onPage: (listener: (page: SearchPage) => void) => () => void
  /** Answers withheld because the environment had moved on. */
  dropped: () => number
  dispose: () => void
}

export interface SearchOptions {
  /** Runs `task` after the current answer has been delivered; the default is a zero-delay timer. */
  schedule?: (task: () => void) => void
}

const globs = (value: string | undefined): string[] =>
  (value ?? '')
    .split(',')
    .map((glob) => glob.trim())
    .filter(Boolean)

function rowOf(value: unknown): SearchRow | undefined {
  const body = raw(value)
  const path = str(body.path)
  const line = num(body.line)
  const text = str(body.text)
  if (body.kind !== 'text' || !path || line === undefined || text === undefined)
    return undefined
  const ranges = Array.isArray(body.ranges) ? body.ranges : []
  const cut = num(body.text_offset)
  return {
    path,
    line,
    text,
    matches: ranges.flatMap((range) => {
      const start = num(raw(range).start)
      const end = num(raw(range).end)
      return start === undefined || end === undefined
        ? []
        : [{ start: scalarToUtf16(text, start), end: scalarToUtf16(text, end) }]
    }),
    ...(cut ? { textOffset: cut } : {}),
  }
}

export function createSearch(
  env: Environment<SearchClient>,
  options: SearchOptions = {},
): Search {
  const { ask, workspaceId, dropped, readAt, dispose } = createAsk(env)
  const api = () => env.client.ide.search
  const schedule = options.schedule ?? ((task) => void setTimeout(task, 0))
  const listeners = new Set<(page: SearchPage) => void>()
  /** The searches whose pages are still being delivered. Cancelling removes one. */
  const running = new Map<string, { id: string }>()

  function emit(page: SearchPage) {
    for (const listener of [...listeners]) {
      try {
        listener(page)
      } catch (error) {
        console.warn('A search listener failed', error)
      }
    }
  }

  const pageOf = (
    answer: unknown,
    at: ReadAt,
    fallbackId: string,
  ): SearchPage => {
    const body = raw(answer)
    const results = Array.isArray(body.results) ? body.results : []
    const rows = results.flatMap((row) => rowOf(row) ?? [])
    return {
      id: str(body.id) ?? fallbackId,
      rows,
      skipped: results.length - rows.length,
      state:
        body.cancelled === true
          ? 'cancelled'
          : body.complete === true
            ? 'complete'
            : 'more',
      readAt: at,
    }
  }

  /** Delivers `first`, then the pages after it, until the last one, a cancel, or a failure. */
  async function follow(
    token: { id: string },
    first: SearchPage,
    limit: number,
    requestId: string,
  ) {
    let page = first
    for (let next = 1; ; next += 1) {
      if (running.get(token.id) !== token) return
      emit(page)
      if (page.state !== 'more') break
      const done = await ask(
        `${requestId}:${next}`,
        'search.query',
        false,
        (headers) => api().query({ ...headers, body: { id: token.id, limit } }),
        (answer, at) => pageOf(answer, at, token.id),
      )
      if (running.get(token.id) !== token) return
      if (done.outcome === 'accepted') {
        page = done.value
      } else if (
        done.outcome === 'refused' &&
        done.code === 'stale_generation'
      ) {
        break
      } else {
        emit({
          id: token.id,
          rows: [],
          skipped: 0,
          state: 'ended',
          end: {
            outcome: done.outcome,
            ...(done.outcome === 'refused' ? { code: done.code } : {}),
            reason: done.reason,
          },
          readAt: readAt(),
        })
        break
      }
    }
    running.delete(token.id)
  }

  return {
    workspaceId,
    dropped,

    async query(request) {
      const { requestId, limit } = request
      const answers = { workspaceId, requestId }
      if (request.query === '') {
        return refused(answers, 'empty_query', 'A search needs a query')
      }
      if (!Number.isInteger(limit) || limit < 1) {
        return refused(answers, 'bad_limit', 'A search needs a positive limit')
      }
      const done = await ask(
        requestId,
        'search.query',
        false,
        (headers) =>
          api().query({
            ...headers,
            body: {
              query: request.query,
              view: 'text',
              regex: request.regex,
              case_sensitive: request.caseSensitive,
              whole_word: request.wholeWord,
              include: globs(request.include),
              exclude: globs(request.exclude),
              limit,
            },
          }),
        (answer, at) => pageOf(answer, at, ''),
      )
      if (done.outcome !== 'accepted') return done
      const first = done.value
      if (first.id === '') {
        return {
          ...answers,
          outcome: 'failed',
          reason: 'The host answered a search with no id',
        }
      }
      const token = { id: first.id }
      running.set(first.id, token)
      schedule(() => void follow(token, first, limit, requestId))
      return accepted(answers, { id: first.id })
    },

    async cancel({ requestId, id }) {
      if (!running.delete(id)) {
        return accepted({ workspaceId, requestId }, { id })
      }
      return ask(
        requestId,
        'search.cancel',
        true,
        (headers) =>
          api().cancel({ ...headers, body: { id } }, { maxRetries: 0 }),
        () => ({ id }),
      )
    },

    onPage(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },

    dispose() {
      running.clear()
      listeners.clear()
      dispose()
    },
  }
}
