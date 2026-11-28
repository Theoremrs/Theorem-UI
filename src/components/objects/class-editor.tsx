// SOURCING: after Craft web's collection field editor (Mobbin ebf78810-7a01-4f15-a3af-3051010ed5cd: Add Field with a name and type, Hide and Order Fields, Edit Field) and Capacities' object type settings (icon, colour, properties); FieldDialog (records/field-form, the register's own field form) for adding and editing a property; field-form Segmented for the advanced choices; schema-edit newObjectType and toInput, and evolution.ts for what a change would do to existing objects; useAskTheorem (index/navigation) for describing a class in words, which reaches the same declareSchema through the agent
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '@/components/icons'
import { useAskTheorem } from '@/components/index/navigation'
import { SchemaConflictError } from '@/components/records/api'
import type {
  FieldSpec,
  ObjectType,
  ObjectTypeInput,
} from '@/components/records/contract'
import { FieldDialog, Segmented } from '@/components/records/field-form'
import { FieldTypeIcon, KIND } from '@/components/records/fields'
import { useDeclareObjectType } from '@/components/records/queries'
import { newObjectType, toInput } from '@/components/records/schema-edit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { describeError } from '@/lib/theorem/client'
import {
  CLASS_TONES,
  notesExtension,
  objectClass,
  withNotesExtension,
} from '@/lib/objects/classes'
import type { ClassTone, NotesExtension } from '@/lib/objects/classes'
import { incompatibilities, refuses } from '@/lib/objects/evolution'
import { useClassRegistry } from '@/lib/objects/register'
import { cn } from '@/lib/utils'
import { CLASS_ICONS, ClassGlyph, ClassIcon, TONE_TILE } from './class-icon'
import { openPane } from './object-actions'

type Draft = {
  singular: string
  plural: string
  description: string
  icon: string
  tone: ClassTone
  layout: NonNullable<NotesExtension['layout']>
  enforcement: ObjectType['enforcement']
  /** Field keys in order; a key left out is removed. */
  order: string[]
  required: Record<string, boolean>
  cardFields: string[] | undefined
}

const draftOf = (type: ObjectType | undefined): Draft => {
  const ext = type ? notesExtension(type) : {}
  const cls = type ? objectClass(type) : undefined
  return {
    singular: type?.label_singular ?? '',
    plural: type?.label_plural ?? '',
    description: type?.description ?? '',
    icon: cls?.icon ?? 'box',
    tone: cls?.tone ?? 'teal',
    layout: ext.layout ?? 'prose',
    enforcement: type?.enforcement ?? 'warn',
    order: type?.fields.map((f) => f.key) ?? [],
    required: Object.fromEntries(
      type?.fields.map((f) => [f.key, f.required]) ?? [],
    ),
    cardFields: ext.cardFields,
  }
}

/** The declaration the draft makes of `type`. */
function inputOf(type: ObjectType, draft: Draft): ObjectTypeInput {
  const byKey = new Map(type.fields.map((f) => [f.key, f]))
  return {
    ...toInput(type),
    label_singular: draft.singular.trim() || type.label_singular,
    label_plural: draft.plural.trim() || type.label_plural,
    description: draft.description.trim() || undefined,
    enforcement: draft.enforcement,
    fields: draft.order.flatMap((key) => {
      const field = byKey.get(key)
      return field
        ? [{ ...field, required: draft.required[key] ?? field.required }]
        : []
    }),
    extensions: withNotesExtension(type, {
      icon: draft.icon,
      tone: draft.tone,
      layout: draft.layout,
      cardFields: draft.cardFields,
    }),
  }
}

/** A class's editor, or a new class's (`classKey` "new"). */
export function ClassEditor({
  classKey,
  onCreated,
}: {
  classKey: string
  onCreated?: (id: string) => void
}) {
  const { registry, model } = useClassRegistry()
  const type =
    classKey === 'new' ? undefined : registry.byId.get(classKey)?.type
  const [draft, setDraft] = useState(() => draftOf(type))
  const [seen, setSeen] = useState(type?.content_anchor)
  // A declaration made here or elsewhere replaces the draft the editor started from.
  if (type && type.content_anchor !== seen) {
    setSeen(type.content_anchor)
    setDraft(draftOf(type))
  }
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))
  const declare = useDeclareObjectType()
  const ask = useAskTheorem()
  const [field, setField] = useState<FieldSpec | 'new' | null>(null)
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const [localError, setLocalError] = useState<unknown>()

  const input = useMemo(
    () => (type ? inputOf(type, draft) : undefined),
    [type, draft],
  )
  const found = useMemo(
    () => (type && input ? incompatibilities(type, input) : []),
    [type, input],
  )
  const refused = refuses(found)
  const removing = found.some((f) => f.reason === 'removed')
  const dirty =
    !!type && JSON.stringify(input) !== JSON.stringify(toInput(type))

  if (classKey !== 'new' && !type)
    return (
      <p role="status" className="p-8 text-sm text-ink-muted">
        {model.isPending ? 'Loading…' : 'This class is not in the register.'}
      </p>
    )

  const native = type ? objectClass(type).native : undefined
  const save = () => {
    if (!type) {
      try {
        const base = newObjectType({
          labelSingular: draft.singular,
          labelPlural: draft.plural || `${draft.singular.trim()}s`,
          description: draft.description,
        })
        declare.mutate(
          {
            input: {
              ...base,
              enforcement: draft.enforcement,
              extensions: withNotesExtension(base, {
                icon: draft.icon,
                tone: draft.tone,
                layout: draft.layout,
              }),
            },
          },
          {
            onSuccess: (result) =>
              onCreated?.(result.object_type.object_type_id),
          },
        )
      } catch (error) {
        declare.reset()
        setLocalError(error)
      }
      return
    }
    if (!input || refused || (removing && !confirmRemoval)) return
    declare.mutate(
      { input, anchor: type.content_anchor },
      { onSuccess: () => setConfirmRemoval(false) },
    )
  }
  const error = localError ?? declare.error
  const preview = { icon: draft.icon, tone: draft.tone }
  const fields = type
    ? draft.order.flatMap((key) => type.fields.filter((f) => f.key === key))
    : []

  return (
    <div className="@container flex h-full min-h-0 overflow-y-auto">
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 pt-14 pb-24 @2xl:px-10 @3xl:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="flex min-w-0 flex-col gap-8">
          <header className="flex items-center gap-3">
            <ClassIcon cls={preview} size="lg" />
            <h1 className="min-w-0 flex-1 truncate font-heading text-3xl font-semibold tracking-tight">
              {draft.singular ||
                (type ? type.label_singular : 'New object class')}
            </h1>
            {type && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  openPane({
                    kind: 'library',
                    key: `class:${type.object_type_id}`,
                  })
                }
              >
                {type.record_count ?? 0} {draft.plural || type.label_plural}
              </Button>
            )}
          </header>

          <Group title="Name">
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="Singular">
                <Input
                  autoFocus={!type}
                  value={draft.singular}
                  placeholder="Book"
                  onChange={(event) => {
                    setLocalError(undefined)
                    set({ singular: event.target.value })
                  }}
                />
              </Labeled>
              <Labeled label="Plural">
                <Input
                  value={draft.plural}
                  placeholder={draft.singular ? `${draft.singular}s` : 'Books'}
                  onChange={(event) => set({ plural: event.target.value })}
                />
              </Labeled>
            </div>
            <Labeled label="Description">
              <Textarea
                rows={2}
                value={draft.description}
                onChange={(event) => set({ description: event.target.value })}
              />
            </Labeled>
          </Group>

          <Group title="Icon and colour">
            <div
              role="radiogroup"
              aria-label="Icon"
              className="grid grid-cols-[repeat(auto-fill,2rem)] gap-1"
            >
              {Object.keys(CLASS_ICONS).map((name) => (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={draft.icon === name}
                  aria-label={name}
                  onClick={() => set({ icon: name })}
                  className={cn(
                    'flex size-8 items-center justify-center rounded-md text-ink-muted outline-none hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus',
                    draft.icon === name && 'bg-pill text-ink shadow-pill',
                  )}
                >
                  <ClassGlyph icon={name} className="size-4" />
                </button>
              ))}
            </div>
            <div role="radiogroup" aria-label="Colour" className="flex gap-1.5">
              {CLASS_TONES.map((tone) => (
                <button
                  key={tone}
                  type="button"
                  role="radio"
                  aria-checked={draft.tone === tone}
                  aria-label={tone}
                  onClick={() => set({ tone })}
                  className={cn(
                    'size-7 rounded-full outline-none ring-offset-2 ring-offset-(--notes-pane) focus-visible:outline-2 focus-visible:outline-focus',
                    TONE_TILE[tone],
                    draft.tone === tone && 'ring-2 ring-ink',
                  )}
                />
              ))}
            </div>
          </Group>

          {type && (
            <Group
              title="Properties"
              action={
                !native && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setField('new')}
                  >
                    <Icon.Add aria-hidden className="size-3.5" />
                    Add property
                  </Button>
                )
              }
            >
              <ol className="flex flex-col">
                {fields.map((f, index) => {
                  const identifier = f.key === type.label_identifier_field
                  return (
                    <li
                      key={f.key}
                      className="group flex h-9 items-center gap-2 rounded-md px-2 hover:bg-hover"
                    >
                      <FieldTypeIcon kind={f.field_type.kind} />
                      <button
                        type="button"
                        disabled={!!native}
                        onClick={() => setField(f)}
                        className="min-w-0 flex-1 truncate text-start text-sm outline-none focus-visible:underline"
                      >
                        {f.label}
                        <span className="ms-2 text-xs text-ink-faint">
                          {KIND[f.field_type.kind].label}
                        </span>
                      </button>
                      {!identifier && !native && (
                        <>
                          <label className="flex items-center gap-1 text-xs text-ink-muted">
                            <input
                              type="checkbox"
                              checked={draft.required[f.key] ?? f.required}
                              onChange={(event) =>
                                set({
                                  required: {
                                    ...draft.required,
                                    [f.key]: event.target.checked,
                                  },
                                })
                              }
                            />
                            Required
                          </label>
                          <label className="flex items-center gap-1 text-xs text-ink-muted">
                            <input
                              type="checkbox"
                              checked={(draft.cardFields ?? []).includes(f.key)}
                              onChange={(event) => {
                                const current = draft.cardFields ?? []
                                set({
                                  cardFields: event.target.checked
                                    ? [...current, f.key]
                                    : current.filter((k) => k !== f.key),
                                })
                              }}
                            />
                            On cards
                          </label>
                          <IconButton
                            label={`Move ${f.label} up`}
                            disabled={index === 0}
                            onClick={() =>
                              set({ order: move(draft.order, f.key, -1) })
                            }
                          >
                            <Icon.ArrowUp className="size-3.5" />
                          </IconButton>
                          <IconButton
                            label={`Move ${f.label} down`}
                            disabled={index === fields.length - 1}
                            onClick={() =>
                              set({ order: move(draft.order, f.key, 1) })
                            }
                          >
                            <Icon.ArrowDown className="size-3.5" />
                          </IconButton>
                          <IconButton
                            label={`Remove ${f.label}`}
                            onClick={() =>
                              set({
                                order: draft.order.filter((k) => k !== f.key),
                              })
                            }
                          >
                            <Icon.Close className="size-3.5" />
                          </IconButton>
                        </>
                      )}
                    </li>
                  )
                })}
              </ol>
              {type.fields.some((f) => !draft.order.includes(f.key)) && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="self-start"
                  onClick={() =>
                    set({
                      order: [
                        ...draft.order,
                        ...type.fields
                          .map((f) => f.key)
                          .filter((k) => !draft.order.includes(k)),
                      ],
                    })
                  }
                >
                  Keep removed properties
                </Button>
              )}
            </Group>
          )}

          <Group title="Advanced">
            <Labeled label="When an object does not match">
              <Segmented
                label="Enforcement"
                value={draft.enforcement}
                onChange={(enforcement) => set({ enforcement })}
                options={[
                  { value: 'observe', label: 'Record it' },
                  { value: 'warn', label: 'Flag it' },
                  { value: 'reject', label: 'Refuse it' },
                ]}
              />
            </Labeled>
            <Labeled label="Page layout">
              <Segmented
                label="Page layout"
                value={draft.layout}
                onChange={(layout) => set({ layout })}
                options={[
                  { value: 'prose', label: 'Reading column' },
                  { value: 'wide', label: 'Full width' },
                ]}
              />
            </Labeled>
            {type && (
              <details className="text-sm">
                <summary className="cursor-default text-ink-muted">
                  Declaration
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-frame p-3 text-xs">
                  {JSON.stringify(input, null, 2)}
                </pre>
              </details>
            )}
          </Group>

          {found.length > 0 && (
            <div
              role={refused ? 'alert' : 'status'}
              className="flex flex-col gap-1.5 rounded-lg border border-separator p-3 text-sm"
            >
              {found.map((f) => (
                <p
                  key={`${f.field}:${f.reason}`}
                  className={
                    f.reason === 'removed' ? 'text-ink-muted' : 'text-error-ink'
                  }
                >
                  {f.message}
                </p>
              ))}
              {removing && !refused && (
                <label className="flex items-center gap-2 pt-1">
                  <input
                    type="checkbox"
                    checked={confirmRemoval}
                    onChange={(event) =>
                      setConfirmRemoval(event.target.checked)
                    }
                  />
                  Remove them
                </label>
              )}
            </div>
          )}
          {error != null && (
            <p role="alert" className="text-sm wrap-anywhere text-error-ink">
              {error instanceof SchemaConflictError || error instanceof Error
                ? error.message
                : describeError(error)}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={save}
              disabled={
                declare.isPending ||
                (!type && !draft.singular.trim()) ||
                (!!type && (!dirty || refused || (removing && !confirmRemoval)))
              }
            >
              {declare.isPending
                ? 'Saving…'
                : type
                  ? 'Save class'
                  : 'Create class'}
            </Button>
            {type && dirty && (
              <Button variant="ghost" onClick={() => setDraft(draftOf(type))}>
                Discard changes
              </Button>
            )}
            {!type && (
              <Button
                variant="ghost"
                onClick={() =>
                  ask(
                    `Declare a new object class in my schema register${
                      draft.singular.trim()
                        ? ` called ${draft.singular.trim()}`
                        : ''
                    }${draft.description.trim() ? `: ${draft.description.trim()}` : ''}. Propose its properties, then declare it.`,
                    [],
                  )
                }
              >
                <Icon.Sparkle aria-hidden className="size-4" />
                Describe it to Theorem
              </Button>
            )}
          </div>
        </div>

        <aside aria-label="Preview" className="flex flex-col gap-3">
          <h2 className="text-xs font-medium text-ink-faint">Preview</h2>
          <div className="flex flex-col gap-2">
            <div className="flex aspect-[4/3] flex-col gap-2 rounded-lg border border-separator bg-(--notes-pane) p-3.5 shadow-sm">
              <ClassIcon cls={preview} size="md" />
              {fields
                .filter(
                  (f) =>
                    f.key !== type?.label_identifier_field &&
                    (draft.cardFields ?? []).includes(f.key),
                )
                .slice(0, 3)
                .map((f) => (
                  <div key={f.key} className="flex flex-col text-xs">
                    <span className="text-ink-faint">{f.label}</span>
                    <span className="h-2 w-2/3 rounded-full bg-pill" />
                  </div>
                ))}
            </div>
            <p className="truncate px-0.5 text-sm font-medium">
              {draft.singular.trim()
                ? `A ${draft.singular.trim().toLowerCase()}`
                : 'An object'}
            </p>
            <p className="flex items-center gap-1.5 px-0.5 text-xs text-ink-faint">
              <ClassIcon cls={preview} className="size-3.5 [&_svg]:size-2.5" />
              {draft.singular || 'Class'}
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-md px-2 py-1 text-sm">
            <ClassIcon cls={preview} />
            {draft.plural ||
              (draft.singular ? `${draft.singular}s` : 'Objects')}
          </div>
        </aside>
      </div>
      {type && model.data && field && (
        <FieldDialog
          open
          onOpenChange={(open) => !open && setField(null)}
          objectType={type}
          model={model.data}
          field={field === 'new' ? undefined : field}
          initial={
            field === 'new' && (type.record_count ?? 0) > 0 ? {} : undefined
          }
        />
      )}
    </div>
  )
}

const move = (order: string[], key: string, by: -1 | 1) => {
  const next = [...order]
  const at = next.indexOf(key)
  const to = at + by
  if (at < 0 || to < 0 || to >= next.length) return order
  ;[next[at], next[to]] = [next[to]!, next[at]!]
  return next
}

const Group = ({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) => (
  <section className="flex flex-col gap-3">
    <div className="flex items-center">
      <h2 className="flex-1 text-sm font-medium">{title}</h2>
      {action}
    </div>
    {children}
  </section>
)

const Labeled = ({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) => (
  <label className="flex flex-col gap-1.5">
    <span className="text-xs font-medium text-ink-muted">{label}</span>
    {children}
  </label>
)

const IconButton = ({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: ReactNode
}) => (
  <button
    type="button"
    aria-label={label}
    disabled={disabled}
    onClick={onClick}
    className="flex size-6 items-center justify-center rounded text-ink-faint opacity-0 outline-none group-hover:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-30"
  >
    {children}
  </button>
)
