import { useState, useRef } from 'react';
import ModuleRuns from '../components/ModuleRuns';
import { PageFrame } from '../ui/PageFrame';

const STEPS = [
  { id: 'scrape', label: 'Scraping Pages',      icon: '🔍' },
  { id: 'export', label: 'Building Excel',       icon: '📊' },
];

const DEFAULT_CONFIG = {
  brandName: '',
  locationSuffix: '',
  sitewidePrefix: '',
  locationPrefix: '',
  plansFilenames: '',
  concurrency: '5',
};

// Per-field placeholder + helper copy (Change 7). Keeps the form usable for any site.
const CONFIG_FIELDS = [
  { key: 'brandName',      label: 'Brand name',            placeholder: 'e.g. Aspen Dental' },
  { key: 'locationSuffix', label: 'Location suffix',       placeholder: 'e.g. , TX  (or leave blank)' },
  { key: 'sitewidePrefix', label: 'Sitewide CDN prefix',   placeholder: 'e.g. abc123def456 (optional)',
    helper: 'Enter the Contentful/Cloudinary asset folder ID to identify content images. Leave blank to include all images.' },
  { key: 'locationPrefix', label: 'Location CDN prefix',   placeholder: 'e.g. xyz789uvw012 (optional)',
    helper: 'Enter the Contentful/Cloudinary asset folder ID to identify content images. Leave blank to include all images.' },
  { key: 'plansFilenames', label: 'Plans image filenames', placeholder: 'e.g. pricing-1, pricing-2 (optional)',
    helper: 'Comma-separated partial filenames used to identify pricing/plan images.' },
  { key: 'concurrency',    label: 'Concurrency (1–10)',    placeholder: '5' },
];

function StepBadge({ status }) {
  if (status === 'done') return (
    <span style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, borderRadius: '50%',
      background: 'var(--success)', color: '#fff', fontSize: 12, fontWeight: 700,
    }}>✓</span>
  );
  if (status === 'active') return (
    <span style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, borderRadius: '50%',
      background: 'var(--primary)',
    }}>
      <svg style={{ width: 14, height: 14, color: '#fff', animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none">
        <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    </span>
  );
  return (
    <span style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      width: 28, height: 28, borderRadius: '50%',
      background: 'var(--border)', color: 'var(--text-3)', fontSize: 12,
    }}>·</span>
  );
}

function UrlStatusIcon({ status }) {
  if (status === 'done')
    return <span style={{ color: 'var(--success)', fontWeight: 700, flexShrink: 0 }}>✓</span>;
  if (status === 'error')
    return <span style={{ color: 'var(--danger)', flexShrink: 0 }}>✕</span>;
  if (status === 'loading')
    return (
      <svg style={{ width: 12, height: 12, flexShrink: 0, color: 'var(--primary)', animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none">
        <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
    );
  return (
    <span style={{ width: 12, height: 12, borderRadius: '50%', background: 'var(--border)', flexShrink: 0, display: 'inline-block' }} />
  );
}

function parseUrlList(raw) {
  return raw
    .split(/[\r\n,]+/)
    .map(u => u.trim())
    .filter(u => u && (u.startsWith('http://') || u.startsWith('https://')));
}

export default function ImageAltAuditPage() {
  const fileInputRef = useRef(null);
  const esRef = useRef(null);

  const [urlInput, setUrlInput] = useState('');
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [showConfig, setShowConfig] = useState(false);

  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [steps, setSteps] = useState({});
  const [urlStatuses, setUrlStatuses] = useState({}); // index → { url, status, locationName, contentCount, decorativeCount, error }
  const [error, setError] = useState('');
  const [download, setDownload] = useState(null); // { token, filename }

  const parsedUrls = parseUrlList(urlInput);
  const urlCount = parsedUrls.length;
  const canStart = urlCount > 0 && !running;

  function reset() {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    setStarted(false);
    setRunning(false);
    setSteps({});
    setUrlStatuses({});
    setError('');
    setDownload(null);
  }

  function handleConfigChange(key, value) {
    setConfig(prev => ({ ...prev, [key]: value }));
  }

  function handleFileUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      const text = ev.target.result || '';
      const lines = text.split(/[\r\n]+/).map(l => l.split(',')[0].trim()).filter(Boolean);
      setUrlInput(lines.join('\n'));
    };
    reader.readAsText(file);
    // Reset file input so the same file can be re-uploaded
    e.target.value = '';
  }

  async function startAudit() {
    if (!canStart) return;
    reset();
    setStarted(true);
    setRunning(true);

    // Pre-populate url status slots
    const initial = {};
    parsedUrls.forEach((url, idx) => { initial[idx] = { url, status: 'pending' }; });
    setUrlStatuses(initial);

    try {
      const configPayload = {
        brandName: config.brandName,
        locationSuffix: config.locationSuffix,
        sitewidePrefix: config.sitewidePrefix,
        locationPrefix: config.locationPrefix,
        plansFilenames: config.plansFilenames.split(',').map(s => s.trim()).filter(Boolean),
        concurrency: parseInt(config.concurrency) || 5,
      };

      const initRes = await fetch('/api/image-alt-audit/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ urls: parsedUrls, config: configPayload }),
      });
      if (!initRes.ok) {
        const err = await initRes.json();
        throw new Error(err.error || 'Failed to start audit');
      }
      const { token } = await initRes.json();

      const es = new EventSource(`/api/image-alt-audit/stream/${token}`);
      esRef.current = es;

      es.addEventListener('step', e => {
        const d = JSON.parse(e.data);
        setSteps(prev => ({ ...prev, [d.id]: { status: d.status, message: d.message } }));
      });

      es.addEventListener('url_start', e => {
        const d = JSON.parse(e.data);
        setUrlStatuses(prev => ({ ...prev, [d.index]: { ...prev[d.index], url: d.url, status: 'loading' } }));
      });

      es.addEventListener('url_done', e => {
        const d = JSON.parse(e.data);
        setUrlStatuses(prev => ({
          ...prev,
          [d.index]: {
            url: d.url,
            status: d.success ? 'done' : 'error',
            locationName: d.locationName,
            contentCount: d.contentCount,
            decorativeCount: d.decorativeCount,
            error: d.error,
          },
        }));
      });

      es.addEventListener('ready', e => {
        const d = JSON.parse(e.data);
        setDownload({ token: d.downloadToken, filename: d.filename });
      });

      es.addEventListener('fail', e => {
        setError(JSON.parse(e.data).message);
      });

      es.addEventListener('done', () => {
        es.close();
        esRef.current = null;
        setRunning(false);
      });

      es.onerror = () => {
        es.close();
        esRef.current = null;
        setRunning(false);
        setError(prev => prev || 'Connection lost. Please try again.');
      };

    } catch (err) {
      setError(err.message);
      setRunning(false);
    }
  }

  function handleDownload() {
    if (!download) return;
    window.location.href = `/api/image-alt-audit/download/${download.token}`;
  }

  const urlStatusList = Object.values(urlStatuses);
  const doneCount = urlStatusList.filter(u => u.status === 'done' || u.status === 'error').length;
  const successCount = urlStatusList.filter(u => u.status === 'done').length;
  const failedCount = urlStatusList.filter(u => u.status === 'error').length;
  const totalContentImages = urlStatusList.reduce((s, u) => s + (u.contentCount || 0), 0);
  const totalDecorativeImages = urlStatusList.reduce((s, u) => s + (u.decorativeCount || 0), 0);

  return (
    <>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <PageFrame
      title="Image Alt Tag Audit"
      purpose="Paste the page addresses to check. It finds the images on each page, writes alt text and file names, and gives you a colour-coded spreadsheet."
      width="narrow"
    >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

        {/* ── Input Card ──────────────────────────────────────────────── */}
        <div style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg)',
          padding: 24,
          boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
        }}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
              Page URLs
            </label>
            <p style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 8 }}>
              One URL per line. Paste directly or upload a .txt / .csv file.
            </p>
            <textarea
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              disabled={running}
              rows={6}
              placeholder={`https://www.example.com/locations/city-name\nhttps://www.example.com/locations/another-city\nhttps://www.example.com/about-us`}
              style={{
                width: '100%',
                padding: '10px 16px',
                borderRadius: 'var(--r-lg)',
                border: '1px solid var(--border)',
                fontSize: 13,
                color: 'var(--text)',
                fontFamily: 'var(--font-mono)',
                background: running ? 'var(--surface)' : 'var(--card)',
                resize: 'none',
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {urlCount > 0 ? (
                  <span style={{ fontWeight: 600, color: 'var(--primary)' }}>
                    {urlCount} URL{urlCount !== 1 ? 's' : ''} ready
                  </span>
                ) : 'No URLs entered yet'}
              </span>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={running}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontSize: 12, fontWeight: 500,
                  padding: '6px 12px',
                  borderRadius: 'var(--r-lg)',
                  border: '1px solid var(--border)',
                  background: 'var(--card)',
                  color: 'var(--text)',
                  cursor: running ? 'not-allowed' : 'pointer',
                  opacity: running ? 0.5 : 1,
                }}
              >
                <svg style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
                Upload .txt / .csv
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv"
                style={{ display: 'none' }}
                onChange={handleFileUpload}
              />
            </div>
          </div>

          {/* Config toggle */}
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
            <button
              onClick={() => setShowConfig(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                fontSize: 12, fontWeight: 600,
                color: 'var(--text-2)',
                background: 'none', border: 'none', cursor: 'pointer', padding: 0,
              }}
            >
              <svg
                style={{
                  width: 14, height: 14,
                  transition: 'transform 0.2s',
                  transform: showConfig ? 'rotate(90deg)' : 'rotate(0deg)',
                }}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
              </svg>
              Configuration
              <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>(optional overrides)</span>
            </button>

            {showConfig && (
              <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                {CONFIG_FIELDS.map(({ key, label, placeholder, helper }) => (
                  <div key={key}>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>
                      {label}
                    </label>
                    <input
                      type="text"
                      value={config[key]}
                      onChange={e => handleConfigChange(key, e.target.value)}
                      disabled={running}
                      placeholder={placeholder}
                      style={{
                        width: '100%',
                        padding: '8px 12px',
                        borderRadius: 'var(--r-lg)',
                        border: '1px solid var(--border)',
                        fontSize: 12,
                        color: 'var(--text)',
                        fontFamily: 'var(--font-mono)',
                        background: running ? 'var(--surface)' : 'var(--card)',
                        outline: 'none',
                        boxSizing: 'border-box',
                      }}
                    />
                    {helper && (
                      <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, marginBottom: 0, lineHeight: 1.4 }}>
                        {helper}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div style={{ marginTop: 20, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={startAudit}
              disabled={!canStart}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 24px',
                borderRadius: 'var(--r-lg)',
                fontSize: 14, fontWeight: 600,
                color: '#fff',
                background: 'var(--primary)',
                border: 'none',
                cursor: !canStart ? 'not-allowed' : 'pointer',
                opacity: !canStart ? 0.5 : 1,
                transition: 'opacity 0.2s',
              }}
            >
              {running ? (
                <>
                  <svg style={{ width: 16, height: 16, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none">
                    <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Running audit…
                </>
              ) : 'Run Audit'}
            </button>
            {started && !running && (
              <button
                onClick={reset}
                style={{
                  fontSize: 14, color: 'var(--text-2)',
                  background: 'none', border: 'none', cursor: 'pointer',
                  textDecoration: 'underline', padding: 0,
                }}
              >
                Reset
              </button>
            )}
          </div>
        </div>

        {/* ── Error ───────────────────────────────────────────────────── */}
        {error && (
          <div style={{
            padding: 16,
            background: 'var(--danger-soft)',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--r-lg)',
            display: 'flex', alignItems: 'flex-start', gap: 12,
          }}>
            <span style={{ color: 'var(--danger)', marginTop: 2, flexShrink: 0 }}>✕</span>
            <p style={{ color: 'var(--danger)', fontSize: 14, fontWeight: 500, flex: 1, margin: 0 }}>{error}</p>
            <button
              onClick={startAudit}
              disabled={!urlCount}
              style={{
                flexShrink: 0, fontSize: 12, fontWeight: 600,
                padding: '6px 12px',
                borderRadius: 'var(--r-lg)',
                color: '#fff',
                background: 'var(--primary)',
                border: 'none',
                cursor: !urlCount ? 'not-allowed' : 'pointer',
                opacity: !urlCount ? 0.5 : 1,
              }}
            >
              Retry
            </button>
          </div>
        )}

        {/* ── Progress ─────────────────────────────────────────────────── */}
        {started && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {STEPS.map(stepCfg => {
              const s = steps[stepCfg.id] || {};
              const isActive = s.status === 'active';
              return (
                <div
                  key={stepCfg.id}
                  style={{
                    background: 'var(--card)',
                    border: `1px solid ${isActive ? 'var(--primary)' : 'var(--border)'}`,
                    borderRadius: 'var(--r-lg)',
                    overflow: 'hidden',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.07)',
                    transition: 'border-color 0.2s',
                  }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '14px 20px',
                    background: isActive ? 'var(--primary-soft)' : 'var(--surface)',
                  }}>
                    <StepBadge status={s.status} />
                    <span style={{ fontSize: 18 }}>{stepCfg.icon}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{stepCfg.label}</span>
                        {isActive && (
                          <span style={{
                            fontSize: 11, padding: '2px 8px', borderRadius: 999,
                            fontWeight: 500,
                            background: 'var(--primary-soft)', color: 'var(--primary)',
                            animation: 'pulse 2s cubic-bezier(0.4,0,0.6,1) infinite',
                          }}>
                            In progress
                          </span>
                        )}
                        {s.status === 'done' && (
                          <span style={{
                            fontSize: 11, padding: '2px 8px', borderRadius: 999,
                            fontWeight: 500,
                            background: 'var(--surface)', color: 'var(--text-2)',
                          }}>Done</span>
                        )}
                      </div>
                      {s.message && (
                        <p style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2, marginBottom: 0 }}>{s.message}</p>
                      )}
                    </div>
                  </div>

                  {/* Per-URL grid (scrape step only) */}
                  {stepCfg.id === 'scrape' && urlStatusList.length > 0 && (
                    <div style={{
                      padding: '16px 20px',
                      display: 'grid',
                      gridTemplateColumns: 'repeat(2, 1fr)',
                      gap: 6,
                    }}>
                      {urlStatusList.map((u, idx) => (
                        <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 }}>
                          <div style={{ marginTop: 2 }}><UrlStatusIcon status={u.status} /></div>
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <span style={{
                              display: 'block',
                              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              color: u.status === 'error' ? 'var(--danger)' : 'var(--text-2)',
                            }}>
                              {(() => { try { return new URL(u.url).pathname.replace(/\/$/, '').split('/').pop() || new URL(u.url).hostname; } catch { return u.url; } })()}
                            </span>
                            {u.status === 'done' && u.locationName && (
                              <span style={{ color: 'var(--text-3)' }}>
                                {u.locationName} · {u.contentCount} content, {u.decorativeCount} decorative
                              </span>
                            )}
                            {u.status === 'error' && u.error && (
                              <span style={{ color: 'var(--danger)', opacity: 0.7 }}>{u.error.substring(0, 60)}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Summary stats (shown once scraping is underway) ──────────── */}
        {doneCount > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {[
              { label: 'Pages processed', value: `${doneCount} / ${urlStatusList.length}`, color: 'var(--primary)' },
              { label: 'Successful',       value: successCount,                             color: 'var(--success)' },
              { label: 'Failed',           value: failedCount,                              color: failedCount > 0 ? 'var(--danger)' : 'var(--text-3)' },
              { label: 'Content images',   value: totalContentImages,                       color: 'var(--primary)' },
            ].map(stat => (
              <div key={stat.label} style={{
                background: 'var(--card)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-lg)',
                padding: '12px 16px',
                boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
              }}>
                <p style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500, margin: 0 }}>{stat.label}</p>
                <p style={{
                  fontSize: 22, fontWeight: 700, marginTop: 2, marginBottom: 0,
                  color: stat.color,
                  fontFamily: 'var(--font-mono)',
                }}>{stat.value}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── Download ─────────────────────────────────────────────────── */}
        {download && (
          <div style={{
            background: 'var(--card)',
            border: '1px solid var(--primary)',
            borderRadius: 'var(--r-lg)',
            padding: 20,
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            boxShadow: '0 1px 3px rgba(61,170,142,0.15)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 40, height: 40, borderRadius: 8,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--primary-soft)',
              }}>
                <svg style={{ width: 20, height: 20, color: 'var(--primary)' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25zM6.75 12h.008v.008H6.75V12zm0 3h.008v.008H6.75V15zm0 3h.008v.008H6.75V18z" />
                </svg>
              </div>
              <div>
                <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', margin: 0 }}>Audit complete</p>
                <p style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2, marginBottom: 0 }}>{download.filename}</p>
              </div>
            </div>
            <button
              onClick={handleDownload}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 20px',
                borderRadius: 'var(--r-lg)',
                fontSize: 14, fontWeight: 600,
                color: '#fff',
                background: 'var(--primary)',
                border: 'none',
                cursor: 'pointer',
                transition: 'opacity 0.2s',
              }}
            >
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
              </svg>
              Download .xlsx
            </button>
          </div>
        )}

        {/* ── Legend ──────────────────────────────────────────────────── */}
        {started && (
          <div style={{
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-lg)',
            padding: '16px 20px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
          }}>
            <p style={{
              fontSize: 11, fontWeight: 600, color: 'var(--text-2)',
              textTransform: 'uppercase', letterSpacing: '0.06em',
              marginBottom: 8, marginTop: 0,
            }}>Excel row colours</p>
            <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, lineHeight: 1.5 }}>
              In the “Content Images” sheet, rows are grouped by an <strong>Image Type</strong> category that is
              inferred by AI from each image’s content and page context. Categories vary by site, and each distinct
              category is assigned its own row colour automatically.
            </p>
          </div>
        )}

        <ModuleRuns toolId="image-alt-audit" />
      </div>
    </PageFrame>
    </>
  );
}
