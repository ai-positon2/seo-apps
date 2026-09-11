import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminApi } from '../lib/projectsApi';
import {
  Card, Kicker, Muted, Tag, Btn, FadingRule, SectionHead, Spinner,
} from '../components/studio/primitives';

// ── Platform administration (PRD §8, §9, §7.3) ──────────────────────────────
// Limits, rollout flags and administrator grants.
//
// This page renders nothing until the server confirms the caller is a platform
// administrator, and it never decides that itself: /api/admin re-checks the
// persisted grant on every request (§7.3, AC-002), so a user who forces this
// route into view gets a 403 body instead of a control panel. The gate below
// exists to explain that, not to enforce it.
//
// /api/admin/limits, /feature-flags and /grants return the underlying rows, so
// the adapters below are the only place snake_case appears on the client.

// Keys mirror services/adminLimits.js DEFAULT_LIMITS. A key with no entry here
// still renders — the table is driven by what the server sent, not by this map.
const LIMIT_HELP = {
  maxUrlsPerCrawl: 'Hard ceiling on URLs fetched in one crawl.',
  maxCrawlDepth: 'How many links from the start URL a crawl may follow.',
  scheduleMinIntervalHours: 'Shortest gap allowed between scheduled crawls.',
  perProjectConcurrency: 'Crawls one project may run at the same time.',
  globalCrawlConcurrency: 'Crawls this deployment runs at the same time.',
  requestTimeoutMs: 'Per-request fetch timeout.',
  renderTimeoutMs: 'Timeout for a page rendered in a browser.',
  renderBudgetPerRun: 'Pages one run may render rather than fetch.',
  crawlRetryCount: 'Retries per URL before it is recorded as failed.',
  modelCallsPerRun: 'Model calls one run may make.',
  modelSpendPerRunUsd: 'Model spend one run may incur, in USD.',
  providerCallsPerDay: 'Third-party API calls per day.',
  gscFreshnessDays: 'How stale Search Console data may be before it is labelled.',
  measurementRetryDays: 'How long a missing measurement keeps being retried.',
  rawHtmlRetentionMonths: 'Months stored raw HTML is kept.',
  exportRetentionMonths: 'Months generated exports are kept.',
  workspacePurgeGraceDays: 'Days a deleted workspace stays restorable before purge.',
};

const DIRECTION_NOTE = { min: 'lower wins', max: 'higher wins', specific: 'most specific scope wins' };

const numberInput = {
  minHeight: 32,
  padding: '5px 9px',
  fontFamily: 'var(--font-mono)',
  fontSize: 12.5,
  color: 'var(--text)',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-sm)',
  outline: 'none',
  width: 110,
  textAlign: 'right',
};

const textInput = {
  minHeight: 34,
  padding: '6px 10px',
  fontFamily: 'var(--font-sans)',
  fontSize: 13.5,
  color: 'var(--text)',
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-md)',
  outline: 'none',
};

const assignmentView = (row) => ({
  id: row.id,
  flagKey: row.flag_key,
  scope: row.scope,
  scopeRef: row.scope_ref || null,
  enabled: Boolean(row.enabled),
  note: row.note || null,
  updatedAt: row.updated_at || row.created_at || null,
});

const grantView = (row) => ({
  id: row.id,
  email: row.normalized_email,
  userId: row.user_id || null,
  status: row.status,
  source: row.grant_source,
  grantedAt: row.granted_at,
  revokedAt: row.revoked_at || null,
  note: row.note || null,
});

export default function AdminPage() {
  const [state, setState] = useState({ loading: true, denied: false, error: null });
  const [limits, setLimits] = useState(null);
  const [flagKeys, setFlagKeys] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [grants, setGrants] = useState([]);
  const [draft, setDraft] = useState({});
  const [banner, setBanner] = useState(null);

  const load = useCallback(async () => {
    setState({ loading: true, denied: false, error: null });
    try {
      const [limitsRes, flagsRes, grantsRes] = await Promise.all([
        adminApi.limits(),
        adminApi.featureFlags(),
        adminApi.grants({ includeRevoked: true }),
      ]);
      setLimits(limitsRes);
      setFlagKeys(flagsRes.flags || []);
      setAssignments((flagsRes.assignments || []).map(assignmentView));
      setGrants((grantsRes.grants || []).map(grantView));
      setDraft({});
      setState({ loading: false, denied: false, error: null });
    } catch (e) {
      setState({ loading: false, denied: e.status === 403, error: e });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const mutate = useCallback(async (fn, successText) => {
    setBanner(null);
    try {
      await fn();
      await load();
      if (successText) setBanner({ tone: 'accent', text: successText });
    } catch (e) {
      setBanner({ tone: 'neg', text: e.message });
    }
  }, [load]);

  const effective = limits?.limits || {};
  const sources = limits?.sources || {};
  const direction = limits?.direction || {};
  const dirty = useMemo(
    () => Object.keys(draft).some((k) => String(draft[k]) !== String(effective[k])),
    [draft, effective],
  );

  if (state.loading) return <div style={{ padding: 24 }}><Spinner label="Loading platform settings…" /></div>;

  if (state.denied) {
    return (
      <div style={{ padding: '28px 32px', maxWidth: 560 }}>
        <Card style={{ padding: 20, gap: 8 }}>
          <Kicker tone="muted">Not available</Kicker>
          <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500 }}>Platform administration</h1>
          <Muted size={13}>
            This account does not hold a platform administrator grant. Grants live in the database
            and are re-checked on the server for every request, so nothing here can be unlocked from
            the browser.
          </Muted>
        </Card>
      </div>
    );
  }

  if (state.error) {
    return (
      <div style={{ padding: '28px 32px', maxWidth: 560 }}>
        <Card style={{ padding: 20, gap: 8 }}>
          <Kicker tone="muted">Couldn’t load platform settings</Kicker>
          <Muted size={13}>{state.error.message}</Muted>
          <div><Btn variant="primary" onClick={load}>Try again</Btn></div>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px 64px', display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 1080, margin: '0 auto' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <Kicker>Platform</Kicker>
        <h1 style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: '-0.015em' }}>Administration</h1>
        <Muted size={13}>
          Limits, rollout flags and administrator grants. Limit changes are appended as new versions
          rather than edited in place, so the value that applied on any past date stays readable.
        </Muted>
      </div>

      {banner && (
        <div
          role="status"
          style={{
            padding: 12, borderRadius: 'var(--r-md)', fontSize: 13,
            background: `color-mix(in srgb, var(--${banner.tone === 'neg' ? 'viz-neg' : 'primary'}) 12%, transparent)`,
            border: `1px solid color-mix(in srgb, var(--${banner.tone === 'neg' ? 'viz-neg' : 'primary'}) 40%, transparent)`,
            color: banner.tone === 'neg' ? 'var(--viz-neg)' : 'var(--primary-text)',
          }}
        >
          {banner.text}
        </div>
      )}

      {/* ── Database capacity ──────────────────────────────────────────────── */}
      <DatabaseCapacityCard />

      {/* ── Limits ─────────────────────────────────────────────────────────── */}
      <Card style={{ padding: 18 }}>
        <SectionHead
          title="Platform limits"
          right={limits?.policies?.platform ? `Version ${limits.policies.platform.version}` : 'Built-in defaults'}
        />
        <Muted size={12.5} style={{ display: 'block', marginBottom: 12 }}>
          A workspace policy can only make a limit stricter than the platform one. Each key declares
          its direction, so “narrower scope wins” can never quietly raise a ceiling.
        </Muted>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['Key', 'Effective', 'From', 'Precedence', 'New value'].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: h === 'Effective' || h === 'New value' ? 'right' : 'left',
                      fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
                      color: 'var(--text-3)', padding: '6px 8px', fontWeight: 600,
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Object.keys(effective).sort().map((key) => (
                <tr key={key} style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                  <td style={{ padding: 8 }}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{key}</span>
                      {LIMIT_HELP[key] && <Muted>{LIMIT_HELP[key]}</Muted>}
                    </div>
                  </td>
                  <td style={{ padding: 8, textAlign: 'right', fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums' }}>
                    {String(effective[key])}
                  </td>
                  <td style={{ padding: 8 }}>
                    <Tag tone={sources[key] === 'default' ? 'muted' : 'outline'}>{sources[key] || 'default'}</Tag>
                  </td>
                  <td style={{ padding: 8, color: 'var(--text-3)', fontSize: 12 }}>
                    {DIRECTION_NOTE[direction[key]] || '—'}
                  </td>
                  <td style={{ padding: 8, textAlign: 'right' }}>
                    <input
                      style={numberInput}
                      aria-label={`New value for ${key}`}
                      value={draft[key] ?? String(effective[key])}
                      onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <Btn
            variant="primary"
            disabled={!dirty}
            onClick={() => mutate(async () => {
              const changed = {};
              for (const [key, raw] of Object.entries(draft)) {
                if (String(raw) === String(effective[key])) continue;
                const value = Number(raw);
                if (!Number.isFinite(value)) throw new Error(`${key} must be a number.`);
                changed[key] = value;
              }
              await adminApi.createLimitVersion({
                scope: 'platform',
                limits: { ...effective, ...changed },
                note: `Updated ${Object.keys(changed).join(', ')} from the admin page`,
              });
            }, 'New platform limit version published.')}
          >
            Publish new version
          </Btn>
          {dirty && <Btn onClick={() => setDraft({})}>Discard</Btn>}
          <Muted>Publishing appends a version; the previous one stays queryable.</Muted>
        </div>
      </Card>

      {/* ── Feature flags ──────────────────────────────────────────────────── */}
      <FlagsCard flagKeys={flagKeys} assignments={assignments} onMutate={mutate} />

      {/* ── Administrator grants ───────────────────────────────────────────── */}
      <GrantsCard grants={grants} onMutate={mutate} />
    </div>
  );
}

/**
 * One row per known flag, showing its global state, then any narrower
 * assignments underneath. A flag with no assignment at all is off — that is the
 * resolver's default, not a missing row, so it is stated rather than left blank.
 */
// ── Database capacity ───────────────────────────────────────────────────────
// The database has a hard size cap, and before this card the only sign of
// hitting it was an unrelated write failing deep inside a feature ("could not
// extend file because project size limit has been exceeded") — a message that
// names the unlucky insert rather than the table that filled the disk. So this
// shows the headroom and, when there is something to act on, the tables
// actually accounting for it.
//
// It loads on its own rather than joining the page's main load(): capacity is
// diagnostic, and a slow or failing size query must not stop an admin reaching
// the limits and grants they came here for.
function DatabaseCapacityCard() {
  const [usage, setUsage] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      setUsage(await adminApi.databaseCapacity({ refresh }));
      setError(null);
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (error) {
    return (
      <Card style={{ padding: 18 }}>
        <SectionHead title="Database capacity" right={<Btn onClick={() => load(true)}>Retry</Btn>} />
        <Muted size={12.5}>Couldn’t read the database size: {error.message}</Muted>
      </Card>
    );
  }
  if (!usage) {
    return (
      <Card style={{ padding: 18 }}>
        <SectionHead title="Database capacity" />
        <Spinner />
      </Card>
    );
  }
  if (!usage.configured) return null;

  const tone = usage.level === 'critical' ? 'var(--viz-neg)'
    : usage.level === 'warning' ? 'var(--viz-warn)'
      : 'var(--primary)';
  const pct = usage.percent == null ? null : Math.min(100, usage.percent);

  return (
    <Card style={{ padding: 18 }}>
      <SectionHead
        title="Database capacity"
        right={<Btn onClick={() => load(true)} disabled={busy}>{busy ? 'Checking…' : 'Refresh'}</Btn>}
      />

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 500, color: tone }}>{usage.pretty}</span>
        <Muted size={13}>
          of {usage.limitPretty}
          {pct != null && ` — ${pct}% used, ${usage.freePretty} free`}
        </Muted>
        {usage.level !== 'ok' && (
          <Tag tone={usage.level === 'critical' ? 'neg' : 'warn'}>
            {usage.level === 'critical' ? 'Critical' : 'Warning'}
          </Tag>
        )}
      </div>

      {pct != null && (
        <div style={{ height: 6, borderRadius: 3, background: 'var(--surface)', overflow: 'hidden', marginBottom: 10 }}>
          <div style={{ width: `${pct}%`, height: '100%', background: tone, transition: 'width 240ms ease' }} />
        </div>
      )}

      <Muted size={12.5} style={{ display: 'block', marginBottom: 12 }}>
        {usage.level === 'critical'
          ? 'Writes will start failing when this is full, in whichever feature happens to write next.'
          : usage.level === 'warning'
            ? 'Worth planning a clean-up before this fills — a full database fails the next write, not the one that filled it.'
            : `Warns at ${Math.round((usage.thresholds?.warn ?? 0.75) * 100)}%, critical at ${Math.round((usage.thresholds?.critical ?? 0.9) * 100)}%.`}
      </Muted>

      {!!(usage.tables || []).length && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['Largest tables', 'Rows', 'Size'].map((h, i) => (
                  <th
                    key={h}
                    style={{
                      textAlign: i === 0 ? 'left' : 'right',
                      fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase',
                      color: 'var(--text-3)', padding: '6px 8px', fontWeight: 600,
                      borderBottom: '1px solid var(--border)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {usage.tables.map((t) => (
                <tr key={t.table} style={{ borderBottom: '1px solid color-mix(in srgb, var(--border) 55%, transparent)' }}>
                  <td style={{ padding: 8, fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{t.table}</td>
                  <td style={{ padding: 8, textAlign: 'right', color: 'var(--text-2)' }}>{t.rows.toLocaleString()}</td>
                  <td style={{ padding: 8, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{t.pretty}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function FlagsCard({ flagKeys, assignments, onMutate }) {
  const byFlag = useMemo(() => {
    const map = new Map(flagKeys.map((key) => [key, []]));
    for (const a of assignments) {
      if (!map.has(a.flagKey)) map.set(a.flagKey, []);
      map.get(a.flagKey).push(a);
    }
    return map;
  }, [flagKeys, assignments]);

  const toggle = (flagKey, scope, scopeRef, enabled, note) => onMutate(
    () => adminApi.setFeatureFlag({ flagKey, scope, scopeRef, enabled, note }),
    `${flagKey} turned ${enabled ? 'on' : 'off'} for ${scope}${scopeRef ? ` ${scopeRef}` : ''}.`,
  );

  return (
    <Card style={{ padding: 18 }}>
      <SectionHead title="Feature flags" right={`${assignments.length} assignment${assignments.length === 1 ? '' : 's'}`} />
      <Muted size={12.5} style={{ display: 'block', marginBottom: 12 }}>
        Unassigned flags are off. The most specific assignment wins — user over project over
        workspace over global.
      </Muted>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {[...byFlag.entries()].map(([flagKey, rows]) => {
          const global = rows.find((r) => r.scope === 'global');
          const scoped = rows.filter((r) => r.scope !== 'global');
          const on = Boolean(global?.enabled);

          return (
            <div key={flagKey} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5 }}>{flagKey}</span>
                  <Muted>
                    {global
                      ? `Global assignment${global.note ? ` · ${global.note}` : ''}`
                      : 'No global assignment — off everywhere it is not overridden'}
                  </Muted>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Tag tone={on ? 'accent' : 'muted'}>{on ? 'On globally' : 'Off globally'}</Tag>
                  <Btn
                    style={{ height: 30, fontSize: 12, padding: '0 12px' }}
                    onClick={() => toggle(flagKey, 'global', null, !on, global?.note || null)}
                  >
                    Turn {on ? 'off' : 'on'}
                  </Btn>
                </div>
              </div>

              {scoped.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 12, borderLeft: '1px solid var(--border)' }}>
                  {scoped.map((row) => (
                    <div
                      key={row.id || `${row.scope}-${row.scopeRef}`}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}
                    >
                      <Muted size={12}>
                        {row.scope} · {row.scopeRef}
                        {row.note ? ` · ${row.note}` : ''}
                      </Muted>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Tag tone={row.enabled ? 'accent' : 'muted'}>{row.enabled ? 'On' : 'Off'}</Tag>
                        <Btn
                          style={{ height: 26, fontSize: 11.5, padding: '0 10px' }}
                          onClick={() => toggle(row.flagKey, row.scope, row.scopeRef, !row.enabled, row.note)}
                        >
                          Turn {row.enabled ? 'off' : 'on'}
                        </Btn>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function GrantsCard({ grants, onMutate }) {
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const active = grants.filter((g) => g.status === 'active');

  return (
    <Card style={{ padding: 18 }}>
      <SectionHead title="Platform administrators" right={`${active.length} active`} />
      <Muted size={12.5} style={{ display: 'block', marginBottom: 12 }}>
        Grants are matched on the exact email, trimmed and lowercased. The last active grant cannot
        be revoked — that would lock every administrator out rather than change a permission.
      </Muted>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {grants.map((grant) => {
          const revoked = grant.status !== 'active';
          return (
            <div
              key={grant.id}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 12, flexWrap: 'wrap', opacity: revoked ? 0.55 : 1,
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: 13.5 }}>{grant.email}</span>
                <Muted>
                  {grant.source === 'bootstrap' ? 'Seeded on first boot' : 'Granted by an administrator'}
                  {grant.note ? ` · ${grant.note}` : ''}
                  {revoked ? ' · revoked' : ''}
                </Muted>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {grant.userId
                  ? <Tag tone="accent">Linked</Tag>
                  : <Tag tone="muted">Awaiting first sign-in</Tag>}
                {!revoked && active.length > 1 && (
                  <Btn
                    variant="danger"
                    style={{ height: 30, fontSize: 12, padding: '0 12px' }}
                    onClick={() => onMutate(
                      () => adminApi.revokeAdmin(grant.id, 'Revoked from the admin page'),
                      `${grant.email} is no longer a platform administrator.`,
                    )}
                  >
                    Revoke
                  </Btn>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <FadingRule style={{ margin: '14px 0' }} />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          style={{ ...textInput, minWidth: 240 }}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="person@position2.com"
          type="email"
          aria-label="Email to grant platform admin"
        />
        <input
          style={{ ...textInput, minWidth: 200, flex: 1 }}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why (recorded in the audit log)"
          aria-label="Reason for the grant"
        />
        <Btn
          variant="primary"
          disabled={!email.trim()}
          onClick={() => onMutate(async () => {
            await adminApi.grantAdmin(email.trim(), note.trim() || null);
            setEmail('');
            setNote('');
          }, 'Administrator grant added.')}
        >
          Grant admin
        </Btn>
      </div>
    </Card>
  );
}
