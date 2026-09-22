// ── Audit-loop fixture corpus ────────────────────────────────────────────────
//
// Each file in this folder reproduces the condition behind one defect the
// audit loop found on a real crawl (.audit-runs/<date>/<domain>/findings.json),
// distilled from the response Phase A saved under that run's evidence/. They
// are named <rule-id>__<defect-id> so a failing test points straight back at
// the finding that motivated it.
//
// `.http` files hold one response in the shape the evidence was captured in:
// status line, headers, a blank line, then the body. `{{ORIGIN}}` stands in for
// the host, so a fixture can be served from a local server on any port.
// `.json` files hold extracted crawl results, for defects that live in the
// analyzer rather than in parsing.

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function substitute(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in vars ? String(vars[key]) : match));
}

function httpFixture(name, vars = {}) {
  const raw = substitute(fs.readFileSync(path.join(__dirname, name), "utf8"), vars);
  const split = raw.search(/\r?\n\r?\n/);
  const head = split === -1 ? raw : raw.slice(0, split);
  const body = split === -1 ? "" : raw.slice(split).replace(/^\r?\n\r?\n/, "");
  const [statusLine, ...headerLines] = head.split(/\r?\n/);
  const status = Number(/^HTTP\/\S+\s+(\d{3})/.exec(statusLine)?.[1]);
  if (!status) throw new Error(`${name}: first line is not an HTTP status line`);
  const headers = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status, headers, body };
}

function jsonFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8"));
}

// Serves `routes(origin)` — a map of path (including any query string) to a
// response ({ status, headers, body }) or a function returning one. Unknown
// paths get a 404. `delayMs` holds every response back, for timing tests.
async function serve(routes, { delayMs = 0 } = {}) {
  let table = {};
  const server = http.createServer((request, response) => {
    const answer = () => {
      const entry = table[request.url];
      const fixture = typeof entry === "function" ? entry(request) : entry;
      const { status, headers = {}, body = "" } = fixture || {
        status: 404,
        headers: { "content-type": "text/plain" },
        body: "Not found",
      };
      response.writeHead(status, headers);
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (delayMs > 0) setTimeout(answer, delayMs);
    else answer();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  table = routes(origin);
  return { origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

function page({ title = "Fixture page", body = "", head = "" } = {}) {
  return {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html><head><title>${title}</title>${head}</head><body>${body}</body></html>`,
  };
}

module.exports = { httpFixture, jsonFixture, serve, page };
