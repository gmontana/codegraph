#!/usr/bin/env node
/**
 * Reachability classifier over a CodeGraph index — replaces the blunt
 * "no callers" signal with: live / test_only / tool_only / unreachable
 * (unreachable split into exported-API vs private, by deletion confidence).
 *
 * Multi-source reachability over calls/references/instantiates edges:
 *   - production roots: `main` + FFI/external surface (export/extern/callconv)
 *   - test roots:       `test` blocks (signature = 'test')
 *   - tool roots:       functions defined in tool/bench/example/script paths
 * A function is `live` if reached from a production root; else `test_only` if
 * reached from a test root; else `tool_only`; else `unreachable`.
 *
 * Generic (any CodeGraph project / language). Prototype for a core
 * `codegraph reachability` command; reads the SQLite index directly.
 *
 * Usage: node scripts/reachability.cjs --db <path> [--lang zig] [--sample 20]
 */
const { DatabaseSync } = require('node:sqlite');

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const DB = arg('--db', '.codegraph/codegraph.db');
const LANG = arg('--lang', 'zig');
const SAMPLE = parseInt(arg('--sample', '20'), 10);

const TOOL_RE = /(^|\/)(tools?|bench|benchmark|benchmarks|examples?|scripts?)\//i;
const TEST_RE = /(^|\/)tests?\/|_test\.|\.test\./i;

const db = new DatabaseSync(`file:${DB}?mode=ro`, { uri: true });

// Callable nodes in the target language.
const nodes = db
  .prepare(
    `SELECT id, name, file_path, visibility, is_exported, signature, decorators
     FROM nodes WHERE kind IN ('function','method') AND language = ?`,
  )
  .all(LANG);

// Outgoing adjacency over the edge kinds that mean "uses".
const adj = new Map();
for (const e of db
  .prepare(`SELECT source, target FROM edges WHERE kind IN ('calls','references','instantiates')`)
  .all()) {
  if (!adj.has(e.source)) adj.set(e.source, []);
  adj.get(e.source).push(e.target);
}

const byId = new Map(nodes.map((n) => [n.id, n]));
const isTest = (n) => n.signature === 'test' || TEST_RE.test(n.file_path);
const isTool = (n) => TOOL_RE.test(n.file_path);
const ffi = (n) => {
  if (!n.decorators) return false;
  try {
    const d = JSON.parse(n.decorators);
    return Array.isArray(d) && d.some((m) => m === 'export' || m === 'extern' || m === 'callconv');
  } catch {
    return false;
  }
};

function bfs(roots) {
  const seen = new Set(roots);
  const stack = [...roots];
  while (stack.length) {
    for (const t of adj.get(stack.pop()) || []) {
      if (!seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  return seen;
}

// Production surface = app entry (`main`), FFI/external-ABI exports, and the
// pub API (in a Zig library the pub surface IS the contract — consumers and
// tests reach the implementation through it, so it's live by definition).
const isPub = (n) => n.is_exported || n.visibility === 'public' || ffi(n);
// build.zig's `build()` is the package's build entry (invoked by `zig build`),
// so it's a production root and never an API-cleanup lead despite 0 in-repo callers.
const isBuildEntry = (n) => /(^|\/)build\.zig$/.test(n.file_path);
const prodRoots = nodes.filter((n) => !isTest(n) && !isTool(n) && (n.name === 'main' || isPub(n) || isBuildEntry(n))).map((n) => n.id);
const testRoots = nodes.filter((n) => n.signature === 'test').map((n) => n.id);
const toolRoots = nodes.filter((n) => isTool(n)).map((n) => n.id);

const liveR = bfs(prodRoots);
const testR = bfs(testRoots);
const toolR = bfs(toolRoots);

const buckets = { live: [], test_only: [], tool_only: [], unreachable: [] };
for (const n of nodes) {
  if (liveR.has(n.id)) buckets.live.push(n);
  else if (testR.has(n.id)) buckets.test_only.push(n);
  else if (toolR.has(n.id)) buckets.tool_only.push(n);
  else buckets.unreachable.push(n);
}

// Incoming-use count (independent of reachability) — the basis for the
// "exported but no in-repo users" lead, which is a softer signal than "dead":
// such a pub symbol may be consumed only by external packages.
const incoming = new Map();
for (const e of db.prepare(`SELECT target, COUNT(*) c FROM edges WHERE kind IN ('calls','references','instantiates') GROUP BY target`).all()) {
  incoming.set(e.target, e.c);
}
const exportedNoUsers = nodes.filter((n) => isPub(n) && !ffi(n) && n.name !== 'main' && !(incoming.get(n.id) > 0) && !isTest(n) && !isTool(n) && !isBuildEntry(n));

console.log(`=== Reachability (${LANG}) — ${nodes.length} functions/methods ===`);
console.log(`  roots: production=${prodRoots.length} (main+FFI+pub-API)  test=${testRoots.length}  tool=${toolRoots.length}\n`);
const pct = (a) => `${((100 * a) / nodes.length).toFixed(1)}%`;
for (const [label, arr] of Object.entries(buckets)) {
  console.log(`  ${label.padEnd(14)} ${String(arr.length).padStart(6)}  ${pct(arr.length)}`);
}
console.log(`\n  exported_no_users ${String(exportedNoUsers.length).padStart(4)}  (pub, 0 in-repo callers — API-cleanup lead, may be external)`);
console.log(`\n--- unreachable (private, unreached → highest-confidence dead; sample) ---`);
for (const n of buckets.unreachable.slice(0, SAMPLE)) console.log(`    ${n.name.padEnd(30)} ${n.file_path}`);
console.log(`\n--- exported_no_users (sample) ---`);
for (const n of exportedNoUsers.slice(0, SAMPLE)) console.log(`    ${n.name.padEnd(30)} ${n.file_path}`);
