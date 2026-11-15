// Design-oracle capture for the right-hand terminal host (Cabinet + Terminal tabs).
const { chromium } = require('playwright')
const fs = require('fs')
const projectId = process.argv[2]
const BASE = 'http://localhost:3000'
const out = __dirname + '/'
;(async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1536, height: 1000 } })
  await page.goto(`${BASE}/projects/${projectId}`, { waitUntil: 'networkidle' })
  if (!(await page.locator('[data-artifact-cabinet]').count()))
    await page.getByRole('button', { name: /^Gallery$/ }).first().click()
  await page.waitForFunction(() => document.querySelectorAll('[data-cabinet-card]').length >= 2, null, { timeout: 30000 })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(2000)
  await page.screenshot({ path: out + 'cabinet.png', clip: { x: 1080, y: 0, width: 456, height: 1000 } })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
  async function faces(selector) {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector })
    const seen = {}
    for (const id of nodeIds.slice(0, 400)) {
      try { const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: id }); for (const f of fonts) seen[f.postScriptName || f.familyName] = (seen[f.postScriptName || f.familyName] || 0) + f.glyphCount } catch {}
    }
    return seen
  }
  const probe = (rootSel) => page.evaluate((rootSel) => {
    const root = document.querySelector(rootSel)
    const cs = getComputedStyle(root)
    // Every leaf element with text inside the drawn grid.
    const leaves = [...root.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim())
    const weights = {}, sizes = {}, pairs = {}
    const rgb = (c) => c
    for (const e of leaves) {
      const s = getComputedStyle(e)
      const n = e.textContent.trim().length
      weights[s.fontWeight] = (weights[s.fontWeight] || 0) + n
      sizes[s.fontSize] = (sizes[s.fontSize] || 0) + n
      // Background: first ancestor with a non-transparent background.
      let b = e, bg = 'rgba(0, 0, 0, 0)'
      while (b && (bg = getComputedStyle(b).backgroundColor) === 'rgba(0, 0, 0, 0)') b = b.parentElement
      const k = s.color + ' on ' + bg
      pairs[k] = (pairs[k] || 0) + n
    }
    const line = leaves.find((e) => e.textContent.trim())
    const lr = line && line.getBoundingClientRect()
    return {
      family: cs.fontFamily, size: cs.fontSize, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, weight: cs.fontWeight,
      featureSettings: cs.fontFeatureSettings, variation: cs.fontVariationSettings,
      leafCount: leaves.length, firstLeafHeight: lr && lr.height, weights, sizes, pairs,
    }
  }, rootSel)
  const cabinet = await probe('[data-artifact-cabinet]')
  cabinet.faces = await faces('[data-artifact-cabinet] *')
  // Row geometry: y of each distinct text row in the cabinet with its text.
  cabinet.rows = await page.evaluate(() => {
    const root = document.querySelector('[data-artifact-cabinet]')
    const r0 = root.getBoundingClientRect()
    const rows = {}
    for (const e of root.querySelectorAll('*')) {
      if (e.children.length || !e.textContent.trim()) continue
      const r = e.getBoundingClientRect(); if (!r.height) continue
      const y = Math.round(r.y - r0.y); (rows[y] ||= []).push({ x: Math.round(r.x - r0.x), t: e.textContent })
    }
    return Object.entries(rows).sort((a, b) => a[0] - b[0]).map(([y, cells]) => ({ y: +y, x: Math.min(...cells.map((c) => c.x)), text: cells.sort((a, b) => a.x - b.x).map((c) => c.t).join('').replace(/\s+/g, ' ').trim().slice(0, 70) }))
  })
  // The host header (tabs) and a sans reference in the page.
  const host = await page.evaluate(() => {
    const tab = [...document.querySelectorAll('[role=tab]')].find((b) => b.textContent.trim() === 'Gallery' && b.getAttribute('role') === 'tab')
    const nav = document.querySelector('[data-appearance-width-role="navigation"] a, [data-appearance-width-role="navigation"] button')
    const f = (e) => { if (!e) return null; const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return { family: s.fontFamily, size: s.fontSize, lineHeight: s.lineHeight, weight: s.fontWeight, letterSpacing: s.letterSpacing, h: r.height, padL: s.paddingLeft } }
    const textX = (e) => { if (!e) return null; const r = document.createRange(); r.selectNodeContents(e); const b = r.getBoundingClientRect(); return { x: b.x, w: b.width } }
    const cab = document.querySelector('[data-artifact-cabinet]')
    const titleLeaf = [...cab.querySelectorAll('*')].find((e) => !e.children.length && e.textContent.includes('Artifact'))
    const targets = [...document.querySelectorAll('[aria-label="Filter artifacts"] button, [data-cabinet-search], select[aria-label="Preview style"], [role=tab]')].map((b) => { const r = b.getBoundingClientRect(); return { t: (b.textContent || b.getAttribute('aria-label') || '').trim().slice(0, 14), w: r.width, h: r.height } })
    return { tab: f(tab), navItem: f(nav), tabText: textX(tab), titleText: textX(titleLeaf), cabX: cab.getBoundingClientRect().x, cabW: cab.getBoundingClientRect().width, targets }
  })
  // Terminal tab.
  await page.getByRole('tab', { name: /^Terminal$/ }).first().click()
  await page.waitForTimeout(2500)
  await page.screenshot({ path: out + 'terminal.png', clip: { x: 1080, y: 0, width: 456, height: 1000 } })
  const termSel = await page.evaluate(() => { const e = document.querySelector('.bg-term.font-mono.whitespace-pre'); if (e) e.setAttribute('data-oracle-term', ''); return !!e })
  const terminal = termSel ? await probe('[data-oracle-term]') : null
  if (terminal) terminal.faces = await faces('[data-oracle-term] *')
  fs.writeFileSync(out + 'raw.json', JSON.stringify({ cabinet, host, terminal }, null, 1))
  console.log(JSON.stringify({ cabinet: { ...cabinet, rows: cabinet.rows.length }, host, terminal }, null, 1))
  await browser.close()
})()
