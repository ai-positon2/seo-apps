// Where a Keyword Research run starts.
//
// full    — the standalone page: a typed seed keyword, the two intent cards,
//           Start Research and Reset.
// compact — inside Content Architect: no seed input. The seed is derived from
//           the topic on the server when "Generate keywords" is clicked, and is
//           shown read-only once known. Intent is a small switch.

import { Spinner, cardShadow } from './shared';

const INTENTS = [
  { value: 'commercial',    label: 'Commercial / Transactional', short: 'Commercial',    desc: 'Service pages, pricing, booking' },
  { value: 'informational', label: 'Informational / Educational', short: 'Informational', desc: 'Guides, FAQs, how-to content' },
];

export default function KrInputBar({ density = 'full', ...props }) {
  return density === 'compact' ? <CompactInputBar {...props} /> : <FullInputBar {...props} />;
}

function FullInputBar({ kr }) {
  const { state } = kr;
  const { running, started, intent, keyword } = state;
  const canStart = keyword.trim() && !running;

  return (
    <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 'var(--r-lg)', padding: 24, boxShadow: cardShadow }}>
      <div style={{ maxWidth: 448 }}>
        <label htmlFor="kr-seed-keyword" style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>
          Seed Keyword
        </label>
        <input
          id="kr-seed-keyword"
          type="text"
          value={keyword}
          onChange={(e) => kr.setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && canStart && kr.start()}
          placeholder="e.g. dental implants"
          disabled={running}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '10px 16px', borderRadius: 8,
            border: '1px solid var(--border)', fontSize: 14, color: 'var(--text)',
            background: running ? 'var(--surface)' : 'var(--card)', outline: 'none', transition: 'border-color 0.15s',
          }}
          onFocus={(e) => { e.target.style.borderColor = 'var(--primary)'; e.target.style.boxShadow = '0 0 0 2px var(--primary-soft)'; }}
          onBlur={(e) => { e.target.style.borderColor = 'var(--border)'; e.target.style.boxShadow = 'none'; }}
        />
      </div>

      <div style={{ marginTop: 16 }}>
        <label style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
          Page Intent
        </label>
        <div style={{ display: 'flex', gap: 12 }}>
          {INTENTS.map((opt) => {
            const isSelected = intent === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={running}
                onClick={() => kr.setIntent(opt.value)}
                style={{
                  flex: 1, textAlign: 'left', padding: '12px 16px', borderRadius: 8,
                  // --primary, as the compact switch below uses: --nav-bg-top is
                  // near-white in light theme, so the selected card read as disabled.
                  border: `2px solid ${isSelected ? 'var(--primary)' : 'var(--border)'}`,
                  background: isSelected ? 'var(--primary)' : 'var(--card)',
                  cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.5 : 1, transition: 'all 0.15s',
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: isSelected ? 'var(--text-on-primary)' : 'var(--text)' }}>{opt.label}</div>
                <div style={{ fontSize: 12, marginTop: 2, color: isSelected ? 'var(--text-on-primary)' : 'var(--text-2)', opacity: isSelected ? 0.75 : 1 }}>{opt.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={() => kr.start()}
          disabled={!canStart}
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '10px 24px', borderRadius: 8,
            fontSize: 14, fontWeight: 600, color: 'var(--text-on-primary)', background: 'var(--primary)', border: 'none',
            cursor: canStart ? 'pointer' : 'not-allowed', opacity: canStart ? 1 : 0.5, transition: 'opacity 0.15s',
          }}
        >
          {running ? <><Spinner /> Running…</> : 'Start Research'}
        </button>
        {started && !running && (
          <button
            onClick={kr.reset}
            style={{ fontSize: 14, color: 'var(--text-2)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * @param {object} props
 * @param {object} props.kr         useKeywordResearch()
 * @param {() => void} props.onGenerate
 * @param {React.ReactNode} [props.aside]  right-aligned extras (saved time, view run)
 */
function CompactInputBar({ kr, onGenerate, aside }) {
  const { running, started, intent, seed, keyword, result } = kr.state;
  const seedLabel = seed?.keyword || (started ? keyword : '');

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={onGenerate}
        disabled={running}
        title={result ? 'Run keyword research again for this topic' : 'Derive a seed keyword from this topic and research it'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 12, fontWeight: 600, padding: '5px 12px', borderRadius: 7,
          border: '1px solid var(--primary)',
          background: running ? 'var(--surface)' : result ? 'transparent' : 'var(--primary)',
          color: running ? 'var(--text-3)' : result ? 'var(--primary-text)' : 'var(--text-on-primary)',
          cursor: running ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
        }}
      >
        {running ? <><Spinner size={12} color="var(--primary)" /> Generating…</> : result ? 'Re-generate' : 'Generate keywords'}
      </button>

      <div role="radiogroup" aria-label="Page intent" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 7, overflow: 'hidden' }}>
        {INTENTS.map((opt) => {
          const on = intent === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={running}
              onClick={() => kr.setIntent(opt.value)}
              title={opt.desc}
              style={{
                fontSize: 11, fontWeight: 600, padding: '4px 9px', border: 'none',
                background: on ? 'var(--primary)' : 'var(--card)', color: on ? 'var(--text-on-primary)' : 'var(--text-2)',
                cursor: running ? 'not-allowed' : 'pointer', opacity: running && !on ? 0.5 : 1,
              }}
            >
              {opt.short}
            </button>
          );
        })}
      </div>

      {seedLabel && (
        <span
          title={seed?.fromTopic ? `Derived from the topic "${seed.fromTopic}"` : undefined}
          style={{ fontSize: 11.5, color: 'var(--text-2)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 99, padding: '3px 10px', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          Seed: <strong style={{ color: 'var(--text)', fontWeight: 600 }}>{seedLabel}</strong>
        </span>
      )}

      {aside && <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8 }}>{aside}</span>}
    </div>
  );
}
