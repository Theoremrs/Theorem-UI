import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { renderGenerativeUI } from '@assistant-ui/generative-ui/react'
import { styledGenerativeUILibrary } from '@/components/assistant-ui/elements/generative-ui'
import { a2uiActionMessage, openUrlOf, presentation, withUnknownDrawn } from './a2ui'
import { inVocabulary } from './operations'

/** A surface in an agent's own catalog: basic components and two it invented. */
const OPERATIONS = [
  {
    version: 'v0.9',
    createSurface: { surfaceId: 'ops', catalogId: 'https://agent.example/catalogs/ops.json' },
  },
  {
    version: 'v0.9',
    updateComponents: {
      surfaceId: 'ops',
      components: [
        { id: 'root', component: 'Column', children: ['title', 'gauge', 'retry'] },
        { id: 'title', component: 'Text', text: { path: '/title' } },
        { id: 'gauge', component: 'Gauge', label: 'Load', value: { path: '/load' }, unit: '%', children: ['note'] },
        { id: 'note', component: 'Text', text: 'Rising since noon' },
        {
          id: 'retry',
          component: 'RetryChip',
          label: 'Retry the job',
          action: { event: { name: 'retry', context: { job: 'nightly' } } },
        },
      ],
    },
  },
  { version: 'v0.9', updateDataModel: { surfaceId: 'ops', path: '/', value: { title: 'Cluster', load: 72 } } },
]

const html = (tree: unknown) =>
  renderToStaticMarkup(<>{renderGenerativeUI(tree, styledGenerativeUILibrary, { status: 'done' })}</>)

describe('agent A2UI', () => {
  test('a surface from another catalog, with components the vocabulary does not name, is drawn whole', () => {
    const { trees, painted, warnings } = presentation({ a2ui: OPERATIONS }, inVocabulary)
    expect(painted).toEqual(['ops'])
    expect(trees).toHaveLength(1)
    const markup = html(trees[0]?.tree)
    for (const text of ['Cluster', 'Load', '72', 'unit', '%', 'Rising since noon', 'Retry the job'])
      expect(markup).toContain(text)
    expect(warnings.some((line) => line.includes('"Gauge"'))).toBe(true)
    expect(warnings.some((line) => line.includes('"RetryChip"'))).toBe(true)
  })

  test('an invented component keeps its action, which tells the agent what the reader did', () => {
    const { trees } = presentation({ a2ui: OPERATIONS }, inVocabulary)
    const actions: Array<unknown> = []
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk)
      if (!node || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      if (record.$action) actions.push(record.$action)
      walk(record.children)
    }
    walk(trees[0]?.tree)
    expect(actions).toHaveLength(1)
    const message = a2uiActionMessage(actions[0] as Record<string, unknown>)
    expect(message).toContain('"retry"')
    expect(message).toContain('nightly')
  })

  test('a `_type` tree naming an unknown component is drawn from its properties', () => {
    const { trees, painted, warnings } = presentation(
      { _type: 'Sparkline', label: 'Latency', value: '41 ms' },
      inVocabulary,
    )
    expect(painted).toEqual(['Sparkline'])
    expect(html(trees[0]?.tree)).toContain('41 ms')
    expect(warnings[0]).toContain('"Sparkline"')
  })

  test('known components pass through untouched', () => {
    const tree = { _type: 'Card', children: [{ _type: 'Text', value: 'hi' }] }
    expect(withUnknownDrawn(tree, inVocabulary)).toEqual({ tree, unknown: [] })
  })

  test('operations the reducer cannot read are reported, not thrown', () => {
    const { painted, warnings } = presentation({ a2ui: [{ nonsense: true }] }, inVocabulary)
    expect(painted).toEqual([])
    expect(warnings.length).toBeGreaterThan(0)
  })

  test('a message stamped with a version the reducer does not read says which versions it does', () => {
    const unstamped = OPERATIONS.map(({ version: _, ...message }) => ({ ...message, version: '0.9' }))
    const { painted, warnings } = presentation({ a2ui: unstamped }, inVocabulary)
    expect(painted).toEqual([])
    expect(warnings.at(-1)).toBe('Each message needs "version" set to "v0.9", "v0.9.1", "v1.0".')
  })

  test('a component written in another shape is answered with the shape the reducer reads', () => {
    const nested = [
      OPERATIONS[0],
      { version: 'v0.9', updateComponents: { surfaceId: 'ops', components: [{ id: 'root', component: { Text: { text: 'Hi' } } }] } },
    ]
    const { painted, warnings } = presentation({ a2ui: nested }, inVocabulary)
    expect(painted).toEqual([])
    expect(warnings.some((line) => line.includes('"component": "Gauge"'))).toBe(true)
  })

  test('openUrl opens web addresses only', () => {
    const call = (url: string) => ({ type: 'a2ui:functionCall', call: 'openUrl', args: { url } })
    expect(openUrlOf(call('https://example.com/a'))).toBe('https://example.com/a')
    expect(openUrlOf(call('javascript:alert(1)'))).toBeUndefined()
  })
})
