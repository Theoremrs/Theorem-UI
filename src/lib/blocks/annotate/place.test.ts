import { describe, expect, test } from 'bun:test'
import { boxAround } from './anchors'
import { connectorEnds, connectorPath, LEADER_RUN, leaderEnds, subjectPath } from './paths'
import { choose, cleared, overlap } from './place'
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

  test('covers another part before it covers another note', () => {
    // Parts drawn on one another leave no side free of them: half of a note
    // on one side, the whole of another part on the other.
    const note = { x: 414, y: 160, width: 160, height: 80 }
    const part = { x: 80, y: 140, width: 220, height: 120 }
    expect(choose([right, left], { subject, bounds, obstacles: [note], others: [part] }).placement).toBe('left')
    expect(choose([right, left], { subject, bounds, obstacles: [note, part] }).placement).toBe('right')
  })

  test('between near-equal candidates, takes the one listed first', () => {
    const high = at('right-start', 334, 120)
    const low = at('right-end', 334, 200)
    expect(choose([high, low], { subject, bounds, obstacles: [] }).placement).toBe('right-start')
    expect(choose([low, high], { subject, bounds, obstacles: [] }).placement).toBe('right-end')
  })

  test('keeps clear of reserved controls', () => {
    const strip = { x: 0, y: 360, width: 600, height: 40 }
    const low = at('bottom', 220, 330)
    expect(choose([low, left], { subject, bounds, obstacles: [strip] }).placement).toBe('left')
  })

  test('where every side lands on a taller note, slides past it instead of covering it', () => {
    // A tall expanded note over the right of this subject, and the layer's
    // edge just left of it: no side Floating UI offers is free.
    const tall = { x: 330, y: 20, width: 200, height: 360 }
    const layer = { x: 200, y: 0, width: 600, height: 400 }
    const sides = [right, left]
    const tried = [...sides, ...sides.flatMap((each) => cleared(each, [tall], 8))]
    const chosen = choose(tried, { subject, bounds: layer, obstacles: [tall] })
    expect(overlap(chosen.box, tall)).toBe(0)
    expect(chosen.placement).toBe('right')
    expect(chosen.box.x).toBe(tall.x + tall.width + 8)
  })

  test('slides along its side, or away from the subject, past every note it would land on', () => {
    const first = { x: 330, y: 150, width: 100, height: 40 }
    const second = { x: 438, y: 150, width: 100, height: 40 }
    const slid = cleared(right, [first, second], 8)
    for (const each of slid) expect(overlap(each.box, first) + overlap(each.box, second)).toBe(0)
    expect(slid.map((each) => each.box)).toContainEqual({ ...right.box, x: second.x + second.width + 8 })
    expect(slid.map((each) => each.box)).toContainEqual({ ...right.box, y: first.y + first.height + 8 })
    expect(slid.map((each) => each.box)).toContainEqual({ ...right.box, y: first.y - right.box.height - 8 })
    expect(cleared(right, [], 8)).toEqual([])
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

  test('a technical leader: one 45 degree elbow off the corner, then a level run into the note', () => {
    // The note is raised above the subject: the leader leaves the bracket's corner.
    const note = { x: 400, y: 120, width: 160, height: 80 }
    const { from, to } = leaderEnds(subject, note, 8, 17)
    expect(from).toEqual([328, 172])
    expect(to).toEqual([400, 137])
    expect(connectorPath('leader', from, to)).toBe('M328,172L363,137L400,137')
    // Too little room for a level run after a 45 degree rise: a right angle instead, never steeper.
    expect(connectorPath('leader', [0, 0], [20, -30])).toBe('M0,0L0,-30L20,-30')
    expect(connectorPath('leader', [0, 0], [32, -30])).toBe('M0,0L0,-30L32,-30')
    expect(connectorPath('leader', [0, 0], [30 + LEADER_RUN, -30])).toBe(`M0,0L30,-30L${30 + LEADER_RUN},-30`)
    // A short run is still a 45 degree elbow: the part moved under a note that kept its side.
    expect(connectorPath('leader', [0, 0], [36, -30])).toBe('M0,0L30,-30L36,-30')
    // Level with the subject: straight across.
    expect(connectorPath('leader', [0, 10], [40, 10])).toBe('M0,10L40,10')
  })

  test('a leader to a note above or below leaves the facing edge', () => {
    const above = { x: 250, y: 40, width: 100, height: 60 }
    expect(leaderEnds(subject, above, 4)).toEqual({ from: [300, 176], to: [300, 100] })
    const below = { x: 250, y: 300, width: 100, height: 60 }
    expect(leaderEnds(subject, below, 4)).toEqual({ from: [300, 224], to: [300, 300] })
  })

  test('brackets have open corners, never a closed box', () => {
    const path = subjectPath('bracket', subject, 0)
    expect(path.match(/M/g)?.length).toBe(4)
    expect(path).not.toContain('z')
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
