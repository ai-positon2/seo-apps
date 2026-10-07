import { useState } from 'react';

function TypeBadge({ type }) {
  const map = {
    direct:        { bg: 'var(--danger-soft)',  color: 'var(--danger)',  label: 'Direct' },
    indirect:      { bg: 'var(--warning-soft)', color: 'var(--warning)', label: 'Indirect' },
    aggregator:    { bg: 'var(--info-soft)',     color: 'var(--info)',    label: 'Aggregator' },
    informational: { bg: 'var(--info-soft)',     color: 'var(--info)',    label: 'Informational' },
  };
  const style = map[type] || { bg: 'var(--surface)', color: 'var(--text-2)', label: type || 'Unknown' };
  return (
    <span style={{
      fontSize: 11, fontWeight: 500, padding: '2px 8px', borderRadius: 4,
      background: style.bg, color: style.color,
    }}>
      {style.label}
    </span>
  );
}

export default function CompetitorConfirmation({ competitors, gptSummary, onConfirm, loading }) {
  const [list, setList] = useState(competitors);
  const [addDomain, setAddDomain] = useState('');
  const [addError, setAddError] = useState('');
  const [addLoading, setAddLoading] = useState(false);

  function remove(domain) {
    setList(l => l.filter(c => c.domain !== domain));
  }

  async function addCompetitor() {
    const domain = addDomain.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase().trim();
    if (!domain) { setAddError('Enter a domain'); return; }
    if (list.find(c => c.domain === domain)) { setAddError('Already in list'); return; }

    setAddLoading(true);
    setAddError('');
    try {
      setList(l => [...l, {
        domain,
        authorityScore: 0,
        organicTraffic: 0,
        organicKeywords: 0,
        competitionLevel: 0,
        gptReasoning: 'Manually added by analyst.',
        competitorType: 'direct',
        gptStatus: 'keep',
      }]);
      setAddDomain('');
    } catch {
      setAddError('Failed to add domain');
    } finally {
      setAddLoading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* GPT Summary */}
      {gptSummary && (
        <div style={{ background: 'var(--info-soft)', border: '1px solid var(--info)', borderRadius: 'var(--r-lg)', padding: 16 }}>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--info)', marginBottom: 6, marginTop: 0 }}>AI Competitive Landscape Summary</p>
          <p style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.6, margin: 0 }}>{gptSummary}</p>
        </div>
      )}

      {/* Competitor cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {list.map(c => (
          <div key={c.domain} style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16, display: 'flex', gap: 16 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{c.domain}</span>
                <TypeBadge type={c.competitorType} />
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-2)', marginBottom: 8, flexWrap: 'wrap' }}>
                {c.authorityScore > 0 && <span>Authority: <b style={{ color: 'var(--text)' }}>{c.authorityScore}</b></span>}
                {c.organicTraffic > 0 && <span>Traffic: <b style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{c.organicTraffic.toLocaleString()}</b></span>}
                {c.organicKeywords > 0 && <span>Keywords: <b style={{ color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>{c.organicKeywords.toLocaleString()}</b></span>}
                {c.competitionLevel > 0 && <span>Competition: <b style={{ color: 'var(--text)' }}>{(c.competitionLevel * 100).toFixed(0)}%</b></span>}
              </div>
              {c.gptReasoning && (
                <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, fontStyle: 'italic', margin: 0 }}>"{c.gptReasoning}"</p>
              )}
            </div>
            <button
              onClick={() => remove(c.domain)}
              title="Remove"
              style={{
                flexShrink: 0, width: 28, height: 28, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer',
              }}
            >
              <svg style={{ width: 16, height: 16 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>

      {/* Add competitor */}
      <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 16 }}>
        <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8, marginTop: 0 }}>Add a Competitor Manually</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            placeholder="e.g. competitor.com"
            value={addDomain}
            onChange={e => { setAddDomain(e.target.value); setAddError(''); }}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCompetitor(); } }}
            style={{
              flex: 1, border: '1px solid var(--border)', borderRadius: 'var(--r-lg)',
              padding: '8px 12px', fontSize: 14, color: 'var(--text)', background: 'var(--card)', outline: 'none',
            }}
          />
          <button
            onClick={addCompetitor}
            disabled={addLoading}
            style={{
              padding: '8px 16px', background: 'var(--primary)', color: '#fff',
              fontSize: 14, fontWeight: 500, borderRadius: 'var(--r-lg)', border: 'none', cursor: 'pointer',
              opacity: addLoading ? 0.5 : 1,
            }}
          >
            Add
          </button>
        </div>
        {addError && <p style={{ fontSize: 12, color: 'var(--danger)', marginTop: 4 }}>{addError}</p>}
      </div>

      {/* Run button */}
      <div>
        {list.length < 3 && (
          <p style={{ fontSize: 12, color: 'var(--warning)', marginBottom: 8, textAlign: 'center' }}>
            Add at least 3 competitors to run the analysis.
          </p>
        )}
        <button
          onClick={() => onConfirm(list)}
          disabled={loading || list.length < 3}
          style={{
            width: '100%', padding: '12px 0', borderRadius: 'var(--r-lg)',
            fontSize: 14, fontWeight: 600, color: '#fff', border: 'none', cursor: 'pointer',
            background: 'var(--primary)', opacity: (loading || list.length < 3) ? 0.5 : 1,
            transition: 'opacity 0.15s',
          }}
        >
          {loading ? 'Starting Analysis…' : `Run Full Analysis (${list.length} competitor${list.length !== 1 ? 's' : ''})`}
        </button>
      </div>
    </div>
  );
}
