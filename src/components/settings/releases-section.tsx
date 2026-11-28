// SOURCING: coss Badge and AlertDialog, ui Button, the settings frame rows, and
// lib/releases (release records, activation, rollback, lifecycle, export and
// import). A native details element gives each module its expandable record
// with keyboard and screen-reader behavior for free.
import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Badge } from '@/components/coss/badge'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/coss/alert-dialog'
import { Icon } from '@/components/icons'
import {
  SettingsBox,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-frame'
import { Button } from '@/components/ui/button'
import { useModuleCatalog } from '@/lib/modules/registry'
import { useInstalledModules } from '@/lib/modules/store'
import type { WorkspaceClient } from '@/lib/workspace/types'
import {
  AXIS_LABEL,
  AXIS_NOTE,
  activateCandidate,
  applyMerge,
  disableModule,
  emptyOwned,
  enableModule,
  exportBundle,
  historyOf,
  planImport,
  previousWorking,
  readModuleFolder,
  releaseRecords,
  replaceWithUpdate,
  resetToDefault,
  dismissUpdate,
  rollbackTo,
  uninstallModule,
  useOwnership,
  useReleaseTracking,
  useReleases,
  vaultPorts,
  writeImport,
} from '@/lib/releases'
import type {
  AppBundle,
  ConflictChoice,
  Diagnostic,
  ImportPlan,
  ModuleRecord,
  Provenance,
} from '@/lib/releases'

const short = (id: string) => id.slice(0, 8)

const provenanceLabel = (p: Provenance) =>
  p.kind === 'shipped'
    ? `Shipped (${p.channel} ${p.revision})`
    : p.kind === 'fork'
      ? `Your fork of ${p.upstreamId} at ${p.upstreamRevision}`
      : 'Written by you'

const when = (at: number) => new Date(at).toLocaleString()

/** One diagnostic as a line a person can act on. */
function DiagnosticLine({ d }: { d: Diagnostic }) {
  return (
    <li className="flex flex-col">
      <span className={d.severity === 'error' ? 'text-error-ink' : undefined}>
        {d.file ? `${d.file}: ` : ''}
        {d.message}
      </span>
      {d.hint && <span className="text-ink-muted">{d.hint}</span>}
    </li>
  )
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  URL.revokeObjectURL(url)
}

/** Releases, drafts' source and customizations of every installed module, with recovery. */
export function ReleasesSection({ client }: { client: WorkspaceClient }) {
  useInstalledModules(client)
  useReleaseTracking(client)
  const installed = useModuleCatalog((s) => s.installed)
  const records = useReleases((s) => s.modules)
  const [notice, setNotice] = useState<string>()
  const identities = [
    ...new Set([...installed.map((m) => m.id), ...Object.keys(records)]),
  ].sort()

  return (
    <>
      <SettingsSection
        title="Installed modules and apps"
        description="Each module keeps its releases. A release that fails its checks never replaces the one that works, and your data is never rolled back with the code."
        action={<ImportButton client={client} onNotice={setNotice} />}
      >
        {notice && (
          <p role="status" className="text-sm text-ink-muted">
            {notice}
          </p>
        )}
        {identities.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No module or app is installed in this vault.
          </p>
        ) : (
          <SettingsBox>
            {identities.map((identity) => (
              <ModuleEntry
                key={identity}
                identity={identity}
                label={installed.find((m) => m.id === identity)?.label}
                record={records[identity]}
                client={client}
                onNotice={setNotice}
              />
            ))}
          </SettingsBox>
        )}
      </SettingsSection>
    </>
  )
}

function ModuleEntry({
  identity,
  label,
  record,
  client,
  onNotice,
}: {
  identity: string
  label?: string
  record?: ModuleRecord
  client: WorkspaceClient
  onNotice: (text: string) => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const active = record?.releases.find((r) => r.releaseId === record.activeId)
  const previous = record && previousWorking(record)
  const waiting = record?.candidate?.awaiting === 'grant'
  const failed = record?.candidate && !waiting
  const owned = useOwnership((s) => s.modules[identity])

  const status = record?.uninstalled
    ? { text: 'Uninstalled', variant: 'outline' as const }
    : record?.disabled
      ? { text: 'Disabled', variant: 'outline' as const }
      : failed
        ? { text: 'Candidate failed', variant: 'error' as const }
        : waiting
          ? { text: 'Needs permission', variant: 'warning' as const }
          : active
            ? { text: 'Running', variant: 'success' as const }
            : { text: 'Not checked yet', variant: 'outline' as const }

  const doRollback = async (releaseId: string) => {
    setBusy(true)
    const out = await rollbackTo(identity, releaseId)
    setBusy(false)
    onNotice(
      out.ok
        ? `Switched ${identity} back to release ${short(releaseId)}. ${
            out.access === 'read-write'
              ? 'Your data was not changed.'
              : out.access === 'read-only'
                ? 'Your data is newer than this release can write, so it opens it read-only. The data was not changed.'
                : 'Your data is outside what this release can read, so it can only export it.'
          }`
        : out.message,
    )
  }

  const recheck = async () => {
    setBusy(true)
    try {
      const folder = active
        ? Object.keys(active.files)[0]?.split('/').slice(0, -1).join('/')
        : undefined
      const path = useModuleCatalog
        .getState()
        .installed.find((m) => m.id === identity)?.path
      const where = path ? path.slice(0, path.lastIndexOf('/')) : folder
      if (!where) return onNotice('There is no folder to read for this module.')
      const outcome = await activateCandidate(
        { identity, files: await readModuleFolder(client, where) },
        vaultPorts(client),
        releaseRecords,
      )
      onNotice(
        outcome.status === 'activated'
          ? `Release ${short(outcome.release.releaseId)} is active.`
          : outcome.status === 'unchanged'
            ? 'Nothing changed since the last release.'
            : outcome.status === 'awaiting-grant'
              ? 'The new release asks for permission before it runs. The previous one keeps running.'
              : 'The new release did not pass its checks. The previous one keeps running.',
      )
    } finally {
      setBusy(false)
    }
  }

  const exportIt = () => {
    if (!active) return
    const manifestPath = Object.keys(active.files).find((p) =>
      p.endsWith('module.json'),
    )
    if (!manifestPath) return onNotice('There is no manifest to export.')
    const { bundle, omitted } = exportBundle({
      release: active,
      manifestPath,
      owned: useOwnership.getState().modules[identity] ?? emptyOwned(identity),
    })
    download(`${identity}.theorem-app.json`, JSON.stringify(bundle, null, 2))
    onNotice(`Exported. Left out: ${omitted.join('; ')}.`)
  }

  return (
    <details className="group" data-module={identity}>
      <summary className="cursor-pointer list-none">
        <SettingsRow
          Mark={Icon.Plugin}
          title={
            <span className="flex flex-wrap items-center gap-2">
              {label ?? identity}
              <Badge variant={status.variant}>{status.text}</Badge>
            </span>
          }
          description={[
            identity,
            active && `release ${short(active.releaseId)}`,
            active && provenanceLabel(active.provenance),
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      </summary>
      <div className="flex flex-col gap-4 px-4 pb-4 text-sm">
        <div className="flex flex-wrap gap-2">
          {record?.disabled || record?.uninstalled ? (
            <Button size="sm" onClick={() => enableModule(identity)}>
              Enable
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onNotice(disableModule(identity).note)}
            >
              Disable
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void recheck()}
          >
            Check files again
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!active}
            onClick={exportIt}
          >
            Export
          </Button>
          {previous && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void doRollback(previous.releaseId)}
            >
              Go back to release {short(previous.releaseId)}
            </Button>
          )}
          {!record?.uninstalled && (
            <Button
              size="sm"
              variant="destructive"
              onClick={() => setConfirming(true)}
            >
              Uninstall
            </Button>
          )}
        </div>

        {record?.candidate && (
          <div role="alert" className="flex flex-col gap-1">
            <p className="font-medium">
              {waiting
                ? 'A new release is waiting for your permission'
                : `The last change did not take effect (${record.candidate.stage})`}
            </p>
            <p className="text-ink-muted">
              The release that works keeps running. Your drafts are kept.
            </p>
            <ul className="flex flex-col gap-1">
              {record.candidate.diagnostics.map((d, i) => (
                <DiagnosticLine key={i} d={d} />
              ))}
            </ul>
          </div>
        )}

        {owned?.pending && (
          <UpdatePanel identity={identity} onNotice={onNotice} />
        )}
        {owned?.source && !owned.pending && (
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const current = useOwnership.getState().modules[identity]
                if (!current) return
                const out = resetToDefault(
                  current,
                  current.revision,
                  Date.now(),
                )
                if (out.ok) {
                  useOwnership.getState().update(identity, () => out.owned)
                  onNotice(
                    'Back to the shipped default. Your version is kept in history; your data was not touched.',
                  )
                } else onNotice(out.message)
              }}
            >
              Reset to the shipped default
            </Button>
          </div>
        )}

        <section aria-label="Releases">
          <h3 className="font-medium">Releases</h3>
          {record && record.releases.length ? (
            <ul className="flex flex-col gap-1">
              {record.releases.toReversed().map((r) => (
                <li
                  key={r.releaseId}
                  className="flex flex-wrap items-center gap-2"
                >
                  <span className="font-mono">{short(r.releaseId)}</span>
                  <span className="text-ink-muted">
                    {when(r.at)} · {provenanceLabel(r.provenance)} · reads data
                    v{r.data.reads.min}-{r.data.reads.max}, writes v
                    {r.data.writes.min}-{r.data.writes.max}
                  </span>
                  {r.releaseId === record.activeId ? (
                    <Badge variant="success">Current</Badge>
                  ) : record.working.includes(r.releaseId) ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void doRollback(r.releaseId)}
                    >
                      Switch code back to this
                    </Button>
                  ) : (
                    <Badge variant="outline">Never ran</Badge>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-ink-muted">
              No release has passed its checks yet.
            </p>
          )}
        </section>

        {(['source', 'layout', 'data'] as const).map((axis) => (
          <section key={axis} aria-label={AXIS_LABEL[axis]}>
            <h3 className="font-medium">{AXIS_LABEL[axis]}</h3>
            <p className="text-ink-muted">{AXIS_NOTE[axis]}</p>
            <ul>
              {historyOf(record?.history ?? [], axis)
                .slice(0, 5)
                .map((h, i) => (
                  <li key={i}>
                    {when(h.at)} · {h.summary}
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {label ?? identity}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its commands and key bindings are removed. Your data, settings and
              history are kept, and what it showed becomes a placeholder you can
              open another way or export. Work it already started is not
              stopped.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <AlertDialogClose
              render={<Button variant="destructive" />}
              onClick={() => onNotice(uninstallModule(identity).note)}
            >
              Uninstall
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </details>
  )
}

/** A product update over the person's own version: what changed, and the choices. */
function UpdatePanel({
  identity,
  onNotice,
}: {
  identity: string
  onNotice: (text: string) => void
}) {
  const owned = useOwnership((s) => s.modules[identity])
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({})
  const pending = owned?.pending
  if (!owned || !pending) return null
  const conflicts = pending.merges.filter((m) => m.result?.conflicts)
  const apply = () => {
    const perFile = Object.fromEntries(
      conflicts.map((m) => [
        m.path,
        Array<ConflictChoice>(m.result!.conflicts).fill(
          choices[m.path] ?? 'mine',
        ),
      ]),
    )
    const out = applyMerge(owned, owned.revision, perFile)
    if (out.ok) {
      useOwnership.getState().update(identity, () => out.owned)
      onNotice('Update merged. Your previous version is kept in history.')
    } else onNotice(out.message)
  }
  return (
    <section aria-label="Product update" className="flex flex-col gap-2">
      <h3 className="font-medium">An update is waiting over your version</h3>
      <p className="text-ink-muted">
        Your version keeps running until you decide. Nothing of yours is
        overwritten.
      </p>
      {conflicts.map((m) => (
        <fieldset key={m.path} className="flex flex-wrap items-center gap-2">
          <legend className="font-mono">{m.path}</legend>
          <span className="text-ink-muted">
            {m.result!.conflicts} place(s) both changed:
          </span>
          {(['mine', 'theirs', 'both'] as const).map((c) => (
            <label key={c} className="flex items-center gap-1">
              <input
                type="radio"
                name={`choice-${identity}-${m.path}`}
                checked={(choices[m.path] ?? 'mine') === c}
                onChange={() => setChoices((s) => ({ ...s, [m.path]: c }))}
              />
              {c === 'mine'
                ? 'Keep mine'
                : c === 'theirs'
                  ? 'Take the update'
                  : 'Keep both'}
            </label>
          ))}
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={apply}>
          Merge
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const out = replaceWithUpdate(owned, owned.revision, Date.now())
            if (out.ok)
              useOwnership.getState().update(identity, () => out.owned)
            else onNotice(out.message)
          }}
        >
          Replace mine with the update
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            useOwnership.getState().update(identity, dismissUpdate)
          }
        >
          Keep mine for now
        </Button>
      </div>
    </section>
  )
}

function ImportButton({
  client,
  onNotice,
}: {
  client: WorkspaceClient
  onNotice: (text: string) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [bundle, setBundle] = useState<AppBundle>()
  const [plan, setPlan] = useState<ImportPlan>()
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const raw: unknown = JSON.parse(await file.text())
      const taken = new Set(
        useModuleCatalog.getState().installed.map((m) => m.id),
      )
      const next = await planImport(raw, {
        // The vault is the signed-in person's own; its id scopes whose data may be attached.
        userId: client.workspace.id,
        record: releaseRecords.get(
          (raw as { identity?: string }).identity ?? '',
        ),
        taken,
      })
      setPlan(next)
      setBundle(next.status === 'refused' ? undefined : (raw as AppBundle))
    } catch {
      setPlan({
        status: 'refused',
        diagnostics: [
          {
            stage: 'resolve',
            severity: 'error',
            message: 'That file is not JSON.',
          },
        ],
      })
    }
  }
  const install = async (mode: 'new' | 'new-release' | 'install-as-copy') => {
    if (!bundle) return
    try {
      const done = await writeImport(
        client,
        bundle,
        mode,
        plan?.status === 'conflict' ? plan.copyIdentity : undefined,
      )
      onNotice(
        `Imported ${done.identity}. It is checked like any new release before it runs, and asks for the permissions it needs.`,
      )
      setPlan(undefined)
      setBundle(undefined)
    } catch (error) {
      onNotice(
        error instanceof Error
          ? error.message
          : 'The import failed; nothing was activated.',
      )
    }
  }
  return (
    <div className="flex flex-col items-end gap-2">
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="Choose an exported app"
        onChange={(e) => void choose(e)}
      />
      <Button size="sm" onClick={() => input.current?.click()}>
        Import
      </Button>
      {plan && (
        <div role="status" className="flex max-w-96 flex-col gap-1 text-sm">
          {plan.status === 'already-installed' ? (
            <p>This exact release is already installed. Nothing was added.</p>
          ) : plan.status === 'refused' ? (
            <p className="text-error-ink">It cannot be imported.</p>
          ) : plan.status === 'conflict' ? (
            <p>You already have a module with this id and different code.</p>
          ) : (
            <p>Ready to import. Nothing runs until it passes its checks.</p>
          )}
          <ul>
            {plan.diagnostics.map((d, i) => (
              <DiagnosticLine key={i} d={d} />
            ))}
          </ul>
          {plan.status === 'ready' && (
            <Button size="sm" onClick={() => void install('new')}>
              Import it
            </Button>
          )}
          {plan.status === 'conflict' && (
            <div className="flex flex-wrap gap-2">
              {plan.options.includes('new-release') && (
                <Button size="sm" onClick={() => void install('new-release')}>
                  Add as a new release
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void install('install-as-copy')}
              >
                Install as a separate copy ({plan.copyIdentity})
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
