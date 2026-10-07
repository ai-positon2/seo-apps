import { useMemo, useState } from 'react';
import {
  Panel, PanelTitle, Eyebrow, FilterPill, TableFrame, Th, sevTone, bandColor,
} from './reportKit';
import { resolveBreakdown } from '../primitives';

// ── Issues ──────────────────────────────────────────────────────────────────
//
// Three blocks, in the order the design puts them: where the points went, what
// is wrong, and every check that ran.
//
// This replaced a three-tab panel — By Severity / By Category / All Checks —
// which asked the reader to pick a grouping before seeing anything. "By
// Category" is the one that went: twenty-one collapsible category cards, each
// holding the AI's issues for that category and then all of its raw checks, is
// the same content as the two blocks that remain, cut a third way. The bucket
// table above the list does the job that grouping was reaching for, and does it
// in nine rows with the points attached.

const UNSCORED = new Set(['skipped', 'na', 'informational']);

export default function IssuesPanel({ findings, ai }) {
  const [sevFilter, setSevFilter] = useState('all');
  const [openId, setOpenId] = useState(null);

  const breakdown = resolveBreakdown(findings?.scores);

  // The AI's issues, flattened out of their category sections. Each section
  // carries the category and the issues found in it.
  const issues = useMemo(() => (ai?.sections || []).flatMap(
    (s) => (s.issues || []).map((i, n) => ({
      ...i,
      category: s.category,
      // The model does not always return an id, and two issues in one category
      // can share a title, so the accordion key is composed rather than trusted.
      key: `${s.category}:${i.id || i.issue || n}`,
    })),
  ), [ai]);

  const counts = useMemo(() => ({
    all: issues.length,
    error: issues.filter((i) => i.severity === 'error').length,
    warning: issues.filter((i) => i.severity === 'warning').length,
    notice: issues.filter((i) => i.severity === 'notice').length,
  }), [issues]);

  const shown = sevFilter === 'all' ? issues : issues.filter((i) => i.severity === sevFilter);

  const checks = findings?.checks || [];
  const scoredChecks = checks.filter((c) => !UNSCORED.has(c.status));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── Where the points went ─────────────────────────────────────────
          The server already sorts the breakdown worst-first by points lost, so
          this table is that order rather than a re-sort — the number in the
          third column IS the sort key, which is what makes the row order
          self-explanatory. */}
      {breakdown.length > 0 && (
        <Panel pad="22px 24px" style={{ gap: 12 }}>
          <PanelTitle>By bucket — worst first</PanelTitle>
          <TableFrame>
            <thead>
              <tr style={{ background: 'var(--surface)' }}>
                <Th>Bucket</Th>
                <Th align="right">Score</Th>
                <Th align="right">Points lost</Th>
                <Th>Checks</Th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((b) => {
                const st = b.statuses || {};
                const parts = [
                  st.errors ? `${st.errors} error${st.errors === 1 ? '' : 's'}` : null,
                  st.warning ? `${st.warning} warning${st.warning === 1 ? '' : 's'}` : null,
                  st.notice ? `${st.notice} notice${st.notice === 1 ? '' : 's'}` : null,
                  st.pass ? `${st.pass} passed` : null,
                ].filter(Boolean);
                return (
                  <tr key={b.key} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '10px 12px', color: 'var(--text)' }}>{b.label}</td>
                    <td
                      className="num"
                      style={{
                        padding: '10px 12px', textAlign: 'right', fontWeight: 600,
                        color: bandColor(b.score),
                      }}
                    >
                      {Number.isFinite(b.score) ? b.score : '—'}
                    </td>
                    <td className="num" style={{ padding: '10px 12px', textAlign: 'right', color: 'var(--text-2)' }}>
                      {Number.isFinite(b.points_lost) ? `−${b.points_lost}` : '—'}
                    </td>
                    <td style={{ padding: '10px 12px', color: 'var(--text-3)', fontSize: 12 }}>
                      {parts.length
                        ? parts.join(' · ')
                        : Number.isFinite(b.checks_scored)
                          ? `${b.checks_scored} scored`
                          : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
        </Panel>
      )}

      {/* ── What is wrong ─────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
          <PanelTitle>Issues by severity</PanelTitle>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['all', 'error', 'warning', 'notice'].map((f) => (
              <FilterPill key={f} active={sevFilter === f} onClick={() => setSevFilter(f)}>
                {f === 'all' ? `All (${counts.all})` : `${f[0].toUpperCase()}${f.slice(1)}s (${counts[f]})`}
              </FilterPill>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {shown.map((i) => (
            <IssueRow
              key={i.key}
              issue={i}
              open={openId === i.key}
              onToggle={() => setOpenId(openId === i.key ? null : i.key)}
            />
          ))}
          {!shown.length && (
            <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
              {issues.length
                ? 'No issue of this severity.'
                : ai
                  ? 'The AI analysis found no issues to report on this page.'
                  : 'The AI analysis did not complete, so there is no issue list. Every check that '
                    + 'ran is in the table below.'}
            </span>
          )}
        </div>
      </div>

      {/* ── Every check that ran ──────────────────────────────────────────── */}
      {checks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <PanelTitle>All checks — {checks.length} run</PanelTitle>
          <TableFrame>
            <thead>
              <tr style={{ background: 'var(--surface)' }}>
                <Th>ID</Th>
                <Th>Category</Th>
                <Th>Check</Th>
                <Th>Status</Th>
                <Th>Value</Th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => {
                const tone = sevTone(c.status);
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '9px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-3)', fontSize: 11.5 }}>
                      {c.id}
                    </td>
                    <td style={{ padding: '9px 12px', color: 'var(--text-2)' }}>{c.category || '—'}</td>
                    <td style={{ padding: '9px 12px', color: 'var(--text)' }}>{c.name || c.label || '—'}</td>
                    <td style={{ padding: '9px 12px', fontWeight: 600, color: tone.fg }}>{tone.label}</td>
                    <td
                      style={{
                        padding: '9px 12px', color: 'var(--text-3)', fontFamily: 'var(--font-mono)',
                        fontSize: 11.5, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={c.evidence || c.detail || undefined}
                    >
                      {c.evidence || c.detail || '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
          {/* The design says "full list in the downloadable Excel report" under a
              truncated table. This one is not truncated — every check is here —
              so it says what the numbers mean instead. */}
          <span style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
            {scoredChecks.length} of {checks.length} checks are scored. The rest are marked not
            applicable for this page’s intent, or informational, and are excluded from every score
            on this page.
          </span>
        </div>
      )}
    </div>
  );
}

function IssueRow({ issue, open, onToggle }) {
  const [hover, setHover] = useState(false);
  const tone = sevTone(issue.severity);
  return (
    <div style={{ borderRadius: 10, background: 'var(--card)', border: '1px solid var(--border)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        aria-expanded={open}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 12, padding: '13px 16px',
          border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)',
          background: hover ? 'var(--surface)' : 'transparent',
        }}
      >
        <span
          style={{
            flexShrink: 0, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 4,
            background: tone.bg, color: tone.fg,
          }}
        >
          {tone.label}
        </span>
        <span style={{ flex: 1, fontSize: 13, color: 'var(--text)', minWidth: 0 }}>{issue.issue}</span>
        <span style={{ flexShrink: 0, fontSize: 12, color: 'var(--text-3)' }}>{issue.category}</span>
        {issue.effort && (
          <span
            style={{
              flexShrink: 0, fontSize: 11.5, color: 'var(--text-2)', padding: '2px 8px',
              borderRadius: 4, background: 'var(--surface)',
            }}
          >
            {issue.effort}
          </span>
        )}
        <span style={{ color: 'var(--text-3)', fontSize: 10, flexShrink: 0 }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 16px 16px' }}>
          {issue.current_state && (
            <div>
              <Eyebrow>Current state</Eyebrow>
              <p
                style={{
                  margin: '4px 0 0', fontSize: 12.5, color: 'var(--text-2)',
                  fontFamily: 'var(--font-mono)', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {asText(issue.current_state)}
              </p>
            </div>
          )}
          {issue.impact && (
            <div>
              <Eyebrow>Impact</Eyebrow>
              <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
                {asText(issue.impact)}
              </p>
            </div>
          )}
          {issue.fix && (
            <div>
              <Eyebrow>Fix</Eyebrow>
              <p
                style={{
                  margin: '4px 0 0', fontSize: 13, color: 'var(--text)', lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {asText(issue.fix)}
              </p>
            </div>
          )}
          {/* Kept from the panel this replaces. The model returns it for the
              issues where a snippet is the fastest way to say what to change,
              and the design has a <pre> block for exactly this. */}
          {issue.code_example && (
            <pre
              style={{
                margin: 0, fontSize: 11.5, background: '#0F1416', color: '#DCEFE8',
                borderRadius: 8, padding: 12, overflowX: 'auto', whiteSpace: 'pre-wrap',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {asText(issue.code_example)}
            </pre>
          )}
          {issue.context_note && (
            <span style={{ fontSize: 11.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
              {asText(issue.context_note)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function asText(v) {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
  if (v && typeof v === 'object') return Object.values(v).join('\n');
  return v ?? '';
}
