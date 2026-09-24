"use strict";

// ── Fingerprints for near-duplicate text ─────────────────────────────────────
//
// MinHash over word 3-grams. A page's main text becomes 64 numbers; the share
// of positions two pages agree on estimates the share of three-word phrases
// they have in common (Jaccard similarity), so "92% the same" is a measured
// statement, not a guess. Comparing fingerprints instead of texts keeps a
// crawl's worth of pages cheap to compare and needs no text stored per page.
//
// Candidate pairs come from locality-sensitive hashing: the 64 numbers in 16
// bands of 4, and only pages sharing a whole band are compared. Two pages
// 85% alike share a band with near certainty; unrelated pages almost never do.

const SHINGLE_WORDS = 3;
const SIGNATURE_SIZE = 64;
const BAND_ROWS = 4;

function fnv1a32(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// murmur3's finalizer, seeded per signature position: 64 hash functions from
// one string hash.
function fmix32(value) {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
const SEEDS = Array.from({ length: SIGNATURE_SIZE }, (_, i) => fmix32(Math.imul(i + 1, 0x9e3779b9)));

function words(text) {
  return String(text || "").toLowerCase().normalize("NFKC").match(/[\p{L}\p{N}]+/gu) || [];
}

/**
 * @param {string} text
 * @returns {string} the signature, base64; "" for text with no words
 */
function contentSignature(text) {
  const tokens = words(text);
  if (!tokens.length) return "";
  const shingles = new Set();
  for (let i = 0; i <= Math.max(0, tokens.length - SHINGLE_WORDS); i += 1) {
    shingles.add(tokens.slice(i, i + SHINGLE_WORDS).join(" "));
  }
  const minimums = new Uint32Array(SIGNATURE_SIZE).fill(0xffffffff);
  for (const shingle of shingles) {
    const base = fnv1a32(shingle);
    for (let i = 0; i < SIGNATURE_SIZE; i += 1) {
      const value = fmix32(base ^ SEEDS[i]);
      if (value < minimums[i]) minimums[i] = value;
    }
  }
  return Buffer.from(minimums.buffer).toString("base64");
}

// The signature as numbers, or null when it is not one.
function decodeSignature(signature) {
  if (typeof signature !== "string" || !signature) return null;
  const buffer = Buffer.from(signature, "base64");
  if (buffer.length !== SIGNATURE_SIZE * 4) return null;
  const values = new Uint32Array(SIGNATURE_SIZE);
  for (let i = 0; i < SIGNATURE_SIZE; i += 1) values[i] = buffer.readUInt32LE(i * 4);
  return values;
}

// Estimated share of three-word phrases two texts have in common, 0 to 1.
function signatureSimilarity(a, b) {
  const x = a instanceof Uint32Array ? a : decodeSignature(a);
  const y = b instanceof Uint32Array ? b : decodeSignature(b);
  if (!x || !y) return 0;
  let same = 0;
  for (let i = 0; i < SIGNATURE_SIZE; i += 1) if (x[i] === y[i]) same += 1;
  return same / SIGNATURE_SIZE;
}

// The band keys a signature is filed under for candidate pairs.
function signatureBands(signature) {
  const values = signature instanceof Uint32Array ? signature : decodeSignature(signature);
  if (!values) return [];
  const bands = [];
  for (let band = 0; band < SIGNATURE_SIZE / BAND_ROWS; band += 1) {
    bands.push(`${band}:${Array.from(values.subarray(band * BAND_ROWS, (band + 1) * BAND_ROWS)).join(".")}`);
  }
  return bands;
}

module.exports = { contentSignature, decodeSignature, signatureSimilarity, signatureBands };
