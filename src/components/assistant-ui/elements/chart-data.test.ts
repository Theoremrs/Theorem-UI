// The chart's one data shape: normalization, a truthful axis policy, and the
// values the plot, Data view, and aria description all read (ub-mode U1).
import { describe, expect, test } from 'bun:test'
import { axisScale, normalizeChart, tickValues } from './chart-data'

const SEARCH_READ = {
  series: [
    {
      label: 'Search',
      data: [
        { label: 'Tue', value: 320 },
        { label: 'Wed', value: 290 },
        { label: 'Thu', value: 305 },
        { label: 'Fri', value: 260 },
        { label: 'Sat', value: 240 },
        { label: 'Sun', value: 225 },
        { label: 'Mon', value: 210 },
      ],
    },
    {
      label: 'Read',
      data: [
        { label: 'Tue', value: 180 },
        { label: 'Wed', value: 170 },
        { label: 'Thu', value: 165 },
        { label: 'Fri', value: 150 },
        { label: 'Sat', value: 140 },
        { label: 'Sun', value: 135 },
        { label: 'Mon', value: 120 },
      ],
    },
  ],
}

describe('normalizeChart', () => {
  test('a single data array is one series; labels default to 1-based index', () => {
    const chart = normalizeChart({ data: [{ value: 5 }, { label: 'B', value: 7 }] })
    expect(chart.count).toBe(2)
    expect(chart.series).toHaveLength(1)
    expect(chart.series[0]!.values).toEqual([5, 7])
    expect(chart.series[0]!.labels).toEqual(['1', 'B'])
    expect(chart.series[0]!.label).toBeUndefined()
  })

  test('series takes precedence and pads shorter series with zero', () => {
    const chart = normalizeChart({
      data: [{ value: 99 }],
      series: [
        { label: 'A', data: [{ value: 1 }, { value: 2 }] },
        { label: 'B', data: [{ value: 3 }] },
      ],
    })
    expect(chart.count).toBe(2)
    expect(chart.series.map((s) => s.values)).toEqual([
      [1, 2],
      [3, 0],
    ])
    expect(chart.series.map((s) => s.label)).toEqual(['A', 'B'])
  })

  test('non-finite values become zero, never NaN in the plot', () => {
    const chart = normalizeChart({
      data: [{ value: Number.NaN }, { value: Infinity }, { value: 4 }],
    })
    expect(chart.series[0]!.values).toEqual([0, 0, 4])
  })
})

describe('axisScale', () => {
  test('the fixture gets a zero baseline, 400 bound, and 100 ticks', () => {
    const chart = normalizeChart(SEARCH_READ)
    const scale = axisScale(chart.series)
    expect(scale.min).toBe(0)
    expect(scale.max).toBe(400)
    expect(tickValues(scale)).toEqual([400, 300, 200, 100, 0])
  })

  test('a small maximum does not inflate to a large round bound', () => {
    const scale = axisScale(normalizeChart({ data: [{ value: 7 }, { value: 5 }] }).series)
    expect(scale.max).toBe(8)
    expect(scale.min).toBe(0)
    expect(tickValues(scale)).toEqual([8, 6, 4, 2, 0])
  })

  test('negative values keep a symmetric truthful range around zero', () => {
    const scale = axisScale(
      normalizeChart({ data: [{ value: -30 }, { value: 20 }] }).series,
    )
    expect(scale.min).toBeLessThan(0)
    expect(scale.max).toBeGreaterThan(0)
    expect(scale.min).toBe(-scale.max)
  })

  test('an all-zero series still yields a usable 0..1 axis', () => {
    const scale = axisScale(normalizeChart({ data: [{ value: 0 }] }).series)
    expect(scale.min).toBe(0)
    expect(scale.max).toBeGreaterThan(0)
  })
})
