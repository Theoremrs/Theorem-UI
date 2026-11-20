// SOURCING: @tanstack/react-router file route; the web's own App frame
// (components/artifacts/app-revision-frame.tsx PinnedAppFrame) and App check
// (lib/blocks/app-operations.ts answerAppRequest), reached by a native app
// through lib/app-host/native.ts; the platform ResizeObserver for the height.
//
// The App host a native app embeds in a WebView: one App revision, run as the
// web runs it, or an `app.check` the agent asked the phone for. The page has no
// session; it reads and saves the App's document through the native app.
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { PinnedAppFrame } from '@/components/artifacts/app-revision-frame'
import type { TheoremArtifact } from '@/components/artifacts/artifact-model'
import { answerAppRequest } from '@/lib/blocks/app-operations'
import { listenToNative, nativeChange, nativeDocuments, tellNative } from '@/lib/app-host/native'
import type { FromNative } from '@/lib/app-host/native'
import { ownAppDocumentsThrough } from '@/lib/theorem/apps'

export const Route = createFileRoute('/app-host')({
  // The frame, the compiler and the checker run in the WebView; nothing renders on the server.
  ssr: false,
  component: AppHost,
})

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

function AppHost() {
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
      }).then((answer) => tellNative({ type: 'checked', id: message.id, answer }))
    })
    tellNative({ type: 'ready' })
    return stop
  }, [])

  // The WebView takes the height of what the App draws.
  useEffect(() => {
    const element = page.current
    if (!element) return
    const observer = new ResizeObserver(() =>
      tellNative({ type: 'height', height: Math.ceil(element.getBoundingClientRect().height) }),
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={page} className="bg-background">
      {shown ? <PinnedAppFrame artifact={artifactOf(shown)} interactive /> : null}
    </div>
  )
}
