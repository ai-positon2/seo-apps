#!/usr/bin/env node
/**
 * Detector 8 (Round 2, Pass C) — a resource acquired but not released on the
 * failure path.
 *
 * The success path almost always releases; the throw path is where these leak,
 * and a leak of a pool client or a browser page is not a slow degradation but a
 * hard stop once the pool is exhausted.
 *
 * Looks for an acquisition — pool.connect(), puppeteer.launch(),
 * browser.newPage(), createWriteStream, setInterval, fs.open — and then asks
 * whether its release appears inside a `finally` block in the same function.
 * A release that only appears in the success path, or only in a `catch`, is
 * reported: a `catch` misses the case where the body returns normally but a
 * later statement throws, and neither covers an early `return`.
 *
 * Heuristic. Every hit needs reading — `db.tx()` in services/db.js is the
 * correct shape and must come back clean.
 */
const fs = require('fs');
const path = require('path');
const { blank } = require('./lib/blank');

const ROOT = path.resolve(__dirname, '../..');
const toPosix = (p) => p.split(path.sep).join(String.fromCharCode(47));
const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : ['server'];

const ACQUIRE = [
  { re: /\.connect\(\s*\)/g,            name: 'pool client',   release: /\.release\(/ },
  { re: /puppeteer\.launch\(/g,          name: 'browser',       release: /\.close\(/ },
  { re: /\.newPage\(\s*\)/g,             name: 'page',          release: /\.close\(/ },
  { re: /createWriteStream\(/g,          name: 'write stream',  release: /\.(end|close|destroy)\(/ },
  { re: /createReadStream\(/g,           name: 'read stream',   release: /\.(close|destroy)\(/ },
  { re: /setInterval\(/g,                name: 'interval',      release: /clearInterval\(/ },
];

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



function matchBrace(src, open) {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (!d) return i; }
  }
  return -1;
}

/** The enclosing function body span for an offset, best-effort. */
function enclosingBody(src, at) {
  let best = null;
  const re = /(?:async\s+)?(?:function\b[^(]*|\([^)]*\)\s*=>|\b[A-Za-z_$][\w$]*\s*\([^)]*\)\s*)\{/g;
  for (const m of src.matchAll(re)) {
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open === -1 || open > at) continue;
    const close = matchBrace(src, open);
    if (close === -1 || close < at) continue;
    if (!best || open > best[0]) best = [open, close];
  }
  return best;
}

/** Spans of every `finally { … }` inside [from,to]. */
function finallySpans(src, from, to) {
  const spans = [];
  const region = src.slice(from, to);
  for (const m of region.matchAll(/\bfinally\s*\{/g)) {
    const open = from + m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    if (close !== -1) spans.push([open, close]);
  }
  return spans;
}

const findings = [];
const files = [];
for (const t of TARGETS) {
  const abs = path.join(ROOT, t);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs, files);
  else if (fs.existsSync(abs)) files.push(abs);
}

for (const file of files) {
  if (/__tests__/.test(file)) continue;
  const src = blank(fs.readFileSync(file, 'utf8'));
  const rel = toPosix(path.relative(ROOT, file));
  const lineOf = (i) => src.slice(0, i).split('\n').length;

  for (const spec of ACQUIRE) {
    for (const m of src.matchAll(spec.re)) {
      const at = m.index;
      const body = enclosingBody(src, at);
      if (!body) continue;
      const [bOpen, bClose] = body;
      const scope = src.slice(bOpen, bClose);
      if (!spec.release.test(scope)) {
        findings.push({ file: rel, line: lineOf(at), resource: spec.name, why: 'no release call in this function' });
        continue;
      }
      // Released somewhere — is any release inside a finally?
      const fins = finallySpans(src, bOpen, bClose);
      let inFinally = false;
      for (const rm of scope.matchAll(new RegExp(spec.release.source, 'g'))) {
        const abs2 = bOpen + rm.index;
        if (fins.some(([s, e]) => abs2 > s && abs2 < e)) { inFinally = true; break; }
      }
      if (!inFinally) {
        findings.push({ file: rel, line: lineOf(at), resource: spec.name, why: 'released, but not in a finally' });
      }
    }
  }
}

fs.writeFileSync(
  path.join(ROOT, 'error-loop/reports/resource-release.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), targets: TARGETS, findings }, null, 2),
);

console.log(`resource acquisitions without a finally-release: ${findings.length}`);
for (const f of findings) console.log(`  ${f.file}:${f.line}  ${f.resource} — ${f.why}`);
process.exitCode = findings.length ? 1 : 0;
