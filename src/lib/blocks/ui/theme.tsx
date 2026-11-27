// SOURCING: Astryx's own token names (`@astryxdesign/theme-neutral`), drawn
// from the frame's `--theorem-*` variables in theme.css, so Astryx controls in
// an App wear the page's colours, font and radius and follow its mode.
import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import './theme.css'

/** An element whose descendants draw Astryx components in Theorem's theme. */
export const Theme = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function Theme(
  { className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      data-astryx-theme="neutral"
      className={['tn-theme', className].filter(Boolean).join(' ')}
      {...rest}
    />
  )
})
