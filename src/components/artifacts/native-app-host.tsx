import { useEffect, useRef, useState } from 'react'
import { PinnedAppFrame } from '@/components/artifacts/app-revision-frame'
import type { TheoremArtifact } from '@/components/artifacts/artifact-model'
import { answerAppRequest } from '@/lib/blocks/app-operations'
import {
  listenToNative,
  nativeChange,
  nativeDocuments,
  tellNative,
} from '@/lib/app-host/native'
import type { FromNative } from '@/lib/app-host/native'
import { ownAppDocumentsThrough } from '@/lib/theorem/apps'

type Show = Extract<FromNative, { type: 'show' }>

/** The revision as the web's artifact model names it, from what the native app was given. */
const artifactOf = (shown: Show): TheoremArtifact => ({
  partId: `${shown.documentId}@${shown.position ?? ''}`,
  artifactId: shown.documentId,
  revision: shown.position ?? '',
  kind: 'app',
  rendererId: 'theorem-app',
  contractVersion: '',
  lifecycle: 'ready',
  patchSequence: 0,
  title: shown.title,
  content: shown.html,
  language: 'html',
  fallbackText: '',
  payloadRef: undefined,
  runId: undefined,
  sourceTool: undefined,
  documentId: shown.documentId,
  documentPosition: shown.position,
})

export default function AppHost() {
  const [shown, setShown] = useState<Show>()
  const page = useRef<HTMLDivElement>(null)

  useEffect(() => {
    ownAppDocumentsThrough(nativeDocuments, nativeChange)
    const stop = listenToNative((message) => {
      if (message.type === 'show') return setShown(message)
      // A check changes nothing, so the receipt's revision is the native app's to fill in.
      void answerAppRequest({
        runId: '',
        requestRef: message.id,
        operation: message.operation,
        args: message.args,
        expectedRevision: 0,
      }).then((answer) =>
        tellNative({ type: 'checked', id: message.id, answer }),
      )
    })
    tellNative({ type: 'ready' })
    return stop
  }, [])

  // The WebView takes the height of what the App draws.
  useEffect(() => {
    const element = page.current
    if (!element) return
    const observer = new ResizeObserver(() =>
      tellNative({
        type: 'height',
        height: Math.ceil(element.getBoundingClientRect().height),
      }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={page} className="bg-background">
      {shown ? (
        <PinnedAppFrame artifact={artifactOf(shown)} interactive />
      ) : null}
    </div>
  )
}
