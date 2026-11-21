// SOURCING: none — the model catalog as a person searches, sorts, pages, stars and inspects it, rendered with React into happy-dom (test/blocks/render). The catalog is synthetic: literal Muse entries, the reproduced Nemotron subsequence trap, a duplicate display name, and numeric names.
import { afterEach, expect, test } from 'bun:test'
import * as React from 'react'
import { act } from 'react'
import { cleanup, click, render, waitFor } from '../../../test/blocks/render'
import { parseModelList } from '@/lib/theorem/models'
import type { ModelOption } from '@/lib/theorem/models'
import { ModelsTable } from './models-table'

afterEach(cleanup)

/** One catalog entry as Theorem serves it, parsed through the real contract. */
function entry(ref: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    ref,
    name,
    source: 'catalog',
    context_length: 128000,
    architecture: { input_modalities: ['text'] },
    supported_parameters: ['tools'],
    pricing: { prompt: '0.000001', completion: '0.000003' },
    ...extra,
  }
}

const catalog: ModelOption[] = parseModelList({
  models: [
    // Its ref holds m-u-s-e in sequence without the word: the fuzzy trap.
    entry('openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.1', 'Nemotron'),
    entry(
      'openrouter/muse-lab/muse-spark-1.3-contributor',
      'Muse Spark 1.3 Contributor',
    ),
    entry('openrouter/muse-lab/muse-spark-1.10', 'Muse Spark 1.10'),
    entry('openrouter/muse-lab/muse-spark-1.3', 'Muse Spark 1.3'),
    entry('openrouter/muse-lab/muse-spark-1.2', 'Muse Spark 1.2'),
    entry('openrouter/google/nano-banana', 'Nano Banana', {
      pricing: { prompt: '0', completion: '0' },
      architecture: {
        input_modalities: ['text', 'image', 'file', 'audio', 'video'],
      },
      supported_parameters: [],
    }),
    entry('alpha/twins', 'Twins'),
    entry('beta/twins', 'Twins'),
  ],
  defaultRef: 'openrouter/muse-lab/muse-spark-1.3',
}).models

/** Enough numeric names to fill three pages at 25 rows. */
const numericCatalog: ModelOption[] = parseModelList({
  models: Array.from({ length: 60 }, (_, index) =>
    entry(`x/model-${index + 1}`, `Model ${index + 1}`),
  ),
}).models

/** The table as the settings page holds it: stars live above it and come back down. */
function Harness({
  models = catalog,
  initialStarred = [] as readonly string[],
  selected,
}: {
  models?: readonly ModelOption[]
  initialStarred?: readonly string[]
  selected?: string
}) {
  const [starred, setStarred] = React.useState(initialStarred)
  return (
    <ModelsTable
      models={models}
      starred={starred}
      selected={selected}
      onToggleStar={(ref) =>
        setStarred((previous) =>
          previous.includes(ref)
            ? previous.filter((star) => star !== ref)
            : [...previous, ref],
        )
      }
    />
  )
}

const mount = (
  models: readonly ModelOption[] = catalog,
  starred: readonly string[] = [],
  selected?: string,
) =>
  render(
    <Harness models={models} initialStarred={starred} selected={selected} />,
  )

/** The display names down the Model column, as the rows are now. */
const shownNames = (container: HTMLElement) =>
  [...container.querySelectorAll('tbody tr')].flatMap((row) => {
    const cells = row.querySelectorAll('td')
    if (cells.length < 2) return []
    const name = cells[1]!.querySelector('[data-model-name], .truncate')
    return [name?.textContent]
  })

const searchInput = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(
    'input[aria-label="Search models"]',
  )!

const type = (input: HTMLInputElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })

async function search(container: HTMLElement, text: string) {
  await type(searchInput(container), text)
  await waitFor(() => searchInput(container).value === text)
  // The search box debounces its commit.
  await act(() => new Promise((resolve) => setTimeout(resolve, 350)))
}

const countLine = (container: HTMLElement) =>
  [...container.querySelectorAll('div')].find((div) =>
    /^\d+ of \d+ models$/.test(div.textContent),
  )?.textContent

const pageLine = (container: HTMLElement) =>
  [...container.querySelectorAll('div, p')]
    .find((element) => /^Page \d+ of \d+$/.test(element.textContent.trim()))
    ?.textContent.trim()

const buttonLabeled = (container: ParentNode, label: string) =>
  [...container.querySelectorAll('button')].find(
    (button) => button.getAttribute('aria-label') === label,
  )

/** A Base UI select option commits on pointerdown, as a pointer press does. */
const pickOption = (option: Element) =>
  act(async () => {
    option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    option.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

// Search

test('muse returns the literal Muse entries in name order, not subsequence matches', async () => {
  const { container } = await mount()
  await search(container, 'muse')
  expect(shownNames(container)).toEqual([
    'Muse Spark 1.2',
    'Muse Spark 1.3',
    'Muse Spark 1.3 Contributor',
    'Muse Spark 1.10',
  ])
  expect(countLine(container)).toBe('4 of 8 models')
})

test('search trims outer whitespace and ignores case', async () => {
  const { container } = await mount()
  await search(container, '  NANO banana ')
  expect(shownNames(container)).toEqual(['Nano Banana'])
})

test('a canonical-ID query and a vendor query match literally', async () => {
  const { container } = await mount()
  await search(container, 'openrouter/muse-lab/muse-spark-1.3-contributor')
  expect(shownNames(container)).toEqual(['Muse Spark 1.3 Contributor'])
  await search(container, 'google')
  expect(shownNames(container)).toEqual(['Nano Banana'])
})

test('an unmatched query shows the empty state with an honest count', async () => {
  const { container } = await mount()
  await search(container, 'nothing-here')
  expect(shownNames(container)).toEqual([])
  expect(container.textContent).toContain('No model matches.')
  expect(countLine(container)).toBe('0 of 8 models')
  expect(pageLine(container)).toBe('Page 1 of 0')
})

// Sort

test('the default order is natural A-Z on the display name, not starred first', async () => {
  const { container } = await mount(catalog, ['openrouter/google/nano-banana'])
  expect(shownNames(container)).toEqual([
    'Muse Spark 1.2',
    'Muse Spark 1.3',
    'Muse Spark 1.3 Contributor',
    'Muse Spark 1.10',
    'Nano Banana',
    'Nemotron',
    'Twins',
    'Twins',
  ])
})

test('starring under the default order does not move the row or the picked model', async () => {
  const { container } = await mount(
    catalog,
    [],
    'openrouter/muse-lab/muse-spark-1.3',
  )
  const before = shownNames(container)
  await click(buttonLabeled(container, 'Star Nemotron')!)
  expect(shownNames(container)).toEqual(before)
  expect(
    buttonLabeled(container, 'Unstar Nemotron')?.getAttribute('aria-pressed'),
  ).toBe('true')
  const inUse = container.querySelector('[data-in-use] [data-model-name]')
  expect(inUse?.textContent).toBe('Muse Spark 1.3')
})

test('an explicitly chosen sort stays active while searching', async () => {
  const { container } = await mount()
  const modelHeader = [...container.querySelectorAll('th')].find((head) =>
    head.textContent.includes('Model'),
  )!
  await click(modelHeader.querySelector('button')!)
  const desc = await waitFor(() =>
    [...document.querySelectorAll('[role^="menuitem"]')].find((item) =>
      item.textContent.trim().endsWith('Desc'),
    ),
  )
  await click(desc)
  await search(container, 'muse')
  expect(shownNames(container)).toEqual([
    'Muse Spark 1.10',
    'Muse Spark 1.3 Contributor',
    'Muse Spark 1.3',
    'Muse Spark 1.2',
  ])
})

// Pagination

test('searching from a later page returns to page one', async () => {
  const { container } = await mount(numericCatalog)
  await click(buttonLabeled(container, 'Go to next page')!)
  expect(pageLine(container)).toBe('Page 2 of 2')
  expect(shownNames(container)[0]).toBe('Model 51')
  await search(container, 'Model 1')
  expect(pageLine(container)).toBe('Page 1 of 1')
  expect(shownNames(container)[0]).toBe('Model 1')
})

test('starring on a later page keeps the page', async () => {
  const { container } = await mount(numericCatalog)
  await click(buttonLabeled(container, 'Go to next page')!)
  await click(buttonLabeled(container, 'Star Model 51')!)
  expect(pageLine(container)).toBe('Page 2 of 2')
  expect(shownNames(container)[0]).toBe('Model 51')
})

test('a column filter from a later page returns to page one', async () => {
  const { container } = await mount(numericCatalog)
  await click(buttonLabeled(container, 'Go to next page')!)
  expect(pageLine(container)).toBe('Page 2 of 2')
  await click(
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Filter'),
    )!,
  )
  await click(await waitFor(() => buttonLabeled(document, 'Add new filter')))
  // The first offered field is Starred; move the filter to the Model column.
  await click(
    await waitFor(() =>
      buttonLabeled(document, 'Select filter field. Current: Starred'),
    ),
  )
  await click(
    await waitFor(() =>
      [...document.querySelectorAll('[role="option"]')].find(
        (option) => option.textContent.trim() === 'Model',
      ),
    ),
  )
  const value = await waitFor(() =>
    document.querySelector<HTMLInputElement>(
      'input[aria-label="Model filter value"]',
    ),
  )
  await type(value, 'Model 1')
  // "Model 1" is contained in Model 1 and Model 10..19: eleven matches.
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
  expect(pageLine(container)).toBe('Page 1 of 1')
  expect(shownNames(container)[0]).toBe('Model 1')
  expect(countLine(container)).toBe('11 of 60 models')
})

test('a catalog refresh clamps a page that no longer exists', async () => {
  const view = await mount(numericCatalog)
  const { container } = view
  await click(buttonLabeled(container, 'Go to next page')!)
  expect(pageLine(container)).toBe('Page 2 of 2')
  await view.rerender(<Harness models={numericCatalog.slice(0, 30)} />)
  await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
  expect(pageLine(container)).toBe('Page 1 of 1')
  expect(shownNames(container).length).toBe(30)
})

// Presentation

test('rows show one line per model without the canonical ID under every name', async () => {
  const { container } = await mount()
  const name = container.querySelector('[data-model-name]')!
  expect(name.getAttribute('title')).toBe('Muse Spark 1.2')
  const row = name.closest('tr')!
  expect(row.textContent).not.toContain('openrouter/')
  expect(row.querySelectorAll('[data-model-name]').length).toBe(1)
})

test('prices read Free at zero, and tools and reasoning read plain Yes or No', async () => {
  const { container } = await mount()
  const banana = shownNames(container).indexOf('Nano Banana')
  const row = container.querySelectorAll('tbody tr')[banana]!
  expect(row.textContent).toContain('Free')
  const cells = row.querySelectorAll('td')
  expect(cells[cells.length - 2]!.textContent.trim()).toBe('No')
  expect(cells[cells.length - 1]!.textContent.trim()).toBe('No')
  const spark = container.querySelectorAll('tbody tr')[0]!
  const sparkCells = spark.querySelectorAll('td')
  expect(sparkCells[sparkCells.length - 2]!.textContent.trim()).toBe('Yes')
})

test('the full modality list stays reachable from a compact Inputs cell', async () => {
  const { container } = await mount()
  const banana = shownNames(container).indexOf('Nano Banana')
  const row = container.querySelectorAll('tbody tr')[banana]!
  const inputs = row.querySelector('[data-model-inputs]')!
  expect(inputs.getAttribute('title')).toContain('Audio')
  expect(inputs.getAttribute('title')).toContain('Video')
})

// Details

test('opening details exposes the full identity and closes back to the trigger', async () => {
  const { container } = await mount(
    catalog,
    [],
    'openrouter/muse-lab/muse-spark-1.3',
  )
  const trigger = buttonLabeled(
    container,
    'Details for Muse Spark 1.3, openrouter/muse-lab/muse-spark-1.3',
  )!
  await click(trigger)
  const panel = await waitFor(() =>
    document.querySelector('[data-model-details]'),
  )
  expect(panel.textContent).toContain('Muse Spark 1.3')
  expect(panel.textContent).toContain('openrouter/muse-lab/muse-spark-1.3')
  expect(panel.textContent).toContain('muse-lab')
  expect(panel.textContent).toContain('In use')
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  await waitFor(() => !document.querySelector('[data-model-details]'))
  await waitFor(() => document.activeElement === trigger)
})

test('duplicate display names stay distinguishable in details', async () => {
  const { container } = await mount()
  const trigger = buttonLabeled(container, 'Details for Twins, beta/twins')!
  await click(trigger)
  const panel = await waitFor(() =>
    document.querySelector('[data-model-details]'),
  )
  expect(panel.textContent).toContain('beta/twins')
  expect(panel.textContent).not.toContain('alpha/twins')
})

test('inspecting a model does not change the picked model', async () => {
  const { container } = await mount(
    catalog,
    [],
    'openrouter/muse-lab/muse-spark-1.3',
  )
  await click(
    buttonLabeled(
      container,
      'Details for Nemotron, openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.1',
    )!,
  )
  await waitFor(() => document.querySelector('[data-model-details]'))
  const inUse = container.querySelector('[data-in-use] [data-model-name]')
  expect(inUse?.textContent).toBe('Muse Spark 1.3')
})

test('the details panel copies the canonical ID', async () => {
  const { container } = await mount()
  await click(
    buttonLabeled(
      container,
      'Details for Nemotron, openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.1',
    )!,
  )
  await waitFor(() => document.querySelector('[data-model-details]'))
  await click(buttonLabeled(document, 'Copy canonical ID')!)
  await waitFor(() =>
    buttonLabeled(document, 'Copy canonical ID')?.textContent.includes(
      'Copied',
    ),
  )
  expect(await navigator.clipboard.readText()).toBe(
    'openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.1',
  )
})

test('Starred first remains an explicit sort choice', async () => {
  const { container } = await mount(catalog, ['openrouter/google/nano-banana'])
  await click(
    [...container.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Sort'),
    )!,
  )
  // Replace the Model rule with Starred, descending: starred rows lead.
  const field = await waitFor(() =>
    buttonLabeled(document, 'Select column to sort by. Current: Model'),
  )
  await click(field)
  const starred = await waitFor(() =>
    [...document.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent.trim() === 'Starred',
    ),
  )
  await click(starred)
  const direction = await waitFor(() =>
    buttonLabeled(document, 'Sort direction for Starred'),
  )
  await click(direction)
  const desc = await waitFor(() =>
    [...document.querySelectorAll('[role="option"]')].find(
      (option) => option.textContent.trim() === 'Desc',
    ),
  )
  await pickOption(desc)
  await waitFor(() => shownNames(container)[0] === 'Nano Banana')
  // The starred row leads; the rest keep the core row order under a single rule.
  expect(shownNames(container)[0]).toBe('Nano Banana')
  expect(shownNames(container).slice(1)).not.toContain('Nano Banana')
})

async function inspectTwin(container: HTMLElement, ref: string) {
  await click(buttonLabeled(container, `Details for Twins, ${ref}`)!)
  await waitFor(() => document.querySelector('[data-model-details]'))
}

async function closeModelDetails() {
  await act(async () => {
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
  await waitFor(() => !document.querySelector('[data-model-details]'))
}

test('copy feedback belongs to the inspected model', async () => {
  const { container } = await mount()
  await inspectTwin(container, 'alpha/twins')
  await click(buttonLabeled(document, 'Copy canonical ID')!)
  await waitFor(() =>
    buttonLabeled(document, 'Copy canonical ID')?.textContent.includes(
      'Copied',
    ),
  )
  expect(await navigator.clipboard.readText()).toBe('alpha/twins')
  await closeModelDetails()
  await inspectTwin(container, 'beta/twins')
  expect(buttonLabeled(document, 'Copy canonical ID')?.textContent).toBe('Copy')
  await click(buttonLabeled(document, 'Copy canonical ID')!)
  await waitFor(() =>
    buttonLabeled(document, 'Copy canonical ID')?.textContent.includes(
      'Copied',
    ),
  )
  expect(await navigator.clipboard.readText()).toBe('beta/twins')
})

test('a pending copy cannot mark a later model as copied', async () => {
  const originalWriteText = navigator.clipboard.writeText
  let finishCopy: (() => void) | undefined
  let copied = ''
  navigator.clipboard.writeText = (value: string) => {
    copied = value
    return new Promise<void>((resolve) => {
      finishCopy = resolve
    })
  }
  try {
    const { container } = await mount()
    await inspectTwin(container, 'alpha/twins')
    await click(buttonLabeled(document, 'Copy canonical ID')!)
    expect(copied).toBe('alpha/twins')
    await closeModelDetails()
    await inspectTwin(container, 'beta/twins')
    await act(async () => {
      finishCopy?.()
    })
    expect(buttonLabeled(document, 'Copy canonical ID')?.textContent).toBe(
      'Copy',
    )
  } finally {
    await act(async () => {
      finishCopy?.()
    })
    navigator.clipboard.writeText = originalWriteText
  }
})

test('clipboard failure is announced, retry succeeds, and feedback resets for another model', async () => {
  const originalWriteText = navigator.clipboard.writeText
  let rejected = true
  navigator.clipboard.writeText = (value: string) =>
    rejected
      ? Promise.reject(
          new DOMException('Clipboard permission denied', 'NotAllowedError'),
        )
      : originalWriteText.call(navigator.clipboard, value)
  try {
    const { container } = await mount()
    await inspectTwin(container, 'alpha/twins')
    await click(buttonLabeled(document, 'Copy canonical ID')!)
    expect(
      document.querySelector('[data-model-details] [role="alert"]')
        ?.textContent,
    ).toBe('Could not copy the model ID. Try again.')
    expect(buttonLabeled(document, 'Copy canonical ID')?.textContent).toBe(
      'Copy',
    )

    rejected = false
    await click(buttonLabeled(document, 'Copy canonical ID')!)
    await waitFor(() =>
      buttonLabeled(document, 'Copy canonical ID')?.textContent.includes(
        'Copied',
      ),
    )
    expect(
      document.querySelector('[data-model-details] [role="alert"]'),
    ).toBeNull()
    expect(await navigator.clipboard.readText()).toBe('alpha/twins')

    rejected = true
    await click(buttonLabeled(document, 'Copy canonical ID')!)
    expect(
      document.querySelector('[data-model-details] [role="alert"]'),
    ).not.toBeNull()
    expect(buttonLabeled(document, 'Copy canonical ID')?.textContent).toBe(
      'Copy',
    )
    await closeModelDetails()
    await inspectTwin(container, 'beta/twins')
    expect(
      document.querySelector('[data-model-details] [role="alert"]'),
    ).toBeNull()
    expect(buttonLabeled(document, 'Copy canonical ID')?.textContent).toBe(
      'Copy',
    )
  } finally {
    navigator.clipboard.writeText = originalWriteText
  }
})

test('a late clipboard rejection cannot show an error for another model', async () => {
  const originalWriteText = navigator.clipboard.writeText
  let rejectCopy: ((error: Error) => void) | undefined
  navigator.clipboard.writeText = () =>
    new Promise<void>((_, reject) => {
      rejectCopy = reject
    })
  try {
    const { container } = await mount()
    await inspectTwin(container, 'alpha/twins')
    await click(buttonLabeled(document, 'Copy canonical ID')!)
    await closeModelDetails()
    await inspectTwin(container, 'beta/twins')
    await act(async () =>
      rejectCopy?.(new Error('Clipboard permission denied')),
    )
    expect(
      document.querySelector('[data-model-details] [role="alert"]'),
    ).toBeNull()
    expect(buttonLabeled(document, 'Copy canonical ID')?.textContent).toBe(
      'Copy',
    )
  } finally {
    await act(async () =>
      rejectCopy?.(new Error('Clipboard permission denied')),
    )
    navigator.clipboard.writeText = originalWriteText
  }
})

test('a pending clipboard write blocks a second write and allows retry after settlement', async () => {
  const originalWriteText = navigator.clipboard.writeText
  const writes: string[] = []
  let rejectFirst: ((error: Error) => void) | undefined
  navigator.clipboard.writeText = (value: string) => {
    writes.push(value)
    return writes.length === 1
      ? new Promise<void>((_, reject) => {
          rejectFirst = reject
        })
      : originalWriteText.call(navigator.clipboard, value)
  }
  try {
    const { container } = await mount()
    await inspectTwin(container, 'alpha/twins')
    const copy = buttonLabeled(document, 'Copy canonical ID')!
    await click(copy)
    const pending = {
      disabled: copy.disabled,
      busy: copy.getAttribute('aria-busy'),
      text: copy.textContent,
    }
    await click(copy)
    await act(async () =>
      rejectFirst?.(new Error('Clipboard permission denied')),
    )
    expect({
      pending,
      writes,
      settledText: copy.textContent,
      failed: Boolean(
        document.querySelector('[data-model-details] [role="alert"]'),
      ),
    }).toEqual({
      pending: { disabled: true, busy: 'true', text: 'Copying…' },
      writes: ['alpha/twins'],
      settledText: 'Copy',
      failed: true,
    })
    expect(copy.disabled).toBe(false)
    expect(copy.getAttribute('aria-busy')).toBe('false')
    await click(copy)
    await waitFor(() => copy.textContent.includes('Copied'))
    expect(writes).toEqual(['alpha/twins', 'alpha/twins'])
    expect(
      document.querySelector('[data-model-details] [role="alert"]'),
    ).toBeNull()
    expect(await navigator.clipboard.readText()).toBe('alpha/twins')
  } finally {
    await act(async () =>
      rejectFirst?.(new Error('Clipboard permission denied')),
    )
    navigator.clipboard.writeText = originalWriteText
  }
})
