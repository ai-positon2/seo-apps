import { useState, useEffect, useRef, useCallback } from 'react';
import { startAudit, pollStatus, getResult, listAudits, deleteAudit } from '../lib/onPageAuditApi';
import ModuleRuns from '../components/ModuleRuns';

const POLL_MS = 3500;

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  pass:    { bg: 'var(--success-soft)', text: 'var(--success)', label: 'Pass'    },
  fail:    { bg: 'var(--danger-soft)',  text: 'var(--danger)',  label: 'Fail'    },
  warning: { bg: 'var(--warning-soft)', text: 'var(--warning)', label: 'Warning' },
  manual:  { bg: 'var(--info-soft)',    text: 'var(--info)',    label: 'Manual'  },
  na:      { bg: 'var(--surface)',      text: 'var(--text-2)',  label: 'N/A'     },
};

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.na;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: 4,
      fontSize: 12,
      fontWeight: 600,
      backgroundColor: c.bg,
      color: c.text,
    }}>
      {c.label}
    </span>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────────

function MagnifyIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 10.607z" />
    </svg>
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

// ── Header ────────────────────────────────────────────────────────────────────

function Header({ onBack }) {
  return (
    <header style={{
      background: 'var(--card)',
      borderBottom: '1px solid var(--border)',
      height: 56,
      display: 'flex',
      alignItems: 'center',
      padding: '0 24px',
      flexShrink: 0,
    }}>
      <div style={{ maxWidth: 1280, margin: '0 auto', width: '100%', display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={onBack} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'none', border: 'none', cursor: 'pointer', opacity: 1, transition: 'opacity 0.15s' }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.8'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}>
          <div style={{
            width: 28, height: 28, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--primary)', color: '#fff',
          }}>
            <MagnifyIcon />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 700, color: 'var(--text)', fontSize: 14, letterSpacing: '-0.02em' }}>On-Page SEO Audit</span>
            <span style={{ color: 'var(--text-3)', fontSize: 14 }}>· Arena</span>
          </div>
        </button>
      </div>
    </header>
  );
}

// ── Scorecard ─────────────────────────────────────────────────────────────────

function Scorecard({ audit }) {
  const counts = { pass: 0, fail: 0, warning: 0, manual: 0, na: 0 };
  (audit.sections || []).forEach(s => s.checks.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; }));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const scored = counts.pass + counts.fail + counts.warning;
  const score = scored > 0 ? Math.round((counts.pass / scored) * 100) : 0;

  const scoreColor = score >= 80 ? 'var(--success)' : score >= 60 ? 'var(--warning)' : 'var(--danger)';
  const scoreBg    = score >= 80 ? 'var(--success-soft)' : score >= 60 ? 'var(--warning-soft)' : 'var(--danger-soft)';

  const statItems = [
    ['pass',    counts.pass,    'var(--success)', 'var(--success-soft)'],
    ['fail',    counts.fail,    'var(--danger)',  'var(--danger-soft)'],
    ['warning', counts.warning, 'var(--warning)', 'var(--warning-soft)'],
    ['manual',  counts.manual,  'var(--info)',    'var(--info-soft)'],
    ['na',      counts.na,      'var(--text-2)',  'var(--surface)'],
  ];

  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      padding: 24,
      marginBottom: 24,
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 24 }}>
        {/* Score number */}
        <div style={{ flexShrink: 0, textAlign: 'center' }}>
          <div style={{ fontSize: 48, fontWeight: 700, color: scoreColor, fontFamily: 'var(--font-mono)' }}>{score}</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>Score (pass%)</div>
        </div>
        {/* URL + meta */}
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
            Keywords: {(audit.primaryKeywords || []).join(', ')} · {new Date(audit.auditDate).toLocaleString()}
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
        {/* Pass-rate pill */}
        <div style={{ flexShrink: 0, textAlign: 'center', borderRadius: 'var(--r-lg)', padding: '12px 20px', backgroundColor: scoreBg }}>
          <div style={{ fontSize: 24, fontWeight: 700, color: scoreColor, fontFamily: 'var(--font-mono)' }}>{score}%</div>
          <div style={{ fontSize: 12, marginTop: 4, color: scoreColor }}>Pass Rate</div>
        </div>
      </div>
    </div>
  );
}

// ── Priority Action List ───────────────────────────────────────────────────────

function PriorityActions({ actions }) {
  if (!actions?.length) return null;
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      marginBottom: 24,
      overflow: 'hidden',
    }}>
      <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border)' }}>
        <h2 style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14, margin: 0 }}>Top Priority Actions</h2>
        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '2px 0 0' }}>Highest-impact fixes ordered by SEO priority</p>
      </div>
      <div>
        {actions.map((a, i) => (
          <div key={i} style={{
            padding: '16px 24px',
            display: 'flex',
            gap: 16,
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
              <p style={{ fontSize: 12, color: 'var(--text-2)', margin: '0 0 4px' }}>{a.why}</p>
              <p style={{
                fontSize: 12, color: 'var(--text)',
                background: 'var(--surface)', borderRadius: 4,
                padding: '8px 12px', border: '1px solid var(--border)', margin: 0,
              }}>
                Fix: {a.fix}
              </p>
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
          cursor: showExpand ? 'pointer' : 'default',
          transition: 'background 0.15s',
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
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      marginBottom: 12,
      overflow: 'hidden',
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

// ── Manual Items Summary ──────────────────────────────────────────────────────

function ManualSummary({ items }) {
  if (!items?.length) return null;
  const [open, setOpen] = useState(false);
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r-lg)',
      marginBottom: 24,
      overflow: 'hidden',
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

// ── Report view ───────────────────────────────────────────────────────────────

function ReportView({ audit, onNewAudit }) {
  return (
    <div style={{ maxWidth: 896, margin: '0 auto', padding: '0 16px 48px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 0' }}>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', margin: 0 }}>Audit Report</h1>
        <button
          onClick={onNewAudit}
          style={{
            fontSize: 14, padding: '8px 16px', borderRadius: 8,
            fontWeight: 500, color: '#fff', border: 'none', cursor: 'pointer',
            background: 'var(--primary)', transition: 'opacity 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.opacity = '0.88'}
          onMouseLeave={e => e.currentTarget.style.opacity = '1'}
        >
          New Audit
        </button>
      </div>

      <DataErrorsBanner errors={audit.dataErrors} />
      <Scorecard audit={audit} />
      <PriorityActions actions={audit.priorityActions} />
      <ManualSummary items={audit.manualItems} />

      <h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 12, marginTop: 24 }}>
        All {audit.sections?.length} Sections
      </h2>
      {(audit.sections || []).map((s, i) => <SectionCard key={i} section={s} />)}
    </div>
  );
}

// ── Progress screen ───────────────────────────────────────────────────────────

function ProgressScreen({ progress }) {
  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{
        maxWidth: 512, margin: '0 auto', padding: '96px 16px',
        display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center',
      }}>
        <div style={{
          width: 48, height: 48, borderRadius: '50%',
          border: '4px solid var(--primary-soft)',
          borderTopColor: 'var(--primary)',
          animation: 'spin 0.8s linear infinite',
          marginBottom: 24,
        }} />
        <h2 style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 8, margin: '0 0 8px' }}>Running Audit…</h2>
        <p style={{ fontSize: 14, color: 'var(--text-2)', margin: 0 }}>{progress || 'Initializing…'}</p>
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 12 }}>PageSpeed Insights can take 30–60 seconds. Please wait.</p>
      </div>
    </>
  );
}

// ── History list ──────────────────────────────────────────────────────────────

function HistoryList({ audits, onSelect, onDelete }) {
  if (!audits.length) return null;
  return (
    <div style={{ marginTop: 32 }}>
      <h3 style={{
        fontSize: 12, fontWeight: 600, color: 'var(--text-2)',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12,
      }}>Recent Audits</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {audits.map(a => (
          <div key={a.id} style={{
            background: 'var(--card)', borderRadius: 8, border: '1px solid var(--border)',
            padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12,
            transition: 'box-shadow 0.15s',
          }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = '0 1px 4px rgba(0,0,0,0.08)'}
            onMouseLeave={e => e.currentTarget.style.boxShadow = 'none'}
          >
            <button style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }} onClick={() => onSelect(a.id)}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
                <span style={{
                  fontSize: 14, fontWeight: 500, color: 'var(--text)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 320,
                }}>{a.url}</span>
                {a.pageType && (
                  <span style={{ fontSize: 12, padding: '1px 6px', borderRadius: 4, color: 'var(--info)', background: 'var(--info-soft)' }}>{a.pageType}</span>
                )}
                {a.status === 'failed' && (
                  <span style={{ fontSize: 12, padding: '1px 6px', borderRadius: 4, color: 'var(--danger)', background: 'var(--danger-soft)' }}>Failed</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {new Date(a.auditDate).toLocaleString()} · {a.failCount} fail · {a.passCount}/{a.totalSections} sections pass
              </div>
            </button>
            <button
              onClick={() => onDelete(a.id)}
              style={{
                flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--text-3)', fontSize: 12, padding: 4, transition: 'color 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--danger)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--text-3)'}
              title="Delete"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Input form ────────────────────────────────────────────────────────────────

function InputForm({ onSubmit, loading }) {
  const [url, setUrl] = useState('');
  const [keywords, setKeywords] = useState('');
  const [error, setError] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    setError('');
    const trimUrl = url.trim();
    if (!trimUrl || !/^https?:\/\/./.test(trimUrl)) {
      setError('Please enter a valid URL starting with http:// or https://');
      return;
    }
    const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
    if (!kws.length) {
      setError('Please enter at least one primary keyword');
      return;
    }
    onSubmit(trimUrl, kws);
  }

  const inputStyle = {
    width: '100%', border: '1px solid var(--border)', borderRadius: 8,
    padding: '10px 16px', fontSize: 14, outline: 'none',
    background: 'var(--card)', color: 'var(--text)',
    boxSizing: 'border-box', transition: 'border-color 0.15s',
    opacity: loading ? 0.5 : 1,
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>Page URL</label>
        <input
          type="url"
          value={url}
          onChange={e => setUrl(e.target.value)}
          placeholder="https://example.com/service-page/"
          disabled={loading}
          style={inputStyle}
          onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
          onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
        />
      </div>
      <div>
        <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
          Primary Keywords{' '}
          <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(comma-separated, e.g. "dental implants, dental implants cost")</span>
        </label>
        <input
          type="text"
          value={keywords}
          onChange={e => setKeywords(e.target.value)}
          placeholder="dental implants, dental implants near me"
          disabled={loading}
          style={inputStyle}
          onFocus={e => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
          onBlur={e => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
        />
      </div>
      {error && <p style={{ fontSize: 12, color: 'var(--danger)', margin: 0 }}>{error}</p>}
      <button
        type="submit"
        disabled={loading}
        style={{
          width: '100%', padding: '10px 0', borderRadius: 8,
          fontSize: 14, fontWeight: 600, color: '#fff', border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
          background: 'var(--primary)', opacity: loading ? 0.5 : 1, transition: 'opacity 0.15s',
        }}
      >
        {loading ? 'Running…' : 'Run Audit'}
      </button>
    </form>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OnPageAuditPage() {
  const [view, setView] = useState('input'); // input | progress | report
  const [jobId, setJobId] = useState(null);
  const [progress, setProgress] = useState('');
  const [audit, setAudit] = useState(null);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const pollRef = useRef(null);

  useEffect(() => {
    listAudits().then(setHistory).catch(() => {});
    return () => clearInterval(pollRef.current);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  async function handleSubmit(url, kws) {
    setLoading(true);
    setView('progress');
    setProgress('Starting…');
    try {
      const { jobId: jid } = await startAudit(url, kws);
      setJobId(jid);
      pollRef.current = setInterval(async () => {
        try {
          const job = await pollStatus(jid);
          setProgress(job.progress || '');
          if (job.status === 'complete') {
            stopPolling();
            const result = await getResult(job.auditId);
            setAudit(result);
            setView('report');
            setLoading(false);
            listAudits().then(setHistory).catch(() => {});
          } else if (job.status === 'failed') {
            stopPolling();
            setView('input');
            setLoading(false);
            alert(`Audit failed: ${job.error || 'Unknown error'}`);
          }
        } catch (err) {
          // network blip — keep polling
        }
      }, POLL_MS);
    } catch (err) {
      setView('input');
      setLoading(false);
      alert(`Failed to start audit: ${err.message}`);
    }
  }

  async function handleSelectHistory(auditId) {
    const result = await getResult(auditId);
    if (result) { setAudit(result); setView('report'); }
  }

  async function handleDeleteHistory(auditId) {
    await deleteAudit(auditId);
    setHistory(h => h.filter(a => a.id !== auditId));
  }

  function handleNewAudit() {
    setView('input');
    setAudit(null);
    setJobId(null);
    setProgress('');
  }

  return (
    <>
      {view === 'input' && (
        <main style={{ flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 48, padding: '48px 16px 0' }}>
          <div style={{ width: '100%', maxWidth: 576 }}>
            <div style={{
              background: 'var(--card)', borderRadius: 'var(--r-lg)',
              border: '1px solid var(--border)', padding: 32,
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
            }}>
              <div style={{ marginBottom: 24 }}>
                <h1 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', margin: '0 0 4px' }}>On-Page SEO Audit</h1>
                <p style={{ fontSize: 14, color: 'var(--text-2)', margin: 0 }}>
                  Run 23 sections of automated checks — URL, meta, headings, content, schema, Core Web Vitals, mobile, E-E-A-T, local SEO, and more. Live data from the page + PageSpeed Insights API.
                </p>
              </div>
              <InputForm onSubmit={handleSubmit} loading={loading} />
            </div>
            <HistoryList audits={history} onSelect={handleSelectHistory} onDelete={handleDeleteHistory} />
            <ModuleRuns toolId="on-page-audit" />
          </div>
        </main>
      )}

      {view === 'progress' && <ProgressScreen progress={progress} />}

      {view === 'report' && audit && (
        <main style={{ flex: 1 }}>
          <ReportView audit={audit} onNewAudit={handleNewAudit} />
        </main>
      )}
    </>
  );
}
