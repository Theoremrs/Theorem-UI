// SOURCING: d3-dsv's csvFormatRows (as the generic record table's export used it), and the browser's own download (an object URL on a link that is clicked); the cells are what the table shows: related records by name, dates as stored. A cell that a spreadsheet would run as a formula (OWASP's CSV injection guidance: a leading =, +, -, @, tab or carriage return) is written with a leading apostrophe so it is read as text
import { csvFormatRows } from 'd3-dsv'
import type { FieldSpec } from '@/components/records/contract'
import { sortValue } from '@/components/records/fields'
import type { CrmRecord } from './api'

const text = (value: unknown): string =>
  value === null || value === undefined
    ? ''
    : Array.isArray(value)
      ? value.map(text).join(', ')
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)

// Record text can come from Theorem, from imports or from another person; a
// spreadsheet must not run it.
const FORMULA = /^[=+\-@\t\r]/
const inert = (cell: string) => (FORMULA.test(cell) ? `'${cell}` : cell)

// A number stays a number, so -3 is still -3 in the sheet.
const cell = (value: unknown) =>
  typeof value === 'number' ? String(value) : inert(text(value))

/** A header row of the fields' labels, then one row per record, in the order given. */
export function recordsCsv(
  fields: FieldSpec[],
  records: CrmRecord[],
  titleOf: (field: FieldSpec, id: string) => string,
) {
  return csvFormatRows([
    fields.map((field) => inert(field.label)),
    ...records.map((record) =>
      fields.map((field) => cell(sortValue(record, field, titleOf))),
    ),
  ])
}

/** Hands the person a CSV file to save. */
export function downloadCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${name}.csv`
  link.click()
  // Revoked at once, some browsers cancel the download it has just started.
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
