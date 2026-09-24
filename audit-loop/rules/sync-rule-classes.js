#!/usr/bin/env node
// ── Keep rule-classes.json in step with the rule catalog ────────────────────
//
// rule-classes.json is the audit loop's map of every rule the crawler can emit:
// its severity, how it can be evaluated (a single crawl, Search Console, ...)
// and how often it should fire on a real site. The ids and severities are a
// copy of server/modules/crawlScope/issue-catalog.json, and a copy drifts: a
// rule added to the catalog but not here is a rule the validation loop never
// asks about, and a severity changed in one place but not the other makes the
// loop grade the wrong thing.
//
// This regenerates the file from the catalog. `class` and `rarity` are not in
// the catalog, so they are carried over from the existing file; a rule new to
// the catalog takes them from NEW_RULES below, and the script refuses to run
// until one is given, rather than guessing.
//
//   node audit-loop/rules/sync-rule-classes.js          rewrite the file
//   node audit-loop/rules/sync-rule-classes.js --check  exit 1 if it is stale
//
// The layout (aligned columns, one rule per line, grouped by category, errors
// first) is reproduced exactly, so a sync that changes nothing leaves the file
// byte-identical.

const fs = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "rule-classes.json");
const CATALOG = path.join(__dirname, "../../server/modules/crawlScope/issue-catalog.json");

// class / rarity for rules that do not yet appear in rule-classes.json.
const NEW_RULES = {
  "canonical-to-http": { class: "crawl", rarity: "rare" },
  "sitemap-http-url": { class: "crawl", rarity: "occasional" },
  "broken-internal-image": { class: "crawl", rarity: "common" },
  "broken-internal-resource": { class: "crawl", rarity: "occasional" },
  "soft-404-site": { class: "crawl", rarity: "occasional" },
  "soft-404": { class: "crawl", rarity: "occasional" },
  "crawl-blocked": { class: "crawl", rarity: "occasional" },
  "sitemap-too-large": { class: "crawl", rarity: "rare" },
  "sitemap-off-host": { class: "crawl", rarity: "occasional" },
  "multiple-canonical": { class: "crawl", rarity: "occasional" },
  "canonical-outside-head": { class: "crawl", rarity: "rare" },
  "hreflang-conflict": { class: "crawl", rarity: "rare" },
  "hreflang-target-invalid": { class: "crawl", rarity: "occasional" },
  "hreflang-x-default-missing": { class: "crawl", rarity: "occasional" },
  "html-lang-missing": { class: "crawl", rarity: "occasional" },
  "title-short": { class: "crawl", rarity: "common" },
  "html-too-large": { class: "crawl", rarity: "rare" },
  "html-uncompressed": { class: "crawl", rarity: "occasional" },
  "url-too-long": { class: "crawl", rarity: "occasional" },
  "url-underscore": { class: "crawl", rarity: "occasional" },
  "url-too-many-parameters": { class: "crawl", rarity: "occasional" },
  "charset-missing": { class: "crawl", rarity: "occasional" },
  "doctype-missing": { class: "crawl", rarity: "rare" },
  "too-many-links": { class: "crawl", rarity: "rare" },
};

const GROUPS = [
  ["indexability", "Indexability"],
  ["technical", "Technical"],
  ["metadata", "Metadata"],
  ["accessibility_social", "Accessibility & Social"],
  ["content", "Content"],
  ["links", "Links"],
  ["performance", "Performance"],
  ["structured_data", "Structured Data"],
];
const SEVERITY_ORDER = ["error", "warning", "notice"];

// The columns each group's rules are aligned to, read from the existing file:
// they were aligned by hand, per group, so they are measured rather than
// recomputed. A group only widens when a new id needs more room.
function existingColumns(text) {
  const columns = new Map();
  let group = null;
  for (const line of text.split("\n")) {
    const heading = /^ {2}"([a-z_]+)": \{$/.exec(line);
    if (heading) {
      group = heading[1];
      continue;
    }
    if (!group || columns.has(group) || !line.includes('{ "sev"')) continue;
    columns.set(group, {
      brace: line.indexOf('{ "sev"'),
      cls: line.indexOf('"class"'),
      rarity: line.indexOf('"rarity"'),
    });
  }
  return columns;
}

function build(catalog, current, currentText = "") {
  const columns = existingColumns(currentText);
  const known = new Map();
  // Position in the existing file. Rules keep the order they were written in
  // (within a severity), and a new rule goes at the end of its severity block.
  const position = new Map();
  for (const [group, rules] of Object.entries(current)) {
    if (group === "_meta") continue;
    for (const [id, entry] of Object.entries(rules)) {
      known.set(id, entry);
      position.set(id, position.size);
    }
  }

  const missing = [];
  const grouped = new Map(GROUPS.map(([key]) => [key, []]));
  for (const rule of catalog) {
    const group = GROUPS.find(([, category]) => category === rule.category)?.[0];
    if (!group) throw new Error(`${rule.id}: no rule-classes group for category "${rule.category}"`);
    const previous = known.get(rule.id) || NEW_RULES[rule.id];
    if (!previous) {
      missing.push(rule.id);
      continue;
    }
    grouped.get(group).push({ id: rule.id, sev: rule.severity, class: previous.class, rarity: previous.rarity });
  }
  if (missing.length) {
    throw new Error(
      `No class/rarity for ${missing.join(", ")}. Add them to NEW_RULES in ${path.basename(__filename)}.`,
    );
  }

  const counts = { error: 0, warning: 0, notice: 0 };
  for (const rule of catalog) counts[rule.severity] = (counts[rule.severity] || 0) + 1;
  const meta = { ...current._meta, total: catalog.length, severity_counts: counts };

  const metaLines = JSON.stringify(meta, null, 2).split("\n");
  // severity_counts is written on one line.
  const compactCounts = `"severity_counts": { ${Object.entries(counts).map(([k, v]) => `"${k}": ${v}`).join(", ")} }`;
  const metaText = metaLines
    .join("\n")
    .replace(/"severity_counts": \{[\s\S]*?\n  \}/, compactCounts)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join("\n");

  const sections = GROUPS.map(([key]) => {
    const at = (id) => (position.has(id) ? position.get(id) : Number.POSITIVE_INFINITY);
    const rules = grouped.get(key).sort(
      (a, b) =>
        SEVERITY_ORDER.indexOf(a.sev) - SEVERITY_ORDER.indexOf(b.sev)
        || at(a.id) - at(b.id)
        || a.id.localeCompare(b.id),
    );
    const measured = columns.get(key) || {};
    // Column of "{", of "class" and of "rarity": the widest of what the file
    // already used and what the longest value in this group needs.
    const brace = Math.max(measured.brace || 0, 4 + Math.max(...rules.map((r) => r.id.length)) + 4);
    const clsAt = Math.max(
      (measured.cls || 0) - (measured.brace || 0),
      '{ "sev": '.length + Math.max(...rules.map((r) => r.sev.length)) + 4,
    );
    const rarityAt = Math.max(
      (measured.rarity || 0) - (measured.cls || 0),
      '"class": '.length + Math.max(...rules.map((r) => r.class.length)) + 4,
    );
    const lines = rules.map((r, index) => {
      const head = `    "${r.id}":`.padEnd(brace);
      const sev = `{ "sev": "${r.sev}",`.padEnd(clsAt);
      const cls = `"class": "${r.class}",`.padEnd(rarityAt);
      const comma = index === rules.length - 1 ? "" : ",";
      return `${head}${sev}${cls}"rarity": "${r.rarity}" }${comma}`;
    });
    return `  "${key}": {\n${lines.join("\n")}\n  }`;
  });

  return `{\n  "_meta": ${metaText},\n\n${sections.join(",\n\n")}\n}\n`;
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
  const currentText = fs.readFileSync(FILE, "utf8");
  const next = build(catalog, JSON.parse(currentText), currentText);
  if (process.argv.includes("--check")) {
    if (next !== currentText) {
      console.error("rule-classes.json is out of date with issue-catalog.json; run node audit-loop/rules/sync-rule-classes.js");
      process.exit(1);
    }
    return;
  }
  fs.writeFileSync(FILE, next);
}

if (require.main === module) main();

module.exports = { build };
