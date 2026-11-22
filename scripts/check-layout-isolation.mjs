#!/usr/bin/env node
// AC-61 (R03, R05, R29, R48): the Herdr layout boundary must build for the
// browser target on its own and must not pull any native terminal, process or
// Ghostty dependency into the browser. Run from the worktree root:
//
//   CARGO_TARGET_DIR=<dir> node scripts/check-layout-isolation.mjs
//
// It builds `theorem-workbench-layout` for wasm32-unknown-unknown, lists the
// normal dependency tree of the layout and dock crates for that target, fails
// on any banned name, and writes docs/plans/evidence/workbench-layout-isolation.json.
// ISOLATION_EXTRA_BANNED=name[,name] adds names to the list, to show that the
// check can fail (for example `serde`, which is present).

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const terminal = join(root, "terminal");
const layoutSrc = join(terminal, "crates/workbench-layout/src/lib.rs");
const evidencePath = join(root, "docs/plans/evidence/workbench-layout-isolation.json");
const TARGET = "wasm32-unknown-unknown";
const PACKAGES = ["theorem-workbench-layout", "theorem-workbench-dock"];

// What Herdr's own application pulls in, from its Cargo.toml at the pinned
// commit (ee5bfb5, [dependencies] and the cfg(unix), cfg(linux), cfg(windows)
// tables) plus the neighbours that terminal and process crates drag in. Each
// entry is a regular expression on the whole crate name.
const BANNED = [
  [/^ghostty.*/, "Ghostty VT: Herdr's terminal emulator (crates/ghostty-vt, a Zig build)"],
  [/^portable-pty$/, "pseudo-terminal spawn and kill: Herdr's process launcher"],
  [/^crossterm$/, "native terminal backend of Herdr's TUI (raw mode, input, signals)"],
  [/^ratatui-crossterm$/, "ratatui 0.30 split the crossterm backend into its own crate"],
  [/^ratatui-termwiz$/, "ratatui's termwiz backend, the other native terminal backend"],
  [/^termwiz$/, "native terminal backend and escape parser"],
  [/^tokio$/, "async runtime; Herdr enables its `process` and `signal` features"],
  [/^libc$/, "raw syscalls: fork, kill, waitpid and pty ioctl in Herdr's runtime"],
  [/^nix$/, "POSIX process and pty control"],
  [/^rustix$/, "process, pty and fd syscalls"],
  [/^signal-hook(-registry)?$/, "Unix signal handling, Herdr's cfg(unix) dependency"],
  [/^ctrlc$/, "Ctrl-C and termination handler installed by Herdr's server"],
  [/^interprocess$/, "local sockets and named pipes to the Herdr server process"],
  [/^mio$/, "native event loop under tokio and pty readers"],
  [/^socket2$/, "native sockets under tokio and interprocess"],
  [/^filedescriptor$/, "pty and pipe file descriptors (portable-pty's helper)"],
  [/^zbus$/, "D-Bus logind shutdown inhibitor, Herdr's cfg(linux) dependency"],
  [/^windows([-_].*)?$/, "Windows APIs: job objects, pipes and console, Herdr's cfg(windows) tables"],
  [/^widestring$/, "UTF-16 SDDL for Herdr's Windows pipe security descriptors"],
  [/^wmi$/, "Windows Management Instrumentation, Herdr's cfg(windows) dependency"],
];
for (const name of (process.env.ISOLATION_EXTRA_BANNED ?? "").split(",").filter(Boolean)) {
  BANNED.push([new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "added by ISOLATION_EXTRA_BANNED"]);
}

const targetDir = process.env.CARGO_TARGET_DIR;
if (!targetDir) {
  console.error("CARGO_TARGET_DIR must be set so this build does not share a directory with others.");
  process.exit(2);
}

const commands = [];
function cargo(args) {
  const r = spawnSync("cargo", args, { cwd: terminal, encoding: "utf8", env: process.env });
  const entry = { command: `cargo ${args.join(" ")}`, cwd: "terminal", exit_code: r.status };
  commands.push(entry);
  return { ...r, entry };
}

// The pin is read from the crate's own header, not written here.
const header = readFileSync(layoutSrc, "utf8").split("\n").slice(0, 12).join("\n");
const pin = {
  repo: "herdrdev/herdr",
  commit: header.match(/commit ([0-9a-f]{40})/)?.[1] ?? null,
  path: header.match(/path (\S+?),/)?.[1] ?? null,
  blob: header.match(/blob ([0-9a-f]{40})/)?.[1] ?? null,
  license: header.match(/License: ([\w.-]+)/)?.[1] ?? null,
  source: "terminal/crates/workbench-layout/src/lib.rs header",
};

const failures = [];
if (!pin.commit || !pin.blob) failures.push("the layout crate does not record the donor commit and blob");

const build = cargo(["build", "-p", "theorem-workbench-layout", "--target", TARGET, "--locked"]);
if (build.status !== 0) failures.push(`wasm build failed (exit ${build.status})`);

const trees = {};
for (const pkg of PACKAGES) {
  const r = cargo(["tree", "-p", pkg, "--target", TARGET, "--edges", "normal", "--prefix", "none"]);
  if (r.status !== 0) {
    failures.push(`cargo tree failed for ${pkg} (exit ${r.status})`);
    continue;
  }
  // Names only: `cargo tree` prints `name vX.Y.Z (path or marker)`.
  const names = [...new Set(r.stdout.split("\n").map((l) => l.match(/^(\S+) v/)?.[1]).filter(Boolean))].sort();
  const hits = [];
  for (const name of names) {
    for (const [re, why] of BANNED) if (re.test(name)) hits.push({ name, why });
  }
  trees[pkg] = { dependencies: names, banned_hits: hits };
  for (const h of hits) failures.push(`${pkg} depends on ${h.name}: ${h.why}`);
}

const evidence = {
  case: "AC-61",
  requirements: ["R03", "R05", "R29", "R48"],
  target: TARGET,
  pin,
  rustc: spawnSync("rustc", ["--version"], { encoding: "utf8" }).stdout.trim(),
  banned: BANNED.map(([re, why]) => ({ pattern: re.source, why })),
  commands,
  trees,
  result: failures.length === 0 ? "pass" : "fail",
  failures,
};
mkdirSync(dirname(evidencePath), { recursive: true });
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

for (const c of commands) console.log(`exit ${c.exit_code}  ${c.command}`);
for (const [pkg, t] of Object.entries(trees)) console.log(`${pkg}: ${t.dependencies.length} dependencies for ${TARGET}, ${t.banned_hits.length} banned`);
console.log(`pin: ${pin.repo}@${pin.commit} ${pin.path} blob ${pin.blob}`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f}`);
  process.exit(1);
}
console.log("layout isolation: pass");
