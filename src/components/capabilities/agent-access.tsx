// SOURCING: the authoring dialog's parts (authoring-parts, its Tick over coss ui Checkbox) and the
// app's Button. The three separate agent-access controls of the spec's section 7: use this capability
// in the current conversation (the composer reference path the table's Ask already uses), make it
// discoverable (set_agent), and permit actions (set_grants over the grant list describe discloses to
// an author). Each is its own control, so using one never implies another.
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { fieldControl } from '@/components/pages/resource-field'
import type { CapabilityDefinition, Grant } from '@/lib/capabilities/contract'
import { Note, Row, Tick } from './authoring-parts'
import type { Submit } from './authoring-parts'

const ALL = '*'

function Heading({ children }: { children: string }) {
  return <h3 className="text-xs font-medium text-ink">{children}</h3>
}

export function AgentAccess({
  definition,
  grants,
  busy,
  onSubmit,
  onAsk,
}: {
  definition: CapabilityDefinition
  /** The instance's whole grant list; describe sends it only to a caller who may author. */
  grants: Grant[] | undefined
  busy: boolean
  onSubmit: Submit
  /** Put this capability in the current conversation; absent outside a module that shows it. */
  onAsk?: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-1.5">
        <Heading>Use in this conversation</Heading>
        <Note>
          Puts this capability in the composer as context for this conversation
          only. It lists nothing and grants nothing.
        </Note>
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          disabled={!onAsk}
          title={
            onAsk
              ? undefined
              : 'Open the dialog from a page module that shows this capability.'
          }
          onClick={onAsk}
        >
          Use in this conversation
        </Button>
      </section>
      <Discoverable definition={definition} busy={busy} onSubmit={onSubmit} />
      <section className="flex flex-col gap-1.5">
        <Heading>Permitted actions</Heading>
        {grants ? (
          <GrantsEditor
            definition={definition}
            grants={grants}
            busy={busy}
            onSubmit={onSubmit}
          />
        ) : (
          <Note>
            The grant list is disclosed only to a caller who may author this
            instance, and this answer did not include it, so it cannot be edited
            here.
          </Note>
        )}
      </section>
    </div>
  )
}

function Discoverable({
  definition,
  busy,
  onSubmit,
}: {
  definition: CapabilityDefinition
  busy: boolean
  onSubmit: Submit
}) {
  const [discoverable, setDiscoverable] = useState(
    definition.agent.discoverable,
  )
  const [description, setDescription] = useState(definition.agent.description)
  return (
    <section className="flex flex-col gap-1.5">
      <Heading>Discoverable to agents</Heading>
      <Note>
        Whether agent discovery lists this capability, and how it is described
        there. Being listed grants nothing: what an agent may do is the
        permitted actions below.
      </Note>
      <Tick
        label="Discoverable to agents"
        text="List it in agent discovery"
        checked={discoverable}
        onChange={setDiscoverable}
      />
      <Row label="Description for agents">
        <input
          aria-label="Agent description"
          className={fieldControl}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Row>
      <Button
        size="sm"
        className="self-start"
        disabled={busy}
        aria-label="Save discoverability"
        onClick={() =>
          void onSubmit(
            [
              {
                op: 'set_agent',
                agent: {
                  ...definition.agent,
                  discoverable,
                  description: description.trim(),
                },
              },
            ],
            'Agent access saved',
          )
        }
      >
        Save
      </Button>
    </section>
  )
}

/** What stops the grant list being saved: a grant naming no principal, or a principal with two. */
function grantProblems(rows: Grant[]) {
  const problems: string[] = []
  rows.forEach((grant, at) => {
    const principal = grant.principal.trim()
    if (!principal) problems.push(`grant ${at + 1} names no principal`)
    else if (rows.findIndex((one) => one.principal.trim() === principal) !== at)
      problems.push(`${principal} has two grants`)
  })
  return problems
}

/** The actions a grant's ticks name: every declared one, then any key the definition no longer declares. */
function invokeKeys(definition: CapabilityDefinition, grant: Grant) {
  const declared = definition.actions.map((action) => action.key)
  return [
    ...declared,
    ...grant.invoke.filter((key) => key !== ALL && !declared.includes(key)),
  ]
}

/** One grant: its principal, what it may read, invoke and author, and the way to remove it. */
function GrantRow({
  grant,
  n,
  definition,
  onChange,
  onRemove,
}: {
  grant: Grant
  n: number
  definition: CapabilityDefinition
  onChange: (change: Partial<Grant>) => void
  onRemove: () => void
}) {
  const all = grant.invoke.includes(ALL)
  return (
    <fieldset className="flex flex-col gap-1.5 rounded-md border border-separator p-2">
      <div className="flex items-center gap-1.5">
        <input
          aria-label={`Principal ${n}`}
          className={fieldControl}
          value={grant.principal}
          placeholder="user:someone"
          onChange={(event) => onChange({ principal: event.target.value })}
        />
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Remove grant ${n}`}
          onClick={onRemove}
        >
          ×
        </Button>
      </div>
      <div className="flex flex-wrap gap-3">
        <Tick
          label={`Grant ${n} reads`}
          text="Read records"
          checked={grant.read}
          onChange={(read) => onChange({ read })}
        />
        <Tick
          label={`Grant ${n} authors`}
          text="Author the definition"
          checked={grant.author}
          onChange={(author) => onChange({ author })}
        />
      </div>
      <Tick
        label={`Grant ${n} invokes every action`}
        text="Invoke every action"
        checked={all}
        onChange={(on) => onChange({ invoke: on ? [ALL] : [] })}
      />
      {!all && (
        <div className="flex flex-wrap gap-3 ps-4">
          {invokeKeys(definition, grant).map((key) => {
            const action = definition.actions.find((one) => one.key === key)
            return (
              <Tick
                key={key}
                label={`Grant ${n} invokes ${key}`}
                text={action?.label ?? key}
                checked={grant.invoke.includes(key)}
                onChange={(on) =>
                  onChange({
                    invoke: on
                      ? [...grant.invoke.filter((one) => one !== key), key]
                      : grant.invoke.filter((one) => one !== key),
                  })
                }
              />
            )
          })}
        </div>
      )}
      {grant.background && (
        <Note>
          May also run background behavior; this editor keeps that as it is.
        </Note>
      )}
    </fieldset>
  )
}

function GrantsEditor({
  definition,
  grants,
  busy,
  onSubmit,
}: {
  definition: CapabilityDefinition
  grants: Grant[]
  busy: boolean
  onSubmit: Submit
}) {
  // Each row is the grant as read with the edits laid over it, so a part this
  // editor does not show (background, for one) goes back unchanged.
  const [rows, setRows] = useState<Grant[]>(grants)
  const set = (at: number, change: Partial<Grant>) =>
    setRows((held) =>
      held.map((one, i) => (i === at ? { ...one, ...change } : one)),
    )
  const problems = grantProblems(rows)

  return (
    <div className="flex flex-col gap-2">
      <Note>
        Saving replaces the whole grant list. Reading, invoking and authoring
        are separate: invoking never implies authoring.
      </Note>
      {rows.map((grant, at) => (
        <GrantRow
          key={at}
          grant={grant}
          n={at + 1}
          definition={definition}
          onChange={(change) => set(at, change)}
          onRemove={() => setRows((held) => held.filter((_, i) => i !== at))}
        />
      ))}
      <Button
        size="xs"
        variant="outline"
        className="self-start"
        onClick={() =>
          setRows((held) => [
            ...held,
            { principal: '', read: true, invoke: [], author: false },
          ])
        }
      >
        Add grant
      </Button>
      {problems.length > 0 && <Note>Still to do: {problems.join('; ')}.</Note>}
      <Button
        size="sm"
        className="self-start"
        disabled={problems.length > 0 || busy}
        aria-busy={busy}
        onClick={() =>
          void onSubmit(
            [
              {
                op: 'set_grants',
                grants: rows.map((grant) => ({
                  ...grant,
                  principal: grant.principal.trim(),
                })),
              },
            ],
            'Grants saved',
          )
        }
      >
        Save grants
      </Button>
    </div>
  )
}
