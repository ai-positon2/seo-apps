#!/usr/bin/env node
// Detector 3 - req.params.X read by a handler whose route path never declares :X.
// Always undefined at runtime, so the handler silently works on a missing value
// instead of failing loudly. Comment/string aware.
const fs = require('fs');
const path = require('path');
const { blank } = require('./lib/blank');
const ROOT = path.resolve(__dirname, '../..');
const toPosix = (p) => p.split(path.sep).join(String.fromCharCode(47));
const TARGETS = process.argv.slice(2).length ? process.argv.slice(2) : ['server/routes'];

function walk(dir, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

function matchParen(src, open) {
  let d = 0;
  for (let i = open; i < src.length; i++) { if (src[i]==='(') d++; else if (src[i]===')'){d--; if(!d) return i;} }
  return -1;
}
const findings = [];
const files = [];
for (const t of TARGETS) {
  const abs = path.join(ROOT, t);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) walk(abs, files);
  else if (fs.existsSync(abs)) files.push(abs);
}
for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const src = blank(raw);
  const rel = toPosix(path.relative(ROOT, file));
  // The route PATH is matched against the raw source, the body against the
  // blanked one. The shared lexer blanks string bodies (it must, so a `//` or a
  // brace inside a string cannot desynchronise it), and this detector's whole
  // input is a string literal — matched against the blanked text the path came
  // back as '        ' and every route read as declaring no parameters at all.
  // Offsets are identical between the two, so an index from `raw` indexes `src`.
  const re = /\b(?:router|app)\.(get|post|put|patch|delete|all)\s*\(\s*(['"])([^'"]*)\2/g;
  for (const m of raw.matchAll(re)) {
    const routePath = m[3];
    const open = src.indexOf('(', m.index);
    const close = matchParen(src, open);
    if (close === -1) continue;
    const declared = new Set([...routePath.matchAll(/:([A-Za-z_$][\w$]*)/g)].map(x => x[1]));
    const body = src.slice(open, close);
    const used = new Set([...body.matchAll(/req\.params\.([A-Za-z_$][\w$]*)/g)].map(x => x[1]));
    for (const d of [...body.matchAll(/req\.params\s*(?:\|\|\s*\{\}\s*)?;?\s*$/g)]) {}
    for (const u of used) {
      if (!declared.has(u)) {
        findings.push({ file: rel, line: src.slice(0, m.index).split('\n').length, routePath, param: u, declared: [...declared] });
      }
    }
  }
}
fs.writeFileSync(path.join(ROOT, 'error-loop/reports/route-params.json'), JSON.stringify({ generatedAt: new Date().toISOString(), targets: TARGETS, findings }, null, 2));
console.log(`req.params reads with no matching route param: ${findings.length}`);
for (const f of findings) console.log(`  ${f.file}:${f.line}  '${f.routePath}' reads req.params.${f.param} (declares: ${f.declared.join(', ') || 'none'})`);
process.exitCode = findings.length ? 1 : 0;
