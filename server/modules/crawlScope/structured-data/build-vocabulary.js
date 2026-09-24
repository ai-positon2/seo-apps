#!/usr/bin/env node
// ── Regenerate vocabulary.json from a schema.org release ────────────────────
//
// The structured-data checks need to know which types and properties schema.org
// defines, what each type inherits from, and which types each property belongs
// to. The release file carries all of that (and ~1.5MB of descriptions); this
// keeps only those three things. Every layer is kept (core, pending and the
// hosted extensions), so a term Google or schema.org accepts is never flagged
// as unknown.
//
//   curl -sO https://schema.org/version/<version>/schemaorg-current-https.jsonld
//   node server/modules/crawlScope/structured-data/build-vocabulary.js <version> schemaorg-current-https.jsonld

const fs = require("node:fs");
const path = require("node:path");

const [version, file] = process.argv.slice(2);
if (!version || !file) {
  console.error("usage: build-vocabulary.js <schema.org version> <schemaorg-current-https.jsonld>");
  process.exit(1);
}

const graph = JSON.parse(fs.readFileSync(file, "utf8"))["@graph"];
const short = (ref) => {
  const id = typeof ref === "string" ? ref : ref?.["@id"];
  return typeof id === "string" && id.startsWith("schema:") ? id.slice("schema:".length) : null;
};
const list = (value) => (value === undefined ? [] : [].concat(value)).map(short).filter(Boolean);

const types = {};
const properties = {};
for (const node of graph) {
  const name = short(node["@id"]);
  if (!name) continue;
  const kinds = [].concat(node["@type"]);
  if (kinds.includes("rdfs:Class")) types[name] = list(node["rdfs:subClassOf"]).sort();
  else if (kinds.includes("rdf:Property")) properties[name] = list(node["schema:domainIncludes"]).sort();
}

const sorted = (object) => Object.fromEntries(Object.keys(object).sort().map((key) => [key, object[key]]));
const out = {
  version,
  source: `https://schema.org/version/${version}/schemaorg-current-https.jsonld`,
  types: sorted(types),
  properties: sorted(properties),
};
fs.writeFileSync(path.join(__dirname, "vocabulary.json"), `${JSON.stringify(out)}\n`);
console.log(`${Object.keys(types).length} types, ${Object.keys(properties).length} properties`);
