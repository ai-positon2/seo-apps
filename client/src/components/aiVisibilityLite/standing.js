// ── Where the client stands against the brands it tracks ────────────────────
//
// Pure, so the wording rules can be tested without rendering the overview.
//
// Rank is 1 + the number of brands STRICTLY ahead. It was the client's place
// in a stable sort, so on a tie the client — listed first — came out #1, and
// Position² at 0.0% beside a competitor at 0.0% read 'LEADING' and 'ranks #1
// of the 2 brands'. A tie is said as a tie, and when nobody was named at all
// there is no verdict.
//
// The fallback sentence names the real reason there is nothing to compare:
// no competitors tracked (the only case that should ask for one), no answers
// in the period, or tracked competitors never named.

/**
 * @param {object} report  the lite report
 * @returns {{ranked, rank, tied, tiedWith, allZero, verdict, sentence}}
 */
export function standingOf(report) {
  const all = report?.brands || [];
  const brands = all.filter((b) => b.namedRate?.value !== null && b.namedRate?.value !== undefined);
  const ranked = [...brands].sort((a, b) => b.namedRate.value - a.namedRate.value);
  const client = ranked.find((b) => b.isClient) || null;
  const competitorCount = all.filter((b) => !b.isClient).length;
  const answers = Number(report?.meta?.answersMeasured) || 0;
  const headline = report?.headline?.namedRate?.value;
  const brandName = client?.name || 'You';

  const comparable = Boolean(client) && ranked.length >= 2 && headline !== null && headline !== undefined;
  const ahead = client ? ranked.filter((b) => b.namedRate.value > client.namedRate.value).length : 0;
  const rank = client ? ahead + 1 : 0;
  const tiedWith = client
    ? ranked.filter((b) => !b.isClient && b.namedRate.value === client.namedRate.value)
    : [];
  const tied = tiedWith.length > 0;
  const allZero = ranked.length > 0 && ranked.every((b) => !b.named);

  let verdict = null;
  if (comparable && !allZero) {
    if (rank === 1) verdict = tied ? 'TIED' : 'LEADING';
    else verdict = rank <= Math.ceil(ranked.length / 2) ? 'HOLDING' : 'BEHIND';
  }

  const others = ranked.filter((b) => !b.isClient);
  const runnerUp = others.find((b) => b.namedRate.value <= (client?.namedRate.value ?? Infinity) && !tiedWith.includes(b))
    || others[0] || null;
  const names = (list) => (list.length <= 2
    ? list.map((b) => b.name).join(' and ')
    : `${list.slice(0, -1).map((b) => b.name).join(', ')} and ${list[list.length - 1].name}`);

  let sentence;
  if (comparable && allZero) {
    sentence = `Neither ${brandName} nor ${names(others)} was named in any of the ${answers} answers.`;
  } else if (comparable && tied && rank === 1) {
    sentence = `${brandName} is level with ${names(tiedWith)} at ${client.namedRate.display} of answers, `
      + `the most of the ${ranked.length} brands this project tracks.`;
  } else if (comparable && tied) {
    sentence = `${brandName} is level with ${names(tiedWith)} at ${client.namedRate.display} of answers; `
      + `${ahead} tracked brand${ahead === 1 ? ' is' : 's are'} named more often.`;
  } else if (comparable && runnerUp) {
    sentence = rank === 1
      ? `${brandName} ranks #1 of the ${ranked.length} brands this project tracks. `
        + `The next one, ${runnerUp.name}, comes up in ${runnerUp.namedRate.display} of answers.`
      : `${brandName} ranks #${rank} of the ${ranked.length} brands this project tracks. `
        + `${ranked[0].name} leads, named in ${ranked[0].namedRate.display} of answers.`;
  } else if (competitorCount === 0) {
    sentence = 'This project isn’t tracking any competitors yet, so there’s nothing to compare against — '
      + 'add one or two to see how you stack up.';
  } else if (!answers) {
    sentence = 'Nothing was measured in this period, so there is nothing to compare against.';
  } else {
    sentence = 'None of the competitors this project tracks could be compared in these answers.';
  }

  return {
    ranked, rank, tied, tiedWith, allZero, verdict, sentence, competitorCount,
  };
}

/**
 * The headline when the period has no measured answers: never measured at
 * all, or measured before this window — which is a different statement.
 */
export function emptyHeadline(report) {
  const last = report?.meta?.lastMeasuredAt;
  if (!last) return 'No AI answers measured yet.';
  const d = new Date(last);
  const when = Number.isNaN(d.getTime())
    ? String(last).slice(0, 10)
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `No answers in this period — last measured ${when}.`;
}
