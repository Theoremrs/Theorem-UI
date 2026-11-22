// SOURCING: none — one predicate over the DOM KeyboardEvent; the platform test is the one terminal/src/workbench.rs uses (platform_of), so both sides agree on what Mod means
type KeyLike = {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
}

type NavigatorLike = { platform?: string; userAgent?: string }

/** The same reading as the Rust side: a Mac says so in its platform or user agent. */
export const isMac = (navigator: NavigatorLike): boolean =>
  (navigator.platform ?? '').includes('Mac') ||
  (navigator.userAgent ?? '').includes('Mac')

/**
 * Whether this key press is the browser's own paste chord. The browser answers it with a `paste`
 * event that carries the text, and that event is how a paste enters the workbench. Passing the key
 * on as well would have the panel ask the host to read the clipboard, and the text would arrive
 * twice. On a Mac Ctrl+V is not paste: it stays a key, so a terminal still receives ^V.
 */
export function isPasteChord(event: KeyLike, mac: boolean): boolean {
  if (event.key.toLowerCase() !== 'v' || event.altKey) return false
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}
