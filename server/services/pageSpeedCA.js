const axios = require('axios');

const PSI_URL = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const DELAY_MS = 250;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPageSpeed(url, strategy = 'mobile') {
  const params = {
    url: url.startsWith('http') ? url : `https://${url}`,
    strategy,
  };
  const apiKey = process.env.GOOGLE_PSI_API_KEY;
  if (apiKey) params.key = apiKey;

  try {
    const res = await axios.get(PSI_URL, { params, timeout: 30000 });
    const data = res.data;
    const lhr = data.lighthouseResult || {};
    const cats = lhr.categories || {};
    const audits = lhr.audits || {};

    const score = Math.round((cats.performance?.score ?? 0) * 100);
    const lcp = audits['largest-contentful-paint']?.displayValue || 'N/A';
    const cls = audits['cumulative-layout-shift']?.displayValue || 'N/A';
    const ttfb = audits['server-response-time']?.displayValue || 'N/A';
    const fcp = audits['first-contentful-paint']?.displayValue || 'N/A';
    const inp = audits['interaction-to-next-paint']?.displayValue || 'N/A';
    const coreWebVitalsPassed = data.loadingExperience?.overall_category === 'FAST';

    return { score, lcp, cls, ttfb, fcp, inp, coreWebVitalsPassed };
  } catch (err) {
    const status = err.response?.status;
    if (status === 400) return null; // Domain unreachable — not a real error, don't surface one
    const reason = err.response?.data?.error?.message || err.message;
    throw new Error(status ? `PageSpeed ${strategy} request failed (${status}): ${reason}` : `PageSpeed ${strategy} request failed: ${reason}`);
  }
}

// Mobile and desktop are independent PSI calls — one failing (e.g. a rate
// limit hit on the second call) must not discard a result the other already
// got back, so each is caught on its own rather than one throw losing both.
async function getPageSpeedForDomain(domain) {
  const url = `https://${domain}`;
  const errors = [];

  let mobile = null;
  try { mobile = await runPageSpeed(url, 'mobile'); } catch (err) { errors.push(err.message); }
  await sleep(DELAY_MS);

  let desktop = null;
  try { desktop = await runPageSpeed(url, 'desktop'); } catch (err) { errors.push(err.message); }
  await sleep(DELAY_MS);

  return {
    domain,
    mobile: mobile || { score: null, lcp: 'N/A', cls: 'N/A', ttfb: 'N/A', fcp: 'N/A', inp: 'N/A' },
    desktop: desktop || { score: null, lcp: 'N/A', cls: 'N/A', ttfb: 'N/A', fcp: 'N/A', inp: 'N/A' },
    coreWebVitalsPassed: mobile?.coreWebVitalsPassed || false,
    dataUnavailable: !mobile && !desktop,
    ...(errors.length ? { error: errors.join('; ') } : {}),
  };
}

async function getPageSpeedForAllDomains(domains) {
  const settled = await Promise.allSettled(domains.map(d => getPageSpeedForDomain(d)));
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      domain: domains[i],
      mobile: { score: null, lcp: 'N/A', cls: 'N/A', ttfb: 'N/A', fcp: 'N/A', inp: 'N/A' },
      desktop: { score: null, lcp: 'N/A', cls: 'N/A', ttfb: 'N/A', fcp: 'N/A', inp: 'N/A' },
      coreWebVitalsPassed: false,
      dataUnavailable: true,
      error: r.reason?.message,
    };
  });
}

function scoreColor(score) {
  if (score === null || score === undefined) return '#9CA3AF';
  if (score >= 90) return '#1DA64B';
  if (score >= 50) return '#F0B816';
  return '#D3342E';
}

module.exports = { getPageSpeedForAllDomains, scoreColor };
