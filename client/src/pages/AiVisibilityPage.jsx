import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { SectionHeader } from '../ui/SectionHeader';
import { useActiveProjectId } from '../lib/activeProject';
import { projectsApi } from '../lib/projectsApi';

// ── AI Visibility report ─────────────────────────────────────────────────────
//
// What ChatGPT and Google AI Overview say about this client. The only module
// whose evidence is about somebody else's product, which is why every number
// here is labelled with the surface it came from.
//
// The reading this page has to get right: a score is over MEASURED captures,
// never attempted ones. A provider timeout is not an absent brand, so coverage
// sits next to the score rather than in a footnote — if 12 of 40 captures
// failed, "30/100" means something quite different.

async function req(path) {
  const res = await fetch(path, { credentials: 'include' });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed.'), { code: data.code });
  return data;
}

const card = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)',
  padding: 18,
};

const muted = { fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 };

function band(score) {
  if (score === null || score === undefined) return 'var(--text-3)';
  if (score >= 60) return 'var(--success)';
  if (score >= 30) return 'var(--warning)';
  return 'var(--danger)';
}

/** A bar whose width is a share of the widest value, not of 100. */
function Bar({ value, max, color }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ height: 6, borderRadius: 999, background: 'color-mix(in srgb, var(--text-3) 16%, transparent)', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color || 'var(--primary)', borderRadius: 999 }} />
    </div>
  );
}

export default function AiVisibilityPage() {
  const [activeProjectId] = useActiveProjectId();
  const [projects, setProjects] = useState(null);
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    projectsApi.list()
      .then((d) => setProjects(d.projects || []))
      .catch(() => setProjects([]));
  }, []);

  const project = projects?.find((p) => p.id === activeProjectId) || projects?.[0] || null;

  const load = useCallback(async () => {
    if (!project) return;
    setState({ loading: true, error: null, data: null });
    try {
      setState({ loading: false, error: null, data: await req(`/api/ai-visibility/${project.id}/report`) });
    } catch (e) {
      setState({ loading: false, error: e, data: null });
    }
  }, [project?.id]);

  useEffect(() => { load(); }, [load]);

  if (projects === null || (project && state.loading)) {
    return <main style={{ padding: '28px 32px' }}><div style={muted}>Reading stored captures…</div></main>;
  }

  if (!project) {
    return (
      <main style={{ padding: '28px 32px' }}>
        <SectionHeader title="AI Visibility" subtitle="No client selected." />
      </main>
    );
  }

  const { data, error } = state;
  const report = data?.report;
  const run = data?.run;

  return (
    <main style={{ padding: '28px 32px 64px', maxWidth: 1120, margin: '0 auto' }}>
      <SectionHeader
        title={`AI Visibility — ${project.name}`}
        subtitle="Whether answer engines name this client, and which sources they cite instead."
        actions={<Link to="/" style={{ fontSize: 12, color: 'var(--text-2)' }}>Dashboard</Link>}
      />

      {error && (
        <div style={{ ...card, borderColor: 'var(--danger)', marginBottom: 16 }}>
          <div style={{ fontSize: 13, color: 'var(--text)' }}>{error.message}</div>
          {error.code === 'migration_needed' && (
            <div style={{ ...muted, marginTop: 6 }}>
              Apply <code>supabase/migrations/0016_ai_visibility.sql</code>, then reload.
            </div>
          )}
        </div>
      )}

      {!error && !run && (
        <div style={card}>
          <div style={{ fontSize: 14, color: 'var(--text)' }}>This module has not run yet.</div>
          <div style={{ ...muted, marginTop: 6 }}>
            Run AI Visibility from the dashboard card. A run measures the stored prompt set
            across ChatGPT and Google AI Overview and takes 30–60 minutes.
          </div>
        </div>
      )}

      {/* A run that produced no captures is NOT a zero score — it is an unknown. */}
      {!error && run && !report && (
        <div style={{ ...card, borderColor: 'var(--warning)' }}>
          <div style={{ fontSize: 14, color: 'var(--text)' }}>
            The last run stored no captures, so nothing is known about this client&apos;s visibility.
          </div>
          <div style={{ ...muted, marginTop: 6 }}>
            {run.error || run.note || 'No answer was captured. This is not an absence of the brand.'}
          </div>
        </div>
      )}

      {report && (
        <>
          {/* ── Headline ─────────────────────────────────────────────────── */}
          <div style={{ ...card, display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--text-3)', fontWeight: 600 }}>
                Visibility
              </div>
              <div style={{ fontSize: 46, lineHeight: 1.05, color: band(report.score), fontFamily: 'var(--font-mono)' }}>
                {report.score === null ? '—' : report.score}
                {report.score !== null && <span style={{ fontSize: 18, color: 'var(--text-3)' }}>/100</span>}
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
                Named in <strong>{report.promptsNaming}</strong> of{' '}
                <strong>{report.coverage.measured}</strong> measured captures.
              </div>
              {/* Coverage next to the score, not beneath it: a score over 4 of 40
                  captures is a different claim from one over 40 of 40. */}
              <div style={{ ...muted, marginTop: 6 }}>
                Coverage: {report.coverage.measured} of {report.coverage.total} captured
                {report.coverage.failed ? `, ${report.coverage.failed} not measured` : ''}.
              </div>
              {report.coverage.failureReasons?.map((f) => (
                <div key={f.reason} style={{ ...muted, color: 'var(--warning)' }}>
                  {f.count}× {f.reason}
                </div>
              ))}
              {run?.scoreBasis && (
                <div style={{ ...muted, marginTop: 8, fontStyle: 'italic' }}>{run.scoreBasis}</div>
              )}
            </div>
          </div>

          {/* ── Share of voice + who gets cited ──────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginTop: 16 }}>
            <div style={card}>
              <h3 style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--text)' }}>Share of voice</h3>
              {!report.shareOfVoice.length && <div style={muted}>Nobody was named.</div>}
              {report.shareOfVoice.map((s) => (
                <div key={s.name} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                    <span style={{ color: s.isBrand ? 'var(--primary-text)' : 'var(--text-2)', fontWeight: s.isBrand ? 600 : 400 }}>
                      {s.name}{s.isBrand ? ' (you)' : ''}
                    </span>
                    <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                      {s.prompts}/{report.coverage.measured}
                    </span>
                  </div>
                  <Bar
                    value={s.prompts}
                    max={report.coverage.measured}
                    color={s.isBrand ? 'var(--primary)' : 'var(--text-3)'}
                  />
                </div>
              ))}
            </div>

            <div style={card}>
              <h3 style={{ margin: '0 0 12px', fontSize: 14, color: 'var(--text)' }}>Cited instead</h3>
              {!report.citedDomains.length && <div style={muted}>No citations were recorded.</div>}
              {report.citedDomains.slice(0, 12).map((d) => (
                <div key={d.domain} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12.5, padding: '3px 0' }}>
                  <span style={{
                    color: d.isBrand ? 'var(--primary-text)' : 'var(--text-2)',
                    fontWeight: d.isBrand ? 600 : 400,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {d.domain}{d.isBrand ? ' (you)' : ''}
                  </span>
                  <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>
                    {d.prompts}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* ── Every capture ───────────────────────────────────────────── */}
          <div style={{ ...card, marginTop: 16 }}>
            <h3 style={{ margin: '0 0 4px', fontSize: 14, color: 'var(--text)' }}>
              Prompt by prompt
            </h3>
            <div style={{ ...muted, marginBottom: 12 }}>
              {report.surfaces.join(' · ')}
            </div>

            {data.captures.map((c) => {
              const notMeasured = c.mentioned === null;
              return (
                <div key={c.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 11,
                      color: notMeasured ? 'var(--text-3)' : c.mentioned ? 'var(--success)' : 'var(--danger)',
                    }}>
                      {notMeasured ? '?' : c.mentioned ? 'NAMED' : 'absent'}
                    </span>
                    <span style={{ fontSize: 13, color: 'var(--text)' }}>{c.prompt}</span>
                    <span style={{ ...muted, marginLeft: 'auto' }}>{c.surfaceLabel}</span>
                  </div>

                  {notMeasured ? (
                    <div style={{ ...muted, color: 'var(--warning)', marginTop: 3 }}>
                      Not measured — {c.failureReason || c.status}
                    </div>
                  ) : (
                    <div style={{ ...muted, marginTop: 3 }}>
                      {/* cited is three-valued: an unresolved citation means we
                          cannot rule the brand out, which is not "no". */}
                      own domain cited: {c.cited === null ? 'unknown' : c.cited ? 'yes' : 'no'}
                      {c.competitorsMentioned?.length ? ` · competitors: ${c.competitorsMentioned.join(', ')}` : ''}
                      {c.citations?.length
                        ? ` · cites ${[...new Set(c.citations.map((x) => x.domain).filter(Boolean))].slice(0, 5).join(', ')}`
                        : ''}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ ...muted, marginTop: 12 }}>
            {data.promptBasis ? `${data.promptBasis}. ` : ''}
            Spend on this run: ${report.spend.toFixed(4)}.
          </div>
        </>
      )}
    </main>
  );
}
