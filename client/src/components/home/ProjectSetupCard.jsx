import { useMemo, useState } from 'react';
import { Card, Kicker, Btn, Muted, Tag, FadingRule } from '../studio/primitives';
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

// What one domain costs Competitor Research, mirroring moduleRunners.METERED on
// the server (domain_rank + backlinks_overview + keywords + AIO + branded). The
// client's own domain is charged too, which is the +1 below.
//
// Stated here because the comparison now starts the moment the project is
// created: a price nobody sees until the run history is not a price, it is a
// surprise.
const SEMRUSH_UNITS_PER_DOMAIN = 1955;

// competitorAnalysis/discovery.js — what "find competitors for me" adds when the
// typed list is empty, so the estimate is not blank in the one case where the
// count is not yet known.
const AUTO_DISCOVERY_COUNT = 3;

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

export default function ProjectSetupCard({
  limits, onCreated, onCancel,
  // The workspaces this caller belongs to, and which one is active. Both come
  // straight from GET /api/projects, which already returns them.
  workspaces = [], activeWorkspaceId = null,
}) {
  const [workspaceId, setWorkspaceId] = useState(
    activeWorkspaceId || workspaces[0]?.id || '',
  );
  const [name, setName] = useState('');
  const [primaryDomain, setPrimaryDomain] = useState('');
  const [country, setCountry] = useState('US');
  const [competitorText, setCompetitorText] = useState('');
  const [autoFindCompetitors, setAutoFindCompetitors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Set when the server reports the domain is already tracked in this
  // workspace: the next submit carries confirmDuplicate (PRD §18.2).
  const [duplicate, setDuplicate] = useState(null);

  const maxUrls = limits?.maxUrlsPerCrawl ?? 5000;

  // The toggle and the typed list are not mutually exclusive: whatever is typed
  // here is sent either way, and the server only auto-discovers more
  // competitors if this list is still empty when the run starts
  // (server/modules/projects/moduleRunners.js).
  const competitors = useMemo(
    () => competitorText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    [competitorText],
  );
  const competitorCount = competitors.length;
  const estimatedUnits = (
    (competitorCount || (autoFindCompetitors ? AUTO_DISCOVERY_COUNT : 0)) + 1
  ) * SEMRUSH_UNITS_PER_DOMAIN;

  async function submit(event) {
    event?.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await projectsApi.create({
        name: name.trim() || undefined,
        primaryDomain: primaryDomain.trim(),
        country,
        competitors,
        autoFindCompetitors,
        confirmDuplicate: Boolean(duplicate),
        // Omitted when there was no choice to make, so the server falls back to
        // the session's active workspace exactly as before.
        ...(workspaceId ? { workspaceId } : {}),
      });

      if (result?.duplicate) {
        setDuplicate(result);
        setBusy(false);
        return;
      }
      // The second argument is what the server did about Competitor Research —
      // it starts by itself now, so the caller reports that rather than leaving
      // a metered run to be discovered.
      onCreated?.(result.project, result.competitorResearch);
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

        {/* Which workspace this lands in.
            Only shown when there is a real choice — with one workspace the
            question has one answer and the control is noise. The server has
            always accepted a workspaceId here and membership-checked it; the
            client simply never sent one, so a project went to whichever
            workspace happened to be active. That is how a workspace named after
            a client ends up holding none of that client's work. */}
        {workspaces.length > 1 && (
          <Field
            label="Workspace"
            hint="Everyone in this workspace can open this project and everything it records."
          >
            <select
              style={inputStyle}
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}{w.isPersonal ? ' (personal)' : ''}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Competitor domains</span>

          <label
            style={{
              display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px',
              border: '1px solid var(--border)', borderRadius: 'var(--r-md)', cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={autoFindCompetitors}
              onChange={(e) => setAutoFindCompetitors(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>Find competitors for me</span>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                SEMrush + AI pick them as part of the Competitor Research run this project starts for itself.
                They&rsquo;re added and tracked automatically, no extra confirmation, and you can edit the list
                anytime afterward.
              </span>
            </span>
          </label>

          <textarea
            style={{ ...inputStyle, minHeight: 76, resize: 'vertical' }}
            value={competitorText}
            onChange={(e) => setCompetitorText(e.target.value)}
            placeholder={'aspendental.com\nsmiledirectclub.com'}
          />
          <Muted size={11}>
            {autoFindCompetitors
              ? 'Optional, and editable later. SEMrush + AI only fill this in if it’s still empty when the run starts — anything you type here now is kept as-is.'
              : 'Optional, and editable later. One per line or comma separated. Competitors are used for competitive evidence only — their sites are never crawled.'}
          </Muted>

          {/* What creating this project will spend, before it is created.
              Competitor Research bills per domain and now starts by itself, so
              the number belongs next to the field that decides it — not in a
              run history someone reads afterwards. */}
          {(competitorCount > 0 || autoFindCompetitors) && (
            <div
              style={{
                display: 'flex', flexDirection: 'column', gap: 4,
                padding: '10px 12px', borderRadius: 'var(--r-md)',
                background: 'color-mix(in srgb, var(--viz-warn) 10%, transparent)',
                border: '1px solid color-mix(in srgb, var(--viz-warn) 35%, transparent)',
              }}
            >
              <span style={{ fontSize: 12.5, color: 'var(--text)' }}>
                Competitor Research starts as soon as this project is created.
              </span>
              <Muted size={11}>
                It compares your domain against {autoFindCompetitors && !competitorCount
                  ? 'the competitors it finds'
                  : `${competitorCount} competitor${competitorCount === 1 ? '' : 's'}`}{' '}
                and costs roughly{' '}
                <strong style={{ color: 'var(--text-2)' }}>
                  {estimatedUnits.toLocaleString('en-US')} SEMrush units
                </strong>{' '}
                {autoFindCompetitors && !competitorCount ? '(estimated) ' : ''}
                for the run. Adding competitors later starts another one.
              </Muted>
            </div>
          )}
        </div>

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
