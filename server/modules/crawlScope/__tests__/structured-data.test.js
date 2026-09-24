const test = require("node:test");
const assert = require("node:assert/strict");
const cheerio = require("cheerio");
const { structuredDataFromPage } = require("../structured-data");

// Structured data was read from JSON-LD only, seven types were hand-checked
// (with a rule for dentists but none for any other local business), and
// properties Google only recommends were reported as required. These pin what
// is read now: JSON-LD and microdata, against the whole schema.org vocabulary
// and Google's requirements per rich result.

const ld = (object) => `<script type="application/ld+json">${JSON.stringify(object)}</script>`;
const check = (html) => structuredDataFromPage(cheerio.load(`<html><head></head><body>${html}</body></html>`));
const messages = (html, kind) => check(html).problems.filter((p) => !kind || p.kind === kind).map((p) => p.message);
const CONTEXT = "https://schema.org";

test("any local business needs a name and an address, not only a dentist", () => {
  const plumber = messages(ld({ "@context": CONTEXT, "@type": "Plumber", name: "Pipes & Co", telephone: "+1", url: "https://x" }), "required");
  assert.deepEqual(plumber, ["Plumber (JSON-LD) is missing address, which Google requires for local business details."]);
  const dentist = messages(ld({ "@context": CONTEXT, "@type": "Dentist", address: "1 Main St", telephone: "+1", url: "https://x" }), "required");
  assert.deepEqual(dentist, ["Dentist (JSON-LD) is missing name, which Google requires for local business details."]);
});

test("what Google only recommends is reported as recommended, not required", () => {
  const problems = check(ld({ "@context": CONTEXT, "@type": "BlogPosting", headline: "A post" })).problems;
  assert.deepEqual(problems, [{
    kind: "recommended",
    message: "BlogPosting (JSON-LD) is missing image, datePublished and author, which Google recommends for article results.",
  }]);
  assert.deepEqual(check(ld({ "@context": CONTEXT, "@type": "Organization", url: "https://x" })).problems, [{
    kind: "recommended",
    message: "Organization (JSON-LD) is missing name, which Google recommends for organization details.",
  }]);
});

test("a property on the wrong type, a misspelt type and a wrongly capitalised property are invalid", () => {
  const invalid = messages(
    ld({ "@context": CONTEXT, "@type": "Product", name: "Z", price: "9.99", offers: { "@type": "Offer", price: "9.99", priceCurrency: "USD", availability: "https://schema.org/InStock" }, image: "https://x/z.jpg" }) +
    ld({ "@context": CONTEXT, "@type": "Organisation", name: "O" }) +
    ld({ "@context": CONTEXT, "@type": "BlogPosting", headline: "H", datepublished: "2024-01-01" }),
    "invalid",
  );
  assert.deepEqual(invalid, [
    'Product (JSON-LD): "price" is not a property of Product (schema.org defines it for DonateAction, Offer, PriceSpecification…).',
    'Organisation (JSON-LD): "Organisation" is not a schema.org type (did you mean "Organization"?).',
    'BlogPosting (JSON-LD): "datepublished" is not a schema.org property (did you mean "datePublished"? Property names are case-sensitive).',
  ]);
});

test("a product's offer needs its price; an aggregate offer needs its range instead", () => {
  const product = (offers) => ld({ "@context": CONTEXT, "@type": "Product", name: "P", image: "https://x/p.jpg", offers });
  assert.deepEqual(messages(product({ "@type": "Offer", priceCurrency: "USD", availability: "https://schema.org/InStock" }), "required"), [
    "Offer in Product › offers (JSON-LD) needs price or priceSpecification for Google to show product results.",
  ]);
  assert.deepEqual(messages(product({ "@type": "AggregateOffer", lowPrice: "5", highPrice: "9", priceCurrency: "EUR" })), []);
  assert.deepEqual(messages(ld({ "@context": CONTEXT, "@type": "Product", name: "P", image: "https://x/p.jpg" }), "required"), [
    "Product (JSON-LD) needs offers, review or aggregateRating for Google to show product results.",
  ]);
});

test("microdata is read too, including properties kept elsewhere with itemref", () => {
  const html = `
    <div itemscope itemtype="https://schema.org/Product" itemref="product-name">
      <img itemprop="image" src="/w.jpg">
      <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
        <meta itemprop="priceCurrency" content="USD"><link itemprop="availability" href="https://schema.org/InStock">
      </div>
    </div>
    <h1 id="product-name" itemprop="name">Widget</h1>`;
  const result = check(html);
  assert.deepEqual(result.types, ["Product", "Offer"]);
  assert.deepEqual(result.problems.map((p) => p.message), [
    "Offer in Product › offers (microdata) needs price or priceSpecification for Google to show product results.",
  ]);
});

test("breadcrumbs: every crumb needs a position and a name, and all but the last a URL", () => {
  const crumb = (position, name, item) => ({ "@type": "ListItem", position, name, ...(item ? { item } : {}) });
  assert.deepEqual(messages(ld({ "@context": CONTEXT, "@type": "BreadcrumbList", itemListElement: [crumb(1, "Home", "https://x/"), crumb(2, "Here")] })), []);
  assert.deepEqual(messages(ld({ "@context": CONTEXT, "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", name: "Home" }, crumb(2, "Here")] })), [
    "BreadcrumbList (JSON-LD) › crumb 1 is missing position and item, which Google requires for breadcrumbs.",
  ]);
  const microdata = `<ol itemscope itemtype="https://schema.org/BreadcrumbList">
    <li itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem"><a itemprop="item" href="https://x/"><span itemprop="name">Home</span></a><meta itemprop="position" content="1"></li>
    <li itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem"><a itemscope itemtype="https://schema.org/WebPage" itemprop="item" itemid="https://x/books" href="https://x/books"><span itemprop="name">Books</span></a><meta itemprop="position" content="2"></li>
    <li itemprop="itemListElement" itemscope itemtype="https://schema.org/ListItem"><span itemprop="name">This book</span><meta itemprop="position" content="3"></li>
  </ol>`;
  assert.deepEqual(messages(microdata), []);
});

test("unreadable markup: bad JSON, no @context, and data-vocabulary.org", () => {
  const [unparsable, ...rest] = messages(`<script type="application/ld+json">{not json</script>`);
  assert.match(unparsable, /^JSON-LD block 1 is invalid: /);
  assert.deepEqual(rest, []);
  assert.deepEqual(messages(ld({ "@type": "Organization", name: "No context" })), [
    'JSON-LD block 1 has no @context, so its terms are not read as schema.org (add "@context": "https://schema.org").',
  ]);
  assert.deepEqual(messages(`<div itemscope itemtype="http://data-vocabulary.org/Breadcrumb"><a href="/" itemprop="url"><span itemprop="title">Home</span></a></div>`), [
    "Breadcrumb (microdata) uses data-vocabulary.org, which Google stopped reading in 2020; mark it up with schema.org instead.",
  ]);
});

test("a local business mentioned as someone's publisher is not asked for an address", () => {
  const article = ld({
    "@context": CONTEXT, "@type": "Article", headline: "H", image: "https://x/i.jpg", datePublished: "2024-01-01",
    author: { "@type": "Person", name: "Jo" }, publisher: { "@type": "LocalBusiness", name: "Shop" },
  });
  assert.deepEqual(messages(article), []);
  // …but as the page's main entity, it is what the page is about.
  const page = ld({ "@context": CONTEXT, "@type": "WebPage", mainEntity: { "@type": "LocalBusiness", name: "Shop", telephone: "+1", url: "https://x" } });
  assert.deepEqual(messages(page, "required"), [
    "LocalBusiness in WebPage › mainEntity (JSON-LD) is missing address, which Google requires for local business details.",
  ]);
});

test("common real-world markup passes: a Yoast graph, WooCommerce and Shopify products, Google's own examples", () => {
  const yoast = ld({ "@context": CONTEXT, "@graph": [
    { "@type": "WebPage", "@id": "https://x/p/#webpage", url: "https://x/p/", name: "P", isPartOf: { "@id": "https://x/#website" }, breadcrumb: { "@id": "https://x/p/#breadcrumb" }, inLanguage: "en-US", potentialAction: [{ "@type": "ReadAction", target: ["https://x/p/"] }] },
    { "@type": "BreadcrumbList", "@id": "https://x/p/#breadcrumb", itemListElement: [{ "@type": "ListItem", position: 1, name: "Home", item: "https://x/" }, { "@type": "ListItem", position: 2, name: "P" }] },
    { "@type": "WebSite", "@id": "https://x/#website", url: "https://x/", name: "X", potentialAction: [{ "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: "https://x/?s={search_term_string}" }, "query-input": { "@type": "PropertyValueSpecification", valueRequired: true, valueName: "search_term_string" } }] },
    { "@type": "Organization", "@id": "https://x/#organization", name: "X", url: "https://x/", logo: { "@type": "ImageObject", url: "https://x/logo.png", contentUrl: "https://x/logo.png", width: 512, height: 512, caption: "X" }, sameAs: ["https://twitter.com/x"] },
    { "@type": "Article", "@id": "https://x/p/#article", author: { name: "Jo", "@id": "https://x/#/schema/person/1" }, headline: "P", datePublished: "2024-01-01", image: { "@id": "https://x/p/#primaryimage" }, mainEntityOfPage: { "@id": "https://x/p/#webpage" }, wordCount: 900, articleSection: ["News"] },
  ] });
  const woo = ld({ "@context": "https://schema.org/", "@type": "Product", name: "X", image: "https://x/x.jpg", sku: "123", offers: [{ "@type": "Offer", price: "10.00", priceValidUntil: "2026-12-31", priceSpecification: { price: "10.00", priceCurrency: "USD" }, priceCurrency: "USD", availability: "http://schema.org/InStock", seller: { "@type": "Organization", name: "X" } }], aggregateRating: { "@type": "AggregateRating", ratingValue: "4.50", reviewCount: 2 }, review: [{ "@type": "Review", reviewRating: { "@type": "Rating", ratingValue: "5" }, author: { "@type": "Person", name: "A" } }] });
  const shopify = ld({ "@context": "http://schema.org/", "@type": "Product", name: "Shirt", image: ["https://cdn/x.jpg"], brand: { "@type": "Brand", name: "B" }, offers: [{ "@type": "Offer", sku: "S1", availability: "http://schema.org/InStock", price: "20.0", priceCurrency: "USD" }] });
  const event = ld({ "@context": CONTEXT, "@type": "Event", name: "Show", startDate: "2025-07-21T19:00-05:00", endDate: "2025-07-21T23:00-05:00", eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode", location: { "@type": "Place", name: "Stadium", address: { "@type": "PostalAddress", addressLocality: "Town" } }, image: ["https://x/1.jpg"], description: "d", offers: { "@type": "Offer", url: "https://x/t", price: 30, priceCurrency: "USD" }, organizer: { "@type": "Organization", name: "Org", url: "https://org" } });
  const job = ld({ "@context": CONTEXT, "@type": "JobPosting", title: "Engineer", description: "<p>d</p>", datePosted: "2024-01-18", hiringOrganization: { "@type": "Organization", name: "Co" }, jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "City" } }, baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", value: 40, unitText: "HOUR" } } });
  const video = ld({ "@context": CONTEXT, "@type": "VideoObject", name: "Intro", thumbnailUrl: ["https://x/t.jpg"], uploadDate: "2024-03-31T08:00:00+08:00", duration: "PT1M54S", interactionStatistic: { "@type": "InteractionCounter", interactionType: { "@type": "WatchAction" }, userInteractionCount: 5 } });
  const faq = ld({ "@context": CONTEXT, "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "How?", acceptedAnswer: { "@type": "Answer", text: "Like this." } }] });
  for (const [name, html] of Object.entries({ yoast, woo, shopify, event, job, video, faq })) {
    assert.deepEqual(messages(html), [], name);
  }
});

test("markup in another vocabulary is left alone", () => {
  assert.deepEqual(messages(ld({ "@context": "https://www.w3.org/ns/activitystreams", type: "Note", content: "hi" })), []);
  assert.deepEqual(messages(`<div itemscope itemtype="https://example.org/Thing"><span itemprop="whatever">x</span></div>`), []);
});
