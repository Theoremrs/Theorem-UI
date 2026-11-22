// SOURCING: zod (every call a module's frame makes is parsed before use) over
// the block bridge's JSON-RPC methods (src/lib/blocks/sandbox/protocol.ts). A
// sandboxed module gets the same files and state bridge an HTML app gets,
// limited to what the person granted, plus the outputs and events its
// manifest declares, and nothing else.
import { z } from 'zod'
import { BridgeDenied } from '@/lib/blocks/bridge'
import type { Capabilities } from '@/lib/blocks/declarations'
import { call, serve } from '@/lib/blocks/sandbox/protocol'
import type {
  ModuleValues,
  PageMethods,
  Rpc,
  SandboxMethods,
} from '@/lib/blocks/sandbox/protocol'
import type {
  InstanceRequest,
  PortSpec,
  RequestedCapabilities,
} from './contract'
import { identifier } from './contract'
import { isValueOf } from './values'

const params = {
  output: z.object({ name: identifier, value: z.unknown() }),
  emit: z.object({ name: identifier, payload: z.unknown() }),
}

/** What a module's frame may publish and send, and where it goes. */
export interface ModulePorts {
  outputs: ReadonlyArray<PortSpec>
  events: ReadonlyArray<PortSpec>
  output: (name: string, value: unknown) => void
  emit: (name: string, payload: unknown) => void
  /** A person used the frame; input inside it never reaches the page. */
  used: () => void
}

function declared(
  ports: ReadonlyArray<PortSpec>,
  name: string,
  what: 'output' | 'event',
  value: unknown,
): void {
  const port = ports.find((p) => p.name === name)
  if (!port)
    throw new BridgeDenied(
      `"${name}" is not one of this module's ${what}s; declare it in module.json`,
    )
  if (!isValueOf(port.type, value))
    throw new BridgeDenied(`The ${what} "${name}" takes a ${port.type} value`)
}

/** Serves `module.output`, `module.emit` and `module.used` to one module's frame. */
export function serveModule(rpc: Rpc, ports: ModulePorts): void {
  serve<PageMethods, 'module.output'>(rpc, 'module.output', (raw) => {
    const { name, value } = params.output.parse(raw)
    declared(ports.outputs, name, 'output', value)
    ports.output(name, value)
    return null
  })
  serve<PageMethods, 'module.emit'>(rpc, 'module.emit', (raw) => {
    const { name, payload } = params.emit.parse(raw)
    declared(ports.events, name, 'event', payload)
    ports.emit(name, payload)
    return null
  })
  // Only the frame can see its input. Trusting it costs nothing: the depth
  // limit is against accidental loops, and the rate limit still holds.
  serve<PageMethods, 'module.used'>(rpc, 'module.used', () => {
    ports.used()
    return null
  })
}

/** Hands a module's frame its current settings and inputs. */
export const sendValues = (rpc: Rpc, values: ModuleValues) =>
  call<SandboxMethods, 'module.inputs'>(rpc, 'module.inputs', values)

/** Hands a module's frame one of its declared actions, as a route reached it. */
export const sendAction = (rpc: Rpc, name: string, payload: unknown) =>
  call<SandboxMethods, 'module.action'>(rpc, 'module.action', {
    name,
    payload,
  })

/**
 * The bridge's capabilities for a module: what was granted, plus reading its
 * own folder. A module never starts agents and keeps no database.
 */
export function bridgeCapabilities(
  grant: RequestedCapabilities,
  folder: string,
): Capabilities {
  return {
    read: [...grant.read, `${folder}/**`],
    write: grant.write,
    state: grant.state,
    net: grant.net,
    run: [],
    db: [],
  }
}

/** Every item a module asks for, one line each, for the person to allow. */
export type Request =
  | { kind: 'read' | 'write' | 'state' | 'net'; value: string }
  | {
      kind: 'instance'
      instanceId: string
      method: 'describe' | 'query'
    }
  | { kind: 'instance'; instanceId: string; method: 'invoke'; action: string }

/** A request's stable name, for the line that allows it. */
export const requestId = (request: Request): string =>
  request.kind !== 'instance'
    ? `${request.kind}:${request.value}`
    : request.method === 'invoke'
      ? `instance:${request.instanceId}:invoke:${request.action}`
      : `instance:${request.instanceId}:${request.method}`

const instanceRequests = (asked: InstanceRequest): Request[] =>
  asked.methods.flatMap((method): Request[] =>
    method === 'invoke'
      ? asked.actions.map((action) => ({
          kind: 'instance',
          instanceId: asked.instanceId,
          method,
          action,
        }))
      : [{ kind: 'instance', instanceId: asked.instanceId, method }],
  )

export const requestsOf = (requested: RequestedCapabilities): Request[] => [
  ...(['read', 'write', 'state', 'net'] as const).flatMap((kind) =>
    requested[kind].map((value): Request => ({ kind, value })),
  ),
  ...(requested.instances ?? []).flatMap(instanceRequests),
]

export const describeRequest = (request: Request): string => {
  if (request.kind === 'instance')
    switch (request.method) {
      case 'describe':
        return `Read how ${request.instanceId} is defined`
      case 'query':
        return `Read records in ${request.instanceId}`
      case 'invoke':
        return `Run “${request.action}” in ${request.instanceId}`
    }
  const { kind, value } = request
  switch (kind) {
    case 'read':
      return `Read ${value}`
    case 'write':
      return `Change ${value}`
    case 'state':
      return `Keep state in “${value}”`
    case 'net':
      return `Reach ${value} over the network`
  }
}

/** The allowed part, as capabilities, from the requests the person ticked. */
export function allowedFrom(
  requests: ReadonlyArray<Request>,
): RequestedCapabilities {
  const allowed: RequestedCapabilities = {
    read: [],
    write: [],
    state: [],
    net: [],
    instances: [],
  }
  const instances = new Map<string, InstanceRequest>()
  for (const request of requests) {
    if (request.kind !== 'instance') {
      allowed[request.kind].push(request.value)
      continue
    }
    const entry = instances.get(request.instanceId) ?? {
      instanceId: request.instanceId,
      methods: [],
      actions: [],
    }
    if (!entry.methods.includes(request.method))
      entry.methods.push(request.method)
    if (request.method === 'invoke') entry.actions.push(request.action)
    instances.set(request.instanceId, entry)
  }
  allowed.instances = [...instances.values()]
  return allowed
}
