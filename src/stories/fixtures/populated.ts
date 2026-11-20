// SOURCING: none: the design overhaul's populated fixture (docs/plans/design-overhaul.checklist.json), in the SDK's own message shape and lib/theorem/connections' roster shape, so neither can drift from the contract.
import type { ToolGroup } from '@/lib/theorem/connections'
import type { Pin } from '@/lib/theorem/sidebar-prefs'
import { message } from './thread'

/** A project and two sessions, so the shelf shows both tile kinds. */
export const POPULATED_PINS: readonly Pin[] = [
  { kind: 'project', id: 'project-atlas' },
  { kind: 'thread', id: 'thread-python-sdk' },
  { kind: 'thread', id: 'thread-graph-memory' },
]

const REPLY = `## Which layout loads faster

The **grid** wins on a cold start; the **list** wins once the gallery passes a few hundred apps. Both read the same \`useGallery()\` query, so the difference is all in how much each one draws on the first frame.

| Layout | First paint | Apps drawn at once | Memory at 500 apps |
| --- | --- | --- | --- |
| Grid | 180 ms | 24 | 61 MB |
| List | 240 ms | 60 | 38 MB |
| List, virtualised | 150 ms | 18 | 22 MB |

The grid draws fewer tiles up front because each one is larger, but every tile decodes a full-size preview. The list draws more rows, though each row is text and a 32px icon.

### What I would change

1. Virtualise the list with \`@tanstack/react-virtual\`, which the notes pane already uses.
2. Ask Theorem for \`preview=thumb\` on grid tiles instead of decoding the original image.
3. Keep \`staleTime\` at five minutes so switching layouts reads the cache rather than refetching.

\`\`\`tsx
const rows = useVirtualizer({
  count: apps.length,
  getScrollElement: () => scroller.current,
  estimateSize: () => 44,
})
\`\`\`

With those three changes the list is the faster layout at every size I tried, and the grid stays the better one for browsing by picture. I would ship the list as the default and keep the grid one click away.`

export const populatedMessages = (now: number) => [
  message(
    'message-ask',
    'user',
    'Compare the two gallery layouts. Which one loads faster, and what would you change?',
    now - 6 * 60_000,
  ),
  message('message-answer', 'assistant', REPLY, now - 5 * 60_000, [
    {
      partId: 'work-reasoning',
      type: 'reasoning',
      payload: { text: 'Measured both layouts against the gallery fixture at 50, 200 and 500 apps.' },
    },
    {
      partId: 'work-call-1',
      type: 'tool_call',
      payload: { toolCallId: 'work-1', toolName: 'read_file', argumentsText: '{"path":"src/gallery/gallery.tsx"}' },
    },
    {
      partId: 'work-result-1',
      type: 'tool_result',
      payload: { toolCallId: 'work-1', toolName: 'read_file', output: 'Read 212 lines.' },
    },
    {
      partId: 'work-call-2',
      type: 'tool_call',
      payload: { toolCallId: 'work-2', toolName: 'run_benchmark', argumentsText: '{"suite":"gallery-layouts"}' },
    },
    {
      partId: 'work-result-2',
      type: 'tool_result',
      payload: { toolCallId: 'work-2', toolName: 'run_benchmark', output: '3 layouts, 3 sizes, 9 runs each.' },
    },
  ]),
]

/** Plugins and skills as Theorem's GET /api/chat/v1/skills answers: two from a plugin, two standalone. */
export const POPULATED_SKILLS = {
  plugins: [{ id: 'writing', name: 'writing', description: 'Drafting and review', skillCount: 2 }],
  skills: [
    { id: 'pack-doc-review', name: 'Document review', description: 'Reads a draft and marks what to change', plugin: 'writing' },
    { id: 'pack-release-notes', name: 'Release notes', description: 'Turns merged changes into notes', plugin: 'writing' },
    { id: 'research-brief', name: 'Research brief', description: 'Gathers sources into a cited brief', plugin: null },
    { id: 'tidy-imports', name: 'Tidy imports', description: 'Sorts and prunes a module\'s imports', plugin: null },
  ],
}

/** Four MCP connections, one switched off in Settings, as GET /api/connections/v1/tools answers. */
export const POPULATED_ROSTER: ToolGroup[] = [
  {
    connectionId: 'github',
    label: 'GitHub',
    kind: 'github',
    enabled: true,
    tools: [
      { name: 'search_issues', title: 'Search issues', effect: 'read' },
      { name: 'create_issue', title: 'Create an issue', effect: 'write' },
    ],
  },
  {
    connectionId: 'mcp:linear',
    label: 'Linear',
    kind: 'mcp',
    enabled: true,
    tools: [{ name: 'list_issues', title: 'List issues', effect: 'read' }],
  },
  {
    connectionId: 'mcp:docs',
    label: 'Docs server',
    kind: 'mcp',
    enabled: true,
    tools: [{ name: 'search', title: 'Search the docs', effect: 'read' }],
  },
  {
    connectionId: 'mcp:figma',
    label: 'Figma',
    kind: 'mcp',
    enabled: false,
    tools: [{ name: 'get_file', title: 'Read a file', effect: 'read' }],
  },
]
