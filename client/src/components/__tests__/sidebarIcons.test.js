// ── Every sidebar tool has an icon ──────────────────────────────────────────
//
// Run: npm test --prefix client
//
// The sidebar looks a tool's icon up by its id in MacWindow's TOOL_ICONS. A
// tool with no entry renders without one and sits out of line with the rest:
// "AI Visibility" (id ai-visibility-lite, while the map only had the hidden
// scraped ai-visibility) and "Content Writer" both did. MacWindow is JSX, which
// node --test cannot import, so the map's keys are read from the source.

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { NAV_GROUPS } from '../../toolsMeta.js';

const source = readFileSync(new URL('../MacWindow.jsx', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('const TOOL_ICONS = {'), source.indexOf('\n};', source.indexOf('const TOOL_ICONS = {')));
const iconIds = new Set([...block.matchAll(/^ {2}'([a-z0-9-]+)':/gm)].map(m => m[1]));

test('the TOOL_ICONS block was found and parsed', () => {
  assert.ok(iconIds.size > 5, `parsed only ${iconIds.size} icon ids`);
});

test('every tool shown in the sidebar has an icon', () => {
  const missing = NAV_GROUPS.flatMap(g => g.tools).filter(t => !iconIds.has(t.id)).map(t => t.id);
  assert.deepStrictEqual(missing, []);
});
