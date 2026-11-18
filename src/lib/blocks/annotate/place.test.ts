import { describe, expect, test } from 'bun:test'
import { boxAround } from './anchors'
import { connectorEnds, connectorPath, subjectPath } from './paths'
import { choose, overlap } from './place'
import type { Candidate } from './place'

const bounds = { x: 0, y: 0, width: 600, height: 400 }
const subject = { x: 280, y: 180, width: 40, height: 40 }
const at = (placement: Candidate['placement'], x: number, y: number): Candidate => ({
  placement,
  box: { x, y, width: 160, height: 80 },
})
const right = at('right', 334, 160)
const left = at('left', 106, 160)
const bottom = at('bottom', 220, 234)

describe('placing a note', () => {
  test('takes the free side over one that covers another note', () => {
    expect(choose([right, left], { subject, bounds, obstacles: [right.box] }).placement).toBe('left')
  })

  test('keeps the side it had unless another is clearly better', () => {
    const options = { subject, bounds, obstacles: [] }
    expect(choose([left, right], { ...options, previous: 'right' }).placement).toBe('right')
    expect(choose([left, right], { ...options, previous: 'left' }).placement).toBe('left')
  })

  test('stays inside the layer and off its subject', () => {
    const outside = at('right', 520, 160)
    const covering = at('top', 260, 150)
    expect(choose([outside, covering, bottom], { subject, bounds, obstacles: [] }).placement).toBe('bottom')
  })

  test('keeps clear of reserved controls', () => {
    const strip = { x: 0, y: 360, width: 600, height: 40 }
    const low = at('bottom', 220, 330)
    expect(choose([low, left], { subject, bounds, obstacles: [strip] }).placement).toBe('left')
  })
})

describe('subjects and connectors', () => {
  test('a leader leaves the subject on the side facing the note and ends on the note', () => {
    const { from, to } = connectorEnds(subject, right.box, 0)
    expect(from).toEqual([320, 200])
    expect(to).toEqual([334, 200])
    expect(connectorPath('line', from, to)).toBe('M320,200L334,200')
    expect(connectorPath('elbow', [0, 0], [100, 20])).toBe('M0,0L20,20L100,20')
  })

  test('an App can draw its own subject and connector', () => {
    expect(subjectPath((box) => `M${box.x},${box.y}`, subject)).toBe('M280,180')
    expect(connectorPath((a, b) => `${a}|${b}`, [1, 2], [3, 4])).toBe('1,2|3,4')
    expect(subjectPath('none', subject)).toBe('')
    expect(subjectPath('rect', subject)).toContain('z')
  })

  test('boxes', () => {
    expect(boxAround([[1, 2], [5, -1]])).toEqual({ x: 1, y: -1, width: 4, height: 3 })
    expect(overlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(25)
  })
})
