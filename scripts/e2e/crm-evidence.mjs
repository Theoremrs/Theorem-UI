// Reduces the provider requests scripts/e2e/crm-context.mjs kept to what the
// evidence needs, and copies them with the run's screenshots into
// docs/plans/evidence/crm-life-context.
//
//   E2E_DATA_DIR=<dir> node scripts/e2e/crm-evidence.mjs [run.log]
//
// Whole request bodies stay in the data directory: they are large, and the
// system prompt is not this scenario's subject. Each kept request names its
// size and digest, so the whole body can be matched to it.
import { createHash } from 'node:crypto'
import { copyFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config.mjs'
import { SHOTS } from './lib.mjs'

const OUT = 'docs/plans/evidence/crm-life-context'
const raw = JSON.parse(
  readFileSync(join(DATA_DIR, 'crm-context-requests.json'), 'utf8'),
)
const { run } = raw

const text = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? '').join('')
      : ''

// The negative controls crm-context.mjs seeds, searched for in each whole body.
const searches = {
  'phone number kept from Theorem': '555-0100',
  'private note': 'Noor mentioned the studio may close',
  "other workspace's contact": "Blake's landlord",
  "other workspace's record id": `person:noor-other-${run}`,
  "private record's id": `interaction:private-${run}`,
}

const requests = raw.requests.map((request, index) => {
  const body = request.body ?? {}
  const serialized = JSON.stringify(body)
  const messages = body.messages ?? []
  const system = messages.find((message) => message.role === 'system')
  const tools = (body.tools ?? []).map(
    (tool) => tool?.function?.name ?? tool?.name,
  )
  const toolResults = messages
    .filter((message) => message.role === 'tool')
    .map((message) => {
      try {
        return JSON.parse(text(message.content))
      } catch {
        return { unparsed: text(message.content).slice(0, 200) }
      }
    })
  return {
    turn: index + 1,
    path: request.path,
    bodyKeys: Object.keys(body),
    model: body.model,
    serializedBody: {
      note: 'The body as the stand-in parsed it, serialized again with JSON.stringify.',
      bytes: Buffer.byteLength(serialized),
      sha256: createHash('sha256').update(serialized).digest('hex'),
    },
    messageRoles: messages.map((message) => message.role),
    systemMessageBytes: Buffer.byteLength(text(system?.content)),
    userMessages: messages
      .filter((message) => message.role === 'user')
      .map((message) => text(message.content)),
    earlierAnswersInHistory: messages
      .filter((message) => message.role === 'assistant' && text(message.content))
      .map((message) => text(message.content)),
    offersLookUp: tools.includes('saved_records_look_up'),
    toolCalls: messages.flatMap((message) =>
      (message.tool_calls ?? []).map((call) => ({
        name: call.function?.name,
        arguments: call.function?.arguments,
      })),
    ),
    toolResults,
    recordSpans: request.recordSpans,
    modelSpans: request.modelSpans,
    searchedForInWholeBody: Object.fromEntries(
      Object.entries(searches).map(([label, needle]) => [
        label,
        { text: needle, found: serialized.includes(needle) },
      ]),
    ),
  }
})

writeFileSync(
  join(OUT, 'provider-requests.json'),
  `${JSON.stringify({ ...raw, requests }, null, 2)}\n`,
)

let shots = 0
for (const name of readdirSync(SHOTS)) {
  if (!name.startsWith('crm-context-') || !name.endsWith('.png')) continue
  copyFileSync(join(SHOTS, name), join(OUT, name))
  shots++
}

const log = process.argv[2]
if (log) copyFileSync(log, join(OUT, 'crm-context-run.log'))

console.log(
  `${requests.length} requests, ${shots} screenshots${log ? ', the run log' : ''} -> ${OUT}`,
)
