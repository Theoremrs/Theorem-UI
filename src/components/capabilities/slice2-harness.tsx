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
import {
  completedReceipt,
  describeResult,
  ownerGrant,
  queryResult,
  taskRows,
} from './fixture'

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

/** A call as the fake Theorem reads it, normalised the way fetch itself reads its arguments. */
async function readCall(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init)
  const raw = await request.text()
  return {
    url: new URL(request.url),
    method: request.method,
    headers: request.headers,
    body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
  }
}

/** An action call: completed, moving its one record a revision on. */
const invoked = (body: Record<string, unknown> | undefined) =>
  json(
    completedReceipt(String(body?.actionKey), [
      {
        id: String(body?.recordId),
        revision: Number(body?.expectedRevision ?? 0) + 1,
      },
    ]),
  )

/**
 * An authoring call: refused unless it was made against the pinned
 * definition; otherwise the new pin, with any rule switched on or off.
 */
function authored(
  instanceId: string | undefined,
  body: Record<string, unknown> | undefined,
) {
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

/** The runs routes: the list (of one rule, when asked), one run, and a retry that sets it pending. */
function runsAnswer(
  url: URL,
  runId: string | undefined,
  verb: string | undefined,
) {
  if (runId === undefined) {
    const ruleKey = url.searchParams.get('ruleKey')
    return json({
      runs: server.runs.filter((one) => !ruleKey || one.ruleKey === ruleKey),
    })
  }
  const found = server.runs.find((one) => one.runId === runId)
  if (!found) return problem(404, 'capability_run_not_found', 'no run')
  if (verb !== 'retry') return json(found)
  const again = { ...found, status: 'pending' } as RuleRun
  server.runs = server.runs.map((one) => (one.runId === runId ? again : one))
  return json(again)
}

/** A rule run by hand: a pending run, newest first, keyed by the call's idempotency key. */
function startedRun(
  instanceId: string | undefined,
  ruleKey: string | undefined,
  headers: Headers,
) {
  const started = {
    runId: `caprun:manual-${server.runs.length + 1}`,
    instanceId: instanceId ?? '',
    ruleKey: ruleKey ?? '',
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

/** What a capabilities route answers, by the parts of its path after the API's root. */
function route(call: Awaited<ReturnType<typeof readCall>>) {
  const rest = call.url.pathname
    .slice(CAPABILITIES.length + 1)
    .split('/')
    .map(decodeURIComponent)
  const [, instanceId, tail, key, verb] = rest
  if (rest.length === 2) return json(server.described)
  if (tail === 'query') return json(queryResult(taskRows))
  if (tail === 'invoke') return invoked(call.body)
  if (tail === 'author') return authored(instanceId, call.body)
  if (tail === 'runs') return runsAnswer(call.url, key, verb)
  if (tail === 'rules' && verb === 'run')
    return startedRun(instanceId, key, call.headers)
  return json({}, 404)
}

/** The fake Theorem: the chat bootstrap unrecorded, then every call recorded and refused or routed. */
async function serve(input: RequestInfo | URL, init?: RequestInit) {
  const call = await readCall(input, init)
  if (call.url.pathname === '/api/chat/v1/bootstrap')
    return json({ schema: 'theorem.chat.bootstrap.v1', csrfToken: 'csrf' })
  server.calls.push({
    method: call.method,
    path: call.url.pathname,
    search: call.url.search,
    body: call.body,
    headers: call.headers,
  })
  for (const [suffix, refusal] of server.refuse)
    if (call.url.pathname.endsWith(suffix))
      return problem(refusal.status, refusal.code, refusal.detail)
  return route(call)
}

export function install() {
  page.setURL('http://localhost:3000/pages/Desk')
  server.calls = []
  server.described = withRules()
  server.runs = []
  server.refuse = new Map()
  window.fetch = serve as typeof fetch
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
