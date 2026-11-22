// Seeds one project with two sessions through the real Theorem chat API:
// session 1 attaches a markdown document, session 2 a PNG. Both are uploads
// referenced from a user message part, which is how project outputs find them.
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const API = process.env.API ?? 'http://127.0.0.1:8082/api/chat/v1'
const dir = new URL('.', import.meta.url).pathname
const auth = { authorization: 'Bearer local-dev' }

async function call(method: string, path: string, csrf: string, body?: unknown, extra: Record<string, string> = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...auth,
      'content-type': 'application/json',
      'x-csrf-token': csrf,
      'idempotency-key': randomUUID(),
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text}`)
  return JSON.parse(text)
}

const boot = await (await fetch(API + '/bootstrap', { headers: auth })).json()
const csrf: string = boot.csrfToken ?? boot.csrf_token
console.log('bootstrap keys', Object.keys(boot))

// The oldest project is the inbox; its threads are not a project's members.
if (!boot.projects?.items?.length) await call('POST', '/projects', csrf, { title: 'Inbox' })
const project = await call('POST', '/projects', csrf, { title: 'Headland survey' })
const projectId: string = project.record?.projectId ?? project.projectId
console.log('project', projectId)

async function upload(file: string, type: string) {
  const bytes = readFileSync(dir + file)
  const res = await fetch(`${API}/projects/${projectId}/uploads`, {
    method: 'POST',
    headers: {
      ...auth,
      'content-type': type,
      'idempotency-key': randomUUID(),
      'x-csrf-token': csrf,
      'x-file-name-b64': Buffer.from(file).toString('base64url'),
      'x-file-size': String(bytes.length),
      'x-content-sha256': createHash('sha256').update(bytes).digest('hex'),
    },
    body: bytes,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`upload ${file}: ${JSON.stringify(json)}`)
  return json.record
}

async function session(title: string, file: string, type: string, text: string) {
  const created = await call('POST', `/projects/${projectId}/threads`, csrf, { title })
  const thread = created.record ?? created
  const threadId: string = thread.threadId
  const branchId: string = thread.selectedBranchId ?? thread.defaultBranchId ?? thread.branchId
  const revision = created.revision ?? thread.revision ?? 0
  const up = await upload(file, type)
  const uploadId: string = up.uploadId
  console.log('upload', up.state, up.detectedMediaType, up.originalName)
  const msg = await call(
    'POST',
    `/threads/${threadId}/messages`,
    csrf,
    {
      branchId,
      role: 'user',
      uploadIds: [uploadId],
      parts: [
        { partId: 'p1', type: 'text', payload: { text } },
        { partId: 'p2', type: 'attachment', payload: { uploadId, contentRef: up.contentRef, name: up.originalName, mediaType: up.detectedMediaType, state: 'ready' } },
      ],
    },
    { 'if-match': String(revision) },
  )
  console.log(title, { threadId, branchId, uploadId, revision: msg.revision })
  return threadId
}

if (process.env.INSPECT) {
  const t = await call('POST', `/projects/${projectId}/threads`, csrf, { title: 'probe' })
  console.log(JSON.stringify(t, null, 1).slice(0, 1500))
  process.exit(0)
}
await session('Field notes', 'field-notes.md', 'text/markdown', 'Notes from the walk.')
await session('Headland photo', 'headland-at-dusk.png', 'image/png', 'The headland at dusk.')
const outputs = await (await fetch(`${API}/projects/${projectId}/outputs?limit=10`, { headers: auth })).json()
console.log(JSON.stringify(outputs, null, 1))
