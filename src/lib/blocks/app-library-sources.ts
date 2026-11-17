// SOURCING: Vite's `?raw` imports: each library of app-libraries.ts as its
// TypeScript text, for the App build (export.ts) to bundle into an App that
// imports it. A library's modules import each other as `./name`; `index` is
// its entry.
import spatialArrange from './spatial/arrange.ts?raw'
import spatialEngine from './spatial/engine.ts?raw'
import spatialForm from './spatial/form.ts?raw'
import spatialIndex from './spatial/index.ts?raw'
import spatialParts from './spatial/parts.ts?raw'
import spatialView from './spatial/view.ts?raw'

/** Each library's modules by name. */
export const librarySources: Record<string, Record<string, string>> = {
  '@theorem/spatial': {
    arrange: spatialArrange,
    engine: spatialEngine,
    form: spatialForm,
    index: spatialIndex,
    parts: spatialParts,
    view: spatialView,
  },
}
