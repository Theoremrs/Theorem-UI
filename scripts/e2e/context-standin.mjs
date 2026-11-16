// SOURCING: node:http; a test double of the one chat-completions route Theorem calls, so nothing upstream models it.
//
// The model provider as Theorem sees it during scripts/e2e/crm-context.mjs. It
// keeps every request body whole, beside the saved-record spans it found in
// it, so the scenario can read exactly what was serialized for the model, and
// it answers from that body alone: its reply
// names only what the admitted saved records say. An answer that changes when
// a saved record changes therefore changed because the request did.
//
// It keeps whole requests, so it is for synthetic data only. Nothing here
// reaches a real provider and no real key is involved.
import { createServer } from 'node:http'

const PORT = Number(process.env.E2E_STANDIN_PORT)
const RECORD_SOURCE = 'life_context_record'
const MODEL_SOURCE = 'life_context_model'
const BRIEF_START = '{"brief_id"'

const requests = []

const answer = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const text = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => part?.text ?? '').join('')
      : ''

/**
 * Where the JSON object opening at `start` closes. The brief is one object in
 * the middle of the system message, with prose before it and after it.
 */
function objectEnd(source, start) {
  let depth = 0
  let quoted = false
  for (let at = start; at < source.length; at++) {
    const char = source[at]
    if (quoted) {
      if (char === '\\') at++
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return at + 1
  }
  return source.length
}

/** The saved-record spans of the context brief in a request's system messages. */
const recordSpans = (body) => spansOf(body, RECORD_SOURCE)
/** The span that describes how the person's records are organised, if sent. */
const modelSpans = (body) => spansOf(body, MODEL_SOURCE)

function spansOf(body, sourceType) {
  const spans = []
  for (const message of body?.messages ?? []) {
    if (message.role !== 'system') continue
    const system = text(message.content)
    const start = system.indexOf(BRIEF_START)
    if (start < 0) continue
    let brief
    try {
      brief = JSON.parse(system.slice(start, objectEnd(system, start)))
    } catch {
      continue
    }
    for (const span of brief.evidence ?? [])
      if (span.source_type === sourceType) spans.push(span)
  }
  return spans
}

/** One sentence per admitted record, from its serialized content and nothing else. */
function reply(body) {
  const lines = []
  for (const span of recordSpans(body)) {
    let record
    try {
      record = JSON.parse(span.content)
    } catch {
      continue
    }
    const fields = record.fields ?? {}
    const name =
      fields.title ?? fields.name ?? fields.statement ?? fields.summary
    // A record that relates two others says so in words; repeat them.
    if (record.statement) lines.push(record.statement)
    else if (!name) continue
    else if (record.type === 'Commitment' && fields.due)
      lines.push(`"${name}" is due ${fields.due}.`)
    else lines.push(`${record.type}: ${name}.`)
  }
  return lines.length
    ? `From your saved records. ${lines.join(' ')}`
    : 'I have no saved record about that.'
}

createServer(async (req, res) => {
  if (req.url === '/__requests' && req.method === 'GET')
    return answer(res, 200, requests)
  if (req.url === '/__requests' && req.method === 'DELETE') {
    requests.length = 0
    return answer(res, 200, [])
  }
  // Theorem checks a key before it keeps one; any key is this stand-in's.
  if (req.method === 'GET') return answer(res, 200, { data: { label: 'e2e' } })

  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return answer(res, 400, { error: { message: 'request body is not JSON' } })
  }
  requests.push({
    path: req.url,
    at: Date.now(),
    body,
    recordSpans: recordSpans(body),
    modelSpans: modelSpans(body),
  })
  const content = reply(body)
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  if (!body.stream)
    return answer(res, 200, {
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage,
    })
  // The same answer as a chat-completions event stream, for a model the
  // catalog streams.
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
  event({
    choices: [
      { index: 0, delta: { role: 'assistant', content }, finish_reason: null },
    ],
  })
  event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })
  res.end('data: [DONE]\n\n')
}).listen(PORT, '127.0.0.1')
