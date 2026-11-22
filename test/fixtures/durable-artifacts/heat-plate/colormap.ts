// How a temperature becomes a color: presentation only. A change here is a
// presentation revision; it does not touch a solved field.
export const COLORMAP = { name: 'inferno-like', version: '1' } as const

const STOPS: Array<[number, [number, number, number]]> = [
  [0, [0, 0, 4]],
  [0.25, [87, 16, 110]],
  [0.5, [188, 55, 84]],
  [0.75, [249, 142, 9]],
  [1, [252, 255, 164]],
]

/** The color at `fraction` (0 coldest, 1 hottest) of the field's range. */
export function colorAt(fraction: number): [number, number, number] {
  const f = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0))
  for (let k = 1; k < STOPS.length; k++) {
    const [to, high] = STOPS[k]!
    const [from, low] = STOPS[k - 1]!
    if (f <= to) {
      const s = (f - from) / (to - from)
      return [0, 1, 2].map((c) =>
        Math.round(low[c]! + s * (high[c]! - low[c]!)),
      ) as [number, number, number]
    }
  }
  return STOPS.at(-1)![1]
}
