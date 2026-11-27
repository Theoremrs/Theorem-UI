// SOURCING: d3 (d3-brush, d3-force, d3-drag, d3-hierarchy's partition,
// d3-scale, d3-selection) and Observable Plot, both handed in from the
// notebook's own builtins so a view adds no second copy to the frame; the
// shapes follow Observable's examples (Plot's brushed scatterplot, "Force-
// directed graph", "Zoomable icicle", "Brushable scatterplot matrix"; ISC).
// The selection reaches the page through the frame's App bridge
// (`theorem.select`). No library packages "a D3 view whose selection becomes
// the next turn's context", so the drawing is d3's and the wiring is here.
//
// The views a reply reaches for most, as one call each from a cell:
// `views.linked`, `views.graph`, `views.tree`, `views.timeline` and
// `views.param`. Each returns an element with a `.value` and fires `input`,
// so `const picked = view(views.linked(...))` feeds other cells. Each redraws when
// its width or the page's theme changes, and stops its work while offscreen.
import type * as D3 from 'd3'
import type * as PlotLib from '@observablehq/plot'
import { THEME_EVENT, chartTheme, readTheme } from './theme'
import type { ChartTheme } from './theme'

type Row = Record<string, unknown>
type Accessor = string | ((row: Row, index: number) => unknown)

/** What a view remembers between a save and a reopen: its own state and the parameters. */
export interface SavedView {
  params?: Record<string, unknown>
  state?: Record<string, unknown>
}

/** What a view reports of the person's selection. `ids` name the records chosen. */
export interface ViewSelection {
  label: string
  ids?: Array<string>
  state?: Record<string, unknown>
}

interface Bridge {
  select?: (selection: ViewSelection | null) => unknown
}

const STYLE = `
.tv-view{display:flex;flex-direction:column;gap:8px;min-width:0;font:400 12px/18px var(--font-sans,system-ui,sans-serif);color:var(--ink)}
.tv-view svg{display:block;max-width:100%;overflow:visible}
.tv-view svg text{fill:var(--ink-muted)}
.tv-brush .selection{fill:var(--redwood);fill-opacity:.12;stroke:var(--redwood)}
.tv-dim{opacity:.22}
.tv-node{cursor:pointer;outline:none}
.tv-node circle{stroke:var(--surface-artifact);stroke-width:1.5}
.tv-node:focus-visible circle,.tv-node[aria-pressed=true] circle{stroke:var(--focus);stroke-width:2.5}
.tv-node text{fill:var(--ink);pointer-events:none}
.tv-link{stroke:var(--line-control);stroke-opacity:.6}
.tv-cell{cursor:pointer;outline:none}
.tv-cell:focus-visible rect{stroke:var(--focus);stroke-width:2}
.tv-cell text{fill:var(--ink);pointer-events:none}
.tv-table-wrap{max-height:240px;overflow:auto}
.tv-table{width:100%;border-collapse:collapse;font:400 13px/20px var(--font-sans,system-ui,sans-serif)}
.tv-table th{position:sticky;top:0;background:var(--surface-artifact);padding:4px 8px;text-align:start;font-weight:500;color:var(--ink-muted);border-bottom:1px solid var(--line-separator)}
.tv-table td{padding:4px 8px;border-bottom:1px solid var(--line-separator)}
.tv-table .num{text-align:end;font-variant-numeric:tabular-nums}
.tv-table tr[data-hover] td{background:var(--surface-hover)}
.tv-meta{color:var(--ink-muted)}
.tv-param{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.tv-moved{display:inline-flex;align-items:center;padding:0 6px;border-radius:4px;background:var(--ochre-container,var(--surface-hover));color:var(--ochre-ink,var(--ink));font:500 12px/20px var(--font-sans,system-ui,sans-serif)}
.tv-moved[hidden]{display:none}
@media (prefers-reduced-motion:reduce){.tv-view *{transition:none!important}}
`

const value = (row: Row, accessor: Accessor, index: number) =>
  typeof accessor === 'function' ? accessor(row, index) : row[accessor]

const text = (input: unknown) =>
  input instanceof Date ? input.toISOString().slice(0, 10) : String(input ?? '')

const MAX_IDS = 200

/**
 * The views, bound to the notebook's d3 and Plot. `saved` is what the view
 * was saved with, so a reopened artifact starts where it was left.
 */
export function createViews(
  d3: typeof D3,
  Plot: typeof PlotLib,
  saved: SavedView = {},
) {
  const restored = saved.state ?? {}
  const params: Record<string, unknown> = { ...saved.params }
  const state: Record<string, unknown> = {}
  const counts = new Map<string, number>()
  let latest: (ViewSelection & { key: string }) | null = null

  if (!document.querySelector('style[data-theorem-views]')) {
    const style = document.createElement('style')
    style.dataset.theoremViews = ''
    style.textContent = STYLE
    document.head.append(style)
  }

  /** The key a view keeps its state under: its own, or its kind and order. */
  const keyOf = (kind: string, key?: string) => {
    if (key) return key
    const count = (counts.get(kind) ?? 0) + 1
    counts.set(kind, count)
    return `${kind}${count}`
  }

  /** Tells the page what is selected now, with every view's state and the parameters. */
  const publish = () => {
    const bridge = (window as { theorem?: Bridge }).theorem
    const named = Object.keys(params).length > 0
    void bridge?.select?.(
      latest || named
        ? {
            label: latest?.label ?? 'Parameters',
            ids: latest?.ids?.slice(0, MAX_IDS),
            state: { ...state, ...(named && { params }) },
          }
        : null,
    )
  }

  /** A view's new state and selection; clearing a view clears only its own selection. */
  const report = (key: string, own: unknown, selection: ViewSelection | null) => {
    if (own === undefined) delete state[key]
    else state[key] = own
    if (selection) latest = { ...selection, key }
    else if (latest?.key === key) latest = null
    publish()
  }

  /**
   * A view's element: `draw` runs now and again whenever the width or the
   * theme changes; `pause` and `resume` follow whether it is on screen.
   */
  function host<T>(
    kind: string,
    draw: (root: HTMLElement, width: number, theme: ChartTheme) => void,
    initial: T,
    lifecycle: { pause?: () => void; resume?: () => void } = {},
  ) {
    const root = document.createElement('div')
    root.className = `tv-view tv-${kind}`
    let width = 0
    const redraw = () => {
      const next = Math.max(240, Math.round(root.clientWidth || 640))
      width = next
      root.replaceChildren()
      draw(root, width, chartTheme(readTheme()))
    }
    let current = initial
    Object.defineProperty(root, 'value', {
      get: () => current,
      set: (next: T) => (current = next),
    })
    const set = (next: T) => {
      current = next
      root.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const resized = new ResizeObserver(() => {
      if (Math.max(240, Math.round(root.clientWidth)) !== width) redraw()
    })
    const themed = () => redraw()
    const seen = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) lifecycle.resume?.()
      else lifecycle.pause?.()
    })
    // Drawn once attached, when the cell has a width to give it.
    queueMicrotask(() => {
      redraw()
      resized.observe(root)
      seen.observe(root)
      window.addEventListener(THEME_EVENT, themed)
    })
    // A cell that runs again replaces this element; its observers go with it.
    const gone = new MutationObserver(() => {
      if (root.isConnected || !root.dataset.drawn) return
      resized.disconnect()
      seen.disconnect()
      gone.disconnect()
      window.removeEventListener(THEME_EVENT, themed)
      lifecycle.pause?.()
    })
    queueMicrotask(() => {
      root.dataset.drawn = ''
      gone.observe(document.body, { childList: true, subtree: true })
    })
    return { root, set, redraw }
  }

  /** A table of records, each row linked to its mark. */
  function table(
    rows: Array<Row>,
    columns: Array<string>,
    onHover: (row: Row | undefined) => void,
  ) {
    const wrap = document.createElement('div')
    wrap.className = 'tv-table-wrap'
    const tableElement = document.createElement('table')
    tableElement.className = 'tv-table'
    const numeric = columns.map((column) =>
      rows.every((row) => row[column] == null || typeof row[column] === 'number'),
    )
    const head = tableElement.createTHead().insertRow()
    columns.forEach((column, index) => {
      const th = document.createElement('th')
      th.scope = 'col'
      th.textContent = column
      if (numeric[index]) th.className = 'num'
      head.append(th)
    })
    const body = tableElement.createTBody()
    for (const row of rows.slice(0, 200)) {
      const tr = body.insertRow()
      columns.forEach((column, index) => {
        const td = tr.insertCell()
        td.textContent = text(row[column])
        if (numeric[index]) td.className = 'num'
      })
      tr.addEventListener('pointerenter', () => {
        tr.dataset.hover = ''
        onHover(row)
      })
      tr.addEventListener('pointerleave', () => {
        delete tr.dataset.hover
        onHover(undefined)
      })
    }
    wrap.append(tableElement)
    return wrap
  }

  /**
   * A Plot of records with a brush, linked to a table of what the brush
   * holds. `x` and `y` name fields; `fill` colours by one; `id` and `label`
   * name each record. `mark` is `dot` (the default) or `line`.
   */
  function linked(
    data: Iterable<Row> | null | undefined,
    options: {
      x: Accessor
      y: Accessor
      id?: Accessor
      label?: Accessor
      fill?: Accessor
      r?: Accessor | number
      columns?: Array<string>
      height?: number
      noun?: string
      key?: string
      mark?: 'dot' | 'line'
    },
  ) {
    const rows = Array.from(data ?? [])
    const key = keyOf('linked', options.key)
    const id = options.id ?? ((_: Row, index: number) => String(index))
    const noun = options.noun ?? 'records'
    const columns =
      options.columns ?? Object.keys(rows[0] ?? {}).slice(0, 6)
    let extent = restored[key] as
      | { x: [number, number]; y: [number, number] }
      | undefined
    const inside = (row: Row, index: number, scales: { x: PlotLib.Scale; y: PlotLib.Scale }) => {
      if (!extent) return true
      const px = scales.x.apply(value(row, options.x, index)) as number
      const py = scales.y.apply(value(row, options.y, index)) as number
      return (
        px >= extent.x[0] && px <= extent.x[1] && py >= extent.y[0] && py <= extent.y[1]
      )
    }
    const { root, set } = host<Array<Row>>(
      'linked',
      (element, width, theme) => {
        const height = options.height ?? Math.round(Math.min(320, width * 0.55))
        const marks: Array<PlotLib.Markish> = [
          options.mark === 'line'
            ? Plot.line(rows, { x: options.x, y: options.y, stroke: options.fill ?? theme.series[0] })
            : Plot.dot(rows, {
                x: options.x,
                y: options.y,
                r: options.r ?? 3.5,
                fill: options.fill ?? theme.series[0],
                fillOpacity: 0.85,
              }),
        ]
        const plot = Plot.plot({
          width,
          height,
          grid: true,
          style: { background: 'transparent', color: theme.inkMuted, fontSize: '12px' },
          color: { range: theme.series, legend: options.fill !== undefined },
          marks,
        })
        const svg = (plot instanceof SVGSVGElement ? plot : plot.querySelector('svg'))!
        const scales = { x: plot.scale('x')!, y: plot.scale('y')! }
        const circles = Array.from(svg.querySelectorAll<SVGCircleElement>('circle'))
        const indexOf = (circle: Element) =>
          (circle as unknown as { __data__?: number }).__data__
        const tableSlot = document.createElement('div')
        const meta = document.createElement('div')
        meta.className = 'tv-meta'
        const paint = () => {
          const picked = rows.filter((row, index) => inside(row, index, scales))
          for (const circle of circles) {
            const index = indexOf(circle)
            circle.classList.toggle(
              'tv-dim',
              extent !== undefined && index !== undefined && !inside(rows[index]!, index, scales),
            )
          }
          meta.textContent = extent
            ? `${picked.length} of ${rows.length} ${noun}`
            : `${rows.length} ${noun}`
          tableSlot.replaceChildren(
            table(picked, columns, (row) => {
              for (const circle of circles) {
                const index = indexOf(circle)
                circle.classList.toggle(
                  'tv-dim',
                  row !== undefined && index !== undefined && rows[index] !== row,
                )
              }
              if (!row) paint()
            }),
          )
          return picked
        }
        const [x0, x1] = scales.x.range as [number, number]
        const [y1, y0] = scales.y.range as [number, number]
        const brush = d3
          .brush()
          .extent([
            [Math.min(x0, x1), Math.min(y0, y1)],
            [Math.max(x0, x1), Math.max(y0, y1)],
          ])
          .on('brush end', (event: D3.D3BrushEvent<unknown>) => {
            if (!event.sourceEvent) return
            const selection = event.selection as [[number, number], [number, number]] | null
            extent = selection
              ? { x: [selection[0][0], selection[1][0]], y: [selection[0][1], selection[1][1]] }
              : undefined
            const picked = paint()
            if (event.type !== 'end') return
            set(extent ? picked : rows)
            report(
              key,
              extent,
              extent
                ? {
                    label: `${picked.length} of ${rows.length} ${noun}`,
                    ids: picked.map((row) => text(value(row, id, rows.indexOf(row)))),
                  }
                : null,
            )
          })
        const layer = d3.select(svg).append('g').attr('class', 'tv-brush').call(brush)
        if (extent)
          layer.call(brush.move, [
            [extent.x[0], extent.y[0]],
            [extent.x[1], extent.y[1]],
          ])
        element.append(plot, meta, tableSlot)
        paint()
      },
      rows,
    )
    return root
  }

  /**
   * A force-directed graph of `nodes` and `links` (`source` and `target`
   * name node ids). Choosing a node, by pointer or Enter, selects it with its
   * neighbours. `group` colours nodes by one of their fields.
   */
  function graph(
    input: { nodes: Array<Row>; links: Array<Row> },
    options: { id?: string; label?: string; group?: string; height?: number; key?: string } = {},
  ) {
    const idKey = options.id ?? 'id'
    const labelKey = options.label ?? 'label'
    const key = keyOf('graph', options.key)
    const nodes = input.nodes.map((node) => ({ ...node })) as Array<Row & D3.SimulationNodeDatum>
    const links = input.links.map((link) => ({ ...link })) as Array<
      Row & D3.SimulationLinkDatum<Row & D3.SimulationNodeDatum>
    >
    const idOf = (node: Row) => text(node[idKey])
    const nameOf = (node: Row) => text(node[labelKey] ?? node[idKey])
    let chosen = restored[key] as string | undefined
    let simulation: D3.Simulation<Row & D3.SimulationNodeDatum, undefined> | undefined
    const neighbours = (nodeId: string) => {
      const near = new Set([nodeId])
      for (const link of links) {
        const source = idOf(link.source as Row)
        const target = idOf(link.target as Row)
        if (source === nodeId) near.add(target)
        if (target === nodeId) near.add(source)
      }
      return near
    }
    const { root, set } = host<Row | undefined>(
      'graph',
      (element, width, theme) => {
        simulation?.stop()
        const height = options.height ?? Math.round(Math.min(420, width * 0.65))
        const groups = Array.from(new Set(nodes.map((node) => text(node[options.group ?? '']))))
        const colour = d3.scaleOrdinal<string, string>().domain(groups).range(theme.series)
        const svg = d3
          .create('svg')
          .attr('viewBox', [-width / 2, -height / 2, width, height])
          .attr('width', width)
          .attr('height', height)
          .attr('role', 'group')
          .attr('aria-label', `${nodes.length} nodes, ${links.length} links`)
        const link = svg
          .append('g')
          .selectAll('line')
          .data(links)
          .join('line')
          .attr('class', 'tv-link')
        const node = svg
          .append('g')
          .selectAll<SVGGElement, Row & D3.SimulationNodeDatum>('g')
          .data(nodes)
          .join('g')
          .attr('class', 'tv-node')
          .attr('tabindex', 0)
          .attr('role', 'button')
          .attr('aria-label', nameOf)
        node
          .append('circle')
          .attr('r', 6)
          .attr('fill', (d) => (options.group ? colour(text(d[options.group])) : theme.series[0]!))
        node
          .append('text')
          .attr('x', 9)
          .attr('dy', '0.32em')
          .text((d) => (nodes.length <= 60 ? nameOf(d) : ''))
        const paint = () => {
          const near = chosen ? neighbours(chosen) : undefined
          node
            .classed('tv-dim', (d) => near !== undefined && !near.has(idOf(d)))
            .attr('aria-pressed', (d) => String(idOf(d) === chosen))
          link.classed(
            'tv-dim',
            (d) =>
              near !== undefined &&
              !(idOf(d.source as Row) === chosen || idOf(d.target as Row) === chosen),
          )
        }
        const choose = (d: Row) => {
          chosen = chosen === idOf(d) ? undefined : idOf(d)
          paint()
          const picked = chosen ? nodes.find((n) => idOf(n) === chosen) : undefined
          set(picked)
          report(
            key,
            chosen,
            chosen
              ? { label: `${nameOf(picked!)} and ${neighbours(chosen).size - 1} neighbours`, ids: [...neighbours(chosen)] }
              : null,
          )
        }
        node
          .on('click', (_, d) => choose(d))
          .on('keydown', (event: KeyboardEvent, d) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            choose(d)
          })
        simulation = d3
          .forceSimulation(nodes)
          .force(
            'link',
            d3.forceLink<Row & D3.SimulationNodeDatum, (typeof links)[number]>(links).id(idOf).distance(48),
          )
          .force('charge', d3.forceManyBody().strength(-140))
          .force('collide', d3.forceCollide(14))
          .force('x', d3.forceX())
          .force('y', d3.forceY())
          .on('tick', () => {
            link
              .attr('x1', (d) => (d.source as D3.SimulationNodeDatum).x!)
              .attr('y1', (d) => (d.source as D3.SimulationNodeDatum).y!)
              .attr('x2', (d) => (d.target as D3.SimulationNodeDatum).x!)
              .attr('y2', (d) => (d.target as D3.SimulationNodeDatum).y!)
            node.attr('transform', (d) => `translate(${d.x},${d.y})`)
          })
        const sim = simulation
        node.call(
          d3
            .drag<SVGGElement, Row & D3.SimulationNodeDatum>()
            .on('start', (event, d) => {
              if (!event.active) sim.alphaTarget(0.3).restart()
              d.fx = d.x
              d.fy = d.y
            })
            .on('drag', (event, d) => {
              d.fx = event.x
              d.fy = event.y
            })
            .on('end', (event, d) => {
              if (!event.active) sim.alphaTarget(0)
              d.fx = null
              d.fy = null
            }),
        )
        element.append(svg.node()!)
        paint()
      },
      undefined,
      {
        // Offscreen, the layout stops; back on screen, it settles from where it was.
        pause: () => simulation?.stop(),
        resume: () => {
          if (simulation && simulation.alpha() > simulation.alphaMin()) simulation.restart()
        },
      },
    )
    return root
  }

  /**
   * A hierarchy as a zoomable icicle: `root` is nested records whose
   * `children` hold more; leaves are sized by `value`. Choosing a cell zooms
   * to it; choosing the top cell zooms back out.
   */
  function tree(
    data: Row,
    options: { name?: string; children?: string; value?: string; height?: number; key?: string } = {},
  ) {
    const nameKey = options.name ?? 'name'
    const childrenKey = options.children ?? 'children'
    const valueKey = options.value ?? 'value'
    const key = keyOf('tree', options.key)
    const hierarchy = d3
      .hierarchy(data, (d) => d[childrenKey] as Array<Row> | undefined)
      .sum((d) => (typeof d[valueKey] === 'number' ? (d[valueKey]) : 0))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    const pathOf = (node: D3.HierarchyNode<Row>) =>
      node
        .ancestors()
        .reverse()
        .map((d) => text(d.data[nameKey]))
        .join(' / ')
    let focusPath = restored[key] as string | undefined
    const view = host<Row>(
      'tree',
      (element, width, theme) => {
        const height = options.height ?? Math.round(Math.min(360, width * 0.6))
        const laid = d3.partition<Row>().size([height, (hierarchy.height + 1) * (width / 3)])(
          hierarchy.copy(),
        )
        const cells = laid.descendants()
        const focus = cells.find((d) => pathOf(d) === focusPath) ?? laid
        const x = d3.scaleLinear().domain([focus.y0, focus.y0 + width]).range([0, width])
        const y = d3.scaleLinear().domain([focus.x0, focus.x1]).range([0, height])
        const colour = d3
          .scaleOrdinal<string, string>()
          .domain((laid.children ?? []).map((d) => text(d.data[nameKey])))
          .range(theme.series)
        const top = (d: D3.HierarchyRectangularNode<Row>) =>
          text((d.ancestors().reverse()[1] ?? d).data[nameKey])
        const svg = d3
          .create('svg')
          .attr('width', width)
          .attr('height', height)
          .attr('role', 'group')
          .attr('aria-label', pathOf(focus))
        const cell = svg
          .selectAll('g')
          .data(cells.filter((d) => y(d.x1) - y(d.x0) > 0.5 && x(d.y0) < width && x(d.y1) > 0))
          .join('g')
          .attr('class', 'tv-cell')
          .attr('tabindex', 0)
          .attr('role', 'button')
          .attr('aria-label', (d) => `${pathOf(d)}: ${d.value ?? 0}`)
          .attr('transform', (d) => `translate(${x(d.y0)},${y(d.x0)})`)
        cell
          .append('rect')
          .attr('width', (d) => Math.max(0, x(d.y1) - x(d.y0) - 1))
          .attr('height', (d) => Math.max(0, y(d.x1) - y(d.x0) - 1))
          .attr('fill', (d) => (d.depth ? colour(top(d)) : theme.lineStrong))
          .attr('fill-opacity', (d) => (d.children ? 0.75 : 0.5))
          .attr('rx', 2)
        cell
          .append('text')
          .attr('x', 4)
          .attr('y', 13)
          .text((d) => (y(d.x1) - y(d.x0) > 16 ? `${text(d.data[nameKey])} ${d.value ?? ''}` : ''))
        const zoom = (d: D3.HierarchyRectangularNode<Row>) => {
          const next = d === focus && d.parent ? d.parent : d
          focusPath = next === laid ? undefined : pathOf(next)
          view.set(next.data)
          report(key, focusPath, focusPath ? { label: focusPath, ids: [focusPath] } : null)
          view.redraw()
        }
        cell
          .on('click', (_, d) => zoom(d))
          .on('keydown', (event: KeyboardEvent, d) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            zoom(d)
          })
        element.append(svg.node()!)
      },
      data,
    )
    return view.root
  }

  /**
   * Events on lanes in time order, with a brush along time. Each event has a
   * `start`, an optional `end`, a `lane` and a `label`; the brush selects the
   * events it overlaps.
   */
  function timeline(
    events: Iterable<Row> | null | undefined,
    options: { start?: string; end?: string; lane?: string; label?: string; id?: string; height?: number; key?: string } = {},
  ) {
    const startKey = options.start ?? 'start'
    const endKey = options.end ?? 'end'
    const laneKey = options.lane ?? 'lane'
    const labelKey = options.label ?? 'label'
    const key = keyOf('timeline', options.key)
    const rows = Array.from(events ?? [])
    const date = (input: unknown) => new Date(input as string | number | Date)
    const span = (row: Row): [Date, Date] => [
      date(row[startKey]),
      row[endKey] == null ? date(row[startKey]) : date(row[endKey]),
    ]
    let range = (restored[key] as [string, string] | undefined)?.map(date) as
      | [Date, Date]
      | undefined
    const overlapping = () =>
      range
        ? rows.filter((row) => {
            const [a, b] = span(row)
            return b >= range![0] && a <= range![1]
          })
        : rows
    const { root, set } = host<Array<Row>>(
      'timeline',
      (element, width, theme) => {
        const lanes = Array.from(new Set(rows.map((row) => text(row[laneKey]))))
        const band = 22
        const margin = { top: 8, right: 12, bottom: 24, left: Math.min(140, width * 0.22) }
        const height = options.height ?? margin.top + margin.bottom + Math.max(1, lanes.length) * band
        const all = rows.flatMap(span)
        const x = d3
          .scaleTime()
          .domain(d3.extent(all) as [Date, Date])
          .nice()
          .range([margin.left, width - margin.right])
        const y = d3.scaleBand().domain(lanes).range([margin.top, height - margin.bottom]).padding(0.25)
        const colour = d3.scaleOrdinal<string, string>().domain(lanes).range(theme.series)
        const svg = d3.create('svg').attr('width', width).attr('height', height)
        svg
          .append('g')
          .attr('transform', `translate(0,${height - margin.bottom})`)
          .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(width / 110))))
          .call((g) => g.selectAll('path,line').attr('stroke', theme.lineStrong))
        svg
          .append('g')
          .attr('transform', `translate(${margin.left - 6},0)`)
          .call(d3.axisLeft(y).tickSize(0))
          .call((g) => g.select('.domain').remove())
        const marks = svg
          .append('g')
          .selectAll('rect')
          .data(rows)
          .join('rect')
          .attr('x', (row) => x(span(row)[0]))
          .attr('width', (row) => Math.max(3, x(span(row)[1]) - x(span(row)[0])))
          .attr('y', (row) => y(text(row[laneKey]))!)
          .attr('height', y.bandwidth())
          .attr('rx', 2)
          .attr('fill', (row) => colour(text(row[laneKey])))
        marks.append('title').text((row) => text(row[labelKey]))
        const meta = document.createElement('div')
        meta.className = 'tv-meta'
        const paint = () => {
          const picked = new Set(overlapping())
          marks.classed('tv-dim', (row) => range !== undefined && !picked.has(row))
          meta.textContent = range
            ? `${picked.size} of ${rows.length} events, ${text(range[0])} to ${text(range[1])}`
            : `${rows.length} events`
        }
        const brush = d3
          .brushX()
          .extent([
            [margin.left, margin.top],
            [width - margin.right, height - margin.bottom],
          ])
          .on('brush end', (event: D3.D3BrushEvent<unknown>) => {
            if (!event.sourceEvent) return
            const selection = event.selection as [number, number] | null
            range = selection ? [x.invert(selection[0]), x.invert(selection[1])] : undefined
            paint()
            if (event.type !== 'end') return
            const picked = overlapping()
            set(picked)
            report(
              key,
              range?.map((d) => d.toISOString()),
              range
                ? {
                    label: `${picked.length} events, ${text(range[0])} to ${text(range[1])}`,
                    ids: picked.map((row, index) => text(row[options.id ?? 'id'] ?? index)),
                  }
                : null,
            )
          })
        const layer = d3.select(svg.node()!).append('g').attr('class', 'tv-brush').call(brush)
        if (range) layer.call(brush.move, [x(range[0]), x(range[1])])
        element.append(svg.node()!, meta)
        paint()
      },
      rows,
    )
    return root
  }

  /**
   * An input the prose was written for, such as `Inputs.range(...)`. When
   * the person moves it off the value the reply assumed, the view says so,
   * and its value travels with the selection as a parameter named `name`.
   */
  function param<T extends HTMLElement & { value: unknown }>(input: T, name?: string) {
    const label = name ?? input.querySelector('label')?.textContent.trim() ?? 'value'
    const written = input.value
    if (Object.hasOwn(params, label)) {
      input.value = params[label]
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const wrap = document.createElement('div')
    wrap.className = 'tv-view tv-param'
    const moved = document.createElement('span')
    moved.className = 'tv-moved'
    const sync = () => {
      const changed = JSON.stringify(input.value) !== JSON.stringify(written)
      moved.hidden = !changed
      moved.textContent = `moved from ${Array.isArray(written) ? written.map(text).join(', ') : text(written)}`
      if (changed) params[label] = input.value
      else delete params[label]
    }
    input.addEventListener('input', () => {
      sync()
      publish()
    })
    sync()
    Object.defineProperty(wrap, 'value', {
      get: () => input.value,
      set: (next: unknown) => (input.value = next),
    })
    wrap.append(input, moved)
    return wrap
  }

  return { linked, graph, tree, timeline, param }
}

export type Views = ReturnType<typeof createViews>
