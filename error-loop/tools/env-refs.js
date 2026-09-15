#!/usr/bin/env node
/**
 * Detector 6 — environment-variable drift.
 *
 * Two directions, and the first is the one that bites:
 *
 *   undocumented  process.env.X is read by the server but X appears nowhere in
 *                 .env.example. Whoever deploys this has no way to know the
 *                 variable exists, so the feature silently takes its fallback —
 *                 or, where the code asserts, the process refuses to boot with
 *                 a variable nobody documented.
 *
 *   unused        X is documented in .env.example but nothing reads it. Usually
 *                 harmless, occasionally the fossil of a rename that left half
 *                 the callers behind — which is worth seeing.
 *
 * Comment- and string-aware. Reports only, fixes nothing.
 */
const fs = require('fs');
const path = require('path');
const { blank } = require('./lib/blank');

const ROOT = path.resolve(__dirname, '../..');
const toPosix = (p) => p.split(path.sep).join(String.fromCharCode(47));
const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : ['server'];

function walk(dir, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}



// ── Documented keys ─────────────────────────────────────────────────────────
const documented = new Set();
for (const name of ['.env.example']) {
  const f = path.join(ROOT, name);
  if (!fs.existsSync(f)) continue;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]{2,})\s*=/);
    if (m) documented.add(m[1]);
  }
}

// ── Keys the code reads ─────────────────────────────────────────────────────
const used = new Map(); // key -> [ "file:line", ... ]
const files = [];
for (const t of TARGETS) {
  const abs = path.join(ROOT, t);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs, files);
  else if (fs.existsSync(abs)) files.push(abs);
}

for (const file of files) {
  if (/__tests__/.test(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  const src = blank(raw);
  const rel = toPosix(path.relative(ROOT, file));
  const re = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g;
  for (const m of src.matchAll(re)) {
    const key = m[1] || m[2];
    const line = src.slice(0, m.index).split('\n').length;
    if (!used.has(key)) used.set(key, []);
    if (used.get(key).length < 3) used.get(key).push(`${rel}:${line}`);
  }
}

// Supplied by the platform, never by .env.example.
const AMBIENT = new Set([
  'NODE_ENV', 'PORT', 'HOME', 'PATH', 'USER', 'USERNAME', 'TMPDIR', 'TEMP',
  'RAILWAY_ENVIRONMENT', 'RENDER', 'CI', 'PWD', 'HOSTNAME',
]);

const undocumented = [...used.keys()]
  .filter((k) => !documented.has(k) && !AMBIENT.has(k))
  .sort();
const unused = [...documented]
  .filter((k) => !used.has(k) && !AMBIENT.has(k))
  .sort();

fs.writeFileSync(
  path.join(ROOT, 'error-loop/reports/env-refs.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    targets: TARGETS,
    documentedCount: documented.size,
    usedCount: used.size,
    undocumented: undocumented.map((k) => ({ key: k, at: used.get(k) })),
    unused,
  }, null, 2),
);

console.log(`documented in .env.example: ${documented.size}`);
console.log(`read by code: ${used.size}`);
console.log(`\nREAD BUT NOT DOCUMENTED: ${undocumented.length}`);
for (const k of undocumented) console.log(`  ${k}  (${used.get(k).join(', ')})`);
console.log(`\ndocumented but never read: ${unused.length}`);
for (const k of unused) console.log(`  ${k}`);
process.exitCode = undocumented.length ? 1 : 0;
