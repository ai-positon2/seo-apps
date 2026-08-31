// Crawl settings panel, shared by the "new crawl" form and the project editor.
// Field ranges mirror the ceilings in server/.../shared/options.js; the server
// clamps anyway, so these only stop the UI offering something it can't have.

import { Field } from '../../ui';

const NUMBERS = [
  { key: 'maxUrls', label: 'Max URLs', min: 1, max: 5000, step: 1,
    helper: 'Stop after this many URLs.' },
  { key: 'maxExternalUrls', label: 'Max external URLs', min: 0, max: 500, step: 1,
    helper: 'External links checked for a status code. 0 to skip.' },
  { key: 'concurrency', label: 'Concurrency', min: 1, max: 8, step: 1,
    helper: 'Requests in flight at once.' },
  { key: 'timeout', label: 'Request timeout (ms)', min: 3000, max: 30000, step: 500,
    helper: 'Give up on a single response after this long.' },
  { key: 'perHostDelay', label: 'Per-host delay (ms)', min: 0, max: 60000, step: 50,
    helper: 'Politeness gap between requests to the same host.' },
];

const TOGGLES = [
  { key: 'respectRobots', label: 'Respect robots.txt',
    helper: 'Uses CrawlScope as the user-agent token.' },
  { key: 'discoverSitemaps', label: 'Discover sitemaps',
    helper: 'Seed the crawl from sitemap.xml as well as links.' },
  { key: 'includeSubdomains', label: 'Include subdomains',
    helper: 'Treat blog.example.com as in scope for example.com.' },
  { key: 'crawlAssets', label: 'Crawl assets',
    helper: 'Fetch CSS, JS and images to check they resolve.' },
  { key: 'checkExternalLinks', label: 'Check external links',
    helper: 'Follow outbound links far enough to get a status.' },
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
};

export default function CrawlOptionsForm({
  options, onChange, disabled = false, mode = 'spider',
}) {
  const set = (key, value) => onChange({ ...options, [key]: value });
  const inert = (key) => (mode === 'list' ? INERT_IN_LIST_MODE[key] : null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
        {NUMBERS.map((f) => (
          <Field
            key={f.key}
            label={f.label}
            helper={inert(f.key) || f.helper}
            type="number"
            min={f.min}
            max={f.max}
            step={f.step}
            disabled={disabled || Boolean(inert(f.key))}
            value={options[f.key]}
            onChange={(e) => set(f.key, Number(e.target.value))}
          />
        ))}
      </div>

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
    </div>
  );
}
