// The real settings page and layout over the existing story API transport.
import { useState } from 'react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { SettingsLayout } from '@/components/settings/settings-frame'
import { Route as AiRoute } from '@/routes/settings/ai'
import { Route as ResponsesRoute } from '@/routes/settings/responses'
import { Route as AppearanceRoute } from '@/routes/settings/appearance'

/** The settings frame at one of its pages: AI (the model table), Responses, or Appearance. */
export function SettingsAiStory({
  path = '/settings/ai',
}: {
  path?: '/settings/ai' | '/settings/responses' | '/settings/appearance'
}) {
  const [router] = useState(() => {
    const root = createRootRoute({
      component: () => (
        <SettingsLayout>
          <Outlet />
        </SettingsLayout>
      ),
    })
    return createRouter({
      routeTree: root.addChildren([
        createRoute({
          getParentRoute: () => root,
          path: '/settings/ai',
          component: AiRoute.options.component,
        }),
        createRoute({
          getParentRoute: () => root,
          path: '/settings/responses',
          component: ResponsesRoute.options.component,
        }),
        createRoute({
          getParentRoute: () => root,
          path: '/settings/appearance',
          component: AppearanceRoute.options.component,
        }),
      ]),
      history: createMemoryHistory({ initialEntries: [path] }),
    })
  })
  return <RouterProvider router={router} />
}
