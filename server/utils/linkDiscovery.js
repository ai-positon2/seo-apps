const axios = require('axios');
const cheerio = require('cheerio');

const ACTION_TERMS = ['services', 'appointments', 'book', 'schedule', 'treatments', 'procedures', 'pricing', 'locations', 'location', 'about', 'products', 'shop', 'store', 'solutions', 'packages'];
const FORM_TERMS  = ['contact', 'request', 'form', 'consultation', 'get-started', 'apply', 'checkout', 'intake', 'enquiry', 'inquiry', 'quote', 'demo', 'trial', 'signup', 'sign-up', 'register'];

async function discoverLinks(homepageUrl) {
  try {
    const parsed = new URL(homepageUrl);
    const origin = parsed.origin;

    const response = await axios.get(homepageUrl, {
      timeout: 6000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AgentReadinessBot/1.0)' },
      validateStatus: () => true,
      maxRedirects: 3,
    });

    const html = typeof response.data === 'string' ? response.data : '';
    const $ = cheerio.load(html);

    // Collect all href values, filter same-origin, strip query/fragment, deduplicate
    const seen = new Set();
    const links = [];

    $('a[href]').each((_, el) => {
      if (links.length >= 60) return false; // cap at 60

      const raw = $(el).attr('href');
      if (!raw || !raw.trim()) return;

      let full;
      try {
        // Resolve relative URLs against the homepage origin
        full = new URL(raw, homepageUrl).href;
      } catch {
        return;
      }

      // Same-origin only
      const linkParsed = new URL(full);
      if (linkParsed.origin !== origin) return;

      // Strip query strings and fragments
      const clean = `${linkParsed.origin}${linkParsed.pathname}`.replace(/\/$/, '') || origin;

      // Exclude the homepage itself
      const homepageClean = `${parsed.origin}${parsed.pathname}`.replace(/\/$/, '') || origin;
      if (clean === homepageClean || clean === origin) return;

      if (seen.has(clean)) return;
      seen.add(clean);

      links.push({ path: linkParsed.pathname, full: clean });
    });

    // Score each link
    const scored = links.map(link => {
      const pathLower = link.path.toLowerCase();
      let actionScore = 0;
      let formScore = 0;

      for (const term of ACTION_TERMS) {
        if (pathLower.includes(term)) actionScore += 2;
      }
      for (const term of FORM_TERMS) {
        if (pathLower.includes(term)) formScore += 2;
      }

      return { ...link, actionScore, formScore };
    });

    // Sort by score descending, take top 2 per slot
    const actionCandidates = scored
      .filter(l => l.actionScore > 0)
      .sort((a, b) => b.actionScore - a.actionScore)
      .slice(0, 2)
      .map(({ path, full }) => ({ path, full }));

    const formCandidates = scored
      .filter(l => l.formScore > 0)
      .sort((a, b) => b.formScore - a.formScore)
      .slice(0, 2)
      .map(({ path, full }) => ({ path, full }));

    return { actionCandidates, formCandidates };
  } catch {
    return { actionCandidates: [], formCandidates: [] };
  }
}

module.exports = { discoverLinks };
