#!/usr/bin/env node
/**
 * Detector 7 — client API calls with no matching Express route.
 *
 * The highest-yield check for a repo mid-merge: a route that moved or was
 * renamed leaves the client calling a path that no longer exists. Nothing fails
 * at build time (the client is plain JSX, the call is a template literal), and
 * nothing fails in the test suite (no test issues HTTP). The first sign is a
 * button that does nothing in production.
 *
 * Since server.js now answers an unmatched /api/* with a JSON 404 rather than
 * the SPA shell, such a call surfaces as "Unknown API endpoint" at runtime —
 * still only when someone clicks it.
 *
 * Method:
 *   1. Build the server's route table: every `app.use('/prefix', …, router)` in
 *      server.js, resolved to its router file, plus `router.use('/sub',
 *      require('./x'))` mounts one level down.
 *   2. Build the client's call table: each `client/src/lib/*.js` module's BASE
 *      constant plus every fetch() path expression in it.
 *   3. Normalise both to a comparable shape — `:param` and `${expr}` both become
 *      `*` — and report client paths that match no server route.
 *
 * Dynamic segments make this approximate, so it reports rather than concludes.
 */
const fs = require('fs');
const path = require('path');
// Comments-only: this detector's whole subject is the CONTENT of string
// literals (route paths, BASE constants, fetch URLs). Blanking strings makes
// it read empty quotes and report a confident zero — which it did.
const { blankComments: blank } = require('./lib/blank');

const ROOT = path.resolve(__dirname, '../..');
const toPosix = (p) => p.split(path.sep).join(String.fromCharCode(47));



const norm = (p) => {
  let s = p
    .replace(/\$\{[^}]*\}/g, '*')   // client interpolation
    .replace(/:[A-Za-z_][\w]*/g, '*') // express param
    .split('?')[0]
    .replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
};

// ── 1. Server route table ───────────────────────────────────────────────────
const serverSrc = blank(fs.readFileSync(path.join(ROOT, 'server/server.js'), 'utf8'));

// requireName -> relative router file
const required = new Map();
for (const m of serverSrc.matchAll(/(?:const|let)\s+\{?\s*([\w\s,:]+?)\s*\}?\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
  const spec = m[2];
  for (const raw of m[1].split(',')) {
    const name = raw.includes(':') ? raw.split(':')[1].trim() : raw.trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) required.set(name, spec);
  }
}

function resolveRouter(spec, fromDir) {
  const base = path.resolve(fromDir, spec);
  for (const t of [base + '.js', path.join(base, 'index.js'), base]) {
    try { if (fs.statSync(t).isFile()) return t; } catch {}
  }
  return null;
}

function routesIn(file, prefix, out, depth = 0) {
  if (!file || depth > 2) return out;
  let src;
  try { src = blank(fs.readFileSync(file, 'utf8')); } catch { return out; }
  for (const m of src.matchAll(/\brouter\.(get|post|put|patch|delete|all)\s*\(\s*(['"`])([^'"`]*)\2/g)) {
    out.push({ method: m[1].toUpperCase(), path: norm(prefix + m[3]) });
  }
  // Sub-routers mounted one level down.
  for (const m of src.matchAll(/\brouter\.use\s*\(\s*(['"`])([^'"`]+)\1\s*,\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const sub = resolveRouter(m[3], path.dirname(file));
    routesIn(sub, prefix + m[2], out, depth + 1);
  }
  return out;
}

const serverRoutes = [];
for (const m of serverSrc.matchAll(/app\.use\(\s*(['"`])(\/api\/[^'"`]*)\1\s*,([^;]*?)\)\s*;/g)) {
  const prefix = m[2].replace(/\/$/, '');
  const args = m[3];
  const names = [...args.matchAll(/([A-Za-z_$][\w$]*)/g)].map((x) => x[1]);
  for (const name of names.reverse()) {
    if (!required.has(name)) continue;
    const file = resolveRouter(required.get(name), path.join(ROOT, 'server'));
    if (file) { routesIn(file, prefix, serverRoutes); break; }
  }
}

const serverSet = new Set(serverRoutes.map((r) => `${r.method} ${r.path}`));
const serverPaths = new Set(serverRoutes.map((r) => r.path));

// ── 2. Client call table ────────────────────────────────────────────────────
const LIB = path.join(ROOT, 'client/src/lib');
const calls = [];
for (const name of fs.readdirSync(LIB).filter((f) => f.endsWith('.js'))) {
  const file = path.join(LIB, name);
  const src = blank(fs.readFileSync(file, 'utf8'));
  const rel = toPosix(path.relative(ROOT, file));
  const baseM = src.match(/const\s+BASE\s*=\s*['"`]([^'"`]+)['"`]/);
  const BASE = baseM ? baseM[1].replace(/\/$/, '') : null;
  const lineOf = (i) => src.slice(0, i).split('\n').length;

  // Read the first argument of a call as a literal, handling a template
  // literal whose ${...} holds quotes or nested backticks. A plain
  // [^'"`]* capture stopped at the first nested backtick and produced
  // half-paths like `/api/…/prompts${qs `.
  function firstArgLiteral(from) {
    let i = from;
    while (i < src.length && /\s/.test(src[i])) i++;
    const q = src[i];
    if (q !== "'" && q !== '"' && q !== '`') return null;
    i++;
    let out = '';
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
      if (q === '`' && c === '$' && src[i + 1] === '{') { depth++; out += '${'; i += 2; continue; }
      if (depth > 0) {
        if (c === '{') depth++;
        else if (c === '}') { depth--; out += '}'; i++; continue; }
        out += c; i++; continue;
      }
      if (c === q) return out;
      if (c === '\n' && q !== '`') return null;
      out += c;
      i++;
    }
    return null;
  }

  // Two conventions live side by side in this directory and they must not be
  // conflated. crawlScopeApi's helper does fetch(`${BASE}${path}`) and its call
  // sites pass a RELATIVE path; aiVisibilityApi's helper does fetch(path) and
  // its call sites pass the FULL path including ${BASE}. Prepending BASE to both
  // produced doubled prefixes like /api/ai-visibility*/*/report.
  const resolvePath = (litRaw) => {
    let p = litRaw;
    if (p.includes('${BASE}')) return norm(p.split('${BASE}').join(BASE ?? ''));
    if (p.startsWith('/api')) return norm(p);
    if (p.startsWith('/') && BASE) return norm(BASE + p);
    return null;
  };

  const methodNear = (at) => {
    const after = src.slice(at, at + 300);
    const mm = after.match(/method\s*:\s*['"`](GET|POST|PUT|PATCH|DELETE)['"`]/i);
    return (mm ? mm[1] : 'GET').toUpperCase();
  };

  for (const m of src.matchAll(/\b(?:fetch|req|api|call|request)\s*\(/g)) {
    const lit = firstArgLiteral(m.index + m[0].length);
    if (lit === null) continue;
    const p = resolvePath(lit);
    if (!p || !p.startsWith('/api')) continue;
    calls.push({ file: rel, line: lineOf(m.index), method: methodNear(m.index), path: p, raw: lit });
  }
}

// Compare segment-wise, with a server '*' matching any single client segment.
// A literal match is not enough: an Express `:param` is a wildcard, and this
// repo also generates routes in loops —
//   for (const decision of ['approve','reject'])
//     router.post(`/:projectId/domains/:domainId/${decision}`, …)
// which normalises to /*/domains/*/* while the client calls …/domains/*/approve.
// Comparing strings reported every such route as missing.
const serverSegs = serverRoutes.map((r) => ({ ...r, segs: r.path.split('/') }));

function matches(clientPath, method) {
  const cs = clientPath.split('/');
  return serverSegs.some((r) => {
    if (r.method !== method) return false;
    if (r.segs.length !== cs.length) return false;
    return r.segs.every((s, i) => s === '*' || cs[i] === '*' || s === cs[i]);
  });
}
function pathExists(clientPath) {
  const cs = clientPath.split('/');
  return serverSegs.some((r) =>
    r.segs.length === cs.length && r.segs.every((s, i) => s === '*' || cs[i] === '*' || s === cs[i]));
}

// A helper DEFINITION — fetch(`${BASE}${path}`) — is not a call site.
const isHelperDef = (raw) => /^\$\{BASE\}\$\{[A-Za-z_$][\w$]*\}$/.test(raw.trim());
// Residue from a ternary inside a template literal (`${qs ? `?${qs}` : ''}`).
const hasResidue = (p) => /[`'"{}]|\s:\s/.test(p);

const missing = [];
const skipped = [];
for (const c of calls) {
  if (isHelperDef(c.raw)) { skipped.push({ ...c, why: 'helper definition' }); continue; }
  if (hasResidue(c.path)) { skipped.push({ ...c, why: 'unparsed template expression' }); continue; }
  if (matches(c.path, c.method)) continue;
  if (pathExists(c.path)) continue; // path exists, method was inferred — not a finding
  missing.push(c);
}

fs.writeFileSync(
  path.join(ROOT, 'error-loop/reports/api-contract.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    serverRouteCount: serverRoutes.length,
    clientCallCount: calls.length,
    missing,
    skipped,
  }, null, 2),
);

console.log(`server routes discovered: ${serverRoutes.length}`);
console.log(`client API calls found:   ${calls.length}`);
console.log(`\nclient calls with NO matching server path: ${missing.length}`);
for (const c of missing) console.log(`  ${c.file}:${c.line}  ${c.method} ${c.path}`);
process.exitCode = missing.length ? 1 : 0;
