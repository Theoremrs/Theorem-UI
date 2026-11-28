// SOURCING: none — class definitions as a portable JSON file over the register's own declaration shape (components/records/schema-edit toInput); importing declares each through declareSchema like any class, so nothing here is a second format to keep in step
import type {
  DataModel,
  ObjectType,
  ObjectTypeInput,
} from '@/components/records/contract'
import { toInput } from '@/components/records/schema-edit'

export const EXPORT_FORMAT = 'theorem.object-classes/1'

export type ClassExport = {
  format: typeof EXPORT_FORMAT
  exportedAt: string
  classes: ObjectTypeInput[]
}

/** The definitions of `types`, instances excluded, ready to save as a file. */
export function exportClasses(types: ObjectType[]): ClassExport {
  return {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    classes: types.map(toInput),
  }
}

export type ImportPlan = {
  /** Classes the register does not have: declared new. */
  create: ObjectTypeInput[]
  /** Classes it has under the same name: replaced at the anchor read, so a change made since is refused. */
  replace: { input: ObjectTypeInput; current: ObjectType }[]
  /** Entries that are not class definitions. */
  rejected: { index: number; reason: string }[]
}

const isInput = (value: unknown): value is ObjectTypeInput => {
  const v = value as Partial<ObjectTypeInput> | null
  return (
    !!v &&
    typeof v.name_singular === 'string' &&
    typeof v.label_singular === 'string' &&
    typeof v.node_label === 'string' &&
    Array.isArray(v.fields)
  )
}

/** Read an export file against the register, deciding what each entry becomes. */
export function planImport(text: string, model: DataModel): ImportPlan {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`The file is not JSON: ${(error as Error).message}`)
  }
  const file = parsed as Partial<ClassExport>
  if (file.format !== EXPORT_FORMAT || !Array.isArray(file.classes))
    throw new Error(`The file is not a ${EXPORT_FORMAT} class export.`)
  const byName = new Map(
    model.objectTypes.map((type) => [type.name_singular, type]),
  )
  const plan: ImportPlan = { create: [], replace: [], rejected: [] }
  file.classes.forEach((entry, index) => {
    if (!isInput(entry)) {
      plan.rejected.push({ index, reason: 'not a class definition' })
      return
    }
    const current = byName.get(entry.name_singular)
    if (current) plan.replace.push({ input: entry, current })
    else plan.create.push(entry)
  })
  return plan
}
