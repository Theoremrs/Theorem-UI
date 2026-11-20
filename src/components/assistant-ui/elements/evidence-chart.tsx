// SOURCING: chart-data owns the shared dataset and plot coordinates. Theorem's
// material resolver, coss controls and Base UI dialog own appearance and focus.
import { useId, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import type { GenerativeUILibrary } from '@assistant-ui/generative-ui/react'
import { defaultGenerativeUILibrary } from '@assistant-ui/generative-ui/react'
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@/components/coss/segmented-control'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Icon } from '@/components/icons'
import { useLiquidGlass } from '@/components/glass/liquid-glass/use-liquid-glass'
import { useSurfaceMaterial } from '@/lib/appearance'
import { cn } from '@/lib/utils'
import { safeHref } from '../utils/href'
import { useIsomorphicLayoutEffect } from '../utils/useIsomorphicLayoutEffect'
import { responseToolbar } from './surfaces'
import {
  axisScale,
  chartPositions,
  chartSeriesColor,
  formatValue,
  normalizeChart,
  tickValues,
} from './chart-data'
import type {
  ChartSeriesInput,
  ChartPoint,
  NormalizedChart,
} from './chart-data'

export type EvidenceChartProps = {
  variant?: 'bar' | 'line' | 'sparkline' | 'area'
  data?: ChartPoint[]
  series?: ChartSeriesInput[]
  stacked?: boolean
  showAxis?: boolean
  showLegend?: boolean
  color?: string
  /** What the values measure, shown beside the title and on the table. */
  units?: string
  /** Where the data came from and when: the analysis service or the model. */
  source?: string
  /** A URL for the source, when one exists; only then is the caption a link. */
  sourceUrl?: string
  title?: string
  children?: React.ReactNode
}

const baseChart = defaultGenerativeUILibrary.Chart!
type View = 'chart' | 'data'
const labelOf = (chart: NormalizedChart, index: number) =>
  chart.series[index]?.label ?? `Series ${index + 1}`

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [width, setWidth] = useState(640)
  useIsomorphicLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = () =>
      setWidth(Math.max(160, Math.round(element.clientWidth)))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}

/** Inline and expanded views share data, selection and view mode. Expanding
 *  never requests data or runs the presentation operation again. */
export function EvidenceChart(props: EvidenceChartProps) {
  const [view, setView] = useState<View>('chart')
  const [selected, setSelected] = useState<number | null>(null)
  const { data, series } = props
  const chart = useMemo(() => normalizeChart({ data, series }), [data, series])
  const state = {
    props,
    chart,
    view,
    setView,
    selected:
      selected === null || !chart.count
        ? null
        : Math.min(selected, chart.count - 1),
    setSelected,
  }
  return (
    <Dialog>
      <ChartFrame
        {...state}
        expand={
          <DialogTrigger
            aria-label="Expand chart"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-sm text-ink-muted outline-focus hover:bg-hover hover:text-ink focus-visible:outline-2"
          >
            <Icon.Expand className="size-3.5" />
          </DialogTrigger>
        }
      />
      <DialogContent
        className="max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] overflow-y-auto rounded-md pt-10 sm:max-w-5xl"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{props.title ?? 'Chart'}</DialogTitle>
        <ChartFrame {...state} expanded />
      </DialogContent>
    </Dialog>
  )
}

type ChartFrameProps = {
  props: EvidenceChartProps
  chart: NormalizedChart
  view: View
  setView: (view: View) => void
  selected: number | null
  setSelected: (point: number) => void
  expanded?: boolean
  expand?: React.ReactNode
}

/** A material perimeter around an opaque, stable reading panel. */
function ChartFrame({
  props,
  chart,
  view,
  setView,
  selected,
  setSelected,
  expanded = false,
  expand,
}: ChartFrameProps) {
  const material = useSurfaceMaterial('chart')
  const liquid = material === 'glass' || material === 'liquid'
  const frameRef = useRef<HTMLElement>(null)
  useLiquidGlass(frameRef, liquid)
  const sourceHref = safeHref(props.sourceUrl)
  const named = chart.series.length > 1 || chart.series[0]?.label !== undefined
  const legend = props.showLegend ?? (named && props.variant !== 'sparkline')
  return (
    <figure
      ref={frameRef}
      data-slot="evidence-chart"
      data-surface-role="chart"
      data-expanded={expanded || undefined}
      className={cn(
        'response-frame evidence-chart my-2',
        liquid && 'surface-liquid',
      )}
    >
      <div className={responseToolbar}>
        <span
          data-appearance-recipe="ui.section"
          className="min-w-0 flex-1 truncate"
        >
          {props.title ?? 'Chart'}
        </span>
        {props.units && (
          <span
            data-appearance-recipe="metadata"
            className="min-w-0 truncate text-ink-muted"
          >
            {props.units}
          </span>
        )}
        <SegmentedControl size="sm" aria-label="Chart view">
          {(['chart', 'data'] as const).map((mode) => (
            <SegmentedControlItem
              key={mode}
              size="sm"
              aria-pressed={view === mode}
              data-pressed={view === mode ? '' : undefined}
              onClick={() => setView(mode)}
            >
              {mode === 'chart' ? 'Chart' : 'Data'}
            </SegmentedControlItem>
          ))}
        </SegmentedControl>
        {expand}
      </div>
      <div className="response-frame-body">
        <div className="evidence-chart-reading">
          {chart.count === 0 ? (
            <p className="py-4 text-sm text-ink-muted">No data points yet.</p>
          ) : view === 'chart' ? (
            <>
              <ChartPlot
                chart={chart}
                props={props}
                expanded={expanded}
                selected={selected}
                setSelected={setSelected}
              />
              {legend && (
                <div className="evidence-chart-legend" aria-label="Series">
                  {chart.series.map((entry, index) => {
                    const color = chartSeriesColor(
                      entry,
                      index,
                      chart.series.length,
                      props.color,
                    )
                    return (
                      <span
                        key={index}
                        className="evidence-chart-legend-item"
                        data-series={index}
                      >
                        <span
                          className="evidence-chart-legend-swatch"
                          aria-hidden="true"
                          style={{
                            background: index % 2 === 1 ? 'transparent' : color,
                            ...(index % 2 === 1 && {
                              backgroundImage: `repeating-linear-gradient(90deg, ${color} 0 3px, transparent 3px 6px)`,
                            }),
                          }}
                        />
                        {labelOf(chart, index)}
                      </span>
                    )
                  })}
                </div>
              )}
            </>
          ) : (
            <div className="overflow-x-auto">
              <table
                data-slot="evidence-chart-table"
                className="w-full border-collapse text-sm"
              >
                <caption className="sr-only">
                  {props.title ?? 'Chart'}
                  {props.units ? ` (${props.units})` : ''}
                </caption>
                <thead>
                  <tr className="border-b border-separator text-start">
                    <th
                      scope="col"
                      className="px-2 py-1 text-start font-medium text-ink-muted"
                    >
                      Point
                    </th>
                    {chart.series.map((_, index) => (
                      <th
                        key={index}
                        scope="col"
                        className="px-2 py-1 text-end font-medium text-ink-muted"
                      >
                        {named
                          ? labelOf(chart, index)
                          : (props.units ?? 'Value')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: chart.count }, (_, point) => (
                    <tr
                      key={point}
                      className={cn(
                        'border-b border-separator/60',
                        selected === point && 'bg-hover',
                      )}
                    >
                      <td className="px-2 py-1 text-ink-muted">
                        {chart.series[0]?.labels[point]}
                      </td>
                      {chart.series.map((entry, index) => (
                        <td
                          key={index}
                          className="px-2 py-1 text-end tabular-nums"
                        >
                          {entry.labels[point] !==
                            chart.series[0]?.labels[point] && (
                            <span className="me-1 text-ink-muted">
                              {entry.labels[point]}:
                            </span>
                          )}
                          {entry.values[point]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <figcaption
        data-appearance-recipe="metadata"
        className="flex items-start gap-1.5 border-t border-separator px-3 py-1.5 text-ink-muted"
      >
        <Icon.Link className="mt-0.5 size-3 shrink-0" />
        {sourceHref ? (
          <a
            href={sourceHref}
            target="_blank"
            rel="noreferrer"
            className="min-w-0 break-words text-link underline underline-offset-2"
          >
            {props.source || 'View source'}
          </a>
        ) : (
          <span className="min-w-0 break-words">
            {props.source || 'Source not provided'}
          </span>
        )}
      </figcaption>
    </figure>
  )
}

/** One focus stop inspects every point. Pointer/touch and keyboard selection
 *  read the same values as Data, including unrounded small measurements. */
function ChartPlot({
  chart,
  props,
  expanded,
  selected,
  setSelected,
}: {
  chart: NormalizedChart
  props: EvidenceChartProps
  expanded: boolean
  selected: number | null
  setSelected: (point: number) => void
}) {
  const { ref, width } = useWidth<HTMLDivElement>()
  const readoutId = useId()
  const variant = props.variant ?? 'line'
  const isBar = variant === 'bar'
  const sparkline = variant === 'sparkline'
  const showAxis = props.showAxis ?? !sparkline
  const stacked = props.stacked === true && (isBar || variant === 'area')
  const positioned = chartPositions(chart.series, stacked)
  const scale = axisScale(
    positioned.map((entry) => ({ ...entry, values: entry.ends })),
  )
  const height =
    sparkline && !showAxis
      ? 64
      : expanded
        ? width < 480
          ? 240
          : 320
        : width < 480
          ? 144
          : 200
  const ticks = tickValues(scale)
  const axisGutter = Math.max(
    40,
    ...ticks.map((tick) => formatValue(tick).length * 7 + 10),
  )
  const pad = showAxis
    ? { top: 16, right: 16, bottom: 24, left: axisGutter }
    : { top: 16, right: 10, bottom: 12, left: 10 }
  const plotW = Math.max(1, width - pad.left - pad.right)
  const plotH = height - pad.top - pad.bottom
  const slot = plotW / chart.count
  const x = (point: number) =>
    pad.left +
    (isBar
      ? slot * (point + 0.5)
      : chart.count === 1
        ? plotW / 2
        : (plotW * point) / (chart.count - 1))
  const y = (value: number) =>
    pad.top + plotH - ((value - scale.min) / (scale.max - scale.min)) * plotH
  const barW = (slot * 0.7) / (stacked ? 1 : chart.series.length)
  const labelStep = Math.max(
    1,
    Math.ceil(chart.count / Math.max(1, Math.floor(plotW / 60))),
  )
  const pointText = (series: number, point: number) => {
    const entry = chart.series[series]!
    return `${labelOf(chart, series)}, ${entry.labels[point]}: ${entry.values[point]}${props.units ? ` ${props.units}` : ''}`
  }
  const inspectPointer = (clientX: number) => {
    const box = ref.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    const position = ((clientX - box.left) * width) / box.width - pad.left
    const point = isBar
      ? Math.floor(position / slot)
      : Math.round((position / plotW) * (chart.count - 1))
    setSelected(Math.max(0, Math.min(chart.count - 1, point)))
  }
  return (
    <div>
      <div
        ref={ref}
        role="group"
        tabIndex={0}
        data-slot="chart-inspector"
        aria-label="Inspect chart values"
        aria-describedby={readoutId}
        aria-keyshortcuts="ArrowLeft ArrowRight Home End"
        className="w-full rounded-sm outline-focus focus-visible:outline-2 focus-visible:outline-offset-2"
        onFocus={() => {
          if (selected === null) setSelected(0)
        }}
        onKeyDown={(event) => {
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? chart.count - 1
                : event.key === 'ArrowRight'
                  ? Math.min(chart.count - 1, (selected ?? -1) + 1)
                  : event.key === 'ArrowLeft'
                    ? Math.max(0, (selected ?? 1) - 1)
                    : null
          if (next === null) return
          event.preventDefault()
          setSelected(next)
        }}
        onPointerMove={(event) => {
          if (event.pointerType !== 'touch' || event.buttons)
            inspectPointer(event.clientX)
        }}
        onPointerDown={(event) => inspectPointer(event.clientX)}
      >
        <svg
          className="evidence-chart-plot"
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          style={{ height }}
          role="img"
          aria-label={`${props.title ?? 'Chart'}${props.units ? ` (${props.units})` : ''}. ${chart.count} points. ${chart.series.map((_, i) => labelOf(chart, i)).join(', ')}. Values are available in Data view.`}
          data-variant={variant}
          data-stacked={stacked || undefined}
        >
          {showAxis && (
            <g data-slot="chart-axes">
              {ticks.map((tick, index) => (
                <g key={index}>
                  <line
                    className="evidence-chart-grid"
                    x1={pad.left}
                    x2={width - pad.right}
                    y1={y(tick)}
                    y2={y(tick)}
                  />
                  <text x={pad.left - 6} y={y(tick) + 3} textAnchor="end">
                    {formatValue(tick)}
                  </text>
                </g>
              ))}
              <line
                className="evidence-chart-axis"
                x1={pad.left}
                x2={width - pad.right}
                y1={y(0)}
                y2={y(0)}
              />
              {chart.series[0]?.labels.map((label, point) =>
                point % labelStep === 0 || point === chart.count - 1 ? (
                  <text
                    key={point}
                    x={x(point)}
                    y={height - 6}
                    textAnchor="middle"
                  >
                    {label}
                  </text>
                ) : null,
              )}
            </g>
          )}
          {selected !== null && (
            <line
              x1={x(selected)}
              x2={x(selected)}
              y1={pad.top}
              y2={height - pad.bottom}
              stroke="var(--ink-muted)"
              strokeDasharray="2 3"
            />
          )}
          {positioned.map((entry, index) => {
            const color = chartSeriesColor(
              entry,
              index,
              chart.series.length,
              props.color,
            )
            if (isBar)
              return entry.values.map((_, point) => (
                <rect
                  key={`${index}-${point}`}
                  x={
                    pad.left +
                    slot * point +
                    slot * 0.15 +
                    (stacked ? 0 : index * barW)
                  }
                  y={Math.min(y(entry.starts[point]!), y(entry.ends[point]!))}
                  width={barW}
                  height={Math.abs(
                    y(entry.starts[point]!) - y(entry.ends[point]!),
                  )}
                  fill={color}
                  data-series={index}
                  data-point={point}
                >
                  <title>{pointText(index, point)}</title>
                </rect>
              ))
            const points = entry.ends.map(
              (value, point) => `${x(point)},${y(value)}`,
            )
            const last = entry.values.length - 1
            return (
              <g key={index} data-series={index} style={{ color }}>
                {variant === 'area' && chart.count > 1 && (
                  <polygon
                    className="evidence-chart-area"
                    points={[
                      ...points,
                      ...entry.starts
                        .map((value, point) => `${x(point)},${y(value)}`)
                        .reverse(),
                    ].join(' ')}
                    fill={color}
                  />
                )}
                <polyline
                  className="evidence-chart-line"
                  points={points.join(' ')}
                  stroke={color}
                  strokeDasharray={index % 2 === 1 ? '6 4' : undefined}
                />
                {entry.ends.map((value, point) => (
                  <circle
                    key={point}
                    cx={x(point)}
                    cy={y(value)}
                    r={
                      point === selected
                        ? 4
                        : sparkline && chart.count > 1
                          ? 0
                          : 2.5
                    }
                    fill={color}
                    data-point={point}
                  >
                    <title>{pointText(index, point)}</title>
                  </circle>
                ))}
                {!sparkline && last >= 0 && (
                  <text
                    className="evidence-chart-endpoint"
                    x={x(last)}
                    y={y(entry.ends[last]!) - 6}
                    textAnchor="end"
                  >
                    {formatValue(entry.values[last]!)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <div
        id={readoutId}
        data-slot="chart-readout"
        role="status"
        aria-atomic="true"
        className="min-h-9 pt-2 text-xs leading-relaxed text-ink-muted"
      >
        {selected === null ? (
          'Point to a value, or focus the chart and use Left and Right to inspect.'
        ) : (
          <span className="flex flex-wrap gap-x-3 tabular-nums">
            {chart.series.map((_, index) => (
              <span key={index}>{pointText(index, selected)}</span>
            ))}
          </span>
        )}
      </div>
    </div>
  )
}

export const evidenceChartDefinition: GenerativeUILibrary[string] = {
  ...baseChart,
  description:
    'A chart with its evidence. Inspect values, open Data or expand the same dataset. `variant` selects bar, line, sparkline or area; `data` is one series, `series` several. Name `units` and `source` so the reader knows what the values measure and where they came from.',
  properties: (baseChart.properties as z.ZodObject).extend({
    title: z.string().optional().describe('A short name for what is plotted.'),
    units: z.string().optional().describe('What the values measure.'),
    source: z
      .string()
      .optional()
      .describe(
        'Origin, date/range and transformations. Mark illustrative data explicitly.',
      ),
    sourceUrl: z
      .string()
      .optional()
      .describe('A URL for the source; only then is the caption a link.'),
  }),
  render: (props) => <EvidenceChart {...(props as EvidenceChartProps)} />,
}
