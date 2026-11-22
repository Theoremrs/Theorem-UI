// esm.sh's package wrappers select a build; /X-.../es2022/*.mjs and
// declaration URLs already identify one. Querying a compiled URL does not
// change its build, so only package wrappers receive the App's defaults.
export const APP_DEPENDENCY_EXTERNALS = 'react,react-dom'

export function esmPackageURL(value: string) {
  const url = new URL(value)
  if (url.origin !== 'https://esm.sh') return undefined
  const match = /^\/(@[\w.-]+\/[\w.-]+|[\w.-]+)(?:@([^/]+))?(?:\/(.*))?$/.exec(url.pathname)
  if (!match || match[1] === 'node' || match[1] === 'error.js') return undefined
  return { name: match[1]!, version: match[2], path: match[3] ?? '' }
}

/** Keep direct and transitive npm imports on the same React-external build.
 * Other build choices (version, subpath, target, conditions, aliases, etc.)
 * remain part of the URL and therefore retain their separate identities. */
export function appDependencyURL(value: string): string {
  const parsed = esmPackageURL(value)
  if (!parsed) return value
  if (
    /^(?:X-[^/]+\/|(?:es\d{4}|esnext|deno(?:next)?|node)\/)/.test(parsed.path) ||
    /\.(?:d\.[cm]?ts|css|json|wasm|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico)$/.test(parsed.path)
  ) return value
  const url = new URL(value)
  // Raw assets and URL-only exports are not package build wrappers.
  if (url.searchParams.has('raw') || url.searchParams.has('url')) return value
  if (!url.searchParams.has('target')) url.searchParams.set('target', 'es2022')
  const external = url.searchParams.get('external')?.split(',').filter(Boolean) ?? []
  if (!external.includes('*')) {
    url.searchParams.set('external', [...new Set([
      ...external, ...APP_DEPENDENCY_EXTERNALS.split(','),
    ])].sort().join(','))
  }
  return url.href
}

/** Only the host's ordinary wrapper policy may choose a shared type tree.
 * Explicit aliases/conditions/dev builds keep their own declaration identity. */
export function usesDefaultDependencyBuild(value: string): boolean {
  const url = new URL(value)
  return esmPackageURL(value) !== undefined &&
    url.searchParams.get('target') === 'es2022' &&
    url.searchParams.get('external') === APP_DEPENDENCY_EXTERNALS &&
    [...url.searchParams.keys()].every((key) => key === 'target' || key === 'external')
}
