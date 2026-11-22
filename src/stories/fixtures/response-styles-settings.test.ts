import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { theoremJson } from '@/lib/theorem/passthrough'
import type {
  ResponseStyleCatalog,
  ResponseStyleDetail,
} from '@/lib/theorem/response-styles'
import { installFakeTheorem } from '../fake-theorem'
import { createResponseStylesFake } from './response-styles'
import { seedResponseStylesSettings } from './response-styles-settings'

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM
beforeAll(() => page.setURL('http://localhost:3000/'))
afterAll(() => page.setURL('about:blank'))

const ROOT = '/api/chat/v1/response-styles'
let restore: (() => void) | undefined
afterEach(() => restore?.())

test('the story seed leaves Formal edited with a newer shipped version and adds one style of the person', async () => {
  restore = installFakeTheorem(
    createResponseStylesFake({ updatesAvailable: ['theorem.style.formal'] })
      .routes,
  )
  await seedResponseStylesSettings()
  const catalog = await theoremJson<ResponseStyleCatalog>(ROOT)
  const formal = catalog.styles.find(
    (style) => style.id === 'theorem.style.formal',
  )
  expect(formal).toMatchObject({ origin: 'shipped', revision: 1 })
  const detail = await theoremJson<ResponseStyleDetail>(
    `${ROOT}/styles/theorem.style.formal`,
  )
  expect(detail.shipped?.updateAvailable).toBe(true)
  const mine = catalog.styles.filter((style) => style.origin === 'user')
  expect(mine.map((style) => style.name)).toEqual(['Release notes tone'])
})

test('seeding twice changes nothing the second time', async () => {
  restore = installFakeTheorem(
    createResponseStylesFake({ updatesAvailable: ['theorem.style.formal'] })
      .routes,
  )
  await seedResponseStylesSettings()
  await seedResponseStylesSettings()
  const catalog = await theoremJson<ResponseStyleCatalog>(ROOT)
  expect(
    catalog.styles.filter((style) => style.origin === 'user'),
  ).toHaveLength(1)
  expect(
    catalog.styles.find((style) => style.id === 'theorem.style.formal')
      ?.revision,
  ).toBe(1)
})

test('a seed that stopped after editing Formal resumes with the missing style, without editing Formal again', async () => {
  const fake = createResponseStylesFake({
    updatesAvailable: ['theorem.style.formal'],
  })
  let failPost = true
  restore = installFakeTheorem({
    ...fake.routes,
    [`POST ${ROOT}/styles`]: (params, request) => {
      if (!failPost)
        return fake.routes[`POST ${ROOT}/styles`]?.(params, request)
      failPost = false
      return new Response(
        JSON.stringify({ title: 'Store unavailable', code: 'unavailable' }),
        {
          status: 503,
          headers: { 'content-type': 'application/problem+json' },
        },
      )
    },
  })
  await expect(seedResponseStylesSettings()).rejects.toBeDefined()
  let catalog = await theoremJson<ResponseStyleCatalog>(ROOT)
  expect(
    catalog.styles.find((style) => style.id === 'theorem.style.formal')
      ?.revision,
  ).toBe(1)
  expect(catalog.styles.some((style) => style.origin === 'user')).toBe(false)

  await seedResponseStylesSettings()
  catalog = await theoremJson<ResponseStyleCatalog>(ROOT)
  expect(
    catalog.styles.find((style) => style.id === 'theorem.style.formal')
      ?.revision,
  ).toBe(1)
  expect(
    catalog.styles
      .filter((style) => style.origin === 'user')
      .map((s) => s.name),
  ).toEqual(['Release notes tone'])
})
