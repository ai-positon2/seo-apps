const axios = require('axios');
const store = require('./store');

// Self-imposed ceiling, independent of the account's actual plan allowance —
// tune here if the limit ever needs to change. There's no per-report cost
// table to keep in sync: usage is measured as the real drop in account
// balance since the first check of the day, via SEMrush's own (free) balance
// endpoint, so this stays accurate even if SEMrush's report pricing changes.
const DAILY_CREDIT_CAP = 100000;

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

async function getAccountBalance() {
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) return null;
  try {
    const res = await axios.get('https://www.semrush.com/users/countapiunits.html', {
      params: { key },
      timeout: 10000,
    });
    const n = parseInt(String(res.data).trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Today's SEMrush credit usage against the self-imposed daily cap.
 * usedToday/remainingToday are null when the balance check itself is
 * unreachable — callers should treat null as "unknown", not zero.
 */
async function getTodayUsage() {
  const today = todayKey();
  const currentBalance = await getAccountBalance();

  if (currentBalance === null) {
    return { date: today, cap: DAILY_CREDIT_CAP, usedToday: null, remainingToday: null, currentBalance: null };
  }

  let state = await store.getSemrushBudgetState();
  if (!state || state.date !== today) {
    state = { date: today, balanceAtStartOfDay: currentBalance };
    await store.saveSemrushBudgetState(state);
  }

  const usedToday = Math.max(0, state.balanceAtStartOfDay - currentBalance);
  return {
    date: today,
    cap: DAILY_CREDIT_CAP,
    usedToday,
    remainingToday: Math.max(0, DAILY_CREDIT_CAP - usedToday),
    currentBalance,
  };
}

// Fails OPEN: if the balance check itself is unreachable, the run proceeds
// rather than blocking the whole tracker over an unrelated endpoint being
// down. Per-call footprints are kept small (see runner.js) specifically so
// a single blind run can't do much damage even if this check is skipped.
async function hasBudgetRemaining() {
  const usage = await getTodayUsage();
  if (usage.usedToday === null) return true;
  return usage.usedToday < usage.cap;
}

module.exports = { getAccountBalance, getTodayUsage, hasBudgetRemaining, DAILY_CREDIT_CAP };
