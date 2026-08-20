import { useState } from 'react';
import * as XLSX from 'xlsx';
import { saveAs } from 'file-saver';
import { useSeoGeoAudit } from '../hooks/useSeoGeoAudit';
import { scoreColor } from '../components/seoGeo/primitives';
import AuditInputPanel from '../components/seoGeo/AuditInputPanel';
import ScoreDashboard, { AuditMetaBar } from '../components/seoGeo/ScoreDashboard';
import ModuleRuns from '../components/ModuleRuns';

const SEV_COLOR = {
  error:   { bg: 'var(--danger-soft)',  text: 'var(--danger)',  border: 'var(--danger)',  label: 'Error' },
  warning: { bg: 'var(--warning-soft)', text: 'var(--warning)', border: 'var(--warning)', label: 'Warning' },
  notice:  { bg: 'var(--info-soft)',    text: 'var(--info)',    border: 'var(--info)',    label: 'Notice' },
  info:    { bg: 'var(--success-soft)', text: 'var(--success)', border: 'var(--success)', label: 'Info' },
};

const PLATFORM_BADGE = {
  ready:     { bg: 'var(--success-soft)', text: 'var(--success)' },
  partial:   { bg: 'var(--warning-soft)', text: 'var(--warning)' },
  not_ready: { bg: 'var(--danger-soft)',  text: 'var(--danger)' },
};

function SeverityBadge({ severity }) {
  const c = SEV_COLOR[severity] || SEV_COLOR.info;
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
      background: c.bg, color: c.text, border: `1px solid ${c.border}`,
    }}>
      {c.label}
    </span>
  );
}

function IssueCard({ issue }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left', padding: '12px 16px',
          display: 'flex', alignItems: 'flex-start', gap: 12,
          background: 'none', border: 'none', cursor: 'pointer',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        <SeverityBadge severity={issue.severity} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{issue.issue || issue.id}</span>
          <p style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{issue.current_state}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {issue.effort && (
            <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, background: 'var(--surface)', color: 'var(--text-2)' }}>{issue.effort}</span>
          )}
          <svg style={{ width: 16, height: 16, color: 'var(--text-3)', transition: 'transform 200ms', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>
      {open && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--border)', background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {issue.impact && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 12, marginBottom: 4 }}>Impact</p>
              <p style={{ fontSize: 14, color: 'var(--text)' }}>{issue.impact}</p>
            </div>
          )}
          {issue.context_note && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>Context Note</p>
              <p style={{ fontSize: 12, color: 'var(--text-2)', fontStyle: 'italic', borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>{issue.context_note}</p>
            </div>
          )}
          {issue.fix && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Fix</p>
              <p style={{ fontSize: 14, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{issue.fix}</p>
            </div>
          )}
          {issue.code_example && (
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Code Example</p>
              <pre style={{ fontSize: 12, background: '#1E293B', color: '#E2E8F0', borderRadius: 8, padding: 12, overflowX: 'auto', whiteSpace: 'pre-wrap', margin: 0 }}>{issue.code_example}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RawCheckRow({ check }) {
  const statusColor = {
    pass: 'var(--success)', fail: 'var(--danger)',
    warning: 'var(--warning)', notice: 'var(--info)', skipped: 'var(--text-3)',
    na: 'var(--text-3)', informational: 'var(--text-3)',
  }[check.status] || 'var(--text-3)';
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)', fontSize: 14 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)', width: 32, flexShrink: 0, paddingTop: 2 }}>{check.id}</span>
      <span style={{ width: 8, height: 8, borderRadius: '50%', marginTop: 6, flexShrink: 0, backgroundColor: statusColor }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ color: 'var(--text)', fontWeight: 500 }}>{check.name}</span>
        {check.detail && <p style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{check.detail}</p>}
        {check.value && <p style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(check.value).substring(0, 120)}</p>}
      </div>
      {/* 'na' and 'informational' rows are neutral: SEV_COLOR.info is green and
          would render them as an "Info" pass. */}
      {check.status !== 'pass' && check.status !== 'skipped'
        && check.status !== 'na' && check.status !== 'informational' && (
        <SeverityBadge severity={check.severity} />
      )}
    </div>
  );
}

const CATEGORY_ORDER = [
  'Title Tag','Meta Description','Meta Robots','Canonical','Headings',
  'Content Quality','Images','Internal Links','External Links','Schema',
  'Open Graph','Hreflang','Technical','URL Signals','Page Speed',
  'Semantic HTML','Accessibility','E-E-A-T','Security','GEO Signals','Miscellaneous'
];

// ── IssuesBySeverity ─────────────────────────────────────────────────────────
function IssuesBySeverity({ ai, checksByCategory }) {
  const [errOpen, setErrOpen] = useState(true);
  const [warnOpen, setWarnOpen] = useState(true);
  const [noticeOpen, setNoticeOpen] = useState(false);

  const allIssues = (ai?.sections || []).flatMap(s =>
    (s.issues || []).map(i => ({ ...i, category: s.category }))
  );
  const errors   = allIssues.filter(i => i.severity === 'error');
  const warnings = allIssues.filter(i => i.severity === 'warning');
  const notices  = allIssues.filter(i => i.severity === 'notice');

  const Section = ({ label, items, color, bgColor, open, onToggle }) => (
    <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', overflow: 'hidden', marginBottom: 12 }}>
      <button
        onClick={onToggle}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', background: 'none', border: 'none', cursor: 'pointer' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color }}>{label}</span>
          <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 999, background: bgColor, color }}>{items.length}</span>
        </div>
        <svg style={{ width: 16, height: 16, color: 'var(--text-3)', transition: 'transform 200ms', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      {open && items.length > 0 && (
        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((issue, i) => (
            <div key={i}>
              <IssueCard issue={issue} />
              {issue.category && <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2, paddingLeft: 4 }}>Category: {issue.category}</p>}
            </div>
          ))}
        </div>
      )}
      {open && items.length === 0 && (
        <p style={{ padding: '12px 20px', fontSize: 14, color: 'var(--text-3)', borderTop: '1px solid var(--border)' }}>No {label.toLowerCase()} found.</p>
      )}
    </div>
  );

  return (
    <div>
      <Section label="Errors"   items={errors}   color="var(--danger)"  bgColor="var(--danger-soft)"  open={errOpen}    onToggle={() => setErrOpen(o => !o)} />
      <Section label="Warnings" items={warnings} color="var(--warning)" bgColor="var(--warning-soft)" open={warnOpen}   onToggle={() => setWarnOpen(o => !o)} />
      <Section label="Notices"  items={notices}  color="var(--info)"    bgColor="var(--info-soft)"    open={noticeOpen} onToggle={() => setNoticeOpen(o => !o)} />
    </div>
  );
}

// ── AllChecksTable ────────────────────────────────────────────────────────────
function AllChecksTable({ findings }) {
  const [page, setPage] = useState(0);
  const PER_PAGE = 50;
  const checks = findings?.checks || [];
  const pageChecks = checks.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  return (
    <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
          <thead style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
            <tr>
              {['ID', 'Category', 'Check', 'Status', 'Value'].map(h => (
                <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageChecks.map(c => {
              const statusColor = {
                pass: 'var(--success)', fail: 'var(--danger)',
                warning: 'var(--warning)', notice: 'var(--info)', skipped: 'var(--text-3)',
              }[c.status] || 'var(--text-3)';
              return (
                <tr key={c.id} style={{ borderBottom: '1px solid var(--surface)' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >
                  <td style={{ padding: '6px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>{c.id}</td>
                  <td style={{ padding: '6px 12px', color: 'var(--text-2)' }}>{c.category}</td>
                  <td style={{ padding: '6px 12px', color: 'var(--text)' }}>{c.name}</td>
                  <td style={{ padding: '6px 12px' }}><span style={{ fontWeight: 600, color: statusColor }}>{c.status}</span></td>
                  <td style={{ padding: '6px 12px', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(c.value || '').substring(0, 60)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-2)' }}>
        <span>{checks.length} total checks</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card)', color: 'var(--text)', cursor: 'pointer', opacity: page === 0 ? 0.4 : 1 }}>←</button>
          <span style={{ padding: '4px 8px' }}>{page + 1} / {Math.ceil(checks.length / PER_PAGE) || 1}</span>
          <button onClick={() => setPage(p => Math.min(Math.ceil(checks.length / PER_PAGE) - 1, p + 1))} disabled={(page + 1) * PER_PAGE >= checks.length} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--card)', color: 'var(--text)', cursor: 'pointer', opacity: (page + 1) * PER_PAGE >= checks.length ? 0.4 : 1 }}>→</button>
        </div>
      </div>
    </div>
  );
}

// ── SchemaDetectedCard ────────────────────────────────────────────────────────
function SchemaDetectedCard({ schema }) {
  const [open, setOpen] = useState(false);
  const hasErrors = schema.validation_errors?.length > 0;
  const statusColor = schema.status === 'valid' ? 'var(--success)' : schema.status === 'has_errors' ? 'var(--danger)' : 'var(--warning)';
  const statusBg = schema.status === 'valid' ? 'var(--success-soft)' : schema.status === 'has_errors' ? 'var(--danger-soft)' : 'var(--warning-soft)';
  return (
    <div style={{ border: `1px solid ${hasErrors ? 'var(--danger)' : 'var(--border)'}`, borderRadius: 8, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{schema.type}</span>
          <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: statusBg, color: statusColor }}>{schema.status?.replace('_', ' ')}</span>
          {hasErrors && <span style={{ fontSize: 12, color: 'var(--danger)' }}>{schema.validation_errors.length} error(s)</span>}
        </div>
        <svg style={{ width: 16, height: 16, color: 'var(--text-3)', transition: 'transform 200ms', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      {open && (
        <div style={{ padding: '0 16px 12px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {schema.fields_missing?.length > 0 && (
            <div>
              <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>Missing fields</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {schema.fields_missing.map(f => (
                  <span key={f} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, background: 'var(--warning-soft)', color: 'var(--warning)', border: '1px solid var(--warning)' }}>{f}</span>
                ))}
              </div>
            </div>
          )}
          {schema.validation_errors?.length > 0 && (
            <div>
              <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>Validation errors</p>
              {schema.validation_errors.map((err, i) => (
                <div key={i} style={{ fontSize: 12, background: 'var(--danger-soft)', color: 'var(--danger)', borderRadius: 4, padding: 8, marginBottom: 4 }}>
                  <span style={{ fontWeight: 600 }}>{err.field}:</span> {err.error}
                  {err.fix && <p style={{ marginTop: 4, fontFamily: 'var(--font-mono)' }}>→ {err.fix}</p>}
                </div>
              ))}
            </div>
          )}
          {schema.corrected_json_ld && (
            <div>
              <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>Corrected JSON-LD</p>
              <pre style={{ fontSize: 12, background: '#1E293B', color: '#E2E8F0', borderRadius: 8, padding: 12, overflowX: 'auto', whiteSpace: 'pre-wrap', maxHeight: 256, margin: 0 }}>{schema.corrected_json_ld}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── SchemaRecommendedCard ─────────────────────────────────────────────────────
function SchemaRecommendedCard({ rec }) {
  const [open, setOpen] = useState(false);
  const priorityColor = rec.priority === 'required' ? 'var(--danger)' : rec.priority === 'recommended' ? 'var(--warning)' : 'var(--text-2)';
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer' }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{rec.type}</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: priorityColor }}>{rec.priority}</span>
        </div>
        <svg style={{ width: 16, height: 16, color: 'var(--text-3)', transition: 'transform 200ms', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      {open && (
        <div style={{ padding: '0 16px 12px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rec.reason && <p style={{ fontSize: 14, color: 'var(--text)' }}>{rec.reason}</p>}
          {rec.key_fields?.length > 0 && (
            <div>
              <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>Key fields to include</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {rec.key_fields.map(f => (
                  <span key={f} style={{ fontSize: 12, padding: '2px 8px', borderRadius: 4, background: 'var(--info-soft)', color: 'var(--info)', border: '1px solid var(--info)' }}>{f}</span>
                ))}
              </div>
            </div>
          )}
          {rec.starter_template && (
            <div>
              <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>Starter template</p>
              <pre style={{ fontSize: 12, background: '#1E293B', color: '#E2E8F0', borderRadius: 8, padding: 12, overflowX: 'auto', whiteSpace: 'pre-wrap', maxHeight: 192, margin: 0 }}>{rec.starter_template}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── downloadReport (7 sheets) ─────────────────────────────────────────────────
function downloadReport(findings, ai) {
  const wb = XLSX.utils.book_new();

  const statusFill = (status) => {
    const fills = {
      pass:    { fgColor: { rgb: 'D1FAE5' } },
      fail:    { fgColor: { rgb: 'FEE2E2' } },
      warning: { fgColor: { rgb: 'FEF3C7' } },
      notice:  { fgColor: { rgb: 'DBEAFE' } },
      skipped: { fgColor: { rgb: 'F3F4F6' } },
      na:      { fgColor: { rgb: 'F3F4F6' } },
    };
    return fills[status] || fills.skipped;
  };

  // Sheet 1: Summary
  const summaryRows = [
    ['SEO & GEO Audit Report', ''],
    [''],
    ['Field', 'Value'],
    ['URL', findings.meta.url],
    ['Page Type', findings.meta.page_type || '—'],
    ['Page Intent', findings.meta.page_intent
      ? `${findings.meta.page_intent}${findings.meta.page_intent_source === 'detected' ? ' (auto)' : ''}`
      : '—'],
    ['Content Vertical', findings.meta.content_vertical || '—'],
    ['Is YMYL', findings.meta.is_ymyl ? 'Yes' : 'No'],
    ['Audit Date', new Date(findings.meta.fetch_timestamp).toLocaleString()],
    ['HTTP Status', findings.meta.http_status ?? '—'],
    ['HTML Size', `${Math.round(findings.meta.html_size_bytes / 1024)}KB`],
    ['Total Checks', findings.meta.total_checks_run],
    ['Errors', findings.meta.errors],
    ['Warnings', findings.meta.warnings],
    ['Notices', findings.meta.notices],
    ['Passed', findings.meta.passed],
    ['Keywords Audited', (findings.meta.keywords || []).join(', ') || '(none)'],
    [''],
    ['Scores', ''],
    ['Overall Score (after cap)', findings.scores.overall ?? '—'],
    ['Composite (uncapped)', findings.scores.composite ?? '—'],
    ['Band', findings.scores.band?.label ?? '—'],
    ['Cap Applied', findings.scores.cap?.applied
      ? `${findings.scores.cap.value} — ${(findings.scores.cap.groups || []).map(g => g.reason).join(' · ')}`
      : 'No'],
    ['Title & Meta', findings.scores.title_meta ?? '—'],
    ['Content & Structure', findings.scores.content_structure ?? '—'],
    ['Indexability', findings.scores.indexability ?? '—'],
    ['Schema', findings.scores.schema ?? '—'],
    ['GEO Signals', findings.scores.geo_signals ?? '—'],
    ['E-E-A-T', findings.scores.eeat ?? '—'],
    ['Technical & Performance', findings.scores.technical ?? '—'],
    ['Links & Media', findings.scores.links_media ?? '—'],
    ['Keyword Targeting', findings.scores.keyword ?? '—'],
    [''],
    ['AI Assessment', ''],
    ['GEO Readiness', ai?.summary?.geo_readiness ?? '—'],
    ['E-E-A-T Strength', ai?.summary?.eeat_strength ?? '—'],
    ['Priority Verdict', ai?.summary?.priority_verdict ?? '—'],
    [''],
    ['Quick Wins', ''],
    ...(ai?.summary?.quick_wins ?? []).map((w, i) => [`${i + 1}`, w]),
    [''],
    // Rule-based answerability (F28) — the rubric and its components switch with
    // page intent, so the rows are generated rather than hardcoded to C/S/Q/A/F.
    ['GEO Answerability', findings.geo?.answerability_score ?? findings.geo?.csqaf_score ?? '—'],
    ['Answerability Rubric', findings.geo?.answerability_rubric ?? '—'],
    ['Answerability Points', Number.isFinite(findings.geo?.answerability_earned) && Number.isFinite(findings.geo?.answerability_max)
      ? `${findings.geo.answerability_earned} of ${findings.geo.answerability_max}`
      : '—'],
    ...(findings.geo?.answerability_breakdown ?? []).map(c => [
      `${c.key} — ${c.label}`,
      `${c.points}/${c.max}${c.finding ? ` · ${c.finding}` : ''}`,
    ]),
  ];

  // Sheet 2: Keyword Analysis (only if keywords provided)
  const kwRows = [['ID', 'Check', 'Keyword', 'Status', 'Tier', 'Evidence', 'Found Value', 'Fix']];
  for (const c of findings.kwChecks || []) {
    kwRows.push([c.id, c.name, (findings.meta.keywords || []).join(', '), c.status,
      c.tier ?? '', c.evidence ?? '', c.value ?? '', c.detail ?? '']);
  }

  // Sheet 3: Issues (errors + warnings)
  const issueRowsMain = [['Category', 'ID', 'Severity', 'Issue', 'Current State', 'Impact', 'Context Note', 'Fix', 'Code Example', 'Effort', 'Priority']];
  for (const section of ai?.sections ?? []) {
    for (const issue of section.issues ?? []) {
      if (issue.severity === 'error' || issue.severity === 'warning') {
        issueRowsMain.push([
          section.category ?? '',
          issue.id ?? '',
          issue.severity ?? '',
          issue.issue ?? '',
          issue.current_state ?? '',
          issue.impact ?? '',
          issue.context_note ?? '',
          issue.fix ?? '',
          issue.code_example ?? '',
          issue.effort ?? '',
          issue.priority ?? '',
        ]);
      }
    }
  }

  // Sheet 4: Notices
  const noticeRows = [['Category', 'ID', 'Issue', 'Current State', 'Fix', 'Effort']];
  for (const section of ai?.sections ?? []) {
    for (const issue of section.issues ?? []) {
      if (issue.severity === 'notice') {
        noticeRows.push([section.category ?? '', issue.id ?? '', issue.issue ?? '', issue.current_state ?? '', issue.fix ?? '', issue.effort ?? '']);
      }
    }
  }

  // Sheet 5: All Checks
  const checkRows = [['ID', 'Category', 'Name', 'Status', 'Severity', 'Value', 'Detail']];
  for (const c of findings.checks ?? []) {
    checkRows.push([c.id, c.category, c.name, c.status, c.severity, c.value ?? '', c.detail ?? '']);
  }

  // Sheet 6: Schema Analysis
  const schemaRows = [['Schema Analysis', '']];
  schemaRows.push([''], ['Detected Schemas', '']);
  for (const s of ai?.schema_analysis?.detected ?? []) {
    schemaRows.push([s.type, s.status]);
    schemaRows.push(['Fields Present', (s.fields_present || []).join(', ')]);
    schemaRows.push(['Fields Missing', (s.fields_missing || []).join(', ')]);
    for (const err of s.validation_errors || []) {
      schemaRows.push([`Error: ${err.field}`, err.error]);
      if (err.fix) schemaRows.push(['Fix', err.fix]);
    }
    if (s.corrected_json_ld) schemaRows.push(['Corrected JSON-LD', s.corrected_json_ld]);
    schemaRows.push(['']);
  }
  schemaRows.push(['Recommended Schemas', '']);
  for (const r of ai?.schema_analysis?.recommended ?? []) {
    schemaRows.push([r.type, r.relevant ? r.priority : 'NOT RELEVANT']);
    if (r.reason) schemaRows.push(['Reason', r.reason]);
    if (r.starter_template) schemaRows.push(['Starter Template', r.starter_template]);
    schemaRows.push(['']);
  }

  // Sheet 7: GEO & Content
  const pr = ai?.geo_analysis?.platform_readiness ?? {};
  const cr = ai?.content_recommendations ?? {};
  const isCommercial = findings.meta?.page_intent === 'commercial';
  const geoRows = [
    ['Platform Readiness', ''],
    ['Google AIO', pr.google_aio ?? '—'],
    ['ChatGPT', pr.chatgpt ?? '—'],
    ['Perplexity', pr.perplexity ?? '—'],
    ['Claude', pr.claude_ai ?? '—'],
    ['Gemini', pr.gemini ?? '—'],
    ['Copilot', pr.copilot ?? '—'],
    [''],
    ['Top GEO Fix', ai?.geo_analysis?.top_geo_fix ?? '—'],
    [''],
    ['Content Recommendations', ''],
    ['Rewrite Priority', cr.rewrite_priority ?? '—'],
    // Statistics / expert quotes are informational-intent only; entity completeness
    // and the direct-answer rewrite are their commercial-intent counterparts.
    ...(isCommercial ? [] : [
      ['Statistics to Add', cr.statistics_to_add ?? '—'],
      ['Expert Quote Guidance', cr.expert_quote_guidance ?? '—'],
    ]),
    ...(isCommercial ? [
      ['Entity Completeness Actions', cr.entity_completeness_actions ?? '—'],
      ['Direct Answer Rewrite', cr.direct_answer_rewrite ?? '—'],
    ] : []),
    ['FAQ Recommendations', cr.faq_recommendation ?? '—'],
    ['Word Count Verdict', cr.word_count_verdict ?? '—'],
  ];

  const wsCols = (rows) => {
    const maxLen = {};
    rows.forEach(row => row.forEach((cell, i) => {
      maxLen[i] = Math.min(80, Math.max(maxLen[i] ?? 10, String(cell ?? '').length + 2));
    }));
    return Object.values(maxLen).map(w => ({ wch: w }));
  };

  const ws1 = XLSX.utils.aoa_to_sheet(summaryRows);
  const ws2 = XLSX.utils.aoa_to_sheet(kwRows);
  const ws3 = XLSX.utils.aoa_to_sheet(issueRowsMain);
  const ws4 = XLSX.utils.aoa_to_sheet(noticeRows);
  const ws5 = XLSX.utils.aoa_to_sheet(checkRows);
  const ws6 = XLSX.utils.aoa_to_sheet(schemaRows);
  const ws7 = XLSX.utils.aoa_to_sheet(geoRows);

  [ws1, ws2, ws3, ws4, ws5, ws6, ws7].forEach((ws, idx) => {
    const rows = [summaryRows, kwRows, issueRowsMain, noticeRows, checkRows, schemaRows, geoRows][idx];
    ws['!cols'] = wsCols(rows);
  });

  // Color-code the status column in All Checks sheet (column D = index 3)
  for (let r = 1; r < checkRows.length; r++) {
    const status = checkRows[r][3];
    const cellRef = XLSX.utils.encode_cell({ r, c: 3 });
    if (ws5[cellRef]) {
      ws5[cellRef].s = {
        fill: statusFill(status),
        font: { color: { rgb: status === 'pass' ? '065F46' : status === 'fail' ? '991B1B' : status === 'warning' ? '92400E' : '1E40AF' } }
      };
    }
  }

  const sheetNames = ['Summary', 'Keyword Analysis', 'Errors & Warnings', 'Notices', 'All Checks', 'Schema Analysis', 'GEO & Content'];
  [ws1, ws2, ws3, ws4, ws5, ws6, ws7].forEach((ws, i) => XLSX.utils.book_append_sheet(wb, ws, sheetNames[i]));

  const domain = (() => { try { return new URL(findings.meta.url).hostname.replace(/^www\./, ''); } catch { return 'audit'; } })();
  const date = new Date().toISOString().slice(0, 10);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  saveAs(new Blob([buf], { type: 'application/octet-stream' }), `seo-geo-audit-${domain}-${date}.xlsx`);
}

// ── Main page component ───────────────────────────────────────────────────────
export default function SeoGeoAuditPage() {
  // View-only state — not shared with the Snapshot page, which has no panels.
  const [activePanel, setActivePanel] = useState('dashboard');
  const [expandedCats, setExpandedCats] = useState({});
  const [issueTab, setIssueTab] = useState('severity');

  // Inputs, the SSE run and run persistence live in the shared hook so the
  // Snapshot page provably sends the same request body and restores the same way.
  const ctl = useSeoGeoAudit('seo-geo-audit', {
    onRestored: () => setActivePanel('dashboard'),
    onResult:   () => setActivePanel('dashboard'),
  });
  const { findings, ai } = ctl;

  // Group raw checks by category
  const checksByCategory = {};
  if (findings?.checks) {
    for (const c of findings.checks) {
      const cat = c.category || 'Other';
      if (!checksByCategory[cat]) checksByCategory[cat] = [];
      checksByCategory[cat].push(c);
    }
  }

  // Group AI issues by category
  const aiByCategory = {};
  if (ai?.sections) {
    for (const sec of ai.sections) {
      aiByCategory[sec.category] = sec;
    }
  }

  const orderedCats = CATEGORY_ORDER.filter(c => checksByCategory[c]);

  return (
    <main style={{ maxWidth: 1280, margin: '0 auto', padding: '24px' }}>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {/* Input panel */}
      {!findings && (
        <div style={{ maxWidth: 672, margin: '0 auto' }}>
          <AuditInputPanel
            ctl={ctl}
            title="SEO & GEO Audit"
            subtitle="Run 200+ checks across all SEO and GEO parameters. Get a scored report with AI-powered recommendations."
            ctaLabel="Audit"
            ctaLabelHtml="Audit HTML"
          />
        </div>
      )}

      {/* Results */}
      {findings && (
        <div>
          {/* Meta bar */}
          <AuditMetaBar findings={findings} />

          {/* Panel tabs */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
            {[
              { id: 'dashboard', label: 'Score Dashboard' },
              { id: 'issues',    label: 'Issues' },
              { id: 'geo',       label: 'GEO & Content' },
            ].map(p => (
              <button key={p.id} onClick={() => setActivePanel(p.id)} style={{
                padding: '8px 16px', fontSize: 14, fontWeight: 500, borderRadius: 8, cursor: 'pointer', transition: 'all 150ms',
                background: activePanel === p.id ? 'var(--card)' : 'transparent',
                color: activePanel === p.id ? 'var(--text)' : 'var(--text-2)',
                border: activePanel === p.id ? '1px solid var(--border)' : '1px solid transparent',
                boxShadow: activePanel === p.id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
              }}>
                {p.label}
              </button>
            ))}
          </div>

          {/* ── Panel 1: Score Dashboard ── */}
          {activePanel === 'dashboard' && (
            <ScoreDashboard findings={findings} ai={ai} />
          )}

          {/* ── Panel 2: Issues (3-tab layout) ── */}
          {activePanel === 'issues' && (
            <div>
              {/* Tab switcher */}
              <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
                {[['severity', 'By Severity'], ['category', 'By Category'], ['all', 'All Checks']].map(([id, label]) => (
                  <button key={id} onClick={() => setIssueTab(id)} style={{
                    padding: '6px 12px', fontSize: 12, fontWeight: 500, borderRadius: 8, cursor: 'pointer', transition: 'all 150ms',
                    background: issueTab === id ? 'var(--card)' : 'transparent',
                    color: issueTab === id ? 'var(--text)' : 'var(--text-2)',
                    border: issueTab === id ? '1px solid var(--border)' : '1px solid transparent',
                    boxShadow: issueTab === id ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                  }}>
                    {label}
                  </button>
                ))}
              </div>

              {/* Tab 1: By Severity */}
              {issueTab === 'severity' && (
                <IssuesBySeverity ai={ai} checksByCategory={checksByCategory} />
              )}

              {/* Tab 2: By Category */}
              {issueTab === 'category' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {orderedCats.map(cat => {
                    const catChecks = checksByCategory[cat] || [];
                    const aiCat = aiByCategory[cat] || aiByCategory[cat?.replace(/ /g, '_')];
                    // 'na' (not applicable for this page intent) and 'informational'
                    // are excluded from scoring server-side; they are not failures here either.
                    const failures = catChecks.filter(c => c.status !== 'pass' && c.status !== 'skipped'
                      && c.status !== 'na' && c.status !== 'informational');
                    const isExpanded = expandedCats[cat] !== false;

                    return (
                      <div key={cat} style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                        <button
                          onClick={() => setExpandedCats(prev => ({ ...prev, [cat]: !isExpanded }))}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', background: 'none', border: 'none', cursor: 'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'none'}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{cat}</span>
                            {failures.filter(c => c.severity === 'error').length > 0 && (
                              <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: 'var(--danger-soft)', color: 'var(--danger)' }}>{failures.filter(c => c.severity === 'error').length} error</span>
                            )}
                            {failures.filter(c => c.severity === 'warning' || c.status === 'warning').length > 0 && (
                              <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: 'var(--warning-soft)', color: 'var(--warning)' }}>{failures.filter(c => c.severity === 'warning' || c.status === 'warning').length} warn</span>
                            )}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                            {aiCat?.score !== undefined && (
                              <span style={{ fontSize: 14, fontWeight: 700, fontFamily: 'var(--font-mono)', color: scoreColor(aiCat.score) }}>{aiCat.score}</span>
                            )}
                            <svg style={{ width: 16, height: 16, color: 'var(--text-3)', transition: 'transform 200ms', transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                            </svg>
                          </div>
                        </button>

                        {isExpanded && (
                          <div style={{ borderTop: '1px solid var(--border)' }}>
                            {/* AI issues first */}
                            {aiCat?.issues?.length > 0 && (
                              <div style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
                                <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>AI Recommendations</p>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  {aiCat.issues.sort((a, b) => (a.priority || 99) - (b.priority || 99)).map((issue, i) => (
                                    <IssueCard key={i} issue={issue} />
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Raw check results */}
                            <div style={{ padding: '0 16px 8px' }}>
                              <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 12, marginBottom: 4 }}>All Checks</p>
                              {catChecks.map(c => <RawCheckRow key={c.id} check={c} />)}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Tab 3: All Checks */}
              {issueTab === 'all' && (
                <AllChecksTable findings={findings} />
              )}
            </div>
          )}

          {/* ── Panel 3: GEO & Content ── */}
          {activePanel === 'geo' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

              {/* Platform readiness */}
              {ai?.geo_analysis?.platform_readiness && (
                <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: 20, gridColumn: 'span 2', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 16 }}>Platform Readiness</p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                    {Object.entries({
                      'Google AIO': ai.geo_analysis.platform_readiness.google_aio,
                      'ChatGPT': ai.geo_analysis.platform_readiness.chatgpt,
                      'Perplexity': ai.geo_analysis.platform_readiness.perplexity,
                      'Claude': ai.geo_analysis.platform_readiness.claude_ai,
                      'Gemini': ai.geo_analysis.platform_readiness.gemini,
                      'Copilot': ai.geo_analysis.platform_readiness.copilot,
                    }).map(([platform, value]) => {
                      const status = typeof value === 'string' ? value.split(' ')[0]?.toLowerCase().replace('not_ready', 'not_ready') : 'partial';
                      const normalized = status === 'not_ready' || value?.toLowerCase().startsWith('not_ready') ? 'not_ready' : status;
                      const badgeStyle = PLATFORM_BADGE[normalized] || PLATFORM_BADGE.partial;
                      return (
                        <div key={platform} style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{platform}</span>
                            <span style={{ fontSize: 12, fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: badgeStyle.bg, color: badgeStyle.text }}>
                              {normalized === 'not_ready' ? 'Not Ready' : normalized.charAt(0).toUpperCase() + normalized.slice(1)}
                            </span>
                          </div>
                          <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5 }}>{typeof value === 'string' ? value.replace(/^(ready|partial|not_ready)\s*—?\s*/i, '') : ''}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Top GEO fix */}
              {ai?.geo_analysis?.top_geo_fix && (
                <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--primary)', padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                  <p style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, color: 'var(--primary)' }}>Top GEO Fix</p>
                  <p style={{ fontSize: 14, color: 'var(--text)' }}>{ai.geo_analysis.top_geo_fix}</p>
                </div>
              )}

              {/* Schema Analysis (richer version) */}
              {(ai?.schema_analysis || findings?.detectedSchemas?.length > 0) && (
                <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: 20, gridColumn: 'span 2', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 16 }}>Schema Analysis</p>

                  {/* Detected schemas */}
                  {ai?.schema_analysis?.detected?.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <p style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500, marginBottom: 8 }}>Detected</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {ai.schema_analysis.detected.map((schema, i) => (
                          <SchemaDetectedCard key={i} schema={schema} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Recommended schemas */}
                  {ai?.schema_analysis?.recommended?.filter(r => r.relevant !== false).length > 0 && (
                    <div>
                      <p style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500, marginBottom: 8 }}>Recommended / Missing</p>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {ai.schema_analysis.recommended.filter(r => r.relevant !== false).map((rec, i) => (
                          <SchemaRecommendedCard key={i} rec={rec} />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Content recommendations */}
              {ai?.content_recommendations && (
                <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: 20, gridColumn: 'span 2', boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
                  <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 16 }}>Content Recommendations</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                    {[
                      ['Rewrite Priority', ai.content_recommendations.rewrite_priority],
                      // informational-only keys — the prompt omits them for commercial pages
                      ['Statistics to Add', ai.content_recommendations.statistics_to_add],
                      ['Expert Quote Guidance', ai.content_recommendations.expert_quote_guidance],
                      // commercial-only keys — omitted for informational pages
                      ['Entity Completeness Actions', ai.content_recommendations.entity_completeness_actions],
                      ['Direct Answer Rewrite', ai.content_recommendations.direct_answer_rewrite],
                      ['Word Count Verdict', ai.content_recommendations.word_count_verdict],
                    ].filter(([, v]) => v).map(([label, value]) => (
                      <div key={label} style={{ background: 'var(--surface)', borderRadius: 8, padding: 12 }}>
                        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>{label}</p>
                        <p style={{ fontSize: 14, color: 'var(--text)' }}>{value}</p>
                      </div>
                    ))}
                    {ai.content_recommendations.faq_recommendation && (
                      <div style={{ background: 'var(--surface)', borderRadius: 8, padding: 12, gridColumn: 'span 2' }}>
                        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 4 }}>FAQ Recommendations</p>
                        <p style={{ fontSize: 14, color: 'var(--text)', whiteSpace: 'pre-line' }}>{ai.content_recommendations.faq_recommendation}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* No AI analysis fallback */}
              {!ai && (
                <div style={{ background: 'var(--warning-soft)', border: '1px solid var(--warning)', borderRadius: 'var(--r-lg)', padding: 20, gridColumn: 'span 2' }}>
                  <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--warning)', marginBottom: 4 }}>AI analysis unavailable</p>
                  <p style={{ fontSize: 14, color: 'var(--warning)' }}>The GPT-4o mini analysis did not complete. Raw check results are available in the Issues tab.</p>
                </div>
              )}
            </div>
          )}

        </div>
      )}
      <ModuleRuns toolId="seo-geo-audit" />
    </main>
  );
}
