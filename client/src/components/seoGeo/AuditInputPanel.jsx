import { StepBar } from './primitives';

const inputStyle = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: '8px 12px',
  fontSize: 14,
  background: 'var(--card)',
  color: 'var(--text)',
  outline: 'none',
};

const CAPTION = {
  fontSize: 11, fontWeight: 600, color: 'var(--text-3)',
  textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8,
};

// Segmented control shared by the input-type and page-intent toggles.
function segStyle(active) {
  return {
    padding: '6px 16px', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer',
    border: active ? '1px solid var(--primary)' : '1px solid var(--border)',
    color: active ? 'var(--primary)' : 'var(--text-2)',
    background: active ? 'var(--primary-soft)' : 'var(--card)',
    transition: 'all 150ms',
  };
}

export default function AuditInputPanel({ ctl, title, subtitle, ctaLabel = 'Audit', ctaLabelHtml = 'Audit HTML' }) {
  const {
    inputType, setInputType, urlInput, setUrlInput, htmlInput, setHtmlInput,
    keyword1, setKeyword1, keyword2, setKeyword2,
    pageIntent, setPageIntent, running, steps, error, runAudit,
  } = ctl;

  return (
    <div style={{ background: 'var(--card)', borderRadius: 'var(--r-lg)', border: '1px solid var(--border)', padding: 24, boxShadow: '0 1px 3px rgba(0,0,0,0.07)' }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>{title}</h1>
      <p style={{ fontSize: 14, color: 'var(--text-2)', marginBottom: 20 }}>{subtitle}</p>

      {/* Primary Keywords */}
      <div style={{ marginBottom: 16 }}>
        <p style={CAPTION}>Primary Keywords (optional)</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={keyword1}
            onChange={e => setKeyword1(e.target.value)}
            placeholder="e.g. dentist brockton ma"
            style={{ ...inputStyle, flex: 1 }}
            onFocus={e => e.target.style.boxShadow = '0 0 0 2px var(--primary)'}
            onBlur={e => e.target.style.boxShadow = 'none'}
          />
          <input
            type="text"
            value={keyword2}
            onChange={e => setKeyword2(e.target.value)}
            placeholder="Secondary keyword (optional)"
            style={{ ...inputStyle, flex: 1 }}
            onFocus={e => e.target.style.boxShadow = '0 0 0 2px var(--primary)'}
            onBlur={e => e.target.style.boxShadow = 'none'}
          />
        </div>
      </div>

      {/* Page intent */}
      <div style={{ marginBottom: 16 }}>
        <p style={CAPTION}>Page Intent</p>
        <div style={{ display: 'flex', gap: 8 }}>
          {[['auto', 'Auto-detect'], ['commercial', 'Commercial'], ['informational', 'Informational']].map(([v, l]) => (
            <button key={v} onClick={() => setPageIntent(v)} style={segStyle(pageIntent === v)}>
              {l}
            </button>
          ))}
        </div>
        <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
          Commercial pages (location, service, product) are not scored on citations, statistics or quotations.
        </p>
      </div>

      {/* URL / HTML toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        {[['url', 'URL'], ['html', 'Paste HTML']].map(([t, l]) => (
          <button key={t} onClick={() => setInputType(t)} style={segStyle(inputType === t)}>
            {l}
          </button>
        ))}
      </div>

      {inputType === 'url' ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="url"
            value={urlInput}
            onChange={e => setUrlInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !running && urlInput.trim() && runAudit()}
            placeholder="https://example.com/page"
            style={{ ...inputStyle, flex: 1 }}
            onFocus={e => e.target.style.boxShadow = '0 0 0 2px var(--primary)'}
            onBlur={e => e.target.style.boxShadow = 'none'}
          />
          <button
            onClick={runAudit}
            disabled={running || !urlInput.trim()}
            style={{
              padding: '8px 20px', borderRadius: 8, fontSize: 14, fontWeight: 600,
              color: '#fff', background: 'var(--primary)', border: 'none', cursor: 'pointer',
              opacity: (running || !urlInput.trim()) ? 0.5 : 1, transition: 'opacity 150ms',
            }}
          >
            {running ? 'Running…' : ctaLabel}
          </button>
        </div>
      ) : (
        <div>
          <textarea
            value={htmlInput}
            onChange={e => setHtmlInput(e.target.value)}
            placeholder="Paste raw HTML here…"
            rows={8}
            style={{ ...inputStyle, width: '100%', fontFamily: 'var(--font-mono)', resize: 'none', boxSizing: 'border-box' }}
            onFocus={e => e.target.style.boxShadow = '0 0 0 2px var(--primary)'}
            onBlur={e => e.target.style.boxShadow = 'none'}
          />
          <button
            onClick={runAudit}
            disabled={running || !htmlInput.trim()}
            style={{
              marginTop: 8, width: '100%', padding: '8px 0', borderRadius: 8,
              fontSize: 14, fontWeight: 600, color: '#fff', background: 'var(--primary)',
              border: 'none', cursor: 'pointer',
              opacity: (running || !htmlInput.trim()) ? 0.5 : 1, transition: 'opacity 150ms',
            }}
          >
            {running ? 'Running…' : ctaLabelHtml}
          </button>
        </div>
      )}

      {error && (
        <p style={{ marginTop: 12, fontSize: 14, color: 'var(--danger)', background: 'var(--danger-soft)', borderRadius: 8, padding: '8px 12px' }}>{error}</p>
      )}

      {running && (
        <div style={{ marginTop: 20, padding: 16, background: 'var(--surface)', borderRadius: 8 }}>
          <StepBar steps={steps} />
        </div>
      )}
    </div>
  );
}
