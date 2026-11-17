import { afterEach, expect, test } from 'bun:test'
import { onLifeFrame, publishLifeFrame } from './frames'

const stops: Array<() => void> = []
afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  document.body.replaceChildren()
})

test('a reader that subscribes after a paused field drew hears that frame', () => {
  const canvas = document.body.appendChild(document.createElement('canvas'))
  publishLifeFrame(canvas)
  const heard: HTMLCanvasElement[] = []
  stops.push(onLifeFrame((drawn) => heard.push(drawn)))
  expect(heard).toEqual([canvas])
  publishLifeFrame(canvas)
  expect(heard).toHaveLength(2)
})

test('a canvas no longer on the page is not replayed', () => {
  const canvas = document.body.appendChild(document.createElement('canvas'))
  publishLifeFrame(canvas)
  canvas.remove()
  const heard: HTMLCanvasElement[] = []
  stops.push(onLifeFrame((drawn) => heard.push(drawn)))
  expect(heard).toEqual([])
})
