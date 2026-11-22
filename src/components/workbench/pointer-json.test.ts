import { describe, expect, test } from 'bun:test'
import { pointerJson } from './pointer-json'

const press = (detail: number) => ({
  button: 0,
  clientX: 10,
  clientY: 20,
  detail,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
})

describe('pointerJson', () => {
  test('carries the DOM press count, so a double and a triple click reach the core', () => {
    expect(JSON.parse(pointerJson('down', press(2))).detail).toBe(2)
    expect(JSON.parse(pointerJson('down', press(3))).detail).toBe(3)
  })

  test('a count of 0, as pointerdown reports, is a single press', () => {
    expect(JSON.parse(pointerJson('down', press(0))).detail).toBe(1)
  })

  test('names the button and the wheel deltas the Rust side reads', () => {
    const json = JSON.parse(
      pointerJson('wheel', {
        ...press(0),
        button: 2,
        deltaY: 40,
        deltaMode: 1,
      }),
    )
    expect(json).toMatchObject({
      type: 'wheel',
      button: 'right',
      deltaX: 0,
      deltaY: 40,
      deltaMode: 1,
      clientX: 10,
    })
  })
})
