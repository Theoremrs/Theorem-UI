// SOURCING: Theorem's client operations, as the web declares `app.check` (Theorem-UI src/lib/blocks/app-operations.ts APP_OPERATIONS, copied: the agent reads the description, so keep it in step) and words a check (src/components/chat/theorem-parts.tsx appCheckSummary); the artifact part as src/components/artifacts/artifact-model.ts readArtifact reads it

export const APP_CHECK = 'app.check'

/** The largest App a check is given, as the server allows one to be. */
const MAX_HTML = 1024 * 1024
const MAX_RUN_MS = 5000

export const APP_OPERATIONS = [
  {
    name: APP_CHECK,
    effect: 'read' as const,
    description:
      "Builds and checks an App in the person's browser and returns what is wrong with it. Pass `html`, a complete App document exactly as it would be published, to check a draft before publishing it; or pass `documentId` to check a published App as it is saved now. The result says whether it built, lists its build, type and runtime problems with file, line and column, and gives what the App showed: its text, and `outline`, each thing on the page by role, name and state as assistive technology reads it, with the source place that made it. Pass `picture: true` to also get `picture`, an image of the App as drawn, if you read images. Nothing is changed and nothing is shown to the person: the App runs hidden for a moment, reaching the network as it would on the page, with empty state and an empty in-memory database, so records it reads are not the person's.",
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        html: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_HTML,
          description: 'A complete App document to check as a draft.',
        },
        documentId: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          description: 'A published App, checked as it is saved now.',
        },
        runMs: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_RUN_MS,
          description:
            'How long to run the App and listen for errors. 0 builds and checks types without running it. Default 1500.',
        },
        picture: {
          type: 'boolean',
          description:
            'Also return an image of what the App showed. Only a model that reads images is shown it.',
        },
      },
    },
  },
]

type Json = Record<string, unknown>
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const str = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

export const ARTIFACT_PART = 'theorem-artifact'

export type AppRevision = {
  artifactId: string
  documentId: string
  title: string
  html: string
  /** The revision's position in its document. */
  position?: string
  revision: string
}

/** An App revision a message part carries, or undefined for any other artifact. */
export function appRevisionOf(data: unknown): AppRevision | undefined {
  const outer = object(data)
  // The part itself, or the part wrapped as its payload.
  const source = str(outer.artifactId) ? outer : object(outer.payload)
  const payload = object(source.payload)
  const kind = str(source.artifactKind) ?? str(payload.form) ?? str(source.form)
  const artifactId = str(source.artifactId)
  const html = str(payload.content)
  if (kind !== 'app' || !artifactId || !html) return undefined
  const position = object(payload.revision).position
  return {
    artifactId,
    documentId: str(payload.documentId) ?? artifactId,
    title: str(payload.title) ?? 'App',
    html,
    position: position === undefined || position === null ? undefined : String(position),
    revision: str(source.artifactRevision) ?? artifactId,
  }
}

/** One line for an App check, as the web words it. */
export function appCheckWords(
  data: unknown,
  running: boolean,
): { words: string; pending: boolean; wrong: boolean } {
  const call = object(data)
  const state = str(call.state) ?? 'pending'
  const receipt = object(call.receipt)
  const result = object(receipt.result)
  const problems = Array.isArray(result.problems) ? result.problems.length : 0
  const found = problems + (typeof result.omitted === 'number' ? result.omitted : 0)
  const pending = state === 'pending' && running
  const checked = state === 'answered' && str(receipt.outcome) === 'applied'
  const reason = checked ? str(result.typeCheckError) : undefined
  const wrong = !pending && (!checked || found > 0 || reason !== undefined)
  const words = pending
    ? 'Checking the App'
    : !checked
      ? 'The App was not checked'
      : result.built === false
        ? 'The App does not build'
        : found > 0
          ? `Checked the App: ${found === 1 ? '1 problem' : `${found} problems`}`
          : reason !== undefined
            ? 'Checked the App: its types could not be checked'
            : 'Checked the App: no problems'
  return { words, pending, wrong }
}

/** The problems a check listed, one to a line, each after where it is when the check says. */
export function appCheckProblems(data: unknown): string[] {
  const problems = object(object(object(data).receipt).result).problems
  if (!Array.isArray(problems)) return []
  return problems.map((value) => {
    const problem = object(value)
    const where = [str(problem.file), problem.line, problem.column]
      .filter((part) => part !== undefined)
      .join(':')
    const message = str(problem.message) ?? 'Unknown problem'
    return where ? `${where}  ${message}` : message
  })
}
