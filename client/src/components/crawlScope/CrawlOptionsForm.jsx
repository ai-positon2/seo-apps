// Crawl settings panel, shared by the "new crawl" form and the project editor.
// Field ranges mirror the ceilings in server/.../shared/options.js; the server
// clamps anyway, so these only stop the UI offering something it can't have.
//
// `limits` is the workspace's effective admin limits, which every project API
// response already carries. The Max URLs field used to advertise a hardcoded
// 10,000 whatever the workspace was actually allowed, so the one control whose
// whole job is to choose a page budget was the one control lying about it.

import { Field } from '../../ui';
import { DEFAULT_THRESHOLDS, listOptionText } from './crawlHelpers';

const NUMBERS = [
  { key: 'maxUrls', label: 'Max URLs', min: 1, max: 10000, step: 1,
    limitKey: 'maxUrlsPerCrawl',
    helper: 'Stop after this many URLs.' },
  { key: 'maxExternalUrls', label: 'Max external URLs', min: 0, max: 500, step: 1,
    helper: 'External links checked for a status code. 0 to skip.' },
  { key: 'concurrency', label: 'Concurrency', min: 1, max: 8, step: 1,
    limitKey: 'maxCrawlConcurrency',
    helper: 'Requests in flight at once.' },
  { key: 'timeout', label: 'Request timeout (ms)', min: 3000, max: 30000, step: 500,
    limitKey: 'requestTimeoutMs',
    helper: 'Give up on a single response after this long.' },
  { key: 'perHostDelay', label: 'Per-host delay (ms)', min: 0, max: 60000, step: 50,
    helper: 'Politeness gap between requests to the same host.' },
];

const TOGGLES = [
  { key: 'respectRobots', label: 'Respect robots.txt',
    helper: 'Obeys the rules for CrawlScope. Blocked pages are reported as Googlebot reads robots.txt.' },
  { key: 'discoverSitemaps', label: 'Discover sitemaps',
    helper: 'Seed the crawl from sitemap.xml as well as links.' },
  { key: 'includeSubdomains', label: 'Include subdomains',
    helper: 'Treat blog.example.com as in scope for example.com.' },
  { key: 'crawlAssets', label: 'Crawl assets',
    helper: 'Fetch CSS, JS and images to check they resolve.' },
  { key: 'checkExternalLinks', label: 'Check external links',
    helper: 'Follow outbound links far enough to get a status.' },
  { key: 'renderCheck', label: 'Check JavaScript rendering',
    helper: 'After the crawl, render up to 10 key pages in a browser to see whether scripts add links or content.' },
  { key: 'renderJavaScript', label: 'Render JavaScript (slower)',
    helper: 'Audit every page as a browser builds it, for sites whose links or content come from scripts.' },
  { key: 'scopeToFolder', label: 'Only this folder',
    helper: "Crawl only URLs under the start URL's path, such as /blog/." },
];

// Which part of the site to crawl. Patterns use robots.txt syntax, which is
// what server/modules/crawlScope/url-scope.js matches them with.
const SCOPE_LISTS = [
  { key: 'includePatterns', label: 'Only crawl URLs matching',
    placeholder: '/blog/*\n/news/*',
    helper: 'One pattern per line, as in robots.txt: /blog/* from the start of the path, * for anything, $ for the end. The start page is always crawled.' },
  { key: 'excludePatterns', label: 'Never crawl URLs matching',
    placeholder: '/tag/*\n*?replytocom=',
    helper: 'One pattern per line. A pattern without a leading / matches anywhere in the URL.' },
  { key: 'removeParameters', label: 'Ignore these URL parameters',
    placeholder: 'sort\nfilter',
    helper: 'Parameters that do not make a different page (sort orders, filters). One per line, or * for all.' },
  { key: 'sitemapUrls', label: 'Also read these sitemaps',
    placeholder: 'https://example.com/sitemap-products.xml',
    helper: 'Full sitemap URLs, one per line, for sitemaps robots.txt does not name.' },
];

// The limits the audit judges pages by (server thresholds.js), each with the
// server's bounds.
const THRESHOLD_FIELDS = [
  { key: 'titleMinLength', label: 'Title too short under (characters)', min: 1, max: 200 },
  { key: 'titleMaxLength', label: 'Title too long over (characters)', min: 10, max: 300 },
  { key: 'metaMinLength', label: 'Description too short under (characters)', min: 1, max: 300 },
  { key: 'metaMaxLength', label: 'Description too long over (characters)', min: 50, max: 1000 },
  { key: 'minWords', label: 'Thin page under (words)', min: 1, max: 10000 },
  { key: 'slowResponseMs', label: 'Slow response over (ms)', min: 100, max: 60000 },
  { key: 'maxClickDepth', label: 'Deep page over (clicks from the start page)', min: 1, max: 50 },
  { key: 'urlMaxLength', label: 'URL too long over (characters)', min: 50, max: 2000 },
  { key: 'maxLinksPerPage', label: 'Too many links on a page over', min: 10, max: 100000 },
];

// Settings the crawler ignores in list mode, and why.
//
// A control that silently does nothing is worse than one that is absent: it
// invites someone to set "Max URLs 50" over a 300-URL list and believe they
// have capped it. The server pins maxUrls to the list length, and the crawler
// skips sitemap discovery entirely (`this.mode !== "list"`), so both are shown
// as inert rather than editable.
const INERT_IN_LIST_MODE = {
  maxUrls: 'Set by the list — every URL you give is fetched.',
  discoverSitemaps: 'Not used — a list has no single site to read a sitemap from.',
  scopeToFolder: 'Not used — a list crawl fetches exactly the URLs given.',
  includePatterns: 'Not used — a list crawl fetches exactly the URLs given.',
  excludePatterns: 'Not used — a list crawl fetches exactly the URLs given.',
  removeParameters: 'Not used — a list crawl fetches exactly the URLs given.',
  sitemapUrls: 'Not used — a list has no single site to read a sitemap from.',
};

export default function CrawlOptionsForm({
  options, onChange, disabled = false, mode = 'spider', limits = null,
}) {
  const set = (key, value) => onChange({ ...options, [key]: value });
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const setThreshold = (key, value) => onChange({ ...options, thresholds: { ...thresholds, [key]: value } });
  const inert = (key) => (mode === 'list' ? INERT_IN_LIST_MODE[key] : null);

  // The admin's number when we know it, the static range otherwise — a form
  // rendered before the limits arrive must not advertise 1 as the maximum.
  const ceilingFor = (f) => {
    const value = Number(limits?.[f.limitKey]);
    return Number.isFinite(value) && value > 0 ? Math.min(value, f.max) : f.max;
  };
  const ceilingNote = (f) => {
    const value = Number(limits?.[f.limitKey]);
    if (!Number.isFinite(value) || value <= 0 || value >= f.max) return null;
    return `${f.helper} Your workspace allows up to ${value.toLocaleString('en-US')}.`;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
        {NUMBERS.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            helper={inert(f.key) || ceilingNote(f) || f.helper}
            type="number"
            min={f.min}
            max={ceilingFor(f)}
            step={f.step}
            disabled={disabled || Boolean(inert(f.key))}
            value={options[f.key]}
            onChange={(e) => set(f.key, Number(e.target.value))}
          />
        ))}
      </div>

      {/* The User-Agent the crawl sends. Both say CrawlScope, so robots.txt
          and the site's logs see the same crawler; "Smartphone" is for sites
          that serve phones different pages, which is what Google indexes. */}
      <Field
        label="Crawl as"
        helper="Smartphone sends a mobile browser's user-agent, for sites that serve phones different pages."
        disabled={disabled}
        value={options.userAgentProfile || 'desktop'}
        onChange={(e) => set('userAgentProfile', e.target.value)}
        as="select"
      >
        <option value="desktop">CrawlScope (desktop)</option>
        <option value="mobile">CrawlScope (smartphone)</option>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
        {TOGGLES.map((t) => (
          <label
            key={t.key}
            style={{
              display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px',
              border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
              cursor: disabled || inert(t.key) ? 'default' : 'pointer',
              opacity: disabled || inert(t.key) ? 0.6 : 1,
            }}
          >
            <input
              type="checkbox"
              disabled={disabled || Boolean(inert(t.key))}
              checked={Boolean(options[t.key])}
              onChange={(e) => set(t.key, e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{t.label}</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{inert(t.key) || t.helper}</span>
            </span>
          </label>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 14 }}>
        {SCOPE_LISTS.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            as="textarea"
            rows={3}
            placeholder={f.placeholder}
            helper={inert(f.key) || f.helper}
            disabled={disabled || Boolean(inert(f.key))}
            value={listOptionText(options[f.key])}
            onChange={(e) => set(f.key, e.target.value)}
          />
        ))}
      </div>

      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
          Audit thresholds
        </summary>
        <p style={{ fontSize: 11, color: 'var(--text-3)', margin: '6px 0 12px' }}>
          The limits pages are judged by. A finding measured against a changed limit says which limit it used.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          {THRESHOLD_FIELDS.map((f) => (
            <Field
              key={f.key}
              label={f.label}
              helper={`Default ${DEFAULT_THRESHOLDS[f.key].toLocaleString()}.`}
              type="number"
              min={f.min}
              max={f.max}
              step={1}
              disabled={disabled}
              value={thresholds[f.key]}
              onChange={(e) => setThreshold(f.key, e.target.value === '' ? '' : Number(e.target.value))}
            />
          ))}
        </div>
      </details>
    </div>
  );
}
