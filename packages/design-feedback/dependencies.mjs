import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve an installed dependency without downloading packages or changing a project. */
export async function dependency(name) {
  if (!['playwright-core', 'pngjs', 'pixelmatch'].includes(name)) throw new Error(`Unsupported dependency: ${name}`)
  const candidates = [
    import.meta.url,
    pathToFileURL(join(process.cwd(), 'package.json')),
    ...[process.env.DESIGN_FEEDBACK_NODE_MODULES, process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES]
      .filter(Boolean).map((directory) => pathToFileURL(join(resolve(directory), '__design_feedback__.cjs'))),
  ]
  for (const candidate of candidates) {
    let resolved
    try { resolved = createRequire(candidate).resolve(name) } catch { continue }
    return import(pathToFileURL(resolved).href)
  }
  throw new Error(`Missing ${name}. Install playwright-core@1.62.1 pngjs@7.0.0 pixelmatch@7.2.0 in this project, or set DESIGN_FEEDBACK_NODE_MODULES to an existing node_modules directory. No packages were downloaded.`)
}
