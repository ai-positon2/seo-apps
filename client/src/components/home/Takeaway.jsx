import { Kicker, Muted } from './primitives';

// ── The one thing to say first ───────────────────────────────────────────────
//
// A CMO looking at this screen has one question: is anything wrong, and what do
// we do about it. The dashboard had six scores and no answer, and the answer was
// already being computed — the insight layer's `lead` is the highest-severity
// thing found across modules, with the action it implies. It was just below the
// fold, under six cards.
//
// So it moves to the top, in the buyer's words rather than the auditor's.
//
// Three states, and none of them is a filler sentence. A dashboard that invents
// something reassuring to say when it has measured nothing is worse than one
// that admits it: the whole product's credibility rests on its numbers meaning
// what they say.

export default function Takeaway({ insights, loading, onOpen }) {
  if (loading && !insights) {
    return (
      <Row>
        <Kicker tone="muted">What matters most</Kicker>
        <Muted size={13}>Reading the stored evidence…</Muted>
      </Row>
    );
  }

  const lead = insights?.lead;
  const backlog = insights?.backlog;

  // Nothing has been measured. Say what to do, not something comforting.
  if (!lead) {
    const neverRun = (insights?.coverage || []).filter((c) => c.state === 'never_run').length;
    return (
      <Row>
        <Kicker tone="muted">What matters most</Kicker>
        <span style={{ fontSize: 15, color: 'var(--text-2)', lineHeight: 1.4 }}>
          {neverRun
            ? 'Not enough has been measured yet to say.'
            : 'Nothing yet spans two modules — run a full audit to find out.'}
        </span>
        <Muted size={12}>
          {neverRun
            ? `${neverRun} module${neverRun === 1 ? ' has' : 's have'} never run against this client. `
              + 'Press Run Full Audit above.'
            : 'The modules below show what each one found on its own.'}
        </Muted>
      </Row>
    );
  }

  const templateWide = backlog?.totals?.templateWide || 0;

  // The headline and its action used to sit here: a severity tag, the modules
  // that agreed ("from hub_spoke + technical"), the finding itself ("40 of 50
  // crawled pages have no inbound internal link"), and the remediation sentence
  // under it.
  //
  // Removed on request. The same lead is the first row of the backlog below,
  // where it sits next to the eleven other things and can be acted on, rather
  // than being restated at the top of the page in bigger type. What is left is
  // the one thing the top of the page could say that the backlog cannot: how
  // much work there is in total, and how much of it is a single template change.
  //
  // If nothing is ranked, this renders nothing at all rather than an empty
  // heading.
  if (!(backlog?.totals?.actions > 0)) return null;

  return (
    <Row>
      <button
        type="button"
        onClick={onOpen}
        style={{
          alignSelf: 'flex-start', padding: 0, border: 'none', textAlign: 'left',
          background: 'none', cursor: 'pointer', fontSize: 13.5,
          color: 'var(--primary-text)', fontFamily: 'var(--font-sans)', lineHeight: 1.45,
        }}
      >
        {backlog.totals.actions} thing{backlog.totals.actions === 1 ? '' : 's'} to fix
        {templateWide
          ? ` · ${templateWide} of them are one template change, not page-by-page work`
          : ''}
        {' →'}
      </button>
    </Row>
  );
}

const Row = ({ children }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      paddingTop: 16,
      marginTop: 4,
      borderTop: '1px solid var(--border)',
    }}
  >
    {children}
  </div>
);
