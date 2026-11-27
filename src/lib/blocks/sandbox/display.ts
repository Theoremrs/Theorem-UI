// SOURCING: react-dom/client (React elements a block displays render into
// their own root), object-inspect (any other value shown as text), and the
// platform's ResizeObserver and MutationObserver (the frame reports its
// height, and a static copy of itself, to the page).
import inspect from 'object-inspect'
import { isValidElement } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { Display } from './cell'
import { outlineOf } from './outline'
import {
  MAX_PAGE_ATTRIBUTES,
  MAX_SNAPSHOT,
  PAGE_ATTRIBUTE,
  TRANSPARENT,
} from './protocol'
import type { PageAttributes } from './protocol'

/** Shows displayed values in `container`, each in its own element. */
export function createDisplay(container: HTMLElement): Display {
  const roots: Array<Root> = []
  return {
    show(value) {
      const holder = document.createElement('div')
      holder.className = 'theorem-display'
      container.append(holder)
      if (isValidElement(value)) {
        const root = createRoot(holder)
        root.render(value as ReactNode)
        roots.push(root)
      } else if (value instanceof Node) {
        holder.append(value)
      } else {
        const pre = document.createElement('pre')
        pre.textContent =
          typeof value === 'string' ? value : inspect(value, { depth: 4 })
        holder.append(pre)
      }
    },
    clear() {
      for (const root of roots.splice(0)) root.unmount()
      container.replaceChildren()
    },
  }
}

const SNAPSHOT_DELAY_MS = 400

/**
 * The page as static HTML: its style elements and a copy of its body, with
 * form state written into attributes (it lives in properties), canvases as
 * images, no scripts, and nothing the page does not display. The page
 * sanitizes it again before showing it.
 * Pictures of canvases are most of a large copy: past MAX_SNAPSHOT they are
 * left out, blank at their size, until the rest fits: first a canvas hidden
 * from assistive technology (decoration, such as glass over a scene), then
 * the largest.
 */
export function snapshotHtml(): string {
  const copy = document.body.cloneNode(true) as HTMLElement
  const pictures: Array<{ image: HTMLImageElement; decoration: boolean }> = []
  const live = document.body.querySelectorAll('input, textarea, select, canvas')
  const copies = copy.querySelectorAll('input, textarea, select, canvas')
  live.forEach((element, index) => {
    const target = copies[index]
    if (!target) return
    if (element instanceof HTMLInputElement) {
      target.toggleAttribute('checked', element.checked)
      target.setAttribute('value', element.value)
    } else if (element instanceof HTMLTextAreaElement) {
      target.textContent = element.value
    } else if (element instanceof HTMLSelectElement) {
      for (const [i, option] of [
        ...(target as HTMLSelectElement).options,
      ].entries())
        option.toggleAttribute('selected', i === element.selectedIndex)
    } else if (element instanceof HTMLCanvasElement) {
      const image = document.createElement('img')
      image.width = element.width
      image.height = element.height
      try {
        image.src = element.toDataURL()
      } catch {
        // A canvas that drew something it may not read back stays blank.
      }
      pictures.push({ image, decoration: element.closest('[aria-hidden="true"]') !== null })
      target.replaceWith(image)
    }
  })
  leaveOutUndisplayed(document.body, copy)
  for (const script of copy.querySelectorAll('script')) script.remove()
  const styles = [...document.querySelectorAll('style')]
    .map((style) => style.outerHTML)
    .join('')
  let html = styles + copy.innerHTML
  pictures.sort((a, b) => Number(b.decoration) - Number(a.decoration) || b.image.src.length - a.image.src.length)
  for (const { image } of pictures) {
    if (html.length <= MAX_SNAPSHOT) break
    image.removeAttribute('src')
    html = styles + copy.innerHTML
  }
  return html
}

/**
 * Takes out of `copy` what `live` does not display: `hidden`, as the outline
 * reads it, or `display: none`. A copy is read without its page's styles, so a
 * fallback the App hides ("WebGL2 unavailable") would otherwise read as shown.
 * What is only invisible keeps its box, and stays. Style elements stay: they
 * style what is left. An SVG stays whole: what its defs hold has no box of its
 * own, and a gradient taken out would change it.
 */
function leaveOutUndisplayed(live: Element, copy: Element) {
  const shown = live.children
  const copied = copy.children
  // From the end, so taking one out leaves the earlier pairs aligned.
  for (let index = copied.length - 1; index >= 0; index--) {
    const element = shown[index]
    const target = copied[index]
    if (!element || !target || element.localName === 'style') continue
    if (element.hasAttribute('hidden') || getComputedStyle(element).display === 'none')
      target.remove()
    else if (element instanceof HTMLElement && element.localName !== 'canvas')
      leaveOutUndisplayed(element, target)
  }
}

/**
 * The page as it is now: a snapshot and its outline, or null when the copy is
 * too large to send. The outline is read from the live page, which knows what
 * a copy cannot: what is hidden, what a field holds, what is checked.
 */
export function lookNow(): {
  html: string
  outline: string
  page: PageAttributes
} | null {
  const html = snapshotHtml()
  if (html.length > MAX_SNAPSHOT) return null
  return { html, outline: outlineOf(document.body), page: pageAttributes() }
}

function carried(element: Element): Record<string, string> {
  const attributes: Record<string, string> = {}
  for (const { name, value } of element.attributes)
    if (PAGE_ATTRIBUTE.test(name)) attributes[name] = value
  return attributes
}

/**
 * What the root and the body carry that CSS reads. Left empty when it is more
 * than a page takes, so the copy is still sent.
 */
export function pageAttributes(): PageAttributes {
  const painted = (element: Element) => {
    const colour = getComputedStyle(element).backgroundColor
    return colour && !TRANSPARENT.test(colour) ? colour : undefined
  }
  const background = painted(document.documentElement)
    ? undefined
    : painted(document.body)
  const page: PageAttributes = {
    root: carried(document.documentElement),
    body: carried(document.body),
    ...(background ? { background } : {}),
  }
  return JSON.stringify(page).length > MAX_PAGE_ATTRIBUTES
    ? { root: {}, body: {} }
    : page
}

/**
 * Calls `report` with a snapshot of the page once it settles after a change,
 * for the page to show where a live frame would cost too much (a canvas card
 * far out).
 */
export function observeSnapshots(
  report: (html: string, outline: string) => void,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const take = () => {
    const seen = lookNow()
    if (seen) report(seen.html, seen.outline)
  }
  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(take, SNAPSHOT_DELAY_MS)
  }
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })
  document.addEventListener('input', schedule, true)
  document.addEventListener('change', schedule, true)
  schedule()
}

/**
 * Calls `report` with the document's height whenever it changes. The page's
 * box height keeps fractions, where scrollHeight rounds 186.4px down to 186
 * and the frame would scroll for the rest. scrollHeight never reads less than
 * the frame either, so a page that got shorter would keep its old height; it
 * counts only when the page overflows its box.
 *
 * A page laid out by its viewport (100vh, or height: 100% down from the root)
 * has no height of its own, and `fills` says so: the page then gives it one.
 * Such a page either has a box exactly the frame it loaded in, whether its
 * content fits that box or overflows it (a 100vh grid whose side column needs
 * more than the first frame squeezes the rest of the grid to nothing), or
 * outgrows every frame it is given (62vh + 38vh under a caption, in a body
 * with margins, is always the caption and the margins taller), so it is known
 * by growing when nothing but its frame changed. Its root and body do not
 * resize as its content arrives, so content changes are measured too.
 *
 * A page that fills its frame goes on being measured: laid out by its
 * viewport, its box is any frame the host gives it, so resizing the frame
 * changes nothing it reports. A page whose box is any other height only
 * happened to fit its first frame, and goes back to its content height.
 */
export function observeHeight(
  report: (height: number, fills?: boolean) => void,
): void {
  let last = -1
  let outgrew = 0
  let following = true
  let filling = false
  const initial = window.innerHeight
  const measure = (resized = false) => {
    if (!following) return
    const root = document.documentElement
    const box = root.getBoundingClientRect().height
    const overflows = root.scrollHeight > window.innerHeight
    const height = Math.ceil(overflows ? root.scrollHeight : box)
    // Its box is its frame: laid out by the viewport, not by its content.
    const framed = Math.round(box) === window.innerHeight
    if (filling) {
      if (framed) return
      filling = false
      report((last = height))
      return
    }
    if (framed && overflows && window.innerHeight === initial) {
      filling = true
      report((last = height), true)
      return
    }
    if (resized && window.innerHeight === last) {
      // Twice taller than a frame just sized to it: it follows its frame.
      outgrew = height > last ? outgrew + 1 : 0
      if (outgrew >= 2) {
        following = false
        report(last, true)
        return
      }
    }
    if (height !== last) report((last = height))
  }
  let queued = false
  const changed = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      measure()
    })
  }
  const observer = new ResizeObserver(() => measure())
  observer.observe(document.documentElement)
  new MutationObserver(changed).observe(document.documentElement, {
    subtree: true,
    childList: true,
  })
  window.addEventListener('resize', () => measure(true))
  const settled = () => {
    if (document.body) observer.observe(document.body)
    measure()
    // Loaded and exactly as tall as the frame it started in: it fills it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (following && !filling && window.innerHeight === initial && last === initial) {
          filling = true
          report(last, true)
        }
      }),
    )
  }
  if (document.readyState === 'complete') settled()
  else window.addEventListener('load', settled, { once: true })
  measure()
}

/**
 * Marks the cell a selection names, and only that one, so the highlight shows
 * what the page will refer to. A selection outside every cell marks none.
 */
export function markSelectedCell(cell: Element | null | undefined): void {
  for (const marked of document.querySelectorAll(
    '[data-cell-id][data-selected]',
  ))
    if (marked !== cell) marked.removeAttribute('data-selected')
  cell?.setAttribute('data-selected', '')
}
