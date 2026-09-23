const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { build } = require("../../../../audit-loop/rules/sync-rule-classes");

// audit-loop/rules/rule-classes.json is the validation loop's copy of every
// rule id and severity. A rule added to the catalog but missing there is never
// validated, so the two are kept in lockstep: regenerate with
// `node audit-loop/rules/sync-rule-classes.js` after changing the catalog.
test("rule-classes.json matches issue-catalog.json", () => {
  const file = path.join(__dirname, "../../../../audit-loop/rules/rule-classes.json");
  const text = fs.readFileSync(file, "utf8");
  const expected = build(require("../issue-catalog.json"), JSON.parse(text), text);
  assert.ok(expected === text, "rule-classes.json is stale; run node audit-loop/rules/sync-rule-classes.js");
});
