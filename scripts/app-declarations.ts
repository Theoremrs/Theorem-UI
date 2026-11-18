// Writes the declarations a TypeScript App is checked against for
// `window.theorem` and for the libraries of app-libraries.ts
// (`@theorem/annotate`, `@theorem/runtime`, `@theorem/spatial`), from the code that implements
// them.
//
//   bun scripts/app-declarations.ts
//
// TypeScript emits the declarations of src/lib/blocks/sandbox/app-bridge.ts
// and the sandbox files it imports. They are written, with an index that
// declares the `theorem` global, to
// src/lib/blocks/check/theorem-app.generated.ts as the files of a package the
// checker finds at node_modules/@theorem/app. Each library's declarations,
// from src/lib/blocks/<folder>/index.ts and the files it imports, go beside
// them as node_modules/<library>. A library importing another (spatial uses
// annotate) is checked against the other's declarations, not its source.
//
// Run it after changing what `window.theorem` or a library offers. A test
// (src/lib/blocks/app-check.test.ts) fails while the written file differs
// from what this would write.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '..')
const SANDBOX = path.join(ROOT, 'src/lib/blocks/sandbox')
const BLOCKS = path.join(ROOT, 'src/lib/blocks')
export const GENERATED = path.join(
  ROOT,
  'src/lib/blocks/check/theorem-app.generated.ts',
)

// Declarations Theorem writes for a library's dependencies that ship none.
// They type the library's own code; nothing a library exports names them.
const UNTYPED = [path.join(ROOT, 'src/types/liquid-gl.d.ts')]

const INDEX = `import type { TheoremApp } from './app-bridge'

declare global {
  /** The App's bridge to Theorem: its declared files, state, databases and runs. */
  const theorem: TheoremApp
  interface Window {
    theorem: TheoremApp
  }
}

export {}
`

/** The declarations TypeScript emits for `entry` and the files it imports, by file name. */
function declarations(entry: string, paths: Record<string, Array<string>> = {}): Record<string, string> {
  const files: Record<string, string> = {}
  const program = ts.createProgram([entry, ...UNTYPED], {
    paths,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    lib: ['lib.es2023.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'],
    types: [],
    strict: true,
    skipLibCheck: true,
    // A library's stylesheets are imported for their effect; they have no types.
    noUncheckedSideEffectImports: false,
    declaration: true,
    emitDeclarationOnly: true,
    rootDir: path.dirname(entry),
    outDir: '/',
  })
  const result = program.emit(undefined, (file, text) => {
    files[path.basename(file)] = text
  })
  const failures = ts
    .getPreEmitDiagnostics(program)
    .concat(result.diagnostics)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (failures.length)
    throw new Error(
      failures
        .map((failure) =>
          ts.flattenDiagnosticMessageText(failure.messageText, '\n'),
        )
        .join('\n'),
    )
  const name = path.basename(entry).replace(/\.tsx?$/, '.d.ts')
  if (!files[name])
    throw new Error(`TypeScript wrote no declarations for ${path.basename(entry)}`)
  return files
}

const sorted = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))

/** @theorem/app's files by name: one `.d.ts` per sandbox file, and the index. */
export function appDeclarations(): Record<string, string> {
  const files = declarations(path.join(SANDBOX, 'app-bridge.ts'))
  files['index.d.ts'] = INDEX
  files['package.json'] = JSON.stringify({
    name: '@theorem/app',
    types: 'index.d.ts',
  })
  return sorted(files)
}

/** A library's files by name: one `.d.ts` per module of `src/lib/blocks/<folder>`. */
export function libraryFiles(
  name: string,
  folder: string,
  paths?: Record<string, Array<string>>,
): Record<string, string> {
  const files = declarations(path.join(BLOCKS, folder, 'index.ts'), paths)
  files['package.json'] = JSON.stringify({ name, types: 'index.d.ts' })
  return sorted(files)
}

/** Each library of app-libraries.ts, by name, as its declaration files. */
export function libraryDeclarations(): Record<string, Record<string, string>> {
  const annotate = libraryFiles('@theorem/annotate', 'annotate')
  const runtime = libraryFiles('@theorem/runtime', 'artifact-runtime')
  // spatial imports annotate and runtime by name: give TypeScript their declarations there.
  const folder = mkdtempSync(path.join(tmpdir(), 'theorem-libraries-'))
  try {
    const written: Record<string, Array<string>> = {}
    for (const [name, files] of Object.entries({ annotate, runtime })) {
      const into = path.join(folder, name)
      mkdirSync(into)
      for (const [file, text] of Object.entries(files)) writeFileSync(path.join(into, file), text)
      written[name] = [path.join(into, 'index.d.ts')]
    }
    return {
      '@theorem/annotate': annotate,
      '@theorem/runtime': runtime,
      '@theorem/spatial': libraryFiles('@theorem/spatial', 'spatial', {
        '@theorem/annotate': written.annotate!,
        '@theorem/runtime': written.runtime!,
      }),
    }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

/** The generated module's text. */
export function generatedModule(): string {
  return `// SOURCING: generated by scripts/app-declarations.ts from
// src/lib/blocks/sandbox/ and the libraries' folders; do not edit. The
// declarations a TypeScript App is checked against for \`window.theorem\`, as
// the files of @theorem/app, and for each library of app-libraries.ts.

export const theoremAppDeclarations: Record<string, string> = ${JSON.stringify(appDeclarations(), null, 2)}

/** Each library of app-libraries.ts, as its declaration files by name. */
export const libraryDeclarations: Record<string, Record<string, string>> = ${JSON.stringify(libraryDeclarations(), null, 2)}
`
}

if (import.meta.main) {
  await Bun.write(GENERATED, generatedModule())
  console.log(`wrote ${path.relative(ROOT, GENERATED)}`)
}
