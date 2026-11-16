// A real IDE host with a real Herdr core behind it, for the local end-to-end stack.
//
//   E2E_IDE_HOST_BIN=<built theorem-ide-host> E2E_HERDR_HC=<herdr-core binary> node scripts/e2e/stack.mjs
//
// Local only. The host listens on loopback with a token generated here, in a file only this user
// can read; the server reaches it through environment-hosts.json, as the production store does. The
// core runs in a session of its own under XDG directories of its own, so the account's default
// Herdr session is never addressed. The host runs as a process the stack does not supervise, so a
// scenario can kill it and start it again while the core and its programs keep running.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ACCOUNT, DATA_DIR, IDE_HOST, IDE_HOST_PORT } from './config.mjs'

/** The core session this stack owns; never `default`. */
export const HERDR_SESSION = process.env.E2E_HERDR_SESSION ?? 'e2ewb'

const DIR = join(DATA_DIR, 'ide-host')
export const HOST_ROOT = join(DIR, 'root')
const BIN_DIR = join(DATA_DIR, 'bin')
const TOKEN_FILE = join(DIR, 'environment-token')
const NO_LANGUAGE_SERVERS = join(DIR, 'no-language-servers.json')
const PID_FILE = join(DIR, 'host.pid')
export const HOSTS_FILE = join(DATA_DIR, 'environment-hosts.json')
export const HOST_LOG = join(DATA_DIR, 'logs', 'ide-host.log')
const HOST_COPY = join(BIN_DIR, 'theorem-ide-host')
const HC_COPY = join(BIN_DIR, 'hc')
const XDG_STATE = join(DIR, 'herdr', 'state')
// A socket path is limited to about 100 bytes, so the run directory is short.
const XDG_RUNTIME = join(DATA_DIR, 'r')

export const ideHostEnabled = Boolean(process.env.E2E_IDE_HOST_BIN)

/** The environment `hc` needs to reach this stack's core and no other. */
export function herdrEnv() {
  return {
    ...process.env,
    HC_SESSION: HERDR_SESSION,
    XDG_STATE_HOME: XDG_STATE,
    XDG_RUNTIME_DIR: XDG_RUNTIME,
  }
}

/** Runs `hc` against this stack's core; returns its stdout. */
export function hc(...args) {
  const done = spawnSync(HC_COPY, args, {
    env: herdrEnv(),
    encoding: 'utf8',
  })
  return { code: done.status, out: done.stdout ?? '', err: done.stderr ?? '' }
}

/** Copies the built host and the core out of their build places, makes the token and the hosts file. */
export function prepareIdeHost() {
  const host = process.env.E2E_IDE_HOST_BIN
  const core = process.env.E2E_HERDR_HC
  if (!host || !existsSync(host)) throw new Error('Set E2E_IDE_HOST_BIN to a built theorem-ide-host.')
  if (!core || !existsSync(core)) throw new Error('Set E2E_HERDR_HC to a herdr-core binary.')
  for (const dir of [DIR, BIN_DIR, HOST_ROOT, XDG_STATE, XDG_RUNTIME])
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  // Each copy lands under a new name and is renamed over the old one. macOS kills a program whose
  // file was written over while a copy of it was running, and the core usually is.
  for (const [from, to] of [
    [host, HOST_COPY],
    [core, HC_COPY],
  ]) {
    copyFileSync(from, `${to}.new`)
    chmodSync(`${to}.new`, 0o755)
    renameSync(`${to}.new`, to)
  }
  if (!existsSync(TOKEN_FILE))
    writeFileSync(TOKEN_FILE, randomBytes(32).toString('hex'), { mode: 0o600 })
  writeFileSync(NO_LANGUAGE_SERVERS, '[]')
  mkdirSync(join(DATA_DIR, 'logs'), { recursive: true, mode: 0o700 })
  if (!existsSync(HOSTS_FILE)) setPrincipals([])
}

/** Which principals may use the host. The server reads the file on every request. */
export function setPrincipals(principals) {
  writeFileSync(
    HOSTS_FILE,
    JSON.stringify({
      [ACCOUNT]: { url: IDE_HOST, token_file: TOKEN_FILE, principals },
    }),
    { mode: 0o600 },
  )
}

/** The token, for the host check a scenario makes directly. Never printed. */
export const hostToken = () => readFileSync(TOKEN_FILE, 'utf8').trim()

/** Starts the host, detached, and says which process it is. */
export function startHost(extraEnv = {}) {
  const log = openSync(HOST_LOG, 'a')
  const child = spawn(HOST_COPY, ['--http'], {
    detached: true,
    stdio: ['ignore', log, log],
    env: {
      ...process.env,
      THEOREM_ENVIRONMENT_TENANT: ACCOUNT,
      THEOREM_ENVIRONMENT_TOKEN_FILE: TOKEN_FILE,
      THEOREM_ENVIRONMENT_ROOT: HOST_ROOT,
      THEOREM_ENVIRONMENT_LISTEN: `127.0.0.1:${IDE_HOST_PORT}`,
      THEOREM_ENVIRONMENT_LANGUAGE_SERVERS_FILE: NO_LANGUAGE_SERVERS,
      THEOREM_HERDR_HC: HC_COPY,
      THEOREM_HERDR_SESSION: HERDR_SESSION,
      XDG_STATE_HOME: XDG_STATE,
      XDG_RUNTIME_DIR: XDG_RUNTIME,
      SHELL: '/bin/bash',
      BASH_SILENCE_DEPRECATION_WARNING: '1',
      RUST_LOG: 'info',
      ...extraEnv,
    },
  })
  closeSync(log)
  child.unref()
  writeFileSync(PID_FILE, String(child.pid))
  return child.pid
}

/** The host's process id, when it was started here. */
export function hostPid() {
  return existsSync(PID_FILE) ? Number(readFileSync(PID_FILE, 'utf8')) : undefined
}

/** Ends the host (SIGKILL by default, as a crash would); the core and its programs are untouched. */
export function killHost(signal = 'SIGKILL') {
  const pid = hostPid()
  if (!pid) return
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}

/** A call straight to the host, as the server makes it: bearer token, tenant, and an actor of this script's own. */
export async function hostApi(method, path, body) {
  const response = await fetch(`${IDE_HOST}/api/environment/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${hostToken()}`,
      'x-theorem-tenant': ACCOUNT,
      'x-theorem-actor': 'e2e-script',
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

/** The core's live terminals, as `hc ls` reports them. */
export function coreTerminals() {
  try {
    return JSON.parse(hc('ls', '--json').out).terminals ?? []
  } catch {
    return []
  }
}

/** True while the host answers; the host refuses an unauthenticated request with 401, which still means it is up. */
export async function hostUp() {
  const response = await fetch(`${IDE_HOST}/api/environment/v1/workspaces`).catch(
    () => undefined,
  )
  return response !== undefined
}

/** The core's own version line, from the copy this stack runs (for example `hc 0.1.17`). */
export function coreVersion() {
  const done = hc('--version')
  return (done.out || done.err).trim()
}

/** Starts the stack's core again after `hc server stop`, detached; true once it answers. */
export async function startCore() {
  const child = spawn(HC_COPY, ['serve'], { detached: true, stdio: 'ignore', env: herdrEnv() })
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (hc('ls', '--json').code === 0) return true
    await new Promise((settle) => setTimeout(settle, 250))
  }
  return false
}

/** Ends the core of this stack's session and everything it runs. */
export function stopCore() {
  hc('server', 'stop')
}

export function stopIdeHost() {
  killHost('SIGTERM')
  stopCore()
}
