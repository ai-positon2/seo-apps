const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

function findLocalBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    `C:\\Users\\${process.env.USERNAME}\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe`,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

const ONPAGE_META = {
  form_labels: {
    cat: 'Forms', label: 'Form label association', effort: 'quick', maxScore: 10,
    business: 'Unlabeled form fields are invisible to AI agents filling forms on behalf of users. Agent-assisted checkout, booking, and lead gen flows fail silently — the agent has no way to know what data each field expects.',
    action: 'Add <label for="[id]"> linked to each input\'s id attribute, or add aria-label to every form input. This is a 15-minute fix for a developer familiar with your forms.',
  },
  input_type: {
    cat: 'Forms', label: 'Input type correctness', effort: 'quick', maxScore: 6,
    business: 'Using type="text" for email or phone fields blocks browser and agent autofill. Agents infer the expected data type from the input\'s type attribute — mismatches cause submission errors or silently skipped fields.',
    action: 'Set type="email" for email fields, type="tel" for phone numbers, type="number" for quantities, type="date" for date fields. Each fix is a one-line change.',
  },
  autocomplete: {
    cat: 'Forms', label: 'Autocomplete attributes', effort: 'quick', maxScore: 6,
    business: 'Without autocomplete attributes, agents cannot reliably map a user\'s stored data (name, address, payment) to your form fields. This breaks agent-assisted form completion and forces manual field-by-field matching.',
    action: 'Add autocomplete="email", autocomplete="tel", autocomplete="name", autocomplete="street-address", etc. to all form inputs. Full token list at html.spec.whatwg.org.',
  },
  schema_search: {
    cat: 'On-Page Signals', label: 'Schema.org SearchAction', effort: 'medium', maxScore: 5,
    business: 'Without a SearchAction in JSON-LD, agents must navigate to your site and guess the search URL structure. Sites that declare SearchAction receive direct, parameterised search queries from AI assistants — bypassing navigation entirely.',
    action: 'Add potentialAction with @type: SearchAction and a target URL template (e.g., "https://example.com/search?q={search_term_string}") to your homepage JSON-LD. ~half a day of dev time.',
  },
  schema_action: {
    cat: 'On-Page Signals', label: 'Schema.org transactional actions', effort: 'medium', maxScore: 5,
    business: 'Agents cannot complete purchases, reservations, or bookings without declared transactional actions in JSON-LD. Competitors who declare BuyAction or OrderAction can be invoked directly by AI assistants to complete transactions on your behalf.',
    action: 'Add potentialAction with @type: BuyAction, OrderAction, ReserveAction, or BookAction to your product or service page JSON-LD. Include a urlTemplate pointing to the action endpoint.',
  },
  captcha: {
    cat: 'On-Page Signals', label: 'CAPTCHA detection', effort: 'high', maxScore: 8,
    business: 'CAPTCHAs block 100% of AI agents from completing actions on your site. A CAPTCHA anywhere in a checkout, booking, or lead form flow is a hard wall — no AI agent can pass it. Every agentic interaction that hits a CAPTCHA is a lost transaction.',
    action: 'Replace CAPTCHA with OAuth 2.1 agent identity verification for authenticated agent flows. If CAPTCHA must remain for anonymous users, ensure verified agent identities bypass it. This is a strategic engineering investment, not a quick fix.',
  },
  cookie_banner: {
    cat: 'On-Page Signals', label: 'Cookie banner accessibility', effort: 'quick', maxScore: 6,
    business: 'An inaccessible cookie consent banner stops AI agents at the door. If an agent cannot programmatically dismiss the banner, it cannot access any content, complete any form, or execute any transaction on your site.',
    action: 'Ensure the dismiss button is a native <button> element — not a styled <div> or <span>. Make sure it has no tabindex="-1" restriction. This is a 30-minute fix with most CMP vendors (OneTrust, Cookiebot, etc.).',
  },
  js_rendering: {
    cat: 'On-Page Signals', label: 'JavaScript rendering gap', effort: 'medium', maxScore: 8,
    business: '69% of AI crawlers do not execute JavaScript. Forms, CTAs, and pricing that only exist after JS renders are completely invisible to the majority of AI traffic — including the crawlers that power ChatGPT, Perplexity, and Claude.',
    action: 'Use server-side rendering (SSR) or static HTML generation for all critical page content: forms, pricing, primary CTAs, and product data. Frameworks like Next.js, Nuxt, and Astro support this out of the box.',
  },
  vague_buttons: {
    cat: 'Forms', label: 'Vague button labels', effort: 'quick', maxScore: 4, flagOnly: true,
    business: 'Agents interpret button labels literally to determine what an action does and whether to click it. Labels like "Submit", "Continue", or "Go" provide no context. Agents either skip the action, misidentify it, or take the wrong branch in a multi-step flow.',
    action: 'Replace generic labels with action-specific copy: "Continue to payment" not "Continue", "Confirm and place order" not "Submit", "Search flights" not "Go". This is a copy change, no engineering required.',
  },
  interactive_divs: {
    cat: 'Forms', label: 'Interactive div detection', effort: 'medium', maxScore: 5,
    business: 'Clickable <div> and <span> elements without semantic role attributes are invisible to AI agents. Agents use semantic HTML to identify interactive elements — custom clickables without ARIA attributes are silently ignored, causing agents to miss key actions.',
    action: 'Replace interactive divs with native <button> or <a href> elements wherever possible. If custom elements must be kept, add role="button" and tabindex="0" to make them accessible to agent interactions.',
  },
};

const CHECK_SLOTS = {
  form_labels:      ['url_form'],
  input_type:       ['url_form'],
  autocomplete:     ['url_form'],
  schema_search:    ['url_homepage'],
  schema_action:    ['url_action'],
  captcha:          ['url_form', 'url_action'],
  cookie_banner:    ['url_homepage'],
  js_rendering:     ['url_homepage', 'url_action', 'url_form'],
  vague_buttons:    ['url_action', 'url_form'],
  interactive_divs: ['url_action', 'url_form'],
};

// ── Individual check implementations ─────────────────────────────────────────

async function checkFormLabels(page) {
  try {
    const inputs = await page.$$eval(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"])',
      (els) => els.map(el => {
        const id = el.id;
        const hasLinkedLabel = id ? !!document.querySelector(`label[for="${id}"]`) : false;
        const hasAriaLabel = !!el.getAttribute('aria-label');
        const hasAriaLabelledBy = !!el.getAttribute('aria-labelledby');
        return {
          name: el.name || '(no name)',
          type: el.type || 'text',
          labeled: hasLinkedLabel || hasAriaLabel || hasAriaLabelledBy,
          method: hasLinkedLabel ? 'label[for]' : hasAriaLabel ? 'aria-label' : hasAriaLabelledBy ? 'aria-labelledby' : 'none',
        };
      })
    );
    const unlabeled = inputs.filter(i => !i.labeled);
    const pass = unlabeled.length === 0;
    return {
      pass,
      detail: pass
        ? `All ${inputs.length} inputs are properly labeled.`
        : `${unlabeled.length} of ${inputs.length} inputs unlabeled: ${unlabeled.map(i => `name="${i.name}" type="${i.type}"`).join(', ')}`,
    };
  } catch (e) {
    return { pass: false, detail: `Check errored: ${e.message}` };
  }
}

async function checkInputType(page) {
  try {
    const mismatches = await page.$$eval(
      'input[type="text"], input:not([type])',
      (els) => {
        const signals = {
          email:    /email/i,
          tel:      /phone|tel|mobile|cell/i,
          number:   /number|qty|quantity|count|amount/i,
          date:     /\bdate\b/i,
          password: /password|passwd/i,
        };
        return els.map(el => {
          const hay = `${el.name} ${el.id} ${el.placeholder}`;
          let expected = null;
          for (const [type, pat] of Object.entries(signals)) {
            if (pat.test(hay)) { expected = type; break; }
          }
          return { name: el.name || el.id || '(unnamed)', current: el.type || 'text', expected, mismatch: expected && el.type !== expected };
        }).filter(i => i.mismatch);
      }
    );
    const pass = mismatches.length === 0;
    return {
      pass,
      detail: pass
        ? 'All inputs use the correct type attribute.'
        : mismatches.map(i => `name="${i.name}" — type is "${i.current}", expected "${i.expected}"`).join('; '),
    };
  } catch (e) {
    return { pass: false, detail: `Check errored: ${e.message}` };
  }
}

async function checkAutocomplete(page) {
  try {
    const missing = await page.$$eval(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="image"])',
      (els) => els.filter(el => !el.getAttribute('autocomplete')).map(el => ({ name: el.name || el.id || '(unnamed)', type: el.type || 'text' }))
    );
    const pass = missing.length === 0;
    return {
      pass,
      detail: pass
        ? 'All inputs have autocomplete attributes.'
        : `${missing.length} inputs missing autocomplete: ${missing.map(i => `"${i.name}" (${i.type})`).join(', ')}`,
    };
  } catch (e) {
    return { pass: false, detail: `Check errored: ${e.message}` };
  }
}

async function checkSchemaSearch(page) {
  try {
    const schemas = await page.$$eval('script[type="application/ld+json"]',
      (els) => els.map(el => { try { return JSON.parse(el.textContent); } catch { return null; } }).filter(Boolean)
    );
    let found = false;
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (obj['@type'] === 'SearchAction') { found = true; return; }
      if (obj.potentialAction) {
        const acts = Array.isArray(obj.potentialAction) ? obj.potentialAction : [obj.potentialAction];
        if (acts.some(a => a['@type'] === 'SearchAction')) { found = true; return; }
      }
      Object.values(obj).forEach(v => typeof v === 'object' && walk(v));
    };
    schemas.forEach(walk);
    return {
      pass: found,
      detail: found
        ? 'SearchAction found in JSON-LD — agents can construct search queries directly.'
        : 'No SearchAction in JSON-LD. Add potentialAction with @type: SearchAction and a target URL template to your homepage JSON-LD.',
    };
  } catch (e) {
    return { pass: false, detail: `Check errored: ${e.message}` };
  }
}

async function checkSchemaAction(page) {
  try {
    const types = ['BuyAction', 'OrderAction', 'ReserveAction', 'BookAction'];
    const schemas = await page.$$eval('script[type="application/ld+json"]',
      (els) => els.map(el => { try { return JSON.parse(el.textContent); } catch { return null; } }).filter(Boolean)
    );
    const found = [];
    const walk = (obj) => {
      if (!obj || typeof obj !== 'object') return;
      if (types.includes(obj['@type'])) found.push(obj['@type']);
      if (obj.potentialAction) {
        const acts = Array.isArray(obj.potentialAction) ? obj.potentialAction : [obj.potentialAction];
        acts.forEach(a => { if (types.includes(a['@type'])) found.push(a['@type']); });
      }
      Object.values(obj).forEach(v => typeof v === 'object' && walk(v));
    };
    schemas.forEach(walk);
    const pass = found.length > 0;
    return {
      pass,
      detail: pass
        ? `Transactional actions found: ${[...new Set(found)].join(', ')}`
        : 'No BuyAction, OrderAction, ReserveAction, or BookAction found in JSON-LD on this page.',
    };
  } catch (e) {
    return { pass: false, detail: `Check errored: ${e.message}` };
  }
}

async function checkCaptcha(page) {
  try {
    const signals = await page.evaluate(() => {
      const srcs = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
      const patterns = [
        /google\.com\/recaptcha/i, /recaptcha\.net/i, /hcaptcha\.com/i,
        /turnstile\.cloudflare\.com/i, /challenges\.cloudflare\.com/i,
        /funcaptcha\.com/i, /arkoselabs\.com/i,
      ];
      const matched = srcs.filter(src => patterns.some(p => p.test(src)));
      const domSignal = !!(
        document.querySelector('.g-recaptcha') ||
        document.querySelector('.h-captcha') ||
        document.querySelector('[data-sitekey]') ||
        document.querySelector('iframe[src*="recaptcha"]') ||
        document.querySelector('iframe[src*="hcaptcha"]')
      );
      return { matched, domSignal };
    });
    const pass = signals.matched.length === 0 && !signals.domSignal;
    return {
      pass,
      detail: pass
        ? 'No CAPTCHA signals detected.'
        : `CAPTCHA detected — ${[...signals.matched.map(s => new URL(s).hostname), signals.domSignal ? 'DOM element' : ''].filter(Boolean).join(', ')}. This blocks all AI agents from completing actions on this page. Replace with OAuth 2.1 agent identity verification for agent flows.`,
    };
  } catch (e) {
    return { pass: false, detail: `Check errored: ${e.message}` };
  }
}

async function checkCookieBanner(page) {
  try {
    const result = await page.evaluate(() => {
      const selectors = [
        '#onetrust-banner-sdk', '#CybotCookiebotDialog', '.cc-banner',
        '#cookie-banner', '#cookie-notice',
        '[id*="cookie"][id*="banner"]', '[id*="cookie"][id*="consent"]',
        '[class*="cookie"][class*="banner"]', '[class*="consent-banner"]',
        '[aria-label*="cookie"]',
      ];
      let el = null;
      for (const sel of selectors) {
        try { el = document.querySelector(sel); if (el) break; } catch {}
      }
      if (!el) return { found: false };
      const buttons = el.querySelectorAll('button');
      const focusable = Array.from(buttons).some(b => b.tabIndex !== -1);
      const labels = Array.from(buttons).map(b => b.textContent.trim()).filter(Boolean);
      return { found: true, hasButton: buttons.length > 0, focusable, labels };
    });
    const pass = !result.found || (result.hasButton && result.focusable);
    let detail;
    if (!result.found) detail = 'No cookie consent banner detected.';
    else if (!result.hasButton) detail = 'Cookie banner uses a non-button dismiss element (<div> or <span>). Agents cannot dismiss it and will be blocked at site entry.';
    else if (!result.focusable) detail = `Cookie banner button (labels: "${result.labels.join('", "')}") has tabindex="-1" — agents using keyboard navigation cannot dismiss it.`;
    else detail = `Cookie banner uses accessible <button> elements (labels: "${result.labels.join('", "')}").`;
    return { pass, detail };
  } catch (e) {
    return { pass: false, detail: `Check errored: ${e.message}` };
  }
}

async function checkJsRendering(url, page) {
  try {
    const rawResp = await axios.get(url, {
      timeout: 8000,
      headers: { 'User-Agent': 'Screaming Frog SEO Spider/23.1' },
      validateStatus: () => true,
    });
    const rawHtml = typeof rawResp.data === 'string' ? rawResp.data : '';
    const $ = cheerio.load(rawHtml);
    const raw = {
      forms:   $('form').length,
      inputs:  $('input:not([type="hidden"])').length,
      buttons: $('button').length,
      price:   /[$£€₹]\s?\d+|price|cost/i.test(rawHtml),
    };
    const rendered = await page.evaluate(() => ({
      forms:   document.querySelectorAll('form').length,
      inputs:  document.querySelectorAll('input:not([type="hidden"])').length,
      buttons: document.querySelectorAll('button').length,
      price:   /[$£€₹]\s?\d+|price|cost/i.test(document.body.innerText),
    }));
    const gaps = [];
    if (rendered.forms > 0 && raw.forms === 0)             gaps.push('forms');
    if (rendered.inputs > raw.inputs * 2)                   gaps.push('form inputs');
    if (rendered.buttons > 0 && raw.buttons === 0)          gaps.push('buttons');
    if (rendered.price && !raw.price)                       gaps.push('pricing content');
    const pass = gaps.length === 0;
    return {
      pass,
      detail: pass
        ? 'No rendering gap — critical content is present in raw HTML.'
        : `JS-only content detected: ${gaps.join(', ')}. 69% of AI crawlers cannot execute JavaScript and will not see this content.`,
    };
  } catch (e) {
    return { pass: false, detail: `Check errored: ${e.message}` };
  }
}

async function checkVagueButtons(page) {
  try {
    const vague = ['continue', 'next', 'submit', 'click here', 'go', 'ok', 'done', 'proceed', 'confirm', 'send', 'back'];
    const all = await page.$$eval(
      'button, input[type="submit"], input[type="button"], [role="button"]',
      (els) => els.map(el => (el.textContent?.trim() || el.value?.trim() || el.getAttribute('aria-label') || '').toLowerCase().trim()).filter(l => l)
    );
    const flagged = all.filter(l => vague.includes(l));
    const pass = flagged.length === 0;
    return {
      pass,
      flagOnly: true,
      detail: pass
        ? 'No vague button labels detected.'
        : `Generic labels flagged for review: "${flagged.join('", "')}". Agents interpret labels literally — replace with action-specific copy like "Continue to payment" or "Confirm and place order".`,
    };
  } catch (e) {
    return { pass: false, flagOnly: true, detail: `Check errored: ${e.message}` };
  }
}

async function checkInteractiveDivs(page) {
  try {
    const problematic = await page.$$eval('div[onclick], span[onclick]', (els) =>
      els.filter(el => !el.getAttribute('role') || !el.getAttribute('tabindex')).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: el.textContent.trim().slice(0, 50),
        noRole: !el.getAttribute('role'),
        noTabindex: !el.getAttribute('tabindex'),
      }))
    );
    const pass = problematic.length === 0;
    return {
      pass,
      detail: pass
        ? 'No inaccessible interactive elements detected.'
        : `${problematic.length} interactive element(s) missing ARIA attributes: ${problematic.map(e => `<${e.tag}> "${e.text}"${e.noRole ? ' no role' : ''}${e.noTabindex ? ' no tabindex' : ''}`).join('; ')}. Add role="button" tabindex="0" or replace with <button>.`,
    };
  } catch (e) {
    return { pass: false, detail: `Check errored: ${e.message}` };
  }
}

const CHECK_FNS = {
  form_labels:      (url, page) => checkFormLabels(page),
  input_type:       (url, page) => checkInputType(page),
  autocomplete:     (url, page) => checkAutocomplete(page),
  schema_search:    (url, page) => checkSchemaSearch(page),
  schema_action:    (url, page) => checkSchemaAction(page),
  captcha:          (url, page) => checkCaptcha(page),
  cookie_banner:    (url, page) => checkCookieBanner(page),
  js_rendering:     (url, page) => checkJsRendering(url, page),
  vague_buttons:    (url, page) => checkVagueButtons(page),
  interactive_divs: (url, page) => checkInteractiveDivs(page),
};

// ── Main runner ───────────────────────────────────────────────────────────────

async function runOnPageChecks(urls) {
  const localBrowser = findLocalBrowser();
  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: localBrowser || (await chromium.executablePath()),
      headless: true,
      args: localBrowser ? ['--no-sandbox', '--disable-setuid-sandbox'] : chromium.args,
      defaultViewport: localBrowser ? { width: 1280, height: 800 } : chromium.defaultViewport,
    });
  } catch (e) {
    throw new Error(`Failed to launch browser for on-page checks: ${e.message}`);
  }

  // For each slot, open page once and run all checks that apply
  const slotData = {}; // slot -> { checkId -> result }

  for (const slot of ['url_homepage', 'url_action', 'url_form']) {
    const url = urls[slot];
    if (!url) continue;

    const checksForSlot = Object.entries(CHECK_SLOTS)
      .filter(([, slots]) => slots.includes(slot))
      .map(([id]) => id);

    let page;
    try {
      page = await browser.newPage();
      await page.setUserAgent('Screaming Frog SEO Spider/23.1');
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 25000 });
      slotData[slot] = {};
      for (const checkId of checksForSlot) {
        slotData[slot][checkId] = await CHECK_FNS[checkId](url, page);
      }
    } catch (e) {
      slotData[slot] = {};
      for (const checkId of checksForSlot) {
        slotData[slot][checkId] = { pass: false, detail: `Page could not be loaded: ${e.message}` };
      }
    } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  await browser.close().catch(() => {});

  // Aggregate across slots — for checks that run on multiple slots, fail wins
  const aggregated = {};
  for (const [checkId, slots] of Object.entries(CHECK_SLOTS)) {
    const available = slots.filter(s => slotData[s]?.[checkId] !== undefined);
    if (available.length === 0) continue;
    const results = available.map(s => ({ ...slotData[s][checkId], slot: s }));
    const worst = results.find(r => !r.pass) || results[0];
    aggregated[checkId] = worst;
  }

  // Build final check objects
  return Object.entries(aggregated).map(([id, result]) => {
    const meta = ONPAGE_META[id];
    return {
      id,
      cat: meta.cat,
      label: meta.label,
      effort: meta.effort,
      business: meta.business,
      action: meta.action,
      maxScore: meta.maxScore,
      flagOnly: meta.flagOnly || false,
      status: result.pass ? 'pass' : (meta.flagOnly ? 'info' : 'fail'),
      tech: result.detail,
      detail: result.detail,
      score: result.pass ? meta.maxScore : 0,
    };
  });
}

module.exports = { runOnPageChecks, ONPAGE_META };
