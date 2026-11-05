import { useMemo, useState } from 'react';
import { Card, Kicker, Btn, Muted, Tag, FadingRule } from '../studio/primitives';
import { projectsApi } from '../../lib/projectsApi';
import {
  competitorEstimate, startsOnCreate, autostartOn, MAX_COMPARED_COMPETITORS,
} from '../../lib/projectCreated';

// ── Project setup (PRD §20.2) ───────────────────────────────────────────────
// Required: project name, primary domain, country. Optional at setup:
// competitors, schedule, recipients.
//
// The panel states the crawl policy before anything is started — robots
// behaviour, the 500-URL initial cap, and the effective administrator limits —
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

// What starts on Create, and what Competitor Research costs, live in
// lib/projectCreated.js so the form and the post-create banner agree with the
// server (routes.js POST /) and with the 4-competitor run cap.

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
  // Which jobs creating a project starts on this deployment (GET /api/projects
  // `autostarts`); null from an older server means all of them.
  autostarts = null,
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Set when the server reports the domain is already tracked in this
  // workspace: the next submit carries confirmDuplicate (PRD §18.2).
  const [duplicate, setDuplicate] = useState(null);

  const maxUrls = limits?.maxUrlsPerCrawl ?? 500;

  // Left empty, the server finds competitors itself when the run starts
  // (server/modules/projects/moduleRunners.js); anything typed here is used
  // as-is instead.
  const competitors = useMemo(
    () => competitorText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean),
    [competitorText],
  );
  // Capped at the run's 4 competitors (10,000 units): the estimate never
  // quotes a run the server will not do, and names the ones it will skip.
  const estimate = competitorEstimate(competitors);
  const { autoDiscovers, compared, skipped } = estimate;
  const estimatedUnits = estimate.units;
  const startList = startsOnCreate({ maxUrls, competitors, autostarts });
  const competitorAutostarts = autostartOn(autostarts, 'competitorResearch');
  const crawlAutostarts = autostartOn(autostarts, 'crawl');

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
        confirmDuplicate: Boolean(duplicate),
        // Omitted when there was no choice to make, so the server falls back to
        // the caller's home workspace (their team's).
        ...(workspaceId ? { workspaceId } : {}),
      });

      if (result?.duplicate) {
        setDuplicate(result);
        setBusy(false);
        return;
      }
      // The second argument is what the server did about Competitor Research
      // (kept for callers that only read that); the third is the whole create
      // response, so the banner can name the crawl, audits and AI Visibility
      // run that also started (lib/projectCreated.createdBanner).
      onCreated?.(result.project, result.competitorResearch, result);
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

          <textarea
            style={{ ...inputStyle, minHeight: 76, resize: 'vertical' }}
            value={competitorText}
            onChange={(e) => setCompetitorText(e.target.value)}
            placeholder={'competitor-one.com\ncompetitor-two.com'}
          />
          <Muted size={11}>
            Optional, and editable later. One per line or comma separated. Leave it empty and
            SEMrush + AI suggest competitors for you (marked as AI picks, with the reason, on the
            project's settings). Nothing is compared against them until you accept them there.
            Competitors are used for competitive evidence only — their sites are never crawled.
          </Muted>

          {/* What creating this project will spend, before it is created.
              Competitor Research bills per domain and starts by itself, so
              the number belongs next to the field that decides it — not in a
              run history someone reads afterwards. */}
          <div
            style={{
              display: 'flex', flexDirection: 'column', gap: 4,
              padding: '10px 12px', borderRadius: 'var(--r-md)',
              background: 'color-mix(in srgb, var(--viz-warn) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--viz-warn) 35%, transparent)',
            }}
          >
            <span style={{ fontSize: 12.5, color: 'var(--text)' }}>
              {competitorAutostarts
                ? 'Competitor Research starts as soon as this project is created.'
                : 'Competitor Research does not start by itself on this deployment — run it from its card.'}
            </span>
            {autoDiscovers ? (
              <Muted size={11}>
                With none typed, it searches for up to {estimate.suggests} competitors and saves them as
                suggestions (about{' '}
                <strong style={{ color: 'var(--text-2)' }}>
                  {estimatedUnits.toLocaleString('en-US')} SEMrush units
                </strong>
                ). You review them in project settings; the comparison — roughly{' '}
                {estimate.unitsIfAccepted.toLocaleString('en-US')} units for {estimate.suggests} — runs only
                after you accept them.
              </Muted>
            ) : (
              <Muted size={11}>
                It compares your domain against {compared} competitor{compared === 1 ? '' : 's'}{' '}
                and costs roughly{' '}
                <strong style={{ color: 'var(--text-2)' }}>
                  {estimatedUnits.toLocaleString('en-US')} SEMrush units
                </strong>{' '}
                for the run. A run compares at most {MAX_COMPARED_COMPETITORS} competitors (10,000-unit cap).
                Adding competitors later starts another one.
              </Muted>
            )}
            {skipped.length > 0 && (
              <Muted size={11}>
                Only the first {MAX_COMPARED_COMPETITORS} are compared. Saved on the project but not compared:{' '}
                <strong style={{ color: 'var(--text-2)' }}>{skipped.join(', ')}</strong>.
              </Muted>
            )}
          </div>
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
            Crawls are capped at <strong style={{ color: 'var(--text-2)' }}>{maxUrls.toLocaleString('en-US')} URLs</strong>,
            a cap set by a platform administrator.{' '}
            {crawlAutostarts
              ? 'The first crawl starts as soon as the project is created; only the weekly repeat waits until you enable a schedule.'
              : 'No crawl starts by itself on this deployment: start one from Tech Audit, or enable a schedule.'}
          </Muted>
          <Kicker tone="muted">Starts on Create</Kicker>
          {startList.length ? (
            <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
              {startList.map((line) => (
                <li key={line} style={{ fontSize: 12, color: 'var(--text-3)' }}>{line}</li>
              ))}
            </ul>
          ) : (
            <Muted size={12}>Nothing — every automatic start is off on this deployment.</Muted>
          )}
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
          <Tag tone="outline">Weekly repeat · off until you enable it</Tag>
        </div>
      </form>
    </Card>
  );
}
