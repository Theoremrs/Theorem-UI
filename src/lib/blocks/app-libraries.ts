// SOURCING: none: the names of the libraries Theorem ships for an App to
// import, and the packages each is built on. A library is a convenience an App
// may import, edit a copy of, or ignore; it is never required.
//
// A library's npm packages are pinned for an App that does not name a version
// itself, so the App and the library share one copy: `@theorem/spatial` hands
// the App three.js objects, which must come from the App's own three.

/** Each library an App can import by name, with the npm packages its source imports. */
export const APP_LIBRARIES: Record<string, { dependencies: Record<string, string> }> = {
  '@theorem/spatial': { dependencies: { three: '0.187.0', elkjs: '0.12.1' } },
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
