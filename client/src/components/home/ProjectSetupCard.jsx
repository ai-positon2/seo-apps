import { useState } from 'react';
import { Card, Kicker, Btn, Muted, Tag, FadingRule } from './primitives';
import { projectsApi } from '../../lib/projectsApi';

// ── Project setup (PRD §20.2) ───────────────────────────────────────────────
// Required: project name, primary domain, country. Optional at setup:
// competitors, schedule, recipients.
//
// The panel states the crawl policy before anything is started — robots
// behaviour, the 5,000-URL initial cap, and the effective administrator limits —
// because §20.2 asks for exactly that, and because a crawler that surprises you
// with what it fetched is a crawler nobody trusts a second time.

// A short list covers most of what this team works on; anything else is typed.
// The server validates against the full ISO 3166-1 alpha-2 list either way, so
// this is a convenience, never the constraint.
const COMMON_COUNTRIES = [
  { code: 'US', label: 'United States' },
  { code: 'CA', label: 'Canada' },
  { code: 'GB', label: 'United Kingdom' },
  { code: 'AU', label: 'Australia' },
  { code: 'IN', label: 'India' },
  { code: 'AE', label: 'United Arab Emirates' },
  { code: 'SG', label: 'Singapore' },
  { code: 'DE', label: 'Germany' },
];

const inputStyle = {
  width: '100%',
  minHeight: 36,
  padding: '7px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  color: 'var(--text)',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  outline: 'none',
};

const Field = ({ label, hint, children, required }) => (
  <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
    <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
      {label}
      {required && <span style={{ color: 'var(--viz-neg)' }}> *</span>}
    </span>
    {children}
    {hint && <Muted size={11}>{hint}</Muted>}
  </label>
);

export default function ProjectSetupCard({ limits, onCreated, onCancel }) {
  const [name, setName] = useState('');
  const [primaryDomain, setPrimaryDomain] = useState('');
  const [country, setCountry] = useState('US');
  const [competitorText, setCompetitorText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Set when the server reports the domain is already tracked in this
  // workspace: the next submit carries confirmDuplicate (PRD §18.2).
  const [duplicate, setDuplicate] = useState(null);

  const maxUrls = limits?.maxUrlsPerCrawl ?? 5000;

  async function submit(event) {
    event?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const competitors = competitorText
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);

      const result = await projectsApi.create({
        name: name.trim() || undefined,
        primaryDomain: primaryDomain.trim(),
        country,
        competitors,
        confirmDuplicate: Boolean(duplicate),
      });

      if (result?.duplicate) {
        setDuplicate(result);
        setBusy(false);
        return;
      }
      onCreated?.(result.project);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <Card elevation="md" style={{ padding: 24, gap: 16, maxWidth: 720 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Kicker>New Project</Kicker>
        <h2 style={{ margin: 0, fontSize: 26, fontWeight: 500, letterSpacing: '-0.015em' }}>
          Set up a client site
        </h2>
        <Muted size={13}>
          A project owns one primary domain and one market. Everything after this — crawls,
          audits, insights and impact — is scoped to it.
        </Muted>
      </div>

      <FadingRule />

      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <Field label="Project name" hint="Defaults to the domain if you leave it blank.">
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Gentle Dental"
              autoComplete="off"
            />
          </Field>

          <Field label="Primary domain" required hint="Paste a domain or a full URL — it is normalized to an origin.">
            <input
              style={inputStyle}
              value={primaryDomain}
              onChange={(e) => { setPrimaryDomain(e.target.value); setDuplicate(null); }}
              placeholder="gentledental.com"
              autoComplete="off"
              required
            />
          </Field>
        </div>

        <Field
          label="Country"
          required
          hint="The market every rank check and Search Console comparison is measured in. It cannot be guessed later."
        >
          <select style={inputStyle} value={country} onChange={(e) => setCountry(e.target.value)}>
            {COMMON_COUNTRIES.map((c) => (
              <option key={c.code} value={c.code}>{c.label} ({c.code})</option>
            ))}
          </select>
        </Field>

        <Field
          label="Competitor domains"
          hint="Optional, and editable later. One per line or comma separated. Competitors are used for competitive evidence only — their sites are never crawled."
        >
          <textarea
            style={{ ...inputStyle, minHeight: 76, resize: 'vertical' }}
            value={competitorText}
            onChange={(e) => setCompetitorText(e.target.value)}
            placeholder={'aspendental.com\nsmiledirectclub.com'}
          />
        </Field>

        {/* Crawl policy, stated before anything runs (PRD §20.2). */}
        <div
          style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            padding: 12, borderRadius: 'var(--r-md)',
            background: 'var(--surface)', border: '1px solid var(--border)',
          }}
        >
          <Kicker tone="muted">Before you start</Kicker>
          <Muted size={12}>
            robots.txt is obeyed on every fetch. Overriding it is possible only for a verified
            primary site, by an administrator, with a reason that is recorded.
          </Muted>
          <Muted size={12}>
            Crawls are capped at <strong style={{ color: 'var(--text-2)' }}>{maxUrls.toLocaleString('en-US')} URLs</strong>{' '}
            and run weekly once scheduled. The cap is set by a platform administrator.
          </Muted>
        </div>

        {duplicate && (
          <div
            style={{
              padding: 12, borderRadius: 'var(--r-md)', fontSize: 12.5,
              background: 'color-mix(in srgb, var(--viz-warn) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--viz-warn) 40%, transparent)',
              color: 'var(--text-2)',
            }}
          >
            {duplicate.message} Submit again to create a second project for the same domain.
          </div>
        )}

        {error && (
          <div
            style={{
              padding: 12, borderRadius: 'var(--r-md)', fontSize: 12.5,
              background: 'color-mix(in srgb, var(--viz-neg) 12%, transparent)',
              border: '1px solid color-mix(in srgb, var(--viz-neg) 40%, transparent)',
              color: 'var(--viz-neg)',
            }}
            role="alert"
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Btn
            variant="primary"
            onClick={submit}
            disabled={busy || !primaryDomain.trim()}
            style={{ fontSize: 15, padding: '11px 20px' }}
          >
            {busy ? 'Creating…' : duplicate ? 'Create anyway' : 'Create project'}
          </Btn>
          {onCancel && (
            <Btn variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Btn>
          )}
          <Tag tone="outline">Weekly schedule · disabled until you enable it</Tag>
        </div>
      </form>
    </Card>
  );
}
