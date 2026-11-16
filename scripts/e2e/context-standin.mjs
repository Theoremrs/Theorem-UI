// SOURCING: node:http; a test double of the one chat-completions route Theorem calls, so nothing upstream models it.
//
// The model provider as Theorem sees it during scripts/e2e/crm-context.mjs. It
// keeps every request body whole, beside the saved-record spans it found in
// it, so the scenario can read exactly what was serialized for the model, and
// it answers from that body alone: its reply
// names only what the admitted saved records say. An answer that changes when
// a saved record changes therefore changed because the request did.
//
// Asked to "list my <type>", it calls Theorem's look-up tool when the request
// offers it, and answers from what the tool returned.
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

const LOOK_UP = 'saved_records_look_up'

/** The messages after the person's latest one. */
function sinceAsked(body) {
  const messages = body?.messages ?? []
  const asked = messages.map((message) => message.role).lastIndexOf('user')
  return { asked: messages[asked], after: messages.slice(asked + 1) }
}

/** The look-up to make for this request, when it asks for one and has none yet. */
function lookUpFor(body) {
  const offered = (body?.tools ?? []).some(
    (tool) => (tool?.function?.name ?? tool?.name) === LOOK_UP,
  )
  const { asked, after } = sinceAsked(body)
  if (!offered || after.some((message) => message.role === 'tool')) return
  const type = /list (?:all )?my (\w+)/i.exec(text(asked?.content))?.[1]
  return type ? { types: [type] } : undefined
}

/** The records a look-up returned to this request, if it made one. */
function lookedUp(body) {
  const records = []
  for (const message of sinceAsked(body).after) {
    if (message.role !== 'tool') continue
    try {
      for (const entry of JSON.parse(text(message.content)).records ?? [])
        if (entry?.record) records.push(entry.record)
    } catch {
      continue
    }
  }
  return records
}

/** One sentence per admitted record, from its serialized content and nothing else. */
function reply(body) {
  const found = lookedUp(body)
  const given = found.length
    ? found
    : recordSpans(body).flatMap((span) => {
        try {
          return [JSON.parse(span.content)]
        } catch {
          return []
        }
      })
  const lines = []
  for (const record of given) {
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
  if (!lines.length) return 'I have no saved record about that.'
  return `${found.length ? 'I looked these up.' : 'From your saved records.'} ${lines.join(' ')}`
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
  const lookUp = lookUpFor(body)
  const call = lookUp && {
    id: `call-${requests.length}`,
    type: 'function',
    function: { name: LOOK_UP, arguments: JSON.stringify(lookUp) },
  }
  const content = call ? null : reply(body)
  const finish = call ? 'tool_calls' : 'stop'
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  if (!body.stream)
    return answer(res, 200, {
      choices: [
        {
          index: 0,
          message: call
            ? { role: 'assistant', content, tool_calls: [call] }
            : { role: 'assistant', content },
          finish_reason: finish,
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
      {
        index: 0,
        delta: call
          ? { role: 'assistant', tool_calls: [{ index: 0, ...call }] }
          : { role: 'assistant', content },
        finish_reason: null,
      },
    ],
  })
  event({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })
  res.end('data: [DONE]\n\n')
}).listen(PORT, '127.0.0.1')
