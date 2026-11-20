// SOURCING: chart-data (the one normalized dataset + truthful axis the plot,
// Data view and aria description share), the app's material resolver and
// useLiquidGlass for the glass frame, coss ui SegmentedControl for the
// Chart/Data switch, Icon for the marks, utils/href for a safe source link.
// The plot is Theorem's own SVG (the vocabulary's chart math is not
// exported); its series colors read the customizable --chart-1..5 slots.
import { useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import type { GenerativeUILibrary } from '@assistant-ui/generative-ui/react'
import { defaultGenerativeUILibrary } from '@assistant-ui/generative-ui/react'
import {
  SegmentedControl,
  SegmentedControlItem,
} from '@/components/coss/segmented-control'
import { Icon } from '@/components/icons'
import { useLiquidGlass } from '@/components/glass/liquid-glass/use-liquid-glass'
import { useSurfaceMaterial } from '@/lib/appearance'
import { cn } from '@/lib/utils'
import { safeHref } from '../utils/href'
import { useIsomorphicLayoutEffect } from '../utils/useIsomorphicLayoutEffect'
import { responseToolbar } from './surfaces'
import {
  axisScale,
  formatValue,
  normalizeChart,
  tickValues,
} from './chart-data'
import type { ChartSeriesInput, ChartPoint } from './chart-data'

type Point = ChartPoint
type Series = ChartSeriesInput

export type EvidenceChartProps = {
  variant?: 'bar' | 'line' | 'sparkline' | 'area'
  data?: Point[]
  series?: Series[]
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
  /** A short name for what is plotted. */
  title?: string
  children?: React.ReactNode
}

const baseChart = defaultGenerativeUILibrary.Chart!
const SERIES_SLOTS = 5
const seriesColor = (index: number) =>
  `var(--chart-${(index % SERIES_SLOTS) + 1})`

/** The plot's geometry: a left gutter for y ticks, a bottom band for x
 *  labels, and the drawing box between. Width is measured, not a fixed
 *  desktop viewBox, so a narrow chart keeps readable text. */
const PAD = { top: 12, right: 16, bottom: 22, left: 40 }

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

/**
 * The evidence chart: a glass frame (the material resolver owns the
 * perimeter) around a stable, opaque reading panel that carries the plot,
 * axes, labels and legend. The plot, the Data view and the aria description
 * all read one normalized dataset, so they cannot drift. Multiple series
 * always carry a legend and a dashed alternate line, so identity survives
 * even when two chosen hues are close.
 */
export function EvidenceChart(props: EvidenceChartProps) {
  const [view, setView] = useState<'chart' | 'data'>('chart')
  const { data, series } = props
  const chart = useMemo(() => normalizeChart({ data, series }), [data, series])
  const named = chart.series.length > 1 || chart.series[0]?.label !== undefined
  const labelOf = (index: number) =>
    chart.series[index]?.label ?? `Series ${index + 1}`
  const material = useSurfaceMaterial('chart')
  const liquid = material === 'glass' || material === 'liquid'
  const frameRef = useRef<HTMLElement>(null)
  useLiquidGlass(frameRef, liquid)
  const sourceHref = safeHref(props.sourceUrl)
  const description = chart.series
    .map(
      (entry, index) =>
        `${named ? labelOf(index) : 'Values'}: ${entry.values
          .map((value, point) => `${entry.labels[point]} ${formatValue(value)}`)
          .join(', ')}`,
    )
    .join('. ')

  return (
    <figure
      ref={frameRef}
      data-slot="evidence-chart"
      data-surface-role="chart"
      className={cn(
        'response-frame evidence-chart my-2',
        liquid && 'surface-liquid',
      )}
    >
      <div className={responseToolbar}>
        <span data-appearance-recipe="ui.section" className="min-w-0 truncate">
          {props.title ?? 'Chart'}
        </span>
        {props.units && (
          <span
            data-appearance-recipe="metadata"
            className="min-w-0 flex-1 truncate text-ink-muted"
          >
            {props.units}
          </span>
        )}
        <SegmentedControl size="sm" aria-label="Chart view">
          <SegmentedControlItem
            size="sm"
            aria-pressed={view === 'chart'}
            data-pressed={view === 'chart' ? '' : undefined}
            onClick={() => setView('chart')}
          >
            Chart
          </SegmentedControlItem>
          <SegmentedControlItem
            size="sm"
            aria-pressed={view === 'data'}
            data-pressed={view === 'data' ? '' : undefined}
            onClick={() => setView('data')}
          >
            Data
          </SegmentedControlItem>
        </SegmentedControl>
      </div>
      <div className="response-frame-body">
        <div className="evidence-chart-reading">
          {view === 'chart' ? (
            <>
              <ChartPlot
                chart={chart}
                variant={props.variant ?? 'line'}
                units={props.units}
                description={description}
              />
              {named && (
                <div className="evidence-chart-legend" aria-hidden>
                  {chart.series.map((_, index) => (
                    <span
                      key={index}
                      className="evidence-chart-legend-item"
                      data-series={index}
                    >
                      <span
                        className="evidence-chart-legend-swatch"
                        style={{
                          background:
                            index % 2 === 1 ? 'transparent' : seriesColor(index),
                          ...(index % 2 === 1 && {
                            backgroundImage: `repeating-linear-gradient(90deg, ${seriesColor(index)} 0 3px, transparent 3px 6px)`,
                          }),
                        }}
                      />
                      {labelOf(index)}
                    </span>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="overflow-x-auto">
              <table
                data-slot="evidence-chart-table"
                className="w-full border-collapse text-sm"
              >
                <thead>
                  <tr className="border-b border-separator text-start">
                    <th className="px-2 py-1 text-start font-medium text-ink-muted">
                      Point
                    </th>
                    {chart.series.map((_, index) => (
                      <th
                        key={index}
                        className="px-2 py-1 text-end font-medium text-ink-muted"
                      >
                        {named ? labelOf(index) : (props.units ?? 'Value')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Array.from({ length: chart.count }, (_, point) => (
                    <tr key={point} className="border-b border-separator/60">
                      <td className="px-2 py-1 text-ink-muted">
                        {chart.series[0]?.labels[point]}
                      </td>
                      {chart.series.map((entry, index) => (
                        <td
                          key={index}
                          className="px-2 py-1 text-end tabular-nums"
                        >
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
      {props.source && (
        <figcaption
          data-appearance-recipe="metadata"
          className="flex items-center gap-1.5 border-t border-separator px-3 py-1.5 text-ink-muted"
        >
          <Icon.Link className="size-3 shrink-0" />
          {sourceHref ? (
            <a
              href={sourceHref}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate text-link underline underline-offset-2"
            >
              {props.source}
            </a>
          ) : (
            <span className="min-w-0 truncate">{props.source}</span>
          )}
        </figcaption>
      )}
    </figure>
  )
}

/** The plot: a measured-width SVG on the reading panel. Gridlines and ticks
 *  from the truthful axis; each series a line (alternate series dashed) with
 *  an endpoint value label; bars for the bar variant. Colors read the
 *  customizable --chart-N slots. */
function ChartPlot({
  chart,
  variant,
  units,
  description,
}: {
  chart: ReturnType<typeof normalizeChart>
  variant: NonNullable<EvidenceChartProps['variant']>
  units: string | undefined
  description: string
}) {
  const { ref, width } = useWidth<HTMLDivElement>()
  // A compact plot for genuinely narrow frames; text keeps its size because
  // the viewBox is the measured width, not a fixed desktop box.
  const height = width < 480 ? 144 : 200
  const scale = axisScale(chart.series)
  const ticks = tickValues(scale)
  const plotW = Math.max(1, width - PAD.left - PAD.right)
  const plotH = height - PAD.top - PAD.bottom
  const x = (point: number) =>
    PAD.left +
    (chart.count <= 1 ? plotW / 2 : (plotW * point) / (chart.count - 1))
  const y = (value: number) =>
    PAD.top + plotH - ((value - scale.min) / (scale.max - scale.min)) * plotH
  const baseY = y(Math.max(scale.min, 0))
  const isBar = variant === 'bar'
  const slot = chart.count > 0 ? plotW / chart.count : plotW
  const barW = Math.max(2, (slot * 0.7) / chart.series.length)

  return (
    <div ref={ref} className="w-full">
      <svg
        className="evidence-chart-plot"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        style={{ height }}
        role="img"
        aria-label={units ? `${description}. Units: ${units}.` : description}
        data-variant={variant}
      >
        {ticks.map((tick, index) => (
          <g key={index}>
            <line
              className="evidence-chart-grid"
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text x={PAD.left - 6} y={y(tick) + 3} textAnchor="end">
              {formatValue(tick)}
            </text>
          </g>
        ))}
        <line
          className="evidence-chart-axis"
          x1={PAD.left}
          x2={width - PAD.right}
          y1={baseY}
          y2={baseY}
        />
        {chart.series[0]?.labels.map((label, point) => (
          <text
            key={point}
            x={isBar ? PAD.left + slot * (point + 0.5) : x(point)}
            y={height - 6}
            textAnchor="middle"
          >
            {label}
          </text>
        ))}
        {chart.series.map((entry, index) => {
          const color = seriesColor(index)
          if (isBar) {
            return entry.values.map((value, point) => {
              const bx =
                PAD.left +
                slot * point +
                slot * 0.15 +
                index * barW
              const by = y(Math.max(value, 0))
              const bh = Math.abs(baseY - y(value))
              return (
                <rect
                  key={`${index}-${point}`}
                  x={bx}
                  y={by}
                  width={barW}
                  height={Math.max(0, bh)}
                  fill={color}
                  data-series={index}
                />
              )
            })
          }
          const points = entry.values.map((value, point) => `${x(point)},${y(value)}`)
          const last = entry.values.length - 1
          return (
            <g key={index} data-series={index} style={{ color }}>
              {variant === 'area' && (
                <polygon
                  className="evidence-chart-area"
                  points={`${x(0)},${baseY} ${points.join(' ')} ${x(last)},${baseY}`}
                  fill={color}
                />
              )}
              <polyline
                className="evidence-chart-line"
                points={points.join(' ')}
                stroke={color}
                strokeDasharray={index % 2 === 1 ? '6 4' : undefined}
              />
              {entry.values.map((value, point) => (
                <circle key={point} cx={x(point)} cy={y(value)} r={2.5} fill={color} />
              ))}
              {last >= 0 && (
                <text
                  className="evidence-chart-endpoint"
                  x={x(last)}
                  y={y(entry.values[last]!) - 6}
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
  )
}

/** The vocabulary's Chart definition, extended with evidence props. The
 *  additions are optional, so a tree that only plots keeps working. */
export const evidenceChartDefinition: GenerativeUILibrary[string] = {
  ...baseChart,
  description:
    'A chart with its evidence. `variant` selects bar, line, sparkline or area; `data` is one series of {label, value} points, `series` several named ones. Name `units` and `source` so the reader knows what the values measure and where they came from; the Data view shows the same values as a table.',
  properties: (baseChart.properties as z.ZodObject).extend({
    title: z.string().optional().describe('A short name for what is plotted.'),
    units: z.string().optional().describe('What the values measure.'),
    source: z
      .string()
      .optional()
      .describe('Where the data came from and when (service, dataset, range).'),
    sourceUrl: z
      .string()
      .optional()
      .describe('A URL for the source; only then is the caption a link.'),
  }),
  render: (props) => <EvidenceChart {...(props as EvidenceChartProps)} />,
}
