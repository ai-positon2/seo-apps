const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
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

const USER_AGENT = 'Screaming Frog SEO Spider/23.1';
const PAGE_TIMEOUT = 15000;
const MAX_CONTENT_LENGTH = 5000;
const MAX_CONCURRENCY = 3;

async function runWithConcurrency(items, maxConcurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  const workers = Array.from(
    { length: Math.min(maxConcurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

async function scrapeSinglePage(browser, url) {
  let page;
  try {
    page = await browser.newPage();

    await page.setUserAgent(USER_AGENT);
    await page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
    await page.setDefaultTimeout(PAGE_TIMEOUT);

    // Block images, fonts, media to speed up scraping
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    const content = await page.evaluate((maxLen) => {
      // Remove noise elements
      const removeSelectors = [
        'nav', 'header', 'footer', 'aside',
        '.nav', '.navigation', '.header', '.footer', '.sidebar',
        '.advertisement', '.ad', '.ads', '.cookie', '.cookie-banner',
        '.popup', '.modal', '.overlay', '.social-share', '.related-posts',
        '.comments', '#comments', '.comment-section',
        '[role="navigation"]', '[role="banner"]', '[role="complementary"]',
        '[role="search"]', '[aria-label="advertisement"]',
        'script', 'style', 'noscript', 'iframe', 'svg'
      ];

      removeSelectors.forEach(sel => {
        try {
          document.querySelectorAll(sel).forEach(el => el.remove());
        } catch (e) { /* ignore */ }
      });

      // Try to find main content area
      const contentSelectors = [
        'main', 'article',
        '[role="main"]',
        '.main-content', '.post-content', '.entry-content',
        '.article-content', '.article-body', '.content-body',
        '#content', '#main', '#main-content', '#post-content',
        '.page-content', '.single-content'
      ];

      let mainEl = null;
      for (const sel of contentSelectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText && el.innerText.trim().length > 200) {
          mainEl = el;
          break;
        }
      }

      if (!mainEl) mainEl = document.body;

      let text = mainEl ? (mainEl.innerText || '') : '';
      // Collapse excess whitespace
      text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      return text.substring(0, maxLen);
    }, MAX_CONTENT_LENGTH);

    // Extract h2s for context
    const headings = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('h2')).map(h => h.innerText.trim()).filter(Boolean).slice(0, 10);
    });

    return {
      url,
      content,
      headings,
      wordCount: content.split(/\s+/).filter(Boolean).length,
      success: true,
      error: null
    };
  } catch (err) {
    let errorMessage = err.message || 'Unknown error';
    if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
      errorMessage = 'Timed out after 15 seconds';
    } else if (errorMessage.includes('net::ERR')) {
      errorMessage = 'Network error — page may be blocked or unavailable';
    } else if (errorMessage.includes('Protocol error')) {
      errorMessage = 'Browser protocol error';
    }

    return {
      url,
      content: '',
      headings: [],
      wordCount: 0,
      success: false,
      error: errorMessage
    };
  } finally {
    if (page) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
  }
}

async function scrapeUrls(urls) {
  let browser;
  try {
    const isLocal = !process.env.RAILWAY_ENVIRONMENT && !process.env.RENDER;
    const executablePath = isLocal
      ? findLocalBrowser()
      : await chromium.executablePath();

    browser = await puppeteer.launch({
      headless: isLocal ? true : chromium.headless,
      executablePath,
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });

    const results = await runWithConcurrency(urls, MAX_CONCURRENCY, (url) =>
      scrapeSinglePage(browser, url)
    );

    return results;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
  }
}

async function scrapeSinglePageDetailed(browser, url) {
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setDefaultNavigationTimeout(PAGE_TIMEOUT);
    await page.setDefaultTimeout(PAGE_TIMEOUT);

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT });

    const data = await page.evaluate((maxLen) => {
      const title = document.title || '';
      const h1 = document.querySelector('h1')?.innerText?.trim() || '';
      const h2s = Array.from(document.querySelectorAll('h2')).map(h => h.innerText.trim()).filter(Boolean).slice(0, 15);
      const h3s = Array.from(document.querySelectorAll('h3')).map(h => h.innerText.trim()).filter(Boolean).slice(0, 15);
      const h4s = Array.from(document.querySelectorAll('h4')).map(h => h.innerText.trim()).filter(Boolean).slice(0, 10);

      // Detect FAQs via schema markup, class names, or accordion patterns
      const faqTexts = [];
      const faqSelectors = ['[itemtype*="FAQPage"] [itemprop="name"]', '[class*="faq"] h3', '[class*="faq"] h4', '[id*="faq"] h3', 'details summary', '.accordion-title', '.accordion-header'];
      faqSelectors.forEach(sel => {
        try {
          document.querySelectorAll(sel).forEach(el => {
            const t = el.innerText?.trim();
            if (t && t.length > 10 && t.length < 200) faqTexts.push(t);
          });
        } catch (e) { /* ignore */ }
      });

      // Body text
      const removeSelectors = ['nav', 'header', 'footer', 'aside', 'script', 'style', 'noscript', 'iframe', 'svg'];
      removeSelectors.forEach(sel => {
        try { document.querySelectorAll(sel).forEach(el => el.remove()); } catch (e) { /* ignore */ }
      });
      const mainEl = document.querySelector('main, article, [role="main"], .main-content, .post-content, .entry-content') || document.body;
      let bodyText = (mainEl?.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      bodyText = bodyText.substring(0, maxLen);

      return { title, h1, h2s, h3s, h4s, faqs: [...new Set(faqTexts)].slice(0, 8), bodyText };
    }, 6000);

    return { url, ...data, success: true, error: null };
  } catch (err) {
    let errorMessage = err.message || 'Unknown error';
    if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
      errorMessage = 'Timed out after 15 seconds';
    } else if (errorMessage.includes('net::ERR')) {
      errorMessage = 'Network error — page may be blocked or unavailable';
    }
    console.error(`[scrape-detailed] Failed ${url}: ${errorMessage}`);
    return { url, title: '', h1: '', h2s: [], h3s: [], h4s: [], faqs: [], bodyText: '', success: false, error: errorMessage };
  } finally {
    if (page) {
      try { await page.close(); } catch (e) { /* ignore */ }
    }
  }
}

async function scrapeUrlsDetailed(urls, onProgress) {
  let browser;
  try {
    const isLocal = !process.env.RAILWAY_ENVIRONMENT && !process.env.RENDER;
    const executablePath = isLocal ? findLocalBrowser() : await chromium.executablePath();

    browser = await puppeteer.launch({
      headless: isLocal ? true : chromium.headless,
      executablePath,
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080'
      ]
    });

    const results = [];
    for (let i = 0; i < urls.length; i++) {
      onProgress?.({ index: i, total: urls.length, url: urls[i], status: 'loading' });
      const result = await scrapeSinglePageDetailed(browser, urls[i]);
      results.push(result);
      onProgress?.({ index: i, total: urls.length, url: urls[i], status: result.success ? 'done' : 'error', error: result.error });
    }
    return results;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { scrapeUrls, scrapeUrlsDetailed };
