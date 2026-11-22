// SOURCING: none: the interactive-responses plan's three representative responses, in the SDK's own message shape. Every value is invented fixture data, clearly labelled as such in the reply text: the research answer's numbers are illustrative, not a measurement.
import type { Theorem } from '@/lib/theorem/client'

const ASKED_AT = Date.UTC(2026, 10, 19, 15)

const message = (
  messageId: string,
  role: Theorem.MessageRole,
  createdAtMs: number,
  parts: Theorem.StoredPart[],
): Theorem.Message => ({
  schema: 'theorem.chat.message.v1',
  messageId,
  tenantId: 'story',
  threadId: 'thread-responses',
  originBranchId: 'branch-main',
  role,
  parts,
  createdAtMs,
})

const said = (partId: string, text: string): Theorem.StoredPart => ({
  partId,
  type: 'text',
  payload: { text },
})

const citation = (
  partId: string,
  sourceId: string,
  label: string,
  url: string | undefined,
  excerpt: string | undefined,
  sourceKind = 'document',
): Theorem.StoredPart => ({
  partId,
  type: 'citation',
  payload: { sourceId, sourceKind, label, provenance: { url, excerpt } },
})

/** The chart the research answer paints: one ui.present tree, answered. */
const present = (
  partId: string,
  requestRef: string,
  tree: Record<string, unknown>,
): Theorem.StoredPart => ({
  partId,
  type: 'client_operation',
  payload: {
    requestRef,
    operation: 'ui.present',
    state: 'answered',
    args: tree,
    expectedRevision: 0,
    receipt: { outcome: 'applied', result: { painted: tree._type } },
  },
})

const LATENCY_TREE = {
  _type: 'Chart',
  variant: 'line',
  title: 'Median response time',
  units: 'ms',
  source: 'Illustrative fixture data · Nov 12–18',
  showAxis: true,
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

/** A research answer: prose, two inspectable sources (one cited twice, one
 *  whose preview metadata failed), a chart with its data view, and a
 *  comparison table — the plan's evidence slice in one reply. */
export function evidenceMessages(): Theorem.Message[] {
  return [
    message('evidence-ask', 'user', ASKED_AT, [
      said(
        'evidence-ask-text',
        'How do the two retrieval paths compare on latency, and what supports that?',
      ),
    ]),
    message('evidence-answer', 'assistant', ASKED_AT + 42_000, [
      said(
        'evidence-answer-text',
        "Both paths got faster over the week (fixture data). Search stays slower than Read because it ranks before it answers; the gap narrowed from 140ms to 90ms. The measurement notes below carry the exact passages; the second source's preview could not be loaded, so it stays a plain working link.",
      ),
      citation(
        'evidence-source-1',
        'notes-latency',
        'Retrieval latency notes',
        'https://notes.example.com/retrieval-latency',
        'Search p50 fell from 320ms to 210ms between Tue and Mon; Read p50 fell from 180ms to 120ms over the same window. Ranking accounts for most of the difference.',
      ),
      citation(
        'evidence-source-2',
        'report-weekly',
        'Weekly performance report',
        'https://reports.example.com/weekly/46',
        'Week 46 summary: both retrieval paths improved; the full tables are in the appendix.',
      ),
      citation(
        'evidence-source-1-again',
        'notes-latency',
        'Retrieval latency notes',
        'https://notes.example.com/retrieval-latency',
        'Search p50 fell from 320ms to 210ms between Tue and Mon; Read p50 fell from 180ms to 120ms over the same window. Ranking accounts for most of the difference.',
      ),
      present('evidence-chart', 'req-evidence-chart', LATENCY_TREE),
      present('evidence-table', 'req-evidence-table', {
        _type: 'Table',
        columns: [
          { label: 'Path' },
          { label: 'p50 start', align: 'end' },
          { label: 'p50 end', align: 'end' },
          { label: 'Change', align: 'end' },
        ],
        rows: [
          ['Search', '320ms', '210ms', '−34%'],
          ['Read', '180ms', '120ms', '−33%'],
        ],
      }),
      said(
        'evidence-answer-close',
        'The chart and the table are two views of the same fixture dataset; open Data on the chart to check them against each other.',
      ),
    ]),
  ]
}

/** A coding answer: a failed step kept beside the useful output, a source
 *  for the fix, and the changed file as a chip. Review/apply is Phase 2 and
 *  is not claimed here. */
export function codingMessages(): Theorem.Message[] {
  return [
    message('coding-ask', 'user', ASKED_AT, [
      said(
        'coding-ask-text',
        'The tile loader fails on the staging map. Fix it.',
      ),
    ]),
    message('coding-answer', 'assistant', ASKED_AT + 61_000, [
      said(
        'coding-answer-text',
        'The loader imported the tile helper from a path the staging build does not ship. I pointed it at the published module instead; the test run below passed after the change. One earlier attempt failed and is kept as a record.',
      ),
      {
        partId: 'coding-fail-call',
        type: 'tool_call',
        payload: {
          toolCallId: 'coding-fail',
          toolName: 'run_tests',
          argumentsText: '{"filter":"map"}',
        },
      },
      {
        partId: 'coding-fail-result',
        type: 'tool_result',
        payload: {
          toolCallId: 'coding-fail',
          toolName: 'run_tests',
          status: 'failed',
          safeOutput: {
            error:
              'Cannot resolve module ../../src/tiles/helper from examples/map/main.ts',
          },
        },
      },
      {
        partId: 'coding-fix-call',
        type: 'tool_call',
        payload: {
          toolCallId: 'coding-fix',
          toolName: 'edit_file',
          argumentsText: '{"path":"examples/map/main.ts"}',
        },
      },
      {
        partId: 'coding-fix-result',
        type: 'tool_result',
        payload: {
          toolCallId: 'coding-fix',
          toolName: 'edit_file',
          status: 'complete',
          safeOutput: { path: 'examples/map/main.ts', applied: true },
        },
      },
      {
        partId: 'coding-test-call',
        type: 'tool_call',
        payload: {
          toolCallId: 'coding-test',
          toolName: 'run_tests',
          argumentsText: '{"filter":"map"}',
        },
      },
      {
        partId: 'coding-test-result',
        type: 'tool_result',
        payload: {
          toolCallId: 'coding-test',
          toolName: 'run_tests',
          status: 'complete',
          safeOutput: { passed: 14, failed: 0 },
        },
      },
      citation(
        'coding-source',
        'docs-tiles',
        'Tile module layout',
        'https://docs.example.com/tiles/module-layout',
        'The published tile helpers live in src/tiles/url; the internal helper path is not part of the package exports.',
      ),
    ]),
  ]
}

/** A writing answer: a draft paragraph whose claims carry evidence status
 *  as citations beside the text. Claim-level annotation anchors are Phase 4;
 *  this fixture shows the vocabulary the plan names, not the editor marks. */
export function writingMessages(): Theorem.Message[] {
  return [
    message('writing-ask', 'user', ASKED_AT, [
      said(
        'writing-ask-text',
        'Draft the summary paragraph for the retrieval report and mark what is supported.',
      ),
    ]),
    message('writing-answer', 'assistant', ASKED_AT + 38_000, [
      said(
        'writing-answer-text',
        'Draft: "Retrieval latency improved across the week. Search remains slower than Read because it ranks results before answering. The improvement is likely to hold as traffic grows." The first two sentences are source-backed; the third is inferred and needs evidence before it ships.',
      ),
      citation(
        'writing-source-backed',
        'notes-latency',
        'Source-backed: latency notes',
        'https://notes.example.com/retrieval-latency',
        'Search p50 fell from 320ms to 210ms; Read p50 fell from 180ms to 120ms. Ranking accounts for most of the difference.',
      ),
      citation(
        'writing-inferred',
        'claim-projection',
        'Inferred: traffic projection',
        undefined,
        'No source establishes the projection; it follows from the trend plus an assumption about traffic. Find evidence or revise the sentence.',
      ),
    ]),
  ]
}
