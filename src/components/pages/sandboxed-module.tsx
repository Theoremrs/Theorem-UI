// SOURCING: the block frame (../blocks/block-frame: a sandboxed iframe with
// `allow-scripts` only, and its bridge over one MessagePort), the hosted App
// document (src/lib/blocks/hosted-app.ts: the same restrictive policy a
// conversation App gets, from a blob URL, so no local listener is needed,
// and the page's look, which followTheme keeps current),
// and the grants store, which keeps what the person allowed in this browser.
// A module runs only with a grant for its exact files. Its capability calls
// are answered by lib/modules/capability-host; where it cannot run, its
// manifest's fallback (./module-fallback) shows its records instead.
import { useQueryClient } from '@tanstack/react-query'
import { Play, ShieldAlert, Square, Undo2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { BlockFrame } from '@/components/blocks/block-frame'
import { BlockMessage } from '@/components/blocks/block-status'
import { capabilityKeys } from '@/components/capabilities/queries'
import { Button } from '@/components/ui/button'
import type { BridgeHost, StateCollections } from '@/lib/blocks/bridge'
import { followTheme, hostedAppDocument } from '@/lib/blocks/hosted-app'
import type { Rpc } from '@/lib/blocks/sandbox/protocol'
import { workspaceState } from '@/lib/blocks/state'
import { moduleCapabilities } from '@/lib/modules/capability-host'
import type { RequestedCapabilities } from '@/lib/modules/contract'
import {
  grantFor,
  grantKey,
  granted,
  useModuleGrants,
} from '@/lib/modules/grants'
import type { ModuleDefinition, ModuleViewProps } from '@/lib/modules/registry'
import {
  allowedFrom,
  bridgeCapabilities,
  describeRequest,
  requestId,
  requestsOf,
  sendAction,
  sendValues,
  serveModule,
} from '@/lib/modules/sandbox'
import { useModuleFiles, useVaultClient } from '@/lib/modules/store'
import { AskAboutModule } from './module-agent'
import { useRunningModuleFiles } from './running-release'
import { WithFallback } from './module-fallback'
import { useModuleActions, usePageRuntime } from './page-runtime'
import type { ModuleFiles } from '@/lib/modules/store'
import type { WorkspaceClient, WorkspaceId } from '@/lib/workspace/types'

/** State collections that reach the workspace only once a module uses one. */
function lazyState(id: WorkspaceId): StateCollections {
  const replica = () => workspaceState(id)
  return {
    snapshot: (name) => replica().snapshot(name),
    set: (name, key, value) => replica().set(name, key, value),
    delete: (name, key) => replica().delete(name, key),
    subscribe: (name, listener) => replica().subscribe(name, listener),
  }
}

export function SandboxedModule({
  definition,
  view,
}: {
  definition: ModuleDefinition
  view: ModuleViewProps
}) {
  const { client, isPending, missing } = useVaultClient()
  if (definition.implementation.kind !== 'sandboxed-html') return null
  // Nothing runs while the page is arranged: a frame would take the
  // pointer from the editor, and its code has no business running then.
  if (view.arranging) return <ArrangingSummary definition={definition} />
  if (!client)
    return (
      <WithFallback definition={definition} view={view}>
        <BlockMessage>
          {isPending
            ? 'Opening the vault…'
            : `This module lives in the Theorem vault. ${missing}`}
        </BlockMessage>
      </WithFallback>
    )
  const { folder, entry } = definition.implementation
  return (
    <VaultModule
      client={client}
      definition={definition}
      folder={folder}
      entry={entry}
      view={view}
    />
  )
}

function ArrangingSummary({ definition }: { definition: ModuleDefinition }) {
  const ports = (label: string, list: ModuleDefinition['inputs']) =>
    list.length ? `${label}: ${list.map((p) => p.label).join(', ')}` : undefined
  return (
    <div className="flex flex-col gap-1 p-3 text-xs text-ink-muted">
      <p className="text-sm text-ink">
        {definition.label} runs when you use the page.
      </p>
      {[
        ports('Takes', definition.inputs),
        ports('Gives', definition.outputs),
        ports('Sends', definition.events),
      ]
        .filter(Boolean)
        .map((line) => (
          <p key={line}>{line}</p>
        ))}
    </div>
  )
}

/** A running module's bar: what it is doing, its Ask, Run or Stop, and Revoke. */
function ModuleBar({
  stopped,
  failure,
  ask,
  onRun,
  onStop,
  onRevoke,
}: {
  stopped: boolean
  /** What the frame reported when it failed, if it did. */
  failure?: string
  ask: ReactNode
  onRun: () => void
  onStop: () => void
  onRevoke: () => void
}) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1 border-b border-separator px-2 text-xs text-ink-faint">
      <span className="me-auto truncate">
        {stopped
          ? 'Stopped'
          : failure
            ? 'Stopped by an error'
            : 'Running in a sandbox'}
      </span>
      {ask}
      {stopped || failure ? (
        <Button variant="ghost" size="xs" onClick={onRun}>
          <Play />
          Run
        </Button>
      ) : (
        <Button variant="ghost" size="xs" onClick={onStop}>
          <Square />
          Stop
        </Button>
      )}
      <Button variant="ghost" size="xs" onClick={onRevoke}>
        <Undo2 />
        Revoke
      </Button>
    </div>
  )
}

export function VaultModule({
  client,
  definition,
  folder,
  entry,
  view,
}: {
  client: WorkspaceClient
  definition: ModuleDefinition
  folder: string
  entry: string
  view: ModuleViewProps
}) {
  const vaultFiles = useModuleFiles(client, folder, entry)
  // The active release runs, which after a rollback is not the vault's latest.
  const running = useRunningModuleFiles(
    definition.id,
    folder,
    entry,
    vaultFiles.data,
  )
  const files = { error: vaultFiles.error, data: running }
  const key = grantKey(client.workspace.id, definition.id)
  const digest = files.data?.digest
  const grant = useModuleGrants((s) => grantFor(s.grants, key, digest))
  const hadGrant = useModuleGrants((s) => key in s.grants)
  const [stopped, setStopped] = useState(false)
  // What the frame reported when it failed; only a module with a fallback
  // gives way on an error, so one without keeps running as before.
  const [failure, setFailure] = useState<string>()
  const ask = <AskAboutModule definition={definition} view={view} />

  if (files.error)
    return (
      <WithFallback definition={definition} view={view}>
        <BlockMessage tone="error">{files.error.message}</BlockMessage>
      </WithFallback>
    )
  if (!files.data) return <BlockMessage>Reading the module…</BlockMessage>
  if (!grant)
    return (
      <WithFallback definition={definition} view={view}>
        <GrantGate
          files={files.data}
          grantKeyValue={key}
          changed={hadGrant}
          folder={folder}
          ask={ask}
        />
      </WithFallback>
    )
  const allowed = granted(files.data.manifest.capabilities, grant.capabilities)
  const revoke = () => useModuleGrants.getState().revoke(key)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ModuleBar
        stopped={stopped}
        failure={failure}
        ask={ask}
        onRun={() => {
          setStopped(false)
          setFailure(undefined)
        }}
        onStop={() => setStopped(true)}
        onRevoke={revoke}
      />
      {stopped ? (
        <WithFallback definition={definition} view={view}>
          {null}
        </WithFallback>
      ) : failure ? (
        <WithFallback definition={definition} view={view}>
          <BlockMessage tone="error">
            {definition.label} stopped: {failure}
          </BlockMessage>
        </WithFallback>
      ) : (
        <ModuleFrameBody
          client={client}
          definition={definition}
          folder={folder}
          source={files.data.source}
          allowed={allowed}
          view={view}
          {...(definition.fallback ? { onFailure: setFailure } : {})}
        />
      )}
    </div>
  )
}

/** What the module asks for, for the person to allow all or part of. */
function GrantGate({
  files,
  grantKeyValue,
  changed,
  folder,
  ask,
}: {
  files: ModuleFiles
  grantKeyValue: string
  changed: boolean
  folder: string
  ask: ReactNode
}) {
  const requests = useMemo(
    () => requestsOf(files.manifest.capabilities),
    [files.manifest.capabilities],
  )
  const [ticked, setTicked] = useState<ReadonlySet<string>>(
    () => new Set(requests.map(requestId)),
  )
  const allow = () =>
    useModuleGrants.getState().grant(grantKeyValue, {
      digest: files.digest,
      capabilities: allowedFrom(
        requests.filter((r) => ticked.has(requestId(r))),
      ),
      grantedAt: Date.now(),
    })
  return (
    <div className="flex flex-col gap-3 p-3 text-sm">
      <div className="flex items-start gap-2">
        <ShieldAlert
          className="mt-0.5 size-4 shrink-0 text-ink-muted"
          aria-hidden
        />
        <p className="text-ink-muted">
          <span className="font-medium text-ink">
            {changed
              ? `${files.manifest.label} changed since you allowed it, so it asks again.`
              : `${files.manifest.label} is code from ${folder}.`}
          </span>{' '}
          It runs in a sandbox and reaches only what you allow here. What it
          asks for is not allowed until you say so.
        </p>
      </div>
      {requests.length ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs text-ink-muted">It asks to</legend>
          {requests.map((request) => (
            <label
              key={requestId(request)}
              className="flex items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                checked={ticked.has(requestId(request))}
                onChange={(event) => {
                  const next = new Set(ticked)
                  if (event.target.checked) next.add(requestId(request))
                  else next.delete(requestId(request))
                  setTicked(next)
                }}
              />
              <span className="font-mono text-xs">
                {describeRequest(request)}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-xs text-ink-muted">
          It asks for nothing beyond reading its own folder.
        </p>
      )}
      <div className="flex items-center gap-1">
        <Button variant="outline" size="xs" onClick={allow}>
          <Play />
          {requests.length && ticked.size < requests.length
            ? 'Run with what is ticked'
            : 'Run it'}
        </Button>
        {ask}
      </div>
    </div>
  )
}

/** The running frame: its document, its bridge, and its values handed in. */
function ModuleFrameBody({
  client,
  definition,
  folder,
  source,
  allowed,
  view,
  onFailure,
}: {
  client: WorkspaceClient
  definition: ModuleDefinition
  folder: string
  source: string
  allowed: RequestedCapabilities
  view: ModuleViewProps
  /** Hears the frame's first reported error; absent, an error changes nothing here. */
  onFailure?: (message: string) => void
}) {
  const runtime = usePageRuntime()
  const queryClient = useQueryClient()
  const failed = useRef(onFailure)
  useLayoutEffect(() => {
    failed.current = onFailure
  })
  const allowedKey = JSON.stringify(allowed)
  const netKey = JSON.stringify(allowed.net)
  const [frameDocument, setFrameDocument] = useState<{
    src?: string
    error?: string
  }>({})
  useEffect(() => {
    let active = true
    let url: string | undefined
    void hostedAppDocument(source, undefined, {
      net: JSON.parse(netKey) as string[],
    })
      .then((page) => {
        if (!active) return
        url = URL.createObjectURL(new Blob([page], { type: 'text/html' }))
        setFrameDocument({ src: url })
      })
      .catch((error: unknown) => {
        if (active)
          setFrameDocument({
            error: error instanceof Error ? error.message : String(error),
          })
      })
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [source, netKey])

  const host = useMemo<BridgeHost>(() => {
    const lent = JSON.parse(allowedKey) as RequestedCapabilities
    return {
      client,
      capabilities: bridgeCapabilities(lent, folder),
      state: lazyState(client.workspace.id),
      run: () => {
        throw new Error('A module does not start agents.')
      },
      // Only the instances and actions granted; the bridge refuses the rest.
      capability: moduleCapabilities(lent.instances ?? [], {
        onInvoked: (instanceId) =>
          void queryClient.invalidateQueries({
            queryKey: capabilityKeys.instance(instanceId),
          }),
      }),
      onError: (error) => failed.current?.(error.message),
    }
  }, [client, allowedKey, folder, queryClient])

  // The frame's connection outlives renders; it reads the latest view.
  const latest = useRef(view)
  useLayoutEffect(() => {
    latest.current = view
  })
  const rpc = useRef<Rpc | null>(null)
  const valuesKey = JSON.stringify({
    settings: view.settings,
    inputs: view.inputs,
  })
  useEffect(() => {
    const { settings, inputs } = latest.current
    if (rpc.current)
      void sendValues(rpc.current, { settings, inputs }).catch(() => {})
  }, [valuesKey])

  // A route's action goes to the frame; one that comes while the frame
  // starts waits for it.
  const waiting = useRef<Array<[string, unknown]>>([])
  const actionNames = useMemo(
    () => definition.actions.map((a) => a.name),
    [definition.actions],
  )
  useModuleActions(actionNames, (name, payload) => {
    if (rpc.current) void sendAction(rpc.current, name, payload).catch(() => {})
    else waiting.current.push([name, payload])
  })

  if (frameDocument.error)
    return (
      <WithFallback definition={definition} view={view}>
        <BlockMessage tone="error">{frameDocument.error}</BlockMessage>
      </WithFallback>
    )
  if (!frameDocument.src)
    return <BlockMessage>Starting the module…</BlockMessage>
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <BlockFrame
        src={frameDocument.src}
        host={host}
        title={definition.label}
        className="h-full [&>iframe]:min-h-full"
        limited
        onConnection={(connection) => {
          let active = true
          const unfollow = followTheme(connection)
          void connection.connected.then(
            (connected) => {
              if (!active) return
              serveModule(connected, {
                outputs: definition.outputs,
                events: definition.events,
                output: (name, value) => latest.current.output(name, value),
                emit: (name, payload) => latest.current.emit(name, payload),
                used: () => runtime.used(latest.current.path),
              })
              rpc.current = connected
              const { settings, inputs } = latest.current
              void sendValues(connected, { settings, inputs }).catch(() => {})
              for (const [name, payload] of waiting.current.splice(0))
                void sendAction(connected, name, payload).catch(() => {})
            },
            () => {},
          )
          return () => {
            active = false
            unfollow()
            rpc.current = null
          }
        }}
      />
    </div>
  )
}
