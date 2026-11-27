"use client";

import { Component, lazy, Suspense  } from "react";
import type {ReactNode} from "react";
import type { GenerativeUILibrary } from "@assistant-ui/generative-ui/react";
import { defaultGenerativeUILibrary } from "@assistant-ui/generative-ui/react";
import { z } from "zod";
import {
  DependencyGraph,
  GraphNodeSchema,
  graphOf,
} from "./dependency-graph";
import { GenerativeMarkdown } from "./generative-markdown";
import { cn } from "@/lib/utils";
import { bareDrawing } from "./surfaces";
import { GeoMap  } from "./geo-map";
import type {GeoMapPlace} from "./geo-map";
import { evidenceChartDefinition } from "./evidence-chart";
import {
  DataTable
  
  
  
} from "./data-table";
import type {DataTableColumn, DataTableRow, DataTableValue} from "./data-table";

// The diagram engine (beautiful-mermaid and elkjs) is large, so it loads only
// when a Diagram actually renders. The fallback matches the diagram's own
// rendering skeleton, so nothing shifts when the chunk arrives. Server
// rendering still outputs the finished diagram through the Suspense boundary.
const MermaidDiagram = lazy(() =>
  import("./mermaid-diagram").then((mod) => ({ default: mod.MermaidDiagram })),
);

// A View runs Observable cells: Notebook Kit's compiler and the notebook
// runtime load only when a reply carries one.
const InteractiveView = lazy(() =>
  import("./interactive-view").then((mod) => ({ default: mod.InteractiveView })),
);

const DiagramSkeleton = () => (
  <div
    data-slot="mermaid-skeleton"
    aria-label="Rendering diagram"
    aria-busy="true"
    className={cn(
      "aui-mermaid-skeleton bg-muted flex h-32 animate-pulse items-center justify-center gap-3 rounded-b-lg p-4",
      bareDrawing,
    )}
  >
    <div className="bg-muted-foreground/20 h-8 w-20 rounded-md" />
    <div className="bg-muted-foreground/20 h-px w-10" />
    <div className="bg-muted-foreground/20 h-8 w-20 rounded-md" />
    <div className="bg-muted-foreground/20 h-px w-10" />
    <div className="bg-muted-foreground/20 h-8 w-20 rounded-md" />
  </div>
);

const markdownBase = defaultGenerativeUILibrary.Markdown!;

// The vocabulary's Table, drawn by assistant-ui's data-table element: the
// same columns and rows of cells the model already writes, with that
// element's formats (currency, deltas, badges, relative dates, links),
// header sorting, and a card per row when the column is narrow.
// One object with a `kind` rather than a union per kind: the model-facing
// schema stays inside the server's 8 KB cap (lib/generative/operations).
const tableFormat = z.object({
  kind: z.enum([
    "text",
    "number",
    "currency",
    "percent",
    "delta",
    "date",
    "boolean",
    "link",
    "badge",
    "list",
  ]),
  currency: z.string().optional(),
  decimals: z.number().optional(),
  unit: z.string().optional(),
  upIsGood: z.boolean().optional(),
  style: z.enum(["date", "datetime", "relative"]).optional(),
  tones: z
    .record(z.string(), z.enum(["neutral", "success", "warning", "danger"]))
    .optional(),
});
const tableCell = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number()])),
]);
const TableProperties = z.object({
  columns: z
    .array(
      z.object({
        label: z.string(),
        format: tableFormat.optional(),
        align: z.enum(["start", "end"]).optional(),
        priority: z.enum(["primary", "secondary"]).optional(),
      }),
    )
    .optional(),
  rows: z.array(z.array(tableCell)).optional(),
  caption: z.string().optional(),
});

/** A column's cells under a key of their own: `c0`, `c1`, ... */
const columnKey = (index: number) => `c${index}`;

function GenerativeTable({
  columns,
  rows,
  caption,
}: z.infer<typeof TableProperties>) {
  const tableColumns: DataTableColumn[] = (columns ?? []).map(
    ({ format, ...column }, index) => ({
      ...column,
      key: columnKey(index),
      // Currency needs a code; a currency column without one reads as numbers.
      format:
        format?.kind === "currency" && !format.currency
          ? { ...format, kind: "number" }
          : (format as DataTableColumn["format"]),
    }),
  );
  const tableRows: DataTableRow[] = (rows ?? [])
    .filter(Array.isArray)
    .map((row) =>
      Object.fromEntries(
        row.map((cell, index) => [columnKey(index), cell as DataTableValue]),
      ),
    );
  return (
    <DataTable
      columns={tableColumns}
      rows={tableRows}
      caption={caption}
    />
  );
}

const pinsOf = (places: unknown): GeoMapPlace[] =>
  (Array.isArray(places) ? places : []).flatMap((place: unknown, index) => {
    if (place === null || typeof place !== "object") return [];
    const { label, lat, lng, detail } = place as Record<string, unknown>;
    return typeof label === "string" &&
      typeof lat === "number" &&
      typeof lng === "number"
      ? [
          {
            id: String(index),
            label,
            lat,
            lng,
            description: typeof detail === "string" ? detail : undefined,
          },
        ]
      : [];
  });

// If the diagram chunk fails to load, show the source instead of throwing.
class DiagramBoundary extends Component<
  { code: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        data-slot="mermaid-fallback"
        className="aui-mermaid-fallback bg-muted/75 rounded-b-lg"
      >
        <pre className="overflow-x-auto p-4 text-sm">
          {this.props.code.trim()}
        </pre>
      </div>
    );
  }
}

/** `MarkdownTextPrimitive` cannot be reused here: it reads from message-part context, not a prop string. */
export const styledGenerativeUILibrary: GenerativeUILibrary = {
  ...defaultGenerativeUILibrary,
  // The chart carries its evidence: units, provenance, and a Data view of
  // the same series (interactive-responses plan §6).
  Chart: evidenceChartDefinition,
  Table: {
    description:
      "Tabular data: `columns` and `rows`, each row an array of cells matching the columns. A column's `format` presents its cells (number, currency, percent, delta, date, boolean, link, badge, list); the `primary` column titles each row's card when the table is narrow.",
    properties: TableProperties,
    render: GenerativeTable,
  },
  Markdown: {
    properties: markdownBase.properties,
    streamProperties: markdownBase.streamProperties,
    description: "A markdown string, rendered with GitHub-flavored markdown.",
    render: GenerativeMarkdown,
  },
  Diagram: {
    ...defaultGenerativeUILibrary.Diagram!,
    render: ({ code, title }) => (
      <figure data-aui="diagram">
        <DiagramBoundary code={typeof code === "string" ? code : ""}>
          <Suspense fallback={<DiagramSkeleton />}>
            <MermaidDiagram
              code={typeof code === "string" ? code : ""}
              className={bareDrawing}
            />
          </Suspense>
        </DiagramBoundary>
        {typeof title === "string" || typeof title === "number" ? (
          <figcaption data-aui="diagram-title">{title}</figcaption>
        ) : null}
      </figure>
    ),
  },
  // The agent picks the drawing: Diagram for Mermaid source, Graph for a DAG
  // of nodes, laid out by assistant-ui's flow-graph element.
  Graph: {
    description:
      "A DAG of nodes and what each depends on, such as the steps of a plan, drawn left to right. For a dependency graph, use it rather than Diagram.",
    properties: z.object({
      nodes: z
        .array(GraphNodeSchema)
        .describe("The nodes; each names the ids it follows in dependsOn."),
    }),
    render: ({ nodes }) => {
      const graph = graphOf({ nodes });
      return graph ? <DependencyGraph data-aui="graph" graph={graph} /> : null;
    },
  },
  // Agent-written Observable cells, run in the sandboxed notebook frame: the
  // person works the view without a model turn (interactive-views plan).
  View: {
    description:
      "Live Observable cells the reader works. Each string in `cells` is one Observable JavaScript cell; `data` is any JSON the cells read as `data`.",
    properties: z.object({
      id: z
        .string()
        .optional()
        .describe("Names the view for receipts and ui.view; presented again in this reply, it is revised in place."),
      title: z.string().optional(),
      cells: z.array(z.string()),
      data: z.unknown().optional(),
      caption: z.string().optional(),
      source: z.string().optional(),
      sourceUrl: z.string().optional(),
    }),
    render: (props) => (
      <Suspense
        fallback={
          <p role="status" className="py-3 text-sm text-ink-muted">
            Starting the view…
          </p>
        }
      >
        <InteractiveView {...props} />
      </Suspense>
    ),
  },
  Map: {
    ...defaultGenerativeUILibrary.Map!,
    render: ({ places, route }) => {
      const pins = pinsOf(places);
      return (
        <GeoMap
          data-aui="map"
          className="max-w-none [&_[data-slot=geo-map-coordinates]]:hidden"
          places={pins}
          routes={
            route && pins.length > 1
              ? [
                  {
                    id: "route",
                    points: pins.map(({ lat, lng }) => [lat, lng] as const),
                  },
                ]
              : undefined
          }
        />
      );
    },
  },
};
