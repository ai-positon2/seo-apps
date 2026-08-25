// Issue Review — triage every finding a crawl produced.
//
// This is the one screen that is more than a port. In the standalone app review
// status and notes lived on in-memory objects: they were lost on reload, and in
// the hosted build they never reached the downloaded workbook either, because
// that is rebuilt server-side from the stored crawl summary. Here they persist
// to crawl_finding_reviews, so triage survives a refresh, is visible to whoever
// looks next, and is reflected in the Excel audit.
//
// Writes are optimistic: the dropdown and the notes box update immediately and
// the PATCH follows, because waiting on a round trip per keystroke or per
// dropdown makes triaging a few hundred findings unusable. A failed write rolls
// the row back and says so.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  SectionHeader, Card, Button, Badge, MetricCard, EmptyState, useToast,
} from '../ui';
import {
  REVIEW_STATUSES, SEVERITY_ORDER, severityVariant,
} from '../components/crawlScope/crawlHelpers';
import { cs, saveBlob } from '../lib/crawlScopeApi';

const DISMISSED = ['False positive', 'Resolved'];

function statusVariantFor(status) {
  if (status === 'Confirmed issue') return 'danger';
  if (status === 'False positive') return 'neutral';
  if (status === 'Resolved') return 'success';
  return 'warning'; // Needs review
}

// A horizontal stacked bar of the four review states — the desktop app's review
// metrics chart. Deliberately plain: it is one hundred percent of one number,
// and a legend plus a bar says that better than a pie.
function ReviewBar({ counts, total }) {
  if (!total) return null;
  const segments = REVIEW_STATUSES.map((s) => ({ status: s, count: counts[s] || 0 }))
    .filter((s) => s.count > 0);
  const colorFor = (status) => ({
    'Needs review': 'var(--warning)',
    'Confirmed issue': 'var(--danger)',
    'False positive': 'var(--text-3)',
    Resolved: 'var(--success)',
  }[status]);

  return (
    <div>
      <div style={{ display: 'flex', height: 10, borderRadius: 999, overflow: 'hidden', background: 'var(--surface)' }}>
        {segments.map((s) => (
          <div
            key={s.status}
            title={`${s.status}: ${s.count}`}
            style={{ width: `${(s.count / total) * 100}%`, background: colorFor(s.status) }}
          />
        ))}
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 10, flexWrap: 'wrap' }}>
        {REVIEW_STATUSES.map((s) => (
          <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--text-3)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: colorFor(s), display: 'inline-block' }} />
            {s} — {counts[s] || 0}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function CrawlScopeReviewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [findings, setFindings] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedRule, setSelectedRule] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showAllChecks, setShowAllChecks] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Notes are debounced per finding so typing doesn't PATCH per keystroke.
  const noteTimers = useRef({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [f, c] = await Promise.all([cs.findings(id), cs.catalog()]);
        if (cancelled) return;
        setFindings(f.findings || []);
        setCatalog(Array.isArray(c) ? c : c.checks || []);
        setSelectedRule((f.findings || [])[0]?.ruleId || '');
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      Object.values(noteTimers.current).forEach(clearTimeout);
    };
  }, [id]);

  const catalogById = useMemo(
    () => new Map(catalog.map((d) => [d.id, d])),
    [catalog],
  );

  const categories = useMemo(() => {
    const set = new Set(catalog.map((d) => d.category).filter(Boolean));
    return ['all', ...[...set].sort()];
  }, [catalog]);

  const counts = useMemo(() => {
    const out = {};
    for (const f of findings) out[f.reviewStatus] = (out[f.reviewStatus] || 0) + 1;
    return out;
  }, [findings]);

  const outstanding = useMemo(
    () => findings.filter((f) => !DISMISSED.includes(f.reviewStatus)),
    [findings],
  );

  const severityCounts = useMemo(() => {
    const out = {};
    for (const f of outstanding) out[f.severity] = (out[f.severity] || 0) + 1;
    return out;
  }, [outstanding]);

  // One entry per rule that fired, plus (optionally) every catalog check that
  // did not — the desktop app's "show all checks" toggle, which is how you
  // demonstrate a check passed rather than was skipped.
  const ruleList = useMemo(() => {
    const byRule = new Map();
    for (const f of findings) {
      const entry = byRule.get(f.ruleId) || { ruleId: f.ruleId, findings: [] };
      entry.findings.push(f);
      byRule.set(f.ruleId, entry);
    }
    let list = [...byRule.values()].map((e) => {
      const def = catalogById.get(e.ruleId) || {};
      return {
        ...e,
        title: def.title || e.findings[0]?.title || e.ruleId,
        category: def.category || e.findings[0]?.category || '—',
        severity: def.severity || e.findings[0]?.severity || 'info',
        detection: def.detection,
        open: e.findings.filter((f) => !DISMISSED.includes(f.reviewStatus)).length,
        reviewed: e.findings.filter((f) => f.reviewStatus !== 'Needs review').length,
      };
    });

    if (showAllChecks) {
      for (const def of catalog) {
        if (byRule.has(def.id)) continue;
        list.push({
          ruleId: def.id, findings: [], title: def.title, category: def.category,
          severity: def.severity, detection: def.detection, open: 0, reviewed: 0, clean: true,
        });
      }
    }

    if (category !== 'all') list = list.filter((r) => r.category === category);
    if (statusFilter !== 'all') {
      list = list.filter((r) => r.findings.some((f) => f.reviewStatus === statusFilter));
    }
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((r) =>
        `${r.title} ${r.ruleId} ${r.category}`.toLowerCase().includes(q) ||
        r.findings.some((f) => (f.url || '').toLowerCase().includes(q)),
      );
    }

    return list.sort((a, b) => {
      const bySeverity = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
      if (bySeverity !== 0) return bySeverity;
      return b.findings.length - a.findings.length;
    });
  }, [findings, catalog, catalogById, category, statusFilter, query, showAllChecks]);

  const selected = useMemo(
    () => ruleList.find((r) => r.ruleId === selectedRule) || ruleList[0] || null,
    [ruleList, selectedRule],
  );

  const visibleFindings = useMemo(() => {
    if (!selected) return [];
    if (statusFilter === 'all') return selected.findings;
    return selected.findings.filter((f) => f.reviewStatus === statusFilter);
  }, [selected, statusFilter]);

  // ── Persistence ───────────────────────────────────────────────────────────
  const persist = useCallback(async (reviews, previous) => {
    setSaving(true);
    try {
      const { findings: fresh } = await cs.saveReviews(id, reviews);
      setFindings(fresh);
    } catch (e) {
      setFindings(previous); // roll back the optimistic update
      toast.error(`Could not save the review: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }, [id, toast]);

  function setStatus(finding, reviewStatus) {
    const previous = findings;
    setFindings((prev) => prev.map((f) => (f.id === finding.id ? { ...f, reviewStatus } : f)));
    persist([{ findingId: finding.id, reviewStatus, reviewerNotes: finding.reviewerNotes || '' }], previous);
  }

  function setNotes(finding, reviewerNotes) {
    setFindings((prev) => prev.map((f) => (f.id === finding.id ? { ...f, reviewerNotes } : f)));
    clearTimeout(noteTimers.current[finding.id]);
    noteTimers.current[finding.id] = setTimeout(() => {
      // Read the row back off state at flush time so the status isn't reverted
      // to whatever it was when typing began.
      setFindings((current) => {
        const row = current.find((f) => f.id === finding.id);
        if (row) {
          persist(
            [{ findingId: row.id, reviewStatus: row.reviewStatus, reviewerNotes: row.reviewerNotes || '' }],
            current,
          );
        }
        return current;
      });
    }, 700);
  }

  function bulkSet(reviewStatus) {
    if (!visibleFindings.length) return;
    const previous = findings;
    const ids = new Set(visibleFindings.map((f) => f.id));
    setFindings((prev) => prev.map((f) => (ids.has(f.id) ? { ...f, reviewStatus } : f)));
    persist(
      visibleFindings.map((f) => ({
        findingId: f.id,
        reviewStatus,
        reviewerNotes: f.reviewerNotes || '',
      })),
      previous,
    );
  }

  async function downloadWorkbook() {
    setDownloading(true);
    try {
      const { blob, filename } = await cs.downloadReport(id);
      saveBlob(blob, filename);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setDownloading(false);
    }
  }

  if (loading) {
    return <main style={{ padding: '28px 32px' }}><EmptyState title="Loading findings…" /></main>;
  }

  if (error) {
    return (
      <main style={{ padding: '28px 32px' }}>
        <EmptyState
          title="Could not load the review"
          description={error}
          action={<Button onClick={() => navigate(`/crawl-scope/runs/${id}`)}>Back to the crawl</Button>}
        />
      </main>
    );
  }

  if (!findings.length) {
    return (
      <main style={{ padding: '28px 32px' }}>
        <EmptyState
          title="Nothing to review"
          description="This crawl produced no findings — either it is still running, or the site is clean."
          action={<Button onClick={() => navigate(`/crawl-scope/runs/${id}`)}>Back to the crawl</Button>}
        />
      </main>
    );
  }

  const reviewedCount = findings.length - (counts['Needs review'] || 0);

  return (
    <main style={{ padding: '28px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SectionHeader
        title="Issue review"
        subtitle="Confirm or dismiss each finding. Your decisions are saved, shared with the team, and carried into the Excel audit."
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {saving && <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>Saving…</span>}
            <Button variant="ghost" onClick={() => navigate(`/crawl-scope/runs/${id}`)}>Back to the crawl</Button>
            <Button loading={downloading} onClick={downloadWorkbook}>Download Excel audit</Button>
          </div>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <MetricCard label="Findings" value={findings.length.toLocaleString()} />
        <MetricCard label="Reviewed" value={`${reviewedCount} / ${findings.length}`} />
        <MetricCard label="Still outstanding" value={outstanding.length.toLocaleString()} />
        <MetricCard label="Errors outstanding" value={(severityCounts.error || 0).toLocaleString()} />
        <MetricCard label="Warnings outstanding" value={(severityCounts.warning || 0).toLocaleString()} />
      </div>

      <Card title="Review progress">
        <ReviewBar counts={counts} total={findings.length} />
      </Card>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search checks and URLs…"
          style={{
            flex: '1 1 240px', minWidth: 200, height: 34, padding: '0 10px', fontSize: 13,
            background: 'var(--surface)', color: 'var(--text)',
            border: '1px solid var(--border)', borderRadius: 'var(--r-md)',
          }}
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          style={{ height: 34, padding: '0 8px', fontSize: 13, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}
        >
          {categories.map((c) => <option key={c} value={c}>{c === 'all' ? 'All categories' : c}</option>)}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          style={{ height: 34, padding: '0 8px', fontSize: 13, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}
        >
          <option value="all">All review statuses</option>
          {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 12.5, color: 'var(--text-2)', cursor: 'pointer' }}>
          <input type="checkbox" checked={showAllChecks} onChange={(e) => setShowAllChecks(e.target.checked)} />
          Show checks that found nothing
        </label>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 340px) 1fr', gap: 16, alignItems: 'start' }}>
        {/* Rule list */}
        <Card padding="8px" style={{ maxHeight: 640, overflowY: 'auto' }}>
          {ruleList.length ? ruleList.map((r) => {
            const active = selected?.ruleId === r.ruleId;
            return (
              <button
                key={r.ruleId}
                onClick={() => setSelectedRule(r.ruleId)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px',
                  marginBottom: 3, cursor: 'pointer', borderRadius: 'var(--r-md)',
                  border: `1px solid ${active ? 'var(--primary)' : 'transparent'}`,
                  background: active ? 'var(--primary-soft)' : 'transparent',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
                  <Badge variant={severityVariant(r.severity)}>{r.severity}</Badge>
                  {r.clean
                    ? <Badge variant="success">clean</Badge>
                    : <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{r.findings.length}</span>}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.35 }}>{r.title}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  {r.category}
                  {!r.clean && r.open === 0 ? ' · all cleared' : ''}
                </div>
              </button>
            );
          }) : (
            <div style={{ padding: 24, textAlign: 'center', fontSize: 12.5, color: 'var(--text-3)' }}>
              No checks match these filters.
            </div>
          )}
        </Card>

        {/* Selected rule detail */}
        <Card>
          {!selected ? (
            <EmptyState title="No check selected" description="Pick one from the list." />
          ) : (
            <div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                  <Badge variant={severityVariant(selected.severity)}>{selected.severity}</Badge>
                  <Badge variant="neutral">{selected.category}</Badge>
                  {selected.detection && selected.detection !== 'Automatic' && (
                    <Badge variant="info">{selected.detection}</Badge>
                  )}
                </div>
                <h3 style={{ margin: 0, fontSize: 15.5, color: 'var(--text)' }}>{selected.title}</h3>
                {catalogById.get(selected.ruleId)?.recommendation && (
                  <p style={{ margin: '8px 0 0', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
                    {catalogById.get(selected.ruleId).recommendation}
                  </p>
                )}
              </div>

              {selected.clean ? (
                <EmptyState title="No findings" description="Every crawled URL passed this check." />
              ) : (
                <>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                      Mark all {visibleFindings.length} shown:
                    </span>
                    {['Confirmed issue', 'False positive', 'Resolved'].map((s) => (
                      <Button key={s} variant="secondary" size="sm" onClick={() => bulkSet(s)}>{s}</Button>
                    ))}
                  </div>

                  <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--r-md)' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                      <thead>
                        <tr style={{ background: 'var(--surface)' }}>
                          {['URL', 'Detail', 'Review status', 'Reviewer notes'].map((h, i) => (
                            <th key={h} style={{
                              padding: '9px 10px', textAlign: 'left', fontSize: 11, fontWeight: 700,
                              letterSpacing: '0.03em', textTransform: 'uppercase', color: 'var(--text-3)',
                              borderBottom: '1px solid var(--border)',
                              width: [ '32%', '18%', '160px', '28%' ][i],
                            }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {visibleFindings.length ? visibleFindings.map((f) => (
                          <tr key={f.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '8px 10px', maxWidth: 300 }}>
                              <a
                                href={f.url}
                                target="_blank"
                                rel="noreferrer"
                                style={{ color: 'var(--primary-text, var(--primary))', wordBreak: 'break-all', fontSize: 12 }}
                              >
                                {f.url}
                              </a>
                              {f.targetUrl && (
                                <div style={{ fontSize: 11, color: 'var(--text-3)', wordBreak: 'break-all' }}>→ {f.targetUrl}</div>
                              )}
                            </td>
                            <td style={{ padding: '8px 10px', color: 'var(--text-2)', wordBreak: 'break-word' }}>
                              {f.detail || (f.detectedValue !== undefined && f.detectedValue !== '' ? String(f.detectedValue) : '—')}
                            </td>
                            <td style={{ padding: '8px 10px' }}>
                              <select
                                value={f.reviewStatus}
                                onChange={(e) => setStatus(f, e.target.value)}
                                style={{
                                  width: '100%', height: 30, fontSize: 12, padding: '0 6px',
                                  background: 'var(--surface)', color: 'var(--text)',
                                  border: `1px solid var(--${statusVariantFor(f.reviewStatus) === 'neutral' ? 'border' : statusVariantFor(f.reviewStatus)})`,
                                  borderRadius: 'var(--r-sm, 6px)',
                                }}
                              >
                                {REVIEW_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                              </select>
                            </td>
                            <td style={{ padding: '8px 10px' }}>
                              <textarea
                                value={f.reviewerNotes || ''}
                                onChange={(e) => setNotes(f, e.target.value)}
                                placeholder="Add a note…"
                                rows={2}
                                style={{
                                  width: '100%', fontSize: 12, padding: '5px 7px', resize: 'vertical',
                                  background: 'var(--surface)', color: 'var(--text)',
                                  border: '1px solid var(--border)', borderRadius: 'var(--r-sm, 6px)',
                                  fontFamily: 'inherit',
                                }}
                              />
                            </td>
                          </tr>
                        )) : (
                          <tr>
                            <td colSpan={4} style={{ padding: 28, textAlign: 'center', color: 'var(--text-3)' }}>
                              No findings match the review-status filter.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </Card>
      </div>
    </main>
  );
}
