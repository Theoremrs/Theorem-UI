import { describe, expect, test } from 'bun:test'
import { terminalFace } from './terminal-face'

describe('terminalFace', () => {
  test('a dark surface gets a light body with dark eyes that read on it', () => {
    const face = terminalFace('#0d1117', '#e6edf3')
    expect(face.look).toEqual({ visor: true, ink: true, paper: false })
    expect(face.flat).toBe(true)
    expect(face.body).toBe('#e6edf3')
    expect(face.bodyOnSurface).toBeGreaterThan(7)
    expect(face.eyesOnBody).toBeGreaterThan(7)
  })
  test('a light surface gets the chat face: a dark body with light eyes', () => {
    const face = terminalFace('#ffffff', '#1f2328')
    expect(face.look.ink).toBe(false)
    expect(face.flat).toBe(false)
    expect(face.bodyOnSurface).toBeGreaterThan(7)
    expect(face.eyesOnBody).toBeGreaterThan(7)
  })
  test('a custom mid-tone palette still gets eyes above 3:1 on the body', () => {
    const face = terminalFace('#2b2140', '#f0c987')
    expect(face.bodyOnSurface).toBeGreaterThan(3)
    expect(face.eyesOnBody).toBeGreaterThan(3)
  })
  test('the colour of the surface is not fixed: swapping it swaps the look', () => {
    expect(terminalFace('#000', '#fff').look.ink).toBe(true)
    expect(terminalFace('#fff', '#000').look.ink).toBe(false)
  })
  test('a value that is not a colour is refused', () => {
    expect(() => terminalFace('nope', '#fff')).toThrow()
  })
})
