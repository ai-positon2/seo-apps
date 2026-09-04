const axios = require('axios');

// In-memory daily search counter (resets on server restart or new day)
let dailySearchCount = 0;
let lastResetDate = new Date().toDateString();

function resetIfNewDay() {
  const today = new Date().toDateString();
  if (today !== lastResetDate) {
    dailySearchCount = 0;
    lastResetDate = today;
  }
}

async function searchSerper(keyword) {
  const response = await axios.post(
    'https://google.serper.dev/search',
    { q: keyword, gl: 'us', hl: 'en', num: 10 },
    {
      headers: {
        'X-API-KEY': process.env.SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );
  const items = response.data.organic || [];
  return {
    results: items.map(item => ({
      position: item.position,
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || '',
      displayUrl: item.displayLink || '',
    })),
    // Serper's response carries this whenever Google's SERP showed a "People
    // also ask" box — real search-behavior data, previously fetched and then
    // discarded here since no caller read anything but `.organic`.
    peopleAlsoAsk: (response.data.peopleAlsoAsk || []).map(q => ({
      question: q.question || '',
      snippet: q.snippet || '',
    })).filter(q => q.question),
    searchCount: dailySearchCount,
    totalResults: response.data.searchInformation?.totalResults || items.length,
    source: 'serper',
  };
}

async function searchGoogle(keyword) {
  resetIfNewDay();

  // Google quota exhausted — skip straight to Serper
  if (dailySearchCount >= 100) {
    return searchSerper(keyword);
  }

  const params = {
    key: process.env.GOOGLE_API_KEY,
    cx: process.env.GOOGLE_CX,
    q: keyword,
    num: 10,
    gl: 'us',
    hl: 'en',
    cr: 'countryUS'
  };

  let response;
  try {
    response = await axios.get('https://www.googleapis.com/customsearch/v1', { params, timeout: 15000 });
  } catch (err) {
    if (err.response) {
      const status = err.response.status;
      // Quota or auth failure — fall back to Serper
      if (status === 429 || status === 403) {
        return searchSerper(keyword);
      }
      const message = err.response.data?.error?.message || 'Unknown Google API error';
      throw new Error(`Google API error (${status}): ${message}`);
    }
    // Network/timeout error — fall back to Serper
    return searchSerper(keyword);
  }

  dailySearchCount++;

  const items = response.data.items || [];
  const totalResults = parseInt(response.data.searchInformation?.totalResults || '0');

  return {
    results: items.map((item, index) => ({
      position: index + 1,
      title: item.title || '',
      url: item.link || '',
      snippet: item.snippet || '',
      displayUrl: item.displayLink || ''
    })),
    // Google's official Custom Search API has no "People also ask" surface —
    // only Serper (a SERP-scraping API) exposes it. Present but always empty
    // here so callers can read `.peopleAlsoAsk` regardless of which path ran.
    peopleAlsoAsk: [],
    searchCount: dailySearchCount,
    totalResults,
    source: 'google',
  };
}

function getDailyCount() {
  resetIfNewDay();
  return dailySearchCount;
}

module.exports = { searchGoogle, getDailyCount };
