// RD5 — the runner-daemon bundler (scripts/bundle-runnerd.mjs) produces a self-contained,
// dependency-free tree the desktop app can ship. Running the real bundler here also GUARDS the
// daemon's dep-free invariant: it throws if the daemon's import graph ever gains a runtime npm
// dependency, which would break the bundle-and-run-with-plain-Node packaging.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("bundle:runnerd emits the daemon's dependency-free source tree (guards the invariant)", () => {
  execFileSync("node", ["scripts/bundle-runnerd.mjs"], { cwd: repoRoot }); // throws on a bare (npm) import
  const out = join(repoRoot, "dist", "runnerd");
  for (const rel of ["daemon/main.ts", "daemon/runner-client.ts", "agent/runner-protocol.ts", "agent/pi-runner.ts", "types.ts"]) {
    assert.ok(existsSync(join(out, rel)), `${rel} is bundled`);
  }
  // Pure source — no node_modules / package.json required to run it.
  assert.ok(!existsSync(join(out, "node_modules")), "the bundle needs no node_modules");
});
