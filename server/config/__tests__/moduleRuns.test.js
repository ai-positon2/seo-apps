// ── Tests for the in-module run display ─────────────────────────────────────
// Recording a run and showing it are two halves of one feature, and only one
// half is enforced by the server. This guards the other half: a tool that
// records runs but shows them on no page, or a page whose panel points at a
// tool id nothing ever records — both look, in the product, exactly like "this
// tool has never been run".
//
// The client has no test runner of its own, so the check lives next to the
// registry it is checking against (server/config/runTracking.js) and reads the
// pages as text. Run: node config/__tests__/moduleRuns.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { TRACKED_TOOL_IDS } = require('../runTracking');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}

const PAGES_DIR = path.join(__dirname, '../../../client/src/pages');
const COMPONENT = path.join(__dirname, '../../../client/src/components/ModuleRuns.jsx');

// Every <ModuleRuns toolId="…"> in the tool pages, with the page it sits on.
function declaredPanels() {
  const panels = [];
  for (const file of fs.readdirSync(PAGES_DIR).filter(f => f.endsWith('.jsx'))) {
    const source = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8');
    const re = /<ModuleRuns[\s\S]{0,600}?toolId="([^"]+)"/g;
    let m;
    while ((m = re.exec(source)) !== null) panels.push({ file, toolId: m[1] });
  }
  return panels;
}

console.log('In-module run display');

test('every tracked tool shows its runs on at least one page', () => {
  const shown = new Set(declaredPanels().map(p => p.toolId));
  const missing = TRACKED_TOOL_IDS.filter(id => !shown.has(id));
  assert.deepStrictEqual(missing, [], `tools recording runs that no page displays: ${missing.join(', ')}`);
});

test('every panel points at a tool that actually records runs', () => {
  const unknown = declaredPanels().filter(p => !TRACKED_TOOL_IDS.includes(p.toolId));
  assert.deepStrictEqual(
    unknown.map(p => `${p.file} → ${p.toolId}`), [],
    'panels filtered to a tool id nothing records would always look empty',
  );
});

test('a panel that imports the component is the only way runs get rendered', () => {
  // A page with the JSX but no import fails at build; a page with the import
  // and no JSX is dead weight. Both are cheap to catch here.
  for (const file of fs.readdirSync(PAGES_DIR).filter(f => f.endsWith('.jsx'))) {
    const source = fs.readFileSync(path.join(PAGES_DIR, file), 'utf8');
    const hasImport = /import ModuleRuns from/.test(source);
    const hasJsx = /<ModuleRuns/.test(source);
    assert.strictEqual(hasImport, hasJsx, `${file}: import and use of ModuleRuns disagree`);
  }
});

test('the panel is hidden from public platform embeds', () => {
  // Embed sessions share one synthetic user and workspace, so listing runs
  // there would show one visitor the inputs of every other visitor.
  const source = fs.readFileSync(COMPONENT, 'utf8');
  assert.ok(/EMBED_MODE/.test(source), 'ModuleRuns must not render in EMBED_MODE');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
