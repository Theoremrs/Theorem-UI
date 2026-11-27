// SOURCING: the authoring dialog's parts (authoring-parts, its Tick over coss ui Checkbox), the app's
// Table and Button, and pages/resource-field's fieldControl. Two slice-2 field controls:
// add_enum_variant (an additive schema change) and set_lifecycle (initial values and a transitions
// table), each sent over what was read so nothing the form does not show is dropped.
import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
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
import { Choice, Note, Row, Tick } from './authoring-parts'
import type { Submit } from './authoring-parts'

/** A field whose values are a declared list: what a variant or a lifecycle governs. */
const variantsOf = (field: ResolvedField | undefined): string[] | undefined =>
  field?.fieldType.kind === 'enum' || field?.fieldType.kind === 'enum_many'
    ? field.fieldType.variants
    : undefined

const enumFields = (schema: CollectionSchema | undefined) =>
  (schema?.fields ?? []).filter((field) => variantsOf(field) !== undefined)

/** What stops a variant being added: no select field, no variant, or one the field already has. */
function variantProblems(
  field: ResolvedField | undefined,
  variants: string[],
  wanted: string,
) {
  const problems: string[] = []
  if (!field) problems.push('a select field')
  if (!wanted) problems.push('the new variant')
  else if (variants.includes(wanted))
    problems.push('a variant the field does not have yet')
  return problems
}

/** The select field a variant goes to and the variants it has, or why the collection has none. */
function VariantField({
  fields,
  field,
  variants,
  onChange,
}: {
  fields: ResolvedField[]
  field: ResolvedField | undefined
  variants: string[]
  onChange: (fieldKey: string) => void
}) {
  return (
    <>
      {fields.length ? (
        <Row label="Field">
          <Choice
            label="Variant field"
            value={field?.key ?? ''}
            options={fields.map((one) => ({
              value: one.key,
              label: one.label,
            }))}
            onChange={onChange}
          />
        </Row>
      ) : (
        <Note>
          This collection declares no select field to add a variant to.
        </Note>
      )}
      {field && <Note>Its variants now: {variants.join(', ') || 'none'}.</Note>}
    </>
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
  const problems = variantProblems(field, variants, wanted)

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
      <VariantField
        fields={fields}
        field={field}
        variants={variants}
        onChange={setFieldKey}
      />
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

/** The field a collection's lifecycle form opens on: the one its lifecycle governs, else its first select field. */
const startField = (
  definition: CapabilityDefinition,
  schemas: CollectionSchema[],
  collectionKey: string,
) =>
  definition.collections.find((one) => one.key === collectionKey)?.lifecycle
    ?.fieldKey ??
  enumFields(schemaFor(schemas, collectionKey))[0]?.key ??
  ''

/** The fields a lifecycle may govern. A lifecycle over a field the schema no longer lists as a select is still shown. */
function lifecycleFieldOptions(
  fields: ResolvedField[],
  lifecycle: CollectionLifecycle | undefined,
) {
  const options = fields.map((one) => ({ value: one.key, label: one.label }))
  if (lifecycle && !fields.some((one) => one.key === lifecycle.fieldKey))
    options.unshift({ value: lifecycle.fieldKey, label: lifecycle.fieldKey })
  return options
}

/** The values a lifecycle's field holds: its variants, or, for a field no longer a select, the values its transitions name. */
const lifecycleValues = (
  field: ResolvedField | undefined,
  lifecycle: CollectionLifecycle | undefined,
) =>
  variantsOf(field) ?? [
    ...new Set(
      (lifecycle?.transitions ?? []).flatMap((one) => [...one.from, one.to]),
    ),
  ]

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
  const lifecycle = definition.collections.find(
    (one) => one.key === collectionKey,
  )?.lifecycle
  const fields = enumFields(schemaFor(schemas, collectionKey))
  const [fieldKey, setFieldKey] = useState(
    startField(definition, schemas, collectionKey),
  )
  const fieldOptions = lifecycleFieldOptions(fields, lifecycle)

  return (
    <div className="flex flex-col gap-2">
      <Row label="Collection">
        <Choice
          label="Lifecycle collection"
          value={collectionKey}
          options={collections}
          onChange={(next) => {
            setCollectionKey(next)
            setFieldKey(startField(definition, schemas, next))
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
            variants={lifecycleValues(
              fields.find((one) => one.key === fieldKey),
              lifecycle,
            )}
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

const toggled = (list: string[], value: string, on: boolean) =>
  on
    ? [...list.filter((one) => one !== value), value]
    : list.filter((one) => one !== value)

/**
 * What stops a lifecycle being saved: no transition at all (the server takes
 * a lifecycle only when it allows one), a transition from no value or to one
 * the field does not hold, or such an initial value.
 */
function lifecycleProblems(
  transitions: LifecycleTransition[],
  initial: string[] | undefined,
  variants: string[],
) {
  const problems: string[] = []
  if (transitions.length === 0) problems.push('at least one transition')
  transitions.forEach((transition, at) => {
    if (!transition.from.length)
      problems.push(`transition ${at + 1} moves from no value`)
    if (!variants.includes(transition.to))
      problems.push(
        `transition ${at + 1} moves to a value the field does not hold`,
      )
  })
  for (const value of initial ?? [])
    if (!variants.includes(value))
      problems.push(`${value} is not a value the field holds`)
  return problems
}

/** The lifecycle as sent: the one read, with what the form edits over it. No initial list leaves creates ungoverned. */
function lifecycleAsSent(
  own: CollectionLifecycle | undefined,
  fieldKey: string,
  transitions: LifecycleTransition[],
  initial: string[] | undefined,
): CollectionLifecycle {
  const next: CollectionLifecycle = { ...(own ?? {}), fieldKey, transitions }
  if (initial) next.initial = initial
  else delete next.initial
  return next
}

/** Whether creates are governed, and the values a new record may start as. */
function InitialValues({
  variants,
  initial,
  onChange,
}: {
  variants: string[]
  initial: string[] | undefined
  onChange: (initial: string[] | undefined) => void
}) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs font-medium text-ink-muted">
        Initial values
      </legend>
      <Tick
        label="Govern initial values"
        text="Govern what a new record may start as"
        checked={initial !== undefined}
        onChange={(on) => onChange(on ? [] : undefined)}
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
                onChange={(on) => onChange(toggled(initial, value, on))}
              />
            ))}
          </div>
          {initial.length === 0 && (
            <Note>With none chosen, no create may write this field.</Note>
          )}
        </>
      )}
    </fieldset>
  )
}

/** The moves the field may make, one row each: the values it may move from, and the one it moves to. */
function Transitions({
  variants,
  transitions,
  onChange,
}: {
  variants: string[]
  transitions: LifecycleTransition[]
  onChange: Dispatch<SetStateAction<LifecycleTransition[]>>
}) {
  const setTransition = (at: number, change: Partial<LifecycleTransition>) =>
    onChange((held) =>
      held.map((one, i) => (i === at ? { ...one, ...change } : one)),
    )
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="text-xs font-medium text-ink-muted">
        Transitions
      </legend>
      {transitions.length === 0 ? (
        <Note>
          No transition yet: a lifecycle must allow at least one move, so add
          one before saving.
        </Note>
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
                            from: toggled(transition.from, value, on),
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
                      onChange((held) => held.filter((_, i) => i !== at))
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
          onChange((held) => [...held, { from: [], to: variants[0] ?? '' }])
        }
      >
        Add transition
      </Button>
    </fieldset>
  )
}

/**
 * What is still to do, saving, and clearing the lifecycle as read once the
 * person confirms it. The question closes when the clear is taken.
 */
function LifecycleActions({
  lifecycle,
  problems,
  busy,
  onSave,
  onClear,
}: {
  lifecycle: CollectionLifecycle | undefined
  problems: string[]
  busy: boolean
  onSave: () => void
  onClear: () => Promise<boolean>
}) {
  const [clearing, setClearing] = useState(false)
  return (
    <>
      {problems.length > 0 && <Note>Still to do: {problems.join('; ')}.</Note>}
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          disabled={problems.length > 0 || busy}
          aria-busy={busy}
          onClick={onSave}
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
                void onClear().then((taken) => taken && setClearing(false))
              }
            >
              Clear
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setClearing(false)}
            >
              Keep it
            </Button>
          </div>
        </div>
      )}
    </>
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
      <InitialValues
        variants={variants}
        initial={initial}
        onChange={setInitial}
      />
      <Transitions
        variants={variants}
        transitions={transitions}
        onChange={setTransitions}
      />
      <LifecycleActions
        lifecycle={lifecycle}
        problems={lifecycleProblems(transitions, initial, variants)}
        busy={busy}
        onSave={() =>
          void onSubmit(
            [
              {
                op: 'set_lifecycle',
                collectionKey,
                lifecycle: lifecycleAsSent(own, fieldKey, transitions, initial),
              },
            ],
            'Lifecycle saved',
          )
        }
        onClear={() =>
          onSubmit(
            [{ op: 'set_lifecycle', collectionKey, lifecycle: null }],
            'Lifecycle cleared',
          )
        }
      />
    </div>
  )
}
