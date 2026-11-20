// SOURCING: none — the chart's one data shape, pure. The plot, the Data
// view, and the accessible description all read this, so they cannot drift
// (the vocabulary's own chart math is not exported, and its 500-for-320
// headroom is the presentation defect this replaces). Normalization mirrors
// the vocabulary's contract: `series` wins over `data`, shorter series pad
// with zero, non-finite values become zero.

export type ChartPoint = { label?: string; value: number }
export type ChartSeriesInput = {
  label?: string
  color?: string
  data?: ChartPoint[]
}

export interface NormalizedSeries {
  label: string | undefined
  values: number[]
  labels: string[]
}

export interface NormalizedChart {
  count: number
  series: NormalizedSeries[]
}

export interface ChartScale {
  min: number
  max: number
}

const finite = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

/** One dataset, normalized once: the single source every view reads. */
export function normalizeChart(input: {
  data?: ChartPoint[]
  series?: ChartSeriesInput[]
}): NormalizedChart {
  const raw: ChartSeriesInput[] =
    Array.isArray(input.series) && input.series.length > 0
      ? input.series
      : [{ data: Array.isArray(input.data) ? input.data : [] }]
  const count = raw.reduce(
    (max, entry) =>
      Math.max(max, Array.isArray(entry.data) ? entry.data.length : 0),
    0,
  )
  return {
    count,
    series: raw.map((entry) => ({
      label: typeof entry.label === 'string' ? entry.label : undefined,
      values: Array.from({ length: count }, (_, point) =>
        finite(entry.data?.[point]?.value),
      ),
      labels: Array.from({ length: count }, (_, point) => {
        const label = entry.data?.[point]?.label
        return typeof label === 'string' ? label : String(point + 1)
      }),
    })),
  }
}

/** The smallest {1,2,5}×10^n at or above `value` (0 stays 0). */
function niceCeil(value: number): number {
  if (value <= 0) return 0
  const exponent = Math.floor(Math.log10(value))
  const base = 10 ** exponent
  for (const multiple of [1, 2, 5, 10]) {
    const candidate = multiple * base
    if (candidate >= value - 1e-9) return candidate
  }
  return 10 * base
}

const TICKS = 5
const INTERVALS = TICKS - 1

/**
 * A truthful axis: a zero baseline for all-positive data, a nice tick step
 * (max ÷ 4 rounded up to {1,2,5}×10^n) so the bound carries little headroom
 * (320 → step 100 → 400, not 500), and a symmetric range when the data
 * crosses zero. Never hides truncation; an all-zero series still draws.
 */
export function axisScale(series: NormalizedSeries[]): ChartScale {
  const values = series.flatMap((entry) => entry.values)
  const max = values.length ? Math.max(0, ...values) : 0
  const min = values.length ? Math.min(0, ...values) : 0
  if (min >= 0) {
    const step = niceCeil(max / INTERVALS) || 1
    return { min: 0, max: step * INTERVALS }
  }
  if (max <= 0) {
    const step = niceCeil(-min / INTERVALS) || 1
    return { min: -step * INTERVALS, max: 0 }
  }
  const step = niceCeil(Math.max(max, -min) / 2) || 1
  return { min: -2 * step, max: 2 * step }
}

/** Evenly spaced ticks, top to bottom, for the y-axis column. */
export function tickValues(scale: ChartScale): number[] {
  const span = scale.max - scale.min
  if (span <= 0) return [scale.max]
  return Array.from(
    { length: TICKS },
    (_, index) => scale.max - (span * index) / (TICKS - 1),
  )
}

/** A tick or endpoint value as text: rounded to 2dp, grouped. */
export function formatValue(value: number): string {
  return (Math.round(value * 100) / 100).toLocaleString('en-US')
}
