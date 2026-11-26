import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

export async function writeJSON(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function page(title, content) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;margin:0;background:#f5f5f5;color:#171717}main{max-width:1280px;margin:auto;padding:28px}h1,h2{line-height:1.2}a{color:#174ea6}figure{margin:0}img{max-width:100%;height:auto;border:1px solid #aaa;background:white}figcaption{padding:8px 0;font-weight:650}.panels{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}table{border-collapse:collapse;width:100%;background:white}th,td{padding:10px;text-align:left;border-bottom:1px solid #ddd;vertical-align:top}code,pre{overflow-wrap:anywhere;white-space:pre-wrap}small{color:#525252}.note{background:#fff;padding:16px;border-left:4px solid #585858}@media(max-width:700px){.panels{grid-template-columns:1fr}main{padding:16px}table{font-size:14px}}</style><main>${content}</main></html>`
}

export async function writeCaptureReport(out, observation, result) {
  const findings = result.findings ?? []
  const actionable = findings.filter((finding) => finding.status !== 'pass')
  const rows = actionable.map((finding) => `<tr><td>${escapeHTML(finding.status)}<br><small>${escapeHTML(finding.authority)}</small></td><td><strong>${escapeHTML(finding.rule)}</strong><br><code>${escapeHTML(finding.selector ?? finding.elementId ?? 'document')}</code></td><td>${escapeHTML(finding.message)}${finding.repair ? `<br><small>${escapeHTML(finding.repair)}</small>` : ''}<details><summary>Measured evidence</summary><pre>${escapeHTML(JSON.stringify({ measured: finding.measured, expected: finding.expected }, null, 2))}</pre></details></td></tr>`).join('')
  await writeFile(join(out, 'report.html'), page('Design feedback capture', `<h1>Design feedback</h1><p>${escapeHTML(observation.capture?.url ?? '')}</p><p class="note">These checks cover measured DOM properties. They do not establish accessibility conformance or judge visual quality. Unknown and omitted evidence needs review.</p><p><a href="observations.json">Observations</a> · <a href="findings.json">Findings</a> · <a href="capture.json">Capture metadata</a></p><pre>${escapeHTML(JSON.stringify(result.summary ?? {}, null, 2))}</pre><h2>Findings requiring attention</h2>${rows ? `<table><thead><tr><th>Status</th><th>Check and element</th><th>Evidence and repair</th></tr></thead><tbody>${rows}</tbody></table>` : '<p>No non-pass findings were emitted for the measured checks. See coverage before drawing conclusions.</p>'}<h2>Coverage</h2><pre>${escapeHTML(JSON.stringify(result.coverage ?? observation.coverage ?? {}, null, 2))}</pre><h2>Captured viewport</h2><img src="screenshot.png" alt="Browser-rendered viewport at capture time">`))
}

export async function writeComparisonReport(out, result) {
  const incompatible = result.compatibility?.reasons ?? []
  const panels = result.images ? `<div class="panels"><figure><figcaption>Before</figcaption><img src="before.png" alt="Before capture"></figure><figure><figcaption>After</figcaption><img src="after.png" alt="After capture"></figure><figure><figcaption>Difference: magenta indicates change</figcaption><img src="heatmap.png" alt="Perceptual difference heatmap"></figure></div><p><a href="collage.png">Three-panel PNG</a> · <a href="raw-diff.png">Exact pixel difference map, including antialiasing changes</a></p>` : '<p>No heatmap was produced because capture conditions or evidence integrity are incompatible.</p>'
  await writeFile(join(out, 'report.html'), page('Design feedback comparison', `<h1>Design comparison</h1><p class="note">Changed pixels show a difference, not a regression. Geometry changes help distinguish movement from changes within an element. This report does not assign a design-quality score.</p><p><a href="comparison.json">Full comparison JSON</a></p>${incompatible.length ? `<h2>Comparison conditions differ</h2><ul>${incompatible.map((reason) => `<li>${escapeHTML(reason)}</li>`).join('')}</ul>` : '<p>Recorded comparison conditions match.</p>'}${panels}<h2>Pixel evidence</h2><pre>${escapeHTML(JSON.stringify(result.pixels ?? {}, null, 2))}</pre><h2>Element geometry</h2><pre>${escapeHTML(JSON.stringify(result.geometry ?? {}, null, 2))}</pre><h2>Coverage</h2><pre>${escapeHTML(JSON.stringify(result.coverage ?? {}, null, 2))}</pre>`))
}

export async function writeProbeReport(out, result) {
  const runs = result.runs.map((run) => `<li><a href="${escapeHTML(run.directory)}/report.html">${escapeHTML(run.name)}</a>: ${escapeHTML(run.description)}</li>`).join('')
  await writeFile(join(out, 'report.html'), page('Design feedback probes', `<h1>Design probes</h1><p class="note">These are controlled rendering experiments. A successful run means the experiment completed, not that the interface passed an accessibility standard. Text spacing and viewport changes can reveal clipping; motion counts do not establish motion safety.</p><ul>${runs}</ul><p><a href="probes.json">Probe evidence</a></p><pre>${escapeHTML(JSON.stringify(result.findings, null, 2))}</pre>`))
}
