import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { styledGenerativeUILibrary } from '@/components/assistant-ui/elements/generative-ui'
import { presentation } from '@/lib/generative/a2ui'
import { inVocabulary } from '@/lib/generative/operations'
import { cellProblems, transpileCell } from '@/lib/notebooks/cells'
import { recordProblems } from './contract'
import {
  DISPLAYED_CAPABILITIES,
  INTERFACE_RECORDS,
  PRESENT_EXAMPLES,
  RENDERER_VERSION,
  VOCABULARY_EXAMPLES,
} from './records'

type Node = Record<string, unknown>
const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Every node with a `_type` in a tree, depth first. */
function nodesOf(tree: unknown): Array<Node> {
  if (Array.isArray(tree)) return tree.flatMap(nodesOf)
  if (!isNode(tree)) return []
  return [...(typeof tree._type === 'string' ? [tree] : []), ...nodesOf(tree.children)]
}

const examples = INTERFACE_RECORDS.flatMap((record) =>
  (record.examples ?? []).map((example) => ({ record: record.id, ...example })),
)

describe('interface capability records', () => {
  test('stay inside the bounds the server admits', () => {
    expect(recordProblems(INTERFACE_RECORDS)).toEqual([])
  })

  test('name only records that exist', () => {
    const ids = new Set([...INTERFACE_RECORDS.map((record) => record.id), ...DISPLAYED_CAPABILITIES])
    const dangling = INTERFACE_RECORDS.flatMap((record) =>
      [...(record.related ?? []), ...('formats' in record ? record.formats : [])]
        .filter((id) => !ids.has(id))
        .map((id) => `${record.id} -> ${id}`),
    )
    expect(dangling).toEqual([])
  })

  test('hold one record per vocabulary component, with its real schema', () => {
    for (const name of Object.keys(styledGenerativeUILibrary)) {
      const record = INTERFACE_RECORDS.find((entry) => entry.id === `component:${name}`)
      expect(record?.kind).toBe('component')
      if (record?.kind === 'component') expect(record.props).toMatchObject({ type: 'object' })
    }
  })

  test('pin the renderer version that is installed', () => {
    const installed = JSON.parse(
      readFileSync('node_modules/@assistant-ui/generative-ui/package.json', 'utf8'),
    ) as { version: string }
    expect(RENDERER_VERSION).toBe(installed.version)
  })

  test('every Observable example compiles and will run as written', () => {
    const views = examples.flatMap((example) => nodesOf(example.arguments).filter((node) => node._type === 'View'))
    expect(views.length).toBeGreaterThan(4)
    for (const view of views) {
      const cells = view.cells as Array<string>
      cells.forEach((cell, index) => expect(() => transpileCell(cell, index)).not.toThrow())
      expect(cellProblems(cells)).toEqual([])
    }
  })

  test('every composed example validates against the vocabulary', () => {
    const trees = [...Object.values(VOCABULARY_EXAMPLES), PRESENT_EXAMPLES.decision]
    for (const tree of trees)
      for (const node of nodesOf(tree)) {
        const definition = styledGenerativeUILibrary[node._type as string]
        expect(definition).toBeDefined()
        const { _type, _action, _key, children, ...props } = node
        const parsed = definition!.properties.safeParse(props)
        if (!parsed.success) throw new Error(`${String(_type)}: ${parsed.error.message}`)
      }
  })

  test('every present example paints with no warnings', () => {
    for (const example of examples.filter((entry) => entry.operation === 'ui.present')) {
      const painted = presentation(example.arguments as Node, inVocabulary)
      expect({ id: example.record, painted: painted.painted.length > 0, warnings: painted.warnings }).toEqual({
        id: example.record,
        painted: true,
        warnings: [],
      })
    }
  })

  test('A2UI names marked undrawn are drawn from their properties, and mapped ones are not', () => {
    const surface = (component: string) => ({
      a2ui: [
        { version: 'v0.9', createSurface: { surfaceId: 's', catalogId: 'basic' } },
        { version: 'v0.9', updateComponents: { surfaceId: 's', components: [{ id: 'root', component, text: 'x', label: 'x' }] } },
      ],
    })
    const undrawn = INTERFACE_RECORDS.filter((record) => record.kind === 'component' && !record.implemented)
    expect(undrawn.map((record) => record.id)).toEqual(['component:a2ui.Video', 'component:a2ui.AudioPlayer', 'component:a2ui.Modal'])
    for (const record of undrawn) {
      const name = record.id.slice('component:a2ui.'.length)
      expect(presentation(surface(name), inVocabulary).warnings.join(' ')).toContain(`"${name}" is not in the vocabulary`)
    }
    for (const name of ['Text', 'Column', 'Card', 'Divider', 'Slider', 'Tabs'])
      expect(presentation(surface(name), inVocabulary).warnings.join(' ')).not.toContain('is not in the vocabulary')
  })

  test('the page displays its formats and components, not its libraries', () => {
    expect(DISPLAYED_CAPABILITIES).toContain('format:observable')
    expect(DISPLAYED_CAPABILITIES).toContain('component:views.graph')
    expect(DISPLAYED_CAPABILITIES).toContain('format:html-app')
    expect(DISPLAYED_CAPABILITIES).not.toContain('library:plot')
  })
})
