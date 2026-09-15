#!/usr/bin/env node
/**
 * Detector 4 — a call to a locally-declared async function whose promise is
 * dropped on the floor: not awaited, not returned, not given .then/.catch, not
 * assigned, not passed as an argument.
 *
 * Two ways this bites, both silent:
 *   - the work is assumed done when execution moves on, and is not;
 *   - a rejection has no handler, so it reaches process.on('unhandledRejection')
 *     in server.js, which only logs. The failure vanishes.
 *
 * Scope note: only functions declared `async` in the scanned files are treated
 * as promise-returning, so this misses promise-returning functions written
 * without the keyword and misses cross-file calls unless both files are scanned.
 * It is deliberately narrow — a broad version is mostly noise.
 *
 * Deliberate fire-and-forget is legitimate. This detector cannot tell intent,
 * so every hit needs reading: the question is whether a rejection there would
 * be lost, not whether the await is missing.
 */
const fs = require('fs');
const path = require('path');
const { blank } = require('./lib/blank');

const ROOT = path.resolve(__dirname, '../..');
const toPosix = (p) => p.split(path.sep).join(String.fromCharCode(47));
const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : ['server/services'];

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

/** Blank comments and string bodies, preserving offsets and newlines. */


const files = [];
for (const t of TARGETS) {
  const abs = path.join(ROOT, t);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs, files);
  else if (fs.existsSync(abs)) files.push(abs);
}

// Async names are collected PER FILE, not globally. Collected globally, a name
// declared async in one file (platformAdmin's `cacheSet`) marked every call to a
// same-named *synchronous* function elsewhere (workspaceContext's `cacheSet`) as
// a dropped promise. Same-file only is narrower and does not invent hits.
const sources = new Map();
const namesByFile = new Map();
for (const f of files) {
  const src = blank(fs.readFileSync(f, 'utf8'));
  sources.set(f, src);
  const names = new Set();
  for (const m of src.matchAll(/\basync\s+function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\b/g)) names.add(m[1]);
  // `name: async (…) => …` and `async name(…) {` inside object literals / classes
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*:\s*async\b/g)) names.add(m[1]);
  for (const m of src.matchAll(/\basync\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (m[1] !== 'function') names.add(m[1]);
  }
  namesByFile.set(f, names);
}

const findings = [];
for (const f of files) {
  // A test runner's `test(...)` is called exactly this way by design.
  if (/__tests__/.test(f)) continue;
  const src = sources.get(f);
  const rel = toPosix(path.relative(ROOT, f));
  const lineOf = (i) => src.slice(0, i).split('\n').length;

  for (const name of namesByFile.get(f)) {
    const re = new RegExp(`(^|[^\\w$.])(${name})\\s*\\(`, 'g');
    for (const m of src.matchAll(re)) {
      const callStart = m.index + m[1].length;
      // What precedes the call decides whether the promise is kept.
      const before = src.slice(Math.max(0, callStart - 120), callStart);
      if (/\b(await|return|yield)\s*$/.test(before)) continue;
      // A concise arrow body returns its expression, so the promise is kept and
      // handled by whatever awaits the arrow — `() => worker()`,
      // `.then(() => fetchIt(d))`, `items.map((u) => scrape(u))`. Must be tested
      // before the generic `=` rule below, which would otherwise not see it.
      if (/=>\s*$/.test(before)) continue;
      if (/[=(,:[?]\s*$/.test(before)) continue;            // assigned / passed / ternary
      if (/\b(new|typeof|instanceof)\s*$/.test(before)) continue;
      if (/\.\s*$/.test(before)) continue;                   // method call on something
      // Declaration sites, not calls. A class method is written `async _foo() {`
      // with no `function` keyword, so the bare `async` case has to be excluded
      // too or every async method reads as a dropped call to itself.
      if (/\basync\s*$/.test(before)) continue;
      if (/\b(async\s+)?function\s*$/.test(before)) continue;
      if (/\b(const|let|var|class)\s*$/.test(before)) continue;

      // What follows decides whether it is chained.
      const openIdx = src.indexOf('(', callStart);
      let depth = 0, close = -1;
      for (let i = openIdx; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (!depth) { close = i; break; } }
      }
      if (close === -1) continue;
      const after = src.slice(close + 1, close + 30);
      if (/^\s*\./.test(after)) continue;                    // .then / .catch / .finally
      if (/^\s*[)\],;]*\s*=>/.test(after)) continue;

      findings.push({ file: rel, line: lineOf(callStart), name });
    }
  }
}

fs.writeFileSync(
  path.join(ROOT, 'error-loop/reports/floating-promise.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), targets: TARGETS, findings }, null, 2),
);

console.log(`dropped promises from async functions: ${findings.length}`);
for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.name}(...) result discarded`);
process.exitCode = findings.length ? 1 : 0;
