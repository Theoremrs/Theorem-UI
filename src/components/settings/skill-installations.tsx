// SOURCING: existing coss/Base UI dialogs, selects and settings rows over the native installation API.
import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Badge } from '@/components/coss/badge'
import { Input } from '@/components/coss/input'
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/coss/select'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from '@/components/coss/alert-dialog'
import {
  SettingsBox,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/settings-frame'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Icon } from '@/components/icons'
import { describeError } from '@/lib/theorem/client'
import { useMcpServers } from '@/lib/theorem/connections'
import { isNotServed } from '@/lib/theorem/passthrough'
import { readSkillPackage } from '@/lib/theorem/skill-package'
import type { PreparedImport } from '@/lib/theorem/skill-package'
import {
  useSkillInstallationMutations,
  useSkillInstallations,
} from '@/lib/theorem/skill-installations'
import type { SkillInstallation } from '@/lib/theorem/skill-installations'

const STATUS = {
  ready: 'Ready',
  needs_setup: 'Needs setup',
  limited: 'Partly supported',
} as const

export function SkillInstallations() {
  const query = useSkillInstallations()
  const { remove } = useSkillInstallationMutations()
  const [importing, setImporting] = useState(false)
  const [updating, setUpdating] = useState<SkillInstallation>()
  const [removing, setRemoving] = useState<SkillInstallation>()
  const [settingUp, setSettingUp] = useState<SkillInstallation>()
  const [notice, setNotice] = useState<string>()
  return (
    <SettingsSection
      title="Your imports"
      description="Skills and plugin packages you added. Import the same source again to update it."
      action={
        <Button
          size="sm"
          onClick={() => {
            setUpdating(undefined)
            setImporting(true)
          }}
        >
          Import
        </Button>
      }
    >
      {notice && (
        <p role="status" className="text-sm text-ink-muted">
          {notice}
        </p>
      )}
      {query.error ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-error-ink">
            {isNotServed(query.error)
              ? 'This Theorem does not support skill imports yet.'
              : describeError(query.error)}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : query.isPending ? (
        <p role="status" className="text-sm text-ink-muted">
          Loading imports...
        </p>
      ) : query.data.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Choose a SKILL.md file, a skill folder, or a Claude plugin folder to
          add its workflows.
        </p>
      ) : (
        <SettingsBox>
          {query.data.map((installation) => (
            <div key={installation.installationId}>
              <SettingsRow
                Mark={installation.kind === 'plugin' ? Icon.Plugin : Icon.Skill}
                title={installation.name}
                description={[
                  installation.version,
                  `${installation.skills.length} skills`,
                  installation.source,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              >
                <Badge
                  variant={
                    installation.status === 'ready' ? 'success' : 'warning'
                  }
                >
                  {STATUS[installation.status]}
                </Badge>
                {installation.requirements.length > 0 && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSettingUp(installation)}
                  >
                    {installation.status === 'needs_setup'
                      ? 'Set up'
                      : 'Connections'}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setUpdating(installation)
                    setImporting(true)
                  }}
                >
                  Update
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRemoving(installation)}
                >
                  Remove
                </Button>
              </SettingsRow>
              <InstallationDetails installation={installation} />
            </div>
          ))}
        </SettingsBox>
      )}
      <SkillImportDialog
        open={importing}
        onOpenChange={setImporting}
        updating={updating}
      />
      <Dialog
        open={Boolean(settingUp)}
        onOpenChange={(open) => !open && setSettingUp(undefined)}
      >
        <DialogContent className="sm:max-w-lg">
          {settingUp && (
            <SetupForm
              key={settingUp.installationId}
              installation={settingUp}
              onDone={() => setSettingUp(undefined)}
            />
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(undefined)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Remove this installation and its own skills. Shared skills and
              existing connections stay available.
            </AlertDialogDescription>
            {remove.error && (
              <p role="alert" className="text-sm text-error-ink">
                {describeError(remove.error)}
              </p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              Keep
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                removing &&
                remove.mutate(removing.installationId, {
                  onSuccess: (result) => {
                    setNotice(
                      `Removed ${removing.name}.${result.preserved.length ? ' Shared skills were kept.' : ''}`,
                    )
                    setRemoving(undefined)
                  },
                })
              }
            >
              {remove.isPending ? 'Removing...' : 'Remove installation'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  )
}

export function InstallationDetails({
  installation,
}: {
  installation: SkillInstallation
}) {
  const { requirements = [], unsupported = [] } = installation
  return (
    <details className="px-3 pb-3 text-xs text-ink-muted">
      <summary className="cursor-pointer py-1">
        Included skills and setup
      </summary>
      <ul className="mt-2 flex flex-col gap-1">
        {installation.skills.map((skill) => (
          <li key={skill.id}>{skill.name}</li>
        ))}
        {requirements.map((item) => (
          <li key={item.name}>
            {item.name}: {item.status === 'ready' ? 'Connected' : 'Needs setup'}
            {item.connectionId ? ` (${item.connectionId})` : ''}
          </li>
        ))}
      </ul>
      {unsupported.length > 0 && (
        <div className="mt-3">
          <p className="font-medium text-ink">Not installed</p>
          <ul className="mt-1 max-h-40 list-inside list-disc overflow-auto">
            {unsupported.map((item) => (
              <li key={item} className="wrap-anywhere">
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </details>
  )
}

export function SkillImportDialog({
  open,
  onOpenChange,
  updating,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  updating?: SkillInstallation
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <ImportForm updating={updating} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function ImportForm({
  updating,
  onDone,
}: {
  updating?: SkillInstallation
  onDone: () => void
}) {
  const { install } = useSkillInstallationMutations()
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const attempt = useRef(0)
  const [reading, setReading] = useState(false)
  const [prepared, setPrepared] = useState<PreparedImport>()
  const [source, setSource] = useState('')
  const [bindings, setBindings] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? [])
    if (!selected.length) return
    const current = ++attempt.current
    setReading(true)
    setError(undefined)
    setPrepared(undefined)
    install.reset()
    try {
      const next = await readSkillPackage(selected)
      if (
        updating &&
        (next.name !== updating.name || next.kind !== updating.kind)
      )
        throw new Error(
          `Choose the ${updating.name} package to update this installation.`,
        )
      if (current !== attempt.current) return
      setPrepared(next)
      setSource(updating?.source ?? next.request.source)
      setBindings(
        Object.fromEntries(
          next.requirements.flatMap((name) =>
            updating?.connections[name]
              ? [[name, updating.connections[name]]]
              : [],
          ),
        ),
      )
    } catch (failure) {
      if (current === attempt.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'The package could not be read.',
        )
    } finally {
      if (current === attempt.current) setReading(false)
      event.target.value = ''
    }
  }
  if (install.data)
    return (
      <>
        <DialogHeader>
          <DialogTitle>
            {updating ? 'Updated' : 'Imported'} {install.data.name}
          </DialogTitle>
          <DialogDescription>
            {STATUS[install.data.status]}. {install.data.skills.length} skills
            are registered with Theorem.
          </DialogDescription>
        </DialogHeader>
        <InstallationDetails installation={install.data} />
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </>
    )
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!prepared || reading) return
        install.mutate({
          ...prepared.request,
          source: source.trim(),
          connections: bindings,
        })
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {updating ? `Update ${updating.name}` : 'Import skills or a plugin'}
        </DialogTitle>
        <DialogDescription>
          Choose a SKILL.md file or a folder. Skill folders include supporting
          files; plugin folders include a plugin.json manifest and skills.
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-wrap gap-2">
        <input
          ref={fileInput}
          type="file"
          accept=".md,.markdown"
          className="hidden"
          aria-label="Skill file"
          onChange={(event) => void choose(event)}
        />
        <input
          ref={(input) => {
            folderInput.current = input
            input?.setAttribute('webkitdirectory', '')
          }}
          type="file"
          multiple
          className="hidden"
          aria-label="Skill or plugin folder"
          onChange={(event) => void choose(event)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={reading || install.isPending}
          onClick={() => fileInput.current?.click()}
        >
          Choose SKILL.md
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={reading || install.isPending}
          onClick={() => folderInput.current?.click()}
        >
          Choose folder
        </Button>
      </div>
      {reading && (
        <p role="status" className="text-sm text-ink-muted">
          Reading package...
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-error-ink">
          {error}
        </p>
      )}
      {prepared && (
        <>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">
              {prepared.name}
              {prepared.version ? ` · ${prepared.version}` : ''}
            </h3>
            <p className="text-sm text-ink-muted">
              {prepared.kind === 'skill'
                ? 'One skill'
                : `${prepared.request.skills?.length ?? 0} skills`}
              , with supporting files.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm">
            Source
            <Input
              value={source}
              onChange={(event) => setSource(event.target.value)}
              disabled={Boolean(updating) || install.isPending}
            />
          </label>
          {prepared.requirements.length > 0 && (
            <ConnectionBindings
              names={prepared.requirements}
              bindings={bindings}
              onChange={setBindings}
              disabled={install.isPending}
            />
          )}
          {prepared.notices.length > 0 && (
            <details className="rounded-lg border border-separator p-3 text-xs text-ink-muted">
              <summary className="cursor-pointer font-medium text-ink">
                Not installed ({prepared.notices.length})
              </summary>
              <ul className="mt-2 max-h-40 list-inside list-disc overflow-auto">
                {prepared.notices.map((item) => (
                  <li key={item} className="wrap-anywhere">
                    {item}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {install.error && (
        <p role="alert" className="text-sm text-error-ink">
          {describeError(install.error)}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={install.isPending}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!prepared || !source.trim() || reading || install.isPending}
        >
          {install.isPending
            ? 'Importing...'
            : updating
              ? 'Update installation'
              : 'Import package'}
        </Button>
      </DialogFooter>
    </form>
  )
}

function ConnectionBindings({
  names,
  bindings,
  onChange,
  disabled,
}: {
  names: string[]
  bindings: Record<string, string>
  onChange: (next: Record<string, string>) => void
  disabled: boolean
}) {
  const servers = useMcpServers()
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">Connections this package needs</h3>
      <p className="text-xs text-ink-muted">
        Use an existing connection or finish setup later. Importing does not
        start a server.
      </p>
      {servers.error && (
        <p role="alert" className="text-sm text-error-ink">
          {describeError(servers.error)}
        </p>
      )}
      {names.map((name) => (
        <div key={name} className="flex flex-col gap-1 text-sm">
          <span>{name}</span>
          <Select
            value={bindings[name] ?? ''}
            onValueChange={(value) => {
              const next = { ...bindings }
              if (value) next[name] = value
              else delete next[name]
              onChange(next)
            }}
            disabled={disabled}
          >
            <SelectTrigger aria-label={`Connection for ${name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">Set up later</SelectItem>
              {(servers.data ?? []).map((server) => (
                <SelectItem key={server.id} value={server.id}>
                  {server.label}
                  {server.status !== 'connected'
                    ? ' — needs setup'
                    : !server.enabled
                      ? ' — off'
                      : ''}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ))}
      <a
        href="/settings/connections"
        target="_blank"
        rel="noreferrer"
        className="self-start text-xs underline underline-offset-2"
      >
        Manage connections
      </a>
    </div>
  )
}

function SetupForm({
  installation,
  onDone,
}: {
  installation: SkillInstallation
  onDone: () => void
}) {
  const { setup } = useSkillInstallationMutations()
  const [bindings, setBindings] = useState(installation.connections)
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        setup.mutate(
          { id: installation.installationId, connections: bindings },
          { onSuccess: onDone },
        )
      }}
    >
      <DialogHeader>
        <DialogTitle>Set up {installation.name}</DialogTitle>
        <DialogDescription>
          Choose which existing connections this installation can use.
        </DialogDescription>
      </DialogHeader>
      <ConnectionBindings
        names={installation.requirements.map((item) => item.name)}
        bindings={bindings}
        onChange={setBindings}
        disabled={setup.isPending}
      />
      {setup.error && (
        <p role="alert" className="text-sm text-error-ink">
          {describeError(setup.error)}
        </p>
      )}
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onDone}
          disabled={setup.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={setup.isPending}>
          {setup.isPending ? 'Saving...' : 'Save connections'}
        </Button>
      </DialogFooter>
    </form>
  )
}
