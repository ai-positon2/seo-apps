import { useMemo, useState } from 'react';
import {
  Panel, Tile, Eyebrow, Chip, Pill, BackLink, OutlineButton, RuledHead,
  TableFrame, Th, Pager, SearchField, sevOf, REVIEW_TONE,
} from './reportPrimitives';
import { REVIEW_STATUSES } from '../crawlHelpers';

// ── One problem's own page ──────────────────────────────────────────────────
//
// What the check looks for, what to do about it, and every page it fired on —
// with the review decision editable in the row. This is where the separate
// "Issue review" screen went: it was a second full page listing the same
// findings with the same four statuses, reachable by a button next to the
// report, and the two disagreed about what a finding count meant often enough
// that people asked which one was right. There is now one place to read a
// finding and one place to triage it, and they are the same place.
//
// The review decision is saved as it is made, not batched behind a Save button:
// triage is a long session over hundreds of rows and losing an hour of it to a
// closed tab is not a risk worth designing in.

const PAGE_SIZE = 25;

/**
 * @param {object}   props
 * @param {object}   props.group          the rollup row that was opened:
 *   { id, label, severity, category, scope, count, pages }
 * @param {object?}  props.entry          its catalog entry
 * @param {Array}    props.findings       this rule's instances, sliced from the
 *   run's finding set — which arrives with the page, so there is no per-issue
 *   load to fail
 * @param {Map}      props.titleByUrl     url → page title, for the row's second line
 * @param {object}   props.metrics        for the health-cost tile's denominator
 * @param {Array}    props.breakdown      healthScoreBreakdown(metrics)
 * @param {object?}  props.next           the next issue group, for the footer band
 * @param {string}   props.backLabel
 * @param {Function} props.onBack
 * @param {Function} props.onOpenNext
 * @param {Function} props.onReview       (findingId, reviewStatus) => void
 * @param {Function} props.onExport       exports the listed URLs as CSV
 */
export default function IssueDetail({
  group, entry, findings, titleByUrl, metrics, breakdown = [],
  next, backLabel, onBack, onOpenNext, onReview, onExport,
}) {
  const [review, setReview] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const s = sevOf(group.severity);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return findings.filter((f) => {
      if (review !== 'all' && (f.reviewStatus || 'Needs review') !== review) return false;
      if (!q) return true;
      return (f.url || '').toLowerCase().includes(q)
        || String(f.detail || f.detectedValue || '').toLowerCase().includes(q);
    });
  }, [findings, review, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pageCount);
  const start = (current - 1) * PAGE_SIZE;
  const shown = filtered.slice(start, start + PAGE_SIZE);

  const triaged = findings.filter((f) => (f.reviewStatus || 'Needs review') !== 'Needs review').length;

  // The band's deduction, not this issue's own. There is no per-rule figure to
  // report: the score counts each affected PAGE once per severity band, so a
  // page carrying three warnings costs the same as a page carrying one. Saying
  // "−5, shared across this band" is the truth; splitting the band's points
  // between the rules in it would be a number the formula never computed.
  const band = (breakdown || []).find((b) => b.label === BAND_LABEL[group.severity]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <BackLink onClick={onBack}>{backLabel}</BackLink>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 320, flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Chip bg={s.chipBg} fg={s.chipFg}>{s.label}</Chip>
              {entry?.priority && <Chip>{entry.priority}</Chip>}
              {entry?.category && <Chip>{entry.category}</Chip>}
            </div>
            <h1
              style={{
                margin: 0, fontSize: 30, fontWeight: 500, letterSpacing: '-0.02em',
                color: 'var(--text)', lineHeight: 1.15,
              }}
            >
              {entry?.title || group.label || group.id}
            </h1>
            <span style={{ fontSize: 13.5, color: 'var(--text-3)' }}>
              {/* Both figures from the group, which is derived once for the
                  whole run — `pages` is distinct affected pages and `count` is
                  occurrences, and one page can trip the same check twice. */}
              Found on {group.pages} of {metrics.htmlCount} HTML page
              {metrics.htmlCount === 1 ? '' : 's'} · the rule fired {group.count} time
              {group.count === 1 ? '' : 's'} in this crawl
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {/* "Assign to the team" sat here in the design. There is no
                assignment feature anywhere in the app, so it is not drawn — a
                button that does nothing is worse than one absence. */}
            <OutlineButton
              onClick={() => onExport(filtered)}
              disabled={!filtered.length}
              style={{ height: 36, fontSize: 12.5, padding: '0 14px' }}
            >
              Export these URLs
            </OutlineButton>
          </div>
        </div>
      </div>

      <div className="crawl-detail-tiles">
        <Tile
          label="Pages affected"
          value={group.pages.toLocaleString()}
          sub={`of ${metrics.htmlCount.toLocaleString()} HTML pages on the site`}
          color={s.chipFg}
          size={26}
        />
        <Tile
          label="Health cost"
          value={band ? `−${band.points}` : '—'}
          sub={band
            ? `points, shared across every ${group.severity} in this crawl`
            : 'this crawl produced no score'}
          size={26}
        />
        <Tile
          label="Triaged"
          value={`${triaged} / ${findings.length}`}
          sub="findings with a review decision recorded"
          size={26}
        />
      </div>

      <div className="crawl-detail-cards">
        <Panel>
          {/* The design leads this card with a "Why it matters" paragraph in the
              client's language. The catalog has no such field, so the card is
              the check's own description until those are written. */}
          <Eyebrow>What the check looks for</Eyebrow>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: 'var(--text)', textWrap: 'pretty' }}>
            {entry?.description || 'No description is recorded for this check.'}
          </p>
        </Panel>
        <Panel>
          <Eyebrow>The fix</Eyebrow>
          <p style={{ margin: 0, fontSize: 15, lineHeight: 1.55, color: 'var(--text)', textWrap: 'pretty' }}>
            {entry?.recommendation || 'No remediation is recorded for this check.'}
          </p>
          <div style={{ height: 1, background: 'var(--border)', margin: '6px 0' }} />
          <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Eyebrow>Detection</Eyebrow>
              <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{entry?.detection || '—'}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Eyebrow>Rule id</Eyebrow>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-3)' }}>
                {group.id}
              </span>
            </div>
          </div>
        </Panel>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <RuledHead
          title="Pages with this problem"
          note={`${group.count.toLocaleString()} finding${group.count === 1 ? '' : 's'} recorded · every URL is in the Excel audit`}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <SearchField
            value={query}
            onChange={(v) => { setQuery(v); setPage(1); }}
            placeholder="Search these URLs"
          />
          {['all', ...REVIEW_STATUSES].map((r) => (
            <Pill
              key={r}
              size="sm"
              active={review === r}
              onClick={() => { setReview(r); setPage(1); }}
            >
              {r === 'all' ? 'All statuses' : r}
            </Pill>
          ))}
        </div>

        <TableFrame>
          <thead>
            <tr style={{ background: 'var(--surface)' }}>
              <Th nowrap>URL</Th>
              <Th nowrap>What we found there</Th>
              <Th nowrap>Review</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((f) => {
              const status = f.reviewStatus || 'Needs review';
              const tone = REVIEW_TONE[status] || REVIEW_TONE['Needs review'];
              return (
                <tr key={f.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '12px 14px', maxWidth: 340 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{
                          fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--primary-text)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >
                        {f.url}
                      </a>
                      {titleByUrl.get(f.url) && (
                        <span
                          style={{
                            fontSize: 11.5, color: 'var(--text-3)', overflow: 'hidden',
                            textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          {titleByUrl.get(f.url)}
                        </span>
                      )}
                      {/* The design has a "Where it came from" column for the
                          discovery source. The crawler does not record one, but
                          a link-shaped finding does carry what it points at,
                          which is the thing you actually have to go and fix. */}
                      {f.targetUrl && (
                        <span
                          style={{
                            fontSize: 11.5, color: 'var(--text-3)', fontFamily: 'var(--font-mono)',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}
                        >
                          → {f.targetUrl}
                        </span>
                      )}
                    </div>
                  </td>
                  <td
                    style={{
                      padding: '12px 14px', color: 'var(--text-2)', maxWidth: 320,
                      overflow: 'hidden', textOverflow: 'ellipsis',
                    }}
                  >
                    {f.detail
                      || (f.detectedValue !== undefined && f.detectedValue !== ''
                        ? String(f.detectedValue)
                        : '—')}
                  </td>
                  <td style={{ padding: '12px 14px' }}>
                    <select
                      value={status}
                      onChange={(e) => onReview(f.id, e.target.value)}
                      aria-label={`Review status for ${f.url}`}
                      style={{
                        fontFamily: 'var(--font-sans)', fontSize: 11, padding: '3px 8px',
                        borderRadius: 6, cursor: 'pointer', border: '1px solid transparent',
                        background: tone.bg, color: tone.fg,
                      }}
                    >
                      {REVIEW_STATUSES.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr>
                <td colSpan={3} style={{ padding: '18px 14px', fontSize: 13 }}>
                  {findings.length ? (
                    <span style={{ color: 'var(--text-3)' }}>
                      No finding matches that search and filter.
                    </span>
                  ) : (
                    // The rule fired — `group` came from the same finding set —
                    // but nothing in it carries this rule id. That is a real
                    // inconsistency rather than an empty state, so it says so
                    // instead of reading as "nothing to see here".
                    <span style={{ color: 'var(--text-3)' }}>
                      This rule is counted {group.count.toLocaleString()} time
                      {group.count === 1 ? '' : 's'} in this crawl, but none of its individual
                      findings could be matched to it — please report this.
                    </span>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </TableFrame>

        <Pager
          page={current}
          pageCount={pageCount}
          onPage={setPage}
          note={filtered.length
            ? `Showing ${start + 1}–${start + shown.length} of ${filtered.length.toLocaleString()}`
            : 'Nothing to show'}
        />
      </div>

      {next && next.id !== group.id && (
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
            padding: '16px 20px', borderRadius: 'var(--r-lg)', background: 'var(--card)',
            border: '1px solid var(--border)', flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            Next problem: {next.title} — {next.pages} page{next.pages === 1 ? '' : 's'}
          </span>
          <OutlineButton
            tone="accent"
            onClick={onOpenNext}
            style={{ height: 36, fontSize: 12.5, padding: '0 14px' }}
          >
            Open it →
          </OutlineButton>
        </div>
      )}
    </div>
  );
}

const BAND_LABEL = { error: 'Errors', warning: 'Warnings', notice: 'Notices' };
