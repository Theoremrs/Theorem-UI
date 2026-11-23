import { expect, test } from 'bun:test'
import type { ThreadMessage } from '@assistant-ui/react'
import { transcriptOf } from './transcript'

test('a reply view is shown in the workbench as the program it runs', () => {
  const message = {
    id: 'm1',
    role: 'assistant',
    status: { type: 'complete' },
    metadata: { custom: {} },
    content: [
      {
        type: 'data',
        name: 'theorem-client_operation',
        data: { operation: 'ui.present', args: { _type: 'View', cells: ['Plot.dot(data).plot()'] } },
      },
    ],
  } as unknown as ThreadMessage
  const [row] = transcriptOf([message], false).messages
  expect(row?.parts).toEqual([
    { type: 'program', source: 'Plot.dot(data).plot()', language: 'javascript', streaming: false },
  ])
})
