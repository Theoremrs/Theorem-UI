// SOURCING: none — the CSV export's cells, checked as a spreadsheet would read them
import { expect, test } from 'bun:test'
import type { FieldSpec } from '@/components/records/contract'
import type { CrmRecord } from './api'
import { recordsCsv } from './export-csv'

const field = (key: string, kind: 'text' | 'number'): FieldSpec =>
  ({
    key,
    label: key,
    field_type: { kind },
    required: false,
    system: false,
  })

const record = (values: Record<string, unknown>): CrmRecord =>
  ({ id: 'person:a', values, version: 1, labels: [] }) as unknown as CrmRecord

test('a cell a spreadsheet would run as a formula is written as text; a number is not', () => {
  const csv = recordsCsv(
    [field('name', 'text'), field('note', 'text'), field('balance', 'number')],
    [
      record({
        name: '=HYPERLINK("http://example.test")',
        note: '@sum',
        balance: -3,
      }),
      record({ name: 'Noor', note: '-not a number', balance: 4 }),
    ],
    () => '',
  )
  const [, first, second] = csv.split('\n')
  expect(first).toBe(`"'=HYPERLINK(""http://example.test"")",'@sum,-3`)
  expect(second).toBe(`Noor,'-not a number,4`)
})
