// SOURCING: src/lib/modules/contract.ts (parseManifest: the manifest is read
// against its schema), the DOM's own parser (an entry page is parsed, never
// run) and ./activation's ports. These are the default ports for a module
// installed as files in the vault. The real initialization preview needs an
// isolated frame; the shell supplies it by passing its own `preview` port.
import { ModuleFileError, parseManifest } from '@/lib/modules/contract'
import type { ModuleManifest } from '@/lib/modules/contract'
import { StageFailure } from './activation'
import type { CandidateInput, PreviewCapabilities } from './activation'
import { buildRelease } from './release'
import type {
  Provenance,
  Release,
  ResolvedDependency,
  Diagnostic,
} from './types'

const MANIFEST = 'module.json'
export const MAX_ENTRY_BYTES = 4 * 1024 * 1024

export interface VaultResolveOptions {
  provenance?: Provenance
  dependencies?: (
    files: Record<string, string>,
  ) => Promise<ResolvedDependency[]>
  data?: Release['data']
  at?: () => number
}

const manifestPathOf = (files: Record<string, string>) =>
  Object.keys(files).find(
    (path) => path === MANIFEST || path.endsWith(`/${MANIFEST}`),
  )

/** Reads a module's files into a release: manifest checked against its schema, entry points named. */
export function vaultResolver(options: VaultResolveOptions = {}) {
  return async (input: CandidateInput): Promise<Release> => {
    const manifestPath = manifestPathOf(input.files)
    if (!manifestPath)
      throw new StageFailure([
        {
          stage: 'resolve',
          severity: 'error',
          message: 'There is no module.json in the files.',
          hint: 'A module is a folder with a module.json and its page.',
        },
      ])
    let manifest: ModuleManifest
    try {
      manifest = parseManifest(manifestPath, input.files[manifestPath]!)
    } catch (error) {
      if (error instanceof ModuleFileError)
        throw new StageFailure([
          {
            stage: 'resolve',
            severity: 'error',
            message: error.message,
            file: manifestPath,
            hint: 'Fix the manifest; the release you have keeps running.',
          },
        ])
      throw error
    }
    const folder = manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1)
    const entryPoints =
      manifest.implementation.kind === 'sandboxed-html'
        ? [`${folder}${manifest.implementation.entry}`]
        : []
    return buildRelease({
      identity: manifest.id,
      files: input.files,
      manifestPath,
      entryPoints,
      dependencies: (await options.dependencies?.(input.files)) ?? [],
      requested:
        manifest.implementation.kind === 'composite'
          ? { read: [], write: [], state: [], net: [] }
          : manifest.capabilities,
      version: manifest.version,
      provenance: options.provenance,
      data: options.data,
      at: options.at?.(),
    })
  }
}

const error = (
  stage: Diagnostic['stage'],
  message: string,
  file?: string,
  hint?: string,
): Diagnostic => ({
  stage,
  severity: 'error',
  message,
  ...(file ? { file } : {}),
  ...(hint ? { hint } : {}),
})

/** Structural checks: every entry point is there, is a page, and is a sane size. */
export async function structuralChecks(
  release: Release,
): Promise<Diagnostic[]> {
  const problems: Diagnostic[] = []
  for (const entry of release.entryPoints) {
    const text = release.files[entry]
    if (text === undefined)
      problems.push(
        error(
          'compile',
          `The entry page ${entry} is missing.`,
          entry,
          'Add it, or point module.json at the page that exists.',
        ),
      )
    else if (text.length > MAX_ENTRY_BYTES)
      problems.push(
        error(
          'compile',
          `${entry} is larger than ${MAX_ENTRY_BYTES} bytes.`,
          entry,
        ),
      )
    else if (!/<\s*(?:!doctype|html|body|script|div|p)\b/i.test(text))
      problems.push(
        error('compile', `${entry} does not look like an HTML page.`, entry),
      )
  }
  return problems
}

/**
 * The default preview: the entry page is parsed and every classic inline script
 * is compiled (not run) so a syntax error is found before activation. It
 * never executes module code and holds no capability, so it cannot write.
 * An isolated frame that runs initialization is the shell's `preview` port.
 */
export async function staticPreview(
  release: Release,
  _preview: PreviewCapabilities,
): Promise<Diagnostic[]> {
  const problems: Diagnostic[] = []
  for (const entry of release.entryPoints) {
    const html = release.files[entry]
    if (html === undefined) continue
    const page = new DOMParser().parseFromString(html, 'text/html')
    for (const script of page.querySelectorAll('script')) {
      const type = script.getAttribute('type')
      if (script.src || (type && type !== 'text/javascript' && type !== ''))
        continue
      try {
        // Compiles the text as a function body without calling it.
        new Function(script.textContent)
      } catch (cause) {
        problems.push(
          error(
            'preview',
            `A script in ${entry} does not compile: ${cause instanceof Error ? cause.message : String(cause)}`,
            entry,
            'Fix the script. The release you have keeps running.',
          ),
        )
      }
    }
  }
  return problems
}
