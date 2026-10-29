import { useMemo, useState } from 'react';
import {
  Panel, Tile, Eyebrow, Chip, Pill, BackLink, OutlineButton, RuledHead,
  TableFrame, Th, Pager, SearchField, sevOf, REVIEW_TONE,
} from './reportPrimitives';
import { REVIEW_STATUSES, findingEvidence, findingFix } from '../crawlHelpers';
import { splitSentences } from '../../explain/ExplainPopover';

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
 * @param {object?}  props.next           the next issue group, for the footer band
 * @param {string}   props.backLabel
 * @param {Function} props.onBack
 * @param {Function} props.onOpenNext
 * @param {Function} props.onReview       (findingId, reviewStatus) => void
 * @param {Function} [props.onBulkReview] (findingIds, reviewStatus) => void, for every URL the filters show
 * @param {Function} props.onExport       exports the listed URLs as CSV
 */
export default function IssueDetail({
  group, entry, findings, titleByUrl, metrics,
  next, backLabel, onBack, onOpenNext, onReview, onBulkReview = null, onExport,
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

      {/* Two tiles since "Health cost" was removed; two columns so neither row has a gap. */}
      <div className="crawl-detail-tiles" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
        <Tile
          label="Pages affected"
          value={group.pages.toLocaleString()}
          sub={`of ${metrics.htmlCount.toLocaleString()} HTML pages on the site`}
          color={s.chipFg}
          size={26}
        />
        <Tile
          label="Triaged"
          info="t_triaged"
          infoCtx={{ triaged, total: findings.length }}
          value={`${triaged} / ${findings.length}`}
          sub="findings with a review decision recorded"
          size={26}
        />
      </div>

      <div className="crawl-detail-cards">
        <CheckCard
          severity={group.severity}
          color={s.chipFg}
          description={entry?.description}
        />
        <FixCard
          recommendation={entry?.recommendation}
          detection={entry?.detection}
          ruleId={group.id}
        />
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
          {/* Every URL the search and status filter show, not just this page
              of the table. A false positive marked here also carries over to
              the same issue on the next crawl of this site. */}
          {onBulkReview && filtered.length > 1 && (
            <select
              value=""
              aria-label={`Set the review of all ${filtered.length} URLs shown`}
              onChange={(e) => {
                if (e.target.value) onBulkReview(filtered.map((f) => f.id), e.target.value);
              }}
              style={{
                fontSize: 12.5, padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)',
                background: 'var(--card)', color: 'var(--text)', fontFamily: 'var(--font-sans)',
              }}
            >
              <option value="">{`Set all ${filtered.length.toLocaleString()} shown to…`}</option>
              {REVIEW_STATUSES.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          )}
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
                    {/* What it means, then what was found: the link text,
                        every redirect hop, the title as written. */}
                    {(() => {
                      const { primary, secondary } = findingEvidence(f);
                      return (
                        <>
                          {primary}
                          {secondary && (
                            <div
                              style={{
                                marginTop: 4, fontSize: 12, color: 'var(--text-3)',
                                fontFamily: 'var(--font-mono)', wordBreak: 'break-word',
                              }}
                            >
                              {secondary}
                            </div>
                          )}
                          {f.sourceTruncated && (
                            <div style={{ marginTop: 4, fontSize: 12, color: 'var(--text-3)' }}>
                              Counted on the first 5 MB of the page, which is larger: the true
                              figure may be higher.
                            </div>
                          )}
                        </>
                      );
                    })()}
                    {/* The page-specific half of the fix: a suggested value
                        (title, meta description, H1) and, for rules that build
                        one from this page's evidence, advice naming its URLs.
                        The card above carries the rule's general fix. */}
                    {(() => {
                      const { suggestion, fix } = findingFix(f, entry);
                      return (
                        <>
                          {suggestion && (
                            <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text)' }}>
                              <strong style={{ fontWeight: 600 }}>Suggested:</strong> {suggestion}
                            </div>
                          )}
                          {fix && (
                            <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--text)' }}>
                              <strong style={{ fontWeight: 600 }}>Fix here:</strong> {fix}
                            </div>
                          )}
                        </>
                      );
                    })()}
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

// ── The two explanation cards ───────────────────────────────────────────────
//
// The catalog's description and remediation are written as paragraphs. They
// are laid out here to be scanned: what it means for the site in one line, the
// check's first sentence as the lead (the rest a click away), and the fix as
// numbered steps with the action itself in bold.

const SEVERITY_MEANS = {
  error: 'Likely stopping these pages from performing in search.',
  warning: 'Holding these pages back.',
  notice: 'Worth tidying when there is time.',
};

const CARD_ICONS = {
  check: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  fix: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />,
};

function CardHead({ icon, children, tint = 'var(--text-2)' }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      <span
        aria-hidden="true"
        style={{
          width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          color: tint, background: `color-mix(in srgb, ${tint} 13%, var(--card))`,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {CARD_ICONS[icon]}
        </svg>
      </span>
      <Eyebrow>{children}</Eyebrow>
    </span>
  );
}

function CheckCard({ severity, color, description }) {
  const [more, setMore] = useState(false);
  const sentences = splitSentences(description);
  const lead = sentences[0] || 'No description is recorded for this check.';
  const rest = sentences.slice(1);
  return (
    <Panel style={{ gap: 14 }}>
      <CardHead icon="check">What the check looks for</CardHead>
      {SEVERITY_MEANS[severity] && (
        <span
          style={{
            alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '6px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, color,
            background: `color-mix(in srgb, ${color} 11%, var(--card))`,
          }}
        >
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />
          {SEVERITY_MEANS[severity]}
        </span>
      )}
      <p style={{ margin: 0, fontSize: 15, fontWeight: 500, lineHeight: 1.5, color: 'var(--text)', textWrap: 'pretty' }}>
        {lead}
      </p>
      {rest.length > 0 && (more ? (
        <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-2)', textWrap: 'pretty' }}>
          {rest.join(' ')}
        </p>
      ) : (
        <button type="button" className="issue-more" onClick={() => setMore(true)}>More detail</button>
      ))}
    </Panel>
  );
}

/** "Let the crawler through, then crawl again: allow-list…" → bold head, plain rest. */
function stepParts(step) {
  const at = step.indexOf(': ');
  if (at > 0 && at <= 70) return [step.slice(0, at), step.slice(at + 2)];
  return [null, step];
}

/**
 * "Restore it, redirect it, or remove the links." → three alternatives. Only
 * when the sentence is a plain list ending in ", or …", so a comma inside an
 * ordinary clause is never split.
 */
function alternatives(step) {
  const parts = step.replace(/\.$/, '').split(', ');
  if (parts.length < 3 || !parts[parts.length - 1].startsWith('or ')) return null;
  const opts = parts.map((t, i) => (i === parts.length - 1 ? t.slice(3) : t));
  if (opts.some((t) => t.split(' ').length < 3)) return null;
  return opts.map((t) => t.charAt(0).toUpperCase() + t.slice(1));
}

function FixCard({ recommendation, detection, ruleId }) {
  const steps = splitSentences(recommendation);
  const options = steps.length === 1 ? alternatives(steps[0]) : null;
  return (
    <Panel style={{ gap: 14 }}>
      <CardHead icon="fix" tint="var(--primary)">The fix</CardHead>
      {options ? (
        <>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>Any one of these:</span>
          <ul className="issue-options">
            {options.map((o) => <li key={o}>{o}</li>)}
          </ul>
        </>
      ) : steps.length ? (
        <ol className={`issue-steps${steps.length === 1 ? ' issue-steps--single' : ''}`}>
          {steps.map((step) => {
            const [head, body] = stepParts(step);
            return (
              <li key={step}>
                {head && <strong>{head}. </strong>}
                {head ? body.charAt(0).toUpperCase() + body.slice(1) : body}
              </li>
            );
          })}
        </ol>
      ) : (
        <p style={{ margin: 0, fontSize: 14, color: 'var(--text-2)' }}>No remediation is recorded for this check.</p>
      )}
      <div style={{ marginTop: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {detection && <span className="issue-meta">{detection} check</span>}
        <span className="issue-meta" style={{ fontFamily: 'var(--font-mono)' }}>{ruleId}</span>
      </div>
    </Panel>
  );
}
