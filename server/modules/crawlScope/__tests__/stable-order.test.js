const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { SeoCrawler } = require("../crawler");

// Which pages fit under a page budget depended on which answered first: links
// were queued as each page finished, four at a time, and the budget went to
// whichever were queued first. Two crawls of the same site could audit
// different pages. Now each round of links is admitted together, in the order
// a one-at-a-time crawl would find them: by depth, then the order of the page
// that links to them, then their order on that page.

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const page = (title, links) =>
  `<!doctype html><html lang="en"><head><title>${title} stable order fixture</title></head><body><h1>${title}</h1>` +
  `${links.map((href) => `<a href="${href}">${href}</a>`).join("")}</body></html>`;

// Home links to ten sections, each section to ten pages of its own. `delayOf`
// sets how long each section takes to answer.
async function crawlWithDelays(delayOf) {
  const sections = Array.from({ length: 10 }, (_, i) => i);
  const server = http.createServer((request, response) => {
    const match = /^\/s(\d)\/$/.exec(request.url);
    const send = (body, status = 200) => {
      response.statusCode = status;
      response.setHeader("Content-Type", "text/html");
      response.end(body);
    };
    if (request.url === "/") return send(page("Home", sections.map((i) => `/s${i}/`)));
    if (match) {
      const i = Number(match[1]);
      return setTimeout(() => send(page(`Section ${i}`, Array.from({ length: 10 }, (_, j) => `/s${i}/p${j}`))), delayOf(i));
    }
    if (/^\/s\d\/p\d$/.test(request.url)) return send(page(request.url, []));
    return send("<html><head><title>Not found</title></head><body>Not found</body></html>", 404);
  });
  const port = await listen(server);
  try {
    const crawler = new SeoCrawler({ maxUrls: 25, concurrency: 4, checkExternalLinks: false, discoverSitemaps: false, respectRobots: false });
    const summary = await crawler.start(`http://127.0.0.1:${port}/`);
    return summary.results.filter((r) => r.status === 200).map((r) => new URL(r.url).pathname).sort();
  } finally {
    server.close();
  }
}

test("a capped crawl audits the same pages however fast each one answers", async () => {
  const fastFirst = await crawlWithDelays((i) => i * 15);
  const slowFirst = await crawlWithDelays((i) => (9 - i) * 15);
  assert.equal(fastFirst.length, 25);
  assert.deepEqual(slowFirst, fastFirst);
  // …and they are the pages a one-at-a-time crawl reaches first: the home
  // page, every section, all of the first section's pages, then the second's.
  const expected = [
    "/",
    ...Array.from({ length: 10 }, (_, i) => `/s${i}/`),
    ...Array.from({ length: 10 }, (_, j) => `/s0/p${j}`),
    ...Array.from({ length: 4 }, (_, j) => `/s1/p${j}`),
  ].sort();
  assert.deepEqual(fastFirst, expected);
});
