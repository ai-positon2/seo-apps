#!/usr/bin/env node
/**
 * Detector 2 — unguarded await in an Express async route handler.
 *
 * This repo runs Express 4.22. Express 4 does NOT catch a rejected promise
 * returned by a handler: it never reaches next(), so the global error handler
 * in server.js never sees it, no response is written, and the request hangs
 * until the client times out. (Auto-forwarding arrived in Express 5.)
 *
 * Three things the first draft got wrong, all found by reading the hits:
 *
 *   1. Most routers here wrap handlers in a local `wrap()` / `wrapStep()`
 *      helper that does .catch(...). Those are guarded. Wrapped handlers are
 *      reported separately, naming the wrapper, so the wrapper itself can be
 *      confirmed once instead of per route.
 *   2. Nested async callbacks (`runWithConcurrency(urls, n, async (u) => ...)`)
 *      were being reported as if they were the handler. An await inside a
 *      nested async function belongs to that function, not to the handler.
 *   3. A `try` with only a `finally` does not swallow a rejection, so it is
 *      not treated as a guard.
 *
 * Still a heuristic. Confirm every hit by reading the handler.
 */
const fs = require('fs');
const path = require('path');
const { blank } = require('./lib/blank');

const ROOT = path.resolve(__dirname, '../..');
const SLASH = String.fromCharCode(47);
const toPosix = (p) => p.split(path.sep).join(SLASH);

const TARGETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['server/routes', 'server/middleware'];

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Blank comment and string bodies, preserving offsets and newlines. */


function matchPair(src, open, oc, cc) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === oc) depth++;
    else if (src[i] === cc) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
const matchBrace = (src, open) => matchPair(src, open, '{', '}');
const matchParen = (src, open) => matchPair(src, open, '(', ')');

/** Body span of the async function whose `async` keyword starts at `at`. */
function asyncBody(src, at) {
  let i = at + 5; // past 'async'
  while (i < src.length && /\s/.test(src[i])) i++;
  if (src.startsWith('function', i)) {
    i += 8;
    while (i < src.length && /[\s\w$]/.test(src[i]) && src[i] !== '(') i++;
  }
  if (src[i] === '(') {
    const pEnd = matchParen(src, i);
    if (pEnd === -1) return null;
    i = pEnd + 1;
  } else {
    while (i < src.length && /[\w$]/.test(src[i])) i++; // single bare param
  }
  while (i < src.length && (/\s/.test(src[i]) || src[i] === '=' || src[i] === '>')) i++;
  if (src[i] !== '{') return null; // concise arrow body — no statements to guard
  const close = matchBrace(src, i);
  return close === -1 ? null : [i, close];
}

/** Spans of try blocks that have a catch. try/finally alone does not guard. */
function guardedSpans(src, from, to) {
  const spans = [];
  const region = src.slice(from, to);
  for (const m of region.matchAll(/\btry\s*\{/g)) {
    const open = from + m.index + m[0].length - 1;
    const close = matchBrace(src, open);
    if (close === -1) continue;
    if (/^\s*catch\b/.test(src.slice(close + 1, close + 40))) spans.push([open, close]);
  }
  return spans;
}

const direct = [];   // handler passed straight to router.METHOD — real risk
const wrapped = [];  // handler passed through a wrapper call — verify wrapper
const files = [];
for (const t of TARGETS) {
  const abs = path.join(ROOT, t);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs, files);
  else if (fs.existsSync(abs)) files.push(abs);
}

for (const file of files) {
  const src = blank(fs.readFileSync(file, 'utf8'));
  const rel = toPosix(path.relative(ROOT, file));
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;

  for (const m of src.matchAll(/\b(?:router|app)\.(get|post|put|patch|delete|use|all)\s*\(/g)) {
    const callOpen = m.index + m[0].length - 1;
    const callClose = matchParen(src, callOpen);
    if (callClose === -1) continue;
    const routeLine = lineOf(m.index);
    const method = m[1].toUpperCase();

    // Walk the argument list, tracking paren depth relative to the call.
    // depth 1 == a direct argument; depth 2 inside an identifier(...) == wrapped.
    let depth = 1;
    for (let i = callOpen + 1; i < callClose; i++) {
      const ch = src[i];
      if (ch === '(') { depth++; continue; }
      if (ch === ')') { depth--; continue; }
      if (ch === '{' ) { const e = matchBrace(src, i); if (e !== -1) { i = e; } continue; }
      if (!src.startsWith('async', i)) continue;
      if (i > 0 && /[\w$.]/.test(src[i - 1])) continue;

      const body = asyncBody(src, i);
      if (!body) continue;
      const [bOpen, bClose] = body;

      if (depth > 1) {
        // Inside some call — a wrapper if that call is the direct argument.
        const before = src.slice(Math.max(0, i - 200), i);
        const wrapName = (before.match(/([A-Za-z_$][\w$]*)\s*\($/) || [])[1] || 'unknown';
        wrapped.push({ file: rel, line: routeLine, method, wrapper: wrapName });
        i = bClose;
        continue;
      }

      // Direct handler. Exclude awaits belonging to nested async functions.
      const nested = [];
      for (let j = bOpen + 1; j < bClose; j++) {
        if (!src.startsWith('async', j)) continue;
        if (/[\w$.]/.test(src[j - 1])) continue;
        const nb = asyncBody(src, j);
        if (nb) { nested.push(nb); j = nb[1]; }
      }
      const spans = guardedSpans(src, bOpen, bClose);
      const bad = [];
      for (const aw of src.slice(bOpen, bClose).matchAll(/\bawait\b/g)) {
        const at = bOpen + aw.index;
        if (nested.some(([s, e]) => at > s && at < e)) continue;
        if (spans.some(([s, e]) => at > s && at < e)) continue;
        bad.push(at);
      }
      if (bad.length) {
        direct.push({
          file: rel, line: routeLine, method,
          unguarded: bad.length,
          lines: bad.slice(0, 5).map(lineOf),
        });
      }
      i = bClose;
    }
  }
}

const byWrapper = {};
for (const w of wrapped) {
  const key = `${w.file} :: ${w.wrapper}`;
  byWrapper[key] = (byWrapper[key] || 0) + 1;
}

fs.writeFileSync(
  path.join(ROOT, 'error-loop/reports/async-route-guard.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), targets: TARGETS, direct, byWrapper }, null, 2),
);

console.log(`UNGUARDED direct handlers: ${direct.length}`);
for (const f of direct) {
  console.log(`  ${f.file}:${f.line}  ${f.method}  ${f.unguarded} await(s) outside try/catch, at line(s) ${f.lines.join(', ')}`);
}
console.log(`\nwrapper-guarded handlers (verify each wrapper catches):`);
for (const [k, v] of Object.entries(byWrapper).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${v.toString().padStart(3)}  ${k}`);
}
process.exitCode = direct.length ? 1 : 0;
