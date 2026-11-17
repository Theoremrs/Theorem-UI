import { expect, test } from 'bun:test'
import { dockMaxWidth, dockMinWidth } from './dock-geometry'

test('the resize bounds keep the conversation minimum at a narrow viewport', () => {
  expect(dockMaxWidth(700)).toBe(280)
  expect(dockMinWidth(700)).toBe(280)
  expect(dockMaxWidth(1200)).toBe(780)
  expect(dockMinWidth(1200)).toBe(360)
  expect(dockMaxWidth(390)).toBe(0)
  expect(dockMinWidth(390)).toBe(0)
})
