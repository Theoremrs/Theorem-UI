// SOURCING: the library template routes through queries (useSaveCapabilityTemplate,
// useCapabilityTemplates, useInstantiateCapabilityTemplate over lib/capabilities/api), the authoring
// dialog's parts and the app's Button. The plan's templates (section 10, scenario 10): save an
// instance's design, or bind a new instance from one. Each control states what does not travel, since
// a template carries the definition and its collections' declarations and never the data or access.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { fieldControl } from '@/components/pages/resource-field'
import { refusalMessage } from '@/lib/capabilities/api'
import type { CapabilityDefinition } from '@/lib/capabilities/contract'
import { Choice, Note, Row, StatusLine } from './authoring-parts'
import type { Status } from './authoring-parts'
import {
  useCapabilityTemplates,
  useInstantiateCapabilityTemplate,
  useSaveCapabilityTemplate,
} from './queries'

/** Save the instance's pinned definition as a template. */
export function SaveTemplate({
  instanceId,
  definition,
}: {
  instanceId: string
  definition: CapabilityDefinition
}) {
  const saving = useSaveCapabilityTemplate()
  const [name, setName] = useState(definition.name)
  const [description, setDescription] = useState(definition.purpose)
  const [status, setStatus] = useState<Status>()

  const save = async () => {
    setStatus({ kind: 'pending', message: 'Saving the template…' })
    try {
      const saved = await saving.mutateAsync({
        instanceId,
        name: name.trim(),
        description: description.trim(),
      })
      setStatus({
        kind: 'saved',
        message: `Saved as template ${saved.name} · ${saved.templateId}.`,
      })
    } catch (error) {
      setStatus({ kind: 'failed', message: refusalMessage(error, 'Saving') })
    }
  }

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-ink">Save as template</h3>
      <Note>
        A template keeps this design: its collections, views, actions and
        lifecycle, with the definition as it is pinned now. Records, grants,
        enabled schedules and credentials are not included, nor is this
        instance's configuration; a rule travels switched off.
      </Note>
      <Row label="Name">
        <input
          aria-label="Template name"
          className={fieldControl}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Row>
      <Row label="Description">
        <input
          aria-label="Template description"
          className={fieldControl}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Row>
      <StatusLine status={status} />
      <Button
        size="sm"
        className="self-start"
        disabled={!name.trim() || saving.isPending}
        aria-busy={saving.isPending}
        onClick={() => void save()}
      >
        Save as template
      </Button>
    </section>
  )
}

/**
 * Bind a new instance from one of the caller's templates. It gets its own
 * empty collections and only its creator as owner; `onOpen`, where a module
 * can switch to it, opens it.
 */
export function NewFromTemplate({
  onOpen,
}: {
  onOpen?: (instanceId: string) => void
}) {
  const templates = useCapabilityTemplates()
  const instantiating = useInstantiateCapabilityTemplate()
  const listed = templates.data?.templates ?? []
  const [chosen, setChosen] = useState('')
  const [instanceId, setInstanceId] = useState('')
  const [status, setStatus] = useState<Status>()
  const template = listed.find((one) => one.templateId === chosen) ?? listed[0]

  const id = instanceId.trim()
  const problems: string[] = []
  if (!id) problems.push('an instance id')
  else if (/\s/.test(id)) problems.push('an instance id without spaces')

  const create = async () => {
    if (!template) return
    setStatus({ kind: 'pending', message: `Creating ${id}…` })
    try {
      const made = await instantiating.mutateAsync({
        templateId: template.templateId,
        instanceId: id,
      })
      const created = made.instance.instanceId
      if (onOpen) {
        setStatus({
          kind: 'saved',
          message: `Created ${created} from ${template.name}.`,
        })
        onOpen(created)
      } else
        setStatus({
          kind: 'saved',
          message: `Created ${created} from ${template.name}. Name it in a capability module's Instance setting to open it.`,
        })
    } catch (error) {
      setStatus({ kind: 'failed', message: refusalMessage(error, 'Creating') })
    }
  }

  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium text-ink">New from template</h3>
      {templates.isPending ? (
        <Note>Reading your templates…</Note>
      ) : templates.isError ? (
        <p role="alert" className="text-xs text-error-ink">
          {refusalMessage(templates.error, 'Your templates')}
        </p>
      ) : !template ? (
        <Note>
          No templates saved yet. Save one from an instance's authoring
          controls, under Templates.
        </Note>
      ) : (
        <>
          <Row label="Template">
            <Choice
              label="Template to use"
              value={template.templateId}
              options={listed.map((one) => ({
                value: one.templateId,
                label: one.name,
              }))}
              onChange={setChosen}
            />
          </Row>
          {template.description && <Note>{template.description}</Note>}
          {template.requirements.modules.length > 0 && (
            <Note>
              Shown through {template.requirements.modules.join(', ')}.
            </Note>
          )}
          <Row
            label="Instance id"
            hint="Stable: pages and agents name the new instance by it."
          >
            <input
              aria-label="New instance id"
              className={fieldControl}
              value={instanceId}
              placeholder="reading/home"
              onChange={(event) => setInstanceId(event.target.value)}
            />
          </Row>
          <Note>
            Its own empty collections, with you as its only owner. Nothing is
            copied from any instance the template was saved from, and later
            changes to the template never reach it.
          </Note>
          {problems.length > 0 && (
            <Note>Still to do: {problems.join(', ')}.</Note>
          )}
          <StatusLine status={status} />
          <Button
            size="sm"
            className="self-start"
            disabled={problems.length > 0 || instantiating.isPending}
            aria-busy={instantiating.isPending}
            onClick={() => void create()}
          >
            Create instance
          </Button>
        </>
      )}
    </section>
  )
}
