// Bundle the runner DAEMON into a self-contained tree for the desktop app to ship. The daemon's
// import graph (from src/daemon/main.ts) is DEPENDENCY-FREE — only `node:` builtins + local .ts —
// so "bundling" is just resolving that graph and copying the reachable .ts files into dist/runnerd/,
// preserving their src-relative paths so the relative imports still resolve. The result runs with a
// plain Node (which executes .ts natively): `node dist/runnerd/daemon/main.ts`.
//
// Zero dependencies (no bundler): a tiny BFS over `import/export … from "./…"`. If it ever hits a
// bare specifier (a real npm dep), it fails loudly — the daemon must stay dep-free to bundle this
// way. The desktop release then copies dist/runnerd/ (and a Node binary) into the .app; see
// docs/runner-daemon.md.

import { mkdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = join(repoRoot, "src");
const entry = join(srcRoot, "daemon", "main.ts");
const outRoot = join(repoRoot, "dist", "runnerd");

/** Strip comments so a `from "…"` inside prose (e.g. a doc comment mentioning a package) isn't
 * mistaken for a real import — imports themselves never live inside strings here. */
function stripComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|\s)\/\/.*$/gm, "$1"); // line comments (whitespace-guarded so `https://` survives)
}

/** Every `from "…"` specifier in a source file (import and export forms), comments removed. */
function specifiers(code) {
  const clean = stripComments(code);
  const out = [];
  for (const m of clean.matchAll(/(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/g)) out.push(m[1]);
  // Also bare side-effect imports: `import "./x.ts";`
  for (const m of clean.matchAll(/import\s*["']([^"']+)["']/g)) out.push(m[1]);
  return out;
}

const seen = new Set();
const queue = [entry];
while (queue.length > 0) {
  const file = queue.shift();
  if (seen.has(file)) continue;
  seen.add(file);
  const code = readFileSync(file, "utf8");
  for (const spec of specifiers(code)) {
    if (spec.startsWith("node:")) continue; // Node builtin — provided by the runtime
    if (!spec.startsWith(".")) {
      throw new Error(`bundle-runnerd: ${relative(repoRoot, file)} imports a non-local dependency "${spec}" — the daemon must stay dependency-free to bundle. Fix the import or extend this script.`);
    }
    const target = resolve(dirname(file), spec);
    if (!seen.has(target)) queue.push(target);
  }
}

rmSync(outRoot, { recursive: true, force: true });
let count = 0;
for (const file of seen) {
  const rel = relative(srcRoot, file);
  const dest = join(outRoot, rel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(file, dest);
  count++;
}

console.error(`▸ bundled ${count} files → ${relative(repoRoot, outRoot)} (entry: daemon/main.ts)`);
console.error(`  run standalone:  node ${relative(repoRoot, join(outRoot, "daemon", "main.ts"))}`);
