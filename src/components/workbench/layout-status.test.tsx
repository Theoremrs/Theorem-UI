import { afterEach, expect, test } from 'bun:test'
import { WorkspaceLayoutStatus } from './layout-status'
import type { LayoutStatus } from '@/lib/workbench/layout/status'
import { cleanup, click, render } from '../../../test/blocks/render'

afterEach(cleanup)

const diagnostic = {
  route: '/api/workbench/v1/test',
  workspaceId: 'test',
  requestId: 'test-request',
}

for (const status of [
  { kind: 'account', revision: 0 },
  { kind: 'account', revision: 4 },
  { kind: 'pending', operation: 'restore' },
  { kind: 'pending', operation: 'save' },
] satisfies LayoutStatus[]) {
  test(`${JSON.stringify(status)} leaves the terminal free of routine layout chrome`, async () => {
    const { container } = await render(
      <WorkspaceLayoutStatus status={status} recover={() => {}} />,
    )
    expect(container.childElementCount).toBe(0)
  })
}

for (const { status, label, operation } of [
  {
    status: { kind: 'device', diagnostic },
    label: 'Retry restore',
    operation: 'load',
  },
  {
    status: {
      kind: 'failed',
      operation: 'restore',
      recovery: 'restore',
      diagnostic,
    },
    label: 'Retry restore',
    operation: 'load',
  },
  {
    status: { kind: 'failed', operation: 'save', recovery: 'save', diagnostic },
    label: 'Retry save',
    operation: 'retrySave',
  },
  {
    status: {
      kind: 'failed',
      operation: 'save',
      recovery: 'check',
      diagnostic,
    },
    label: 'Restore saved account layout',
    operation: 'load',
  },
] satisfies {
  status: LayoutStatus
  label: string
  operation: 'load' | 'retrySave'
}[]) {
  test(`${status.kind} ${label} keeps its recovery action`, async () => {
    let recovered: string | undefined
    const { container } = await render(
      <WorkspaceLayoutStatus
        status={status}
        recover={(next) => {
          recovered = next
        }}
      />,
    )
    const action = container.querySelector('button')!
    expect(action.textContent).toBe(label)
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    await click(action)
    expect(recovered).toBe(operation)
  })
}
