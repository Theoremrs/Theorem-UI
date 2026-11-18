// SOURCING: Vite's `?raw` imports: each library of app-libraries.ts as its
// source text, for the App build (export.ts) to bundle into an App that
// imports it. A library's modules import each other as `./name`, with or
// without the extension; `index` is its entry.
import annotateAnchors from './annotate/anchors.ts?raw'
import annotateAnnotation from './annotate/annotation.tsx?raw'
import annotateGlass from './annotate/glass.tsx?raw'
import annotateHooks from './annotate/hooks.ts?raw'
import annotateIndex from './annotate/index.ts?raw'
import annotateLayer from './annotate/layer.tsx?raw'
import annotateNote from './annotate/note.tsx?raw'
import annotatePaths from './annotate/paths.ts?raw'
import annotatePlace from './annotate/place.ts?raw'
import annotateThemeCss from './annotate/theme.css?raw'
import annotateTheme from './annotate/theme.tsx?raw'
import runtimeDigest from './artifact-runtime/digest.ts?raw'
import runtimeIndex from './artifact-runtime/index.ts?raw'
import runtimeSession from './artifact-runtime/session.ts?raw'
import runtimeTypes from './artifact-runtime/types.ts?raw'
import runtimeValues from './artifact-runtime/values.ts?raw'
import spatialArrange from './spatial/arrange.ts?raw'
import spatialChromeCss from './spatial/chrome.css?raw'
import spatialChrome from './spatial/chrome.tsx?raw'
import spatialDossier from './spatial/dossier.tsx?raw'
import spatialEngine from './spatial/engine.ts?raw'
import spatialForm from './spatial/form.ts?raw'
import spatialIndex from './spatial/index.ts?raw'
import spatialParts from './spatial/parts.ts?raw'
import spatialTimeline from './spatial/timeline.ts?raw'
import spatialTrace from './spatial/trace.ts?raw'
import spatialView from './spatial/view.ts?raw'

/** Each library's modules by file name. */
export const librarySources: Record<string, Record<string, string>> = {
  '@theorem/annotate': {
    'anchors.ts': annotateAnchors,
    'annotation.tsx': annotateAnnotation,
    'glass.tsx': annotateGlass,
    'hooks.ts': annotateHooks,
    'index.ts': annotateIndex,
    'layer.tsx': annotateLayer,
    'note.tsx': annotateNote,
    'paths.ts': annotatePaths,
    'place.ts': annotatePlace,
    'theme.css': annotateThemeCss,
    'theme.tsx': annotateTheme,
  },
  '@theorem/runtime': {
    'digest.ts': runtimeDigest,
    'index.ts': runtimeIndex,
    'session.ts': runtimeSession,
    'types.ts': runtimeTypes,
    'values.ts': runtimeValues,
  },
  '@theorem/spatial': {
    'arrange.ts': spatialArrange,
    'chrome.css': spatialChromeCss,
    'chrome.tsx': spatialChrome,
    'dossier.tsx': spatialDossier,
    'engine.ts': spatialEngine,
    'form.ts': spatialForm,
    'index.ts': spatialIndex,
    'parts.ts': spatialParts,
    'timeline.ts': spatialTimeline,
    'trace.ts': spatialTrace,
    'view.ts': spatialView,
  },
}

/** A library module by the path an import names, with its extension found. */
export function libraryModule(library: string, name: string): { file: string; source: string } | undefined {
  const modules = librarySources[library]
  if (!modules) return undefined
  for (const file of [name, `${name}.ts`, `${name}.tsx`])
    if (Object.hasOwn(modules, file)) return { file, source: modules[file]! }
  return undefined
}
