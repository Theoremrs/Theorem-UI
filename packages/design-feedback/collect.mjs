/**
 * A bounded DOM observation adapter. Keep every dependency inside this function:
 * callers also run its source in a sandbox frame or with Playwright evaluate.
 * Measurements describe this render, not token intent or a full a11y audit.
 */
export function collectDesignObservations(options = {}) {
  const limit = (value, fallback, maximum) =>
    Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback
  const maxElements = limit(options.maxElements, 1000, 5000)
  const maxNodes = limit(options.maxNodes, 10000, 50000)
  const maxTextLength = limit(options.maxTextLength, 160, 2000)
  const captureId = String(options.captureId ?? `capture-${Date.now()}`).slice(0, 256)
  const evidenceKind = options.evidenceKind === 'rendered-artifact'
    ? 'rendered-artifact' : 'rendered-web'
  const limitations = new Set([
    'DOM styles and geometry do not prove complete accessibility or visual quality.',
    'Requested font-family is recorded; the actual face used for each glyph is not identified.',
    'Occlusion, pseudo-element text, shadow-root contents, image/canvas contents and nested frames are not inspected.',
    'Form values, placeholder text and generated content are not included in direct-text contrast checks.',
    'Selector identities may change when document structure changes; prefer unique data-design-id attributes.',
  ])
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  if (!segmenter) limitations.add('Intl.Segmenter is unavailable; reading-measure grapheme counts are not measured.')
  const colorScheme = ['light', 'dark'].includes(options.colorScheme) ? options.colorScheme
    : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  // What the embedding page paints behind a transparent document, resolved to
  // the browser's own computed form. Without it, text with no opaque
  // background of its own has an unresolved contrast.
  let canvas = null
  if (typeof options.canvas === 'string' && options.canvas.length <= 256 && CSS.supports('color', options.canvas)) {
    const probe = document.createElement('span')
    probe.style.color = options.canvas
    document.documentElement.append(probe)
    canvas = getComputedStyle(probe).color
    probe.remove()
    limitations.add('Text with no opaque background of its own is measured against the colour the embedding page paints behind the document.')
  }
  const bounded = (value, length = 512) => String(value ?? '').slice(0, length)
  const cssEscape = (value) => CSS.escape(String(value))
  const styleCache = new Map()
  const styleOf = (element) => {
    if (!styleCache.has(element)) styleCache.set(element, getComputedStyle(element))
    return styleCache.get(element)
  }
  const asRect = (box) => ({ x: box.x, y: box.y, width: box.width, height: box.height })
  const alphaOf = (value) => {
    if (value === 'transparent') return 0
    const match = value.match(/^rgba?\(([^)]+)\)$/i)
    if (!match) return null
    const components = match[1].replace('/', ',').split(/[\s,]+/).filter(Boolean)
    if (components.length === 3) return 1
    if (components.length === 4) {
      const alpha = Number.parseFloat(components[3]) / (components[3].endsWith('%') ? 100 : 1)
      return Number.isFinite(alpha) ? alpha : null
    }
    return null
  }
  const selectorOf = (element) => {
    for (const attribute of ['data-design-id', 'data-testid', 'id']) {
      const value = element.getAttribute(attribute)
      if (!value) continue
      const selector = `[${attribute}="${cssEscape(value)}"]`
      if (selector.length <= 512 && `${attribute}:${value}`.length <= 1024 && document.querySelectorAll(selector).length === 1)
        return { id: `${attribute}:${value}`, selector, identity: 'explicit' }
    }
    const parts = []
    let current = element
    while (current && current !== document.documentElement) {
      let index = 1
      let sibling = current.previousElementSibling
      while (sibling) {
        if (sibling.localName === current.localName) index++
        sibling = sibling.previousElementSibling
      }
      parts.unshift(`${cssEscape(current.localName)}:nth-of-type(${index})`)
      current = current.parentElement
    }
    const selector = ['html', ...parts].join(' > ')
    if (selector.length > 512) return null
    return { id: `selector:${selector}`, selector, identity: 'selector' }
  }
  const paintOf = (element, foreground, textBounds) => {
    const reasons = new Set()
    let background = null
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml') reasons.add('Non-HTML glyph paint is outside this adapter.')
    if (alphaOf(foreground) !== 1) reasons.add('Foreground is not opaque sRGB.')
    const ownStyle = styleOf(element)
    if (ownStyle.webkitTextFillColor && ownStyle.webkitTextFillColor !== foreground)
      reasons.add('Text fill differs from color; the actual glyph paint needs review.')
    if (Number.parseFloat(ownStyle.webkitTextStrokeWidth) > 0)
      reasons.add('Text stroke affects glyph contrast.')
    for (let current = element; current; current = current.parentElement) {
      const style = styleOf(current)
      if (Number(style.opacity) !== 1) reasons.add('Element or ancestor has opacity.')
      if (style.filter !== 'none') reasons.add('Element or ancestor has a filter.')
      if (style.backdropFilter && style.backdropFilter !== 'none') reasons.add('Backdrop filtering affects paint.')
      if (style.mixBlendMode !== 'normal') reasons.add('Blend mode affects paint.')
      if (style.maskImage && style.maskImage !== 'none') reasons.add('A mask affects paint.')
      if (style.zoom && Number(style.zoom) !== 1) reasons.add('CSS zoom changes effective text size.')
      if (style.scale && !['none', '1', '1 1', '1 1 1'].includes(style.scale)) reasons.add('CSS scale changes effective text size.')
      if (style.transform !== 'none') {
        const matrix = new DOMMatrixReadOnly(style.transform)
        if (!matrix.is2D || Math.abs(Math.hypot(matrix.a, matrix.b) - 1) > 0.0001 || Math.abs(Math.hypot(matrix.c, matrix.d) - 1) > 0.0001)
          reasons.add('A transform changes effective text size or requires 3D paint inspection.')
      }
      if (style.textShadow !== 'none') reasons.add('Text shadow is outside this contrast measurement.')
      for (const pseudo of ['::before', '::after']) {
        const painted = getComputedStyle(current, pseudo)
        if (!['none', 'normal', ''].includes(painted.content) && painted.display !== 'none')
          reasons.add('Pseudo-element paint needs visual inspection.')
      }
      for (const pseudo of ['::first-line', '::first-letter']) {
        const painted = getComputedStyle(current, pseudo)
        const glyphProperties = ['color', 'webkitTextFillColor', 'webkitTextStrokeWidth', 'textShadow', 'fontSize', 'fontWeight']
        if (glyphProperties.some((property) => painted[property] !== style[property]) ||
          painted.backgroundImage !== 'none' || alphaOf(painted.backgroundColor) !== 0)
          reasons.add('Styled ::first-line or ::first-letter glyphs need visual inspection.')
      }
      if (background === null) {
        if (/\binset\b/.test(style.boxShadow)) reasons.add('An inset box shadow affects the text background.')
        if (style.backgroundImage !== 'none') reasons.add('Background image or gradient needs pixel sampling.')
        const alpha = alphaOf(style.backgroundColor)
        if (alpha === 1) {
          background = style.backgroundColor
          // An ancestor's background color does not extend to overflowing or
          // positioned descendants. The root canvas is special; other boxes
          // must contain the observed glyph bounds before they can supply paint.
          if (current !== document.documentElement && textBounds) {
            const paintedBox = current.getBoundingClientRect()
            if (textBounds.left < paintedBox.left - 0.5 || textBounds.right > paintedBox.right + 0.5 ||
              textBounds.top < paintedBox.top - 0.5 || textBounds.bottom > paintedBox.bottom + 0.5)
              reasons.add('Text extends outside the opaque background box; the paint behind it is unresolved.')
          }
          if (style.backgroundClip !== 'border-box') reasons.add('Background clipping needs visual inspection.')
        }
        else if (alpha !== 0) reasons.add('Background is not transparent or opaque sRGB.')
      }
    }
    if (background === null) {
      if (canvas !== null && alphaOf(canvas) === 1) background = canvas
      else reasons.add('No explicit opaque background; the canvas or embedding page supplies it.')
    }
    return { background, paintStatus: reasons.size ? 'unknown' : 'resolved', paintReasons: [...reasons] }
  }
  const directText = (element) => [...element.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE && /\S/.test(node.textContent ?? ''))
  const textOf = (element, style) => {
    const nodes = directText(element)
    if (!nodes.length) return undefined
    const value = nodes.map((node) => node.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim()
    if (!value) return undefined
    const tops = []
    let textBounds = null
    for (const node of nodes) {
      const range = document.createRange()
      range.selectNodeContents(node)
      for (const rect of range.getClientRects()) {
        if (rect.width > 0 && rect.height > 0) {
          if (!tops.some((top) => Math.abs(top - rect.top) < 0.5)) tops.push(rect.top)
          textBounds = textBounds ? {
            left: Math.min(textBounds.left, rect.left), right: Math.max(textBounds.right, rect.right),
            top: Math.min(textBounds.top, rect.top), bottom: Math.max(textBounds.bottom, rect.bottom),
          } : { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
        }
      }
    }
    const sampled = value.slice(0, maxTextLength)
    const measured = value.slice(0, 8192)
    // Bounds are intentional: no per-glyph layout loop over untrusted content.
    const graphemeCount = segmenter ? [...segmenter.segment(measured)].length : 0
    const readingMeasureEligible = Boolean(segmenter) && !element.children.length && value.length <= 8192 && style.writingMode === 'horizontal-tb'
    const lineHeight = Number.parseFloat(style.lineHeight)
    const fontWeight = Number.parseFloat(style.fontWeight)
    return {
      value: sampled,
      complete: value.length <= maxTextLength,
      fontSize: Number.parseFloat(style.fontSize) || 0,
      fontWeight: Number.isFinite(fontWeight) ? fontWeight : style.fontWeight === 'bold' ? 700 : 400,
      fontFamily: bounded(style.fontFamily),
      lineHeight: Number.isFinite(lineHeight) ? lineHeight : null,
      color: bounded(style.color, 256),
      ...paintOf(element, style.color, textBounds),
      lineCount: tops.length,
      graphemeCount,
      readingMeasureEligible,
      averageGraphemesPerLine: tops.length && readingMeasureEligible ? graphemeCount / tops.length : null,
    }
  }
  // How the in-flow items of a wrapping row container fall into rows: a row
  // ends where an item starts below every item before it.
  const wrapOf = (element, style) => {
    const flex = ['flex', 'inline-flex'].includes(style.display)
    const grid = ['grid', 'inline-grid'].includes(style.display)
    if (!(flex && ['row', 'row-reverse'].includes(style.flexDirection) && style.flexWrap !== 'nowrap') && !grid) return undefined
    const rows = []
    let bottom = -Infinity
    for (const child of element.children) {
      const childStyle = styleOf(child)
      if (childStyle.display === 'none' || ['absolute', 'fixed'].includes(childStyle.position)) continue
      const box = child.getBoundingClientRect()
      if (!(box.width > 0 && box.height > 0)) continue
      if (!rows.length || box.top >= bottom - 0.5) {
        if (rows.length >= 64) return undefined
        rows.push(0)
        bottom = box.bottom
      } else bottom = Math.max(bottom, box.bottom)
      rows[rows.length - 1]++
    }
    return rows.length > 1 ? { kind: flex ? 'flex' : 'grid', rows } : undefined
  }
  const elements = []
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT)
  let nodesSeen = 0
  let omitted = 0
  let node = walker.currentNode
  while (node && nodesSeen < maxNodes) {
    nodesSeen++
    const element = node
    node = walker.nextNode()
    if (['script', 'style', 'meta', 'link', 'title', 'head', 'noscript', 'template'].includes(element.localName)) continue
    const style = styleOf(element)
    if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0) continue
    // A transparent ancestor makes every descendant invisible even if their
    // own computed opacity is one. Hidden attribute alone is not sufficient.
    let ancestorVisible = true
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (Number(styleOf(ancestor).opacity) === 0) { ancestorVisible = false; break }
    }
    if (!ancestorVisible) continue
    const box = element.getBoundingClientRect()
    if (!(box.width > 0 && box.height > 0)) {
      if (style.display === 'contents' && directText(element).some((text) => {
        const range = document.createRange()
        range.selectNodeContents(text)
        return [...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)
      })) {
        omitted++
        limitations.add('Visible direct text in display: contents has no element box and was not measured.')
      }
      continue
    }
    if (elements.length >= maxElements) { omitted++; continue }
    const identity = selectorOf(element)
    if (!identity) { omitted++; limitations.add('An element selector exceeded the supported length.'); continue }
    const interactive = element.matches('button, input:not([type="hidden"]), select, textarea, a[href], summary, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="switch"], [tabindex]')
    const disabled = Boolean(element.closest(':disabled, [aria-disabled="true"]'))
    const text = textOf(element, style)
    const source = element.closest('[data-theorem-source]')?.getAttribute('data-theorem-source')
    const overflowX = element.scrollWidth > element.clientWidth + 1
    const overflowY = element.scrollHeight > element.clientHeight + 1
    const overflow = element.clientWidth > 0 && element.clientHeight > 0 ? {
      x: overflowX,
      y: overflowY,
      scrollableX: ['auto', 'scroll'].includes(style.overflowX),
      scrollableY: ['auto', 'scroll'].includes(style.overflowY),
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
    } : undefined
    const wrap = wrapOf(element, style)
    const observation = {
      ...identity,
      tag: element.localName,
      rect: { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height },
      viewportRect: asRect(box),
      interactive,
      disabled,
      ...(element.getAttribute('role') ? { role: bounded(element.getAttribute('role'), 80) } : {}),
      ...(interactive ? { name: bounded(element.getAttribute('aria-label') || element.getAttribute('title') || element.textContent, 160).replace(/\s+/g, ' ').trim() } : {}),
      ...(source ? { source: bounded(source) } : {}),
      ...(text ? { text } : {}),
      ...(overflow ? { overflow } : {}),
      ...(wrap ? { wrap } : {}),
    }
    elements.push(observation)
  }
  const scanLimited = node !== null
  if (scanLimited) limitations.add('DOM scan limit reached; omitted is a lower bound because remaining nodes were not scanned.')
  if (omitted) limitations.add('Collection limits, unsupported geometry or selector length omitted visible elements.')
  const root = document.documentElement
  const body = document.body
  return {
    schemaVersion: 'design-feedback/v1',
    capture: {
      id: captureId,
      url: bounded(location.href, 1024),
      timestamp: new Date().toISOString(),
      evidenceKind,
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      scroll: { x: scrollX, y: scrollY },
      document: {
        width: Math.max(root.scrollWidth, body?.scrollWidth ?? 0, innerWidth),
        height: Math.max(root.scrollHeight, body?.scrollHeight ?? 0, innerHeight),
      },
      colorScheme,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      fontsStatus: document.fonts?.status ?? 'unavailable',
    },
    elements,
    coverage: { nodesSeen, elementsMeasured: elements.length, omitted, complete: !scanLimited && omitted === 0, limitations: [...limitations] },
  }
}
