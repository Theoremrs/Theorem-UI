// SOURCING: the authoring dialog's parts (authoring-parts), coss ui Checkbox, the app's Table and
// Button, and pages/resource-field's fieldControl. Two slice-2 field controls: add_enum_variant (an
// additive schema change) and set_lifecycle (initial values and a transitions table), each sent over
// what was read so nothing the form does not show is dropped.
import { useState } from 'react'
import { Checkbox } from '@/components/coss/checkbox'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { fieldControl } from '@/components/pages/resource-field'
import type {
  CapabilityDefinition,
  CollectionLifecycle,
  CollectionSchema,
  LifecycleTransition,
  ResolvedField,
} from '@/lib/capabilities/contract'
import { schemaFor } from '@/lib/capabilities/model'
import { Choice, Note, Row } from './authoring-parts'
import type { Submit } from './authoring-parts'

/** A field whose values are a declared list: what a variant or a lifecycle governs. */
const variantsOf = (field: ResolvedField | undefined): string[] | undefined =>
  field?.fieldType.kind === 'enum' || field?.fieldType.kind === 'enum_many'
    ? field.fieldType.variants
    : undefined

const enumFields = (schema: CollectionSchema | undefined) =>
  (schema?.fields ?? []).filter((field) => variantsOf(field) !== undefined)

/** A checkbox named for assistive tech, with its words beside it rather than around it. */
function Tick({
  label,
  text,
  checked,
  onChange,
}: {
  label: string
  text: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink">
      <Checkbox
        aria-label={label}
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span>{text}</span>
    </span>
  )
}

export function AddVariant({
  definition,
  schemas,
  busy,
  onSubmit,
}: {
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  busy: boolean
  onSubmit: Submit
}) {
  const collections = definition.collections.map((collection) => ({
    value: collection.key,
    label: collection.label,
  }))
  const [collectionKey, setCollectionKey] = useState(
    collections[0]?.value ?? '',
  )
  const fields = enumFields(schemaFor(schemas, collectionKey))
  const [fieldKey, setFieldKey] = useState('')
  const field = fields.find((one) => one.key === fieldKey) ?? fields[0]
  const [variant, setVariant] = useState('')
  const variants = variantsOf(field) ?? []
  const wanted = variant.trim()

  const problems: string[] = []
  if (!field) problems.push('a select field')
  if (!wanted) problems.push('the new variant')
  else if (variants.includes(wanted))
    problems.push('a variant the field does not have yet')

  return (
    <div className="flex flex-col gap-2">
      <Row label="Collection">
        <Choice
          label="Variant collection"
          value={collectionKey}
          options={collections}
          onChange={(next) => {
            setCollectionKey(next)
            setFieldKey('')
          }}
        />
      </Row>
      {fields.length ? (
        <Row label="Field">
          <Choice
            label="Variant field"
            value={field?.key ?? ''}
            options={fields.map((one) => ({ value: one.key, label: one.label }))}
            onChange={setFieldKey}
          />
        </Row>
      ) : (
        <Note>This collection declares no select field to add a variant to.</Note>
      )}
      {field && <Note>Its variants now: {variants.join(', ') || 'none'}.</Note>}
      <Row
        label="New variant"
        hint="Variants are only added: removing or renaming one is not supported."
      >
        <input
          aria-label="New variant"
          className={fieldControl}
          value={variant}
          onChange={(event) => setVariant(event.target.value)}
          placeholder="blocked"
        />
      </Row>
      {problems.length > 0 && <Note>Still to do: {problems.join(', ')}.</Note>}
      <Button
        size="sm"
        disabled={problems.length > 0 || busy}
        aria-busy={busy}
        aria-label="Add enum variant"
        onClick={() =>
          field &&
          void onSubmit(
            [
              {
                op: 'add_enum_variant',
                collectionKey,
                fieldKey: field.key,
                variant: wanted,
              },
            ],
            'Variant added',
          )
        }
      >
        Add variant
      </Button>
    </div>
  )
}

/** Which collection's lifecycle, and over which field; the form below starts over with either. */
export function LifecycleEditor({
  definition,
  schemas,
  busy,
  onSubmit,
}: {
  definition: CapabilityDefinition
  schemas: CollectionSchema[]
  busy: boolean
  onSubmit: Submit
}) {
  const collections = definition.collections.map((collection) => ({
    value: collection.key,
    label: collection.label,
  }))
  const [collectionKey, setCollectionKey] = useState(
    collections[0]?.value ?? '',
  )
  const collection = definition.collections.find(
    (one) => one.key === collectionKey,
  )
  const lifecycle = collection?.lifecycle
  const fields = enumFields(schemaFor(schemas, collectionKey))
  const [fieldKey, setFieldKey] = useState(
    lifecycle?.fieldKey ?? fields[0]?.key ?? '',
  )
  const fieldOptions = fields.map((one) => ({
    value: one.key,
    label: one.label,
  }))
  // A lifecycle over a field the schema no longer lists as a select is still shown.
  if (lifecycle && !fields.some((one) => one.key === lifecycle.fieldKey))
    fieldOptions.unshift({
      value: lifecycle.fieldKey,
      label: lifecycle.fieldKey,
    })

  return (
    <div className="flex flex-col gap-2">
      <Row label="Collection">
        <Choice
          label="Lifecycle collection"
          value={collectionKey}
          options={collections}
          onChange={(next) => {
            setCollectionKey(next)
            const nextCollection = definition.collections.find(
              (one) => one.key === next,
            )
            setFieldKey(
              nextCollection?.lifecycle?.fieldKey ??
                enumFields(schemaFor(schemas, next))[0]?.key ??
                '',
            )
          }}
        />
      </Row>
      {fieldOptions.length ? (
        <>
          <Row label="Lifecycle field">
            <Choice
              label="Lifecycle field"
              value={fieldKey}
              options={fieldOptions}
              onChange={setFieldKey}
            />
          </Row>
          <LifecycleForm
            key={`${collectionKey}:${fieldKey}`}
            collectionKey={collectionKey}
            fieldKey={fieldKey}
            variants={
              variantsOf(fields.find((one) => one.key === fieldKey)) ?? [
                ...new Set(
                  (lifecycle?.transitions ?? []).flatMap((one) => [
                    ...one.from,
                    one.to,
                  ]),
                ),
              ]
            }
            lifecycle={lifecycle}
            busy={busy}
            onSubmit={onSubmit}
          />
        </>
      ) : (
        <Note>
          This collection declares no select field, so it has nothing a
          lifecycle could govern.
        </Note>
      )}
    </div>
  )
}

function LifecycleForm({
  collectionKey,
  fieldKey,
  variants,
  lifecycle,
  busy,
  onSubmit,
}: {
  collectionKey: string
  fieldKey: string
  variants: string[]
  /** The collection's lifecycle as read, which this form edits only if it governs this field. */
  lifecycle: CollectionLifecycle | undefined
  busy: boolean
  onSubmit: Submit
}) {
  const own = lifecycle?.fieldKey === fieldKey ? lifecycle : undefined
  const [initial, setInitial] = useState<string[] | undefined>(own?.initial)
  const [transitions, setTransitions] = useState<LifecycleTransition[]>(
    own?.transitions ?? [],
  )
  const [clearing, setClearing] = useState(false)

  const toggle = (list: string[], value: string, on: boolean) =>
    on ? [...list.filter((one) => one !== value), value] : list.filter((one) => one !== value)
  const setTransition = (at: number, change: Partial<LifecycleTransition>) =>
    setTransitions((held) =>
      held.map((one, i) => (i === at ? { ...one, ...change } : one)),
    )

  const problems: string[] = []
  transitions.forEach((transition, at) => {
    if (!transition.from.length)
      problems.push(`transition ${at + 1} moves from no value`)
    if (!variants.includes(transition.to))
      problems.push(`transition ${at + 1} moves to a value the field does not hold`)
  })
  for (const value of initial ?? [])
    if (!variants.includes(value))
      problems.push(`${value} is not a value the field holds`)

  // The lifecycle as sent: the one read, with what this form edits over it.
  const next: CollectionLifecycle = { ...(own ?? {}), fieldKey, transitions }
  if (initial) next.initial = initial
  else delete next.initial

  return (
    <div className="flex flex-col gap-2">
      <Note>
        Every write that changes this field is held to the transitions below:
        declared actions and generic updates alike.
      </Note>
      {lifecycle && !own && (
        <Note>
          This collection's lifecycle governs {lifecycle.fieldKey} now; saving
          moves it to this field.
        </Note>
      )}
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-ink-muted">
          Initial values
        </legend>
        <Tick
          label="Govern initial values"
          text="Govern what a new record may start as"
          checked={initial !== undefined}
          onChange={(on) => setInitial(on ? [] : undefined)}
        />
        {initial === undefined ? (
          <Note>
            Ungoverned: a new record may start at any value the field holds.
          </Note>
        ) : (
          <>
            <div className="flex flex-wrap gap-3 ps-4">
              {variants.map((value) => (
                <Tick
                  key={value}
                  label={`Initial ${value}`}
                  text={value}
                  checked={initial.includes(value)}
                  onChange={(on) => setInitial(toggle(initial, value, on))}
                />
              ))}
            </div>
            {initial.length === 0 && (
              <Note>With none chosen, no create may write this field.</Note>
            )}
          </>
        )}
      </fieldset>
      <fieldset className="flex flex-col gap-1">
        <legend className="text-xs font-medium text-ink-muted">
          Transitions
        </legend>
        {transitions.length === 0 ? (
          <Note>No transition is allowed yet: once saved, the field cannot change.</Note>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>From</TableHead>
                <TableHead>To</TableHead>
                <TableHead className="w-px">
                  <span className="sr-only">Remove</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transitions.map((transition, at) => (
                <TableRow key={at}>
                  <TableCell>
                    <div className="flex flex-wrap gap-2">
                      {variants.map((value) => (
                        <Tick
                          key={value}
                          label={`Transition ${at + 1} from ${value}`}
                          text={value}
                          checked={transition.from.includes(value)}
                          onChange={(on) =>
                            setTransition(at, {
                              from: toggle(transition.from, value, on),
                            })
                          }
                        />
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Choice
                      label={`Transition ${at + 1} to`}
                      value={transition.to}
                      options={(variants.includes(transition.to)
                        ? variants
                        : [transition.to, ...variants]
                      ).map((value) => ({ value, label: value }))}
                      onChange={(to) => setTransition(at, { to })}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Remove transition ${at + 1}`}
                      onClick={() =>
                        setTransitions((held) => held.filter((_, i) => i !== at))
                      }
                    >
                      ×
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          disabled={variants.length === 0}
          onClick={() =>
            setTransitions((held) => [...held, { from: [], to: variants[0] ?? '' }])
          }
        >
          Add transition
        </Button>
      </fieldset>
      {problems.length > 0 && <Note>Still to do: {problems.join('; ')}.</Note>}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          disabled={problems.length > 0 || busy}
          aria-busy={busy}
          onClick={() =>
            void onSubmit(
              [{ op: 'set_lifecycle', collectionKey, lifecycle: next }],
              'Lifecycle saved',
            )
          }
        >
          Save lifecycle
        </Button>
        {lifecycle && !clearing && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setClearing(true)}
          >
            Clear lifecycle
          </Button>
        )}
      </div>
      {lifecycle && clearing && (
        <div className="flex flex-col gap-1.5 rounded-md bg-raised p-2">
          <p className="text-xs text-ink">
            Clear the lifecycle on {lifecycle.fieldKey}? The field becomes
            ungoverned; records are not changed.
          </p>
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              aria-label="Confirm clear lifecycle"
              onClick={() =>
                void onSubmit(
                  [{ op: 'set_lifecycle', collectionKey, lifecycle: null }],
                  'Lifecycle cleared',
                ).then((taken) => taken && setClearing(false))
              }
            >
              Clear
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setClearing(false)}>
              Keep it
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
