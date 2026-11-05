// ── Agent Readiness: a real file, and a refused audit ───────────────────────
//
// Cabinet's site answers every address with its HTML page, so the protocol
// checks (API catalog, OAuth, MCP card, agent skills…) all "passed" and it
// scored 58 instead of about 20. And a site that rate-limited the audit was
// scored as failing every check: Eventgroove 0, 8x8 12.
//
// Run: node --test routes/__tests__/agentReadinessChecks.test.js

const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  isJsonDocument, isSitemapDocument, auditBlocked, allowsEveryCrawler, agentLinkRels, siteOnce,
  aiBotAccess, aiBotsCheck, describeHttpChecks, buildBriefPrompt,
} = require('../agentReadinessAudit')._private;
const { WEIGHTS } = require('../agentReadinessAudit');

const reply = (status, type, data) => ({ status, headers: type ? { 'content-type': type } : {}, data });

test('an HTML page answering a protocol address is not the file', () => {
  assert.equal(isJsonDocument(reply(200, 'text/html; charset=utf-8', '<!doctype html><html>…')), false);
  assert.equal(isJsonDocument(reply(200, null, '<html><body>Not found</body></html>')), false);
});

test('a JSON document passes, parsed or as text', () => {
  assert.equal(isJsonDocument(reply(200, 'application/json', { issuer: 'https://x.test' })), true);
  assert.equal(isJsonDocument(reply(200, 'application/linkset+json', '{"linkset":[]}')), true);
  assert.equal(isJsonDocument(reply(200, 'text/plain', '{"name":"skills"}')), true);
});

test('a redirect or a missing file does not pass', () => {
  assert.equal(isJsonDocument(reply(301, 'text/html', '')), false);
  assert.equal(isJsonDocument(reply(404, 'application/json', {})), false);
  assert.equal(isJsonDocument(reply(200, 'text/plain', 'not json')), false);
});

test('a sitemap must be an XML sitemap, not a web page', () => {
  assert.equal(isSitemapDocument(reply(200, 'application/xml', '<?xml version="1.0"?><urlset>')), true);
  assert.equal(isSitemapDocument(reply(200, 'text/html', '<html><body>Home</body></html>')), false);
  assert.equal(isSitemapDocument(reply(200, 'text/html', '<?xml version="1.0"?><sitemapindex>')), true);
});

test('robots.txt and the page both refused is "not measured", not a fail', () => {
  assert.match(auditBlocked(reply(429), reply(429)), /refused the audit/);
  assert.match(auditBlocked({ status: null }, reply(403)), /refused the audit/);
  assert.match(auditBlocked(reply(503), reply(500)), /refused the audit/);
});

test('a refused page is not measured, even when robots.txt answered', () => {
  // Scoring it would read the error page's headers and HTML as the site's.
  assert.match(auditBlocked(reply(404), reply(429)), /refused the audit's request for the page \(HTTP 429\)/);
  assert.match(auditBlocked(reply(200, 'text/plain', ''), reply(403)), /could not be measured/);
});

test('an answered page means the site was measured', () => {
  assert.equal(auditBlocked(reply(429), reply(200)), null);
  assert.equal(auditBlocked(reply(404), reply(404)), null, 'a 404 page is an answer');
});

// ── Fix 4.2: checks that could not pass, or passed for the wrong reason ──────

test('a robots.txt that lets every crawler in counts as an AI bot decision', () => {
  assert.equal(allowsEveryCrawler('User-agent: *\nAllow: /\n'), true);
  assert.equal(allowsEveryCrawler('User-agent: *\nDisallow: /admin\n'), true);
  assert.equal(allowsEveryCrawler(''), true);
  assert.equal(allowsEveryCrawler('User-agent: *\nDisallow: /\n'), false);
  // A root block for one named bot is not a block for everyone.
  assert.equal(allowsEveryCrawler('User-agent: Baiduspider\nDisallow: /\n\nUser-agent: *\nDisallow:\n'), true);
});

test('only Link headers that point an agent somewhere count', () => {
  assert.deepEqual(agentLinkRels('</app.css>; rel=preload; as=style, <https://cdn.x>; rel="preconnect"'), []);
  assert.deepEqual(agentLinkRels('</.well-known/api-catalog>; rel="api-catalog"'), ['api-catalog']);
  assert.deepEqual(agentLinkRels('</index.md>; rel="alternate"; type="text/markdown"'), ['alternate']);
});

test('the emerging protocols keep their weight (D3: future readiness)', () => {
  assert.equal(WEIGHTS.webmcp, 6);
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('a site file is fetched once for every page of a run', async () => {
  let calls = 0;
  async function fakeFetch() { calls += 1; return { status: 200 }; }
  await Promise.all([siteOnce(fakeFetch, 'https://once.test/robots.txt'), siteOnce(fakeFetch, 'https://once.test/robots.txt')]);
  await siteOnce(fakeFetch, 'https://once.test/robots.txt');
  assert.equal(calls, 1);
});

// ── UX-211 / UX-222: AI crawler access is read from the rules ───────────────

test('naming an AI crawler only to block it is a block, not a pass', () => {
  const robots = 'User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\n';
  assert.deepEqual(aiBotAccess(robots).blocked, ['GPTBot']);
  const check = aiBotsCheck(true, robots, 200);
  assert.equal(check.status, 'fail');
  assert.equal(check.blocking, true);
  assert.match(check.tech, /blocks AI crawlers: GPTBot/);
});

test('a crawler named with Allow: / is let in, and grouped agents share rules', () => {
  const robots = 'User-agent: GPTBot\nUser-agent: ClaudeBot\nAllow: /\n\nUser-agent: *\nDisallow: /\n';
  const access = aiBotAccess(robots);
  assert.deepEqual(access.named, ['GPTBot', 'ClaudeBot']);
  // Everyone else falls back to `*`, which shuts the site.
  assert.ok(!access.blocked.includes('GPTBot'));
  assert.ok(!access.blocked.includes('ClaudeBot'));
  assert.ok(access.blocked.includes('PerplexityBot'));
});

test('path-only Disallows under * let every AI crawler in (Beta Bionics, LogicGate)', () => {
  const robots = 'User-agent: *\nDisallow: /wp-json/\nDisallow: /?rest_route=\nCrawl-delay: 10\nSitemap: https://x.test/sitemap.xml\n';
  const check = aiBotsCheck(true, robots, 200);
  assert.equal(check.status, 'pass');
  assert.equal(check.blocking, undefined);
  assert.match(check.tech, /lets every crawler in/);
});

test('Disallow: / under * blocks every AI crawler that is not named', () => {
  const check = aiBotsCheck(true, 'User-agent: *\nDisallow: /\n', 200);
  assert.equal(check.status, 'fail');
  assert.equal(check.blocking, true);
});

test('an unreadable robots.txt fails without being called a block', () => {
  for (const status of [401, 403, 429, 500, 503, null]) {
    const check = aiBotsCheck(false, '', status);
    assert.equal(check.status, 'fail', String(status));
    assert.equal(check.blocking, undefined);
    assert.match(check.tech, /could not be read/);
  }
});

test('a missing robots.txt (404/410) lets every AI crawler in (RFC 9309)', () => {
  for (const status of [404, 410]) {
    const check = aiBotsCheck(false, '<html>Not found</html>', status);
    assert.equal(check.status, 'pass', String(status));
    assert.equal(check.blocking, undefined);
    assert.match(check.tech, new RegExp(`No robots\\.txt \\(HTTP ${status}\\)`));
  }
  // and the brief is told crawlers are allowed
  const checks = { aibots: aiBotsCheck(false, '', 404) };
  assert.match(buildBriefPrompt('https://x.test/', 30, 'L', checks, []), /crawlersAllowed = true/);
});

test('the stored check carries the blocking flag only when there is one', () => {
  const [blocked] = describeHttpChecks({ aibots: { status: 'fail', blocking: true, tech: 'x' } });
  assert.equal(blocked.blocking, true);
  assert.equal(blocked.cat, 'Bot Access');
  const [plain] = describeHttpChecks({ contentsignals: { status: 'fail', tech: 'y' } });
  assert.equal('blocking' in plain, false);
});

test('the brief is told crawlers are allowed, and forbidden to say otherwise', () => {
  const checks = {
    aibots: aiBotsCheck(true, 'User-agent: *\nDisallow: /wp-json/\n', 200),
    contentsignals: { status: 'fail', tech: 'No Content-Signal directives in robots.txt' },
  };
  const cats = [{ id: 'Bot Access', score: 55, passed: 1, total: 3 }, { id: 'API / Auth / MCP', score: 0, passed: 0, total: 6 }];
  const prompt = buildBriefPrompt('https://www.betabionics.com/', 20, 'Level 0 — Not started', checks, cats);
  assert.match(prompt, /crawlersAllowed = true/);
  assert.match(prompt, /Never say or imply the site is invisible, closed off, blocked/);
  assert.doesNotMatch(prompt, /lead with AI discoverability risk/);
  assert.doesNotMatch(prompt, /Invisible to AI assistants|Open bot access/);
});

test('a real robots.txt block is stated to the brief as one', () => {
  const checks = { aibots: aiBotsCheck(true, 'User-agent: GPTBot\nDisallow: /\n', 200) };
  const prompt = buildBriefPrompt('https://x.test/', 10, 'Level 0 — Not started', checks, []);
  assert.match(prompt, /crawlersAllowed = false\. robots\.txt blocks AI crawlers: GPTBot/);
  assert.doesNotMatch(prompt, /Never say or imply/);
});

// ── UX-211: the brief may not call an open site closed ──────────────────────
const {
  claimsBlocked, neutraliseBrief, generateCmoBrief, homeChallenge, pageTextFacts,
} = require('../agentReadinessAudit')._private;

/** A stand-in model that answers each call with the next brief and counts calls. */
function stubModel(...briefs) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (req) => {
      calls.push(req);
      const next = briefs[Math.min(calls.length - 1, briefs.length - 1)];
      return { choices: [{ message: { content: JSON.stringify(next) } }] };
    } } },
  };
}
const openChecks = { aibots: { status: 'pass', tech: 'No AI-specific rules, but robots.txt lets every crawler in' } };
const shutChecks = { aibots: { status: 'fail', blocking: true, tech: 'robots.txt blocks AI crawlers: GPTBot' } };
const goodBrief = {
  headline: 'Early on agent signals', summary: 'AI crawlers can read your site. Newer signals are not yet set up.',
  riskTitle: 'Behind on agent signals', risk: 'Rivals may publish agent files first.',
  opportunityTitle: 'Publish agent files', opportunity: 'Publish an API catalog within 60 days.',
  competitiveTitle: 'First-mover advantage', competitive: 'Few peers have these signals yet.',
};
const badBrief = {
  ...goodBrief,
  headline: 'Invisible to AI assistants',
  summary: 'Your site is completely closed off to AI agents. Newer signals are not yet set up.',
  risk: 'ChatGPT and Perplexity cannot access your pages.',
};

test('the claim detector finds block claims and lets denials through', () => {
  for (const s of ['Invisible to AI assistants', 'closed off to AI agents', 'AI crawlers are blocked',
    'ChatGPT cannot access your pages', "assistants can't read or cite your content", 'inaccessible to AI',
    'robots.txt blocks AI crawlers', 'shut AI agents out']) {
    assert.equal(claimsBlocked(s), true, s);
  }
  for (const s of ['AI crawlers are not blocked', "Your site isn't invisible to AI", 'the building blocks of agent readiness',
    'Publish agent files to stand out', 'AI crawlers can read your site today']) {
    assert.equal(claimsBlocked(s), false, s);
  }
});

test('true statements about missing signals are not block claims', () => {
  for (const s of ['Without an API catalog, agents cannot discover your booking services.',
    'Your pricing stays hidden from assistants until you add schema.',
    'Agents cannot find your opening hours without structured data.',
    'Your products are undiscoverable in AI answers until you add product markup.']) {
    assert.equal(claimsBlocked(s), false, s);
  }
});

test('a brief stating true signal gaps costs one model call and keeps every sentence', async () => {
  const brief = { ...goodBrief, risk: 'Without an API catalog, agents cannot discover your booking services.',
    summary: 'Your offers stay hidden from assistants until you add schema. Newer signals are not yet set up.' };
  const model = stubModel(brief);
  const out = await generateCmoBrief('https://x.test/', 30, 'L', openChecks, model, []);
  assert.deepEqual(out, brief);
  assert.equal(model.calls.length, 1);
});

test('robots.txt refused (401/403/429): crawler access is unknown, so an accurate firewall sentence stays', async () => {
  const { aiBotsCheck } = require('../agentReadinessAudit')._private;
  for (const status of [401, 403, 429]) {
    const aibots = aiBotsCheck(false, '', status);
    assert.equal(aibots.refused, true, String(status));
    const brief = { ...goodBrief, risk: 'Your firewall blocks AI bots, so assistants cannot read your site.' };
    const model = stubModel(brief);
    const out = await generateCmoBrief('https://x.test/', 30, 'L', { aibots }, model, []);
    assert.deepEqual(out, brief);
    assert.equal(model.calls.length, 1);
    assert.match(model.calls[0].messages[0].content, /crawlersAllowed = unknown/);
  }
  assert.equal(aiBotsCheck(false, '', 500).refused, undefined, 'a server error is not a refusal');
});

test('a clean brief is returned as written, with one model call', async () => {
  const model = stubModel(goodBrief);
  const out = await generateCmoBrief('https://x.test/', 30, 'L', openChecks, model, []);
  assert.deepEqual(out, goodBrief);
  assert.equal(model.calls.length, 1);
});

test('a brief calling an open site blocked is asked for once more', async () => {
  const model = stubModel(badBrief, goodBrief);
  const out = await generateCmoBrief('https://x.test/', 30, 'L', openChecks, model, []);
  assert.deepEqual(out, goodBrief);
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].messages[0].content, /That is false: crawlersAllowed = true/);
});

test('if the retry still says it, the false sentences become neutral wording', async () => {
  const model = stubModel(badBrief, badBrief);
  const out = await generateCmoBrief('https://x.test/', 30, 'L', openChecks, model, []);
  assert.equal(model.calls.length, 2);
  for (const k of Object.keys(out)) assert.equal(claimsBlocked(out[k]), false, k);
  assert.equal(out.summary, 'Newer signals are not yet set up.');
  assert.equal(out.headline, 'AI crawlers can read your site; agent signals come next');
  assert.match(out.risk, /agent-ready signals/);
  assert.equal(out.opportunity, goodBrief.opportunity);
});

test('a retry that throws still ends in neutral wording, never a block claim', async () => {
  let n = 0;
  const model = { chat: { completions: { create: async () => {
    n += 1;
    if (n > 1) throw new Error('timeout');
    return { choices: [{ message: { content: JSON.stringify(badBrief) } }] };
  } } } };
  const out = await generateCmoBrief('https://x.test/', 30, 'L', openChecks, model, []);
  for (const k of Object.keys(out)) assert.equal(claimsBlocked(out[k]), false, k);
});

test('a real block may be stated: no retry, no rewrite', async () => {
  const model = stubModel(badBrief);
  const out = await generateCmoBrief('https://x.test/', 10, 'L', shutChecks, model, []);
  assert.deepEqual(out, badBrief);
  assert.equal(model.calls.length, 1);
});

test('neutraliseBrief leaves a clean brief alone', () => {
  assert.deepEqual(neutraliseBrief(goodBrief), goodBrief);
});

// ── UX-036: a bot check answered with 200 is not the site ───────────────────
test('a challenge page served with HTTP 200 is blocked, not scored', () => {
  const page = (title, body = '') => ({ status: 200, headers: { 'content-type': 'text/html' }, data: `<html><head><title>${title}</title></head><body>${body}</body></html>` });
  assert.match(homeChallenge(page('Just a moment...')), /bot-protection wall/);
  assert.match(homeChallenge(page('Vercel Security Checkpoint')), /could not be measured/);
  assert.equal(homeChallenge(page('Acme — Payroll software', 'Welcome to Acme. '.repeat(100))), null);
  assert.equal(homeChallenge({ status: 200, headers: {}, data: { json: true } }), null);
  assert.equal(homeChallenge(null), null);
  // Real pages whose titles merely contain a challenge phrase.
  const words = 'Open an account with no monthly fee and earn rewards. '.repeat(90);
  assert.equal(homeChallenge(page('Free Checking Your Way | Acme Bank', words)), null);
  assert.equal(homeChallenge(page('Security Checkpoint Software | Acme', words)), null);
  // A challenge title on a long page counts only with a challenge marker.
  assert.equal(homeChallenge(page('Just a moment...', words)), null);
  assert.match(homeChallenge(page('Just a moment...', `${words}<script>window._cf_chl_opt={}</script>`)), /bot-protection wall/);
  const facts = pageTextFacts('<title> Hi  &amp; bye </title><script>var a = 1 2 3</script><p>one two three</p>');
  assert.equal(facts.title, 'Hi & bye');
  assert.equal(facts.wordCount, 6);
});
