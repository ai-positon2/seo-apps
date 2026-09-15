#!/usr/bin/env node
/**
 * Detector 9 (Round 3, Pass E) — caller-controlled input reaching something
 * consequential.
 *
 * Two classes, both of which this app is structurally exposed to because its
 * whole purpose is fetching URLs somebody typed and writing files named after
 * things somebody typed:
 *
 *   ssrf   an outbound fetch/axios/puppeteer.goto whose URL derives from
 *          req.body / req.query / req.params without passing an SSRF guard.
 *          The repo HAS a guard (modules/crawlScope/net/egress.js's
 *          assertPublicUrl / isPublicAddress, tested in crawlScope's suite), so
 *          the question is which call sites use it.
 *
 *   path   a filesystem path built by interpolating request input, which is
 *          path traversal unless the segment is validated. The record store
 *          validates table and column identifiers; the file-backed modules
 *          build paths from ids.
 *
 * Reports call sites for reading. It cannot see whether a value was validated
 * three functions earlier, so every hit needs the trace walked by hand.
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



const OUTBOUND = /\b(?:axios\.(?:get|post|put|patch|delete|request)|fetch|undici\.request|\.goto)\s*\(/g;
const FSWRITE  = /\bfs(?:Sync)?\.(?:promises\.)?(?:readFile|writeFile|appendFile|unlink|rm|mkdir|createReadStream|createWriteStream|open)\s*\(/g;
const GUARDS   = /assertPublicUrl|isPublicAddress|normalizeOrigin|urlSafety|UnsafeUrlError|assertSafe|isSafeUrl/;
const REQIN    = /\breq\.(?:body|query|params)\b/;

const ssrf = [];
const paths = [];
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
  const fileGuarded = GUARDS.test(src);

  // Only files that actually touch request input can carry request-derived data.
  if (!REQIN.test(src)) continue;

  // The guard window is BACKWARD-only and excludes import lines.
  //
  // The first version looked ±400 characters and treated any mention of a guard
  // name as protection. In the self-test that meant the `const { assertPublicUrl }
  // = require(...)` line at the top of the file sat inside the window of an
  // unguarded handler below it, so the one case the detector exists to catch was
  // silently skipped and it reported zero. A guard has to run BEFORE the call to
  // be a guard, and a require is not a call.
  const stripRequires = (t) => t.replace(/^.*\brequire\s*\(.*$/gm, ' ');
  for (const m of src.matchAll(OUTBOUND)) {
    const before = stripRequires(src.slice(Math.max(0, m.index - 700), m.index));
    const after = src.slice(m.index, m.index + 200);
    if (!REQIN.test(before + after)) continue;
    if (GUARDS.test(before)) continue;
    ssrf.push({ file: rel, line: lineOf(m.index), fileHasGuardSomewhere: fileGuarded });
  }

  for (const m of src.matchAll(FSWRITE)) {
    const near = src.slice(Math.max(0, m.index - 300), m.index + 300);
    if (!REQIN.test(near)) continue;
    paths.push({ file: rel, line: lineOf(m.index) });
  }
}

fs.writeFileSync(
  path.join(ROOT, 'error-loop/reports/ssrf-paths.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), targets: TARGETS, ssrf, paths }, null, 2),
);

console.log(`outbound calls near request input with no guard in view: ${ssrf.length}`);
for (const f of ssrf) console.log(`  ${f.file}:${f.line}${f.fileHasGuardSomewhere ? '   (file does guard elsewhere)' : ''}`);
console.log(`\nfilesystem calls near request input: ${paths.length}`);
for (const f of paths) console.log(`  ${f.file}:${f.line}`);
process.exitCode = 0;
