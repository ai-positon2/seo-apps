// The On-Page SEO Audit report body.
//
// Rendered by the "On-Page" tab inside the SEO & GEO Audit, which is now the only
// way into this report. It was extracted from a standalone pages/OnPageAuditPage.jsx
// so the tab and that page could share one implementation; the page has since been
// removed as a duplicate of the tab, and this component outlived it.
//
// The audit itself still runs server-side through /api/on-page-audit — see
// hooks/useOnPageTab.js. The project dashboard's On-Page score is a separate path
// that calls the auditor directly (server/modules/projects/moduleRunners.js).
import { useState } from 'react';

const STATUS_COLORS = {
  pass:    { bg: 'var(--success-soft)', text: 'var(--success)', label: 'Pass'    },
  fail:    { bg: 'var(--danger-soft)',  text: 'var(--danger)',  label: 'Fail'    },
  warning: { bg: 'var(--warning-soft)', text: 'var(--warning)', label: 'Warning' },
  manual:  { bg: 'var(--info-soft)',    text: 'var(--info)',    label: 'Manual'  },
  na:      { bg: 'var(--surface)',      text: 'var(--text-2)',  label: 'N/A'     },
};

export function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.na;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', padding: '2px 8px',
      borderRadius: 4, fontSize: 12, fontWeight: 600,
      backgroundColor: c.bg, color: c.text,
    }}>
      {c.label}
    </span>
  );
}

function ChevronDown({ open }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
      style={{ transform: open ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function CheckCircle() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function XCircle() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function AlertTriangle() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
    </svg>
  );
}

// ── Scorecard ─────────────────────────────────────────────────────────────────

function Scorecard({ audit }) {
  const counts = { pass: 0, fail: 0, warning: 0, manual: 0, na: 0 };
  (audit.sections || []).forEach(s => s.checks.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; }));
  const scored = counts.pass + counts.fail + counts.warning;
  const score = scored > 0 ? Math.round((counts.pass / scored) * 100) : 0;

  const scoreColor = score >= 80 ? 'var(--success)' : score >= 60 ? 'var(--warning)' : 'var(--danger)';
  const scoreBg    = score >= 80 ? 'var(--success-soft)' : score >= 60 ? 'var(--warning-soft)' : 'var(--danger-soft)';

  const statItems = [
    ['pass',    counts.pass,    'var(--success)'],
    ['fail',    counts.fail,    'var(--danger)'],
    ['warning', counts.warning, 'var(--warning)'],
    ['manual',  counts.manual,  'var(--info)'],
    ['na',      counts.na,      'var(--text-2)'],
  ];

  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)', padding: 24, marginBottom: 24,
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
        <div style={{ flexShrink: 0, textAlign: 'center' }}>
          <div style={{ fontSize: 48, fontWeight: 700, color: scoreColor, fontFamily: 'var(--font-mono)' }}>{score}</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>Score (pass%)</div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320 }}>{audit.url}</span>
            {audit.pageType && (
              <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 99, fontWeight: 500, background: 'var(--info-soft)', color: 'var(--info)' }}>
                {audit.pageType}
              </span>
            )}
            {audit.isYMYL && (
              <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 99, fontWeight: 500, background: 'var(--danger-soft)', color: 'var(--danger)' }}>YMYL</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 12 }}>
            Keywords: {(audit.primaryKeywords || []).join(', ') || '—'} · {audit.auditDate ? new Date(audit.auditDate).toLocaleString() : ''}
          </div>
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {statItems.map(([label, count, color]) => (
              <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: color, display: 'inline-block' }} />
                <span style={{ fontSize: 14, fontWeight: 600, color }}>{count}</span>
                <span style={{ fontSize: 12, color: 'var(--text-2)', textTransform: 'capitalize' }}>{label}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ flexShrink: 0, textAlign: 'center', borderRadius: 'var(--r-lg)', padding: '12px 20px', backgroundColor: scoreBg }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: scoreColor, fontFamily: 'var(--font-mono)' }}>{score}%</div>
          <div style={{ fontSize: 12, marginTop: 4, color: scoreColor }}>Pass Rate</div>
        </div>
      </div>
    </div>
  );
}

// ── Priority action list ──────────────────────────────────────────────────────

function PriorityActions({ actions }) {
  if (!actions?.length) return null;
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)', marginBottom: 24, overflow: 'hidden',
    }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14, margin: 0 }}>Top Priority Actions</h2>
        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '2px 0 0' }}>Highest-impact fixes ordered by SEO priority</p>
      </div>
      <div>
        {actions.map((a, i) => (
          <div key={i} style={{
            padding: '16px 24px', display: 'flex', gap: 16,
            borderBottom: i < actions.length - 1 ? '1px solid var(--border)' : 'none',
          }}>
            <div style={{
              flexShrink: 0, width: 28, height: 28, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, color: '#fff',
              backgroundColor: a.status === 'fail' ? 'var(--danger)' : 'var(--warning)',
            }}>
              {a.rank}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{a.issue}</span>
                <StatusBadge status={a.status} />
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{a.sectionName}</span>
              </div>
              {a.why && <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 4px' }}>{a.why}</p>}
              {a.fix && (
                <p style={{
                  fontSize: 12, color: 'var(--text)', background: 'var(--surface)',
                  borderRadius: 4, padding: '8px 12px', border: '1px solid var(--border)', margin: 0,
                }}>
                  Fix: {a.fix}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Check row ─────────────────────────────────────────────────────────────────

function CheckRow({ check }) {
  const [open, setOpen] = useState(check.status === 'fail');
  const showExpand = check.evidence || check.recommendation;
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <button
        onClick={() => showExpand && setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 24px', textAlign: 'left', background: 'none', border: 'none',
          cursor: showExpand ? 'pointer' : 'default', transition: 'background 0.15s',
        }}
        onMouseEnter={e => { if (showExpand) e.currentTarget.style.background = 'var(--surface)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
      >
        <div style={{ flexShrink: 0, width: 20, height: 20, color: STATUS_COLORS[check.status]?.text || 'var(--text-2)' }}>
          {check.status === 'pass' && <CheckCircle />}
          {check.status === 'fail' && <XCircle />}
          {(check.status === 'warning' || check.status === 'manual') && <AlertTriangle />}
        </div>
        <span style={{ flex: 1, fontSize: 14, color: 'var(--text)' }}>{check.label}</span>
        <StatusBadge status={check.status} />
        {showExpand && (
          <span style={{ flexShrink: 0, color: 'var(--text-3)' }}>
            <ChevronDown open={open} />
          </span>
        )}
      </button>
      {open && showExpand && (
        <div style={{ padding: '0 24px 16px', marginLeft: 32, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {check.evidence && (
            <div style={{
              fontSize: 12, background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 4, padding: '8px 12px', color: 'var(--text)',
              fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
            }}>
              {check.evidence}
            </div>
          )}
          {check.recommendation && (
            <div style={{
              fontSize: 12, color: 'var(--text)', background: 'var(--info-soft)',
              border: '1px solid var(--info)', borderRadius: 4, padding: '8px 12px',
            }}>
              <span style={{ fontWeight: 600, color: 'var(--info)' }}>Recommendation: </span>
              {check.recommendation}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Section card ──────────────────────────────────────────────────────────────

function SectionCard({ section }) {
  const [open, setOpen] = useState(section.status === 'fail' || section.status === 'warning');
  const c = STATUS_COLORS[section.status] || STATUS_COLORS.na;
  const counts = section.checks.reduce((acc, ck) => { acc[ck.status] = (acc[ck.status] || 0) + 1; return acc; }, {});
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)', marginBottom: 12, overflow: 'hidden',
    }}>
      <button
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 24px', background: 'none', border: 'none', cursor: 'pointer',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
        onClick={() => setOpen(o => !o)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontSize: 14, fontWeight: 600, color: c.text,
            backgroundColor: c.bg, padding: '2px 8px', borderRadius: 4,
          }}>{c.label}</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{section.name}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'flex', gap: 8, fontSize: 12 }}>
            {counts.fail > 0 && <span style={{ fontWeight: 600, color: 'var(--danger)' }}>{counts.fail} fail</span>}
            {counts.warning > 0 && <span style={{ fontWeight: 600, color: 'var(--warning)' }}>{counts.warning} warn</span>}
            {counts.pass > 0 && <span style={{ fontWeight: 600, color: 'var(--success)' }}>{counts.pass} pass</span>}
            {counts.manual > 0 && <span style={{ fontWeight: 600, color: 'var(--info)' }}>{counts.manual} manual</span>}
          </div>
          <span style={{ color: 'var(--text-3)' }}><ChevronDown open={open} /></span>
        </div>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {section.checks.map((ck, i) => <CheckRow key={i} check={ck} />)}
        </div>
      )}
    </div>
  );
}

// ── Manual items summary ──────────────────────────────────────────────────────

function ManualSummary({ items }) {
  // The hook has to run before any early return: the original called useState AFTER
  // `if (!items?.length) return null`, so a render where items went from empty to non-empty
  // changed the hook count and threw "Rendered more hooks than during the previous render".
  // That never fired on the standalone page (audit is set once) but the tab loads async.
  const [open, setOpen] = useState(false);
  if (!items?.length) return null;
  return (
    <div style={{
      background: 'var(--card)', border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)', marginBottom: 24, overflow: 'hidden',
    }}>
      <button
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 24px', background: 'none', border: 'none', cursor: 'pointer',
          transition: 'background 0.15s',
        }}
        onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
        onMouseLeave={e => e.currentTarget.style.background = 'none'}
        onClick={() => setOpen(o => !o)}
      >
        <div>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Manual Checks Summary</span>
          <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-2)' }}>{items.length} items require human verification</span>
        </div>
        <span style={{ color: 'var(--text-3)' }}><ChevronDown open={open} /></span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {items.map((item, i) => (
            <div key={i} style={{
              padding: '16px 24px',
              borderBottom: i < items.length - 1 ? '1px solid var(--border)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                <StatusBadge status="manual" />
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{item.sectionName}</span>
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{item.label}</span>
              </div>
              {item.evidence && (
                <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 4px' }}>{item.evidence}</p>
              )}
              {item.instructions && (
                <p style={{
                  fontSize: 12, color: 'var(--info)', background: 'var(--info-soft)',
                  borderRadius: 4, padding: '8px 12px', border: '1px solid var(--info)', margin: 0,
                }}>{item.instructions}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Data errors banner ────────────────────────────────────────────────────────

function DataErrorsBanner({ errors }) {
  const entries = Object.entries(errors || {}).filter(([, v]) => v);
  if (!entries.length) return null;
  return (
    <div style={{
      background: 'var(--warning-soft)', border: '1px solid var(--warning)',
      borderRadius: 8, padding: '12px 16px', marginBottom: 16,
      fontSize: 12, color: 'var(--warning)',
    }}>
      <span style={{ fontWeight: 600 }}>Data collection warnings:</span>
      {entries.map(([k, v]) => (
        <span key={k} style={{ marginLeft: 8 }}>{k}: {String(v).slice(0, 80)}</span>
      ))}
    </div>
  );
}

// The report body only — no page chrome, so it drops into either host unchanged.
export default function OnPageReport({ audit }) {
  if (!audit) return null;
  return (
    <>
      <DataErrorsBanner errors={audit.dataErrors} />
      <Scorecard audit={audit} />
      <PriorityActions actions={audit.priorityActions} />
      <ManualSummary items={audit.manualItems} />
      <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 12, marginTop: 24 }}>
        All {audit.sections?.length || 0} Sections
      </h2>
      {(audit.sections || []).map((s, i) => <SectionCard key={i} section={s} />)}
    </>
  );
}
