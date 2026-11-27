import { afterEach, expect, test } from 'bun:test'
import { cleanup, render } from '../../../../test/blocks/render'
import { layout, readGraph } from './dependency-graph'
import { styledGenerativeUILibrary } from './generative-ui'

afterEach(cleanup)

const at = (graph: ReturnType<typeof layout>, id: string) => {
  const node = graph.nodes.find((n) => n.id === id)!
  return [node.column, node.row]
}

test('a node sits one column past the furthest node it depends on, wherever it is listed', () => {
  const graph = layout({
    nodes: [
      { id: 'ship', dependsOn: ['test', 'docs'] },
      { id: 'build' },
      { id: 'test', dependsOn: ['build'] },
      { id: 'docs' },
    ],
  })
  expect(at(graph, 'build')[0]).toBe(0)
  expect(at(graph, 'docs')[0]).toBe(0)
  expect(at(graph, 'test')[0]).toBe(1)
  expect(at(graph, 'ship')[0]).toBe(2)
  expect(graph.edges).toEqual([
    { from: 'test', to: 'ship' },
    { from: 'docs', to: 'ship' },
    { from: 'build', to: 'test' },
  ])
})

test('each column is centred on the tallest, and a node without a label or state shows its id as done', () => {
  const graph = layout({
    nodes: [
      { id: 'harbor' },
      { id: 'headland', dependsOn: ['harbor'] },
      { id: 'lighthouse', dependsOn: ['headland'] },
      {
        id: 'cove',
        dependsOn: ['headland'],
        label: 'The cove',
        state: 'active',
      },
    ],
  })
  expect(at(graph, 'harbor')).toEqual([0, 0.5])
  expect(at(graph, 'headland')).toEqual([1, 0.5])
  expect(at(graph, 'lighthouse')).toEqual([2, 0])
  expect(at(graph, 'cove')).toEqual([2, 1])
  const shown = graph.nodes.map((n) => [n.label, n.state])
  expect(shown[0]).toEqual(['harbor', 'done'])
  expect(shown[3]).toEqual(['The cove', 'active'])
})

test('a cycle or an id no node has does not stop the layout', () => {
  const graph = layout({
    nodes: [
      { id: 'a', dependsOn: ['b'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['missing'] },
    ],
  })
  expect(graph.nodes.map((n) => n.column)).toEqual([1, 0, 0])
})

test('a source that is not a graph is not read as one', () => {
  expect(readGraph('flowchart LR\n  a --> b')).toBeUndefined()
  expect(readGraph('{"nodes":[]}')).toBeUndefined()
  expect(readGraph('{"nodes":[{"label":"no id"}]}')).toBeUndefined()
  expect(readGraph('{"nodes":[{"id":"a"}]}')).toEqual({ nodes: [{ id: 'a' }] })
})

test('the agent can present a graph: the flow graph alone, with no paper around it', async () => {
  const { container } = await render(
    <>
      {styledGenerativeUILibrary.Graph!.render({
        nodes: [{ id: 'plan' }, { id: 'patch', dependsOn: ['plan'] }],
      })}
    </>,
  )
  const graph = container.querySelector('[data-slot="flow-graph"]')!
  expect(graph.textContent).toBe('planpatch')
  expect(graph.className).toContain('border-0')
})
