"use strict";

// ── Structured data: read it the way Google does, and say what is wrong ─────
//
// The page's JSON-LD blocks and microdata items, checked two ways:
//
//   invalid      the markup cannot be read as schema.org: a block that does not
//                parse, has no @context or @type, a type or property schema.org
//                does not define (usually a typo or the wrong capitalisation),
//                a property on a type it does not belong to (price on Product
//                instead of its Offer), or data-vocabulary.org markup, which
//                Google stopped reading in 2020;
//   required     markup written for a Google rich result lacks a property
//                Google requires for it, so the page cannot get that result;
//   recommended  it has what is required but lacks what Google recommends.
//
// The vocabulary (vocabulary.json) is the whole of a schema.org release: core,
// pending and the hosted extensions, so nothing schema.org accepts is flagged.
// The requirements are Google's, from its Search Central documentation for
// each feature. Before this, only JSON-LD was read, seven types were checked
// by hand (a dentist among them, but no other local business), and properties
// Google only recommends (an article's image and date) were reported as
// required.

const vocabulary = require("./vocabulary.json");

// JSON.parse accepts arbitrarily deep input, so an unbounded walk over its
// output can exhaust the stack. A RangeError here would escape the per-block
// try below, and the crawler would then report a perfectly good 200 page as an
// unreachable crawl failure.
const MAX_DEPTH = 64;
const MAX_PROBLEMS = 20;
const MAX_TYPES = 20;

const TYPES = new Map(Object.entries(vocabulary.types));
const PROPERTIES = new Map(Object.entries(vocabulary.properties));

// ── The vocabulary ──────────────────────────────────────────────────────────

const ancestorsCache = new Map();
function ancestors(type) {
  if (ancestorsCache.has(type)) return ancestorsCache.get(type);
  const seen = new Set([type]);
  const stack = [type];
  while (stack.length) {
    for (const parent of TYPES.get(stack.pop()) || []) {
      if (!seen.has(parent)) {
        seen.add(parent);
        stack.push(parent);
      }
    }
  }
  ancestorsCache.set(type, seen);
  return seen;
}
const isA = (node, type) => node.types.some((t) => ancestors(t).has(type));

// "Organisation" → "Organization", "datepublished" → "datePublished": the
// nearest term, when one is near. Memoised, since a site repeats its typos on
// every page of a template.
const suggestionCache = new Map();
function suggestion(name, terms) {
  const key = `${terms === TYPES ? "t" : "p"}:${name}`;
  if (suggestionCache.has(key)) return suggestionCache.get(key);
  const lower = name.toLowerCase();
  let best = null;
  let bestDistance = name.length >= 5 ? 3 : 2;
  for (const term of terms.keys()) {
    if (term.toLowerCase() === lower) {
      best = term;
      break;
    }
    if (Math.abs(term.length - name.length) >= bestDistance) continue;
    const distance = editDistance(lower, term.toLowerCase(), bestDistance);
    if (distance < bestDistance) {
      best = term;
      bestDistance = distance;
    }
  }
  if (suggestionCache.size > 1_000) suggestionCache.clear();
  suggestionCache.set(key, best);
  return best;
}

// Levenshtein distance, giving up once it reaches `limit`.
function editDistance(a, b, limit) {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin >= limit) return limit;
    previous = current;
  }
  return previous[b.length];
}

// ── Reading the markup ──────────────────────────────────────────────────────
//
// Both syntaxes become the same nodes:
//   { types: ["Product"], foreignTypes: [], source: "JSON-LD", schema: true,
//     props: Map { "name" => ["Widget"], "offers" => [node] } }
// where `schema` says the node's terms are schema.org's.

const SCHEMA_PREFIX = /^(?:https?:\/\/schema\.org\/|schema:)/i;
const DATA_VOCABULARY = /^https?:\/\/(?:www\.)?data-vocabulary\.org\//i;

function isSchemaContext(context) {
  if (context === undefined || context === null) return null;
  const entries = Array.isArray(context) ? context : [context];
  return entries.some((entry) => {
    if (typeof entry === "string") return /^(?:https?:\/\/)?schema\.org\/?$/i.test(entry.trim());
    return Boolean(entry && typeof entry === "object" &&
      typeof entry["@vocab"] === "string" && /^https?:\/\/schema\.org\/?$/i.test(entry["@vocab"].trim()));
  });
}

// A type or property name as the vocabulary spells it, or null when it belongs
// to some other vocabulary (a prefix or a full URL that is not schema.org's).
function schemaTerm(raw, schemaContext) {
  const value = String(raw || "").trim();
  if (!value) return null;
  if (SCHEMA_PREFIX.test(value)) return value.replace(SCHEMA_PREFIX, "").replace(/\/$/, "");
  if (!schemaContext || /[:/]/.test(value)) return null;
  return value;
}

const present = (values) =>
  (values || []).some((value) =>
    value !== null && value !== undefined &&
    !(typeof value === "string" && !value.trim()));

function jsonLdNode(value, schemaContext, depth, source) {
  if (depth > MAX_DEPTH || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((item) => jsonLdNode(item, schemaContext, depth + 1, source));
  if (typeof value !== "object") return value;
  if ("@value" in value) return value["@value"];
  if ("@list" in value || "@set" in value) {
    return jsonLdNode(value["@list"] ?? value["@set"], schemaContext, depth + 1, source);
  }
  const own = isSchemaContext(value["@context"]);
  const context = own === null ? schemaContext : own;
  const rawTypes = [].concat(value["@type"] ?? []).map(String);
  const node = {
    types: [],
    foreignTypes: [],
    rawTypes,
    source,
    schema: context,
    id: typeof value["@id"] === "string" ? value["@id"] : null,
    props: new Map(),
  };
  for (const raw of rawTypes) {
    const term = schemaTerm(raw, context);
    if (term) node.types.push(term);
    else node.foreignTypes.push(raw);
  }
  for (const [key, child] of Object.entries(value)) {
    if (key.startsWith("@")) continue;
    const values = []
      .concat(jsonLdNode(child, context, depth + 1, source))
      .flat(MAX_DEPTH);
    node.props.set(key, values);
  }
  if (value["@graph"]) node.graph = [].concat(jsonLdNode(value["@graph"], context, depth + 1, source)).flat(MAX_DEPTH);
  return node;
}

// The top-level nodes of every JSON-LD block, and what could not be read.
function readJsonLd($, elements) {
  const nodes = [];
  const problems = [];
  elements.each((index, element) => {
    const raw = $(element).html()?.replace(/^\s*<!--|-->\s*$/g, "").trim();
    if (!raw) return;
    const label = `JSON-LD block ${index + 1}`;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      problems.push({ kind: "invalid", message: `${label} is invalid: ${String(error.message).replace(/\s+/g, " ").trim()}` });
      return;
    }
    for (const top of [].concat(parsed)) {
      if (!top || typeof top !== "object" || Array.isArray(top)) continue;
      const context = isSchemaContext(top["@context"]);
      if (context === null) {
        problems.push({
          kind: "invalid",
          message: `${label} has no @context, so its terms are not read as schema.org (add "@context": "https://schema.org").`,
        });
      }
      // Checked as schema.org either way, so fixing the context does not
      // reveal a second round of problems.
      const node = jsonLdNode(top, context !== false, 0, "JSON-LD");
      const members = node.graph ? node.graph.filter((member) => member && typeof member === "object") : [node];
      for (const member of members) {
        const meaningful = [...member.props.keys()].length > 0;
        if (member.schema && !member.rawTypes.length && meaningful && !member.id) {
          problems.push({ kind: "invalid", message: `${label} has an item with no @type, so nothing can tell what it describes.` });
        }
        nodes.push(member);
      }
    }
  });
  return { nodes, problems };
}

// Microdata values, per the HTML standard's rules for itemprop values.
const URL_VALUE = { a: "href", area: "href", link: "href", audio: "src", embed: "src", iframe: "src", img: "src", source: "src", track: "src", video: "src", object: "data" };
function microdataValue($, element) {
  const tag = String(element.tagName || element.name || "").toLowerCase();
  const $element = $(element);
  if (tag === "meta") return $element.attr("content") ?? "";
  if (URL_VALUE[tag]) return $element.attr(URL_VALUE[tag]) ?? "";
  if (tag === "data" || tag === "meter") return $element.attr("value") ?? "";
  if (tag === "time") return $element.attr("datetime") ?? $element.text();
  return $element.text();
}

function microdataItem($, element, depth, dataVocabulary) {
  const $element = $(element);
  const rawTypes = String($element.attr("itemtype") || "").split(/\s+/).filter(Boolean);
  const node = {
    types: [],
    foreignTypes: [],
    rawTypes,
    source: "microdata",
    schema: false,
    id: $element.attr("itemid") || null,
    props: new Map(),
  };
  for (const raw of rawTypes) {
    if (DATA_VOCABULARY.test(raw)) dataVocabulary.add(raw.replace(DATA_VOCABULARY, ""));
    const term = SCHEMA_PREFIX.test(raw) ? raw.replace(SCHEMA_PREFIX, "").replace(/\/$/, "") : null;
    if (term) node.types.push(term);
    else node.foreignTypes.push(raw);
  }
  node.schema = node.types.length > 0;
  if (depth > MAX_DEPTH) return node;
  const property = (child) => {
    const $child = $(child);
    const names = String($child.attr("itemprop") || "").split(/\s+/).filter(Boolean);
    const scoped = $child.attr("itemscope") !== undefined;
    if (names.length) {
      const value = scoped ? microdataItem($, child, depth + 1, dataVocabulary) : microdataValue($, child);
      for (const raw of names) {
        const name = SCHEMA_PREFIX.test(raw) ? raw.replace(SCHEMA_PREFIX, "") : raw;
        node.props.set(name, [...(node.props.get(name) || []), value]);
      }
    }
    // A nested item's own properties are its own.
    if (!scoped) walk(child);
  };
  const walk = (parent) => $(parent).children().each((_, child) => property(child));
  walk(element);
  // itemref="a b": properties kept elsewhere in the page, by element id.
  for (const id of String($element.attr("itemref") || "").split(/\s+/).filter(Boolean)) {
    const referenced = $("[id]").filter((_, candidate) => $(candidate).attr("id") === id).first();
    if (referenced.length) property(referenced[0]);
  }
  return node;
}

function readMicrodata($, elements) {
  const nodes = [];
  const dataVocabulary = new Set();
  elements.each((_, element) => {
    // An item that is itself a property value is read with its parent.
    if ($(element).attr("itemprop") !== undefined) return;
    nodes.push(microdataItem($, element, 0, dataVocabulary));
  });
  const problems = [...dataVocabulary].map((type) => ({
    kind: "invalid",
    message: `${type} (microdata) uses data-vocabulary.org, which Google stopped reading in 2020; mark it up with schema.org instead.`,
  }));
  return { nodes, problems };
}

// ── Google's requirements ───────────────────────────────────────────────────
//
// From Google Search Central's documentation for each rich result. `oneOf`
// lists alternatives of which at least one is required. `within` limits a
// requirement to a node reached through that parent type and property: an
// Offer needs a price as a product's offer, not as an event's. `topLevel`
// limits it to what the page is about (a top-level item, or a page's
// mainEntity): a local business named as an article's publisher is not
// asking for a local business result. `except` leaves out subtypes with
// requirements of their own.

const FEATURES = [
  { type: "LocalBusiness", topLevel: true, feature: "local business details", required: ["name", "address"], recommended: ["telephone", "url"] },
  { type: "Product", topLevel: true, feature: "product results", required: ["name"], oneOf: [["offers", "review", "aggregateRating"]], recommended: ["image"] },
  { type: "Offer", except: ["AggregateOffer"], within: ["Product", "offers"], feature: "product results", oneOf: [["price", "priceSpecification"]], recommended: ["priceCurrency", "availability"] },
  { type: "AggregateOffer", within: ["Product", "offers"], feature: "product results", required: ["lowPrice", "priceCurrency"] },
  { type: "AggregateRating", feature: "review stars", required: ["ratingValue"], oneOf: [["ratingCount", "reviewCount"]] },
  { type: "Review", except: ["ClaimReview"], feature: "review snippets", required: ["author", "reviewRating"] },
  { type: "Rating", within: ["Review", "reviewRating"], feature: "review snippets", required: ["ratingValue"] },
  { type: "BreadcrumbList", feature: "breadcrumbs", required: ["itemListElement"] },
  { type: "FAQPage", topLevel: true, feature: "FAQ results", required: ["mainEntity"] },
  { type: "Question", within: ["FAQPage", "mainEntity"], feature: "FAQ results", required: ["name", "acceptedAnswer"] },
  { type: "Answer", within: ["Question", "acceptedAnswer"], feature: "FAQ results", required: ["text"] },
  { type: "Event", topLevel: true, feature: "event results", required: ["name", "startDate", "location"], recommended: ["endDate", "image", "description"] },
  { type: "Recipe", topLevel: true, feature: "recipe results", required: ["name", "image"] },
  { type: "VideoObject", feature: "video results", required: ["name", "thumbnailUrl", "uploadDate"] },
  { type: "JobPosting", topLevel: true, feature: "job listings", required: ["title", "description", "datePosted", "hiringOrganization"] },
  { type: "SoftwareApplication", topLevel: true, feature: "software app results", required: ["name", "offers"], oneOf: [["aggregateRating", "review"]] },
  { type: "Dataset", topLevel: true, feature: "dataset results", required: ["name", "description"] },
  // Google lists no required properties for articles or organizations.
  { type: "Article", topLevel: true, feature: "article results", recommended: ["headline", "image", "datePublished", "author"] },
  { type: "Organization", feature: "organization details", recommended: ["name"] },
];

const listOf = (names, joiner = "and") =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ${joiner} ${names[names.length - 1]}`;

function labelOf(node, parent) {
  const type = node.types[0] || node.rawTypes[0] || "Item";
  return parent ? `${type} in ${parent.label} › ${parent.property} (${node.source})` : `${type} (${node.source})`;
}

function checkFeatures(node, parent, problems) {
  const label = labelOf(node, parent);
  const reported = new Set();
  const topLevel = !parent || parent.property === "mainEntity";
  for (const feature of FEATURES) {
    if (!isA(node, feature.type)) continue;
    if (feature.except && feature.except.some((type) => isA(node, type))) continue;
    if (feature.topLevel && !topLevel) continue;
    if (feature.within) {
      const [parentType, property] = feature.within;
      if (!parent || parent.property !== property || !isA(parent.node, parentType)) continue;
    }
    const missing = (feature.required || []).filter((name) => !reported.has(name) && !present(node.props.get(name)));
    if (feature.type === "JobPosting" && !present(node.props.get("jobLocation")) && !present(node.props.get("jobLocationType"))) {
      missing.push("jobLocation");
    }
    for (const name of missing) reported.add(name);
    if (missing.length) {
      problems.push({ kind: "required", message: `${label} is missing ${listOf(missing)}, which Google requires for ${feature.feature}.` });
    }
    for (const group of feature.oneOf || []) {
      if (group.some((name) => present(node.props.get(name)))) continue;
      problems.push({ kind: "required", message: `${label} needs ${listOf(group, "or")} for Google to show ${feature.feature}.` });
    }
    const recommended = (feature.recommended || []).filter((name) => !reported.has(name) && !present(node.props.get(name)));
    for (const name of recommended) reported.add(name);
    if (recommended.length) {
      problems.push({ kind: "recommended", message: `${label} is missing ${listOf(recommended)}, which Google recommends for ${feature.feature}.` });
    }
  }
  if (isA(node, "BreadcrumbList")) checkBreadcrumbs(node, label, problems);
}

// Each crumb needs its position and name, and every crumb but the last its URL.
function checkBreadcrumbs(node, label, problems) {
  const items = (node.props.get("itemListElement") || []).filter((item) => item && typeof item === "object");
  items.forEach((item, index) => {
    const target = (item.props.get("item") || [])[0];
    const targetNode = target && typeof target === "object" ? target : null;
    const missing = [];
    if (!present(item.props.get("position"))) missing.push("position");
    if (!present(item.props.get("name")) && !(targetNode && present(targetNode.props.get("name")))) missing.push("name");
    const url = targetNode ? targetNode.id || (targetNode.props.get("url") || [])[0] : target;
    if (index < items.length - 1 && !present([url])) missing.push("item");
    if (missing.length) {
      problems.push({
        kind: "required",
        message: `${label} › crumb ${index + 1} is missing ${listOf(missing)}, which Google requires for breadcrumbs.`,
      });
    }
  });
}

// ── schema.org itself ───────────────────────────────────────────────────────

function checkVocabulary(node, parent, problems) {
  if (!node.schema) return;
  const label = labelOf(node, parent);
  const unknownTypes = node.types.filter((type) => !TYPES.has(type));
  for (const type of unknownTypes) {
    const near = suggestion(type, TYPES);
    problems.push({
      kind: "invalid",
      message: `${label}: "${type}" is not a schema.org type${near ? ` (did you mean "${near}"?)` : ""}.`,
    });
  }
  // A property's fit is only judged when every type the node claims is known.
  const judged = node.types.length > 0 && !unknownTypes.length && !node.foreignTypes.length;
  const lineage = new Set(node.types.flatMap((type) => [...ancestors(type)]));
  for (const name of node.props.keys()) {
    if (/[:/]/.test(name)) continue;
    // schema.org's action annotations: "query-input", "name-output".
    const annotated = /^(.+)-(?:input|output)$/.exec(name);
    if (annotated && PROPERTIES.has(annotated[1])) continue;
    const domains = PROPERTIES.get(name);
    if (!domains) {
      const near = suggestion(name, PROPERTIES);
      const hint = near && near.toLowerCase() === name.toLowerCase()
        ? ` (did you mean "${near}"? Property names are case-sensitive)`
        : near ? ` (did you mean "${near}"?)` : "";
      problems.push({ kind: "invalid", message: `${label}: "${name}" is not a schema.org property${hint}.` });
      continue;
    }
    if (!judged || !domains.length || domains.some((domain) => lineage.has(domain))) continue;
    const owners = domains.slice(0, 3).join(", ") + (domains.length > 3 ? "…" : "");
    problems.push({
      kind: "invalid",
      message: `${label}: "${name}" is not a property of ${node.types.join("/")} (schema.org defines it for ${owners}).`,
    });
  }
}

// ── The page ────────────────────────────────────────────────────────────────

/**
 * @param {import("cheerio").CheerioAPI} $ the page
 * @param {(selector: string) => import("cheerio").Cheerio} select the page's
 *   live elements for a selector (the crawler leaves out template contents)
 * @returns {{ problems: { kind: "invalid"|"required"|"recommended", message: string }[], types: string[] }}
 */
function structuredDataFromPage($, select = (selector) => $(selector)) {
  const jsonLd = readJsonLd($, select('script[type="application/ld+json" i]'));
  const microdata = readMicrodata($, select("[itemscope]"));
  const problems = [...jsonLd.problems, ...microdata.problems];
  const types = new Set();

  const visit = (node, parent, depth) => {
    if (!node || typeof node !== "object" || depth > MAX_DEPTH) return;
    for (const type of node.types) types.add(type);
    checkVocabulary(node, parent, problems);
    if (node.types.length) checkFeatures(node, parent, problems);
    const label = labelOf(node, parent);
    for (const [property, values] of node.props) {
      for (const value of values) {
        if (value && typeof value === "object") visit(value, { node, property, label: label.replace(/ \((?:JSON-LD|microdata)\)$/, "") }, depth + 1);
      }
    }
  };
  for (const node of [...jsonLd.nodes, ...microdata.nodes]) visit(node, null, 0);

  const seen = new Set();
  const unique = problems.filter((problem) => {
    if (seen.has(problem.message)) return false;
    seen.add(problem.message);
    return true;
  });
  return { problems: unique.slice(0, MAX_PROBLEMS), types: [...types].slice(0, MAX_TYPES) };
}

module.exports = { structuredDataFromPage, vocabularyVersion: vocabulary.version };
