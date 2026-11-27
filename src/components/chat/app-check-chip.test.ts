// SOURCING: bun:test over what the row for an App check says (theorem-parts.tsx).
import { expect, test } from 'bun:test'
import { appCheckSummary } from './theorem-parts'

const answered = (result: Record<string, unknown>, outcome = 'applied') => ({
  operation: 'app.check',
  state: 'answered',
  receipt: { outcome, result },
})
const clean = { built: true, problems: [], omitted: 0, typesChecked: true }

test('a check that found nothing says so, and one in flight says it is being made', () => {
  expect(appCheckSummary(answered({ ...clean, started: true }), false)).toEqual(
    {
      words: 'Built and ran the App: no reported problems',
      pending: false,
      wrong: false,
      reason: undefined,
    },
  )
  expect(
    appCheckSummary({ operation: 'app.check', state: 'pending' }, true)?.words,
  ).toBe('Checking the App')
})

test('a type check that could not be made is not a clean check', () => {
  const summary = appCheckSummary(
    answered({
      ...clean,
      typesChecked: false,
      typeCheckError: 'The type checker could not start',
    }),
    false,
  )
  expect(summary).toEqual({
    words: 'Checked the App: its types could not be checked',
    pending: false,
    wrong: true,
    reason: 'The type checker could not start',
  })
})

test('problems are counted with the ones left out, and a failed build is named', () => {
  const two = answered({ ...clean, problems: [{}], omitted: 1 })
  expect(appCheckSummary(two, false)?.words).toBe('Checked the App: 2 problems')
  const unbuilt = answered({ ...clean, built: false, problems: [{}] })
  expect(appCheckSummary(unbuilt, false)).toMatchObject({
    words: 'The App does not build',
    wrong: true,
  })
})

test('a check that was not made says so, and another operation draws nothing', () => {
  expect(appCheckSummary(answered({}, 'failed'), false)).toMatchObject({
    words: 'The App was not checked',
    wrong: true,
  })
  expect(appCheckSummary({ operation: 'kit.move' }, false)).toBeNull()
})

test('declaration reads are not artifact checks', () => {
  expect(
    appCheckSummary(
      answered({
        library: '@theorem/ui',
        digest: 'sha256:api',
        files: [{ name: 'index.d.ts', bytes: 123 }],
        file: 'index.d.ts',
        text: 'export interface SliderProps {}',
      }),
      false,
    ),
  ).toMatchObject({
    words: 'Read @theorem/ui declarations',
    pending: false,
    wrong: false,
  })
  expect(
    appCheckSummary(
      {
        operation: 'app.check',
        state: 'pending',
        args: { library: 'window.theorem' },
      },
      true,
    )?.words,
  ).toBe('Reading window.theorem declarations')
  expect(
    appCheckSummary(
      { ...answered({}, 'rejected'), args: { library: 'missing' } },
      false,
    ),
  ).toMatchObject({ words: 'Could not read missing declarations', wrong: true })
})

test('an applied receipt with no inspection evidence is not a clean check', () => {
  expect(appCheckSummary(answered({}), false)).toMatchObject({
    words: 'The App check returned no inspection result',
    wrong: true,
  })
})

test('building does not claim startup or visual verification', () => {
  expect(
    appCheckSummary(answered({ ...clean, started: false, ranMs: 0 }), false)
      ?.words,
  ).toBe('Built the App; it was not run')
  expect(appCheckSummary(answered(clean), false)?.words).toBe(
    'Built the App; its run was not reported',
  )
  expect(
    appCheckSummary(answered({ ...clean, started: true, ranMs: 1500 }), false)
      ?.words,
  ).toBe('Built and ran the App: no reported problems')
})

test('pending notebook cells remain unobserved after a successful startup', () => {
  expect(
    appCheckSummary(
      answered({
        ...clean,
        started: true,
        cells: {
          ready: ['title'],
          failed: [],
          pending: ['simulation', 'plot'],
        },
      }),
      false,
    )?.words,
  ).toBe('Built and ran the App: 2 cells still pending')
})


test('failed cells are not hidden by an empty diagnostic list', () => {
  expect(appCheckSummary(answered({
    ...clean,
    started: true,
    cells: { ready: [], failed: ['simulation'], pending: [] },
  }), false)).toMatchObject({
    words: 'Built and ran the App: 1 cell failed',
    wrong: true,
  })
})
