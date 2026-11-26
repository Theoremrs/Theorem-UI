// SOURCING: none — bun:test over ./artifact-panel-params, the record a saved layout restores an artifact panel's view from
import { expect, test } from 'bun:test'
import { panelView, viewParams } from './artifact-panel-params'

test('a chosen revision survives the layout: recorded, then restored as not following', () => {
  const recorded = viewParams({ follow: false, revision: 'r1' })
  expect(recorded).toEqual({ follow: 'false', revision: 'r1' })
  expect(
    panelView({ artifactId: 'a', threadId: 't', keep: 'true', ...recorded }),
  ).toEqual({ threadId: 't', follow: false, revision: 'r1', keep: true })
})

test('following records nothing and restores as following', () => {
  expect(viewParams({ follow: true, revision: undefined })).toEqual({
    follow: undefined,
    revision: undefined,
  })
  expect(panelView({ artifactId: 'a' })).toEqual({
    threadId: undefined,
    follow: true,
    revision: undefined,
    keep: false,
  })
})

test('a record that stops following without a revision restores as following', () => {
  expect(panelView({ artifactId: 'a', follow: 'false' }).follow).toBe(true)
})
