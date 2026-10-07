import { relativeTime, isModuleInFlight, scoreVerdict } from '../../lib/projectsApi';
import { friendlyError, errorDetail } from '../../lib/friendlyError';
import { Tag } from '../studio/primitives';
import { plainModuleName } from './moduleIcons';

// ── The four numbers the top of the dashboard leads with ────────────────────
//
// What replaced the single "N things to fix →" line that used to sit here. That
// line was the only figure above the fold, so the header answered one of the
// four questions a reader arrives with and left the other three to be assembled
// out of six cards further down:
//
//   Composite score  how the site is doing overall, and over how much evidence
//   To fix           how much work there is, and how much of it is one change
//   Pages crawled    what the numbers are computed over, and how fresh it is
//   Coverage         how much of the audit has actually run
//
// Every one of them is read from a stored row, and every one has an honest empty
// state. None of them is invented from the others: the composite is the server's
// own mean of the modules that scored (§6.2 forbids a new score being minted
// here), and a module that has never run is counted as missing rather than as a
// zero (§16.11).

const BAND = [
  { min: 80, color: 'var(--primary)' },
  { min: 60, color: 'var(--viz-warn)' },
  { min: 0, color: 'var(--viz-neg)' },
];

const bandColor = (score) => (BAND.find((b) => score >= b.min) || BAND[2]).color;

// Sentence case at a readable size, not the 10px letter-spaced capitals the
// `eyebrow` class draws. Still smaller and quieter than the figure under it, so
// the hierarchy holds; it just no longer has to be deciphered.
const LABEL = { fontSize: 13, fontWeight: 500, color: 'var(--text-2)' };

/** "AI search and Competitor comparison", each named once. */
function listNames(names) {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique.join('');
  return `${unique.slice(0, -1).join(', ')} and ${unique[unique.length - 1]}`;
}

/**
 * @param {object}   props
 * @param {object}   props.composite         overview.composite
 * @param {Array}    props.modules           overview.modules
 * @param {object?}  props.insights          the insight layer's answer, or null
 * @param {boolean}  props.insightsLoading
 * @param {Error?}   props.insightsError     so a failed read is not reported as
 *                                           a clean bill of health
 * @param {boolean}  props.crawling          a crawl of this client is running now
 */
export default function ProfileStats({
  composite, modules = [], insights, insightsLoading, insightsError, crawling = false,
}) {
  // The overview read failed, so there is no profile to summarise. Four em
  // dashes would be four separate claims that this client has been measured and
  // found empty; one line saying the read failed is the truth.
  if (!modules.length) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={LABEL}>Audit profile</span>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          The audit profile could not be read. The section below says why.
        </span>
      </div>
    );
  }

  // ── Composite ─────────────────────────────────────────────────────────────
  const compositeValue = Number.isFinite(composite?.value) ? composite.value : null;
  const scoredCount = composite?.scoredModules || 0;
  const totalCount = composite?.totalModules ?? modules.length;
  const compositeVerdict = scoreVerdict(compositeValue);

  // ── To fix ────────────────────────────────────────────────────────────────
  const totals = insights?.backlog?.totals || null;
  const actions = Number.isFinite(totals?.actions) ? totals.actions : null;
  const templateWide = totals?.templateWide || 0;
  const pagesAffected = Number.isFinite(totals?.pagesAffected) ? totals.pagesAffected : null;

  // ── Pages crawled ─────────────────────────────────────────────────────────
  //
  // The crawl's own internal-page count, from the same field the Tech Audit card
  // and the crawl report divide by. Read from the module rather than recounted,
  // or the header and the card would eventually publish two figures for one
  // crawl — the single most damaging thing this dashboard can do to itself.
  //
  // Labelled "crawled", not "audited": the page-level modules score a selection
  // of these, so calling it audited would overstate what ran.
  //
  // The fallback matters more than it looks. While a crawl is running the Tech
  // Audit card drops its evidence block on purpose — the previous crawl's counts
  // printed on a card about this one get misread — so reading only that field
  // made this stat say "no completed crawl yet" about a client that has crawled
  // every week for a month, for as long as a crawl was in flight. The insight
  // layer counts the last TERMINAL crawl, through the same helper, so it is the
  // right thing to fall back to and cannot disagree with the card.
  const technical = modules.find((m) => m.key === 'technical') || null;
  const cardPages = Number.isFinite(technical?.evidence?.pagesCrawled)
    ? technical.evidence.pagesCrawled
    : null;
  const storedPages = Number.isFinite(insights?.backlog?.totals?.crawledPages)
    ? insights.backlog.totals.crawledPages
    : null;
  const pages = cardPages === null ? storedPages : cardPages;

  // A scan under way changes what every empty state here means. "No completed
  // crawl for this client yet" under a banner showing 9,000 pages being crawled
  // read as the dashboard contradicting itself; the honest sentence is that the
  // scan is happening and these fill in when it ends. Either signal counts: the
  // shell's crawl status, or the Tech Audit card reporting a crawl in flight.
  const scanning = Boolean(crawling) || isModuleInFlight(technical?.status);

  // ── Coverage ──────────────────────────────────────────────────────────────
  // "Has this module produced anything for this client", which is not the same
  // question as "did it score" — Hub and Spoke reports findings and has no
  // rubric, and counting it as uncovered would be wrong.
  const neverRun = modules.filter((m) => m.status === 'not_run');
  const covered = modules.length - neverRun.length;
  const neverRunNames = neverRun.map(plainModuleName);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
        gap: 20,
      }}
    >
      <Stat
        label="Overall score"
        value={compositeValue === null ? '—' : String(compositeValue)}
        unit={compositeValue === null ? null : '/ 100'}
        color={compositeValue === null ? 'var(--text-3)' : bandColor(compositeValue)}
        // The word the number earns, on the bands it is coloured by — the same
        // word the module cards and the summary use, so a reader never has to
        // decide for themselves whether 64 is good.
        badge={compositeVerdict && (
          <Tag tone={compositeVerdict.tone} style={{ fontSize: 12 }}>{compositeVerdict.label}</Tag>
        )}
        // "Scored", not "checked": Hub and Spoke runs without producing a
        // score, so the areas checked can outnumber the ones averaged here, and
        // the Coverage tile beside this counts the former.
        foot={compositeValue === null
          ? 'No area has produced a score for this client yet'
          : scoredCount >= totalCount
            ? `Average of all ${scoredCount} areas`
            : `Average of the ${scoredCount} of ${totalCount} areas scored so far`}
      />

      <Stat
        label="To fix"
        value={actions === null ? '—' : String(actions)}
        unit={actions === null ? null : `action${actions === 1 ? '' : 's'}`}
        color={actions === null ? 'var(--text-3)' : 'var(--text)'}
        // Four different reasons this can be blank, and they are not the same
        // fact. "Nothing to fix" is a claim about the client; "we could not read
        // the backlog" is a claim about us, and reporting the second as the
        // first is how a dashboard tells its reader their site is clean when it
        // has no idea.
        // The one thing worth saying about a count of things to fix: how much
        // of it is a single template change rather than page-by-page work.
        //
        // This was a link into the ranked backlog further down the page. That
        // section is gone, so it is a statement now — a link to nothing is worse
        // than no link.
        foot={actions === null
          ? insightsError
            ? <ErrorFoot err={insightsError} />
            : insightsLoading
              ? 'Reading the stored evidence…'
              : scanning
                ? 'Fixes appear here when the scan finishes'
                : 'Nothing has been measured for this client yet'
          : !actions
            ? (scanning ? 'Fixes appear here when the scan finishes' : 'No fixes listed yet')
            : templateWide
              ? `${templateWide} of them ${templateWide === 1 ? 'is' : 'are'} one template change`
              : pagesAffected
                ? `Across ${pagesAffected.toLocaleString('en-US')} page${pagesAffected === 1 ? '' : 's'}`
                : null}
      />

      <Stat
        label="Pages crawled"
        value={pages === null ? '—' : pages.toLocaleString('en-US')}
        color={pages === null ? 'var(--text-3)' : 'var(--text)'}
        foot={pages === null
          ? (scanning ? 'First scan in progress' : 'No completed scan for this client yet')
          : cardPages === null
            // The card's own count is missing, so `updatedAt` is the running
            // crawl's start time and dating this figure with it would attribute
            // the last crawl's pages to the one still going.
            ? (scanning ? 'From the last completed scan · new scan in progress' : 'From the last completed scan')
            : technical?.updatedAt
              ? `Last scan ${relativeTime(technical.updatedAt)}`
              : null}
      />

      <Stat
        label="Coverage"
        value={String(covered)}
        unit={`of ${modules.length} area${modules.length === 1 ? '' : 's'}`}
        color={covered === 0 ? 'var(--text-3)' : 'var(--text)'}
        foot={neverRun.length
          // Named, because "5 of 6" without saying which one is missing sends the
          // reader hunting through the cards for the gap. Named in plain words
          // (moduleIcons.jsx), and once each: the two AI Visibility modules
          // answer one question and would otherwise read as a duplicate.
          ? `${listNames(neverRunNames)} ${new Set(neverRunNames).size === 1 ? 'check' : 'checks'} not run yet`
          : 'Every area has been checked'}
      />
    </div>
  );
}

/** A failed read, in words the reader can act on, with the original kept one click away. */
function ErrorFoot({ err }) {
  const detail = errorDetail(err);
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span>The fix list could not be read. {friendlyError(err)}</span>
      {detail && (
        <details style={{ fontSize: 12, color: 'var(--text-3)' }}>
          <summary style={{ cursor: 'pointer' }}>Show details</summary>
          {detail}
        </details>
      )}
    </span>
  );
}

function Stat({ label, value, unit, color, foot, badge }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={LABEL}>{label}</span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
        {/* The body font with tabular figures, not monospace: the digits still
            line up across the row, without the figure reading as code. */}
        <span
          style={{
            fontSize: 28, fontWeight: 600, lineHeight: 1, color,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </span>
        {unit && <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{unit}</span>}
        {badge && <span style={{ alignSelf: 'center', marginLeft: 4 }}>{badge}</span>}
      </div>
      {foot && <span style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.4 }}>{foot}</span>}
    </div>
  );
}
