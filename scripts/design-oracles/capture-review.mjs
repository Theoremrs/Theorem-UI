#!/usr/bin/env node
// Review captures that name the code they show. Each capture's file name and
// its manifest entry carry the working tree's fingerprint (the HEAD commit
// and a hash of every tracked change and untracked file), so a screenshot
// can be matched to, or ruled out for, the revision under review.
//
// node scripts/design-oracles/capture-review.mjs <url> <out-dir> \
//   [--scale 2] [--width 1440] [--height 900] [--scheme dark|light] \
//   [--wait 2500] [--local key=value ...] [--click css-selector ...] [--key Key ...]
//   [--shot name=css-selector ...]
// --local seeds localStorage before the page loads, such as the appearance
// preset a reviewer has chosen (theorem-ui:appearance), which a fresh profile
// lacks.
// --click and --key run in the order given, after the page settles, to open a
// menu or a submenu before the captures. Without --shot it captures the
// viewport as "page".
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { launchReviewBrowser } from './review-browser.mjs'

const git = (...args) =>
  execFileSync('git', args, { encoding: 'buffer', maxBuffer: 1 << 30 })

/**
 * HEAD plus a hash of the uncommitted tree, as `<short-rev>-<hash>` or
 * `<short-rev>` when clean. `exclude` leaves a directory out (the captures'
 * own, when it lies inside the tree), so writing one capture does not change
 * the fingerprint of the next.
 */
export function workingTreeFingerprint(exclude) {
  const spec = ['--', '.', ...(exclude ? [`:(exclude)${exclude}`] : [])]
  const rev = git('rev-parse', '--short=10', 'HEAD').toString().trim()
  const hash = createHash('sha256')
  const diff = git('diff', 'HEAD', '--binary', ...spec)
  hash.update(diff)
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z', ...spec)
    .toString()
    .split('\0')
    .filter(Boolean)
    .sort()
  for (const file of untracked) {
    hash.update(file)
    hash.update(readFileSync(file))
  }
  const tree =
    diff.length > 0 || untracked.length > 0
      ? hash.digest('hex').slice(0, 10)
      : null
  return { rev, tree, id: tree ? `${rev}-${tree}` : rev }
}

function parse(argv) {
  const [url, out, ...rest] = argv
  if (!url || !out) {
    console.error('usage: capture-review.mjs <url> <out-dir> [options]')
    process.exit(2)
  }
  const options = { url, out, scale: 2, width: 1440, height: 900, scheme: 'dark', wait: 2500, shots: [], steps: [], local: {} }
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]]
    if (flag === '--shot') {
      const at = value.indexOf('=')
      options.shots.push({ name: value.slice(0, at), selector: value.slice(at + 1) })
    } else if (flag === '--local') {
      const at = value.indexOf('=')
      options.local[value.slice(0, at)] = value.slice(at + 1)
    } else if (flag === '--click' || flag === '--key') {
      options.steps.push({ kind: flag.slice(2), value })
    } else if (flag === '--scheme') options.scheme = value
    else options[flag.slice(2)] = Number(value)
  }
  if (options.shots.length === 0) options.shots.push({ name: 'page', selector: null })
  return options
}

const options = parse(process.argv.slice(2))
const root = git('rev-parse', '--show-toplevel').toString().trim()
const outInTree = relative(root, resolve(options.out))
const print = workingTreeFingerprint(
  outInTree.startsWith('..') || isAbsolute(outInTree) ? undefined : outInTree,
)
const { id } = print
mkdirSync(options.out, { recursive: true })
const browser = await launchReviewBrowser()
const page = await browser.newPage({
  viewport: { width: options.width, height: options.height },
  deviceScaleFactor: options.scale,
  colorScheme: options.scheme,
})
await page.addInitScript((entries) => {
  for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
}, options.local)
await page.goto(options.url, { waitUntil: 'networkidle' })
await page.waitForTimeout(options.wait)
for (const step of options.steps) {
  if (step.kind === 'click') await page.locator(step.value).first().click()
  else await page.keyboard.press(step.value)
  await page.waitForTimeout(400)
}
const manifestPath = join(options.out, 'manifest.json')
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { captures: [] }
for (const shot of options.shots) {
  const file = `${shot.name}.${id}.png`
  const target = shot.selector ? page.locator(shot.selector).first() : page
  await target.screenshot({ path: join(options.out, file) })
  manifest.captures.push({
    file,
    rev: print.rev,
    tree: print.tree,
    url: options.url,
    selector: shot.selector,
    steps: options.steps,
    local: options.local,
    viewport: { width: options.width, height: options.height, scale: options.scale },
    scheme: options.scheme,
    capturedAt: new Date().toISOString(),
  })
  console.log(join(options.out, file))
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
await browser.close()
