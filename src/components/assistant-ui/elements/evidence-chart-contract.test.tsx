import { afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { EvidenceChart } from './evidence-chart'
import { chartPositions, chartSeriesColor, normalizeChart } from './chart-data'
import {
  cleanup,
  click,
  render,
  waitFor,
  buttonNamed,
} from '../../../../test/blocks/render'

afterEach(cleanup)

const SERIES = [
  {
    label: 'A',
    data: [
      { label: 'Mon', value: 4 },
      { label: 'Tue', value: -2 },
    ],
  },
  {
    label: 'B',
    data: [
      { label: 'Mon', value: 6 },
      { label: 'Tue', value: -3 },
    ],
  },
  {
    label: 'C',
    data: [
      { label: 'Mon', value: -1 },
      { label: 'Tue', value: 7 },
    ],
  },
]

test('stacked coordinates separate positive and negative totals without changing data', () => {
  const chart = normalizeChart({ series: SERIES })
  const positioned = chartPositions(chart.series, true)
  expect(positioned.map((s) => s.starts)).toEqual([
    [0, 0],
    [4, -2],
    [0, 0],
  ])
  expect(positioned.map((s) => s.ends)).toEqual([
    [4, -2],
    [10, -5],
    [-1, 7],
  ])
  expect(chart.series.map((s) => s.values)).toEqual([
    [4, -2],
    [6, -3],
    [-1, 7],
  ])
  expect(chartPositions(chart.series, false).map((s) => s.ends)).toEqual([
    [4, -2],
    [6, -3],
    [-1, 7],
  ])
})

test('stacked bars accumulate on the plot while Data retains original values', async () => {
  const { container } = await render(
    <EvidenceChart variant="bar" series={SERIES} stacked />,
  )
  const first = container.querySelector(
    'rect[data-series="0"][data-point="0"]',
  )!
  const second = container.querySelector(
    'rect[data-series="1"][data-point="0"]',
  )!
  expect(first.getAttribute('x')).toBe(second.getAttribute('x'))
  expect(
    Number(second.getAttribute('y')) + Number(second.getAttribute('height')),
  ).toBeCloseTo(Number(first.getAttribute('y')))
  expect(
    container
      .querySelector('svg.evidence-chart-plot')
      ?.getAttribute('data-stacked'),
  ).toBe('true')
  await click(buttonNamed(container, 'Data')!)
  expect(
    [...container.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => cell.textContent),
    ),
  ).toEqual([
    ['Mon', '4', '6', '-1'],
    ['Tue', '-2', '-3', '7'],
  ])
})

test('stacked areas use the preceding series as their lower boundary', async () => {
  const { container } = await render(
    <EvidenceChart variant="area" series={SERIES} stacked />,
  )
  const firstTop = container
    .querySelector('g[data-series="0"] polyline')!
    .getAttribute('points')!
    .split(' ')
  const secondPolygon = container
    .querySelector('g[data-series="1"] polygon')!
    .getAttribute('points')!
    .split(' ')
  expect(secondPolygon.slice(2).reverse()).toEqual(firstTop)
})

test('line and sparkline preserve the contract that stacking only affects bars and areas', async () => {
  const { container } = await render(
    <EvidenceChart variant="line" series={SERIES} stacked />,
  )
  expect(
    container
      .querySelector('svg.evidence-chart-plot')
      ?.hasAttribute('data-stacked'),
  ).toBe(false)
})

test('axis and legend can be explicitly hidden, and sparkline is compact by default', async () => {
  const rendered = await render(
    <EvidenceChart series={SERIES} showAxis={false} showLegend={false} />,
  )
  expect(
    rendered.container.querySelector('[data-slot="chart-axes"]'),
  ).toBeNull()
  expect(rendered.container.querySelector('.evidence-chart-legend')).toBeNull()
  await rendered.rerender(<EvidenceChart variant="sparkline" series={SERIES} />)
  expect(
    rendered.container.querySelector('[data-slot="chart-axes"]'),
  ).toBeNull()
  expect(rendered.container.querySelector('.evidence-chart-legend')).toBeNull()
  expect(
    Number(
      rendered.container
        .querySelector('svg.evidence-chart-plot')
        ?.getAttribute('height'),
    ),
  ).toBeLessThan(100)
  await rendered.rerender(
    <EvidenceChart variant="sparkline" series={SERIES} showAxis showLegend />,
  )
  expect(
    rendered.container.querySelector('[data-slot="chart-axes"]'),
  ).toBeTruthy()
  expect(
    rendered.container.querySelector('.evidence-chart-legend'),
  ).toBeTruthy()
})

test('named color overrides retain their contract, while unknown values keep palette slots', async () => {
  const chart = normalizeChart({
    series: [{ color: 'emphasis', data: [{ value: 1 }] }],
  })
  expect(chart.series[0]!.color).toBe('emphasis')
  expect(chartSeriesColor(chart.series[0]!, 0, 1, 'white')).toBe(
    'var(--foreground)',
  )
  const plain = normalizeChart({ data: [{ value: 1 }] }).series[0]!
  expect(chartSeriesColor(plain, 0, 1, 'white')).toBe('white')
  expect(chartSeriesColor(plain, 1, 2, 'white')).toBe('var(--chart-2)')
  expect(
    chartSeriesColor({ ...plain, color: 'url(https://example.com)' }, 0, 1),
  ).toBe('var(--chart-1)')
  const { container } = await render(
    <EvidenceChart data={[{ value: 1 }]} color="emphasis" showLegend />,
  )
  expect(container.querySelector('polyline')?.getAttribute('stroke')).toBe(
    'var(--foreground)',
  )
  expect(container.querySelector('.evidence-chart-legend')).toBeTruthy()
})

test('keyboard inspection preserves exact small values and shared selection on expansion', async () => {
  const { container } = await render(
    <EvidenceChart
      title="Measurements"
      units="ms"
      source="Fixture source"
      data={[
        { label: 'A', value: 0.000123 },
        { label: 'B', value: 2.75 },
      ]}
    />,
  )
  const inspector = container.querySelector('[data-slot="chart-inspector"]')!
  await act(async () => {
    inspector.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    )
  })
  expect(
    container.querySelector('[data-slot="chart-readout"]')?.textContent,
  ).toContain('0.000123 ms')
  await click(container.querySelector('[aria-label="Expand chart"]')!)
  const dialog = await waitFor(() => document.querySelector('[role="dialog"]'))
  expect(
    dialog.querySelector('[data-slot="chart-readout"]')?.textContent,
  ).toContain('0.000123 ms')
  expect(dialog.textContent).toContain('Fixture source')
  const expandedInspector = dialog.querySelector(
    '[data-slot="chart-inspector"]',
  )!
  await act(async () => {
    expandedInspector.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    )
  })
  expect(
    container.querySelector('[data-slot="chart-readout"]')?.textContent,
  ).toContain('B: 2.75 ms')
  await click(buttonNamed(dialog, 'Data')!)
  expect(dialog.querySelector('table')?.textContent).toContain('0.000123')
  await click(dialog.querySelector('[data-slot="dialog-close"]')!)
  await waitFor(() => !document.querySelector('[role="dialog"]'))
  expect(container.querySelector('table')?.textContent).toContain('0.000123')
  expect(buttonNamed(container, 'Data')?.getAttribute('aria-pressed')).toBe(
    'true',
  )
})

test('empty and shorter streamed datasets retain a truthful usable view', async () => {
  const rendered = await render(<EvidenceChart data={[]} />)
  expect(rendered.container.textContent).toContain('No data points yet.')
  expect(rendered.container.querySelector('svg.evidence-chart-plot')).toBeNull()
  await rendered.rerender(<EvidenceChart data={[{ value: 5 }, { value: 9 }]} />)
  const inspector = rendered.container.querySelector(
    '[data-slot="chart-inspector"]',
  )!
  await act(async () => {
    inspector.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
    )
  })
  await rendered.rerender(
    <EvidenceChart data={[{ label: 'Remaining', value: 7 }]} />,
  )
  expect(
    rendered.container.querySelector('[data-slot="chart-readout"]')
      ?.textContent,
  ).toContain('Remaining: 7')
})

test('missing provenance stays explicit instead of implying a measured source', async () => {
  const rendered = await render(<EvidenceChart data={[{ value: 3 }]} />)
  expect(rendered.container.querySelector('figcaption')?.textContent).toContain(
    'Source not provided',
  )
  await rendered.rerender(
    <EvidenceChart
      data={[{ value: 3 }]}
      sourceUrl="https://example.com/data"
    />,
  )
  expect(
    rendered.container.querySelector('figcaption a')?.getAttribute('href'),
  ).toBe('https://example.com/data')
  expect(rendered.container.querySelector('figcaption a')?.textContent).toBe(
    'View source',
  )
})
