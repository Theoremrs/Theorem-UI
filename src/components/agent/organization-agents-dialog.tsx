// SOURCING: ui/dialog over Base UI Dialog, coss input and textarea, zustand (whether the dialog is open and which agent it shows), lib/theorem/organization-agents (Theorem's organization record owns the agents, their lineage, knowledge bindings, packages and evaluation reports; this only reads and writes them). Layout follows the Rex settings rows: one quiet row per agent, its detail below the list, no capability matrix (AG-02). Unified Agent Experience spec, Gates 4 and 5.
import { useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import { Input } from '@/components/coss/input'
import { Switch } from '@/components/coss/switch'
import { Textarea } from '@/components/coss/textarea'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { entriesOf, profileProblem } from '@/lib/theorem/agent-profile'
import type { AgentProfile } from '@/lib/theorem/agent-profile'
import { describeError } from '@/lib/theorem/client'
import {
  agentName,
  checkImport,
  chosenAgentId,
  exportAgent,
  lineageLine,
  packageFileName,
  parsePackage,
  percent,
  resolutionLine,
  runEvaluation,
  useAgentMemories,
  useChosenAgent,
  useCreateAgent,
  useImportAgent,
  useKnowledgeProviders,
  useOrganizationAgents,
  useRemoveAgent,
  useSaveAgentKnowledge,
  useSaveAgentProfileOf,
  useSaveOrganizationSettings,
} from '@/lib/theorem/organization-agents'
import type {
  AgentPackage,
  EvaluationReport,
  ImportCheck,
  OrganizationAgent,
} from '@/lib/theorem/organization-agents'
import { useAgentProfileDialog } from './agent-profile-dialog'
import { useOrganizationAgentsDialog } from './agents-dialog-store'
import { TheoremError } from '@theoremharness/sdk'

export { useOrganizationAgentsDialog }

export function OrganizationAgentsDialog() {
  const { open, setOpen } = useOrganizationAgentsDialog()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg font-semibold">
            Agents
          </DialogTitle>
          <DialogDescription>
            The agents of this organization. Each keeps its own memories; roles,
            tools and policy stay the organization&apos;s.
          </DialogDescription>
        </DialogHeader>
        {open && <AgentsBody />}
      </DialogContent>
    </Dialog>
  )
}

function Problem({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <p role="alert" className="text-sm text-error-ink">
      {describeError(error)}
    </p>
  )
}

const isConflict = (error: unknown) =>
  error instanceof TheoremError && error.statusCode === 409

/** A refused save of a draft read at an older revision, with the way to read the newer one. */
function SaveProblem({
  error,
  onReload,
}: {
  error: unknown
  onReload: () => void
}) {
  if (!isConflict(error)) return <Problem error={error} />
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className="text-sm text-error-ink">
        The organization changed somewhere else since this was read.
      </p>
      <Button size="xs" variant="outline" onClick={onReload}>
        Load the newer version
      </Button>
    </div>
  )
}

function AgentsBody() {
  const agents = useOrganizationAgents()
  const [shown, setShown] = useState<string | null>(null)
  if (agents.isPending)
    return <p className="text-sm text-ink-muted">Reading the agents…</p>
  if (agents.error) return <Problem error={agents.error} />
  if (!agents.data.served)
    return (
      <p className="text-sm text-ink-muted">
        This Theorem keeps one agent. It cannot hold further agents yet.
      </p>
    )
  const { revision, multipleAgents, agents: list } = agents.data
  const detail = list.find((agent) => agent.agent_id === shown)
  return (
    <div className="flex flex-col gap-5">
      <SettingRow
        revision={revision}
        multipleAgents={multipleAgents}
        further={list.length - 1}
      />
      <ul className="flex flex-col divide-y divide-separator rounded-md border border-separator">
        {list.map((agent) => (
          <AgentRow
            key={agent.agent_id}
            agent={agent}
            open={agent.agent_id === shown}
            onToggle={() =>
              setShown(agent.agent_id === shown ? null : agent.agent_id)
            }
          />
        ))}
      </ul>
      {detail && (
        <AgentDetail key={detail.agent_id} agent={detail} revision={revision} />
      )}
      {multipleAgents && <CreateAgent revision={revision} />}
      <ImportAgent revision={revision} multipleAgents={multipleAgents} />
    </div>
  )
}

function SettingRow({
  revision,
  multipleAgents,
  further,
}: {
  revision: number
  multipleAgents: boolean
  further: number
}) {
  const save = useSaveOrganizationSettings()
  // Turning it off with further agents present is refused by Theorem; say so before trying.
  const locked = multipleAgents && further > 0
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={multipleAgents}
          disabled={locked || save.isPending}
          onCheckedChange={(checked) =>
            save.mutate({
              multipleAgents: checked,
              expectedRevision: revision,
            })
          }
        />
        Allow several agents in this organization
      </label>
      {locked && (
        <span className="ps-6 text-xs text-ink-muted">
          Remove the further agents to turn this off.
        </span>
      )}
      <Problem error={save.error} />
    </div>
  )
}

function AgentRow({
  agent,
  open,
  onToggle,
}: {
  agent: OrganizationAgent
  open: boolean
  onToggle: () => void
}) {
  const agentId = useChosenAgent(chosenAgentId)
  const choose = useChosenAgent((state) => state.choose)
  const talking = agent.primary ? agentId === null : agentId === agent.agent_id
  const lineage = lineageLine(agent)
  const failed = agent.knowledge_resolution.state === 'failed'
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-start outline-focus focus-visible:outline-2"
      >
        <span className="truncate text-sm text-ink">
          {agentName(agent)}
          {agent.primary && (
            <span className="ms-2 text-xs text-ink-faint">primary</span>
          )}
        </span>
        {lineage && (
          <span className="truncate text-xs text-ink-muted">{lineage}</span>
        )}
        <span
          className={`truncate text-xs ${failed ? 'text-error-ink' : 'text-ink-faint'}`}
        >
          {resolutionLine(agent.knowledge_resolution)}
        </span>
      </button>
      <Button
        size="xs"
        variant={talking ? 'secondary' : 'ghost'}
        disabled={talking || failed}
        title={
          failed ? 'Its knowledge cannot be reached on this host' : undefined
        }
        onClick={() => choose(agent.primary ? null : agent.agent_id)}
      >
        {talking ? 'Talking to' : 'Talk to'}
      </Button>
    </li>
  )
}

function AgentDetail({
  agent,
  revision,
}: {
  agent: OrganizationAgent
  revision: number
}) {
  return (
    <section
      aria-label={`${agentName(agent)} details`}
      className="flex flex-col gap-3 text-sm"
    >
      <details open>
        <summary className="cursor-default">Profile</summary>
        <div className="mt-3">
          {agent.primary ? (
            <PrimaryProfile />
          ) : (
            <ProfileEdit agent={agent} revision={revision} />
          )}
        </div>
      </details>
      <details>
        <summary className="cursor-default">Knowledge</summary>
        <div className="mt-3">
          <KnowledgeEdit agent={agent} revision={revision} />
        </div>
      </details>
      <details>
        <summary className="cursor-default">Export</summary>
        <div className="mt-3">
          <ExportAgent agent={agent} />
        </div>
      </details>
      <details>
        <summary className="cursor-default">
          Try another knowledge provider
        </summary>
        <div className="mt-3">
          <EvaluateKnowledge agent={agent} />
        </div>
      </details>
      {!agent.primary && <RemoveAgent agent={agent} revision={revision} />}
    </section>
  )
}

function PrimaryProfile() {
  const openProfile = useAgentProfileDialog((state) => state.setOpen)
  const close = useOrganizationAgentsDialog((state) => state.setOpen)
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() => {
        close(false)
        openProfile(true)
      }}
    >
      Edit the primary agent&apos;s profile
    </Button>
  )
}

/** Each reload mounts the form anew from the agent and revision as they stand now. */
function ProfileEdit(props: { agent: OrganizationAgent; revision: number }) {
  const [reads, setReads] = useState(0)
  return (
    <ProfileForm
      key={reads}
      {...props}
      onReload={() => setReads((count) => count + 1)}
    />
  )
}

function ProfileForm({
  agent,
  revision,
  onReload,
}: {
  agent: OrganizationAgent
  revision: number
  onReload: () => void
}) {
  const save = useSaveAgentProfileOf()
  // The revision the draft was read at: a refetch must not move it, or a save would overwrite
  // a change made elsewhere instead of being refused. Only this form's own save advances it.
  const [readAt, setReadAt] = useState(revision)
  const start = agent.profile
  const [name, setName] = useState(start?.name ?? '')
  const [description, setDescription] = useState(start?.description ?? '')
  const [preferences, setPreferences] = useState(
    (start?.working_preferences ?? []).join('\n'),
  )
  const draft: AgentProfile = {
    name: name.trim(),
    description: description.trim(),
    representation: start?.representation ?? { kind: 'theo', reference: null },
    characteristics: start?.characteristics ?? [],
    working_preferences: entriesOf(preferences),
    instruction_refs: start?.instruction_refs ?? [],
  }
  const problem = profileProblem(draft)
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (problem) return
    save.mutate(
      { agentId: agent.agent_id, profile: draft, expectedRevision: readAt },
      { onSuccess: (record) => setReadAt(record.revision) },
    )
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        Name
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1.5">
        Description
        <Textarea
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        Working preferences, one per line
        <Textarea
          rows={3}
          value={preferences}
          onChange={(event) => setPreferences(event.target.value)}
        />
      </label>
      {problem && <p className="text-ink-muted">{problem}</p>}
      <SaveProblem error={save.error} onReload={onReload} />
      <div>
        <Button
          type="submit"
          size="sm"
          disabled={Boolean(problem) || save.isPending}
        >
          Save profile
        </Button>
      </div>
    </form>
  )
}

/** Each reload mounts the form anew from the agent and revision as they stand now. */
function KnowledgeEdit(props: { agent: OrganizationAgent; revision: number }) {
  const [reads, setReads] = useState(0)
  return (
    <KnowledgeForm
      key={reads}
      {...props}
      onReload={() => setReads((count) => count + 1)}
    />
  )
}

function KnowledgeForm({
  agent,
  revision,
  onReload,
}: {
  agent: OrganizationAgent
  revision: number
  onReload: () => void
}) {
  const providers = useKnowledgeProviders()
  const save = useSaveAgentKnowledge()
  // As with the profile: the draft keeps the revision it was read at until its own save.
  const [readAt, setReadAt] = useState(revision)
  const [binding] = useState(agent.knowledge)
  const [provider, setProvider] = useState(binding.provider ?? '')
  // A provider the binding names that this host does not list still gets an option, so the
  // select shows it and choosing another really changes the value.
  const unlisted =
    binding.provider &&
    !providers.data?.providers.some(
      (descriptor) => descriptor.id === binding.provider,
    )
      ? binding.provider
      : null
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate(
          {
            agentId: agent.agent_id,
            knowledge: { ...binding, provider: provider || null },
            expectedRevision: readAt,
          },
          { onSuccess: (record) => setReadAt(record.revision) },
        )
      }}
    >
      <label className="flex flex-col gap-1.5">
        Where its memories are kept
        <select
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          className="h-8 rounded-md border border-separator bg-transparent px-2"
        >
          <option value="">The host&apos;s choice, else the default</option>
          {unlisted && (
            <option value={unlisted}>
              {unlisted}
              {providers.data ? ' (not on this host)' : ''}
            </option>
          )}
          {providers.data?.providers.map((descriptor) => (
            <option key={descriptor.id} value={descriptor.id}>
              {descriptor.label}
              {descriptor.host_supplied ? ' (this host)' : ''}
            </option>
          ))}
        </select>
      </label>
      <span className="text-xs text-ink-muted">
        A provider that cannot be reached here stops the agent&apos;s turns
        rather than quietly using another.
      </span>
      <Problem error={providers.error} />
      <SaveProblem error={save.error} onReload={onReload} />
      <div>
        <Button type="submit" size="sm" disabled={save.isPending}>
          Save knowledge
        </Button>
      </div>
    </form>
  )
}

function download(agentPackage: AgentPackage) {
  const blob = new Blob([JSON.stringify(agentPackage, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = packageFileName(agentPackage)
  link.click()
  URL.revokeObjectURL(url)
}

function ExportAgent({ agent }: { agent: OrganizationAgent }) {
  const memories = useAgentMemories(agent.agent_id)
  const [chosen, setChosen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const toggle = (id: string) =>
    setChosen((now) =>
      now.includes(id) ? now.filter((each) => each !== id) : [...now, id],
    )
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      download(await exportAgent(agent.agent_id, chosen))
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  const list = memories.data?.memories ?? []
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-muted">
        With nothing ticked the package is a template: the profile and bindings,
        no memories. Tick memories to carry them; their links come along as
        dependencies.
      </p>
      {memories.isPending && (
        <p className="text-ink-muted">Reading its memories…</p>
      )}
      <Problem error={memories.error ?? error} />
      {list.length > 0 && (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
          {list.map((memory) => (
            <li key={memory.id}>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={chosen.includes(memory.id)}
                  onChange={() => toggle(memory.id)}
                />
                <span className="truncate">{memory.title || memory.id}</span>
                <span className="text-xs text-ink-faint">{memory.kind}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {memories.isSuccess && list.length === 0 && (
        <p className="text-ink-muted">It has no memories of its own yet.</p>
      )}
      <div>
        <Button size="sm" variant="outline" disabled={busy} onClick={run}>
          {chosen.length
            ? `Download with ${chosen.length} ${chosen.length === 1 ? 'memory' : 'memories'}`
            : 'Download template'}
        </Button>
      </div>
    </div>
  )
}

function EvaluateKnowledge({ agent }: { agent: OrganizationAgent }) {
  const providers = useKnowledgeProviders()
  const [picked, setPicked] = useState<string[]>([])
  const [queries, setQueries] = useState('')
  const [report, setReport] = useState<EvaluationReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const list = providers.data?.providers ?? []
  const workload = entriesOf(queries)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      setReport(
        await runEvaluation(
          agent.agent_id,
          picked.map((id) => ({
            label: list.find((each) => each.id === id)?.label ?? id,
            provider: id,
          })),
          workload,
        ),
      )
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-ink-muted">
        Runs on a copy of this agent&apos;s memories. Nothing it keeps changes,
        and the organization stays as it is.
      </p>
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1.5">
        <legend className="mb-1.5">Providers to compare</legend>
        {list.map((descriptor) => (
          <label key={descriptor.id} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={picked.includes(descriptor.id)}
              onChange={() =>
                setPicked((now) =>
                  now.includes(descriptor.id)
                    ? now.filter((each) => each !== descriptor.id)
                    : [...now, descriptor.id],
                )
              }
            />
            {descriptor.label}
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1.5">
        Questions to ask it, one per line
        <Textarea
          rows={3}
          value={queries}
          onChange={(event) => setQueries(event.target.value)}
        />
      </label>
      <Problem error={providers.error ?? error} />
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || picked.length === 0 || workload.length === 0}
          onClick={run}
        >
          Compare
        </Button>
      </div>
      {report && <EvaluationResult report={report} />}
    </div>
  )
}

function EvaluationResult({ report }: { report: EvaluationReport }) {
  return (
    <div className="flex flex-col gap-2">
      <table className="w-full text-xs">
        <thead className="text-ink-muted">
          <tr>
            <th className="py-1 text-start font-normal">Provider</th>
            <th className="py-1 text-end font-normal">Recall</th>
            <th className="py-1 text-end font-normal">Time</th>
          </tr>
        </thead>
        <tbody>
          {report.candidates.map((candidate) => (
            <tr key={candidate.label} className="border-t border-separator">
              <td className="py-1">{candidate.label}</td>
              <td className="py-1 text-end tabular-nums">
                {percent(candidate.mean_recall)}
              </td>
              <td className="py-1 text-end tabular-nums">
                {(candidate.mean_latency_us / 1000).toFixed(1)} ms
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="text-xs text-ink-muted">
        {report.snapshot_documents} memories copied.{' '}
        {report.source_unchanged
          ? 'The agent and organization were left unchanged.'
          : 'The source changed while this ran; run it again.'}
      </p>
    </div>
  )
}

function RemoveAgent({
  agent,
  revision,
}: {
  agent: OrganizationAgent
  revision: number
}) {
  const remove = useRemoveAgent()
  const [confirming, setConfirming] = useState(false)
  if (!confirming)
    return (
      <div>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          Remove {agentName(agent)}
        </Button>
      </div>
    )
  return (
    <div className="flex flex-col gap-2">
      <p>
        Remove {agentName(agent)} from the organization? Export it first to keep
        a copy.
      </p>
      <Problem error={remove.error} />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={remove.isPending}
          onClick={() =>
            remove.mutate({
              agentId: agent.agent_id,
              expectedRevision: revision,
            })
          }
        >
          Remove
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
          Keep it
        </Button>
      </div>
    </div>
  )
}

function CreateAgent({ revision }: { revision: number }) {
  const create = useCreateAgent()
  const [name, setName] = useState('')
  const profile: AgentProfile = {
    name: name.trim(),
    description: '',
    representation: { kind: 'theo', reference: null },
    characteristics: [],
    working_preferences: [],
    instruction_refs: [],
  }
  const problem = name.trim() ? profileProblem(profile) : null
  return (
    <div className="flex flex-col gap-1.5">
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!name.trim() || problem) return
          create.mutate(
            { profile, expectedRevision: revision },
            { onSuccess: () => setName('') },
          )
        }}
      >
        <label className="flex flex-1 flex-col gap-1.5 text-sm">
          New agent
          <Input
            placeholder="Its name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          size="sm"
          disabled={!name.trim() || Boolean(problem) || create.isPending}
        >
          Add
        </Button>
      </form>
      {problem && <p className="text-sm text-ink-muted">{problem}</p>}
      <Problem error={create.error} />
    </div>
  )
}

function ImportAgent({
  revision,
  multipleAgents,
}: {
  revision: number
  multipleAgents: boolean
}) {
  const importing = useImportAgent()
  const [agentPackage, setPackage] = useState<AgentPackage | null>(null)
  const [check, setCheck] = useState<ImportCheck | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [checking, setChecking] = useState(false)
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    setPackage(null)
    setCheck(null)
    setError(null)
    if (!file) return
    // No other file can be chosen until this one's check answers, so a report always
    // belongs to the package beside it.
    setChecking(true)
    try {
      const parsed = parsePackage(await file.text())
      setPackage(parsed)
      setCheck(await checkImport(parsed))
    } catch (failure) {
      setError(failure)
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="flex flex-col gap-2 text-sm">
      <label className="flex flex-col gap-1.5">
        Import an agent package
        <input
          type="file"
          accept="application/json,.json"
          disabled={checking || importing.isPending}
          onChange={choose}
        />
      </label>
      {checking && (
        <span className="text-ink-muted">Checking the package…</span>
      )}
      <span className="text-xs text-ink-muted">
        An import is always a copy with a new identity; the package&apos;s
        source is recorded in its lineage.
      </span>
      {!multipleAgents && (
        <span className="text-xs text-ink-muted">
          Allow several agents above to import one.
        </span>
      )}
      <Problem error={error ?? importing.error} />
      {check && <ImportReport check={check} />}
      {agentPackage && check?.ready && (
        <div>
          <Button
            size="sm"
            disabled={!multipleAgents || importing.isPending}
            onClick={() =>
              importing.mutate(
                { agentPackage, expectedRevision: revision },
                {
                  onSuccess: () => {
                    setPackage(null)
                    setCheck(null)
                  },
                },
              )
            }
          >
            Import {agentPackage.agent.profile?.name ?? 'agent'}
          </Button>
        </div>
      )}
    </div>
  )
}

function ImportReport({ check }: { check: ImportCheck }) {
  return (
    <div className="flex flex-col gap-1">
      <p className={check.ready ? 'text-ink' : 'text-error-ink'}>
        {check.ready
          ? `Ready to import${check.memories ? ` with ${check.memories} ${check.memories === 1 ? 'memory' : 'memories'}` : ''}.`
          : 'This host is missing what the package needs.'}
      </p>
      {check.missing.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs">
          {check.missing.map((missing) => (
            <li
              key={`${missing.kind}:${missing.reference}`}
              className={missing.blocking ? 'text-error-ink' : 'text-ink-muted'}
            >
              {missing.detail}
              {missing.blocking ? '' : ' (it will still work)'}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
