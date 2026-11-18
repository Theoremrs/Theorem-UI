// SOURCING: none: the names of the libraries Theorem ships for an App to
// import, and the packages each is built on. A library is a convenience an App
// may import, edit a copy of, or ignore; it is never required.
//
// A library's npm packages are pinned for an App that does not name a version
// itself, so the App and the library share one copy: `@theorem/spatial` hands
// the App three.js objects, which must come from the App's own three.

export interface AppLibrary {
  /** The npm packages its source imports, at the versions it is built against. */
  dependencies: Record<string, string>
  /**
   * The packages its declarations import, which an App that imports it is
   * checked against. A test holds this to the generated declarations.
   */
  types: ReadonlyArray<string>
}

const annotate: AppLibrary = {
  dependencies: {
    '@astryxdesign/core': '0.7.16',
    '@astryxdesign/theme-neutral': '0.7.16',
    '@floating-ui/core': '1.8.0',
    '@stylexjs/stylex': '0.19.2',
  },
  types: ['react'],
}

/** Each library an App can import by name. */
export const APP_LIBRARIES: Record<string, AppLibrary> = {
  '@theorem/annotate': annotate,
  '@theorem/spatial': {
    dependencies: { ...annotate.dependencies, three: '0.187.0', elkjs: '0.12.1' },
    types: ['react', 'three'],
  },
}

/** The library a bare specifier names, if it names one. */
export const appLibrary = (specifier: string) =>
  Object.hasOwn(APP_LIBRARIES, specifier) ? APP_LIBRARIES[specifier] : undefined

/** The pinned packages of every library an App's files import. */
export function libraryDependencies(files: Record<string, string>): Record<string, string> {
  const pinned: Record<string, string> = {}
  for (const [name, library] of Object.entries(APP_LIBRARIES)) {
    const imported = new RegExp(`['"]${name.replace(/[/@]/g, '\\$&')}['"]`)
    if (Object.values(files).some((source) => imported.test(source)))
      Object.assign(pinned, library.dependencies)
  }
  return pinned
}
