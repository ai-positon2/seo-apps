// ── Rule-level prose, sent once per response ────────────────────────────────
//
// Each finding's recommendation and description are rule-level text: the same
// few dozen paragraphs repeated on every instance, most of a 51 MB response for
// a 50,000-finding run. With `?texts=shared` the findings route sends each
// distinct text once, in `texts`, and every finding points at its own by index
// (recommendationRef / descriptionRef). The client puts them back
// (client/src/lib/crawlScopeApi.js#inflateFindingTexts). Opt-in, so the default
// response shape is unchanged for any other reader.

function shareFindingTexts(findings) {
  const texts = [];
  const indexOf = new Map();
  const ref = (value) => {
    if (typeof value !== "string") return undefined;
    let index = indexOf.get(value);
    if (index === undefined) {
      index = texts.length;
      texts.push(value);
      indexOf.set(value, index);
    }
    return index;
  };
  const shared = findings.map((finding) => {
    const { recommendation, description, ...rest } = finding;
    const r = ref(recommendation);
    const d = ref(description);
    if (r !== undefined) rest.recommendationRef = r;
    if (d !== undefined) rest.descriptionRef = d;
    return rest;
  });
  return { findings: shared, texts };
}

module.exports = { shareFindingTexts };
