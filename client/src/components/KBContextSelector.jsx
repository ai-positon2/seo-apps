import { useState, useEffect, useCallback, memo } from 'react';
import { useActiveProject } from '../lib/useActiveProject';
import { matchClientSlug } from '../lib/clientMatch';

const CLIENTS = [
  { value: '', label: 'No client (generic)' },
  { value: 'gentle-dental', label: 'Gentle Dental' },
  { value: 'great-lakes', label: 'Great Lakes' },
  { value: 'riccobene', label: 'Riccobene' },
  { value: 'clear-behavioral-health', label: 'Clear Behavioral Health' },
  { value: 'neuro-wellness-spa', label: 'Neuro Wellness Spa' },
  { value: 'new-life-house', label: 'New Life House' },
];

const ChevronIcon = ({ open }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
    <path d="M19 9l-7 7-7-7" />
  </svg>
);

const CheckIcon = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 12.75l6 6 9-13.5" />
  </svg>
);

const BRAND_SLUGS = CLIENTS.map((c) => c.value).filter(Boolean);

function KBContextSelector({ module: moduleId, onChange, disabled }) {
  // The brand follows the header's client (docs/design-audit/02-plan-one-client.md).
  // It used to default to "No client (generic)" whatever the header said, so the
  // client had to be picked a second time. A hand-picked brand still works, for
  // brands not yet attached to a project, but it is an override, not the norm.
  const { project, loaded } = useActiveProject();
  const headerBrand = matchClientSlug(project, BRAND_SLUGS) || '';
  const [override, setOverride] = useState(null); // null = follow the header
  const [choosing, setChoosing] = useState(false);
  const client = override ?? headerBrand;
  const setClient = (value) => setOverride(value);
  useEffect(() => { setOverride(null); setChoosing(false); }, [project?.id]);
  const [feedbackKbIds, setFeedbackKbIds] = useState([]);
  const [kbData, setKbData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    if (!client) {
      setKbData(null);
      setFeedbackKbIds([]);
      onChange?.({ client: '', feedbackKbIds: [] });
      return;
    }
    setLoading(true);
    fetch(
      `/api/kb-context?client=${encodeURIComponent(client)}&module=${encodeURIComponent(moduleId)}`,
      { credentials: 'include' }
    )
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        setKbData(data);
        setFeedbackKbIds([]);
        onChange?.({ client, feedbackKbIds: [] });
      })
      .catch(() => setKbData(null))
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, moduleId]);

  useEffect(() => {
    if (!client) return;
    onChange?.({ client, feedbackKbIds });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedbackKbIds]);

  const toggleFeedback = useCallback((id) => {
    setFeedbackKbIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }, []);

  const summaryItems = [];
  const warnings = [];
  if (client && kbData && !loading) {
    if (kbData.brand) {
      summaryItems.push({ label: 'Brand', id: kbData.brand.id, hasContent: kbData.brand.hasContent });
      if (!kbData.brand.hasContent) warnings.push(`Brand KB "${kbData.brand.id}" has no content`);
    }
    if (kbData.industry) {
      summaryItems.push({ label: 'Industry', id: kbData.industry.id, hasContent: kbData.industry.hasContent });
      if (!kbData.industry.hasContent) warnings.push(`Industry KB "${kbData.industry.id}" has no content`);
    }
    for (const id of feedbackKbIds) {
      const fb = kbData.feedbackOptions?.find(f => f.id === id);
      if (fb) {
        summaryItems.push({ label: `Feedback: ${fb.label}`, id: fb.id, hasContent: fb.hasContent });
        if (!fb.hasContent) warnings.push(`Feedback KB "${fb.label}" has no content`);
      }
    }
  }

  const feedbackOptions = kbData?.feedbackOptions || [];
  const selectedCount = feedbackKbIds.length;

  const selectStyle = {
    fontSize: 12,
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-md)',
    padding: '5px 10px',
    background: 'var(--card)',
    color: 'var(--text)',
    outline: 'none',
    cursor: 'pointer',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {/* Selector row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px' }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', whiteSpace: 'nowrap' }}>Brand</label>
          {choosing ? (
            <select
              value={client}
              onChange={e => setClient(e.target.value)}
              disabled={disabled}
              style={{ ...selectStyle, opacity: disabled ? 0.5 : 1 }}
              aria-label="Brand notes to use"
            >
              {CLIENTS.map(c => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text)' }}>
              {!loaded ? 'Loading…'
                : client ? (CLIENTS.find((c) => c.value === client)?.label || client)
                  : `No brand notes for ${project?.name || 'this client'} yet`}
              {override === null && client && <span style={{ color: 'var(--text-3)' }}> · from the header</span>}
            </span>
          )}
          {!disabled && (
            <button
              type="button"
              onClick={() => setChoosing((v) => !v)}
              style={{ fontSize: 12, color: 'var(--primary-text)', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              {choosing ? 'Done' : 'Use a different brand'}
            </button>
          )}
        </div>

        {client && (
          <>
            {/* Industry (auto) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>Industry</span>
              {loading ? (
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>…</span>
              ) : kbData?.industry ? (
                <span style={{ fontSize: 12, padding: '2px 8px', borderRadius: 'var(--r-pill)', background: 'var(--surface)', color: 'var(--text)', fontWeight: 500 }}>
                  {kbData.industry.id}
                </span>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>not set</span>
              )}
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>(auto)</span>
            </div>

            {/* Feedback multi-select */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>Feedback</span>
              {loading ? (
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>…</span>
              ) : feedbackOptions.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>No feedback available</span>
              ) : (
                <div style={{ position: 'relative' }}>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => setFeedbackOpen(o => !o)}
                    style={{
                      ...selectStyle,
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                      minWidth: 130, cursor: disabled ? 'not-allowed' : 'pointer',
                      opacity: disabled ? 0.5 : 1,
                    }}
                  >
                    <span style={{ flex: 1, textAlign: 'left' }}>
                      {selectedCount === 0 ? 'None selected' : `${selectedCount} selected`}
                    </span>
                    <ChevronIcon open={feedbackOpen} />
                  </button>

                  {feedbackOpen && (
                    <div style={{
                      position: 'absolute', top: '100%', marginTop: 4, left: 0, zIndex: 20,
                      background: 'var(--card)', border: '1px solid var(--border)',
                      borderRadius: 'var(--r-md)', boxShadow: 'var(--shadow-md)',
                      minWidth: 200, paddingTop: 4, paddingBottom: 4,
                    }}>
                      {feedbackOptions.map(f => (
                        <label key={f.id} style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '8px 12px', cursor: 'pointer',
                        }}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--surface)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                        >
                          {/* Custom checkbox */}
                          <span style={{
                            width: 14, height: 14, borderRadius: 3,
                            border: feedbackKbIds.includes(f.id) ? '2px solid var(--primary)' : '1.5px solid var(--border)',
                            background: feedbackKbIds.includes(f.id) ? 'var(--primary)' : 'var(--card)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: '#fff', flexShrink: 0,
                          }}>
                            {feedbackKbIds.includes(f.id) && <CheckIcon />}
                          </span>
                          <input
                            type="checkbox"
                            checked={feedbackKbIds.includes(f.id)}
                            onChange={() => toggleFeedback(f.id)}
                            style={{ display: 'none' }}
                          />
                          <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500 }}>{f.label}</span>
                          {!f.hasContent && (
                            <span style={{ fontSize: 10, color: 'var(--warning)', marginLeft: 'auto' }}>empty</span>
                          )}
                        </label>
                      ))}
                      <div style={{ borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4, paddingLeft: 12, paddingBottom: 4 }}>
                        <button
                          type="button"
                          onClick={() => setFeedbackOpen(false)}
                          style={{ fontSize: 11, color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer' }}
                        >
                          Close
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Context summary */}
      {client && !loading && summaryItems.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6,
          padding: '8px 12px', borderRadius: 'var(--r-md)',
          background: 'var(--card)', border: '1px solid var(--border)', fontSize: 12,
        }}>
          <span style={{ color: 'var(--text-3)', fontWeight: 500, marginRight: 2 }}>Context injected:</span>
          {summaryItems.map(item => (
            <span key={item.id} style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px', borderRadius: 'var(--r-pill)', fontWeight: 500,
              background: item.hasContent ? 'var(--success-soft)' : 'var(--danger-soft)',
              color: item.hasContent ? 'var(--success)' : 'var(--danger)',
            }}>
              {item.hasContent ? '✓' : '⚠'} {item.label}: {item.id}
            </span>
          ))}
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 8,
          padding: '8px 12px', borderRadius: 'var(--r-md)',
          background: 'var(--warning-soft)', border: '1px solid var(--warning)', fontSize: 12,
        }}>
          <span style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }}>⚠</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {warnings.map((w, i) => (
              <p key={i} style={{ margin: 0, color: 'var(--text)' }}>
                {w} —{' '}
                <a href="/kb" style={{ color: 'var(--primary-text)', textDecoration: 'underline' }}>edit in KB</a>
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(KBContextSelector);
