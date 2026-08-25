import { useState } from 'react';
import OnPageReport from './OnPageReport';

const CARD = {
  background: 'var(--card)', border: '1px solid var(--border)',
  borderRadius: 'var(--r-lg)', padding: 20,
};

// Optional keyword refinement. The audit runs without a keyword — the six keyword-placement
// checks just report N/A — so this is framed as sharpening an existing result, not as a
// prerequisite. Re-running with a keyword turns those N/A rows into real pass/warn/fail.
function KeywordRefine({ ctl, compact }) {
  const [keyword, setKeyword] = useState('');
  const used = ctl.keywordsUsed || [];
  const submit = () => { if (keyword.trim()) ctl.run([keyword]); };

  if (used.length > 0) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 8, padding: '10px 14px', marginBottom: compact ? 16 : 0,
      }}>
        <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
          Scored against keyword{used.length > 1 ? 's' : ''}:{' '}
          <strong style={{ color: 'var(--text)' }}>{used.join(', ')}</strong>
        </span>
        <input
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="Try a different keyword"
          style={{
            fontSize: 12, padding: '5px 9px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--card)',
            color: 'var(--text)', width: 190, marginLeft: 'auto',
          }}
        />
        <button onClick={submit} disabled={!keyword.trim()} style={{
          fontSize: 12, fontWeight: 600, padding: '6px 12px', borderRadius: 6, border: 'none',
          color: '#fff', background: keyword.trim() ? 'var(--primary)' : 'var(--border)',
          cursor: keyword.trim() ? 'pointer' : 'not-allowed',
        }}>Re-score</button>
      </div>
    );
  }

  return (
    <div style={{
      background: 'var(--info-soft)', border: '1px solid var(--info)',
      borderRadius: 8, padding: '12px 16px', marginBottom: compact ? 16 : 0,
    }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--info)', marginBottom: 4 }}>
        Improve this analysis — add a primary keyword
      </p>
      <p style={{ fontSize: 12, color: 'var(--info)', lineHeight: 1.5, marginBottom: 10 }}>
        Optional. Six checks score keyword placement across the title, H1, meta description,
        URL slug, body copy and alt text. They are marked N/A until you supply a target term.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()}
          placeholder="e.g. root canal brighton ma"
          style={{
            flex: 1, minWidth: 200, fontSize: 13, padding: '7px 11px', borderRadius: 6,
            border: '1px solid var(--border)', background: 'var(--card)', color: 'var(--text)',
          }}
        />
        <button onClick={submit} disabled={!keyword.trim()} style={{
          fontSize: 13, fontWeight: 600, padding: '7px 16px', borderRadius: 6, border: 'none',
          color: '#fff', background: keyword.trim() ? 'var(--primary)' : 'var(--border)',
          cursor: keyword.trim() ? 'pointer' : 'not-allowed',
        }}>Re-score with keyword</button>
      </div>
    </div>
  );
}

// The On-Page SEO Audit surfaced as a tab inside the SEO & GEO Audit. Runs the real
// /api/on-page-audit job and renders the same report component as the standalone tool, so
// the two can never disagree.
export default function OnPageTabPanel({ ctl, url }) {
  if (!url) {
    return (
      <div style={{ ...CARD, maxWidth: 620 }}>
        <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>On-Page SEO Audit</p>
        <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>
          This audit ran on pasted HTML. The On-Page audit needs a live URL — it fetches the
          page itself for PageSpeed Insights, the redirect chain and sitemap membership.
          Re-run against a URL to use it.
        </p>
      </div>
    );
  }

  if (ctl.status === 'running') {
    return (
      <div style={{ ...CARD, textAlign: 'center', padding: '48px 20px' }}>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        <div style={{
          width: 40, height: 40, borderRadius: '50%', margin: '0 auto 20px',
          border: '4px solid var(--primary-soft)', borderTopColor: 'var(--primary)',
          animation: 'spin 0.8s linear infinite',
        }} />
        <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>Running On-Page audit…</p>
        <p style={{ fontSize: 13, color: 'var(--text-2)' }}>{ctl.progress || 'Initializing…'}</p>
        <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 10 }}>
          PageSpeed Insights runs mobile and desktop — this usually takes 30–60 seconds.
        </p>
      </div>
    );
  }

  if (ctl.status === 'error') {
    return (
      <div style={{ ...CARD, maxWidth: 620 }}>
        <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--danger)', marginBottom: 6 }}>On-Page audit failed</p>
        <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 14 }}>{ctl.error}</p>
        <button onClick={() => ctl.run(ctl.keywordsUsed)} style={{
          fontSize: 14, fontWeight: 600, padding: '9px 18px', borderRadius: 8,
          border: 'none', color: '#fff', background: 'var(--primary)', cursor: 'pointer',
        }}>Retry</button>
      </div>
    );
  }

  if (ctl.status === 'done' && ctl.audit) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <p style={{ fontSize: 12, color: 'var(--text-3)' }}>
            On-Page SEO Audit · 23 sections · live page data + PageSpeed Insights
          </p>
          <button onClick={() => ctl.run(ctl.keywordsUsed)} style={{
            fontSize: 13, padding: '6px 14px', borderRadius: 8, fontWeight: 500,
            color: 'var(--text)', background: 'var(--surface)',
            border: '1px solid var(--border)', cursor: 'pointer', flexShrink: 0,
          }}>Re-run</button>
        </div>
        <KeywordRefine ctl={ctl} compact />
        {ctl.error && (
          <div style={{
            background: 'var(--warning-soft)', border: '1px solid var(--warning)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 12, color: 'var(--warning)',
          }}>
            Completed with warnings: {ctl.error}
          </div>
        )}
        <OnPageReport audit={ctl.audit} />
      </div>
    );
  }

  // idle — the auto-start has not fired yet (or was reset)
  return (
    <div style={{ ...CARD, maxWidth: 620 }}>
      <p style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 6 }}>On-Page SEO Audit</p>
      <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 14 }}>
        Runs the full 23-section on-page audit against this URL, adding what the SEO &amp; GEO
        checks do not cover: PageSpeed Insights performance and Core Web Vitals for mobile and
        desktop, the full redirect chain, HTTP→HTTPS behaviour, whether the URL is listed in
        your sitemap, and analytics/tracking detection.
      </p>
      <button onClick={() => ctl.run([])} style={{
        fontSize: 14, fontWeight: 600, padding: '10px 20px', borderRadius: 8,
        border: 'none', color: '#fff', background: 'var(--primary)', cursor: 'pointer',
      }}>Run On-Page Audit</button>
    </div>
  );
}
