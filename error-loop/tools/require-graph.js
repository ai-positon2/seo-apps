#!/usr/bin/env node
/**
 * Detector 1 — CommonJS link integrity for server/.
 *
 * Two classes of defect, both invisible to `node --check` and to the test
 * suite (an unreachable branch never loads its module):
 *
 *   unresolved  require('./x') where ./x resolves to no file on disk
 *   no-export   const { foo } = require('./bar') where bar never exports foo
 *
 * Comments are blanked before scanning. The first draft of this detector
 * reported a require that only ever appeared inside a `//` comment, and an
 * export list whose every other name was swallowed by an overlapping-match
 * bug, so both are guarded against below: exports are parsed by walking
 * braces and splitting on top-level commas, never by a global regex.
 *
 * A miss is reported only when the target's exports are statically knowable.
 * A module that assembles its exports dynamically is skipped, not guessed at.
 */
const fs = require('fs');
const path = require('path');
const { blank } = require('./lib/blank');

const ROOT = path.resolve(__dirname, '../..');
const SERVER = path.join(ROOT, 'server');
const SLASH = String.fromCharCode(47);
const toPosix = (p) => p.split(path.sep).join(SLASH);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * Replace comment bodies with spaces, preserving length and newlines so every
 * byte offset and line number computed afterwards still refers to the real file.
 * Tracks string and template literals so a `//` inside a URL is left alone.
 */
// blankComments() is ./lib/blank — shared so a regex-unaware lexer cannot
// silently under-report. See that file.
const blankComments = blank;


function resolve(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const tries = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  for (const t of tries) {
    try { if (fs.statSync(t).isFile()) return t; } catch {}
  }
  return null;
}

/** Split on commas that sit at brace/bracket/paren depth 0. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let buf = '';
  for (const ch of body) {
    if ('{[('.includes(ch)) depth++;
    else if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  return parts;
}

/** The text between the brace at `open` and its match, or null. */
function braceBody(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

/**
 * A binding name from one entry of an object literal or destructuring pattern.
 * `foo` -> foo, `foo: bar` -> foo (export side) , `...rest` -> null.
 */
function bindingName(entry) {
  const t = entry.trim();
  if (!t || t.startsWith('...')) return null;
  const key = t.split(':')[0].trim().replace(/^(async\s+)?/, '').replace(/\(.*$/, '').trim();
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : null;
}

/** Statically knowable export names of a CommonJS module, or null if dynamic. */
const exportCache = new Map();
function exportsOf(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  let result = null;
  try {
    if (file.endsWith('.json')) {
      result = Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')));
    } else {
      const src = blankComments(fs.readFileSync(file, 'utf8'));
      const names = new Set();

      // module.exports = { ... }  — the dominant shape in this repo
      const assign = src.match(/module\.exports\s*=\s*\{/);
      let sawObjectLiteral = false;
      if (assign) {
        const body = braceBody(src, assign.index + assign[0].length - 1);
        if (body !== null) {
          sawObjectLiteral = true;
          for (const part of splitTopLevel(body)) {
            const name = bindingName(part);
            if (name) names.add(name);
          }
        }
      }

      // module.exports.foo = ... / exports.foo = ...
      for (const m of src.matchAll(/(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g)) {
        names.add(m[1]);
      }

      // Shapes we cannot read statically. If one is present and we never saw a
      // readable object literal, the module's surface is unknown -> skip it.
      const opaque = /module\.exports\s*=\s*(?!\{)/.test(src)
        || /Object\.assign\(\s*module\.exports/.test(src)
        || /module\.exports\[/.test(src);

      result = (opaque && !sawObjectLiteral) ? null : (names.size ? [...names] : null);
    }
  } catch { result = null; }
  exportCache.set(file, result);
  return result;
}

const unresolved = [];
const noExport = [];

for (const file of walk(SERVER)) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = blankComments(raw);
  const rel = toPosix(path.relative(ROOT, file));

  for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    const line = src.slice(0, m.index).split('\n').length;
    const target = resolve(file, spec);
    if (!target) { unresolved.push({ file: rel, line, spec }); continue; }

    // Look backwards for a destructuring pattern binding this require.
    // The character class excludes braces deliberately: a greedy [\s\S]* here
    // runs backwards past the previous statement and attributes the previous
    // require's names to this one. Excluding '}' pins the match to the nearest
    // closing brace, while still spanning newlines for multi-line patterns.
    const before = src.slice(Math.max(0, m.index - 600), m.index);
    const destr = before.match(/(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*$/);
    if (!destr) continue;
    const names = splitTopLevel(destr[1]).map(bindingName).filter(Boolean);
    const have = exportsOf(target);
    if (!have) continue; // dynamic exports — not knowable, do not guess
    for (const n of names) {
      if (!have.includes(n)) {
        noExport.push({
          file: rel, line, name: n,
          from: toPosix(path.relative(ROOT, target)),
        });
      }
    }
  }
}

const report = { generatedAt: new Date().toISOString(), unresolved, noExport };
fs.writeFileSync(
  path.join(ROOT, 'error-loop/reports/require-graph.json'),
  JSON.stringify(report, null, 2),
);

console.log(`unresolved requires: ${unresolved.length}`);
for (const u of unresolved) console.log(`  ${u.file}:${u.line}  require('${u.spec}')`);
console.log(`missing named exports: ${noExport.length}`);
for (const n of noExport) console.log(`  ${n.file}:${n.line}  { ${n.name} } not exported by ${n.from}`);
process.exitCode = unresolved.length || noExport.length ? 1 : 0;
