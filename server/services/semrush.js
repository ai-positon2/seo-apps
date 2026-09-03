const axios = require('axios');

// `database` is optional and defaults to the previous hardcoded value, so
// existing callers are unaffected.
async function getUrlKeywords(url, apiKey, limit = 10, database = 'us') {
  const params = {
    type: 'url_organic',
    key: apiKey,
    url: url,
    database,
    display_limit: limit,
    export_columns: 'Ph,Po,Nq,Cp,Kd',
    display_sort: 'nq_desc'
  };

  let response;
  try {
    response = await axios.get('https://api.semrush.com/', { params, timeout: 15000 });
  } catch (err) {
    throw new Error(`SEMrush request failed: ${err.message}`);
  }

  const text = (response.data || '').toString().trim();

  if (!text || text.startsWith('ERROR')) {
    if (text.includes('WRONG_KEY') || text.includes('key is invalid')) {
      throw new Error('Invalid SEMrush API key. Please check and try again.');
    }
    // No data for this URL — not an error, just empty
    return [];
  }

  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= 1) return []; // only header row

  return lines.slice(1).map(line => {
    const parts = line.split(';');
    return {
      keyword: (parts[0] || '').trim(),
      position: parseInt(parts[1]) || 0,
      volume: parseInt(parts[2]) || 0,
      cpc: parseFloat(parts[3]) || 0,
      difficulty: parseInt(parts[4]) || 0
    };
  }).filter(k => k.keyword);
}

module.exports = { getUrlKeywords };
