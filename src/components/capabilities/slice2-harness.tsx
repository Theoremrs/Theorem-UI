// SOURCING: none — a test harness, shaped like capability-table.test.tsx's: window.fetch stands in
// for a Theorem that serves /api/capabilities/v1 with the slice-2 rule, run and module routes the
// plan pins, and the table module is rendered with test/workspace's render (a QueryClient) so a
// test reaches rules and runs the way a person does, from the view bar.
import { act } from 'react'
import { PageRuntimeProvider } from '../pages/page-runtime'
import { render } from '../../../test/workspace'
import { CapabilityTableModule } from './capability-table'
import { CAPABILITIES } from '@/lib/capabilities/api'
import { codes } from '@/lib/capabilities/contract'
import type {
  DescribeResult,
  Grant,
  PatchOp,
  RuleRun,
  RuleSpec,
} from '@/lib/capabilities/contract'
import type { ModuleViewProps } from '@/lib/modules/registry'
import { describeResult, ownerGrant, queryResult, taskRows } from './fixture'

export const nightly: RuleSpec = {
  key: 'nightly_review',
  label: 'Nightly review',
  trigger: { kind: 'schedule', intervalMinutes: 1440 },
  actionKey: 'add',
  inputs: { title: { source: 'literal', value: 'Review the day' } },
}

export const onDone: RuleSpec = {
  key: 'unassign_done',
  label: 'Unassign finished tasks',
  trigger: { kind: 'transition', collectionKey: 'tasks', to: 'done' },
  actionKey: 'assign',
  inputs: { assignee: { source: 'literal', value: null } },
}

/** The owner's grant as slice 2 serves it: background rides beside author. */
export const backgroundGrant = { ...ownerGrant, background: true } as Grant

export type Call = {
  method: string
  path: string
  search: string
  body?: Record<string, unknown>
  headers: Headers
}

export interface Server {
  calls: Call[]
  described: DescribeResult
  runs: RuleRun[]
  /** Every call to a route ending in this suffix answers this problem, until it is removed. */
  refuse: Map<string, { status: number; code: string; detail: string }>
}

export const server: Server = {
  calls: [],
  described: describeResult(),
  runs: [],
  refuse: new Map(),
}

const realFetch = window.fetch

const page = (
  window as unknown as { happyDOM: { setURL: (url: string) => void } }
).happyDOM

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const problem = (status: number, code: string, detail: string) =>
  new Response(
    JSON.stringify({
      type: 'about:blank',
      title: 'Refused',
      status,
      code,
      detail,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  )

/** The tracker with two rules, the nightly one switched on. */
export function withRules(grant: Grant = backgroundGrant): DescribeResult {
  const base = describeResult(grant)
  return {
    ...base,
    definition: { ...base.definition, rules: [nightly, onDone] },
    ruleStates: {
      nightly_review: { enabled: true, changedAtMs: 1, runAs: 'user:travis' },
    },
  }
}

export function install() {
  page.setURL('http://localhost:3000/pages/Desk')
  server.calls = []
  server.described = withRules()
  server.runs = []
  server.refuse = new Map()
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const url = new URL(request ? request.url : String(input))
    const headers = new Headers(init?.headers ?? request?.headers)
    const method = init?.method ?? request?.method ?? 'GET'
    const raw =
      init?.body ?? (request ? await request.clone().text() : undefined)
    const body = raw
      ? (JSON.parse(String(raw)) as Record<string, unknown>)
      : undefined
    if (url.pathname === '/api/chat/v1/bootstrap')
      return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
    server.calls.push({
      method,
      path: url.pathname,
      search: url.search,
      body,
      headers,
    })
    for (const [suffix, refusal] of server.refuse)
      if (url.pathname.endsWith(suffix))
        return problem(refusal.status, refusal.code, refusal.detail)
    const rest = url.pathname
      .slice(CAPABILITIES.length + 1)
      .split('/')
      .map(decodeURIComponent)
    const [, instanceId, tail, key, verb] = rest
    if (rest.length === 2) return json(server.described)
    if (tail === 'query') return json(queryResult(taskRows))
    if (tail === 'author') {
      if (body?.expectedDefinitionId !== 'capdef:abc')
        return problem(
          409,
          codes.DEFINITION_CONFLICT,
          'A newer definition is pinned.',
        )
      const ops = (body.ops ?? []) as PatchOp[]
      const rules: Record<
        string,
        { enabled: boolean; runAs: string; changedAtMs: number }
      > = {}
      for (const op of ops)
        if (op.op === 'set_rule_enabled')
          rules[op.ruleKey] = {
            enabled: op.enabled,
            runAs: 'user:travis',
            changedAtMs: 2,
          }
      return json({
        definitionId: 'capdef:def',
        instance: {
          instanceId,
          capabilityId: 'project-tracker',
          definitionId: 'capdef:def',
          config: {},
          grants: [],
          ownerPrincipal: 'user:travis',
          createdAtMs: 1,
          ...(Object.keys(rules).length ? { rules } : {}),
        },
      })
    }
    if (tail === 'runs' && key === undefined) {
      const ruleKey = url.searchParams.get('ruleKey')
      return json({
        runs: server.runs.filter((one) => !ruleKey || one.ruleKey === ruleKey),
      })
    }
    if (tail === 'runs' && verb === 'retry') {
      const found = server.runs.find((one) => one.runId === key)
      if (!found) return problem(404, 'capability_run_not_found', 'no run')
      const again = { ...found, status: 'pending' } as RuleRun
      server.runs = server.runs.map((one) => (one.runId === key ? again : one))
      return json(again)
    }
    if (tail === 'runs') {
      const found = server.runs.find((one) => one.runId === key)
      return found
        ? json(found)
        : problem(404, 'capability_run_not_found', 'no run')
    }
    if (tail === 'rules' && verb === 'run') {
      const started = {
        runId: `caprun:manual-${server.runs.length + 1}`,
        instanceId: instanceId ?? '',
        ruleKey: key ?? '',
        definitionId: 'capdef:abc',
        trigger: {
          kind: 'manual',
          invocationKey: headers.get('Idempotency-Key') ?? '',
        },
        runAs: 'user:travis',
        cause: { depth: 0, chain: [] },
        status: 'pending',
        attempts: [],
        nextAttemptAtMs: 0,
        createdAtMs: 100,
      } as RuleRun
      server.runs = [started, ...server.runs]
      return json(started, 202)
    }
    return json({}, 404)
  }) as typeof fetch
}

export function uninstall() {
  window.fetch = realFetch
}

export async function showTable(described?: DescribeResult) {
  if (described) server.described = described
  const view: ModuleViewProps = {
    instanceId: 'table-1',
    path: 'table-1',
    settings: { instanceId: 'tracker/main', viewKey: '' },
    inputs: {},
    output: () => {},
    emit: () => {},
    arranging: false,
  }
  return render(
    <PageRuntimeProvider>
      <CapabilityTableModule {...view} />
    </PageRuntimeProvider>,
  )
}

/** Where a dialog's content is: Base UI portals it to the document. */
export const screen = () => document.body

export const button = (root: ParentNode, name: string) =>
  [...root.querySelectorAll('button')].find(
    (one) => one.textContent.trim() === name,
  )

export const named = <T extends Element = HTMLElement>(label: string) =>
  document.querySelector<T>(`[aria-label="${label}"]`)

export async function press(element: Element | null | undefined) {
  if (!element) throw new Error('nothing to press')
  await act(async () => (element as HTMLElement).click())
}

export function fill(
  field: HTMLInputElement | HTMLSelectElement | null,
  value: string,
) {
  if (!field) throw new Error('no field to fill')
  const proto =
    field instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!
  act(() => {
    setter.call(field, value)
    field.dispatchEvent(
      new Event(field instanceof HTMLSelectElement ? 'change' : 'input', {
        bubbles: true,
      }),
    )
  })
}

export const sentTo = (suffix: string) =>
  server.calls.filter((call) => call.path.endsWith(suffix))
