#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectDesign } from './core.mjs'
import { captureURL, prepareOutput, redactURL } from './capture.mjs'
import { compareCaptures } from './compare.mjs'
import { probeURL } from './probe.mjs'
import { writeJSON } from './report.mjs'

export const capabilities = {
  schemaVersion: 'design-feedback/v1', version: '0.1.0',
  commands: {
    capture: { usage: 'capture <url> --out <directory>', outputs: ['capture.json', 'observations.json', 'findings.json', 'screenshot.png', 'report.html'], description: 'Capture an actual browser viewport, collect DOM measurements, and inspect them.' },
    inspect: { usage: 'inspect <observations.json> [--policy <policy.json>] [--out <directory>]', outputs: ['findings.json when --out is given'], description: 'Evaluate collected observations without opening a browser.' },
    compare: { usage: 'compare <before-directory> <after-directory> --out <directory> [--threshold 0.1]', outputs: ['comparison.json', 'report.html', 'before.png', 'after.png', 'heatmap.png', 'raw-diff.png', 'collage.png'], description: 'Compare compatible captures with a thresholded pixel difference map and matched-element geometry changes; incompatible captures produce JSON and HTML only.' },
    probe: { usage: 'probe <url> --out <directory>', outputs: ['probes.json', 'report.html', 'baseline/', 'narrow/', 'text-spacing/', 'reduced-motion/'], description: 'Run fresh-context viewport, text-spacing, and reduced-motion experiments.' },
  },
  flags: {
    '--out': 'Output directory; existing results are preserved unless --overwrite is given.',
    '--policy': 'JSON inspection policy for capture, inspect, and probe.',
    '--width': 'CSS viewport width, default 1440.', '--height': 'CSS viewport height, default 900.', '--dpr': 'Device pixel ratio, default 1.',
    '--scheme': 'light or dark, default light.', '--motion': 'reduce or no-preference, default reduce (probe sets each scenario explicitly).',
    '--engine': 'chromium, firefox, or webkit, default chromium.', '--executable': 'Existing browser executable; also DESIGN_FEEDBACK_BROWSER.',
    '--ready': 'Wait for a visible CSS selector before measuring.', '--settle-ms': 'Additional settle interval from 0 to 5000, default 100.', '--timeout': 'Navigation/readiness timeout in milliseconds, default 15000.',
    '--max-elements': 'Collector output budget, default 1000; omissions remain explicit.', '--revision': 'Optional source revision recorded with the capture.', '--label': 'Optional capture label.',
    '--threshold': 'Pixelmatch perceptual threshold from 0 to 1, default 0.1; compare only.',
    '--no-sandbox': 'Explicitly disable Chromium sandbox, needed only in environments that cannot launch sandboxed Chromium.',
    '--overwrite': 'Allow replacing result files in the output directory.', '--fail-on-findings': 'Exit 1 when measured fail findings are emitted; otherwise successful collection exits 0.',
  },
  evidence: ['rendered DOM text style and geometry', 'actual browser viewport PNG', 'thresholded pixel differences', 'element position and size deltas', 'controlled rendering probes'],
  limitations: ['No aesthetic score or claim of overall accessibility conformance.', 'Unsupported paint and insufficient evidence are unknown, never an automatic pass.', 'Only viewport pixels are captured; the DOM may include elements outside the viewport.', 'Font-family records the CSS request, not the actual face used for each glyph.', 'No screenshot registration or resizing; incompatible comparison conditions are rejected.', 'No keyboard interaction, screen-reader evaluation, native-app adapter, OCR, saliency prediction, or vision model is included.', 'Capture and probe load the requested URL in fresh browser contexts and execute its page scripts; no credentials or authenticated profiles are imported.'],
  exitCodes: { 0: 'Command completed; review findings and coverage.', 1: '--fail-on-findings and at least one measured failure.', 2: 'Invalid input, tool failure, or incompatible comparison.' },
}

const valueFlags = new Map([
  ['--out', 'out'], ['--policy', 'policyFile'], ['--width', 'width'], ['--height', 'height'], ['--dpr', 'dpr'], ['--scheme', 'colorScheme'], ['--motion', 'reducedMotion'], ['--engine', 'engine'], ['--executable', 'executablePath'], ['--ready', 'readySelector'], ['--settle-ms', 'settleMs'], ['--timeout', 'timeout'], ['--max-elements', 'maxElements'], ['--revision', 'sourceRevision'], ['--label', 'label'], ['--threshold', 'threshold'],
])
const booleanFlags = new Map([['--overwrite', 'overwrite'], ['--no-sandbox', 'noSandbox'], ['--fail-on-findings', 'failOnFindings']])

export function parseArguments(argv) {
  const [command = 'capabilities', ...rest] = argv
  if (['help', '--help', '-h', 'capabilities'].includes(command)) {
    if (rest.length) throw new Error(`${command} does not accept arguments`)
    return { command: 'capabilities', positionals: [], options: {} }
  }
  if (!Object.hasOwn(capabilities.commands, command)) throw new Error(`Unknown command: ${command}`)
  const options = {}
  const positionals = []
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]
    if (booleanFlags.has(arg)) options[booleanFlags.get(arg)] = true
    else if (valueFlags.has(arg)) {
      if (rest[index + 1] === undefined || rest[index + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`)
      options[valueFlags.get(arg)] = rest[++index]
    } else if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    else positionals.push(arg)
  }
  const count = command === 'compare' ? 2 : 1
  if (positionals.length !== count) throw new Error(`Usage: ${capabilities.commands[command].usage}`)
  if (command !== 'inspect' && !options.out) throw new Error('--out is required')
  if (command !== 'compare' && options.threshold !== undefined) throw new Error('--threshold is only valid for compare')
  const allowed = command === 'inspect' ? ['out', 'policyFile', 'overwrite', 'failOnFindings'] : command === 'compare' ? ['out', 'overwrite', 'threshold'] : null
  if (allowed) for (const key of Object.keys(options)) if (!allowed.includes(key)) throw new Error(`Option ${key} is not supported by ${command}`)
  if (options.out) options.out = resolve(options.out)
  if (['capture', 'probe'].includes(command) && !options.executablePath && process.env.DESIGN_FEEDBACK_BROWSER) options.executablePath = process.env.DESIGN_FEEDBACK_BROWSER
  return { command, positionals, options }
}

export async function runCLI(argv = process.argv.slice(2), print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)) {
  const { command, positionals, options } = parseArguments(argv)
  if (command === 'capabilities') { print(capabilities); return 0 }
  if (options.policyFile) options.policy = JSON.parse(await readFile(options.policyFile, 'utf8'))
  let result
  if (command === 'capture') {
    const captured = await captureURL(positionals[0], options)
    result = captured.result
    print({ out: options.out, captureId: captured.capture.id, summary: result.summary, findings: result.findings.filter((finding) => finding.status !== 'pass'), coverage: result.coverage, files: captured.capture.files })
  } else if (command === 'inspect') {
    result = inspectDesign(JSON.parse(await readFile(positionals[0], 'utf8')), options.policy)
    if (options.out) {
      await prepareOutput(options.out, 'findings.json', options.overwrite)
      await writeJSON(join(options.out, 'findings.json'), result)
    }
    print(result)
  } else if (command === 'compare') {
    result = await compareCaptures(positionals[0], positionals[1], options)
    print({ out: options.out, ...result })
    return result.compatibility.compatible ? 0 : 2
  } else {
    result = await probeURL(positionals[0], options)
    print({ out: options.out, ...result })
    return options.failOnFindings && result.runs.some((run) => run.summary?.fail > 0) ? 1 : 0
  }
  return options.failOnFindings && result.summary?.fail > 0 ? 1 : 0
}

export async function main(argv = process.argv.slice(2)) {
  try { process.exitCode = await runCLI(argv) }
  catch (error) {
    const message = String(error?.message ?? error).replace(/https?:\/\/[^\s"'<>]+/g, (url) => redactURL(url))
    process.stderr.write(`Design Feedback: ${message}\n`)
    process.exitCode = 2
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main()
}
