const VERSION = 'design-feedback/v1'
const bad = (path, reason) => { throw new TypeError(`Invalid design observation ${path}: ${reason}`) }
const record = (value, path) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bad(path, 'expected an object')
  return value
}
const text = (value, path, maximum = 512) => {
  if (typeof value !== 'string' || value.length > maximum) bad(path, `expected a string of at most ${maximum} characters`)
  return value
}
const number = (value, path, minimum = -1e9, maximum = 1e9) => {
  if (!Number.isFinite(value) || value < minimum || value > maximum) bad(path, 'expected a finite bounded number')
  return value
}
const integer = (value, path, maximum) => {
  number(value, path, 0, maximum)
  if (!Number.isInteger(value)) bad(path, 'expected an integer')
}
const boolean = (value, path) => {
  if (typeof value !== 'boolean') bad(path, 'expected a boolean')
}
const choice = (value, allowed, path) => {
  if (!allowed.includes(value)) bad(path, `expected one of ${allowed.join(', ')}`)
}
const rect = (value, path) => {
  record(value, path)
  number(value.x, `${path}.x`)
  number(value.y, `${path}.y`)
  number(value.width, `${path}.width`, 0)
  number(value.height, `${path}.height`, 0)
}
const strings = (value, path, maximumItems = 32) => {
  if (!Array.isArray(value) || value.length > maximumItems) bad(path, 'expected a bounded string array')
  value.forEach((entry, index) => text(entry, `${path}[${index}]`))
}

/** Validate untrusted JSON before arithmetic, matching or copying into a report. */
export function validateObservation(input) {
  record(input, '$')
  if (input.schemaVersion !== VERSION) bad('schemaVersion', `expected ${VERSION}`)
  const capture = record(input.capture, 'capture')
  text(capture.id, 'capture.id', 256)
  text(capture.url, 'capture.url', 1024)
  text(capture.timestamp, 'capture.timestamp', 80)
  choice(capture.evidenceKind, ['rendered-web', 'rendered-artifact', 'fixture'], 'capture.evidenceKind')
  record(capture.viewport, 'capture.viewport')
  number(capture.viewport.width, 'capture.viewport.width', 1, 100000)
  number(capture.viewport.height, 'capture.viewport.height', 1, 100000)
  number(capture.viewport.dpr, 'capture.viewport.dpr', 0.01, 100)
  record(capture.scroll, 'capture.scroll')
  number(capture.scroll.x, 'capture.scroll.x')
  number(capture.scroll.y, 'capture.scroll.y')
  record(capture.document, 'capture.document')
  number(capture.document.width, 'capture.document.width', 0)
  number(capture.document.height, 'capture.document.height', 0)
  choice(capture.colorScheme, ['light', 'dark'], 'capture.colorScheme')
  boolean(capture.reducedMotion, 'capture.reducedMotion')
  choice(capture.fontsStatus, ['loaded', 'loading', 'unavailable'], 'capture.fontsStatus')
  if (!Array.isArray(input.elements) || input.elements.length > 5000) bad('elements', 'expected at most 5000 elements')
  const ids = new Set()
  for (const [index, element] of input.elements.entries()) {
    const path = `elements[${index}]`
    record(element, path)
    text(element.id, `${path}.id`, 1024)
    if (!element.id || ids.has(element.id)) bad(`${path}.id`, 'expected a unique nonempty identity')
    ids.add(element.id)
    text(element.selector, `${path}.selector`)
    text(element.tag, `${path}.tag`, 80)
    choice(element.identity, ['explicit', 'selector'], `${path}.identity`)
    if (element.role !== undefined) text(element.role, `${path}.role`, 80)
    if (element.name !== undefined) text(element.name, `${path}.name`, 160)
    if (element.source !== undefined) text(element.source, `${path}.source`)
    rect(element.rect, `${path}.rect`)
    rect(element.viewportRect, `${path}.viewportRect`)
    boolean(element.interactive, `${path}.interactive`)
    boolean(element.disabled, `${path}.disabled`)
    if (element.text !== undefined) {
      const t = record(element.text, `${path}.text`)
      text(t.value, `${path}.text.value`, 2000)
      boolean(t.complete, `${path}.text.complete`)
      number(t.fontSize, `${path}.text.fontSize`, 0, 100000)
      number(t.fontWeight, `${path}.text.fontWeight`, 1, 1000)
      text(t.fontFamily, `${path}.text.fontFamily`)
      if (t.lineHeight !== null) number(t.lineHeight, `${path}.text.lineHeight`, 0, 100000)
      text(t.color, `${path}.text.color`, 256)
      if (t.background !== null) text(t.background, `${path}.text.background`, 256)
      choice(t.paintStatus, ['resolved', 'unknown'], `${path}.text.paintStatus`)
      strings(t.paintReasons, `${path}.text.paintReasons`)
      integer(t.lineCount, `${path}.text.lineCount`, 1000000)
      integer(t.graphemeCount, `${path}.text.graphemeCount`, 8192)
      if (t.readingMeasureEligible !== undefined) boolean(t.readingMeasureEligible, `${path}.text.readingMeasureEligible`)
      if (t.averageGraphemesPerLine !== null) number(t.averageGraphemesPerLine, `${path}.text.averageGraphemesPerLine`, 0, 8192)
    }
    if (element.overflow !== undefined) {
      const overflow = record(element.overflow, `${path}.overflow`)
      for (const field of ['x', 'y', 'scrollableX', 'scrollableY']) boolean(overflow[field], `${path}.overflow.${field}`)
      for (const field of ['clientWidth', 'clientHeight', 'scrollWidth', 'scrollHeight']) number(overflow[field], `${path}.overflow.${field}`, 0)
    }
    if (element.wrap !== undefined) {
      const wrap = record(element.wrap, `${path}.wrap`)
      choice(wrap.kind, ['flex', 'grid'], `${path}.wrap.kind`)
      if (!Array.isArray(wrap.rows) || wrap.rows.length < 2 || wrap.rows.length > 64) bad(`${path}.wrap.rows`, 'expected 2 to 64 rows')
      wrap.rows.forEach((count, index) => {
        integer(count, `${path}.wrap.rows[${index}]`, 5000)
        if (!count) bad(`${path}.wrap.rows[${index}]`, 'a row holds at least one item')
      })
    }
  }
  const coverage = record(input.coverage, 'coverage')
  integer(coverage.nodesSeen, 'coverage.nodesSeen', 50000)
  integer(coverage.elementsMeasured, 'coverage.elementsMeasured', 5000)
  integer(coverage.omitted, 'coverage.omitted', 50000)
  if (coverage.elementsMeasured !== input.elements.length) bad('coverage.elementsMeasured', 'must equal elements.length')
  if (coverage.nodesSeen < input.elements.length) bad('coverage.nodesSeen', 'cannot be less than measured elements')
  boolean(coverage.complete, 'coverage.complete')
  if (coverage.complete && coverage.omitted) bad('coverage.complete', 'cannot be complete with omitted elements')
  strings(coverage.limitations, 'coverage.limitations', 64)
  return input
}

function rgb(value) {
  if (typeof value !== 'string') return null
  const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join('') : hex[1]
    return [0, 2, 4].map((index) => Number.parseInt(digits.slice(index, index + 2), 16) / 255)
  }
  const match = value.match(/^rgba?\(([^)]+)\)$/i)
  if (!match) return null
  const values = match[1].replace(/\s*\/\s*/, ',').split(/[\s,]+/).filter(Boolean)
  if (![3, 4].includes(values.length)) return null
  const component = (part, scale) => /^[-+]?\d*\.?\d+(?:e[-+]?\d+)?%?$/i.test(part)
    ? Number.parseFloat(part) / (part.endsWith('%') ? 100 : scale) : NaN
  if (values.length === 4 && component(values[3], 1) !== 1) return null
  const channels = values.slice(0, 3).map((part) => component(part, 255))
  return channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1) ? channels : null
}

/** WCAG 2 relative luminance, opaque sRGB inputs, with no rounded threshold test. */
export function contrastRatio(foreground, background) {
  const front = rgb(foreground), back = rgb(background)
  if (!front || !back) return null
  const luminance = (channels) => channels.map((channel) => channel <= 0.04045
    ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
  const a = luminance(front), b = luminance(back)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function normalizedPolicy(policy) {
  record(policy, 'policy')
  for (const key of Object.keys(policy)) {
    if (!['maxFindings', 'minTargetSize', 'lineHeight', 'readingMeasure'].includes(key))
      bad(`policy.${key}`, 'unsupported policy option')
  }
  const maxFindings = policy.maxFindings ?? 100
  integer(maxFindings, 'policy.maxFindings', 1000)
  if (!maxFindings) bad('policy.maxFindings', 'must be positive')
  const minTargetSize = policy.minTargetSize ?? 24
  number(minTargetSize, 'policy.minTargetSize', 1, 256)
  for (const name of ['lineHeight', 'readingMeasure']) {
    if (policy[name] !== undefined) {
      record(policy[name], `policy.${name}`)
      if (Object.keys(policy[name]).some((key) => key !== 'min' && key !== 'max'))
        bad(`policy.${name}`, 'range supports only min and max')
      number(policy[name].min, `policy.${name}.min`, 0, 2000)
      number(policy[name].max, `policy.${name}.max`, policy[name].min, 2000)
    }
  }
  const range = (value) => value ? { min: value.min, max: value.max } : undefined
  return { maxFindings, minTargetSize, lineHeight: range(policy.lineHeight), readingMeasure: range(policy.readingMeasure) }
}

export function inspectDesign(input, policy = {}) {
  const observation = validateObservation(input)
  const targets = normalizedPolicy(policy)
  const findings = []
  const add = (rule, element, authority, status, measured, expected, message, repair) => {
    findings.push({
      id: `${rule}:${element?.id ?? 'document'}`,
      rule,
      ...(element ? { elementId: element.id, selector: element.selector, ...(element.source ? { source: element.source } : {}) } : {}),
      authority, status,
      severity: status === 'fail' ? 'error' : status === 'pass' ? 'info' : 'warning',
      evidence: { kind: observation.capture.evidenceKind, captureId: observation.capture.id },
      measured, expected, message, ...(repair ? { repair } : {}),
    })
  }
  if (!observation.coverage.complete) add('coverage', null, 'diagnostic', 'unknown',
    { measured: observation.elements.length, omitted: observation.coverage.omitted }, 'Complete requested DOM scan',
    'This report covers only the measured subset; omitted elements are not passing checks.',
    'Inspect a smaller surface or increase bounded collection limits.')
  if (observation.capture.fontsStatus !== 'loaded') add('fonts.ready', null, 'diagnostic', 'unknown',
    observation.capture.fontsStatus, 'document.fonts.status = loaded',
    'Font loading was not settled when geometry was measured.', 'Wait for document.fonts.ready and capture again.')
  const viewport = observation.capture.viewport
  const documentWidth = observation.capture.document.width
  add('layout.document-width', null, 'diagnostic', documentWidth > viewport.width + 1 ? 'review' : 'pass',
    { documentWidth, viewportWidth: viewport.width }, { maximumWithoutHorizontalScroll: viewport.width },
    documentWidth > viewport.width + 1
      ? 'The document is wider than the viewport; review horizontal scrolling and any deliberate wide content.'
      : 'The document fits the measured viewport width.',
    documentWidth > viewport.width + 1 ? 'Locate the overflowing element; contain intentional tables/code or allow surrounding content to reflow.' : undefined)

  for (const element of observation.elements) {
    const t = element.text
    if (t && t.value.trim() && !element.disabled) {
      const threshold = t.fontSize >= 24 || (t.fontSize >= 56 / 3 && t.fontWeight >= 700) ? 3 : 4.5
      const ratio = t.paintStatus === 'resolved' && !t.paintReasons.length && t.background ? contrastRatio(t.color, t.background) : null
      const status = ratio === null ? 'unknown' : ratio >= threshold ? 'pass' : 'fail'
      add('color.text-contrast', element, 'standard', status,
        { foreground: t.color, background: t.background, ratio, fontSize: t.fontSize, fontWeight: t.fontWeight, reasons: [...t.paintReasons] },
        { minimumRatio: threshold, standard: 'WCAG 2.2 SC 1.4.3', scope: 'Ordinary active text; exceptions and occlusion require review.' },
        ratio === null ? 'Text contrast cannot be resolved from these DOM paint observations.'
          : status === 'fail' ? `Observed text color pair is below ${threshold}:1.` : `Observed text color pair meets ${threshold}:1.`,
        ratio === null ? 'Inspect the rendered crop or supply reliable paint observations; do not substitute a guessed background.'
          : status === 'fail' ? 'Adjust the text or surface token, then measure the rendered pair again.' : undefined)
      if (targets.lineHeight) {
        const ratio = t.fontSize > 0 && t.lineHeight !== null ? t.lineHeight / t.fontSize : null
        const within = ratio !== null && ratio >= targets.lineHeight.min && ratio <= targets.lineHeight.max
        add('type.line-height', element, 'target', ratio === null ? 'unknown' : within ? 'pass' : 'review',
          { fontSize: t.fontSize, lineHeight: t.lineHeight, ratio }, { ...targets.lineHeight, unit: 'font-size ratio' },
          ratio === null ? 'The browser exposes a normal or unresolved line height.' : 'Line height compared with the selected typography target.',
          !within ? 'Review this text role and choose an appropriate line-height token; the target is not a universal readability standard.' : undefined)
      }
      if (targets.readingMeasure && t.lineCount > 1) {
        const measure = t.readingMeasureEligible === true ? t.averageGraphemesPerLine : null
        const within = measure !== null && measure >= targets.readingMeasure.min && measure <= targets.readingMeasure.max
        add('type.reading-measure', element, 'target', measure === null ? 'unknown' : within ? 'pass' : 'review',
          { averageGraphemesPerLine: measure, directTextOnly: true, includesLastLine: true, eligible: t.readingMeasureEligible === true, completeSnippet: t.complete },
          { ...targets.readingMeasure, unit: 'mean graphemes per rendered line' },
          'Approximate direct-text line measure compared with the selected target; mixed inline text and short final lines affect this value.',
          !within ? 'Inspect the paragraph crop and adjust measure for its language, font and purpose.' : undefined)
      }
    }
    if (element.interactive && !element.disabled) {
      const { width, height } = element.rect
      const within = width >= targets.minTargetSize && height >= targets.minTargetSize
      add('interaction.target-box', element, 'target', within ? 'pass' : 'review',
        { width, height }, { minimumWidth: targets.minTargetSize, minimumHeight: targets.minTargetSize, unit: 'CSS px' },
        within ? 'The measured control box meets the selected size target.'
          : 'The measured control box is smaller than the selected size target; spacing, inline exceptions and the actual hit area need review.',
        within ? undefined : 'Increase the hit area or verify a justified exception; this box check alone does not establish WCAG 2.5.8 conformance.')
    }
    const overflow = element.overflow
    if (overflow && ((overflow.x && !overflow.scrollableX) || (overflow.y && !overflow.scrollableY))) {
      add('layout.content-overflow', element, 'diagnostic', 'review',
        { x: overflow.x, y: overflow.y, scrollableX: overflow.scrollableX, scrollableY: overflow.scrollableY, clientWidth: overflow.clientWidth, clientHeight: overflow.clientHeight, scrollWidth: overflow.scrollWidth, scrollHeight: overflow.scrollHeight }, 'Content fits its box or has an intentional scrolling/overflow treatment.',
        'Content exceeds its measured box on an axis without auto/scroll overflow; visible overflow may be intentional.',
        'Inspect this element for clipping, overlap or inaccessible text before changing dimensions or overflow.')
    }
    const wrap = element.wrap
    if (wrap) {
      // One item left alone on the last row, under rows of several, reads as
      // a leftover rather than a layout.
      const lone = wrap.rows.at(-1) === 1 && wrap.rows.slice(0, -1).some((count) => count > 1)
      add('layout.lone-wrapped-item', element, 'diagnostic', lone ? 'review' : 'pass',
        { kind: wrap.kind, rows: [...wrap.rows], viewportWidth: viewport.width },
        'The last row holds more than one item, or every item fits on one row.',
        lone ? 'One item wrapped onto a row of its own below rows of several.'
          : 'The wrapped rows hold their items without one left alone at the end.',
        lone ? 'Balance the rows (fewer items per row, grid columns that divide the count, or items that grow to fill), or let the row scroll; check the widths the App is shown at.' : undefined)
    }
  }
  const summary = { pass: 0, fail: 0, review: 0, unknown: 0, omitted: 0 }
  for (const finding of findings) summary[finding.status]++
  const priority = { fail: 0, unknown: 1, review: 2, pass: 3 }
  findings.sort((a, b) => priority[a.status] - priority[b.status])
  summary.omitted = Math.max(0, findings.length - targets.maxFindings)
  return {
    schemaVersion: VERSION,
    captureId: observation.capture.id,
    findings: findings.slice(0, targets.maxFindings),
    summary,
    coverage: {
      nodesSeen: observation.coverage.nodesSeen,
      elementsMeasured: observation.coverage.elementsMeasured,
      omitted: observation.coverage.omitted,
      complete: observation.coverage.complete,
      limitations: [...observation.coverage.limitations, 'Contrast results cover observed color pairs, not all WCAG exceptions or the entire page.'],
    },
  }
}

export function compareGeometry(beforeInput, afterInput, options = {}) {
  const before = validateObservation(beforeInput), after = validateObservation(afterInput)
  record(options, 'comparison options')
  const tolerance = options.tolerance ?? 0.5
  number(tolerance, 'comparison tolerance', 0, 100)
  const maxChanges = options.maxChanges ?? 100
  integer(maxChanges, 'comparison maxChanges', 1000)
  if (!maxChanges) bad('comparison maxChanges', 'must be positive')
  const previous = new Map(before.elements.map((element) => [element.id, element]))
  const current = new Map(after.elements.map((element) => [element.id, element]))
  const changes = [], deltas = []
  let matched = 0, added = 0
  for (const [id, element] of current) {
    const old = previous.get(id)
    if (!old) { added++; continue }
    matched++
    const position = { dx: element.rect.x - old.rect.x, dy: element.rect.y - old.rect.y }
    const size = { dw: element.rect.width - old.rect.width, dh: element.rect.height - old.rect.height }
    deltas.push(position)
    const moved = Math.abs(position.dx) > tolerance || Math.abs(position.dy) > tolerance
    const resized = Math.abs(size.dw) > tolerance || Math.abs(size.dh) > tolerance
    if (moved || resized) changes.push({ elementId: id, selector: element.selector, position, size,
      kind: moved && resized ? 'position-and-size' : moved ? 'position' : 'size' })
  }
  const median = (values) => {
    const sorted = values.sort((a, b) => a - b)
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2
  }
  let globalTranslation = null
  if (matched >= 3) {
    const dx = median(deltas.map((delta) => delta.dx)), dy = median(deltas.map((delta) => delta.dy))
    const matchedFraction = deltas.filter((delta) => Math.abs(delta.dx - dx) <= tolerance && Math.abs(delta.dy - dy) <= tolerance).length / matched
    if (matchedFraction >= 0.75 && (Math.abs(dx) > tolerance || Math.abs(dy) > tolerance)) globalTranslation = { dx, dy, matchedFraction }
  }
  const contextChanged = []
  for (const key of ['width', 'height', 'dpr']) if (before.capture.viewport[key] !== after.capture.viewport[key]) contextChanged.push(`viewport.${key}`)
  for (const key of ['colorScheme', 'reducedMotion', 'fontsStatus']) if (before.capture[key] !== after.capture[key]) contextChanged.push(key)
  const limitations = ['Selector-based matches may refer to different semantic content after DOM restructuring.', 'A shared translation is a diagnostic candidate, not an automatic alignment or a quality verdict.']
  if (contextChanged.length) limitations.push('Capture contexts differ; geometry changes may be expected responsive or state behavior.')
  return {
    matched, added, removed: before.elements.length - matched,
    changed: changes.length, unchanged: matched - changes.length,
    omitted: Math.max(0, changes.length - maxChanges),
    changes: changes.slice(0, maxChanges), globalTranslation,
    coverage: { complete: before.coverage.complete && after.coverage.complete, contextChanged, limitations },
  }
}
