// SOURCING: @tanstack/react-router file route; the web's own App frame
// (components/artifacts/app-revision-frame.tsx PinnedAppFrame) and App check
// (lib/blocks/app-operations.ts answerAppRequest), reached by a native app
// through lib/app-host/native.ts; the platform ResizeObserver for the height.
//
// The App host a native app embeds in a WebView: one App revision, run as the
// web runs it, or an `app.check` the agent asked the phone for. The page has no
// session; it reads and saves the App's document through the native app.
import { createFileRoute } from '@tanstack/react-router'
import { Suspense, lazy } from 'react'

const AppHost = lazy(() => import('@/components/artifacts/native-app-host'))

export const Route = createFileRoute('/app-host')({
  // The frame, the compiler and the checker run in the WebView; nothing renders on the server.
  ssr: false,
  component: () => (
    <Suspense>
      <AppHost />
    </Suspense>
  ),
})
