// The chart and its table are two views of one dataset (interactive-responses O4): the table's values are the plot's normalized series, and the frame carries units and provenance.
import { afterEach, expect, test } from 'bun:test'
import { EvidenceChart } from './evidence-chart'
import { cleanup, click, render, waitFor } from '../../../../test/blocks/render'

afterEach(cleanup)

const SERIES = [
  {
    label: 'Latency',
    data: [
      { label: 'Mon', value: 120 },
      { label: 'Tue', value: 98 },
      { label: 'Wed', value: 143 },
    ],
  },
  {
    label: 'Errors',
    data: [
      { label: 'Mon', value: 2 },
      { label: 'Tue', value: 1 },
      { label: 'Wed', value: 4 },
    ],
  },
]

test('the frame names the units and the source', async () => {
  const { container } = await render(
    <EvidenceChart
      variant="line"
      series={SERIES}
      title="Request health"
      units="ms / count"
      source="metrics service · last 3 days"
    />,
  )
  expect(container.textContent).toContain('Request health')
  expect(container.textContent).toContain('ms / count')
  expect(container.textContent).toContain('metrics service · last 3 days')
  expect(container.querySelector('svg.evidence-chart-plot')).toBeTruthy()
})

test('the Data view shows the same values the plot draws', async () => {
  const { container } = await render(
    <EvidenceChart variant="line" series={SERIES} units="ms" />,
  )
  const data = await waitFor(() =>
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Data'),
    ),
  )
  await click(data)
  const table = await waitFor(() =>
    container.querySelector('[data-slot="evidence-chart-table"]'),
  )
  const rows = [...table.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent),
  )
  expect(rows).toEqual([
    ['Mon', '120', '2'],
    ['Tue', '98', '1'],
    ['Wed', '143', '4'],
  ])
  expect(table.textContent).toContain('Latency')
  expect(table.textContent).toContain('Errors')
  expect(container.querySelector('svg[data-aui="chart"]')).toBeNull()
})

test('a single data series keeps its point labels in the table', async () => {
  const { container } = await render(
    <EvidenceChart
      variant="bar"
      data={[
        { label: 'A', value: 5 },
        { label: 'B', value: 7 },
      ]}
      units="count"
    />,
  )
  const data = await waitFor(() =>
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Data'),
    ),
  )
  await click(data)
  const table = await waitFor(() =>
    container.querySelector('[data-slot="evidence-chart-table"]'),
  )
  expect(table.textContent).toContain('count')
  const rows = [...table.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent),
  )
  expect(rows).toEqual([
    ['A', '5'],
    ['B', '7'],
  ])
})

test('multiple series always carry a legend and a dashed alternate line', async () => {
  const { container } = await render(
    <EvidenceChart variant="line" series={SERIES} />,
  )
  const legend = container.querySelector('.evidence-chart-legend')
  expect(legend?.textContent).toContain('Latency')
  expect(legend?.textContent).toContain('Errors')
  const lines = [...container.querySelectorAll('polyline.evidence-chart-line')]
  expect(lines).toHaveLength(2)
  expect(lines[0]!.getAttribute('stroke-dasharray')).toBeNull()
  expect(lines[1]!.getAttribute('stroke-dasharray')).toBeTruthy()
})

test('a single series draws no legend', async () => {
  const { container } = await render(
    <EvidenceChart variant="line" data={[{ label: 'A', value: 5 }]} />,
  )
  expect(container.querySelector('.evidence-chart-legend')).toBeNull()
})

test('each series shows its endpoint value on the plot', async () => {
  const { container } = await render(
    <EvidenceChart variant="line" series={SERIES} />,
  )
  const endpoints = [...container.querySelectorAll('.evidence-chart-endpoint')].map(
    (node) => node.textContent,
  )
  // Latency ends at 143, Errors at 4 (the last point of each series).
  expect(endpoints).toContain('143')
  expect(endpoints).toContain('4')
})

test('the source caption appears once, as a link only when a URL exists', async () => {
  const plain = await render(
    <EvidenceChart variant="line" series={SERIES} source="metrics service" />,
  )
  const captions = plain.container.querySelectorAll('figcaption')
  expect(captions).toHaveLength(1)
  expect(captions[0]!.textContent).toContain('metrics service')
  expect(captions[0]!.querySelector('a')).toBeNull()
  // The toolbar carries units only, never the source again.
  expect(
    plain.container.querySelector('.response-toolbar')?.textContent,
  ).not.toContain('metrics service')
  await cleanup()

  const linked = await render(
    <EvidenceChart
      variant="line"
      series={SERIES}
      source="metrics service"
      sourceUrl="https://metrics.example.com/week"
    />,
  )
  const anchor = linked.container.querySelector('figcaption a')
  expect(anchor?.getAttribute('href')).toBe('https://metrics.example.com/week')
})

test('an unsafe source URL never becomes a link', async () => {
  const { container } = await render(
    <EvidenceChart
      variant="line"
      series={SERIES}
      source="untrusted"
      sourceUrl="javascript:alert(1)"
    />,
  )
  expect(container.querySelector('figcaption a')).toBeNull()
  expect(container.querySelector('figcaption')?.textContent).toContain('untrusted')
})

test('the frame is a chart surface that wears glass by default', async () => {
  const { container } = await render(
    <EvidenceChart variant="line" series={SERIES} />,
  )
  const frame = container.querySelector('[data-slot="evidence-chart"]')
  expect(frame?.getAttribute('data-surface-role')).toBe('chart')
  expect(frame?.classList.contains('surface-liquid')).toBe(true)
  // The plotted data sits on a stable reading panel inside the glass frame.
  expect(frame?.querySelector('.evidence-chart-reading svg')).toBeTruthy()
})
