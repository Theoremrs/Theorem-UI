// SOURCING: the generic record table's FooterCell and OP_GROUPS (Twenty's Calculate menu: Count, Percent, Date and More options per column) over the calculations in components/records/aggregate, coss ui Menu; laid out under the rows as the header is above them, sticky at the bottom of the grid
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from '@/components/coss/menu'
import {
  AGGREGATE_LABEL,
  aggregateOptions,
  computeAggregate,
  formatAggregate,
} from '@/components/records/aggregate'
import type { AggregateOp } from '@/components/records/aggregate'
import type { FieldSpec } from '@/components/records/contract'
import { cn } from '@/lib/utils'

const OP_GROUPS: { label: string; ops: AggregateOp[] }[] = [
  { label: 'Count', ops: ['count', 'empty', 'notEmpty', 'unique'] },
  { label: 'Percent', ops: ['percentEmpty', 'percentNotEmpty'] },
  { label: 'Date', ops: ['earliest', 'latest'] },
  {
    label: 'More options',
    ops: ['min', 'max', 'average', 'sum', 'checked', 'unchecked'],
  },
]

function FooterCell({
  field,
  op,
  partial,
  values,
  onChange,
}: {
  field: FieldSpec
  op: AggregateOp | undefined
  /** More records exist than were loaded, so the figure covers only those loaded. */
  partial: boolean
  values: unknown[]
  onChange: (op: AggregateOp | undefined) => void
}) {
  const allowed = aggregateOptions(field.field_type.kind)
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Calculate ${field.label}`}
        render={
          <button
            type="button"
            className="group flex h-full w-full min-w-0 items-center justify-end gap-1 px-2 text-xs text-ink-faint hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus data-popup-open:bg-hover"
          />
        }
      >
        {op ? (
          <>
            <span className="truncate">{AGGREGATE_LABEL[op]}</span>
            <span className="font-medium text-ink tabular-nums">
              {formatAggregate(op, computeAggregate(op, values))}
            </span>
            {partial && (
              <span className="shrink-0">of {values.length} loaded</span>
            )}
          </>
        ) : (
          <span className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-popup-open:opacity-100">
            Calculate
          </span>
        )}
      </MenuTrigger>
      <MenuPopup align="end">
        {OP_GROUPS.map((group) => {
          const ops = group.ops.filter((o) => allowed.includes(o))
          if (!ops.length) return null
          return (
            <MenuSub key={group.label}>
              <MenuSubTrigger>{group.label}</MenuSubTrigger>
              <MenuSubPopup>
                {ops.map((o) => (
                  <MenuCheckboxItem
                    key={o}
                    checked={op === o}
                    onCheckedChange={() => onChange(o)}
                  >
                    {AGGREGATE_LABEL[o]}
                  </MenuCheckboxItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          )
        })}
        {op && (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => onChange(undefined)}>None</MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  )
}

/**
 * The Calculate row under the records: one cell per column, each a menu of
 * what to work out over that column's loaded values.
 */
export function CalculationRow({
  fields,
  height,
  checkWidth,
  totalWidth,
  widthOf,
  aggregates,
  valuesOf,
  partial,
  onChange,
}: {
  fields: FieldSpec[]
  height: number
  checkWidth: number
  totalWidth: number
  widthOf: (field: FieldSpec) => number
  aggregates: Record<string, AggregateOp>
  valuesOf: (field: FieldSpec) => unknown[]
  partial: boolean
  onChange: (key: string, op: AggregateOp | undefined) => void
}) {
  return (
    <div
      role="rowgroup"
      data-crm-region="calculations"
      className="sticky bottom-0 z-20"
    >
      <div
        role="row"
        aria-label="Calculations"
        className="flex border-t border-separator bg-raised"
        style={{ height, width: `max(100%, ${totalWidth}px)` }}
      >
        <div
          role="gridcell"
          className="sticky left-0 z-10 shrink-0 bg-raised"
          style={{ width: checkWidth }}
        />
        {fields.map((field, col) => (
          <div
            key={field.key}
            role="gridcell"
            className={cn(
              'shrink-0 border-s border-separator bg-raised',
              col === 0 && 'sticky z-10 border-s-0',
            )}
            style={{
              width: widthOf(field),
              left: col === 0 ? checkWidth : undefined,
            }}
          >
            <FooterCell
              field={field}
              op={aggregates[field.key]}
              partial={partial}
              values={valuesOf(field)}
              onChange={(op) => onChange(field.key, op)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
