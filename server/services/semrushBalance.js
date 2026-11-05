const axios = require('axios');

// "API units" balance check — this Semrush endpoint is free to call and does
// NOT deduct from the account's unit balance, unlike every other Semrush
// report endpoint. Safe to call as often as needed.
const BASE = 'https://www.semrush.com/users/countapiunits.html';
const TIMEOUT = 15000;

async function getApiUnitsBalance() {
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) throw new Error('SEMRUSH_API_KEY not configured');
  let res;
  try {
    res = await axios.get(BASE, { params: { key }, timeout: TIMEOUT });
  } catch (err) {
    if (err.code === 'ECONNABORTED') throw new Error('Semrush balance request timed out');
    throw new Error(`Semrush balance request failed: ${err.message}`);
  }
  // `??`, not `||`: axios parses a body of "0" into the number 0, and `|| ''`
  // turned an empty account into "unexpected response", which hid the badge.
  const raw = String(res.data ?? '').trim();
  const balance = parseInt(raw, 10);
  if (Number.isNaN(balance)) throw new Error(`Unexpected Semrush balance response: "${raw}"`);
  return balance;
}

module.exports = { getApiUnitsBalance };
