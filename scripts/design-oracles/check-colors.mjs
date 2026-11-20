import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { auditPaletteCss, REQUIRED_PALETTE_PAIRS } from './colors.mjs'
const results = auditPaletteCss(
  await readFile(new URL('../../src/palettes.css', import.meta.url), 'utf8'),
)
const modes = results.filter((result) =>
  result.id.startsWith('COL-04.emitted-colors.'),
)
const minimumPairs=results.filter(result=>result.id.startsWith('COL-01.minimum.'))
const contractPairs=results.filter(result=>result.id.startsWith('COL-01.contract.'))
const failures = results.filter((result) => result.status !== 'pass')
// An independent inventory, including Ember in both modes, keeps missing or
// substituted palette blocks from passing on their count alone.
const expectedModes = [
  ':root',
  '.dark',
  "[data-palette='ember']",
  ".dark[data-palette='ember']",
  "[data-palette='stone']",
  ".dark[data-palette='stone']",
  "[data-palette='vitesse']",
  ".dark[data-palette='vitesse']",
  ":root:where(:not([data-appearance-preset]), [data-appearance-preset='calm']):where(:not([data-palette]), [data-palette='github-sharp'])",
  ".dark:where(:not([data-appearance-preset]), [data-appearance-preset='calm']):where(:not([data-palette]), [data-palette='github-sharp'])",
]
const observedModes = modes.map((result) => result.evidence.mode)
if (JSON.stringify(observedModes.sort()) !== JSON.stringify(expectedModes.sort()))
  failures.push({
    id: 'COL-04.coverage',
    status: 'fail',
    observed: observedModes,
    expected: expectedModes,
  })
const expectedPairCount = REQUIRED_PALETTE_PAIRS.length * expectedModes.length
if (minimumPairs.length !== expectedPairCount || contractPairs.length !== expectedPairCount)
  failures.push({id:'COL-01.coverage',status:'fail',observed:{standardRows:minimumPairs.length,contractRows:contractPairs.length,edgeCount:REQUIRED_PALETTE_PAIRS.length,modeCount:modes.length},expected:{standardRows:expectedPairCount,contractRows:expectedPairCount}})
await mkdir('docs/plans/composable-appearance/evidence', { recursive: true })
await writeFile(
  'docs/plans/composable-appearance/evidence/colors.json',
  JSON.stringify({ modes: modes.length, results, failures }, null, 2),
)
console.log(
  `${REQUIRED_PALETTE_PAIRS.length} required color edges × ${modes.length} built-in palette/mode sets; ${results.length} predicates; ${failures.length} failures`,
)
for (const failure of failures) console.error(failure.id, failure.observed)
if (failures.length) process.exitCode = 1
