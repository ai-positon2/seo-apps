import { useState, useEffect, useRef, useCallback } from 'react';
import { startAudit, pollStatus, getResult, listAudits, deleteAudit } from '../lib/onPageAuditApi';
import ModuleRuns from '../components/ModuleRuns';
import ProjectReportBar from '../components/project/ProjectReportBar';
import ReportResolving from '../components/project/ReportResolving';
import OnPageReport from '../components/onPageAudit/OnPageReport';

const POLL_MS = 3500;


// ── Icons ─────────────────────────────────────────────────────────────────────

function MagnifyIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={16} height={16} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 15.803a7.5 7.5 0 0010.607 10.607z" />
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

      <OnPageReport audit={audit} />
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
    // Keywords are optional. Without them the six keyword-placement checks report N/A and
    // every other check still runs, so blocking submission here would be a false gate.
    const kws = keywords.split(',').map(k => k.trim()).filter(Boolean);
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
          <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(optional — comma-separated. Adds 6 keyword-placement checks)</span>
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
  // Which screen to draw: 'loading' until ProjectReportBar has worked out
  // whether this client has a stored report, then 'report' or 'none'. Starting
  // at 'loading' is the point — the input form used to render on mount and be
  // replaced a moment later.
  const [reportState, setReportState] = useState('loading');
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
      {/* Above the view switch, because it stays mounted while you use it: it
          opens a page's report (same path as the tool's own history — set the
          audit, switch view), and switching page has to swap the report rather
          than unmount the switcher. */}
      <div style={{ width: '100%', maxWidth: 1120, margin: '0 auto', padding: '20px 16px 0', boxSizing: 'border-box' }}>
        <ProjectReportBar
          moduleKey="on_page"
          onOpenReport={(native) => { setAudit(native); setView('report'); }}
          onResolved={setReportState}
        />
      </div>

      {/* Resolved before drawn: the input form no longer flashes on a client
          that already has a stored report. */}
      {reportState === 'loading' && view === 'input' && <ReportResolving maxWidth={576} />}

      {view === 'input' && reportState !== 'loading' && (
        <main style={{ flex: 1, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8px 16px 0' }}>
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
