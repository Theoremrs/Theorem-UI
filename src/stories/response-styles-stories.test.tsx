import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router'
import {
  buttonNamed,
  cleanup,
  click,
  render,
  waitFor,
} from '../../test/blocks/render'
import { installFakeTheorem } from './fake-theorem'
import { createResponseStylesFake } from './fixtures/response-styles'
import { ResponseStylesSettingsStory } from './response-styles-stories'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const ROOT = '/api/chat/v1/response-styles'
let restore: (() => void) | undefined
afterEach(async () => {
  await cleanup()
  restore?.()
})

async function mountStory() {
  const root = createRootRoute({ component: ResponseStylesSettingsStory })
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: '/settings/keys',
        component: () => <p>The keys page</p>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  await router.load()
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

test('the settings story shows a failed seed with a retry that seeds again', async () => {
  const fake = createResponseStylesFake()
  let refuse = true
  let reads = 0
  restore = installFakeTheorem({
    'GET /api/chat/v1/bootstrap': () => ({
      csrfToken: 'csrf',
      tenantId: 'story',
    }),
    'GET /api/chat/v1/credentials': () => ({ credentials: [] }),
    ...fake.routes,
    [`GET ${ROOT}`]: (params, request) => {
      reads += 1
      if (refuse && reads === 1)
        return new Response(
          JSON.stringify({ title: 'Store unavailable', code: 'unavailable' }),
          {
            status: 503,
            headers: { 'content-type': 'application/problem+json' },
          },
        )
      return fake.routes[`GET ${ROOT}`]?.(params, request)
    },
  })
  const { container } = await mountStory()
  const alert = await waitFor(() => container.querySelector('[role="alert"]'))
  expect(alert.textContent).toContain('could not set up')
  expect(container.textContent).not.toContain('Release notes tone')

  refuse = false
  await click(buttonNamed(container, 'Try again') as Element)
  await waitFor(() => container.textContent.includes('Release notes tone'))
  expect(container.querySelector('[role="alert"]')).toBeNull()
})
