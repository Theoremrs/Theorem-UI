// SOURCING: node:http; a test double of the one chat-completions route Theorem calls, so nothing upstream models it.
//
// A model that follows a rule, for scenarios that must not depend on what a
// real model decides: scripts/e2e/project-context.mjs. Asked to
//
//   Add <address> to this project as <title>.
//
// it reads the project's context, writes it back with the link under the
// revision it read, and says so. Asked anything else it answers "ok". It keeps
// what each call carried at /__calls, so a scenario can prove what a session
// was given. Nothing here is a secret: the stack points Theorem at it with a
// placeholder credential.
import { createServer } from 'node:http'

const PORT = Number(process.env.E2E_SCRIPTED_PORT)
const READ = 'read_project_context'
const WRITE = 'write_project_context'
// The ask is the message's first line: Theorem appends what the turn was
// given. The composer writes Markdown, which escapes the address's colon.
const ASKED = /^Add (https?\\?:\/\/\S+) to this project as (.+?)\.?[ \t]*$/m

const calls = []

const answer = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** A message's text, whether it came as a string or as parts. */
const text = (message) =>
  typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((part) => part.text ?? '').join('')

/** The project's context somewhere inside what a tool returned. */
function record(value) {
  if (typeof value === 'string') {
    const start = value.indexOf('{')
    if (start < 0) return undefined
    try {
      return record(JSON.parse(value.slice(start)))
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  if (Number.isInteger(value.revision) && Array.isArray(value.links))
    return value
  for (const inner of Object.values(value)) {
    const found = record(inner)
    if (found) return found
  }
  return undefined
}

const say = (content) => ({ role: 'assistant', content })
const call = (name, args) => ({
  role: 'assistant',
  content: null,
  tool_calls: [
    {
      id: `call-${calls.length}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    },
  ],
})

function reply({ messages = [], tools = [] }) {
  const offered = tools.map((tool) => tool.function?.name)
  const last = messages.findLastIndex((message) => message.role === 'user')
  const asked = ASKED.exec(text(messages[last]))
  if (!asked || !offered.includes(READ) || !offered.includes(WRITE))
    return say('ok')
  const [, address, title] = asked
  const url = address.replace('\\:', ':')
  const returned = messages
    .slice(last + 1)
    .filter((message) => message.role === 'tool')
  if (returned.length === 0) return call(READ, {})
  if (returned.length > 1) return say(`I added ${title} to this project.`)
  const held = record(text(returned[0]))
  if (!held) return say(`I could not read this project's context.`)
  return call(WRITE, {
    revision: held.revision,
    documents: held.documents ?? [],
    repositories: held.repositories ?? [],
    links: [...held.links, { url, title }],
  })
}

createServer(async (req, res) => {
  if (req.url === '/__calls') return answer(res, 200, calls)
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    return answer(res, 400, { error: { message: 'not JSON' } })
  }
  const message = reply(body)
  calls.push({
    path: req.url,
    tools: (body.tools ?? []).map((tool) => tool.function?.name),
    messages: (body.messages ?? []).map((sent) => ({
      role: sent.role,
      text: text(sent),
    })),
    reply: message,
  })
  answer(res, 200, {
    id: `chatcmpl-${calls.length}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}).listen(PORT, '127.0.0.1', () => console.log(`scripted model on ${PORT}`))
