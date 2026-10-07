// ── No white text on --nav-bg-top ───────────────────────────────────────────
//
// Run: npm test --prefix client
//
// --nav-bg-top is #EDEAE2 (near-white) in the light theme. White text on it is
// unreadable: Keyword Research's selected Page Intent card and its Start
// Research button looked disabled, and table headers there read as blank.
// DataTable and CtaBand were fixed for this before; this keeps it from coming
// back anywhere. A style that paints --nav-bg-top must not set #fff/#ffffff
// text within the same few lines.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../', import.meta.url));

function* jsxFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name !== '__tests__') yield* jsxFiles(p); }
    else if (name.endsWith('.jsx')) yield p;
  }
}

// #fff, or --border (a pale grey used as text colour on the same background).
const WHITE = /color:\s*(isSelected|i === 0|on)?\s*\??\s*(['"]#fff(fff)?['"]|['"]var\(--border\)['"])/i;

test('no #fff text paired with a --nav-bg-top background', () => {
  const offenders = [];
  for (const file of jsxFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/background.*var\(--nav-bg-top\)/.test(line)) return;
      const window = lines.slice(Math.max(0, i - 6), i + 8);
      if (window.some(l => WHITE.test(l))) offenders.push(`${relative(SRC, file)}:${i + 1}`);
    });
  }
  // Header rows that pull a shared `th` style: check that style object too.
  for (const file of jsxFiles(SRC)) {
    const src = readFileSync(file, 'utf8');
    if (/<tr style=\{\{ background: 'var\(--nav-bg-top\)' \}\}>[\s\S]{0,80}<th style=\{th\}/.test(src) && /const th = \{[^}]*color: '#fff'/.test(src)) {
      offenders.push(`${relative(SRC, file)}: shared th style`);
    }
  }
  assert.deepStrictEqual(offenders, []);
});
