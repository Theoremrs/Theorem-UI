// SOURCING: React state and effects over the resource facade (lib/resources): resolve, preview and references with an AbortController per request, the provider's change subscription, and the browser's online event. No query library: a request is keyed by the reference and replaced by the next.
import { useCallback, useEffect, useMemo, useReducer, useState } from 'react'
import {
  initialReferences,
  referencesReducer,
} from '@/lib/resources/references'
import type { ReferencesState } from '@/lib/resources/references'
import {
  preview,
  providerFor,
  references,
  resolve,
  supports,
} from '@/lib/resources/registry'
import type {
  PreviewData,
  ReferencesRequest,
  ResourceMeta,
} from '@/lib/resources/provider'
import type { NotReady, Tombstone } from '@/lib/resources/state'
import { refKey } from '@/lib/resources/types'
import type { ResourceRef } from '@/lib/resources/types'

export type ResolvedView =
  /** Asked, not answered: the label shown is a hint, not verified. */
  | { status: 'loading' }
  | { status: 'ready'; meta: ResourceMeta }
  | { status: NotReady; tombstone?: Tombstone }

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong.'

/**
 * The owner's current answer about a resource. A new reference starts at
 * `loading` again, so the previous resource's label never stands for it; an
 * answer that is not ready drops the hint, so a revoked resource is not
 * shown under its old name. The answer is re-read when the provider reports a
 * change and when the browser comes back online.
 */
export function useResolved(ref: ResourceRef | undefined): ResolvedView {
  const key = ref ? refKey(ref) : undefined
  const [answer, setAnswer] = useState<{ key?: string; view: ResolvedView }>({
    view: { status: 'loading' },
  })
  const [tick, setTick] = useState(0)
  const stable = useMemo(() => ref, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!stable) return
    const controller = new AbortController()
    resolve(stable, { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return
        setAnswer({
          key,
          view:
            result.state === 'ready' && 'meta' in result
              ? { status: 'ready', meta: result.meta }
              : {
                  status: result.state as NotReady,
                  tombstone:
                    'tombstone' in result ? result.tombstone : undefined,
                },
        })
      },
      () => {
        if (!controller.signal.aborted)
          setAnswer({ key, view: { status: 'unavailable' } })
      },
    )
    const provider = providerFor(stable.resource)
    const unsubscribe = supports(provider, 'changes')
      ? provider!.subscribe!(stable, () => setTick((n) => n + 1))
      : undefined
    const online = () => setTick((n) => n + 1)
    window.addEventListener('online', online)
    return () => {
      controller.abort()
      unsubscribe?.()
      window.removeEventListener('online', online)
    }
  }, [stable, key, tick])
  // An answer for another reference is not this one's.
  return answer.key === key ? answer.view : { status: 'loading' }
}

export type PreviewView =
  | { status: 'loading' }
  | { status: 'ready'; preview: PreviewData }
  | { status: NotReady; tombstone?: Tombstone }

/** The compact preview for `ref`, read only while `enabled` (a closed popover reads nothing). */
export function usePreview(ref: ResourceRef, enabled: boolean): PreviewView {
  const key = refKey(ref)
  const [answer, setAnswer] = useState<{ key?: string; view: PreviewView }>({
    view: { status: 'loading' },
  })
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    preview(ref, { signal: controller.signal }).then(
      (result) => {
        if (controller.signal.aborted) return
        setAnswer({
          key,
          view:
            result.state === 'ready' && 'preview' in result
              ? { status: 'ready', preview: result.preview }
              : {
                  status: result.state as NotReady,
                  tombstone:
                    'tombstone' in result ? result.tombstone : undefined,
                },
        })
      },
      () => {
        if (!controller.signal.aborted)
          setAnswer({ key, view: { status: 'unavailable' } })
      },
    )
    return () => controller.abort()
  }, [key, enabled]) // eslint-disable-line react-hooks/exhaustive-deps
  return answer.key === key ? answer.view : { status: 'loading' }
}

/**
 * One reference's incoming or outgoing occurrences, a page at a time. A failed
 * later page leaves the rows read so far and `retry` asks for it again; a
 * failed first page is a failure, not an empty list.
 */
export function useReferences(
  ref: ResourceRef,
  request: Omit<ReferencesRequest, 'cursor'>,
): ReferencesState & { more: () => void; retry: () => void } {
  const [state, dispatch] = useReducer(referencesReducer, initialReferences)
  const key = `${refKey(ref)}|${request.direction}|${(request.relationships ?? []).join(',')}|${request.limit ?? ''}`
  const [attempt, setAttempt] = useState(0)
  const [position, setPosition] = useState<{ key: string; cursor?: string }>({
    key,
  })
  // A cursor belongs to the request it came from, never to the next one.
  const cursor = position.key === key ? position.cursor : undefined

  useEffect(() => {
    dispatch({ type: 'reset' })
  }, [key])

  useEffect(() => {
    const controller = new AbortController()
    references(ref, { ...request, cursor }, { signal: controller.signal }).then(
      (page) => {
        if (controller.signal.aborted) return
        if ('occurrences' in page)
          dispatch({ type: 'page', page, append: cursor !== undefined })
        else dispatch({ type: 'unsupported' })
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          dispatch({ type: 'failed', error: message(error) })
      },
    )
    return () => controller.abort()
  }, [key, cursor, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  const more = useCallback(() => {
    if (!state.next) return
    dispatch({ type: 'more' })
    setPosition({ key, cursor: state.next })
  }, [state.next, key])
  const retry = useCallback(() => {
    if (state.status === 'failed') dispatch({ type: 'reset' })
    else if (state.status === 'failed-more') dispatch({ type: 'more' })
    setAttempt((n) => n + 1)
  }, [state.status])
  return { ...state, more, retry }
}
