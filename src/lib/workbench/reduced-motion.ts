// SOURCING: the platform's matchMedia('(prefers-reduced-motion: reduce)'), nothing to source; the workbench handle's `set_reduced_motion(bool)` export (terminal/src/workbench.rs) is the receiver, which is why this is not a host message
/** The person's reduced-motion preference, delivered now and again whenever it changes. Returns its stop. */
export function watchReducedMotion(
  apply: (reduced: boolean) => void,
  query: MediaQueryList | null = typeof matchMedia === 'function'
    ? matchMedia('(prefers-reduced-motion: reduce)')
    : null,
): () => void {
  if (!query) return () => {}
  const deliver = () => apply(query.matches)
  deliver()
  query.addEventListener('change', deliver)
  return () => query.removeEventListener('change', deliver)
}
