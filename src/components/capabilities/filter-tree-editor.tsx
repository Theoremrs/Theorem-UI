// SOURCING: the filter tree of lib/capabilities/filter-tree drawn with the authoring dialog's own
// parts (authoring-parts Choice and Row, pages/resource-field's fieldControl, the app's Button). A
// hand-rolled editor because no query-builder in the dependency set models this contract's QueryFilter
// (and/or/not over typed leaves) with its untouched-node guarantee; the tree logic is pure and tested
// apart, so this file only draws it.
import { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { fieldControl } from '@/components/pages/resource-field'
import type { ResolvedField } from '@/lib/capabilities/contract'
import {
  addCondition,
  addGroup,
  negate,
  removeNode,
  setGroupOp,
  setLeaf,
  unwrapNot,
} from '@/lib/capabilities/filter-tree'
import type { EditNode } from '@/lib/capabilities/filter-tree'
import { opsForField, valueless } from '@/lib/capabilities/model'
import type { FilterRow, LeafOp } from '@/lib/capabilities/model'
import { Choice } from './authoring-parts'

const OP_WORDS: Record<LeafOp, string> = {
  eq: 'is',
  ne: 'is not',
  in: 'is one of',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is more than',
  gte: 'is at least',
  contains: 'contains',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
}

const MATCH = [
  { value: 'and', label: 'All of these' },
  { value: 'or', label: 'Any of these' },
]

/** The numbers the controls are named by: conditions, groups and negations in reading order. */
function numbering(tree: EditNode) {
  const numbers = new Map<string, number>()
  const counts = { condition: 0, group: 0, negation: 0 }
  const walk = (node: EditNode) => {
    switch (node.kind) {
      case 'group':
        numbers.set(node.id, ++counts.group)
        node.children.forEach(walk)
        return
      case 'not':
        numbers.set(node.id, ++counts.negation)
        walk(node.child)
        return
      case 'leaf':
      case 'opaque':
        numbers.set(node.id, ++counts.condition)
        return
    }
  }
  walk(tree)
  return numbers
}

/**
 * The whole filter of one view, as nested groups: all-of and any-of groups,
 * negations, and conditions over the collection's fields. What is not touched
 * is saved exactly as it was read.
 */
export function FilterTreeEditor({
  tree,
  fields,
  onChange,
}: {
  tree: EditNode
  fields: Map<string, ResolvedField>
  onChange: (tree: EditNode) => void
}) {
  const numbers = useMemo(() => numbering(tree), [tree])
  const fieldOptions = [...fields.values()].map((field) => ({
    value: field.key,
    label: field.label,
  }))
  const firstRow = (): FilterRow => {
    const fieldKey = fieldOptions[0]?.value ?? ''
    return {
      fieldKey,
      op: opsForField(fields.get(fieldKey))[0] ?? 'eq',
      value: '',
    }
  }

  const draw = (node: EditNode, root: boolean) => {
    const n = numbers.get(node.id) ?? 0
    switch (node.kind) {
      case 'group':
        return (
          <fieldset
            key={node.id}
            className="flex flex-col gap-1.5 rounded-md border border-separator p-2"
          >
            <div className="flex items-center gap-1.5">
              <Choice
                label={`Match for group ${n}`}
                value={node.op}
                options={MATCH}
                onChange={(op) =>
                  onChange(setGroupOp(tree, node.id, op as 'and' | 'or'))
                }
              />
              {!root && (
                <>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Negate group ${n}`}
                    onClick={() => onChange(negate(tree, node.id))}
                  >
                    Not
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    aria-label={`Remove group ${n}`}
                    onClick={() => onChange(removeNode(tree, node.id))}
                  >
                    ×
                  </Button>
                </>
              )}
            </div>
            {node.children.length === 0 && (
              <p className="text-xs text-ink-faint">
                {root
                  ? 'No conditions: the view shows every record.'
                  : 'No conditions in this group yet.'}
              </p>
            )}
            {node.children.map((child) => draw(child, false))}
            <div className="flex gap-1.5">
              <Button
                size="xs"
                variant="outline"
                aria-label={`Add condition to group ${n}`}
                disabled={fieldOptions.length === 0}
                onClick={() =>
                  onChange(addCondition(tree, node.id, firstRow()))
                }
              >
                Add condition
              </Button>
              <Button
                size="xs"
                variant="outline"
                aria-label={`Add group to group ${n}`}
                onClick={() => onChange(addGroup(tree, node.id, 'or'))}
              >
                Add group
              </Button>
            </div>
          </fieldset>
        )
      case 'not':
        return (
          <div
            key={node.id}
            className="flex flex-col gap-1.5 rounded-md border border-separator p-2"
          >
            <div className="flex items-center gap-1.5">
              <span className="flex-1 text-xs font-medium text-ink-muted">
                Not
              </span>
              <Button
                size="xs"
                variant="ghost"
                aria-label={`Remove negation ${n}`}
                onClick={() => onChange(unwrapNot(tree, node.id))}
              >
                Undo not
              </Button>
            </div>
            {draw(node.child, false)}
          </div>
        )
      case 'opaque':
        return (
          <div key={node.id} className="flex items-center gap-1.5">
            <p className="min-w-0 flex-1 truncate rounded-md bg-raised px-2 py-1 text-xs text-ink-muted">
              A condition this editor cannot change, kept as it is:{' '}
              <code className="font-mono">{JSON.stringify(node.original)}</code>
            </p>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Remove condition ${n}`}
              onClick={() => onChange(removeNode(tree, node.id))}
            >
              ×
            </Button>
          </div>
        )
      case 'leaf': {
        const { row } = node
        const field = fields.get(row.fieldKey)
        const ops = opsForField(field)
        const set = (next: FilterRow) => onChange(setLeaf(tree, node.id, next))
        return (
          <div key={node.id} className="flex items-center gap-1.5">
            <Choice
              label={`Field of condition ${n}`}
              value={row.fieldKey}
              options={
                field || !row.fieldKey
                  ? fieldOptions
                  : [{ value: row.fieldKey, label: row.fieldKey }, ...fieldOptions]
              }
              onChange={(fieldKey) =>
                set({
                  fieldKey,
                  op: opsForField(fields.get(fieldKey))[0] ?? 'eq',
                  value: '',
                })
              }
            />
            <Choice
              label={`Operator of condition ${n}`}
              value={row.op}
              options={(ops.includes(row.op) ? ops : [row.op, ...ops]).map(
                (op) => ({ value: op, label: OP_WORDS[op] }),
              )}
              onChange={(op) => set({ ...row, op: op as LeafOp })}
            />
            {!valueless(row.op) && (
              <input
                aria-label={`Value of condition ${n}`}
                className={fieldControl}
                value={row.value}
                placeholder={row.op === 'in' ? 'one, two' : undefined}
                onChange={(event) => set({ ...row, value: event.target.value })}
              />
            )}
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Negate condition ${n}`}
              onClick={() => onChange(negate(tree, node.id))}
            >
              Not
            </Button>
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Remove condition ${n}`}
              onClick={() => onChange(removeNode(tree, node.id))}
            >
              ×
            </Button>
          </div>
        )
      }
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {draw(tree, true)}
      {tree.kind !== 'group' && (
        // A lone condition or negation at the top: adding beside it makes an
        // all-of group of the two.
        <div className="flex gap-1.5">
          <Button
            size="xs"
            variant="outline"
            aria-label="Add condition"
            disabled={fieldOptions.length === 0}
            onClick={() => onChange(addCondition(tree, tree.id, firstRow()))}
          >
            Add condition
          </Button>
          <Button
            size="xs"
            variant="outline"
            aria-label="Add group"
            onClick={() => onChange(addGroup(tree, tree.id, 'or'))}
          >
            Add group
          </Button>
        </div>
      )}
    </div>
  )
}
