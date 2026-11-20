// SOURCING: none — the pure search and order rules for the model catalog (./models-search)
import { expect, test } from 'bun:test'
import {
  compareModelNames,
  matchesModelQuery,
  matchesModelTextFilter,
  pageIndexAfterFilters,
  pageIndexForRows,
} from './models-search'

const model = (
  name: string,
  ref: string,
  vendor = ref.split('/')[1] ?? '',
) => ({
  name,
  ref,
  vendor,
})

const spark = model(
  'Muse Spark 1.3',
  'openrouter/muse-lab/muse-spark-1.3',
  'muse-lab',
)
const contributor = model(
  'Muse Spark 1.3 Contributor',
  'openrouter/muse-lab/muse-spark-1.3-contributor',
  'muse-lab',
)
const banana = model('Nano Banana', 'openrouter/google/nano-banana', 'google')
// Its ref carries m-u-s-e in sequence (llama-3.3-nemotron-super...) without
// the word "muse" occurring anywhere: the reproduced weak fuzzy match.
const nemotron = model(
  'Nemotron',
  'openrouter/nvidia/llama-3.3-nemotron-super-49b-v1.1',
  'nvidia',
)

test('a query matches contiguous text in the name, in any case', () => {
  expect(matchesModelQuery(spark, 'muse')).toBe(true)
  expect(matchesModelQuery(spark, 'MUSE SPARK')).toBe(true)
  expect(matchesModelQuery(spark, 'spark 1.3')).toBe(true)
})

test('outer whitespace is trimmed and an empty query keeps every model', () => {
  expect(matchesModelQuery(spark, '  muse  ')).toBe(true)
  expect(matchesModelQuery(nemotron, '')).toBe(true)
  expect(matchesModelQuery(nemotron, '   ')).toBe(true)
})

test('subsequence letters across a ref do not match', () => {
  expect(matchesModelQuery(nemotron, 'muse')).toBe(false)
  expect(matchesModelQuery(banana, 'muse')).toBe(false)
})

test('vendor and canonical-ID queries match literally', () => {
  expect(matchesModelQuery(nemotron, 'nvidia')).toBe(true)
  expect(matchesModelQuery(spark, 'muse-lab')).toBe(true)
  expect(matchesModelQuery(spark, spark.ref)).toBe(true)
  expect(matchesModelQuery(spark, 'muse-spark-1.3-contributor')).toBe(false)
  expect(matchesModelQuery(contributor, 'muse-spark-1.3-contributor')).toBe(
    true,
  )
})

test('the base model sorts before its longer sibling name', () => {
  expect(compareModelNames(spark, contributor)).toBeLessThan(0)
  expect(compareModelNames(contributor, spark)).toBeGreaterThan(0)
})

test('numeric names sort naturally', () => {
  const two = model('Model 2', 'x/model-2')
  const ten = model('Model 10', 'x/model-10')
  expect(compareModelNames(two, ten)).toBeLessThan(0)
  const minor = model('Model 1.2', 'x/model-1.2')
  const later = model('Model 1.10', 'x/model-1.10')
  expect(compareModelNames(minor, later)).toBeLessThan(0)
})

test('identical names break ties by vendor, then ref', () => {
  const alpha = model('Twins', 'b/twins', 'alpha')
  const beta = model('Twins', 'a/twins', 'beta')
  expect(compareModelNames(alpha, beta)).toBeLessThan(0)
  const first = model('Twins', 'a/twins', 'alpha')
  const second = model('Twins', 'b/twins', 'alpha')
  expect(compareModelNames(first, second)).toBeLessThan(0)
  expect(compareModelNames(first, { ...first })).toBe(0)
})

test('a query or filter change returns to page one', () => {
  expect(pageIndexAfterFilters()).toBe(0)
})

test('a refresh keeps a valid page and clamps an invalid one', () => {
  expect(pageIndexForRows(2, 120, 50)).toBe(2)
  expect(pageIndexForRows(2, 100, 50)).toBe(1)
  expect(pageIndexForRows(2, 40, 50)).toBe(0)
  expect(pageIndexForRows(2, 0, 50)).toBe(0)
})

test('the column text filter compares both sides case-insensitively', () => {
  const contains = [{ value: 'MODEL', operator: 'includesString' }]
  expect(matchesModelTextFilter('Model 1', contains)).toBe(true)
  expect(matchesModelTextFilter('Muse Spark', contains)).toBe(false)
})

test('the column text filter honors its operators', () => {
  expect(
    matchesModelTextFilter('Model 1', [
      { value: 'model', operator: 'startsWith' },
    ]),
  ).toBe(true)
  expect(
    matchesModelTextFilter('Model 1', [{ value: '1', operator: 'endsWith' }]),
  ).toBe(true)
  expect(
    matchesModelTextFilter('Model 1', [
      { value: 'model 1', operator: 'equalsString' },
    ]),
  ).toBe(true)
  expect(
    matchesModelTextFilter('Model 1', [
      { value: 'spark', operator: 'notIncludesString' },
    ]),
  ).toBe(true)
  expect(
    matchesModelTextFilter('Model 1', [
      { value: 'model', operator: 'notEqualsString' },
    ]),
  ).toBe(true)
  expect(matchesModelTextFilter('', [{ value: '', operator: 'isEmpty' }])).toBe(
    true,
  )
  expect(
    matchesModelTextFilter('Model 1', [{ value: '', operator: 'isNotEmpty' }]),
  ).toBe(true)
})

test('the column text filter joins several rules and skips empty values', () => {
  expect(
    matchesModelTextFilter('Model 1', [
      { value: 'model', operator: 'includesString', joinOperator: 'and' },
      { value: '1', operator: 'endsWith' },
    ]),
  ).toBe(true)
  expect(
    matchesModelTextFilter('Model 1', [
      { value: 'spark', operator: 'includesString', joinOperator: 'or' },
      { value: '1', operator: 'endsWith' },
    ]),
  ).toBe(true)
  expect(
    matchesModelTextFilter('Model 1', [
      { value: 'spark', operator: 'includesString', joinOperator: 'and' },
      { value: '1', operator: 'endsWith' },
    ]),
  ).toBe(false)
  expect(matchesModelTextFilter('Model 1', [{ value: '' }])).toBe(true)
})
