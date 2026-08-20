import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import InputForm from '../components/competitorAnalysis/InputForm';
import CompetitorConfirmation from '../components/competitorAnalysis/CompetitorConfirmation';
import ManualUpload from '../components/competitorAnalysis/ManualUpload';
import ProgressTracker from '../components/competitorAnalysis/ProgressTracker';
import ReportPreview from '../components/competitorAnalysis/ReportPreview';
import { refreshSemrushBalance } from '../lib/semrushBalanceStore';
import ModuleRuns from '../components/ModuleRuns';

const API_STEPS  = [{ id: 1, label: 'Input' }, { id: 2, label: 'Discovery' }, { id: 3, label: 'Confirm' }, { id: 4, label: 'Analysis' }, { id: 5, label: 'Report' }];
const MANUAL_STEPS = [{ id: 1, label: 'Input' }, { id: 3, label: 'Upload' }, { id: 4, label: 'Analysis' }, { id: 5, label: 'Report' }];

function StepBar({ step, mode }) {
  const steps = mode === 'manual' ? MANUAL_STEPS : API_STEPS;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: '2rem' }}>
      {steps.map((s, i) => {
        const done = step > s.id;
        const active = step === s.id;
        return (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', flex: 1 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
              <div style={{
                width: 32, height: 32, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, fontWeight: 700,
                background: done ? 'var(--success)' : active ? 'var(--primary)' : 'var(--border)',
                color: done || active ? '#fff' : 'var(--text-3)',
                transition: 'background 0.2s',
              }}>
                {done ? (
                  <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : (i + 1)}
              </div>
              <span style={{
                fontSize: 12, marginTop: 4, fontWeight: 500,
                color: active ? 'var(--primary)' : done ? 'var(--success)' : 'var(--text-3)',
              }}>
                {s.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div style={{
                height: 2, flex: 1, marginBottom: 16,
                background: done ? 'var(--success)' : 'var(--border)',
                transition: 'background 0.2s',
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function CompetitorAnalysisPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState('api'); // 'api' | 'manual'
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Step 3 data
  const [jobId, setJobId] = useState(null);
  const [competitors, setCompetitors] = useState([]);
  const [gptSummary, setGptSummary] = useState('');
  const [brandInfo, setBrandInfo] = useState(null);

  // Step 4 data
  const [sectionStatuses, setSectionStatuses] = useState({});
  const [overallProgress, setOverallProgress] = useState(0);

  // Step 5 data
  const [reportData, setReportData] = useState(null);

  const esRef = useRef(null);

  useEffect(() => {
    return () => {
      if (esRef.current) esRef.current.close();
    };
  }, []);

  // ── Step 1: Form submit — branches on mode ──────────────────────────────────

  async function handleDiscover(formData) {
    setLoading(true);
    setError('');
    setBrandInfo(formData);

    if (formData.mode === 'manual') {
      // Just create the job without hitting Semrush
      try {
        const res = await fetch('/api/competitor-analysis/prepare', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(formData),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to prepare job');
        setJobId(data.jobId);
        setStep(3); // ManualUpload step
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
      return;
    }

    // API mode: discover via Semrush
    setStep(2);
    try {
      const res = await fetch('/api/competitor-analysis/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Discovery failed');
      setJobId(data.jobId);
      setCompetitors(data.competitors || []);
      setGptSummary(data.gptSummary || '');
      setStep(3);
      refreshSemrushBalance();
    } catch (err) {
      setError(err.message);
      setStep(1);
    } finally {
      setLoading(false);
    }
  }

  // ── Step 3 (API mode) → 4: Run Full Analysis ───────────────────────────────

  async function handleRunAnalysis(confirmedCompetitors) {
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/competitor-analysis/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, competitors: confirmedCompetitors }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start analysis');
      setStep(4);
      setLoading(false);
      connectSSE(jobId);
      refreshSemrushBalance();
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  // ── Step 3 (Manual mode) → 4: Upload CSVs and run ─────────────────────────

  async function handleManualRun(confirmedCompetitors, positionFiles, refdomainFiles, authorityScores) {
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/competitor-analysis/run-manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId, competitors: confirmedCompetitors, positionFiles, refdomainFiles, authorityScores }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start analysis');
      setStep(4);
      setLoading(false);
      connectSSE(jobId);
    } catch (err) {
      setError(err.message);
      setLoading(false);
    }
  }

  function connectSSE(id) {
    if (esRef.current) esRef.current.close();

    const es = new EventSource(`/api/competitor-analysis/progress/${id}`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        handleSSEEvent(event);
      } catch {}
    };

    es.onerror = () => {
      es.close();
    };
  }

  function handleSSEEvent(event) {
    if (event.type === 'section_start') {
      setSectionStatuses(s => ({ ...s, [event.section]: 'active' }));
    } else if (event.type === 'section_done') {
      setSectionStatuses(s => ({ ...s, [event.section]: 'done' }));
      setOverallProgress(event.progress || 0);
    } else if (event.type === 'done') {
      setSectionStatuses(s => {
        const all = { ...s };
        Object.keys(all).forEach(k => { all[k] = 'done'; });
        return all;
      });
      setOverallProgress(100);
      setReportData(event.reportData);
      setTimeout(() => setStep(5), 800);
      if (esRef.current) esRef.current.close();
    } else if (event.type === 'error') {
      setError(event.message || 'Analysis failed');
      if (esRef.current) esRef.current.close();
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const stepTitles = {
    1: 'New Competitor Analysis',
    2: 'Discovering Competitors…',
    3: mode === 'manual' ? 'Upload Semrush Reports' : 'Confirm Competitor List',
    4: 'Running Full Analysis…',
    5: 'Report Preview',
  };

  return (
    <>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <div style={{ minHeight: '100vh', background: 'var(--surface)' }}>
        {/* Top nav */}
        <header style={{ background: 'var(--card)', borderBottom: '1px solid var(--border)', height: 56, display: 'flex', alignItems: 'center', padding: '0 1.5rem' }}>
          <div style={{ maxWidth: 896, margin: '0 auto', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={() => navigate('/')}
                style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
              >
                <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5L3 12m0 0l7.5-7.5M3 12h18" />
                </svg>
              </button>
              <div style={{ width: 1, height: 16, background: 'var(--border)' }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 24, height: 24, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--danger-soft)' }}>
                  <svg style={{ width: 14, height: 14, color: 'var(--danger)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                </div>
                <span style={{ fontWeight: 600, color: 'var(--text)', fontSize: 14 }}>Competitor Analysis</span>
              </div>
            </div>
            {brandInfo && (
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {brandInfo.brandName} · {brandInfo.targetUrl} · {brandInfo.country}
              </span>
            )}
          </div>
        </header>

        <main style={{ maxWidth: 896, margin: '0 auto', padding: '2rem 1.5rem' }}>
          <StepBar step={step} mode={mode} />

          {/* Error banner */}
          {error && (
            <div style={{
              marginBottom: 24,
              background: 'var(--danger-soft)',
              border: '1px solid var(--danger)',
              borderRadius: 'var(--r-lg)',
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 12,
            }}>
              <svg style={{ width: 16, height: 16, color: 'var(--danger)', flexShrink: 0, marginTop: 2 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <div>
                <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--danger)', margin: 0 }}>Error</p>
                <p style={{ fontSize: 14, color: 'var(--danger)', margin: '2px 0 0' }}>{error}</p>
              </div>
              <button
                onClick={() => setError('')}
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger)', padding: 0 }}
              >
                <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 20, marginTop: 0 }}>{stepTitles[step]}</h2>

            {/* Step 1: Input */}
            {step === 1 && (
              <InputForm
                onSubmit={handleDiscover}
                loading={loading}
                mode={mode}
                onModeChange={m => setMode(m)}
              />
            )}

            {/* Step 2: Auto-discovery loading (API mode only) */}
            {step === 2 && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem 0', gap: 20 }}>
                <div style={{
                  width: 48, height: 48,
                  border: '4px solid var(--border)',
                  borderTopColor: 'var(--primary)',
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
                <div style={{ textAlign: 'center' }}>
                  <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', margin: 0 }}>Discovering competitors…</p>
                  <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>Pulling Semrush data and running AI validation</p>
                </div>
              </div>
            )}

            {/* Step 3: Confirm competitors (API) or Upload CSVs (manual) */}
            {step === 3 && mode === 'api' && (
              <CompetitorConfirmation
                competitors={competitors}
                gptSummary={gptSummary}
                onConfirm={handleRunAnalysis}
                loading={loading}
              />
            )}
            {step === 3 && mode === 'manual' && (
              <ManualUpload
                clientDomain={brandInfo?.targetUrl || ''}
                brandName={brandInfo?.brandName || ''}
                onRunAnalysis={(comps, posFiles, refFiles, ascores) => handleManualRun(comps, posFiles, refFiles, ascores)}
                loading={loading}
              />
            )}

            {/* Step 4: Progress */}
            {step === 4 && (
              <ProgressTracker
                sectionStatuses={sectionStatuses}
                overallProgress={overallProgress}
              />
            )}

            {/* Step 5: Report */}
            {step === 5 && reportData && (
              <ReportPreview
                reportData={reportData}
                jobId={jobId}
                brandName={brandInfo?.brandName || 'Brand'}
              />
            )}
          </div>

          {step === 5 && (
            <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-3)', marginTop: 16 }}>
              {mode === 'manual'
                ? 'Data sourced from uploaded Semrush CSV exports · 0 API units used'
                : 'Semrush API · approximately 150,000–200,000 units per report'}
            </p>
          )}

          <ModuleRuns toolId="competitor-analysis-report" />
        </main>
      </div>
    </>
  );
}
