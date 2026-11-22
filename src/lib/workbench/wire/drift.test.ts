// Fails when the committed wire types no longer match the Rust source.
// It regenerates into a temp folder with the real exporter and compares files.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const terminalDir = resolve(here, "../../../../terminal");

function tsFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".ts") && name !== "drift.test.ts") {
      files.set(name, readFileSync(join(dir, name), "utf8"));
    }
  }
  return files;
}

test("committed wire types match what Rust generates", () => {
  const temp = mkdtempSync(join(tmpdir(), "theorem-wire-"));
  try {
    const run = Bun.spawnSync(
      ["cargo", "test", "-p", "theorem-workbench-core", "--features", "ts", "--test", "wire_export"],
      { cwd: terminalDir, env: { ...process.env, THEOREM_WIRE_DIR: temp }, stdout: "pipe", stderr: "pipe" },
    );
    if (run.exitCode !== 0) {
      throw new Error(`wire export failed:\n${run.stderr.toString()}\n${run.stdout.toString()}`);
    }
    const fresh = tsFiles(temp);
    const committed = tsFiles(here);
    expect([...committed.keys()].sort()).toEqual([...fresh.keys()].sort());
    for (const [name, text] of fresh) {
      expect(committed.get(name), `${name} drifted; rerun the wire_export test`).toBe(text);
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}, 600_000);
