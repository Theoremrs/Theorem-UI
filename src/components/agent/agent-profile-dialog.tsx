// SOURCING: ui/dialog over Base UI Dialog, coss input and textarea, zustand (whether the dialog is open), lib/theorem/agent-profile (Theorem's organization record holds the profile; this only reads and saves it). The fields follow the Unified Agent Experience spec 10.1 and 10.2: name, representation and a short description first, behaviour below them; no capability matrix, since the profile cannot change what the agent may do (AG-02).
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { create } from 'zustand'
import { Input } from '@/components/coss/input'
import { Textarea } from '@/components/coss/textarea'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  PROFILE_LIMITS,
  REPRESENTATION_KINDS,
  entriesOf,
  profileProblem,
  shownProfile,
  useAgentIdentity,
  useSaveAgentProfile,
} from '@/lib/theorem/agent-profile'
import type {
  AgentIdentity,
  AgentProfile,
  RepresentationKind,
} from '@/lib/theorem/agent-profile'
import { describeError } from '@/lib/theorem/client'
import { TheoremError } from '@theoremharness/sdk'

export const useAgentProfileDialog = create<{
  open: boolean
  setOpen: (open: boolean) => void
}>()((set) => ({ open: false, setOpen: (open) => set({ open }) }))

/**
 * The agent's name as a quiet chip, like the title of a Rex row: the name only, with what it is
 * shown as left to the profile itself. Pressing it opens the profile.
 */
export function AgentIdentityChip() {
  const identity = useAgentIdentity()
  const setOpen = useAgentProfileDialog((state) => state.setOpen)
  const name = shownProfile(identity.data).name
  return (
    <button
      type="button"
      data-activity-chrome=""
      onClick={() => setOpen(true)}
      title="Agent profile"
      className="max-w-40 truncate rounded px-1.5 py-0.5 text-xs text-ink-muted outline-focus hover:bg-hover hover:text-ink focus-visible:outline-2"
    >
      <span className="sr-only">Agent profile: </span>
      {name}
    </button>
  )
}

export function AgentProfileDialog() {
  const { open, setOpen } = useAgentProfileDialog()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted with each opening, so it starts from the profile as it stands now. */}
        {open && <ProfileBody onDone={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function ProfileBody({ onDone }: { onDone: () => void }) {
  const identity = useAgentIdentity()
  const header = (
    <DialogHeader>
      <DialogTitle className="font-heading text-lg font-semibold">
        Agent profile
      </DialogTitle>
      <DialogDescription>
        How the agent is named and shown. Changes to instructions apply to new
        runs; work already running keeps the version it started with.
      </DialogDescription>
    </DialogHeader>
  )
  if (identity.isPending)
    return (
      <div className="flex flex-col gap-4">
        {header}
        <p className="text-sm text-ink-muted">Reading the profile…</p>
      </div>
    )
  if (identity.error)
    return (
      <div className="flex flex-col gap-4">
        {header}
        <p role="alert" className="text-sm text-error-ink">
          {describeError(identity.error)}
        </p>
      </div>
    )
  if (!identity.data.served)
    return (
      <div className="flex flex-col gap-4">
        {header}
        <p className="text-sm text-ink-muted">
          This Theorem cannot store an agent profile yet, so the agent shows as
          Theo.
        </p>
      </div>
    )
  return (
    <ProfileForm identity={identity.data} header={header} onDone={onDone} />
  )
}

function ProfileForm({
  identity,
  header,
  onDone,
}: {
  identity: Extract<AgentIdentity, { served: true }>
  header: ReactNode
  onDone: () => void
}) {
  const start = shownProfile(identity)
  const save = useSaveAgentProfile()
  const [name, setName] = useState(start.name)
  const [description, setDescription] = useState(start.description ?? '')
  const [kind, setKind] = useState<RepresentationKind>(
    start.representation.kind,
  )
  const [reference, setReference] = useState(
    start.representation.reference ?? '',
  )
  const [characteristics, setCharacteristics] = useState(
    (start.characteristics ?? []).join('\n'),
  )
  const [preferences, setPreferences] = useState(
    (start.working_preferences ?? []).join('\n'),
  )
  const [instructions, setInstructions] = useState(
    (start.instruction_refs ?? []).join('\n'),
  )

  const draft: AgentProfile = {
    name: name.trim(),
    description: description.trim(),
    representation: {
      kind,
      reference: kind === 'theo' ? null : reference.trim() || null,
    },
    characteristics: entriesOf(characteristics),
    working_preferences: entriesOf(preferences),
    instruction_refs: entriesOf(instructions),
  }
  const problem = profileProblem(draft)
  const conflict =
    save.error instanceof TheoremError && save.error.statusCode === 409

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (problem) return
    save.mutate(
      { profile: draft, expectedRevision: identity.revision },
      { onSuccess: onDone },
    )
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {header}
      <label className="flex flex-col gap-1.5 text-sm">
        Name
        <Input
          value={name}
          maxLength={PROFILE_LIMITS.name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        Description
        <Textarea
          rows={2}
          maxLength={PROFILE_LIMITS.description}
          placeholder="In your words: what this agent is for."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
        <span className="text-xs text-ink-muted">
          Your description, not a measured capability.
        </span>
      </label>
      <fieldset className="flex flex-col gap-1.5 text-sm">
        <legend className="mb-1.5">Shown as</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {REPRESENTATION_KINDS.map((option) => (
            <label key={option.kind} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="agent-representation"
                value={option.kind}
                checked={kind === option.kind}
                onChange={() => setKind(option.kind)}
              />
              {option.label}
            </label>
          ))}
        </div>
        {kind !== 'theo' && (
          <label className="mt-1 flex flex-col gap-1.5">
            <span className="text-xs text-ink-muted">
              Which one (a design or asset name)
            </span>
            <Input
              value={reference}
              maxLength={PROFILE_LIMITS.reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </label>
        )}
      </fieldset>
      <details className="text-sm">
        <summary className="cursor-default">Character and instructions</summary>
        <div className="mt-3 flex flex-col gap-4">
          <label className="flex flex-col gap-1.5">
            Characteristics, one per line
            <Textarea
              rows={3}
              value={characteristics}
              onChange={(event) => setCharacteristics(event.target.value)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            Working preferences, one per line
            <Textarea
              rows={3}
              placeholder="Ask before deleting files"
              value={preferences}
              onChange={(event) => setPreferences(event.target.value)}
            />
            <span className="text-xs text-ink-muted">
              Saved with the profile. Runs do not read them yet.
            </span>
          </label>
          <label className="flex flex-col gap-1.5">
            Instruction references, one per line
            <Textarea
              rows={2}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
        </div>
      </details>
      {problem && name.trim() !== '' && (
        <p className="text-sm text-ink-muted">{problem}</p>
      )}
      {save.error && (
        <p role="alert" className="text-sm text-error-ink">
          {conflict
            ? 'The profile changed somewhere else. Close this and open it again to see the newer version.'
            : describeError(save.error)}
        </p>
      )}
      <DialogFooter>
        <span className="me-auto self-center text-xs text-ink-faint">
          Version {identity.revision}
        </span>
        <Button type="submit" disabled={Boolean(problem) || save.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  )
}
