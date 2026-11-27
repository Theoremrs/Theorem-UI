import { beforeEach, describe, expect, test } from 'bun:test'
import type { ThreadMessage } from '@assistant-ui/react'
import {
  GENERATIVE_OPERATIONS,
  PRESENT,
  presentRequestsOf,
  resetPresentRequests,
  servePresentRequests,
  VIEW,
} from './operations'
import type { PresentReceipt, PresentRequest } from './operations'
import { reviseViews, useViewInstances } from './view-instances'
import { viewRevision } from './view-reference'

const request = (
  args: Record<string, unknown>,
  requestRef = 'ref_1',
): PresentRequest => ({
  runId: 'run_1',
  requestRef,
  args,
  expectedRevision: 3,
})

/** An assistant message carrying one pending present operation. */
const message = (args: Record<string, unknown>): ThreadMessage =>
  ({
    id: 'm1',
    role: 'assistant',
    status: { type: 'running' },
    metadata: { custom: { theoremRunId: 'run_1' } },
    content: [
      {
        type: 'data',
        name: 'theorem-client_operation',
        data: {
          requestRef: 'ref_1',
          operation: PRESENT,
          state: 'pending',
          args,
          expectedRevision: 3,
        },
      },
    ],
  }) as unknown as ThreadMessage

/** Collects what a served request posts. */
const collect = () => {
  const posted: Array<PresentReceipt> = []
  const post = (_: PresentRequest, receipt: PresentReceipt) => {
    posted.push(receipt)
    return Promise.resolve()
  }
  return { posted, post }
}

/** A view tree, and the instance key and revision its page reports under. */
const viewed = (cells: Array<string>, id?: string) => {
  const revision = viewRevision(cells, undefined)
  return {
    tree: { _type: 'Card', children: [{ _type: 'View', cells, ...(id && { id }) }] },
    key: id ?? revision,
    revision,
  }
}

describe('present requests', () => {
  beforeEach(() => {
    resetPresentRequests()
    useViewInstances.setState({ byKey: {}, savers: {} })
  })

  test('ui.view is declared within the server\'s caps', () => {
    const view = GENERATIVE_OPERATIONS.find((operation) => operation.name === VIEW)!
    expect(Buffer.byteLength(JSON.stringify(view.inputSchema))).toBeLessThan(8 * 1024)
    expect(Buffer.byteLength(view.description)).toBeLessThanOrEqual(1024)
  })

  test('the declared schema fits the server\'s 8 KB cap', () => {
    const schema = GENERATIVE_OPERATIONS[0].inputSchema
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(8 * 1024)
    expect(GENERATIVE_OPERATIONS[0].effect).toBe('presentation')
  })

  test('the description fits the server\'s 1 KB cap and teaches View', () => {
    const { description } = GENERATIVE_OPERATIONS[0]
    expect(Buffer.byteLength(description)).toBeLessThanOrEqual(1024)
    for (const helper of ['linked', 'graph', 'tree', 'timeline', 'param'])
      expect(description).toContain(`views.${helper}(`)
  })

  test('only a live turn\'s pending present calls are read', () => {
    const tree = { _type: 'Card' }
    expect(presentRequestsOf([message(tree)], true)).toHaveLength(1)
    expect(presentRequestsOf([message(tree)], false)).toHaveLength(0)
  })

  test('a paintable tree is applied once, with the revision the run expected', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    const asked = request({ _type: 'Card', children: 'hello' })
    await servePresentRequests([asked], post)
    await servePresentRequests([asked], post)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({
      outcome: 'applied',
      revision: 3,
      result: { painted: 'Card' },
    })
  })

  test('a tree whose root names a component outside the vocabulary is painted, with a warning', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    await servePresentRequests([request({ _type: 'NoSuchComponent', label: 'x', value: 1 })], post)
    expect(posted[0]?.outcome).toBe('applied')
    expect(JSON.stringify(posted[0]?.result)).toContain('NoSuchComponent')
  })

  test('a component given a property it does not read is painted, and the receipt names the property once', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    const tree = {
      _type: 'Col',
      children: [
        { _type: 'Header', text: 'Wind and solar' },
        { _type: 'Text', text: 'Approximate values' },
        { _type: 'Text', text: 'Rounded to whole percentages' },
        { _type: 'Card', padding: 3, gap: 2, children: [{ _type: 'Text', value: 'Data' }] },
      ],
    }
    await servePresentRequests([request(tree)], post)
    expect(posted[0]).toMatchObject({ outcome: 'applied', result: { painted: 'Col' } })
    const warnings = (posted[0]?.result as { warnings?: Array<string> }).warnings
    expect(warnings).toEqual(['Text needs "value"; does not read "text".', 'Card does not read "gap".'])
  })

  test('A2UI from any catalog is painted, and its surfaces named in the receipt', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    const a2ui = [
      { version: 'v0.9', createSurface: { surfaceId: 's1', catalogId: 'https://agent.example/c.json' } },
      {
        version: 'v0.9',
        updateComponents: { surfaceId: 's1', components: [{ id: 'root', component: 'Dial', value: 3 }] },
      },
    ]
    await servePresentRequests([request({ a2ui })], post)
    expect(posted[0]).toMatchObject({ outcome: 'applied', result: { painted: 's1' } })
  })

  test('a view whose cells will fail is painted, and the receipt says which cell and why', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    const cells = ['viewof k = Inputs.range([0, 1], {label: html`k ${kk}`})', 'Plot.dotX(data, {x: (d) => d * k}).plot()']
    await servePresentRequests([request({ _type: 'Card', children: [{ _type: 'View', cells }] })], post, undefined, 0)
    expect(posted[0]?.outcome).toBe('applied')
    expect(JSON.stringify(posted[0]?.result)).toContain('Cell 1 reads `kk`, which no cell defines.')
  })

  test('a view no page has started is only accepted', async () => {
    const { posted, post } = collect()
    const { tree, revision } = viewed(['1 + 1'])
    await servePresentRequests([request(tree)], post, undefined, 0)
    expect(posted[0]).toMatchObject({
      outcome: 'applied',
      result: { views: [{ id: revision, revision, stage: 'accepted' }] },
    })
  })

  test('the receipt waits for the view to show its cells, and says which it shows and what', async () => {
    const { posted, post } = collect()
    const { tree, key, revision } = viewed(['x = 2', 'x * 3'], 'tripled')
    const served = servePresentRequests([request(tree)], post, undefined, 5_000)
    const views = useViewInstances.getState()
    views.mount(key, revision, ['c1', 'c2'])
    views.settle(key, revision, { cell: 'c1', stage: 'ready', shows: 'x = 2' })
    expect(posted).toHaveLength(0)
    views.settle(key, revision, { cell: 'c2', stage: 'ready', shows: '6' })
    await served
    expect(posted[0]?.result).toMatchObject({
      views: [{ id: 'tripled', revision, stage: 'ready', displayed: ['c1', 'c2'], shows: { c1: 'x = 2', c2: '6' } }],
    })
  })

  test('a cell that fails as it runs is reported once, with the error the page raised', async () => {
    const { posted, post } = collect()
    const { tree, key, revision } = viewed(['x = 2', 'x.nope.deeper'])
    const served = servePresentRequests([request(tree)], post, undefined, 5_000)
    const views = useViewInstances.getState()
    views.mount(key, revision, ['c1', 'c2'])
    const thrown = "Cannot read properties of undefined (reading 'deeper')"
    views.settle(key, revision, { cell: 'c1', stage: 'ready' })
    views.error(key, revision, thrown)
    views.error(key, revision, 'ResizeObserver loop completed with undelivered notifications.')
    views.settle(key, revision, { cell: 'c2', stage: 'failed', error: thrown })
    await served
    expect(posted[0]?.result).toMatchObject({
      views: [
        {
          stage: 'partial',
          displayed: ['c1'],
          failed: ['c2'],
          errors: [`Cell c2: ${thrown}`, 'ResizeObserver loop completed with undelivered notifications.'],
        },
      ],
    })
  })

  test('a page that does not build fails the view, and an earlier revision\'s reports are not read', async () => {
    const { posted, post } = collect()
    const { tree, key, revision } = viewed(['import("nowhere")'], 'imports')
    const served = servePresentRequests([request(tree)], post, undefined, 5_000)
    const views = useViewInstances.getState()
    views.settle(key, 'an-earlier-revision', { cell: 'c1', stage: 'ready' })
    views.mount(key, revision, ['c1'])
    views.unbuilt(key, revision, 'The page did not build: nowhere is not a module')
    await served
    expect(posted[0]?.result).toMatchObject({
      views: [{ stage: 'failed', displayed: [], errors: ['The page did not build: nowhere is not a module'] }],
    })
    expect(JSON.stringify(posted[0]?.result)).not.toContain('pending')
  })

  test('a view still running when the wait ends says how far it got and which cells have not settled', async () => {
    const { posted, post } = collect()
    const { tree, key, revision } = viewed(['x = 2', 'new Promise(() => {})'])
    const views = useViewInstances.getState()
    views.mount(key, revision, ['c1', 'c2'])
    views.advance(key, revision, 'mounted')
    views.advance(key, revision, 'compiled')
    views.settle(key, revision, { cell: 'c1', stage: 'ready' })
    await servePresentRequests([request(tree)], post, undefined, 20)
    expect(posted[0]?.result).toMatchObject({
      views: [{ stage: 'mounted', displayed: ['c1'], pending: ['c2'] }],
    })
    expect(JSON.stringify(posted[0]?.result)).not.toContain('waiting')
  })

  test('cells pending on a page that is not drawing are said to wait for the reader, not to be stuck', async () => {
    const { posted, post } = collect()
    const { tree, key, revision } = viewed(['x = 2', 'x * 3'])
    const views = useViewInstances.getState()
    views.mount(key, revision, ['c1', 'c2'])
    views.advance(key, revision, 'mounted')
    views.settle(key, revision, { cell: 'c1', stage: 'ready' })
    const draw = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = () => 0
    try {
      await servePresentRequests([request(tree)], post, undefined, 20)
    } finally {
      globalThis.requestAnimationFrame = draw
    }
    expect(posted[0]?.result).toMatchObject({ views: [{ stage: 'mounted', pending: ['c2'] }] })
    expect(JSON.stringify(posted[0]?.result)).toContain('The page is not drawing')
  })

  test('a hidden page that paints one frame on demand is still said not to be drawing', async () => {
    const { posted, post } = collect()
    const cells = ['const span = view(Inputs.range([0, 9], {value: 4}))', 'span * 2']
    const { tree, key, revision } = viewed(cells)
    const views = useViewInstances.getState()
    views.mount(key, revision, ['c1', 'c2'], cells)
    views.advance(key, revision, 'mounted')
    const draw = globalThis.requestAnimationFrame
    let painted = 0
    globalThis.requestAnimationFrame = (callback) => (painted++ ? 0 : (setTimeout(() => callback(0), 0), 1))
    try {
      await servePresentRequests([request(tree)], post, undefined, 20)
    } finally {
      globalThis.requestAnimationFrame = draw
    }
    expect(JSON.stringify(posted[0]?.result)).toContain('The page is not drawing')
    expect(JSON.stringify(posted[0]?.result)).not.toContain('blocking')
  })

  test('on a page that draws, the receipt names the pending cell the others wait on', async () => {
    const { posted, post } = collect()
    const cells = ['const span = view(Inputs.range([0, 9], {value: [0, 9]}))', 'span * 2', 'const ready = 1']
    const { tree, key, revision } = viewed(cells)
    const views = useViewInstances.getState()
    views.mount(key, revision, ['c1', 'c2', 'c3'], cells)
    views.advance(key, revision, 'mounted')
    views.settle(key, revision, { cell: 'c3', stage: 'ready' })
    await servePresentRequests([request(tree)], post, undefined, 20)
    expect(posted[0]?.result).toMatchObject({
      views: [{ stage: 'mounted', pending: ['c1', 'c2'], blocking: { c1: ['c2'] } }],
    })
  })

  test('a page still building when the wait ends says so', async () => {
    const { posted, post } = collect()
    const { tree, key, revision } = viewed(['1'])
    useViewInstances.getState().mount(key, revision, ['c1'])
    await servePresentRequests([request(tree)], post, undefined, 20)
    expect(posted[0]?.result).toMatchObject({ views: [{ stage: 'accepted', pending: ['c1'] }] })
    useViewInstances.getState().advance(key, revision, 'compiled')
    resetPresentRequests()
    await servePresentRequests([request(tree)], post, undefined, 20)
    expect(posted[1]?.result).toMatchObject({ views: [{ stage: 'compiled', pending: ['c1'] }] })
  })

  test('a repair under the same id is reported as the new revision once it is ready', async () => {
    const { posted, post } = collect()
    const broken = viewed(['x = ', '1'], 'fit')
    const fixed = viewed(['x = 2', 'x + 1'], 'fit')
    const views = useViewInstances.getState()
    views.mount('fit', broken.revision, ['c1', 'c2'])
    views.unbuilt('fit', broken.revision, 'Cell c1 does not parse.')
    await servePresentRequests([request(broken.tree, 'ref_a')], post, undefined, 5_000)
    expect(posted[0]?.result).toMatchObject({ views: [{ id: 'fit', revision: broken.revision, stage: 'failed' }] })
    const repaired = servePresentRequests([request(fixed.tree, 'ref_b')], post, undefined, 5_000)
    views.mount('fit', fixed.revision, ['c1', 'c2'])
    views.settle('fit', fixed.revision, { cell: 'c1', stage: 'ready' })
    views.settle('fit', fixed.revision, { cell: 'c2', stage: 'ready' })
    await repaired
    expect(posted[1]?.result).toMatchObject({ views: [{ id: 'fit', revision: fixed.revision, stage: 'ready' }] })
    expect(JSON.stringify(posted[1]?.result)).not.toContain('errors')
  })

  test('a call with nothing to paint is refused plainly', async () => {
    const posted: Array<PresentReceipt> = []
    const post = (_: PresentRequest, receipt: PresentReceipt) => {
      posted.push(receipt)
      return Promise.resolve()
    }
    await servePresentRequests([request({ caption: 'nothing' })], post)
    expect(posted[0]?.outcome).toBe('rejected')
    expect(posted[0]?.reason).toContain('a2ui')
  })

  test('inspect answers what a view shows now and what the reader selected', async () => {
    const { posted, post } = collect()
    const views = useViewInstances.getState()
    views.mount('rates', 'r1', ['c1', 'c2'])
    views.settle('rates', 'r1', { cell: 'c1', stage: 'ready' })
    views.settle('rates', 'r1', { cell: 'c2', stage: 'ready' })
    views.select('rates', 'r1', { text: '', entityLabel: '2021 to 2023', ids: ['2021', '2022', '2023'], state: { params: { rate: 0.07 } } })
    await servePresentRequests([{ ...request({ id: 'rates', action: 'inspect' }), operation: VIEW }], post)
    expect(posted[0]).toMatchObject({
      outcome: 'applied',
      result: {
        id: 'rates',
        revision: 'r1',
        stage: 'ready',
        displayed: ['c1', 'c2'],
        selection: { label: '2021 to 2023', ids: ['2021', '2022', '2023'], state: { params: { rate: 0.07 } } },
      },
    })
  })

  test('save keeps the view through its own saver and answers the document', async () => {
    const { posted, post } = collect()
    const views = useViewInstances.getState()
    views.mount('rates', 'r1', ['c1'])
    const release = views.offerSave('rates', () => Promise.resolve({ documentId: 'doc_9' }))
    await servePresentRequests([{ ...request({ id: 'rates', action: 'save' }, 'ref_s'), operation: VIEW }], post)
    expect(posted[0]).toMatchObject({ outcome: 'applied', result: { id: 'rates', saved: { documentId: 'doc_9' } } })
    release()
    expect(useViewInstances.getState().savers.rates).toBeUndefined()
  })

  test('a view the page does not have is refused with the ids it does', async () => {
    const { posted, post } = collect()
    const views = useViewInstances.getState()
    views.mount('rates', 'r1', ['c1'])
    views.offerSave('rates', () => Promise.resolve({ documentId: 'doc_9' }))
    await servePresentRequests([{ ...request({ id: 'rate', action: 'inspect' }), operation: VIEW }], post)
    expect(posted[0]?.outcome).toBe('rejected')
    expect(posted[0]?.reason).toContain('Views here: rates.')
  })
})

describe('one view per id in a reply', () => {
  const view = (id: string | undefined, cells: Array<string>) => ({ _type: 'View', ...(id && { id }), cells })

  test('a view presented again is drawn where it first appeared, as its latest definition', () => {
    const first = { _type: 'Card', children: [{ _type: 'Heading', text: 'Rates' }, view('rates', ['broken('])] }
    const repair = view('rates', ['1 + 1'])
    const [drawnFirst, drawnRepair] = reviseViews([first, repair])
    expect(drawnFirst).toEqual({ _type: 'Card', children: [{ _type: 'Heading', text: 'Rates' }, repair] })
    expect(drawnRepair).toEqual({})
  })

  test('views without an id, and calls with no views, keep their objects', () => {
    const plain = { _type: 'Card', children: [view(undefined, ['1'])] }
    const text = { _type: 'Text', text: 'hi' }
    const named = { _type: 'Card', children: [view('only', ['2'])] }
    const drawn = reviseViews([plain, text, named])
    expect(drawn[0]).toBe(plain)
    expect(drawn[1]).toBe(text)
    expect(drawn[2]).toBe(named)
  })

  test('a paint presented again with a view it already showed replaces the earlier paint, where that stood', () => {
    // The agent mends a header the receipt warned about and presents the whole paint again.
    const first = { _type: 'Col', children: [{ _type: 'Text', text: 'Lisp family' }, view('tree', ['tree()'])] }
    const mended = { _type: 'Col', children: [{ _type: 'Text', value: 'Lisp family' }, view('tree', ['tree()'])] }
    const between = { _type: 'Text', value: 'Fixed the header.' }
    expect(reviseViews([first, between, mended])).toEqual([mended, between, {}])
  })

  test('a view shown alone and then presented in a fuller paint is drawn as that paint, where the view stood', () => {
    const later = { _type: 'Card', children: [{ _type: 'Text', value: 'Fixed.' }, view('a', ['3'])] }
    expect(reviseViews([view('a', ['1']), later])).toEqual([later, {}])
  })

  test('a paint restated twice is drawn once, as the last statement, where the first stood', () => {
    const paint = (text: string, cells: Array<string>) => ({ _type: 'Col', children: [{ _type: 'Text', value: text }, view('a', cells)] })
    const last = paint('three', ['3'])
    expect(reviseViews([paint('one', ['1']), paint('two', ['2']), last])).toEqual([last, {}, {}])
  })
})
