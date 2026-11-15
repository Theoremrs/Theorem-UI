// SOURCING: ui/dialog over Base UI Dialog, coss input and textarea, lib/theorem/organization's project edits (Theorem's chat.projects.update takes a title and instructions).
import { useState } from 'react'
import type { FormEvent } from 'react'
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
import { describeError } from '@/lib/theorem/client'
import { useProjectEdits } from '@/lib/theorem/organization'

/** A project's name and the instructions every session in it starts with. */
export function ProjectEditDialog({
  open,
  onOpenChange,
  ...project
}: {
  projectId: string
  title: string
  /** The stored instructions, or undefined when they could not be read. */
  instructions: string | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* Mounted with each opening, so it starts from the project as it stands now. */}
        {open && <EditForm {...project} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function EditForm({
  projectId,
  title,
  instructions,
  onDone,
}: {
  projectId: string
  title: string
  instructions: string | undefined
  onDone: () => void
}) {
  const { describe } = useProjectEdits()
  const [name, setName] = useState(title)
  const [brief, setBrief] = useState(instructions ?? '')
  // Instructions that could not be read are never sent: an empty field
  // would erase them.
  const known = instructions !== undefined

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const next = name.trim()
    if (!next) return
    // Only what changed is sent, so a rename leaves the instructions alone.
    const change = {
      title: next !== title ? next : undefined,
      instructions: known && brief !== instructions ? brief : undefined,
    }
    if (change.title === undefined && change.instructions === undefined)
      return onDone()
    describe.mutate({ projectId, ...change }, { onSuccess: onDone })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle className="font-heading text-lg font-semibold">
          Edit project
        </DialogTitle>
        <DialogDescription>
          Instructions are given to every session started in this project.
        </DialogDescription>
      </DialogHeader>
      <label className="flex flex-col gap-1.5 text-sm">
        Name
        <Input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        Instructions
        <Textarea
          rows={8}
          disabled={!known}
          placeholder="How sessions here should work: the goal, the conventions, what to leave alone."
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
        />
        {!known && (
          <span className="text-xs text-ink-muted">
            The saved instructions could not be read, so they are left as they
            are.
          </span>
        )}
      </label>
      {describe.error && (
        <p role="alert" className="text-sm text-error-ink">
          {describeError(describe.error)}
        </p>
      )}
      <DialogFooter>
        <Button type="submit" disabled={!name.trim() || describe.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
  )
}
